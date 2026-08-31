import { useEffect, useState } from "react";
import { Sunk } from "./components/Chrome";
import { Ticker } from "./components/Ticker";
import { ThemeToggle } from "./components/ThemeToggle";
import { WalletProvider, useWallet } from "./data/WalletContext";
import { addr as shortAddr } from "./data/types";
import { OverviewView } from "./views/Overview";
import { VaultView } from "./views/Vault";
import { MandateView } from "./views/Mandate";
import { AttackView } from "./views/Attack";
import { ConsoleView } from "./views/Console";
import { DeskView } from "./views/Desk";
import { useVaultData } from "./data/useVaultData";
import { startTape } from "./data/oracleTape";
import { addr } from "./data/types";

/**
 * The shell: nav, routing, and the furniture every view shares.
 *
 * Routing is hash-based and dependency-free, which matters for two reasons: the
 * app is served as static files from a CDN with no rewrite rules, and a link to
 * a specific surface (say, the attack demo) has to survive being pasted into a
 * chat.
 */

const VIEWS = ["overview", "app", "console", "vault", "mandate", "attack"] as const;
type View = (typeof VIEWS)[number];

const LABEL: Record<View, string> = {
  overview: "Overview",
  app: "Desk",
  console: "Console",
  vault: "Vault",
  mandate: "Mandate",
  attack: "Attack",
};

function readHash(): View {
  const raw = window.location.hash.replace(/^#\/?/, "");
  return (VIEWS as readonly string[]).includes(raw) ? (raw as View) : "overview";
}

function WalletButton() {
  const { wallets, account, active, connecting, connect, disconnect } = useWallet();

  if (account) {
    return (
      <button type="button" className="walletbtn on" onClick={disconnect} title={`${active?.name} — click to disconnect`}>
        <span className="wdot" aria-hidden="true" />
        {shortAddr(account, 4, 4)}
      </button>
    );
  }
  if (!wallets.length) {
    return <span className="walletbtn muted" title="Install Phantom or Solflare">No wallet</span>;
  }
  return (
    <button type="button" className="walletbtn" onClick={() => connect(wallets[0])} disabled={connecting}>
      {connecting ? "Connecting…" : `Connect ${wallets[0].name}`}
    </button>
  );
}

function Shell() {
  const [view, setView] = useState<View>(readHash);
  const { vault, snapshot, hasKeep } = useVaultData();

  useEffect(() => {
    startTape();
  }, []);

  useEffect(() => {
    const onHash = () => setView(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = (next: string) => {
    window.location.hash = `#/${next}`;
    setView(readHash());
    window.scrollTo({ top: 0 });
  };

  return (
    <>
      <div className="page">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            Moat
          </div>
          <nav className="nav">
            {VIEWS.map((v) => (
              <a
                key={v}
                href={`#/${v}`}
                className={v === view ? "current" : ""}
                aria-current={v === view ? "page" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(v);
                }}
              >
                {LABEL[v]}
              </a>
            ))}
          </nav>
          <div className="chiprow">
            <span className="chip warn">devnet</span>
            <WalletButton />
            <ThemeToggle />
          </div>
        </header>
      </div>

      <Ticker />

      {view === "overview" && <OverviewView onNav={navigate} />}
      {view === "app" && <DeskView />}
      {view === "console" && <ConsoleView />}
      {view === "vault" && <VaultView />}
      {view === "mandate" && <MandateView />}
      {view === "attack" && <AttackView />}

      <div className="page">
        <footer className="foot">
          <div className="footgrid">
            <div>
              <h4>Vault</h4>
              <p>{addr(vault.address, 6, 6)}</p>
              <p>owner {addr(vault.owner, 4, 4)}</p>
            </div>
            <div>
              <h4>Enforced by</h4>
              <p>Solana · Pyth · Jupiter</p>
            </div>
            <div>
              <h4>{hasKeep ? "Sealed by" : "Designed to be sealed by"}</h4>
              <p>MagicBlock TEE · Intel TDX</p>
            </div>
            <div>
              <h4>Source</h4>
              <p>programs/moat · crates/moat-core · keep</p>
            </div>
          </div>

          <p className="footnote">
            This page reads only what the program publishes on-chain. There is no field it could
            show that explains why a trade happened, because none is ever written.
            {snapshot.source === "chain" ? (
              snapshot.historyIsLive ? null : (
                <>
                  {" "}
                  The vault above is read live from devnet. It has not traded yet, so the fills
                  charted here are illustrative — the Console reads the same account directly.
                </>
              )
            ) : (
              <>
                {" "}
                Showing sample data — the chain has not answered yet.
              </>
            )}
          </p>
        </footer>
      </div>

      <div className="closing">
        <Sunk />
      </div>
    </>
  );
}

export default function App() {
  return (
    <WalletProvider>
      <Shell />
    </WalletProvider>
  );
}
