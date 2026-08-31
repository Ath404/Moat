import { useEffect, useState } from "react";

/**
 * Theme toggle.
 *
 * Starts from the reader's system preference and only pins a choice once they
 * make one, so the default is whatever their machine already said rather than
 * whatever this page prefers.
 */

type Theme = "dark" | "light";

function initial(): Theme {
  const saved = localStorage.getItem("moat.theme");
  if (saved === "dark" || saved === "light") return saved;
  return matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return initial();
    } catch {
      return "dark"; // storage can throw in private windows
    }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("moat.theme", theme);
    } catch { /* not worth failing a render over */ }
  }, [theme]);

  return (
    <button
      type="button"
      className="themetoggle"
      onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
    >
      {theme === "dark" ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="4.4" />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((d) => (
            <line key={d} x1="12" y1="1.6" x2="12" y2="4.2" transform={`rotate(${d} 12 12)`} />
          ))}
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20 14.2A8.4 8.4 0 1 1 9.8 4 6.6 6.6 0 0 0 20 14.2Z" />
        </svg>
      )}
    </button>
  );
}
