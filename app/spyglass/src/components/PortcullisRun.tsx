import { useEffect, useMemo, useState } from "react";

/**
 * The portcullis, running.
 *
 * One intent arriving and being checked, in the order `execute_sortie` actually
 * checks it — signature, then binding, then the numeric bounds, then the floor,
 * then the post-swap assertions. The stagger is the point: it makes visible that
 * the enclave's signature is the *first* gate, not the last word.
 *
 * The final line is the one that distinguishes this design, so it lands last and
 * lingers.
 */

const STEPS: { label: string; detail: string; pivotal?: boolean }[] = [
  { label: "Ed25519 signature", detail: "signed by the registered enclave key" },
  { label: "Nonce", detail: "matches vault.next_nonce · no replay" },
  { label: "Accounts bound", detail: "token accounts pinned by ATA derivation" },
  { label: "Caps", detail: "$4,000 ≤ $5,000 per-trade · daily headroom ok" },
  { label: "Oracle", detail: "±0.9 bps ≤ 100 · 4s old ≤ 30s" },
  { label: "Price floor", detail: "min_out ≥ oracle-fair × (1 − 50bps)", pivotal: true },
];

const STEP_MS = 620;
const HOLD_MS = 2600;

export function PortcullisRun() {
  const reduced = useMemo(
    () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
    []
  );
  const [done, setDone] = useState(reduced ? STEPS.length : 0);

  useEffect(() => {
    if (reduced) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const advance = (n: number) => {
      if (cancelled) return;
      if (n <= STEPS.length) {
        setDone(n);
        timer = setTimeout(() => advance(n + 1), STEP_MS);
      } else {
        // Hold on the completed state, then run it again.
        timer = setTimeout(() => {
          if (cancelled) return;
          setDone(0);
          timer = setTimeout(() => advance(1), 400);
        }, HOLD_MS);
      }
    };
    timer = setTimeout(() => advance(1), 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [reduced]);

  const settled = done > STEPS.length - 1;

  return (
    <div className="portrun">
      <div className="sb-head">
        <p className="k">One intent, checked</p>
        <p className={`pr-verdict ${settled ? "on" : ""}`}>{settled ? "SETTLED" : "CHECKING…"}</p>
      </div>

      <ol className="pr-list">
        {STEPS.map((s, i) => {
          const state = i < done ? "pass" : "pending";
          return (
            <li key={s.label} className={`${state} ${s.pivotal ? "pivotal" : ""}`}>
              <span className="pr-mark">{i < done ? "✓" : ""}</span>
              <span className="pr-body">
                <b>{s.label}</b>
                <em>{s.detail}</em>
              </span>
            </li>
          );
        })}
      </ol>

      <p className="sb-note">
        The signature is the first check, not the last. Everything after it is re-checked on-chain.
      </p>
    </div>
  );
}
