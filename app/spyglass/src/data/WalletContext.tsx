import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { autoConnect, connect, detectWallets, disconnect, type DetectedWallet } from "./wallet";

/**
 * Wallet state, lifted.
 *
 * The connect control lives in the top bar, but the console is what actually
 * signs, so the two have to agree about who is connected. One provider rather
 * than two copies of the same state that drift the moment someone disconnects
 * from one of them.
 */

interface WalletState {
  wallets: DetectedWallet[];
  account: string | null;
  active: DetectedWallet | null;
  error: string | null;
  connecting: boolean;
  connect(w: DetectedWallet): Promise<void>;
  disconnect(): Promise<void>;
}

const Ctx = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<DetectedWallet[]>([]);
  const [account, setAccount] = useState<string | null>(null);
  const [active, setActive] = useState<DetectedWallet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    const found = detectWallets();
    setWallets(found);
    // Silent reconnect only — never throw a wallet dialog at someone on load.
    if (found[0]) {
      autoConnect(found[0]).then((key) => {
        if (key) {
          setAccount(key);
          setActive(found[0]);
        }
      });
    }
  }, []);

  const value = useMemo<WalletState>(
    () => ({
      wallets,
      account,
      active,
      error,
      connecting,
      async connect(w) {
        setError(null);
        setConnecting(true);
        try {
          setAccount(await connect(w));
          setActive(w);
        } catch (e) {
          setError(String((e as Error)?.message ?? e));
        } finally {
          setConnecting(false);
        }
      },
      async disconnect() {
        if (active) await disconnect(active).catch(() => undefined);
        setAccount(null);
        setActive(null);
      },
    }),
    [wallets, account, active, error, connecting]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet used outside WalletProvider");
  return v;
}
