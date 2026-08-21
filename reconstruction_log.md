* **2026-08-21T09:00:00**: chore: initialise anchor workspace and cargo layout
* **2026-08-21T10:24:00**: chore: exclude moat-core so it builds without the solana toolchain
* **2026-08-21T11:48:00**: feat(core): add TradeIntent with a domain-separated canonical encoding
* **2026-08-21T13:12:00**: feat(core): define PolicyBounds and the Vault account layout
* **2026-08-21T14:36:00**: test(core): round-trip every field of a signed intent
* **2026-08-22T09:00:00**: feat(core): implement check_intent with per-trade and daily caps
* **2026-08-22T10:24:00**: feat(core): enforce cooldown, nonce ordering and policy version
* **2026-08-22T11:48:00**: feat(core): add mint and venue allowlists
* **2026-08-22T13:12:00**: feat(core): bound oracle staleness and confidence
* **2026-08-22T14:36:00**: test(core): cover every Denial variant
* **2026-08-23T09:00:00**: feat(core): derive the price floor from the chain s own oracle read
* **2026-08-23T11:20:00**: feat(core): split an order into legs from a VRF word
* **2026-08-23T13:40:00**: test(core): property test that legs sum to the requested amount
* **2026-08-24T09:00:00**: feat(program): open_vault, set_policy and rotate_signet
* **2026-08-24T10:45:00**: feat(program): deposit and withdraw
* **2026-08-24T12:30:00**: feat(program): set_paused, with guardian able to pause but not resume
* **2026-08-24T14:15:00**: feat(program): error codes and events
* **2026-08-25T09:00:00**: feat(program): parse the Ed25519 sigverify instruction by introspection
* **2026-08-25T10:45:00**: feat(program): decode Pyth PriceUpdateV2 with variable-width verification level
* **2026-08-25T12:30:00**: feat(program): execute_sortie with pre/post balance measurement
* **2026-08-25T14:15:00**: test(program): ed25519 instruction parser
* **2026-08-26T09:00:00**: fix(program): pin vault token accounts by ATA derivation
* **2026-08-26T09:46:00**: fix(program): require the input account to be debited by exactly amount_in
* **2026-08-26T10:32:00**: fix(program): reject any unmeasured vault-owned token account in the route
* **2026-08-26T11:18:00**: fix(program): require a non-zero output
* **2026-08-26T12:04:00**: fix(program): box accounts to stay inside the BPF 4KB stack frame
* **2026-08-26T12:50:00**: fix(core): separate the slot clock from the unix clock
* **2026-08-26T13:36:00**: fix(core): reject max_slippage_bps at 10000, where the floor collapses
* **2026-08-26T14:22:00**: fix(keep): treat a zero oracle price as an outage, not a buy signal
* **2026-08-26T15:08:00**: fix(core): floor each sortie leg at one atom
* **2026-08-27T09:00:00**: feat(keep): strategy evaluation and intent signing
* **2026-08-27T11:20:00**: feat(keep): VRF-derived execution plan
* **2026-08-27T13:40:00**: test(keep): walk a signed plan leg-by-leg through check_intent
* **2026-08-28T09:00:00**: feat(app): scaffold spyglass on vite, react and typescript
* **2026-08-28T10:24:00**: feat(app): decode the Vault account from hand-written byte offsets
* **2026-08-28T11:48:00**: feat(app): encode anchor instructions with a field-by-field breakdown
* **2026-08-28T13:12:00**: feat(app): live RPC and Pyth panel
* **2026-08-28T14:36:00**: fix(app): read from devnet — mainnet-beta 403s browser origins
* **2026-08-29T09:00:00**: feat(app): overview, vault, mandate and attack views
* **2026-08-29T10:24:00**: feat(app): console with wallet connect and transaction send
* **2026-08-29T11:48:00**: fix(app): polyfill Buffer, which vite does not provide and web3.js needs
* **2026-08-29T13:12:00**: feat(app): the desk — live floor chart, order ticket and mandate meters
* **2026-08-29T14:36:00**: fix(app): prove refusals on-chain through simulateTransaction
* **2026-08-30T09:00:00**: chore: deploy the program to devnet and open the first vault
* **2026-08-30T10:45:00**: feat(app): read the deployed vault live instead of a fixture
* **2026-08-30T12:30:00**: fix(app): fall back to real devnet values so the build needs no env vars
* **2026-08-30T14:15:00**: docs: README — what it is, what is different, and what is not done
