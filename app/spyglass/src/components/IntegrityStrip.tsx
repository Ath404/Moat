import { useMemo, useState } from "react";
import { bps, executionBps, floorBps, tokens, usd, type Sortie } from "../data/types";

/**
 * The integrity strip.
 *
 * Every fill the vault has ever made, plotted against the price the chain
 * itself read from Pyth at execution time. The horizontal rule is that
 * oracle-fair price. The stepped rule below it is the floor the vault refused to
 * trade through, recomputed on-chain per fill. Everything under that floor is
 * hatched, because nothing can land there — the program rejects it.
 *
 * That hatched band is the moat. It is the only chart on this page, and it is
 * the whole argument: you can audit execution quality precisely without being
 * told a single thing about the strategy that chose the trades.
 */

const W = 1100;
const H = 282;
const PAD = { top: 26, right: 22, bottom: 40, left: 54 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

const BPS_MAX = 10;
const BPS_MIN = -58;

const y = (v: number) => PAD.top + ((BPS_MAX - v) / (BPS_MAX - BPS_MIN)) * PLOT_H;

interface Props {
  sorties: Sortie[];
  decimalsFor: (mint: string) => number;
  symbolFor: (mint: string) => string;
}

export function IntegrityStrip({ sorties, decimalsFor, symbolFor }: Props) {
  const [hover, setHover] = useState<{ s: Sortie; x: number; y: number } | null>(null);

  const points = useMemo(
    () =>
      sorties.map((s, i) => {
        const step = PLOT_W / Math.max(sorties.length - 1, 1);
        return {
          s,
          x: PAD.left + i * step,
          exec: executionBps(s),
          floor: floorBps(s),
        };
      }),
    [sorties]
  );

  if (!points.length) {
    return <p className="caption">No sorties yet. The vault has not traded.</p>;
  }

  const floorPath = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${y(p.floor).toFixed(1)}`)
    .join(" ");

  // Headroom is drawn as one column per fill rather than as a continuous area.
  // Fills are discrete events minutes or hours apart; joining them into a
  // silhouette would invent a series that does not exist, and produced a
  // sawtooth that read as noise rather than as measurement.
  const step = PLOT_W / Math.max(points.length - 1, 1);
  const colWidth = Math.min(step * 0.55, 14);

  const betterThanFair = points.filter((p) => p.exec > 0).length;
  const worst = points.reduce((a, b) => (b.exec < a.exec ? b : a));
  const avgExec = points.reduce((s, p) => s + p.exec, 0) / points.length;
  const avgFloor = points.reduce((s, p) => s + p.floor, 0) / points.length;

  return (
    <div className="stripwrap">
      <div className="frame">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Execution quality for ${points.length} fills, measured in basis points against the on-chain oracle price. ${betterThanFair} filled better than the oracle price; the worst was ${worst.exec.toFixed(1)} basis points, against a refusal floor of ${worst.floor.toFixed(0)}. The same figures are listed in the sortie log table below.`}
        >
          <defs>
            <pattern id="moat-hatch" width="7" height="7" patternTransform="rotate(-45)" patternUnits="userSpaceOnUse">
              <line x1="0" y1="0" x2="0" y2="7" stroke="var(--coral)" strokeWidth="1" opacity="0.34" />
            </pattern>
          </defs>

          {/* gridlines every 10 bps */}
          {[10, 0, -10, -20, -30, -40, -50].map((v) => (
            <g key={v}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y(v)}
                y2={y(v)}
                stroke="rgba(var(--tint), 0.06)"
                strokeWidth="1"
                opacity={v === 0 ? 0 : 0.55}
              />
              <text className="axis" x={PAD.left - 10} y={y(v) + 3} textAnchor="end">
                {v > 0 ? `+${v}` : v}
              </text>
            </g>
          ))}

          <text
            className="axis"
            x={PAD.left + 10}
            y={(y(avgExec) + y(avgFloor)) / 2 + 3}
          >
            headroom over the floor
          </text>

          {/* the excluded region: below the floor, nothing can land */}
          <path
            d={`${floorPath} L ${(W - PAD.right).toFixed(1)} ${H - PAD.bottom} L ${PAD.left} ${H - PAD.bottom} Z`}
            fill="url(#moat-hatch)"
          />
          <path d={floorPath} fill="none" stroke="var(--coral)" strokeWidth="1.5" opacity="0.9" />

          {/* the oracle reference the chain measured against */}
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(0)}
            y2={y(0)}
            stroke="var(--bone-2)"
            strokeWidth="1.25"
          />
          {/* The oracle line is named in the legend rather than in the plot:
              fills cluster just under it, and an inline label sat on top of
              them. */}
          <text className="axis-warn" x={PAD.left} y={y(points[0].floor) + 16}>
            refused by the vault
          </text>

          {/* fills */}
          {points.map((p, i) => (
            <g key={p.s.nonce}>
              {/* this fill's margin over the refusal line */}
              <rect
                x={p.x - colWidth / 2}
                y={y(p.exec)}
                width={colWidth}
                height={Math.max(y(p.floor) - y(p.exec), 0)}
                fill="rgba(var(--tint), 0.075)"
                opacity="0.34"
              />
              <circle
                className="dot"
                cx={p.x}
                cy={y(p.exec)}
                r={4.5}
                fill={p.exec > 0 ? "var(--sand)" : "var(--bone)"}
                fillOpacity={p.exec > 0 ? 1 : 0.82}
                style={{ animationDelay: `${Math.min(i * 22, 900)}ms` }}
                onMouseEnter={(e) => {
                  const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                  setHover({
                    s: p.s,
                    x: ((p.x / W) * box.width),
                    y: ((y(p.exec) / H) * box.height),
                  });
                }}
                onMouseLeave={() => setHover(null)}
              />
            </g>
          ))}

          <text className="axis" x={PAD.left} y={H - 12}>
            first fill
          </text>
          <text className="axis" x={W - PAD.right} y={H - 12} textAnchor="end">
            most recent
          </text>
          <text
            className="axis"
            transform={`rotate(-90) translate(${-(PAD.top + PLOT_H / 2)} 14)`}
            textAnchor="middle"
          >
            basis points vs oracle
          </text>
        </svg>

        <div className="legend">
          <span>
            <i className="sw" style={{ background: "var(--bone)" }} /> fill
          </span>
          <span>
            <i className="sw" style={{ background: "var(--sand)" }} /> better than oracle
          </span>
          <span>
            <i className="sw line" /> oracle fair
          </span>
          <span>
            <i className="sw band" /> headroom
          </span>
          <span>
            <i className="sw hatch" /> refused — the moat
          </span>
        </div>
      </div>

      {hover && (
        <div
          className="readout"
          style={{
            left: `min(${hover.x + 24}px, calc(100% - 230px))`,
            top: `${hover.y + 8}px`,
          }}
        >
          <div>
            <b>sortie {hover.s.nonce}</b> · leg {hover.s.sortieIndex + 1}/{hover.s.sortieCount} ·{" "}
            {usd(hover.s.notionalMicroUsd, 0)}
          </div>
          <div>
            received <b>{tokens(hover.s.amountOut, decimalsFor(hover.s.mintOut), 3)}</b>{" "}
            {symbolFor(hover.s.mintOut)}
          </div>
          <div>
            oracle fair {tokens(hover.s.oracleExpectedOut, decimalsFor(hover.s.mintOut), 3)} · floor{" "}
            {tokens(hover.s.minAmountOut, decimalsFor(hover.s.mintOut), 3)}
          </div>
          <div className={executionBps(hover.s) > 0 ? "up" : ""}>
            <b>{bps(executionBps(hover.s))}</b> vs oracle ·{" "}
            {(executionBps(hover.s) - floorBps(hover.s)).toFixed(1)} bps of headroom over the floor
          </div>
        </div>
      )}

      <p className="caption">
        Every dot is a fill, measured against the price the chain read at the moment it executed. The
        hatched band is what the vault will not accept: the floor is recomputed on-chain from Pyth on
        every sortie, so <strong>a compromised strategy engine cannot lower it</strong> to hand the
        position to a sandwich. {betterThanFair} of {points.length} fills landed above the oracle
        price. None has ever entered the band, and by construction none can.
      </p>
    </div>
  );
}
