import { useEffect, useRef, useState } from "react";
import { getTape, startTape, subscribeTape, tapeError, type Tick } from "../data/oracleTape";

/**
 * Price, and the floor under it.
 *
 * Most vault dashboards chart the price. The line that matters here is the one
 * underneath it: `price × (1 − max_slippage)`, recomputed on every sample, which
 * is the number `execute_sortie` derives from the same oracle account before it
 * will let a fill settle. The shaded band between the two lines is the vault's
 * entire tolerance; the hatched region below is where the chain refuses.
 *
 * Drawn on a canvas rather than with a chart library because the whole thing is
 * two paths and a fill, and shipping 90KB of charting to draw them would be the
 * kind of decision this project is arguing against.
 *
 * The y-axis is scaled to the floor-to-price range rather than to zero. On a
 * zero-based axis a 50bp band is a rounding error and the picture says nothing.
 */

const HEIGHT = 260;
const PAD = { top: 18, right: 74, bottom: 22, left: 14 };

export function FloorChart({
  slippageBps = 50,
  stalenessSecs = 30,
}: {
  slippageBps?: number;
  stalenessSecs?: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    startTape();
    return subscribeTape(() => force((n) => n + 1));
  }, []);

  const ticks = getTape();
  const err = tapeError();

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const width = canvas.clientWidth || 640;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(HEIGHT * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, HEIGHT);

      const css = getComputedStyle(document.documentElement);
      const coral = css.getPropertyValue("--coral").trim() || "#ff5c42";
      const tint = css.getPropertyValue("--tint").trim() || "255,250,240";
      const bone = css.getPropertyValue("--bone").trim() || "#f4efe6";
      const bone3 = css.getPropertyValue("--bone-3").trim() || "#6b665e";

      const plotW = width - PAD.left - PAD.right;
      const plotH = HEIGHT - PAD.top - PAD.bottom;

      const drawn: Tick[] = ticks.slice(-180);
      const keep = 1 - slippageBps / 10_000;

      if (drawn.length < 2) {
        ctx.fillStyle = bone3;
        ctx.font = "11px ui-monospace, monospace";
        ctx.fillText(
          err ? `oracle unreachable — ${err.slice(0, 48)}` : "recording the oracle… first samples arriving",
          PAD.left,
          HEIGHT / 2
        );
        return;
      }

      const prices = drawn.map((d) => d.usd);
      const hi = Math.max(...prices);
      const lo = Math.min(...prices) * keep;
      const span = Math.max(hi - lo, hi * 0.0004);
      const top = hi + span * 0.22;
      const bot = lo - span * 0.22;

      const x = (i: number) => PAD.left + (i / (drawn.length - 1)) * plotW;
      const y = (v: number) => PAD.top + ((top - v) / (top - bot)) * plotH;

      // Horizontal guides, four of them, labelled on the right.
      ctx.strokeStyle = `rgba(${tint}, 0.07)`;
      ctx.fillStyle = bone3;
      ctx.font = "10px ui-monospace, monospace";
      ctx.lineWidth = 1;
      for (let i = 0; i <= 3; i++) {
        const v = bot + ((top - bot) * i) / 3;
        const yy = Math.round(y(v)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(PAD.left, yy);
        ctx.lineTo(width - PAD.right, yy);
        ctx.stroke();
        ctx.fillText(v.toFixed(2), width - PAD.right + 8, yy + 3);
      }

      const priceAt = (i: number) => y(drawn[i].usd);
      const floorAt = (i: number) => y(drawn[i].usd * keep);

      // The tolerance band: everything the vault would accept.
      ctx.beginPath();
      ctx.moveTo(x(0), priceAt(0));
      for (let i = 1; i < drawn.length; i++) ctx.lineTo(x(i), priceAt(i));
      for (let i = drawn.length - 1; i >= 0; i--) ctx.lineTo(x(i), floorAt(i));
      ctx.closePath();
      ctx.fillStyle = `rgba(${tint}, 0.07)`;
      ctx.fill();

      // Below the floor: refused. Hatched, in the same coral as the page rule.
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x(0), floorAt(0));
      for (let i = 1; i < drawn.length; i++) ctx.lineTo(x(i), floorAt(i));
      ctx.lineTo(x(drawn.length - 1), HEIGHT - PAD.bottom);
      ctx.lineTo(x(0), HEIGHT - PAD.bottom);
      ctx.closePath();
      ctx.clip();
      ctx.strokeStyle = coral;
      ctx.globalAlpha = 0.19;
      ctx.beginPath();
      for (let px = -HEIGHT; px < width + HEIGHT; px += 9) {
        ctx.moveTo(px, HEIGHT);
        ctx.lineTo(px + HEIGHT, 0);
      }
      ctx.stroke();
      ctx.restore();

      // The floor itself.
      ctx.strokeStyle = coral;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      for (let i = 0; i < drawn.length; i++) {
        const yy = floorAt(i);
        i === 0 ? ctx.moveTo(x(i), yy) : ctx.lineTo(x(i), yy);
      }
      ctx.stroke();

      // The price, drawn segment by segment so the runs where the account had
      // gone stale are visibly a different line. Those are the windows in which
      // the vault refuses to trade at all, whatever the price says.
      ctx.lineWidth = 1.75;
      for (let i = 1; i < drawn.length; i++) {
        ctx.strokeStyle = drawn[i].ageSecs > stalenessSecs ? coral : bone;
        ctx.beginPath();
        ctx.moveTo(x(i - 1), priceAt(i - 1));
        ctx.lineTo(x(i), priceAt(i));
        ctx.stroke();
      }

      // Live head.
      const lastI = drawn.length - 1;
      ctx.fillStyle = bone;
      ctx.beginPath();
      ctx.arc(x(lastI), priceAt(lastI), 3, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = bone;
      ctx.font = "600 11px ui-monospace, monospace";
      ctx.fillText(drawn[lastI].usd.toFixed(2), width - PAD.right + 8, priceAt(lastI) + 3);
      ctx.fillStyle = coral;
      ctx.fillText((drawn[lastI].usd * keep).toFixed(2), width - PAD.right + 8, floorAt(lastI) + 3);
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [ticks, slippageBps, stalenessSecs, err]);

  const span =
    ticks.length > 1 ? Math.round((ticks[ticks.length - 1].t - ticks[0].t) / 60_000) : 0;

  return (
    <div className="chartwrap">
      <div className="chart-head">
        <div>
          <p className="k">SOL / USD · the vault's own oracle</p>
          <p className="chart-note">
            <span className="key-price" /> Pyth price
            <span className="key-floor" /> floor at {slippageBps} bps
            <span className="key-deny" /> refused below
            <span className="key-stale" /> oracle stale, no trade
          </p>
        </div>
        <p className="chart-span">
          {ticks.length} samples{span > 0 ? ` · ${span} min` : ""}
        </p>
      </div>
      <canvas ref={ref} className="floorchart" style={{ height: HEIGHT }} />
    </div>
  );
}
