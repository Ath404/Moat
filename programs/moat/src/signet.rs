//! Signet: proving an intent came from the registered enclave.
//!
//! Solana has no `ed25519_verify` syscall. The way to check a non-transaction
//! signature is to have the client include an instruction for the Ed25519 native
//! program in the same transaction and then *introspect* it: the runtime has
//! already verified the signature by the time our handler runs, so our job is
//! only to confirm that what it verified is the key and the message we care
//! about.
//!
//! That last part is where this pattern is usually got wrong. Finding an Ed25519
//! instruction in the transaction proves *some* signature was valid — not that
//! it covered *our* intent. Every offset below is therefore re-derived and the
//! public key and message bytes compared in full.

use anchor_lang::prelude::*;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::errors::MoatError;

/// The Ed25519 signature-verification native program. Written out rather than
/// pulled from `solana-sdk-ids` so the program this code trusts is visible in
/// the source, not in a dependency graph.
pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

/// The instructions sysvar, the account introspection reads from.
pub const INSTRUCTIONS_SYSVAR_ID: Pubkey = pubkey!("Sysvar1nstructions1111111111111111111111111");

/// Header of the Ed25519 instruction data: `num_signatures: u8`, `padding: u8`.
const HEADER_LEN: usize = 2;
/// One `Ed25519SignatureOffsets` entry: seven little-endian `u16`s.
const OFFSETS_LEN: usize = 14;
/// Sentinel in the `*_instruction_index` fields meaning "this instruction".
const THIS_INSTRUCTION: u16 = u16::MAX;

/// Fail unless this transaction contains an Ed25519 instruction proving
/// `expected_key` signed exactly `expected_message`.
pub fn verify_enclave_signature(
    instructions_sysvar: &AccountInfo,
    expected_key: &Pubkey,
    expected_message: &[u8],
) -> Result<()> {
    require_keys_neq!(*expected_key, Pubkey::default(), MoatError::NoEnclaveRegistered);

    let current = load_current_index_checked(instructions_sysvar)? as usize;

    // Only instructions ahead of this one are considered. Anything the runtime
    // has already executed has already had its signature verified; scanning
    // forward would let a later, failing instruction appear to authorise us.
    for index in 0..current {
        let ix = load_instruction_at_checked(index, instructions_sysvar)?;
        if ix.program_id != ED25519_PROGRAM_ID {
            continue;
        }
        if instruction_covers(&ix.data, expected_key, expected_message)? {
            return Ok(());
        }
    }
    Err(MoatError::MissingEnclaveSignature.into())
}

/// Does this Ed25519 instruction verify `key` over `message`?
///
/// Returns `Ok(false)` for a well-formed instruction that signs something else —
/// a transaction may legitimately carry several — and an error only when the
/// data cannot be parsed at all.
fn instruction_covers(data: &[u8], key: &Pubkey, message: &[u8]) -> Result<bool> {
    let count = *data.first().ok_or(MoatError::MalformedEd25519Instruction)? as usize;
    let needed = HEADER_LEN
        .checked_add(count.checked_mul(OFFSETS_LEN).ok_or(MoatError::MalformedEd25519Instruction)?)
        .ok_or(MoatError::MalformedEd25519Instruction)?;
    require!(data.len() >= needed, MoatError::MalformedEd25519Instruction);

    for i in 0..count {
        let start = HEADER_LEN + i * OFFSETS_LEN;
        let entry = data
            .get(start..start + OFFSETS_LEN)
            .ok_or(MoatError::MalformedEd25519Instruction)?;
        let field = |at: usize| u16::from_le_bytes([entry[at], entry[at + 1]]);

        let signature_ix_index = field(2);
        let public_key_offset = field(4) as usize;
        let public_key_ix_index = field(6);
        let message_offset = field(8) as usize;
        let message_size = field(10) as usize;
        let message_ix_index = field(12);

        // Every part must live inside this same instruction. If any of them
        // point at another instruction's data, the offsets below would be read
        // against the wrong buffer — so such entries are skipped rather than
        // followed.
        if signature_ix_index != THIS_INSTRUCTION
            || public_key_ix_index != THIS_INSTRUCTION
            || message_ix_index != THIS_INSTRUCTION
        {
            continue;
        }

        let Some(signed_key) = data.get(public_key_offset..public_key_offset.saturating_add(32))
        else {
            continue;
        };
        if signed_key != key.as_ref() {
            continue;
        }

        // Length first: comparing a prefix would let a longer message that
        // merely starts with our intent pass as a signature over the intent.
        if message_size != message.len() {
            continue;
        }
        let Some(signed_message) = data.get(message_offset..message_offset.saturating_add(message_size))
        else {
            continue;
        };
        if signed_message == message {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build the data payload the Ed25519 native program expects, the way
    /// `Ed25519Program.createInstructionWithPublicKey` does client-side.
    fn ed25519_data(key: &[u8; 32], message: &[u8]) -> Vec<u8> {
        let mut data = vec![1u8, 0u8]; // one signature, padding
        let signature_offset = (HEADER_LEN + OFFSETS_LEN) as u16;
        let public_key_offset = signature_offset + 64;
        let message_offset = public_key_offset + 32;
        for value in [
            signature_offset,
            THIS_INSTRUCTION,
            public_key_offset,
            THIS_INSTRUCTION,
            message_offset,
            message.len() as u16,
            THIS_INSTRUCTION,
        ] {
            data.extend_from_slice(&value.to_le_bytes());
        }
        data.extend_from_slice(&[0u8; 64]); // signature bytes; the runtime checks these
        data.extend_from_slice(key);
        data.extend_from_slice(message);
        data
    }

    #[test]
    fn accepts_a_signature_over_the_expected_message() {
        let key = Pubkey::new_from_array([3u8; 32]);
        let message = b"moat:intent:v1 ...";
        let data = ed25519_data(&key.to_bytes(), message);
        assert!(instruction_covers(&data, &key, message).unwrap());
    }

    #[test]
    fn rejects_a_signature_by_a_different_key() {
        let message = b"moat:intent:v1 ...";
        let data = ed25519_data(&[3u8; 32], message);
        let other = Pubkey::new_from_array([4u8; 32]);
        assert!(!instruction_covers(&data, &other, message).unwrap());
    }

    #[test]
    fn rejects_a_signature_over_a_different_message() {
        let key = Pubkey::new_from_array([3u8; 32]);
        let data = ed25519_data(&key.to_bytes(), b"some other intent!");
        assert!(!instruction_covers(&data, &key, b"moat:intent:v1 ...").unwrap());
    }

    #[test]
    fn rejects_a_prefix_of_the_signed_message() {
        // A signature over "INTENT||extra" must not authorise "INTENT".
        let key = Pubkey::new_from_array([3u8; 32]);
        let data = ed25519_data(&key.to_bytes(), b"INTENTextra");
        assert!(!instruction_covers(&data, &key, b"INTENT").unwrap());
    }

    #[test]
    fn rejects_offsets_pointing_at_another_instruction() {
        // The offsets would otherwise be read against our own buffer.
        let key = Pubkey::new_from_array([3u8; 32]);
        let message = b"moat:intent:v1 ...";
        let mut data = ed25519_data(&key.to_bytes(), message);
        data[8..10].copy_from_slice(&0u16.to_le_bytes()); // public_key_instruction_index
        assert!(!instruction_covers(&data, &key, message).unwrap());
    }

    #[test]
    fn rejects_truncated_instruction_data() {
        assert!(instruction_covers(&[], &Pubkey::default(), b"x").is_err());
        assert!(instruction_covers(&[4u8, 0u8], &Pubkey::default(), b"x").is_err());
    }

    #[test]
    fn rejects_offsets_running_past_the_end() {
        let key = Pubkey::new_from_array([3u8; 32]);
        let message = b"moat:intent:v1 ...";
        let mut data = ed25519_data(&key.to_bytes(), message);
        data[6..8].copy_from_slice(&60_000u16.to_le_bytes()); // public_key_offset
        assert!(!instruction_covers(&data, &key, message).unwrap());
    }
}
