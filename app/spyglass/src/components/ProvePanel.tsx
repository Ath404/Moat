import { useCallback, useEffect, useRef, useState } from "react";
import { PROGRAM_ID, RPC_URL, VAULT_ADDRESS } from "../data/config";
import { PROBES, runAllProbes, type ProbeOutcome } from "../data/prove";

/**
 * The refusals, proved by the chain.
 *
 * Everything else on this site that says "the vault would refuse" is this app's
 * own arithmetic. This panel is the one place that does not take our word for
 * it: it builds real instructions, sends them to `simulateTransaction` against
 * the deployed program, and prints what came back — error number, error name,
 * and the file and line in the Rust where the check fired.
 *
 * The two probes expected to be *accepted* are not filler. A panel where every
 * row is red demonstrates a broken harness just as well as a working vault, and
 * the difference between those two readings is the whole value of the panel.
 */

function Row({ o }: { o: ProbeOutcome }) {
  const [open, setOpen] = useState(false);

  const asExpected =
    o.refused === null ? null : o.refused === (o.expects === "refused");
  const verdict =
    o.refused === null ? "…" : o.refused ? "REFUSED" : "ACCEPTED";

  return (
    <li className={`probe ${o.refused === null ? "pending" : o.refused ? "denied" : "allowed"}`}>
      <div className="probe-top">
        <div className="probe-what">
          <p className="probe-title">
            {o.title}
            <span className={`whom ${o.as}`}>{o.as === "owner" ? "as owner" : "as a stranger"}</span>
          </p>
          <code className="probe-ask">{o.ask}</code>
        </div>
        <div className="probe-verdict">
          <span className={`vbadge ${o.refused === null ? "" : o.refused ? "no" : "yes"}`}>
            {o.broke ? "ERROR" : verdict}
          </span>
          {asExpected === false && <span className="vwarn">unexpected</span>}
        </div>
      </div>

      {o.broke ? (
        <p className="probe-broke">could not reach the cluster — {o.broke}</p>
      ) : o.refused ? (
        <div className="probe-detail">
          <p className="probe-err">
            <b>{o.code ?? "error"}</b>
            {o.number !== null && <span className="num">#{o.number}</span>}
            {o.message && <em>{o.message}</em>}
          </p>
          {o.where && <p className="probe-where">thrown at {o.where}</p>}
        </div>
      ) : o.refused === false ? (
        <p className="probe-detail ok">
          The program ran to completion. Nothing settled — this is a simulation.
        </p>
      ) : null}

      <p className="probe-because">{o.because}</p>

      {o.logs.length > 0 && (
        <>
          <button type="button" className="probe-more" onClick={() => setOpen((v) => !v)}>
            {open ? "hide" : "show"} the cluster's reply
            {o.units !== null && <i> · {o.units.toLocaleString("en-US")} compute units</i>}
          </button>
          {open && (
            <pre className="probe-logs">
              {o.err ? `err: ${o.err}\n\n` : "err: null\n\n"}
              {o.logs.join("\n")}
            </pre>
          )}
        </>
      )}
    </li>
  );
}

export function ProvePanel({ owner }: { owner: string }) {
  const [results, setResults] = useState<ProbeOutcome[]>([]);
  const [running, setRunning] = useState(false);

  // Epoch, so a run started for an older owner cannot write its results over a
  // newer one. The owner arrives twice: once as the placeholder the dashboard
  // renders before the chain answers, then again for real.
  const epoch = useRef(0);

  const run = useCallback(async () => {
    if (!owner) return;
    const mine = ++epoch.current;
    setRunning(true);
    setResults([]);
    await runAllProbes(
      { endpoint: RPC_URL, programId: PROGRAM_ID, vault: VAULT_ADDRESS, owner },
      (o) => {
        if (epoch.current === mine) setResults((prev) => [...prev, o]);
      }
    );
    if (epoch.current === mine) setRunning(false);
  }, [owner]);

  // Runs when the owner is known, and again if it changes. `owner` is empty
  // until the vault has actually been read, because probing with a fee payer
  // that does not exist fails before the program is ever reached.
  useEffect(() => {
    if (owner) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner]);

  const done = results.filter((r) => !r.broke);
  const agreed = done.filter((r) => r.refused === (r.expects === "refused")).length;

  return (
    <section className="prove">
      <div className="prove-head">
        <div>
          <p className="k">Proved on-chain</p>
          <h3>Six things the deployed program was asked to do</h3>
          <p className="prove-sub">
            Real instructions, addressed to <code>{PROGRAM_ID.slice(0, 8)}…</code> and the live
            vault, run through <code>simulateTransaction</code>. Every verdict below is the
            cluster's, not ours. Nothing is signed and nothing settles.
          </p>
        </div>
        <button type="button" className="prove-run" onClick={run} disabled={running || !owner}>
          {running ? `running ${results.length}/${PROBES.length}…` : "Run again"}
        </button>
      </div>

      {done.length > 0 && (
        <p className={`prove-score ${agreed === done.length ? "ok" : "bad"}`}>
          {agreed} of {done.length} matched the design.
          {agreed === done.length
            ? " Four refusals and two acceptances, decided by the chain."
            : " One or more results differ from what the design predicts."}
        </p>
      )}

      <ol className="probe-list">
        {results.map((o) => (
          <Row key={o.id} o={o} />
        ))}
        {running &&
          PROBES.slice(results.length).map((p) => (
            <li key={p.id} className="probe queued">
              <div className="probe-top">
                <div className="probe-what">
                  <p className="probe-title">{p.title}</p>
                  <code className="probe-ask">{p.ask}</code>
                </div>
                <div className="probe-verdict">
                  <span className="vbadge">queued</span>
                </div>
              </div>
            </li>
          ))}
      </ol>
    </section>
  );
}
