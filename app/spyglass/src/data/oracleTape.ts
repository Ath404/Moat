import { RPC_URL } from "./config";
import { getPythQuotes } from "./live";

/**
 * The tape: a rolling record of what the vault's oracle has said.
 *
 * There is no free source of Pyth history — the benchmarks shim that used to
 * serve candles is gone — and plotting a centralised exchange's price while
 * calling it "the oracle" would be a lie on a page whose entire argument is
 * that the chain prices trades itself. So the tape is sampled: the same
 * `PriceUpdateV2` accounts `execute_sortie` reads, polled on an interval, kept
 * in memory.
 *
 * Two consequences shape the design:
 *
 *   - **It starts empty**, so recording begins when the app loads rather than
 *     when someone opens the desk. By the time a visitor gets there it usually
 *     has a few minutes of shape to draw.
 *   - **It survives a reload** via `sessionStorage`, because losing the chart on
 *     every refresh is the difference between a product and a demo. Stored
 *     samples are still real readings, just older ones.
 *
 * A single shared poller, not one per component: three panels reading the same
 * feed should cost one request, and they must agree about what the price is.
 */

export interface Tick {
  /** Wall-clock ms when this sample was taken. */
  t: number;
  usd: number;
  confBps: number;
  /** Pyth's own publish time, seconds. */
  publishTime: number;
  ageSecs: number;
}

const MAX_TICKS = 400;
const POLL_MS = 3_000;
const STORE_KEY = "moat.tape.v1";
/** Older than this and the sample says more about the past than the market. */
const KEEP_MS = 45 * 60 * 1000;

let ticks: Tick[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let lastError: string | null = null;
const listeners = new Set<() => void>();

function load() {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Tick[];
    const cutoff = Date.now() - KEEP_MS;
    if (Array.isArray(parsed)) ticks = parsed.filter((x) => x && x.t > cutoff).slice(-MAX_TICKS);
  } catch {
    // A private window, cleared storage, or a shape from an older build. The
    // tape simply starts empty; nothing here is load-bearing.
  }
}

function save() {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(ticks.slice(-MAX_TICKS)));
  } catch {
    // Quota or a blocked accessor. Not worth surfacing.
  }
}

function emit() {
  for (const fn of listeners) fn();
}

async function sample() {
  try {
    const quotes = await getPythQuotes(RPC_URL);
    const sol = quotes.find((q) => q.symbol.startsWith("SOL"));
    if (!sol || sol.usd <= 0) return;

    // Every read is recorded, including ones that return a publish already
    // seen. That is not noise: a pull oracle only refreshes when someone pays
    // to push an update, so the flat runs between publishes are exactly the
    // windows in which the account is going stale and the vault will refuse to
    // price against it. Deduplicating by publish time would hide the one thing
    // on this chart that a trader needs to know.

    ticks = [
      ...ticks,
      {
        t: Date.now(),
        usd: sol.usd,
        confBps: sol.confBps,
        publishTime: sol.publishTime,
        ageSecs: sol.ageSecs,
      },
    ].slice(-MAX_TICKS);
    lastError = null;
    save();
    emit();
  } catch (e) {
    lastError = String((e as Error)?.message ?? e);
    emit();
  }
}

/** Begin recording. Safe to call repeatedly; only the first call starts a poll. */
export function startTape() {
  if (timer) return;
  load();
  void sample();
  timer = setInterval(() => void sample(), POLL_MS);
  emit();
}

export function getTape(): Tick[] {
  return ticks;
}

export function tapeError(): string | null {
  return lastError;
}

export function subscribeTape(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
