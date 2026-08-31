/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Solana RPC to read from. Defaults to mainnet-beta public RPC. */
  readonly VITE_RPC_URL?: string;
  /** Deployed moat program id. When set, vault lookups verify account ownership. */
  readonly VITE_PROGRAM_ID?: string;
  /** Vault PDA to display once the program is deployed. */
  readonly VITE_VAULT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
