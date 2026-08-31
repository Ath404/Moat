import { useState } from "react";
import {
  bps,
  executionBps,
  floorBps,
  tokens,
  usd,
  verifySortie,
  type PolicyBounds,
  type Sortie,
} from "../data/types";

/**
 * The sortie log — and the accessible equivalent of the integrity strip above,
 * carrying the same figures in a form a screen reader can walk.
 *
 * Every row expands into the arithmetic behind it. That expansion is the point:
 * the page claims each fill was checked, so it re-runs those checks in the
 * browser, from figures the chain published, and shows the working. A reader who
 * does not believe the headline can open any row and follow the numbers.
 */

interface Props {
  sorties: Sortie[];
  policy: PolicyBounds;
  decimalsFor: (mint: string) => number;
  symbolFor: (mint: string) => string;
  limit?: number;
}

export function SortieLog({ sorties, policy, decimalsFor, symbolFor, limit = 14 }: Props) {
  const [open, setOpen] = useState<number | null>(null);
  const rows = [...sorties].reverse().slice(0, limit);

  return (
    <>
      <div className="tablewrap">
        <table>
          <caption className="visually-hidden">
            The most recent {rows.length} fills, with the oracle-fair price and refusal floor the
            chain computed for each. Each row expands to show the checks re-derived in the browser.
          </caption>
          <thead>
            <tr>
              <th scope="col">Sortie</th>
              <th scope="col">Slot</th>
              <th scope="col">Trade</th>
              <th scope="col" className="num">Size</th>
              <th scope="col" className="num">Received</th>
              <th scope="col" className="num">Oracle fair</th>
              <th scope="col" className="num">Floor</th>
              <th scope="col" className="num">Execution</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const exec = executionBps(s);
              const outDecimals = decimalsFor(s.mintOut);
              const isOpen = open === s.nonce;
              const checks = isOpen ? verifySortie(s, policy, decimalsFor, symbolFor) : [];
              const failed = checks.filter((c) => !c.pass).length;

              return (
                <>
                  <tr
                    key={s.nonce}
                    className={`row ${isOpen ? "isopen" : ""}`}
                    onClick={() => setOpen(isOpen ? null : s.nonce)}
                  >
                    <td className="lead">
                      <button
                        type="button"
                        className="disclose"
                        aria-expanded={isOpen}
                        aria-label={`Verify sortie ${s.nonce}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpen(isOpen ? null : s.nonce);
                        }}
                      >
                        {isOpen ? "−" : "+"}
                      </button>
                      {s.nonce}{" "}
                      <span className="tag">
                        leg {s.sortieIndex + 1}/{s.sortieCount}
                      </span>
                    </td>
                    <td>{s.slot.toLocaleString("en-US")}</td>
                    <td className="lead">
                      {symbolFor(s.mintIn)} → {symbolFor(s.mintOut)}
                    </td>
                    <td className="num">{usd(s.notionalMicroUsd, 0)}</td>
                    <td className="num lead">{tokens(s.amountOut, outDecimals, 3)}</td>
                    <td className="num">{tokens(s.oracleExpectedOut, outDecimals, 3)}</td>
                    <td className="num">{tokens(s.minAmountOut, outDecimals, 3)}</td>
                    <td className={`num ${exec > 0 ? "up" : ""}`}>
                      {bps(exec)}
                      <span className="tag" style={{ marginLeft: 8 }}>
                        {(exec - floorBps(s)).toFixed(0)} over floor
                      </span>
                    </td>
                  </tr>

                  {isOpen && (
                    <tr key={`${s.nonce}-detail`} className="detail">
                      <td colSpan={8}>
                        <p className="detail-head">
                          Re-derived in your browser from this event's published figures —{" "}
                          {failed === 0 ? (
                            <b className="ok">all {checks.length} checks pass</b>
                          ) : (
                            <b className="miss">
                              {failed} of {checks.length} checks fail
                            </b>
                          )}
                        </p>
                        <ul className="checks">
                          {checks.map((c) => (
                            <li key={c.label}>
                              <span className={c.pass ? "mark ok" : "mark miss"}>
                                {c.pass ? "PASS" : "FAIL"}
                              </span>
                              <span>
                                <b>{c.label}</b>
                                <br />
                                {c.detail}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="note" style={{ marginTop: "0.9rem" }}>
        {sorties.length > limit && `Showing the ${limit} most recent of ${sorties.length} fills. `}
        Select any row to re-run its checks.
      </p>
    </>
  );
}
