/**
 * Shared page furniture: the line, the sunk wordmark, and the Solana glyph.
 *
 * The line is the one structural idea this design carries. It appears at full
 * strength under the claim on the overview, and again at the foot of every page
 * with the wordmark beneath it — the only thing allowed below the line, because
 * it is the thing doing the refusing.
 */

/** The Solana mark, set inline beside the word — attribution, not decoration. */
export function SolanaMark() {
  return (
    <svg className="solana" viewBox="0 0 397 311" role="img" aria-label="Solana">
      <path d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z" />
      <path d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z" />
      <path d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.6z" />
    </svg>
  );
}

/** The line, with the moat hatched beneath it. */
export function TheLine() {
  return <div className="bleed theline" aria-hidden="true" />;
}

/** The closing: the wordmark, sunk in the moat. */
export function Sunk() {
  return (
    <div className="bleed sunk">
      <p className="mark" aria-hidden="true">
        MOAT
      </p>
    </div>
  );
}
