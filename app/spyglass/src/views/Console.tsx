import { useCallback, useEffect, useMemo, useState } from "react";
import { ACCOUNTS, build, toHex, type Encoded, type Ix, type PolicyInput } from "../data/anchor";
import { useWallet } from "../data/WalletContext";
import { looksLikeAddress, readVault, type VaultRead } from "../data/live";
import { addr } from "../data/types";
import { accountsFor, deriveVault, sendInstruction, type SendResult } from "../data/send";
import { PROGRAM_ID, RPC_URL, VAULT_ADDRESS } from "../data/config";

/**
 * The console — the part of this you operate.
 *
 * Connect a wallet, point at a vault, and drive it. Every action encodes a real
 * Anchor instruction and decodes it back field by field before anything is
 * signed. A wallet dialog over an opaque blob asks for trust it has not earned;
 * this one shows the bytes and what each one means.
 *
 * Sending is gated on `VITE_PROGRAM_ID`. Until the program is deployed the
 * encoder still runs — nothing here is a mock that would need replacing later.
 */

const RPC = RPC_URL;

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL = "So11111111111111111111111111111111111111112";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

/** Real mainnet Pyth feed ids, so the encoded policy is the one you would ship. */
const FEED = {
  sol: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  usdc: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
};

const ACTIONS: { id: Ix; label: string; blurb: string }[] = [
  { id: "open_vault", label: "Open vault", blurb: "Create the PDA and install its first mandate." },
  { id: "deposit", label: "Deposit", blurb: "Move tokens in. Owner only, by design." },
  { id: "withdraw", label: "Withdraw", blurb: "Always permitted to the owner — even while paused." },
  { id: "set_policy", label: "Set mandate", blurb: "Bumps the policy version, voiding signed intents." },
  { id: "rotate_signet", label: "Register keep", blurb: "Bind the enclave key that may sign intents." },
  { id: "set_paused", label: "Pause", blurb: "Guardian may pause. Only the owner may resume." },
];

const DEFAULT_POLICY: PolicyInput = {
  maxTradeNotionalUsd: 5_000,
  maxDailyNotionalUsd: 25_000,
  maxSlippageBps: 50,
  minCooldownSlots: 150,
  maxOracleStalenessSecs: 30,
  maxOracleConfBps: 100,
  maxQuoteDriftBps: 50,
  maxIntentLifetimeSlots: 300,
  mints: [
    { mint: USDC, symbol: "USDC", feedIdHex: FEED.usdc, decimals: 6 },
    { mint: SOL, symbol: "SOL", feedIdHex: FEED.sol, decimals: 9 },
  ],
  venues: [{ name: "Jupiter", address: JUPITER }],
};

export function ConsoleView() {
  const { account, active } = useWallet();

  const [vaultAddress, setVaultAddress] = useState(VAULT_ADDRESS);
  const [vaultState, setVaultState] = useState<VaultRead | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const [action, setAction] = useState<Ix>("open_vault");
  const [amount, setAmount] = useState("100");
  /** Which mint a deposit or withdrawal moves. Decides both token accounts. */
  const [mint, setMint] = useState(USDC);
  const [guardian, setGuardian] = useState("");
  const [enclaveKey, setEnclaveKey] = useState("");
  const [measurement, setMeasurement] = useState("");
  const [paused, setPaused] = useState(true);
  const [policy, setPolicy] = useState<PolicyInput>(DEFAULT_POLICY);

  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<SendResult | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  /**
   * The only vault this wallet can act on.
   *
   * `open_vault` derives its PDA from the signer (`seeds = [VAULT_SEED,
   * owner.key()]`), and every other instruction takes its seeds from the
   * vault's *stored* owner while separately requiring the signer to equal it.
   * Both roads lead to the same place: for any given wallet there is exactly
   * one vault the program will accept, and this is it.
   *
   * So sending never uses the address in the lookup box. That box exists to
   * read *anyone's* vault, and pointing a transaction at it is precisely how
   * you get `ConstraintSeeds` (2006) — the program derives one PDA, the
   * transaction supplies another, and Anchor prints both.
   */
  const myVault = useMemo(() => {
    if (!account || !PROGRAM_ID) return null;
    try {
      return deriveVault(PROGRAM_ID, account).address;
    } catch {
      return null;
    }
  }, [account]);

  /** Whether that vault has been opened yet. Decides which actions are legal. */
  const [myVaultExists, setMyVaultExists] = useState<boolean | null>(null);
  useEffect(() => {
    if (!myVault) {
      setMyVaultExists(null);
      return;
    }
    let alive = true;
    setMyVaultExists(null);
    readVault(myVault, RPC)
      .then(() => alive && setMyVaultExists(true))
      .catch(() => alive && setMyVaultExists(false));
    return () => {
      alive = false;
    };
  }, [myVault]);

  async function onSend() {
    if (!account || !active || !PROGRAM_ID || !encoded.data || !myVault) return;
    setSending(true);
    setSendError(null);
    setSent(null);
    try {
      // Always the caller's own PDA — never the browsed address.
      const keys = accountsFor(action, { vault: myVault, owner: account, mint });
      const result = await sendInstruction({
        endpoint: RPC,
        programId: PROGRAM_ID,
        owner: account,
        data: encoded.data.bytes,
        keys,
        provider: active.provider as never,
      });
      setSent(result);
      setMyVaultExists(true);
      // Point the reader at what we just changed, so the state below updates.
      setVaultAddress(myVault);
    } catch (e) {
      setSendError(String((e as Error)?.message ?? e));
    } finally {
      setSending(false);
    }
  }

  /**
   * Why the send button is unavailable, in the program's own terms. Naming the
   * reason beats a disabled button with no explanation, and both cases below
   * are ones the chain would otherwise reject after a wallet prompt.
   */
  const blocked: string | null = !account
    ? "Connect a wallet to send"
    : !PROGRAM_ID || !myVault
      ? "Program not deployed"
      : action === "open_vault" && myVaultExists === true
        ? "This wallet already has a vault"
        : action !== "open_vault" && myVaultExists === false
          ? "Open your vault first"
          : null;

  const onLookup = useCallback(async () => {
    setLookupError(null);
    setVaultState(null);
    if (!looksLikeAddress(vaultAddress)) {
      setLookupError("Not a base58 Solana address.");
      return;
    }
    setReading(true);
    try {
      setVaultState(await readVault(vaultAddress, RPC));
    } catch (e) {
      setLookupError(String((e as Error)?.message ?? e));
    } finally {
      setReading(false);
    }
  }, [vaultAddress]);

  // Read the deployed vault on arrival, and keep it current.
  //
  // Making someone press a button before the page will show them anything is
  // how the console ended up feeling like a mock-up: the state was real the
  // whole time, it just sat behind a click. The address is prefilled with the
  // live devnet vault, so there is nothing to wait for.
  //
  // Only the prefilled address auto-loads. Once someone types their own, the
  // effect stops firing on every keystroke and the button takes over — no
  // request storm, no error flashing while a valid address is half-typed.
  const autoRead = vaultAddress === VAULT_ADDRESS;
  useEffect(() => {
    if (!autoRead) return;
    let alive = true;
    const read = () => {
      readVault(VAULT_ADDRESS, RPC)
        .then((v) => alive && (setVaultState(v), setLookupError(null)))
        .catch((e) => alive && setLookupError(String((e as Error)?.message ?? e)));
    };
    read();
    // The vault changes when someone acts on it, including from this page.
    const id = setInterval(read, 20_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [autoRead]);

  const encoded = useMemo<{ data: Encoded | null; error: string | null }>(() => {
    try {
      const human = amount || "0";
      const atoms = BigInt(Math.round(Number(human) * 1e6));
      switch (action) {
        case "open_vault":
          return { data: build.openVault(guardian || account || SOL, policy), error: null };
        case "set_policy":
          return { data: build.setPolicy(policy), error: null };
        case "rotate_signet":
          return {
            data: build.rotateSignet(enclaveKey || SOL, measurement || "00".repeat(32), 1_512_000),
            error: null,
          };
        case "deposit":
          return { data: build.deposit(atoms, human), error: null };
        case "withdraw":
          return { data: build.withdraw(atoms, human), error: null };
        case "set_paused":
          return { data: build.setPaused(paused), error: null };
        default:
          return { data: null, error: "unsupported action" };
      }
    } catch (e) {
      return { data: null, error: String((e as Error)?.message ?? e) };
    }
  }, [action, amount, guardian, account, enclaveKey, measurement, paused, policy]);

  const current = ACTIONS.find((a) => a.id === action)!;
  const accounts = ACCOUNTS[action] ?? [];
  const setP = <K extends keyof PolicyInput>(k: K, v: PolicyInput[K]) =>
    setPolicy((p) => ({ ...p, [k]: v }));

  return (
    <div className="page">
      <section className="section" id="console">
        <div className="head">
          <div>
            <p className="label">Console</p>
            <h2>Drive the vault</h2>
          </div>
          <p>
            Every action encodes a real Anchor instruction and decodes it back, field by field,
            before anything is signed.
          </p>
        </div>

        {/* The vault you are about to act on, decoded. A byte count told an
            operator nothing; this is the state that decides whether an action
            will even be accepted. */}
        <div className="vaultbar">
          <div className="vb-find">
            <div className="lookup">
              <input
                value={vaultAddress}
                onChange={(e) => setVaultAddress(e.target.value)}
                placeholder="Vault address"
                aria-label="Vault address"
                spellCheck={false}
              />
              <button type="button" onClick={onLookup} disabled={reading}>
                {reading ? "…" : "Read"}
              </button>
            </div>
            {lookupError ? (
              <p className="sub miss">{lookupError}</p>
            ) : (
              <p className="sub">Read any vault. Sending always targets your own.</p>
            )}

            {account && myVault && (
              <p className="sub myvault">
                Your vault <code>{addr(myVault, 4, 4)}</code>
                {myVaultExists === null
                  ? " · checking…"
                  : myVaultExists
                    ? " · opened"
                    : " · not opened yet"}
                {vaultAddress !== myVault && (
                  <button type="button" className="linkish" onClick={() => setVaultAddress(myVault)}>
                    read mine
                  </button>
                )}
              </p>
            )}
          </div>

          {vaultState ? (
            <div className="vb-state">
              <div>
                <p className="k">Status</p>
                <p className={`val ${vaultState.vault.paused ? "miss" : ""}`}>
                  {vaultState.vault.paused ? "paused" : "trading"}
                </p>
              </div>
              <div>
                <p className="k">Keep</p>
                <p className={`val ${vaultState.vault.enclaveKey.startsWith("111111") ? "miss" : ""}`}>
                  {vaultState.vault.enclaveKey.startsWith("111111")
                    ? "none"
                    : addr(vaultState.vault.enclaveKey, 4, 4)}
                </p>
              </div>
              <div>
                <p className="k">Policy</p>
                <p className="val">v{vaultState.vault.policyVersion}</p>
              </div>
              <div>
                <p className="k">Next nonce</p>
                <p className="val">{vaultState.vault.nextNonce}</p>
              </div>
              <div>
                <p className="k">Per-trade cap</p>
                <p className="val">
                  ${(Number(vaultState.policy.maxTradeNotional) / 1e6).toLocaleString("en-US")}
                </p>
              </div>
              <div>
                <p className="k">Owner</p>
                <p className="val">{addr(vaultState.vault.owner, 4, 4)}</p>
              </div>
            </div>
          ) : (
            <div className="vb-state empty">
              <p className="sub">Read a vault to see its live state.</p>
            </div>
          )}
        </div>

        <div className="mandate">
          <div className="controls">
            <p className="k">Action</p>
            <div className="presets">
              {ACTIONS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={a.id === action ? "on" : ""}
                  onClick={() => setAction(a.id)}
                >
                  {a.label}
                </button>
              ))}
            </div>
            <p className="sub" style={{ marginTop: "-1.1rem", marginBottom: "1.5rem" }}>
              {current.blurb}
            </p>

            {(action === "deposit" || action === "withdraw") && (
              <>
                <label className="field">
                  <span>Mint <i>decides both token accounts</i></span>
                  <div className="presets">
                    {DEFAULT_POLICY.mints.map((m) => (
                      <button
                        key={m.mint}
                        type="button"
                        className={m.mint === mint ? "on" : ""}
                        onClick={() => setMint(m.mint)}
                      >
                        {m.symbol}
                      </button>
                    ))}
                  </div>
                </label>
                <label className="field">
                  <span>Amount <i>tokens, 6dp assumed</i></span>
                  <input className="text" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
                </label>
                <p className="sub" style={{ marginTop: "-1.1rem", marginBottom: "1.5rem" }}>
                  Moves between your associated token account and the vault's. Both are derived,
                  not typed — the program checks the authority on each before it transfers.
                </p>
              </>
            )}

            {action === "open_vault" && (
              <label className="field">
                <span>Guardian <i>may pause, may never withdraw</i></span>
                <input
                  className="text"
                  value={guardian}
                  onChange={(e) => setGuardian(e.target.value)}
                  placeholder={account ?? "guardian address"}
                  spellCheck={false}
                />
              </label>
            )}

            {action === "rotate_signet" && (
              <>
                <label className="field">
                  <span>Enclave signing key</span>
                  <input className="text" value={enclaveKey} onChange={(e) => setEnclaveKey(e.target.value)} placeholder="ed25519 pubkey" spellCheck={false} />
                </label>
                <label className="field">
                  <span>Code measurement <i>32 bytes hex</i></span>
                  <input className="text" value={measurement} onChange={(e) => setMeasurement(e.target.value)} placeholder="TDX measurement" spellCheck={false} />
                </label>
              </>
            )}

            {action === "set_paused" && (
              <button
                type="button"
                className={`toggle ${paused ? "on" : ""}`}
                onClick={() => setPaused((v) => !v)}
                aria-pressed={paused}
              >
                <span className="dotbox" aria-hidden="true" />
                {paused ? "Pause the vault" : "Resume trading"}
              </button>
            )}

            {(action === "open_vault" || action === "set_policy") && (
              <>
                <label className="field">
                  <span>Per-trade cap <b>${policy.maxTradeNotionalUsd.toLocaleString("en-US")}</b></span>
                  <input type="range" min={100} max={50000} step={100} value={policy.maxTradeNotionalUsd}
                    onChange={(e) => setP("maxTradeNotionalUsd", Number(e.target.value))} />
                </label>
                <label className="field">
                  <span>Daily cap <b>${policy.maxDailyNotionalUsd.toLocaleString("en-US")}</b></span>
                  <input type="range" min={1000} max={250000} step={1000} value={policy.maxDailyNotionalUsd}
                    onChange={(e) => setP("maxDailyNotionalUsd", Number(e.target.value))} />
                </label>
                <label className="field">
                  <span>Max slippage <b>{policy.maxSlippageBps} bps</b></span>
                  <input type="range" min={1} max={500} step={1} value={policy.maxSlippageBps}
                    onChange={(e) => setP("maxSlippageBps", Number(e.target.value))} />
                </label>
                <p className="sub">
                  Assets fixed to USDC · SOL with their real mainnet Pyth feed ids; venue Jupiter.
                </p>
              </>
            )}
          </div>

          <div className="verdict">
            {encoded.error ? (
              <>
                <p className="k">Instruction</p>
                <p className="sub miss">{encoded.error}</p>
              </>
            ) : (
              <>
                <div className="ixhead">
                  <div>
                    <p className="k">Instruction</p>
                    <p className="ixname">{action}</p>
                  </div>
                  <div className="ixmeta">
                    <span>{encoded.data!.bytes.length} bytes</span>
                    <span>{encoded.data!.fields.length} fields</span>
                    <span>{accounts.length} accounts</span>
                  </div>
                </div>

                <div className="decode">
                  {encoded.data!.fields.map((f, i) => (
                    <div className="row2" key={`${f.label}-${i}`}>
                      <div className="meta">
                        <b>{f.label}</b>
                        <em>{f.type}</em>
                        {f.value && <span>{f.value}</span>}
                      </div>
                      <code className={i === 0 ? "hex disc" : "hex"}>{f.hex}</code>
                    </div>
                  ))}
                </div>

                <details className="raw">
                  <summary>Raw instruction data</summary>
                  <code className="hex block">{toHex(encoded.data!.bytes)}</code>
                </details>

                {accounts.length > 0 && (
                  <>
                    <p className="k" style={{ marginTop: "1.4rem" }}>Accounts, in order</p>
                    <div className="acctlist">
                      {accounts.map((a, i) => (
                        <div key={a.name}>
                          <span className="ix">{i}</span>
                          <code>{a.name}</code>
                          <em>{a.role}</em>
                          <span className="sub">{a.note}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                <button
                  type="button"
                  className={`send ${!blocked && !sending ? "live" : ""}`}
                  disabled={!!blocked || sending}
                  onClick={onSend}
                >
                  {sending ? "Simulating, then signing…" : (blocked ?? `Send ${action}`)}
                </button>

                {!blocked && myVault && (
                  <p className="sub sendtarget">
                    Signing as <code>{addr(account!, 4, 4)}</code> against your vault{" "}
                    <code>{addr(myVault, 4, 4)}</code>.
                  </p>
                )}

                {sendError && <p className="sub miss sendmsg">{sendError}</p>}
                {sent && (
                  <p className="sub sendmsg ok">
                    Confirmed ·{" "}
                    <a href={sent.explorer} target="_blank" rel="noreferrer">
                      {sent.signature.slice(0, 24)}…
                    </a>
                  </p>
                )}
                <p className="sub">
                  Devnet only — the cluster's genesis hash is checked before signing, and the
                  transaction is simulated first so a failing one never reaches your wallet. This
                  program is unaudited with three open findings; see the README.
                </p>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
