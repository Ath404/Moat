/**
 * Integration tests for the moat program.
 *
 * STATUS: scaffold. These have never been run — the Anchor CLI is not installed
 * in the environment this was written in. They are written out rather than left
 * as a TODO because the *shape* of the setup is the part worth getting down: the
 * Ed25519 instruction must be prepended to the transaction, the intent encoding
 * must match `moat-core` byte for byte, and the Pyth accounts must be posted
 * updates for the right feed ids. Each of those is a place to lose an afternoon.
 *
 * Run with:  anchor test
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Ed25519Program, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";
import { Moat } from "../target/types/moat";

/** Mirrors `moat_core::intent::INTENT_DOMAIN` — 16 bytes, NUL padded. */
const INTENT_DOMAIN = Buffer.concat([Buffer.from("moat:intent:v1"), Buffer.alloc(2)]);

/** Mirrors `TradeIntent::SIGNING_LEN`. Asserted below rather than trusted. */
const SIGNING_LEN = 275;

interface OracleQuote {
  price: bigint;
  conf: bigint;
  expo: number;
  decimals: number;
  publishTs: bigint;
}

interface TradeIntent {
  vault: PublicKey;
  policyVersion: number;
  nonce: bigint;
  expirySlot: bigint;
  side: 0 | 1;
  mintIn: PublicKey;
  mintOut: PublicKey;
  amountIn: bigint;
  minAmountOut: bigint;
  maxSlippageBps: number;
  venue: PublicKey;
  sortieIndex: number;
  sortieCount: number;
  vrfCommitment: Buffer;
  quotedIn: OracleQuote;
  quotedOut: OracleQuote;
}

/**
 * The canonical encoding, little-endian and fixed-width.
 *
 * This must stay byte-identical to `TradeIntent::signing_bytes` in
 * `crates/moat-core/src/intent.rs`. If the two ever disagree the program will
 * reject every intent with `MissingEnclaveSignature`, which is a confusing way
 * to learn that a field moved.
 */
function encodeIntent(i: TradeIntent): Buffer {
  const parts: Buffer[] = [];
  const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const i32 = (v: number) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
  const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
  const i64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return b; };
  const quote = (q: OracleQuote) =>
    Buffer.concat([u64(q.price), u64(q.conf), i32(q.expo), Buffer.from([q.decimals]), i64(q.publishTs)]);

  parts.push(INTENT_DOMAIN);
  parts.push(i.vault.toBuffer());
  parts.push(u32(i.policyVersion));
  parts.push(u64(i.nonce));
  parts.push(u64(i.expirySlot));
  parts.push(Buffer.from([i.side]));
  parts.push(i.mintIn.toBuffer());
  parts.push(i.mintOut.toBuffer());
  parts.push(u64(i.amountIn));
  parts.push(u64(i.minAmountOut));
  parts.push(u16(i.maxSlippageBps));
  parts.push(i.venue.toBuffer());
  parts.push(Buffer.from([i.sortieIndex, i.sortieCount]));
  parts.push(i.vrfCommitment);
  parts.push(quote(i.quotedIn));
  parts.push(quote(i.quotedOut));

  const out = Buffer.concat(parts);
  assert.equal(out.length, SIGNING_LEN, "intent encoding drifted from moat-core");
  return out;
}

describe("moat", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Moat as Program<Moat>;
  const owner = (program.provider as anchor.AnchorProvider).wallet;

  const vaultPda = () =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), owner.publicKey.toBuffer()],
      program.programId
    )[0];

  it("encodes an intent to exactly SIGNING_LEN bytes", () => {
    // Runs without a validator, and is the check most likely to catch a
    // regression: a field added on the Rust side and forgotten here.
    const quote: OracleQuote = { price: 100_000_000n, conf: 20_000n, expo: -8, decimals: 6, publishTs: 1_770_000_000n };
    const bytes = encodeIntent({
      vault: PublicKey.default,
      policyVersion: 1,
      nonce: 0n,
      expirySlot: 100n,
      side: 0,
      mintIn: PublicKey.default,
      mintOut: PublicKey.default,
      amountIn: 1n,
      minAmountOut: 1n,
      maxSlippageBps: 50,
      venue: PublicKey.default,
      sortieIndex: 0,
      sortieCount: 1,
      vrfCommitment: Buffer.alloc(32),
      quotedIn: quote,
      quotedOut: quote,
    });
    assert.equal(bytes.length, SIGNING_LEN);
    assert.deepEqual(bytes.subarray(0, 16), INTENT_DOMAIN);
  });

  it("opens a vault with a policy", async () => {
    // TODO: needs SPL mints and a funded owner. Shape:
    //
    //   await program.methods
    //     .openVault(guardian.publicKey, {
    //       maxTradeNotional: new BN(5_000_000_000),
    //       maxDailyNotional: new BN(25_000_000_000),
    //       maxSlippageBps: 100,
    //       minCooldownSlots: new BN(0),
    //       maxOracleStalenessSecs: new BN(30),
    //       maxOracleConfBps: 100,
    //       maxQuoteDriftBps: 50,
    //       maxIntentLifetimeSlots: new BN(300),
    //       mints: [{ mint: usdc, feedId: [...], decimals: 6 }, ...],
    //       venues: [JUPITER_PROGRAM_ID],
    //     })
    //     .accounts({ vault: vaultPda(), owner: owner.publicKey, systemProgram: SystemProgram.programId })
    //     .rpc();
    //
    // Then assert policyVersion === 1 and enclaveKey === PublicKey.default:
    // a fresh vault must be unable to trade until rotateSignet runs.
  });

  it("refuses a sortie whose min_amount_out is below the oracle floor", async () => {
    // The headline property, end to end. Needs:
    //
    //   1. a posted Pyth PriceUpdateV2 for each mint (pyth-solana-receiver, or a
    //      mocked account with the right discriminator and feed id);
    //   2. an enclave keypair registered via rotateSignet;
    //   3. an intent with min_amount_out deliberately set to 1;
    //   4. tx = [Ed25519Program.createInstructionWithPrivateKey({...}), executeSortie(...)]
    //
    // Expect: SlippageFloorBreached. This is the test that demonstrates a
    // compromised keep cannot hand the position to a sandwich, so it is worth
    // writing before the happy path.
    //
    //   const message = encodeIntent(intent);
    //   const edIx = Ed25519Program.createInstructionWithPrivateKey({
    //     privateKey: enclave.secretKey,
    //     message,
    //   });
    //   await program.methods.executeSortie(message, routeData)
    //     .accounts({...}).remainingAccounts(jupiterAccounts)
    //     .preInstructions([edIx]).rpc();
  });

  it("refuses an intent signed by a key that is not the registered enclave", async () => {
    // Same setup, signed by a different keypair. Expect MissingEnclaveSignature:
    // the Ed25519 instruction verifies fine, it just does not cover our key.
  });

  it("lets the owner withdraw while paused", async () => {
    // The non-custodial property. Pause via the guardian, then withdraw as the
    // owner, and assert it succeeds. If this test ever fails, the vault has
    // become a custodian and nothing else in the suite matters.
  });
});
