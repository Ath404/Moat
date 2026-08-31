# The Moat web app

React + Vite. Deployed at **[moat-vault.vercel.app](https://moat-vault.vercel.app)**, reading the
live devnet program and vault. `@solana/web3.js` is the only Solana dependency — account reads are
hand-written byte offsets against `Vault`, and instruction data is encoded by hand so the app can
show a reader the exact bytes before anything is signed.

> The directory is named `spyglass` for historical reasons. The product is Moat; the word does not
> appear anywhere user-facing.

## Surfaces

| Route | What it does |
|---|---|
| `#/overview` | The claim, who it is for, and a live oracle panel |
| `#/app` | **The desk.** Price against the floor beneath it, a ticket that runs the deployed vault's real caps, mandate meters, on-chain activity, and six refusals proved against the deployed program |
| `#/console` | Build any instruction against any vault. Encodes real Anchor data, decodes it back field by field, and sends it with a connected wallet |
| `#/vault` | Execution quality per fill |
| `#/mandate` | Write a policy and replay history through it the way the chain would |
| `#/attack` | You hold the compromised enclave. Try to drain the vault |

## What is live and what is not

Read live from devnet: the vault account, its mandate, its authorities, its paused state and
nonce, the Pyth price, the chain slot, and the vault's transaction signatures.

Sample data: the per-fill execution history on `#/overview` and `#/vault`. The deployed vault has
never traded, so there is no real history to draw. `snapshot.historyIsLive` carries that
distinction and the footer states it in plain language.

## Run it

```bash
npm install
npm run dev
```

No environment variables required. `src/data/config.ts` reads `VITE_RPC_URL`, `VITE_PROGRAM_ID`
and `VITE_VAULT` when present and otherwise falls back to the real devnet deployment — `.env` is
gitignored, and an env-dependent build once shipped to production with sending disabled and an
empty vault field.

## Two things worth knowing before editing

**`Buffer` is polyfilled in `src/main.tsx`.** Vite does not provide it and `@solana/web3.js`
needs it. Without it every transaction-building path throws `Buffer is not defined` — at *send*
time only, so reads and the encoder look perfectly healthy while signing is dead.

**`styles.css` is one long file and the obvious class names are taken.** `.stage` belongs to
`HeroStage`; `.chip`, `.meter` and `.meter i` are already defined. Collisions here never error,
they just render something absurd. Grep before adding a rule.

## Files worth reading first

```
src/data/config.ts     deployment constants, env-optional by design
src/data/prove.ts      the six on-chain probes and how their verdicts are read
src/data/anchor.ts     instruction encoding that reports what it wrote
src/data/chain.ts      the Vault byte layout, in declaration order
src/data/live.ts       RPC, Pyth decoding, vault reads
src/views/Desk.tsx     the desk
```
