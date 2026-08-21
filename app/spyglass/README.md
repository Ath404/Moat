# spyglass

The dashboard. **Not built.** This directory holds the intent, not an app.

What it should show, and nothing more:

* vault TVL, current holdings, position
* trade history from `SortieExecuted` events
* realised P&L, ROI, drawdown, volume
* **execution quality** — `amount_out` against `oracle_expected_out` and
  `min_amount_out`, per fill

That third column is the interesting one and it is free: the vault already
publishes what the oracle said an honest fill was worth, so anyone can verify the
vault honoured its own floor without learning anything about the strategy.

What it must never show, because the program never emits it:

* entry/exit thresholds, stop-loss, position sizing, signal weights, timing rules

Everything the dashboard needs is in `programs/moat/src/events.rs`. Read the
comment at the top of that file before adding a field to an event — the split
between what is published and what is withheld is the product.
