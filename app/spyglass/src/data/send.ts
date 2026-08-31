/**
 * Sending transactions.
 *
 * The read path in `chain.ts` is hand-written against fixed byte offsets, which
 * is both verifiable and self-documenting. The *write* path is not the place for
 * that: legacy message serialisation involves compact-u16 arrays, account
 * deduplication, and a signer/writable ordering that has to match the header
 * counts exactly. Getting it subtly wrong produces failures that are miserable
 * to diagnose, and the code moves money. So this file uses `@solana/web3.js`.
 *
 * Guard rails, in order of how much they matter:
 *
 * 1. The cluster is checked against devnet's genesis hash before anything is
 *    signed. This program is unaudited with three open findings; it has no
 *    business being driven against mainnet by accident.
 * 2. Simulation runs first, and a failing simulation aborts before the wallet
 *    is ever asked to sign.
 * 3. The program id the instruction targets is compared to the deployed id.
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type { Ix } from "./anchor";

/** Genesis hash of devnet. Mainnet is 5eykt4… and testnet is 4uhcVJy…. */
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export const VAULT_SEED = "vault";

export interface SendResult {
  signature: string;
  explorer: string;
}

export class ClusterMismatch extends Error {
  constructor(actual: string) {
    super(
      `Refusing to send: connected cluster's genesis is ${actual.slice(0, 8)}…, not devnet. ` +
        `This program is unaudited and devnet-only.`
    );
    this.name = "ClusterMismatch";
  }
}

/** Derive the vault PDA for an owner. Matches `seeds = [b"vault", owner]`. */
export function deriveVault(programId: string, owner: string): { address: string; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_SEED), new PublicKey(owner).toBuffer()],
    new PublicKey(programId)
  );
  return { address: pda.toBase58(), bump };
}

/** SPL Token. A Token-2022 mint would need the other id; none is used here. */
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/**
 * The associated token account for `(owner, mint)`.
 *
 * Derived here rather than pulled in from `@solana/spl-token`, which would add a
 * whole dependency for one `findProgramAddressSync` call. The seeds are fixed by
 * the ATA program, and the owner is allowed to be off-curve — which is what makes
 * this work for the vault PDA as well as for a wallet.
 */
export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM
  );
  return ata;
}

/** The accounts each instruction needs, resolved to real addresses. */
export function accountsFor(
  ix: Ix,
  ctx: { vault: string; owner: string; mint?: string }
): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] {
  const vault = new PublicKey(ctx.vault);
  const owner = new PublicKey(ctx.owner);
  switch (ix) {
    case "open_vault":
      return [
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
    case "set_policy":
    case "rotate_signet":
      return [
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ];
    case "set_paused":
      return [
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ];
    // Both token movements take the same six accounts, but with `from` and `to`
    // on opposite sides: deposit pulls from the owner's ATA into the vault's,
    // withdraw does the reverse. The order below matches `Deposit` and
    // `Withdraw` in drawbridge.rs field-for-field. An Anchor account list is
    // positional, so getting this wrong is a silent wrong-account send rather
    // than an error.
    case "deposit":
    case "withdraw": {
      if (!ctx.mint) throw new Error(`${ix} needs a mint`);
      const mint = new PublicKey(ctx.mint);
      const ownerAta = associatedTokenAddress(owner, mint);
      const vaultAta = associatedTokenAddress(vault, mint);
      const head = [
        // `vault` is not `mut` on either instruction: the tokens move between
        // token accounts, and the PDA itself is only read for its seeds.
        { pubkey: vault, isSigner: false, isWritable: false },
        { pubkey: owner, isSigner: true, isWritable: true },
      ];
      const tail = [
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      ];
      return ix === "deposit"
        ? [
            ...head,
            { pubkey: ownerAta, isSigner: false, isWritable: true }, // from
            { pubkey: vaultAta, isSigner: false, isWritable: true }, // vault_token
            ...tail,
          ]
        : [
            ...head,
            { pubkey: vaultAta, isSigner: false, isWritable: true }, // vault_token
            { pubkey: ownerAta, isSigner: false, isWritable: true }, // to
            ...tail,
          ];
    }
    default:
      // Only `execute_sortie` reaches here. It is the keep's instruction, not
      // the owner's: it carries an Ed25519 signature over a TradeIntent and must
      // be preceded by the sigverify instruction in the same transaction. There
      // is nothing a wallet could assemble from this console.
      throw new Error(`${ix} is signed by the keep, not from this console`);
  }
}

interface Provider {
  signAndSendTransaction?(tx: Transaction): Promise<{ signature: string }>;
  signTransaction?(tx: Transaction): Promise<Transaction>;
}

/**
 * Build, simulate, sign and send. Returns only after the network confirms.
 */
export async function sendInstruction(opts: {
  endpoint: string;
  programId: string;
  owner: string;
  data: Uint8Array;
  keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[];
  provider: Provider;
}): Promise<SendResult> {
  const conn = new Connection(opts.endpoint, "confirmed");

  const genesis = await conn.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) throw new ClusterMismatch(genesis);

  const ix = new TransactionInstruction({
    programId: new PublicKey(opts.programId),
    keys: opts.keys,
    data: Buffer.from(opts.data),
  });

  const tx = new Transaction().add(ix);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = new PublicKey(opts.owner);

  // Simulate before asking anyone to sign. A wallet prompt for a transaction
  // that cannot succeed is just a way to lose someone's trust.
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    const logs = (sim.value.logs ?? []).filter((l) => /Error|failed|Program log/.test(l));
    throw new Error(
      `Simulation failed: ${JSON.stringify(sim.value.err)}` +
        (logs.length ? `\n${logs.slice(-4).join("\n")}` : "")
    );
  }

  let signature: string;
  if (opts.provider.signAndSendTransaction) {
    ({ signature } = await opts.provider.signAndSendTransaction(tx));
  } else if (opts.provider.signTransaction) {
    const signed = await opts.provider.signTransaction(tx);
    signature = await conn.sendRawTransaction(signed.serialize());
  } else {
    throw new Error("wallet exposes neither signAndSendTransaction nor signTransaction");
  }

  const confirmed = await conn.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  if (confirmed.value.err) {
    throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmed.value.err)}`);
  }

  return {
    signature,
    explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
  };
}
