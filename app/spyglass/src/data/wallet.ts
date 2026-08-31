/**
 * Wallet connection, without a dependency tree.
 *
 * Phantom and Solflare both inject a provider that exposes `connect()`,
 * `disconnect()` and a `publicKey`. That covers the overwhelming majority of
 * Solana users, and it means the console can connect for real today rather than
 * waiting on an adapter bundle.
 *
 * If neither is installed the caller gets a specific error, not a spinner.
 */

interface InjectedProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  publicKey?: { toString(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  disconnect(): Promise<void>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    phantom?: { solana?: InjectedProvider };
    solflare?: InjectedProvider;
    solana?: InjectedProvider;
  }
}

export interface DetectedWallet {
  name: string;
  provider: InjectedProvider;
}

export function detectWallets(): DetectedWallet[] {
  const found: DetectedWallet[] = [];
  const phantom = window.phantom?.solana;
  if (phantom) found.push({ name: "Phantom", provider: phantom });
  if (window.solflare?.isSolflare) found.push({ name: "Solflare", provider: window.solflare });
  // A generic injected provider that is neither of the above.
  if (!found.length && window.solana) found.push({ name: "Injected wallet", provider: window.solana });
  return found;
}

export async function connect(wallet: DetectedWallet): Promise<string> {
  const res = await wallet.provider.connect();
  const key = res?.publicKey ?? wallet.provider.publicKey;
  if (!key) throw new Error(`${wallet.name} connected but returned no public key`);
  return key.toString();
}

export async function disconnect(wallet: DetectedWallet): Promise<void> {
  await wallet.provider.disconnect();
}

/**
 * Reconnect silently if this site was already approved. Never prompts — a page
 * that throws a wallet dialog at you on load is one people close.
 */
export async function autoConnect(wallet: DetectedWallet): Promise<string | null> {
  try {
    const res = await wallet.provider.connect({ onlyIfTrusted: true });
    return res?.publicKey?.toString() ?? null;
  } catch {
    return null;
  }
}
