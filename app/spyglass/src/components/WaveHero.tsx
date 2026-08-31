import { useEffect, useRef, type ReactNode } from "react";

/**
 * The opening.
 *
 * A full-height dark hero with a luminous ribbon for a ground and a hard coral
 * rule along the bottom. The ribbon is the price; the rule is the floor. Every
 * frame clamps the ribbon above the rule, because on-chain it is — the clamp is
 * the product, rendered as motion.
 *
 * Four things this gets right that the obvious implementation does not:
 *
 * 1. **One smooth path per ribbon.** Drawing per-column quads with individual
 *    gradients produces visible vertical banding. Each ribbon here is a single
 *    closed path, quadratic-smoothed through its sample points and filled once.
 * 2. **Layers, not slices.** Depth comes from five ribbons at different phases
 *    and opacities, which is also what produces the twist where they cross. The
 *    bright ones get a blurred bloom pass underneath so they read as light
 *    rather than as paint.
 * 3. **Grain.** A flat black field looks like a dead canvas element. A sparse
 *    noise tile over the whole plate is most of what separates this from one.
 * 4. **Its own dark plate.** A glowing ribbon is a dark-ground effect and does
 *    not survive being drawn on paper. Rather than degrade it on the light
 *    theme, the stage brings its own night with it — which is also why the hero
 *    text inside it is fixed light rather than themed.
 */

const SAMPLES = 72;
/** Fraction of the stage height given to the hatch band under the rule. */
const MOAT = 0.055;

interface Layer {
  phase: number;
  amp: number;
  thick: number;
  alpha: number;
  speed: number;
  /** Blur radius of the bloom pass, in px. Omitted on the dim backing layers. */
  glow?: number;
}

const LAYERS: Layer[] = [
  { phase: 0.0, amp: 0.150, thick: 0.088, alpha: 0.085, speed: 0.7 },
  { phase: 1.1, amp: 0.128, thick: 0.064, alpha: 0.14, speed: 0.92 },
  { phase: 2.3, amp: 0.108, thick: 0.042, alpha: 0.24, speed: 1.12, glow: 16 },
  { phase: 3.4, amp: 0.088, thick: 0.022, alpha: 0.52, speed: 1.35, glow: 20 },
  { phase: 4.6, amp: 0.072, thick: 0.008, alpha: 0.9, speed: 1.62, glow: 26 },
];

export function WaveHero({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let raf = 0;
    let width = 1200;
    let height = 700;

    const resize = () => {
      width = canvas.clientWidth || 1200;
      height = canvas.clientHeight || 700;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // Grain, rendered once into a tile. A flat field of black is what makes a
    // canvas hero look unfinished; this is most of the fix.
    const grain = document.createElement("canvas");
    grain.width = grain.height = 160;
    const gctx = grain.getContext("2d");
    if (gctx) {
      const img = gctx.createImageData(160, 160);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.random() * 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = v > 228 ? 22 : 0;
      }
      gctx.putImageData(img, 0, 0);
    }
    const grainPattern = ctx.createPattern(grain, "repeat");

    const coral =
      getComputedStyle(document.documentElement).getPropertyValue("--coral").trim() || "#ff5c42";

    const curveOf = (u: number, t: number, l: Layer) =>
      Math.sin(u * 2.4 + t * l.speed + l.phase) +
      Math.sin(u * 5.3 - t * l.speed * 0.55 + l.phase * 1.7) * 0.3 +
      Math.sin(u * 1.15 + t * l.speed * 0.3) * 0.45;

    /** Quadratic smoothing through midpoints — no visible vertices. */
    const trace = (pts: { x: number; y: number }[]) => {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        const xc = (pts[i].x + pts[i + 1].x) / 2;
        const yc = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last.x, last.y);
    };

    const draw = (time: number) => {
      const t = reduced ? 2.1 : time / 3600;
      const floorY = height * (1 - MOAT);
      // The fold sits high so the headline beneath it lands on quiet ground.
      const mid = height * 0.28;
      const limit = floorY - height * 0.07;

      const bg = ctx.createLinearGradient(0, 0, 0, height);
      bg.addColorStop(0, "#050508");
      bg.addColorStop(0.4, "#0b0b11");
      bg.addColorStop(1, "#060609");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);

      ctx.save();
      ctx.globalCompositeOperation = "lighter";

      for (const l of LAYERS) {
        const amp = height * l.amp;
        const half = height * l.thick;
        const top: { x: number; y: number }[] = [];
        const bot: { x: number; y: number }[] = [];

        for (let i = 0; i <= SAMPLES; i++) {
          const u = i / SAMPLES;
          const x = u * width;
          const c = mid + curveOf(u * 3.2, t, l) * amp;
          // Pinch towards both ends so the ribbon fades in rather than being
          // sliced off by the canvas edge.
          const taper = Math.sin(Math.PI * u) ** 0.55;
          const h = Math.max(0.6, half * taper);
          top.push({ x, y: Math.min(c - h, limit - 3) });
          bot.push({ x, y: Math.min(c + h, limit) });
        }

        const g = ctx.createLinearGradient(0, mid - amp * 1.4, 0, mid + amp * 1.4);
        g.addColorStop(0, `rgba(255,255,255,${l.alpha * 0.28})`);
        g.addColorStop(0.42, `rgba(255,255,255,${l.alpha})`);
        g.addColorStop(1, `rgba(255,255,255,${l.alpha * 0.16})`);

        const path = () => {
          ctx.beginPath();
          trace(top);
          trace([...bot].reverse());
          ctx.closePath();
          ctx.fill();
        };

        // Bloom under, crisp ribbon over. This is what makes it read as light.
        if (l.glow) {
          ctx.save();
          ctx.filter = `blur(${l.glow}px)`;
          ctx.globalAlpha = 0.5;
          ctx.fillStyle = g;
          path();
          ctx.restore();
        }
        ctx.fillStyle = g;
        path();
      }
      ctx.restore();

      if (grainPattern) {
        ctx.save();
        ctx.fillStyle = grainPattern;
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
      }

      // Sink the ribbon into the floor rather than letting it float above it.
      const sink = ctx.createLinearGradient(0, limit - 60, 0, floorY);
      sink.addColorStop(0, "rgba(6,6,9,0)");
      sink.addColorStop(1, "rgba(6,6,9,0.9)");
      ctx.fillStyle = sink;
      ctx.fillRect(0, limit - 60, width, floorY - limit + 60);

      // The moat, then the rule that bounds it.
      ctx.save();
      ctx.strokeStyle = coral;
      ctx.globalAlpha = 0.18;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const band = height - floorY;
      for (let x = -band; x < width + band; x += 11) {
        ctx.moveTo(x, floorY);
        ctx.lineTo(x + band, height);
      }
      ctx.stroke();
      ctx.restore();

      ctx.strokeStyle = coral;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, floorY + 0.5);
      ctx.lineTo(width, floorY + 0.5);
      ctx.stroke();

      if (!reduced) raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <div className="opening">
      <canvas ref={ref} className="opening-wave" aria-hidden="true" />
      <div className="opening-inner">{children}</div>
    </div>
  );
}
