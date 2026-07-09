---
name: Intraday backtest methodology
description: How the intraday signal engine's backtest must be structured to produce trustworthy evidence — walk-forward split, entry-fill realism, and gate non-circularity.
---

When backtesting a rule-based trade-setup generator (entry/stop/target logic
with a "which setup types are allowed" gate), several subtle mistakes will
silently produce misleadingly good numbers:

1. **The gate must never see the data it's derived from.** Split history into
   TRAIN (used only to decide which setup types/parameters are good) and TEST
   (held out, scored with the frozen gate). If your gate-derivation code calls
   the same production function that already enforces the gate, you get a
   circular/tautological result — add a bypass flag for backtest-only use so
   TRAIN is measured against the full, ungated universe.
2. **Require an actual fill.** If a setup defines an entry *zone* (a pullback/
   retest band) rather than "buy right now at the current price," the backtest
   must check that price actually touches that zone in the bars after the
   decision point before it starts tracking stop/target. Scoring stop/target
   from the decision bar onward — without confirming a fill — silently assumes
   a trade happened that never would have.
3. **Cap unresolved (mark-to-close) R-multiples.** A handful of runaway trend
   days will otherwise dominate the whole average-R statistic. Cap at
   target2's R-ratio (or ~1.5x target1's) since a disciplined trader would
   have taken profit there rather than holding indefinitely.
4. **Watch for entry-anchor bugs disguised as "bad setup types."** A setup
   type that looks structurally unprofitable in a backtest may actually be a
   symptom of chasing an already-extended price (entry zone anchored to
   current price instead of the actual breakout/reference level, sometimes
   even producing an inverted entryLow > entryHigh zone). Fix the anchoring
   bug and re-measure before concluding the setup type itself has no edge.
5. **Classification precedence matters.** When multiple setup conditions can
   be true simultaneously (e.g. an ORB break that's also a previous-day-level
   break), the more specific/informative label should win, or a genuinely
   good setup can be silently reclassified as a worse one and gated out.

**Why:** applying these in sequence on the FinanceScope intraday engine moved
out-of-sample win rate from ~35% (unfixed, ungated) to ~41% and avg R from
-0.18R to -0.08R — a real, non-circular improvement, not a mirage from
methodology bugs.

**How to apply:** any time you build or modify a backtest harness for a
rule-based trading/decision system with an entry-zone concept, check for all
five of the above before trusting the resulting numbers.
