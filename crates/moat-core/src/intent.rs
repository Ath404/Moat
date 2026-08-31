//! The [`TradeIntent`] — the only thing the keep is allowed to say to the chain.
//!
//! An intent is not an instruction. It is a *request* carrying every input the
//! chain needs to re-derive whether the request is inside policy. The keep signs
//! [`TradeIntent::signing_bytes`] with its enclave key; the moat program verifies
//! that signature via an Ed25519 native-program instruction and then ignores the
//! keep's judgement entirely, re-checking every bound itself.
//!
//! The encoding is fixed-width, little-endian and domain-separated. Fixed-width
//! matters: a length-prefixed or variable encoding invites two different byte
//! strings that decode to the same intent, which is exactly the seam a signature
//! oracle gets built on.

use core::convert::TryInto;

/// A 32-byte Solana public key. Kept as a plain array so this crate never needs
/// to depend on `solana-program`.
pub type Pubkey = [u8; 32];

/// Domain separator. Bump the trailing version when the layout changes so an
/// intent signed for one layout can never be reinterpreted under another.
pub const INTENT_DOMAIN: [u8; 16] = *b"moat:intent:v1\0\0";

/// Direction, from the vault's point of view. Carried explicitly rather than
/// inferred from the mints so that a mislabelled intent fails signature
/// verification instead of silently meaning the opposite thing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Side {
    Buy = 0,
    Sell = 1,
}

impl Side {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Side::Buy),
            1 => Some(Side::Sell),
            _ => None,
        }
    }
}

/// One oracle observation, in Pyth's shape.
///
/// `price` is scaled by `10^expo` (`expo` is negative in practice) and quotes
/// **one whole token**, not one atom; `decimals` carries the mint's decimals so
/// the atom-level conversion can be done exactly, in one place, in
/// [`crate::policy`].
///
/// Freshness is a unix timestamp, not a slot, because that is the unit Pyth
/// actually publishes. Slots are used everywhere the *chain* is the clock
/// (expiry, cooldown, day windows); seconds are used where the *oracle* is.
/// Keeping the two apart in the type is deliberate — silently treating a
/// publish time as a slot number is a staleness check that always passes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OracleQuote {
    pub price: u64,
    pub conf: u64,
    pub expo: i32,
    pub decimals: u8,
    pub publish_ts: i64,
}

impl OracleQuote {
    pub const LEN: usize = 8 + 8 + 4 + 1 + 8;
}

/// A single leg of a strategy decision, authorised by the keep.
///
/// One strategy decision ("buy $10k of SOL") fans out into `sortie_count` of
/// these, each with its own `nonce` and its own release slot, split and timed by
/// [`crate::sortie`]. `vrf_commitment` binds every leg to the same VRF output so
/// the split cannot be re-rolled after the fact.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TradeIntent {
    /// Vault PDA this intent may be spent against. Prevents cross-vault replay.
    pub vault: Pubkey,
    /// Policy generation this was evaluated against. Any `set_policy` bumps the
    /// generation and strands every in-flight intent, which is the point.
    pub policy_version: u32,
    /// Strictly sequential. The chain accepts only `vault.next_nonce`, so
    /// intents cannot be replayed, reordered, or selectively dropped by a
    /// relayer trying to shape execution.
    pub nonce: u64,
    /// Last slot at which this intent may land.
    pub expiry_slot: u64,
    pub side: Side,
    pub mint_in: Pubkey,
    pub mint_out: Pubkey,
    pub amount_in: u64,
    /// Floor on received amount. Checked twice: against the chain's own oracle
    /// read before the swap, and against the realised balance delta after it.
    pub min_amount_out: u64,
    pub max_slippage_bps: u16,
    /// Target program (Jupiter). Must be in the policy's venue allowlist.
    pub venue: Pubkey,
    pub sortie_index: u8,
    pub sortie_count: u8,
    /// Commitment to the VRF output that produced this sortie plan.
    pub vrf_commitment: [u8; 32],
    /// What the keep claims it saw. The chain compares this to its own read and
    /// rejects a keep that is lying or running on stale data.
    pub quoted_in: OracleQuote,
    pub quoted_out: OracleQuote,
}

impl TradeIntent {
    /// Exact width of [`Self::signing_bytes`]. Asserted against the cursor in
    /// tests rather than trusted.
    pub const SIGNING_LEN: usize = 16  // domain
        + 32  // vault
        + 4   // policy_version
        + 8   // nonce
        + 8   // expiry_slot
        + 1   // side
        + 32  // mint_in
        + 32  // mint_out
        + 8   // amount_in
        + 8   // min_amount_out
        + 2   // max_slippage_bps
        + 32  // venue
        + 1   // sortie_index
        + 1   // sortie_count
        + 32  // vrf_commitment
        + OracleQuote::LEN
        + OracleQuote::LEN;

    /// Canonical bytes the enclave signs and the chain verifies.
    pub fn signing_bytes(&self) -> [u8; Self::SIGNING_LEN] {
        let mut w = Writer::new();
        w.put(&INTENT_DOMAIN);
        w.put(&self.vault);
        w.put(&self.policy_version.to_le_bytes());
        w.put(&self.nonce.to_le_bytes());
        w.put(&self.expiry_slot.to_le_bytes());
        w.put(&[self.side as u8]);
        w.put(&self.mint_in);
        w.put(&self.mint_out);
        w.put(&self.amount_in.to_le_bytes());
        w.put(&self.min_amount_out.to_le_bytes());
        w.put(&self.max_slippage_bps.to_le_bytes());
        w.put(&self.venue);
        w.put(&[self.sortie_index, self.sortie_count]);
        w.put(&self.vrf_commitment);
        w.put_quote(&self.quoted_in);
        w.put_quote(&self.quoted_out);
        debug_assert_eq!(w.at, Self::SIGNING_LEN);
        w.buf
    }

    /// Inverse of [`Self::signing_bytes`]. Used by the keep's own round-trip
    /// tests and by off-chain tooling that has to read an intent off the wire.
    pub fn from_signing_bytes(buf: &[u8]) -> Result<Self, DecodeError> {
        if buf.len() != Self::SIGNING_LEN {
            return Err(DecodeError::Length);
        }
        let mut r = Reader { buf, at: 0 };
        if r.take::<16>()? != INTENT_DOMAIN {
            return Err(DecodeError::Domain);
        }
        let vault = r.take::<32>()?;
        let policy_version = u32::from_le_bytes(r.take::<4>()?);
        let nonce = u64::from_le_bytes(r.take::<8>()?);
        let expiry_slot = u64::from_le_bytes(r.take::<8>()?);
        let side = Side::from_u8(r.take::<1>()?[0]).ok_or(DecodeError::Side)?;
        let mint_in = r.take::<32>()?;
        let mint_out = r.take::<32>()?;
        let amount_in = u64::from_le_bytes(r.take::<8>()?);
        let min_amount_out = u64::from_le_bytes(r.take::<8>()?);
        let max_slippage_bps = u16::from_le_bytes(r.take::<2>()?);
        let venue = r.take::<32>()?;
        let sortie = r.take::<2>()?;
        let vrf_commitment = r.take::<32>()?;
        let quoted_in = r.take_quote()?;
        let quoted_out = r.take_quote()?;
        Ok(Self {
            vault,
            policy_version,
            nonce,
            expiry_slot,
            side,
            mint_in,
            mint_out,
            amount_in,
            min_amount_out,
            max_slippage_bps,
            venue,
            sortie_index: sortie[0],
            sortie_count: sortie[1],
            vrf_commitment,
            quoted_in,
            quoted_out,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    Length,
    Domain,
    Side,
}

struct Writer {
    buf: [u8; TradeIntent::SIGNING_LEN],
    at: usize,
}

impl Writer {
    fn new() -> Self {
        Self { buf: [0u8; TradeIntent::SIGNING_LEN], at: 0 }
    }

    fn put(&mut self, src: &[u8]) {
        let end = self.at + src.len();
        self.buf[self.at..end].copy_from_slice(src);
        self.at = end;
    }

    fn put_quote(&mut self, q: &OracleQuote) {
        self.put(&q.price.to_le_bytes());
        self.put(&q.conf.to_le_bytes());
        self.put(&q.expo.to_le_bytes());
        self.put(&[q.decimals]);
        self.put(&q.publish_ts.to_le_bytes());
    }
}

struct Reader<'a> {
    buf: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn take<const N: usize>(&mut self) -> Result<[u8; N], DecodeError> {
        let end = self.at.checked_add(N).ok_or(DecodeError::Length)?;
        let slice = self.buf.get(self.at..end).ok_or(DecodeError::Length)?;
        self.at = end;
        slice.try_into().map_err(|_| DecodeError::Length)
    }

    fn take_quote(&mut self) -> Result<OracleQuote, DecodeError> {
        Ok(OracleQuote {
            price: u64::from_le_bytes(self.take::<8>()?),
            conf: u64::from_le_bytes(self.take::<8>()?),
            expo: i32::from_le_bytes(self.take::<4>()?),
            decimals: self.take::<1>()?[0],
            publish_ts: i64::from_le_bytes(self.take::<8>()?),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn sample() -> TradeIntent {
        TradeIntent {
            vault: [7u8; 32],
            policy_version: 3,
            nonce: 41,
            expiry_slot: 1_000,
            side: Side::Buy,
            mint_in: [1u8; 32],
            mint_out: [2u8; 32],
            amount_in: 5_000_000,
            min_amount_out: 32_000_000,
            max_slippage_bps: 50,
            venue: [9u8; 32],
            sortie_index: 1,
            sortie_count: 3,
            vrf_commitment: [0xAB; 32],
            quoted_in: OracleQuote {
                price: 100_000_000,
                conf: 20_000,
                expo: -8,
                decimals: 6,
                publish_ts: 990,
            },
            quoted_out: OracleQuote {
                price: 15_000_000_000,
                conf: 3_000_000,
                expo: -8,
                decimals: 9,
                publish_ts: 991,
            },
        }
    }

    #[test]
    fn signing_len_is_exact() {
        // The cursor must land precisely on SIGNING_LEN; a short write would
        // leave attacker-influenced zero padding inside the signed message.
        let bytes = sample().signing_bytes();
        assert_eq!(bytes.len(), TradeIntent::SIGNING_LEN);
        assert_eq!(TradeIntent::SIGNING_LEN, 275);
    }

    #[test]
    fn round_trips() {
        let intent = sample();
        let decoded = TradeIntent::from_signing_bytes(&intent.signing_bytes()).unwrap();
        assert_eq!(intent, decoded);
    }

    #[test]
    fn encoding_is_deterministic() {
        assert_eq!(sample().signing_bytes(), sample().signing_bytes());
    }

    #[test]
    fn every_field_changes_the_signed_bytes() {
        // If two distinct intents share a signature preimage, one signature
        // authorises both. Mutate each field in turn; the bytes must move.
        let base = sample().signing_bytes();
        let mutations: [fn(&mut TradeIntent); 15] = [
            |i| i.vault[0] ^= 1,
            |i| i.policy_version += 1,
            |i| i.nonce += 1,
            |i| i.expiry_slot += 1,
            |i| i.side = Side::Sell,
            |i| i.mint_in[31] ^= 1,
            |i| i.mint_out[31] ^= 1,
            |i| i.amount_in += 1,
            |i| i.min_amount_out -= 1,
            |i| i.max_slippage_bps += 1,
            |i| i.venue[0] ^= 1,
            |i| i.sortie_index += 1,
            |i| i.sortie_count += 1,
            |i| i.vrf_commitment[0] ^= 1,
            |i| i.quoted_in.price += 1,
        ];
        for (n, mutate) in mutations.iter().enumerate() {
            let mut intent = sample();
            mutate(&mut intent);
            assert_ne!(base, intent.signing_bytes(), "mutation {n} left the preimage unchanged");
        }
    }

    #[test]
    fn rejects_foreign_domain() {
        let mut bytes = sample().signing_bytes();
        bytes[0] = b'x';
        assert_eq!(TradeIntent::from_signing_bytes(&bytes), Err(DecodeError::Domain));
    }

    #[test]
    fn rejects_wrong_length() {
        assert_eq!(TradeIntent::from_signing_bytes(&[0u8; 8]), Err(DecodeError::Length));
    }
}
