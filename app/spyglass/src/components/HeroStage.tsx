import { useEffect, useMemo, useState } from "react";
import { LiveFloor } from "./LiveFloor";
import { SealedBoard } from "./SealedBoard";
import { PortcullisRun } from "./PortcullisRun";

/**
 * The hero stage.
 *
 * Three panels, rotating: what the chain can see (the live floor), what it
 * cannot (the sealed board), and what happens in between (the portcullis run).
 * That ordering is the argument in three frames.
 *
 * Rotation pauses on hover and on focus, and stops entirely once someone picks a
 * panel by hand — a carousel that keeps moving under a reader who has chosen
 * something is just taking the page back off them.
 */

const PANELS = [
  { id: "floor", label: "Live floor", node: <LiveFloor /> },
  { id: "sealed", label: "Sealed", node: <SealedBoard /> },
  { id: "check", label: "Checked", node: <PortcullisRun /> },
];

const ROTATE_MS = 9000;

export function HeroStage() {
  const reduced = useMemo(
    () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
    []
  );
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    if (reduced || paused || pinned) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % PANELS.length), ROTATE_MS);
    return () => clearInterval(id);
  }, [reduced, paused, pinned]);

  return (
    <div
      className="stage"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div className="stage-panels">
        {PANELS.map((p, i) => (
          <div
            key={p.id}
            className={`stage-panel ${i === index ? "active" : ""}`}
            aria-hidden={i !== index}
            // Keep inactive panels out of the tab order so the carousel does not
            // trap keyboard users in content they cannot see.
            {...(i !== index ? { inert: "" } : {})}
          >
            {p.node}
          </div>
        ))}
      </div>

      <div className="stage-dots" role="tablist" aria-label="Hero panels">
        {PANELS.map((p, i) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={i === index}
            aria-label={p.label}
            className={i === index ? "on" : ""}
            onClick={() => {
              setIndex(i);
              setPinned(true);
            }}
          >
            <span>{p.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
