//! Sortie planning: turning one strategy decision into an execution pattern
//! that does not advertise itself.
//!
//! A sortie is one leg of a decision. "Buy $10,000 of SOL" becomes three or four
//! sorties of unequal size, released at unequal offsets inside a window. The
//! split and the timing both come from a VRF output, so they are unpredictable
//! before the fact and reproducible after it — anyone holding the VRF proof can
//! recompute this exact plan and check the vault followed it.
//!
//! ## What this does and does not buy you
//!
//! It buys **unpredictability**, not confidentiality. An observer still sees
//! every fill on-chain. What they lose is the regularity — "$10,000 at 12:00
//! daily" — that makes a strategy cheap to fingerprint and cheap to front-run.
//! Confidentiality is the keep's job; this is only about not leaving a rhythm.
//!
//! ## On the expansion function
//!
//! [`Rng`] is SplitMix64, which is not a cryptographic PRF. That is deliberate
//! and safe *here*: the unpredictability is carried entirely by the VRF output
//! that seeds it, and SplitMix64 is only spreading already-unpredictable entropy
//! across a handful of small integers. It must never be seeded with anything an
//! adversary can predict, which is why [`plan`] takes a seed rather than
//! generating one.

use crate::BPS;

/// Legs per decision. Eight is well past the point of diminishing returns for
/// pattern-breaking and keeps [`Plan`] a fixed-size, stack-only struct.
pub const MAX_LEGS: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SortieConfig {
    pub min_legs: u8,
    pub max_legs: u8,
    /// Slots the legs are scattered across, starting at `start_slot`.
    pub window_slots: u64,
    /// Floor on each leg as a fraction of the total, so the split cannot degrade
    /// into one real trade plus dust — which would leak the true size.
    pub min_leg_bps: u16,
}

impl Default for SortieConfig {
    /// Three to five legs over roughly twenty minutes, no leg under 10%.
    fn default() -> Self {
        Self { min_legs: 3, max_legs: 5, window_slots: 3_000, min_leg_bps: 1_000 }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Leg {
    pub amount: u64,
    /// Earliest slot this leg may land. The moat program does not enforce this
    /// directly — `min_cooldown_slots` does the pacing — but the keep releases
    /// signed intents on it, and it is what the VRF proof attests to.
    pub release_slot: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Plan {
    pub legs: [Leg; MAX_LEGS],
    pub count: u8,
}

impl Plan {
    pub fn legs(&self) -> &[Leg] {
        &self.legs[..self.count as usize]
    }

    /// Sum of every leg. Must always equal the total passed to [`plan`].
    pub fn total(&self) -> u64 {
        self.legs().iter().fold(0u64, |acc, l| acc.saturating_add(l.amount))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SortieError {
    /// `min_legs`/`max_legs` out of range, or a `min_leg_bps` floor that cannot
    /// be satisfied by `max_legs` legs.
    BadConfig,
    ZeroTotal,
    Overflow,
}

/// Split `total` into legs and scatter them across the window.
///
/// `seed` must be a VRF output (or a hash of one). Same seed, same plan —
/// that reproducibility is what lets anyone with the proof audit the split.
pub fn plan(seed: &[u8; 32], total: u64, start_slot: u64, cfg: &SortieConfig) -> Result<Plan, SortieError> {
    if cfg.min_legs == 0
        || cfg.max_legs < cfg.min_legs
        || cfg.max_legs as usize > MAX_LEGS
        || (cfg.min_leg_bps as u64).saturating_mul(cfg.max_legs as u64) > BPS
    {
        return Err(SortieError::BadConfig);
    }
    if total == 0 {
        return Err(SortieError::ZeroTotal);
    }

    let mut rng = Rng::from_seed(seed);

    // How many legs, uniform over the configured range.
    let span = (cfg.max_legs as u64).checked_sub(cfg.min_legs as u64).ok_or(SortieError::BadConfig)?;
    let mut n = (cfg.min_legs as u64).checked_add(rng.below(span.saturating_add(1))).ok_or(SortieError::Overflow)?;

    // Every leg gets at least one atom, whatever the percentage floor rounds to.
    // Without this, a small total can round a leg's share to zero, and a
    // zero-amount leg is an intent the vault will refuse (`Denial::ZeroAmount`) —
    // an unexecutable hole in the middle of a plan.
    let total_u128 = total as u128;
    let floor_amt = leg_floor(total_u128, cfg.min_leg_bps)?.max(1);

    // Back off if the total is too small to give every leg that floor. A $3
    // rebalance becomes one leg rather than eight dust legs.
    while n > 1 && (n as u128).saturating_mul(floor_amt) > total_u128 {
        n -= 1;
    }
    let n = n as usize;

    // Give every leg its floor, then share the remainder by random weights.
    let base = (n as u128).checked_mul(floor_amt).ok_or(SortieError::Overflow)?;
    let remainder = total_u128.checked_sub(base).ok_or(SortieError::Overflow)?;

    let mut weights = [0u64; MAX_LEGS];
    let mut weight_sum: u128 = 0;
    for w in weights.iter_mut().take(n) {
        // Never zero: a zero weight would collapse a leg back to the floor and
        // make the smallest leg's size deterministic.
        *w = rng.below(1 << 20).saturating_add(1);
        weight_sum = weight_sum.checked_add(*w as u128).ok_or(SortieError::Overflow)?;
    }

    let mut legs = [Leg::default(); MAX_LEGS];
    let mut assigned: u128 = 0;
    for i in 0..n {
        let extra = remainder
            .checked_mul(weights[i] as u128)
            .ok_or(SortieError::Overflow)?
            .checked_div(weight_sum)
            .ok_or(SortieError::Overflow)?;
        let amount = floor_amt.checked_add(extra).ok_or(SortieError::Overflow)?;
        legs[i].amount = u64::try_from(amount).map_err(|_| SortieError::Overflow)?;
        assigned = assigned.checked_add(amount).ok_or(SortieError::Overflow)?;
    }

    // Integer division leaves a few atoms over. Handing them to a random leg
    // rather than always the last one matters: "the final fill is always the odd
    // one" is itself a pattern, and the whole point here is not to have one.
    let leftover = total_u128.checked_sub(assigned).ok_or(SortieError::Overflow)?;
    if leftover > 0 {
        let lucky = rng.below(n as u64) as usize;
        let bumped = (legs[lucky].amount as u128).checked_add(leftover).ok_or(SortieError::Overflow)?;
        legs[lucky].amount = u64::try_from(bumped).map_err(|_| SortieError::Overflow)?;
    }

    // Scatter release slots across the window, then order them.
    let mut offsets = [0u64; MAX_LEGS];
    for o in offsets.iter_mut().take(n) {
        *o = rng.below(cfg.window_slots.max(1));
    }
    insertion_sort(&mut offsets[..n]);
    for i in 0..n {
        legs[i].release_slot = start_slot.checked_add(offsets[i]).ok_or(SortieError::Overflow)?;
    }

    Ok(Plan { legs, count: n as u8 })
}

fn leg_floor(total: u128, min_leg_bps: u16) -> Result<u128, SortieError> {
    total
        .checked_mul(min_leg_bps as u128)
        .ok_or(SortieError::Overflow)?
        .checked_div(BPS as u128)
        .ok_or(SortieError::Overflow)
}

fn insertion_sort(xs: &mut [u64]) {
    for i in 1..xs.len() {
        let mut j = i;
        while j > 0 && xs[j - 1] > xs[j] {
            xs.swap(j - 1, j);
            j -= 1;
        }
    }
}

/// SplitMix64. Deterministic expansion of a VRF output — see the module note on
/// why a non-cryptographic PRNG is the right tool at this point in the pipeline.
struct Rng(u64);

impl Rng {
    fn from_seed(seed: &[u8; 32]) -> Self {
        let mut s: u64 = 0x9E37_79B9_7F4A_7C15;
        for chunk in seed.chunks_exact(8) {
            let mut word = [0u8; 8];
            word.copy_from_slice(chunk);
            s ^= u64::from_le_bytes(word);
            s = s.wrapping_mul(0xBF58_476D_1CE4_E5B9).rotate_left(31);
        }
        Self(s)
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform-ish in `[0, n)`. The modulo bias is on the order of 2^-44 for the
    /// ranges used here and is irrelevant to timing jitter.
    fn below(&mut self, n: u64) -> u64 {
        if n == 0 {
            0
        } else {
            self.next_u64() % n
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(n: u64) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[..8].copy_from_slice(&n.to_le_bytes());
        s[8..16].copy_from_slice(&(n.wrapping_mul(0x9E37_79B9)).to_le_bytes());
        s
    }

    #[test]
    fn conserves_the_total_exactly_across_many_seeds() {
        // The one invariant that is a bug in production if it ever fails: the
        // legs must add up to the decision, to the atom.
        let cfg = SortieConfig::default();
        for i in 0..2_000u64 {
            let total = 1_000_000 + i * 7_919;
            let p = plan(&seed(i), total, 1_000, &cfg).unwrap();
            assert_eq!(p.total(), total, "seed {i} lost or minted atoms");
            // And no leg may be zero — the vault refuses a zero-amount intent,
            // so a zero leg is an unexecutable hole in the middle of a plan.
            assert!(p.legs().iter().all(|l| l.amount > 0), "seed {i} produced a zero leg");
        }

        // Same invariants at sizes small enough for the percentage floor to
        // round away, which is where the zero-leg case actually lives.
        for total in 1..200u64 {
            let p = plan(&seed(total), total, 0, &cfg).unwrap();
            assert_eq!(p.total(), total);
            assert!(p.legs().iter().all(|l| l.amount > 0), "total {total} produced a zero leg");
        }
    }

    #[test]
    fn respects_the_leg_count_range() {
        let cfg = SortieConfig::default();
        let mut seen = [false; MAX_LEGS + 1];
        for i in 0..1_000u64 {
            let p = plan(&seed(i), 10_000_000, 0, &cfg).unwrap();
            assert!(p.count >= cfg.min_legs && p.count <= cfg.max_legs, "count {} out of range", p.count);
            seen[p.count as usize] = true;
        }
        // And actually varies, rather than being nominally random.
        assert!(seen[3] && seen[4] && seen[5], "leg count did not explore its range");
    }

    #[test]
    fn no_leg_falls_below_the_configured_floor() {
        let cfg = SortieConfig::default(); // 10% floor
        for i in 0..1_000u64 {
            let total = 10_000_000u64;
            let p = plan(&seed(i), total, 0, &cfg).unwrap();
            let floor = total / 10;
            for leg in p.legs() {
                assert!(leg.amount >= floor, "seed {i} produced a dust leg: {}", leg.amount);
            }
        }
    }

    #[test]
    fn release_slots_are_ordered_and_inside_the_window() {
        let cfg = SortieConfig::default();
        for i in 0..500u64 {
            let p = plan(&seed(i), 5_000_000, 900, &cfg).unwrap();
            let mut prev = 0u64;
            for leg in p.legs() {
                assert!(leg.release_slot >= 900);
                assert!(leg.release_slot < 900 + cfg.window_slots);
                assert!(leg.release_slot >= prev, "release slots must be non-decreasing");
                prev = leg.release_slot;
            }
        }
    }

    #[test]
    fn is_reproducible_from_the_vrf_output() {
        // Anyone holding the VRF proof can recompute the plan and audit it.
        let cfg = SortieConfig::default();
        let a = plan(&seed(42), 7_777_777, 100, &cfg).unwrap();
        let b = plan(&seed(42), 7_777_777, 100, &cfg).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn different_vrf_outputs_give_different_plans() {
        let cfg = SortieConfig::default();
        let a = plan(&seed(1), 7_777_777, 100, &cfg).unwrap();
        let b = plan(&seed(2), 7_777_777, 100, &cfg).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn the_split_is_not_systematically_lopsided() {
        // If the remainder always landed on the last leg, the last leg would be
        // the largest far more often than 1/n of the time — an observable tell.
        let cfg = SortieConfig::default();
        let mut last_is_largest = 0u32;
        let trials = 1_000u64;
        for i in 0..trials {
            let p = plan(&seed(i), 3_333_331, 0, &cfg).unwrap();
            let legs = p.legs();
            let max = legs.iter().map(|l| l.amount).max().unwrap();
            if legs[legs.len() - 1].amount == max {
                last_is_largest += 1;
            }
        }
        // Uniform would be ~25% over 3..=5 legs; allow a wide band, only catch a
        // systematic bias.
        assert!(
            (100..=500).contains(&last_is_largest),
            "last leg was largest {last_is_largest}/1000 times, which looks systematic"
        );
    }

    #[test]
    fn a_total_too_small_to_split_backs_off_instead_of_making_dust() {
        let cfg = SortieConfig::default(); // wants 3..=5 legs
        // One atom cannot be three legs. Backing off to one is correct; emitting
        // three legs of which two are zero would put intents in the plan that
        // the vault refuses outright.
        let one = plan(&seed(3), 1, 0, &cfg).unwrap();
        assert_eq!(one.count, 1);
        assert_eq!(one.total(), 1);

        // Two atoms back off to two legs of one.
        let two = plan(&seed(3), 2, 0, &cfg).unwrap();
        assert_eq!(two.count, 2);
        assert_eq!(two.total(), 2);
        assert!(two.legs().iter().all(|l| l.amount > 0));
    }

    #[test]
    fn rejects_impossible_configs() {
        let base = SortieConfig::default();
        assert_eq!(plan(&seed(0), 100, 0, &SortieConfig { min_legs: 0, ..base }), Err(SortieError::BadConfig));
        assert_eq!(
            plan(&seed(0), 100, 0, &SortieConfig { min_legs: 5, max_legs: 3, ..base }),
            Err(SortieError::BadConfig)
        );
        assert_eq!(
            plan(&seed(0), 100, 0, &SortieConfig { max_legs: 9, ..base }),
            Err(SortieError::BadConfig)
        );
        // 8 legs cannot each be 20% of the total.
        assert_eq!(
            plan(&seed(0), 100, 0, &SortieConfig { max_legs: 8, min_leg_bps: 2_000, ..base }),
            Err(SortieError::BadConfig)
        );
        assert_eq!(plan(&seed(0), 0, 0, &base), Err(SortieError::ZeroTotal));
    }
}
