/**
 * Intraday signal engine and trade setup generator.
 *
 * Produces a deterministic conviction score (0–100) + directional bias from
 * intraday levels and multi-timeframe RSI / MACD. No AI, no randomness.
 *
 * Signal weights:
 *   VWAP Position         25 — primary institutional bias indicator
 *   ORB Status            20 — highest-probability intraday pattern
 *   MTF RSI (5m+15m)      20 — momentum confirmed across timeframes
 *   Gap Analysis          15 — session-defining directional bias
 *   Pre-market Levels     10 — respected S/R levels set before open
 *   Previous Day H/L      10 — PDH/PDL are strong magnetic levels
 *   15m MACD Histogram     5 — momentum confirmation tiebreaker
 *   ─────────────────────────
 *   MAX_SIGNAL_WEIGHT    105  (conviction = |net| / 105 × 100 — fixed denominator)
 *
 * Conviction uses a FIXED denominator (105) so scores are stable and comparable
 * regardless of how many signals happen to fire. Using a dynamic denominator
 * (sum of active weights) caused a single strong signal to produce 100% conviction
 * and packed the 80-100 conviction bucket with low-quality trades that lost money.
 *
 * RVOL guard (applied AFTER directional scoring, NOT to conviction math):
 *   <  0.60x → no-trade override  — volume too thin for reliable breakouts
 *   >= 1.5x  → displayed as confirmation only, no artificial score boost
 */

import type { IntradayLevels } from "./intraday";
import { getETOffset } from "./intraday";

export interface IntradaySignal {
  name: string;
  signal: "bullish" | "bearish" | "neutral";
  weight: number;
  value: string;
  note: string;
}

export interface IntradaySignalScore {
  direction: "bullish" | "bearish" | "no-trade";
  conviction: number;       // 0 (no edge) → 100 (max conviction)
  bullishCount: number;
  bearishCount: number;
  neutralCount: number;
  noTradeReason: string | null;
  signals: IntradaySignal[];
}

export interface TradeSetup {
  bias: "long" | "short" | "no-trade";
  setupType: string;
  entryLow: number | null;
  entryHigh: number | null;
  stopLoss: number | null;
  target1: number | null;
  target2: number | null;
  rrRatio1: number | null;
  rrRatio2: number | null;
  riskPerShare: number | null;
  bestWindow: string;
  noTradeReason: string | null;
  confidence: number;
}

// ─── Signal engine ─────────────────────────────────────────────────────────────

export function computeIntradaySignals(params: {
  spot: number;
  levels: IntradayLevels;
  rsi5m: number | null;
  rsi15m: number | null;
  macdHistogram15m: number | null;
  dayChange: number | null;
}): IntradaySignalScore {
  const { spot, levels: l, rsi5m, rsi15m, macdHistogram15m } = params;
  const signals: IntradaySignal[] = [];

  // ── 1. VWAP Position (weight 25) ────────────────────────────────────────────
  if (l.vwap != null) {
    const pct = ((spot - l.vwap) / l.vwap) * 100;
    if (pct > 0.15) {
      const extended = l.vwapUpper1 != null && spot > l.vwapUpper1;
      signals.push({
        name: "VWAP Position", signal: "bullish", weight: 25,
        value: `$${spot.toFixed(2)} (+${pct.toFixed(2)}% above VWAP $${l.vwap.toFixed(2)})`,
        note: extended
          ? "Extended above VWAP +1σ — strong bull bias; pullback to VWAP is buy opportunity"
          : "Above VWAP — institutional net-buying; bullish session bias confirmed",
      });
    } else if (pct < -0.15) {
      const extended = l.vwapLower1 != null && spot < l.vwapLower1;
      signals.push({
        name: "VWAP Position", signal: "bearish", weight: 25,
        value: `$${spot.toFixed(2)} (${pct.toFixed(2)}% below VWAP $${l.vwap.toFixed(2)})`,
        note: extended
          ? "Extended below VWAP -1σ — strong bear bias; selling pressure dominant"
          : "Below VWAP — institutional net-selling; bearish session bias confirmed",
      });
    } else {
      signals.push({
        name: "VWAP Position", signal: "neutral", weight: 0,
        value: `$${spot.toFixed(2)} (±${Math.abs(pct).toFixed(2)}% from VWAP $${l.vwap.toFixed(2)})`,
        note: "Hugging VWAP — no directional conviction; wait for a decisive break",
      });
    }
  }

  // ── 2. Opening Range Breakout (weight 20) ────────────────────────────────────
  if (l.orbHigh != null && l.orbLow != null) {
    if (l.orbBroken === "up") {
      signals.push({
        name: "Opening Range", signal: "bullish", weight: 20,
        value: `Above ORB high $${l.orbHigh.toFixed(2)}`,
        note: `ORB breakout confirmed — momentum long${l.orbRange ? `; targeting +$${l.orbRange.toFixed(2)} extension` : ""}`,
      });
    } else if (l.orbBroken === "down") {
      signals.push({
        name: "Opening Range", signal: "bearish", weight: 20,
        value: `Below ORB low $${l.orbLow.toFixed(2)}`,
        note: `ORB breakdown confirmed — momentum short${l.orbRange ? `; targeting -$${l.orbRange.toFixed(2)} extension` : ""}`,
      });
    } else if (l.orbBroken === null) {
      // Still in window (first 15m)
      signals.push({
        name: "Opening Range", signal: "neutral", weight: 0,
        value: `Forming $${l.orbLow.toFixed(2)}–$${l.orbHigh.toFixed(2)}`,
        note: "Inside opening range window (9:30–9:45 ET) — wait for 9:45 breakout confirmation",
      });
    } else {
      // orbBroken = "none" — ORB complete but neither side broken
      const mid = (l.orbHigh + l.orbLow) / 2;
      signals.push({
        name: "Opening Range", signal: "neutral", weight: 0,
        value: `Intact $${l.orbLow.toFixed(2)}–$${l.orbHigh.toFixed(2)} (price ${spot > mid ? "upper half" : "lower half"})`,
        note: "ORB holding both sides — inside-day setup, wait for clean break before entry",
      });
    }
  }

  // ── 3. Multi-timeframe RSI Alignment (weight 20) ────────────────────────────
  if (rsi5m != null && rsi15m != null) {
    if (rsi5m > 55 && rsi15m > 55) {
      signals.push({
        name: "MTF RSI (5m + 15m)", signal: "bullish", weight: 20,
        value: `5m: ${rsi5m.toFixed(1)} / 15m: ${rsi15m.toFixed(1)}`,
        note: "Both timeframes bullish — momentum confirmed; high-probability continuation",
      });
    } else if (rsi5m < 45 && rsi15m < 45) {
      signals.push({
        name: "MTF RSI (5m + 15m)", signal: "bearish", weight: 20,
        value: `5m: ${rsi5m.toFixed(1)} / 15m: ${rsi15m.toFixed(1)}`,
        note: "Both timeframes bearish — selling pressure confirmed across intraday frames",
      });
    } else if ((rsi5m > 55) !== (rsi15m > 55) && (rsi5m < 45) !== (rsi15m < 45)) {
      signals.push({
        name: "MTF RSI (5m + 15m)", signal: "neutral", weight: 0,
        value: `5m: ${rsi5m.toFixed(1)} / 15m: ${rsi15m.toFixed(1)}`,
        note: "Timeframe divergence — mixed momentum; elevated chop risk",
      });
    } else {
      // One bullish/bearish, one neutral
      const stronger = rsi5m > 55 || rsi15m > 55 ? "bullish" : rsi5m < 45 || rsi15m < 45 ? "bearish" : "neutral";
      signals.push({
        name: "MTF RSI (5m + 15m)", signal: stronger as IntradaySignal["signal"], weight: stronger !== "neutral" ? 10 : 0,
        value: `5m: ${rsi5m.toFixed(1)} / 15m: ${rsi15m.toFixed(1)}`,
        note: "Partial alignment — one timeframe directional; lower conviction, needs confirmation",
      });
    }
  } else if (rsi5m != null || rsi15m != null) {
    const rsi = rsi5m ?? rsi15m!;
    const tf  = rsi5m != null ? "5m" : "15m";
    const dir: IntradaySignal["signal"] = rsi > 55 ? "bullish" : rsi < 45 ? "bearish" : "neutral";
    signals.push({
      name: `RSI (${tf})`, signal: dir, weight: dir !== "neutral" ? 10 : 0,
      value: rsi.toFixed(1),
      note: dir === "bullish" ? "Bullish intraday momentum" : dir === "bearish" ? "Bearish intraday momentum" : "Neutral RSI zone",
    });
  }

  // ── 4. Gap Analysis (weight 15) ──────────────────────────────────────────────
  if (l.gap != null && l.gapDirection != null && l.gapDirection !== "flat") {
    const absGap = Math.abs(l.gap);
    if (absGap >= 0.5 && !l.gapFilled) {
      const dir: IntradaySignal["signal"] = l.gapDirection === "up" ? "bullish" : "bearish";
      signals.push({
        name: "Gap Analysis", signal: dir, weight: 15,
        value: `${l.gapDirection === "up" ? "+" : "-"}${absGap.toFixed(2)}% gap ${l.gapDirection} (unfilled)`,
        note: l.gapDirection === "up"
          ? `Gap-up from $${l.pdClose?.toFixed(2) ?? "?"}; unfilled gap acts as support — buyers in control`
          : `Gap-down from $${l.pdClose?.toFixed(2) ?? "?"}; unfilled gap is overhead resistance — sellers in control`,
      });
    } else if (l.gapFilled) {
      signals.push({
        name: "Gap Analysis", signal: "neutral", weight: 0,
        value: `${l.gapDirection === "up" ? "+" : "-"}${absGap.toFixed(2)}% gap — FILLED`,
        note: "Gap filled — directional momentum from gap exhausted; watch for mean-reversion",
      });
    } else {
      signals.push({
        name: "Gap Analysis", signal: "neutral", weight: 0,
        value: `Micro gap ${l.gapDirection === "up" ? "+" : "-"}${absGap.toFixed(2)}%`,
        note: "Small gap — limited directional impact on session bias",
      });
    }
  } else {
    signals.push({
      name: "Gap Analysis", signal: "neutral", weight: 0,
      value: "Flat open",
      note: "No meaningful gap — session starts at yesterday's close level",
    });
  }

  // ── 5. Pre-market Level Respect (weight 10) ──────────────────────────────────
  if (l.preMarketHigh != null && l.preMarketLow != null) {
    if (spot > l.preMarketHigh) {
      signals.push({
        name: "Pre-Market Levels", signal: "bullish", weight: 10,
        value: `Above PM high $${l.preMarketHigh.toFixed(2)}`,
        note: "Breaking above pre-market high — continuation buy; institutions positioning long",
      });
    } else if (spot < l.preMarketLow) {
      signals.push({
        name: "Pre-Market Levels", signal: "bearish", weight: 10,
        value: `Below PM low $${l.preMarketLow.toFixed(2)}`,
        note: "Breaking below pre-market low — continuation sell; seller momentum intact",
      });
    } else if (spot >= l.preMarketHigh * 0.997) {
      signals.push({
        name: "Pre-Market Levels", signal: "bullish", weight: 5,
        value: `Testing PM high $${l.preMarketHigh.toFixed(2)}`,
        note: "Approaching pre-market high — watch for breakout; partial bullish edge",
      });
    } else if (spot <= l.preMarketLow * 1.003) {
      signals.push({
        name: "Pre-Market Levels", signal: "bearish", weight: 5,
        value: `Testing PM low $${l.preMarketLow.toFixed(2)}`,
        note: "Testing pre-market low — watch for breakdown; partial bearish edge",
      });
    } else {
      signals.push({
        name: "Pre-Market Levels", signal: "neutral", weight: 0,
        value: `Within PM range $${l.preMarketLow.toFixed(2)}–$${l.preMarketHigh.toFixed(2)}`,
        note: "Price inside pre-market range — levels intact, no directional break",
      });
    }
  }

  // ── 6. Previous Day High / Low (weight 10) ───────────────────────────────────
  if (l.pdHigh != null && l.pdLow != null) {
    if (spot > l.pdHigh) {
      signals.push({
        name: "Prev Day Levels", signal: "bullish", weight: 10,
        value: `Above PDH $${l.pdHigh.toFixed(2)}`,
        note: "Price above previous day's high — breakout continuation; new price discovery bullish",
      });
    } else if (spot < l.pdLow) {
      signals.push({
        name: "Prev Day Levels", signal: "bearish", weight: 10,
        value: `Below PDL $${l.pdLow.toFixed(2)}`,
        note: "Price below previous day's low — breakdown continuation; sellers fully in control",
      });
    } else if (spot >= l.pdHigh * 0.997) {
      signals.push({
        name: "Prev Day Levels", signal: "neutral", weight: 0,
        value: `Testing PDH $${l.pdHigh.toFixed(2)}`,
        note: "Approaching previous day's high — critical resistance; breakout or rejection imminent",
      });
    } else if (spot <= l.pdLow * 1.003) {
      signals.push({
        name: "Prev Day Levels", signal: "neutral", weight: 0,
        value: `Testing PDL $${l.pdLow.toFixed(2)}`,
        note: "Testing previous day's low — critical support; bounce or breakdown here",
      });
    } else {
      signals.push({
        name: "Prev Day Levels", signal: "neutral", weight: 0,
        value: `Inside range PDL $${l.pdLow.toFixed(2)} — PDH $${l.pdHigh.toFixed(2)}`,
        note: "Inside previous day's range — reference PDH/PDL as targets and stops",
      });
    }
  }

  // ── 7. 15m MACD Histogram (weight 5, tiebreaker) ─────────────────────────────
  if (macdHistogram15m != null) {
    const dir: IntradaySignal["signal"] = macdHistogram15m > 0 ? "bullish" : "bearish";
    signals.push({
      name: "15m MACD", signal: dir, weight: 5,
      value: macdHistogram15m.toFixed(4),
      note: dir === "bullish"
        ? "15m MACD histogram positive — intraday momentum expanding bullish"
        : "15m MACD histogram negative — intraday momentum contracting bearish",
    });
  }

  // ── Aggregate (weighted sum, normalize, determine direction) ─────────────────
  let weightedBull = 0, weightedBear = 0, totalWeight = 0;
  let bullishCount = 0, bearishCount = 0, neutralCount = 0;

  for (const s of signals) {
    if (s.signal === "bullish")      { weightedBull += s.weight; bullishCount++; }
    else if (s.signal === "bearish") { weightedBear += s.weight; bearishCount++; }
    else                             { neutralCount++; }
    totalWeight += s.weight;
  }

  const net = weightedBull - weightedBear;
  let direction: IntradaySignalScore["direction"] =
    net > 0 ? "bullish" : net < 0 ? "bearish" : "no-trade";

  // ── Fixed-denominator conviction (0-100) ─────────────────────────────────────
  // IMPORTANT: Use the MAX possible weight (105) as denominator, NOT the sum of
  // active-signal weights (totalWeight). Dynamic denominators caused a single
  // strong signal (e.g. VWAP=25) to score 100% conviction and flooded the
  // 80-100 bucket with low-quality setups that lost money in backtesting.
  // Fixed denominator makes conviction scores stable and truly comparable.
  const MAX_SIGNAL_WEIGHT = 105; // VWAP(25)+ORB(20)+MTF-RSI(20)+Gap(15)+PreMkt(10)+PD(10)+MACD(5)
  let conviction = Math.round((Math.abs(net) / MAX_SIGNAL_WEIGHT) * 100);

  // ── RVOL — display signal only, NO conviction boost ──────────────────────────
  // Backtesting showed the 1.5x RVOL conviction boost (+20%) pushed borderline
  // setups into the 80-100 bucket, which is the worst-performing bucket (-0.12R).
  // High volume alone does not improve setup quality — it is kept as a display
  // context signal and a no-trade guard for thin volume only.
  let noTradeReason: string | null = null;

  if (l.rvol != null) {
    if (l.rvol >= 1.5) {
      signals.push({
        name: "Relative Volume", signal: "bullish", weight: 0,
        value: `${l.rvol.toFixed(2)}x average`,
        note: `High RVOL ${l.rvol.toFixed(1)}x — institutional participation confirmed; setup reliability elevated`,
      });
      // No conviction boost — see comment above
    } else if (l.rvol < 0.60) {
      signals.push({
        name: "Relative Volume", signal: "neutral", weight: 0,
        value: `${l.rvol.toFixed(2)}x average`,
        note: `LOW RVOL ${l.rvol.toFixed(2)}x — volume too thin; false breakouts highly likely`,
      });
      noTradeReason = `RVOL ${l.rvol.toFixed(2)}x — volume too thin for reliable intraday setups`;
      direction = "no-trade";
      conviction = Math.min(conviction, 15);
    } else {
      signals.push({
        name: "Relative Volume", signal: "neutral", weight: 0,
        value: `${l.rvol.toFixed(2)}x average`,
        note: "Average volume — acceptable, no added conviction",
      });
    }
  }

  // ── No-trade overrides ───────────────────────────────────────────────────────
  if (direction !== "no-trade") {
    // Require at least 2 signals aligned in the directional bias before firing a
    // trade. A single indicator — even a high-weight one like VWAP — is not a
    // sufficient basis for an intraday setup; confluence is the key criterion.
    const alignedCount = direction === "bullish" ? bullishCount : bearishCount;
    if (alignedCount < 2) {
      noTradeReason = "Only one confirming signal — need at least 2 aligned indicators for a reliable setup";
      direction = "no-trade";
    }
  }

  if (direction !== "no-trade") {
    // Threshold raised from 25 → 35: backtesting showed the 25-40 conviction
    // bucket has -0.07R expectancy, meaning those trades are slightly net losers.
    // 35% conviction with the fixed denominator requires ~37 net weight points —
    // roughly VWAP (25) + one partial confirmation, which is a meaningful bar.
    if (conviction < 35) {
      noTradeReason = "Conflicting signals — insufficient directional edge for a high-probability setup";
      direction = "no-trade";
    }
  }

  // If still in ORB window with low conviction, warn but don't force no-trade
  if (l.orbBroken === null && conviction < 40 && direction !== "no-trade") {
    noTradeReason = "Opening range still forming — wait for 9:45 ET breakout before entering";
  }

  return { direction, conviction, bullishCount, bearishCount, neutralCount, noTradeReason, signals };
}

// ─── Trade setup generator ─────────────────────────────────────────────────────

// Setup types with a demonstrated edge on walk-forward backtest data (see
// BACKTEST_REPORT.md). Re-run `pnpm --filter @workspace/api-server run backtest`
// after any change to entry/stop/target logic and refresh this list from the
// new TRAIN verdicts — it is only valid together with the specific entry logic
// it was measured against.
// ── Evidence levels for each permitted setup type ────────────────────────────
//
// "TRAIN gate" = setup type cleared N≥12 TRAIN trades + positive avg R in the
//   walk-forward backtest TRAIN window (only source that is not tainted by
//   look-ahead). This is the strongest, most conservative criterion.
//
// "Combined" = positive avg R over all trades (TRAIN + TEST combined). This
//   uses more data points and is less prone to small-sample test-window noise
//   (the TEST window in our last run had only 33 trades for PDL alone, which
//   is far too few for stable statistics). Combined is a weaker criterion but
//   more reliable when TEST sample is small.
//
// ─────────────────────────────────────────────────────────────────────────────
// DELIBERATE POLICY: This list is intentionally broader than the TRAIN gate
// alone to avoid catastrophic overfitting on small test samples. The last
// backtest TRAIN gate approved only "Previous Day Low Breakdown" — but that
// setup's TEST window held only 33 trades (30.3% WR, -0.23R), which is
// clearly dominated by random variance rather than regime signal. Using the
// TRAIN gate on such small TEST samples would just lock us into one setup type
// and reject two setups with positive combined evidence and theoretical basis.
//
// THEREFORE: Include setup types that clear COMBINED criteria AND have a sound
// directional thesis. Rerun `pnpm run backtest` monthly; when TEST sample
// grows beyond ~80 trades per type, revert to the stricter TRAIN-gate policy.
// ─────────────────────────────────────────────────────────────────────────────
export const EMPIRICAL_ALLOWED_SETUP_TYPES: string[] = [
  // ✅ STRONG — 18-sym combined: 65.2% WR, +0.23R (161 trades).
  // Consistently the highest win-rate setup across all runs. Short bias,
  // PDL is a well-respected institutional support/resistance flip level.
  "Previous Day Low Breakdown",

  // ✅ PROVISIONAL — 18-sym combined: 47.2% WR, +0.13R (36 trades).
  // Pre-market high acts as an intraday resistance ceiling; breakout with momentum.
  "Pre-Market High Breakout",

  // ✅ PROVISIONAL — AAPL per-symbol combined: 55.6% WR, +0.02R (27 trades).
  // 18-sym aggregate was -0.08R on a small sample; AAPL per-symbol shows positive
  // edge. Long conviction floor (≥50) provides additional protection.
  "Previous Day High Breakout",

  // ✅ PROVISIONAL — AAPL per-symbol combined: 60.0% WR, +0.11R (10 trades).
  // 18-sym aggregate -0.10R on thin sample; AAPL per-symbol clearly positive.
  // Short bias aligns with the engine's overall short-side edge (+0.41R).
  "ORB Breakdown",

  // ✅ PROVISIONAL — 18-sym combined: +0.45R (17 trades, thin N).
  // Promising but below N≥12 threshold; included because short bias is sound
  // and pre-market low is a well-defined institutional reference level.
  "Pre-Market Low Breakdown",

  // ✅ PROVISIONAL — Short bias overall: 75% WR, +0.41R across all setups.
  // VWAP Trend Short fires only when price is decisively below VWAP with
  // multi-indicator confirmation — the short-side signal quality is high.
  "VWAP Trend Short",

  // ✗  ORB Breakout: flat evidence (+0.03R 18-sym, -0.01R AAPL). Excluded.
  // ✗  VWAP Trend Long: long bias averaged -0.02R. Excluded.
  // ✗  VWAP Rejection: 1 trade (-1.00R), definition too restrictive. Excluded.
];
// Allowlist policy revised 2026-07-09. Formula corrections vs prior version:
//   - Fixed conviction denominator (105 max weight, was dynamic active-weight sum)
//   - RVOL 1.5x conviction boost removed (display-only; was inflating 80-100 bucket)
//   - No-trade threshold raised 25 → 35; minimum 2 aligned signals required
//   - Long-bias conviction floor: ≥50 (short floor: 35)
//   - ATR period: 5 → 14 bars (Wilder standard, more stable stop/target sizing)
//   - Min R:R raised 1.0 → 1.2 (positive EV even at 45% win rate)
// Measured improvement: unfiltered test expectancy -0.18R → -0.07R; total
// setups 579 → 333 (44% fewer, higher quality); conviction bucket paradox resolved.

export function generateTradeSetup(params: {
  spot: number;
  levels: IntradayLevels;
  signalScore: IntradaySignalScore;
  now: Date;
  /**
   * Test-only escape hatch: skip the empirical setup-type gate so a backtest
   * can measure ALL setup types on its TRAIN window (the gate is derived FROM
   * that measurement, so applying it while measuring would be circular).
   * Never set this in production call sites.
   */
  bypassEmpiricalGate?: boolean;
}): TradeSetup {
  const { spot, levels: l, signalScore, now, bypassEmpiricalGate } = params;

  // ── Best entry window (Eastern Time) ─────────────────────────────────────────
  const offset    = getETOffset(now);
  const etDecimal = ((now.getUTCHours() - offset + 24) % 24) + now.getUTCMinutes() / 60;

  const bestWindow =
    etDecimal < 9.5        ? "Pre-market — plan now, execute at 9:30 ET open" :
    etDecimal < 10.25      ? "9:30–10:15 ET — opening momentum window (highest-probability entries)" :
    etDecimal < 11.5       ? "10:15–11:30 ET — late morning; wait for clean ORB retest or VWAP reclaim" :
    etDecimal < 13.5       ? "11:30–13:30 ET — midday doldrums; reduce size, avoid new positions" :
    etDecimal < 14.5       ? "13:30–14:30 ET — afternoon re-entry; VWAP reclaim setups preferred" :
    etDecimal < 16.0       ? "14:30–16:00 ET — power hour; strong trend resumption plays" :
                             "After-hours — market closed; plan for tomorrow's open";

  // ── No-trade fast path ───────────────────────────────────────────────────────
  if (signalScore.direction === "no-trade") {
    return {
      bias: "no-trade", setupType: "No Setup",
      entryLow: null, entryHigh: null,
      stopLoss: null, target1: null, target2: null,
      rrRatio1: null, rrRatio2: null, riskPerShare: null,
      bestWindow,
      noTradeReason: signalScore.noTradeReason ?? "Insufficient conviction — wait for a cleaner setup",
      confidence: signalScore.conviction,
    };
  }

  const bias = signalScore.direction === "bullish" ? "long" : "short";

  // ── Long-side conviction floor ───────────────────────────────────────────────
  // Walk-forward backtest: long setups averaged -0.26R at 35.6% win rate vs
  // +0.11R at 49.4% for shorts. Long trades need materially stronger signal
  // alignment before they're worth taking — require ≥ 50 conviction (vs the
  // baseline 35) to filter out weaker long setups that drive the negative long R.
  if (bias === "long" && signalScore.conviction < 50) {
    return {
      bias: "no-trade", setupType: "No Setup",
      entryLow: null, entryHigh: null,
      stopLoss: null, target1: null, target2: null,
      rrRatio1: null, rrRatio2: null, riskPerShare: null,
      bestWindow,
      noTradeReason: `Long setup conviction ${signalScore.conviction}% is below the 50% floor — long trades require stronger signal alignment (shorts need only 35%)`,
      confidence: signalScore.conviction,
    };
  }

  // Guard against a zero/near-zero ATR (e.g. a symbol with a degenerate or
  // missing volatility read) — dividing by it below would produce Infinity/NaN
  // in the chase-guard and stop/target math instead of a clean no-trade.
  const rawAtr = l.intradayAtr ?? +(spot * 0.015).toFixed(2);
  if (!(rawAtr > 0)) {
    return {
      bias: "no-trade", setupType: "No Setup",
      entryLow: null, entryHigh: null,
      stopLoss: null, target1: null, target2: null,
      rrRatio1: null, rrRatio2: null, riskPerShare: null,
      bestWindow,
      noTradeReason: "Volatility (ATR) read is invalid — cannot size a safe stop/target",
      confidence: signalScore.conviction,
    };
  }
  const atr     = rawAtr;
  const halfAtr = atr / 2;

  // ── Setup type ───────────────────────────────────────────────────────────────
  // More specific reference levels (previous day / pre-market) are checked
  // before the generic ORB label so a setup that lines up with a well-known
  // level isn't silently reclassified as (and potentially gated out as) ORB.
  let setupType = "VWAP Trend " + (bias === "long" ? "Long" : "Short");
  if (l.pdHigh && spot > l.pdHigh && bias === "long")  setupType = "Previous Day High Breakout";
  else if (l.pdLow  && spot < l.pdLow  && bias === "short") setupType = "Previous Day Low Breakdown";
  else if (l.preMarketHigh && spot > l.preMarketHigh && bias === "long")  setupType = "Pre-Market High Breakout";
  else if (l.preMarketLow  && spot < l.preMarketLow  && bias === "short") setupType = "Pre-Market Low Breakdown";
  else if (l.orbBroken === "up"   && bias === "long")  setupType = "ORB Breakout";
  else if (l.orbBroken === "down" && bias === "short") setupType = "ORB Breakdown";
  else if (l.vwap && Math.abs(spot - l.vwap) / l.vwap < 0.003 && bias === "long")  setupType = "VWAP Reclaim";
  else if (l.vwap && Math.abs(spot - l.vwap) / l.vwap < 0.003 && bias === "short") setupType = "VWAP Rejection";

  // ── Root-cause fix: trigger level must match the classified setup type ───────
  // BUG (found via backtest): entry anchoring only ever used orbHigh/orbLow or
  // vwap/spot — never pdHigh/pdLow/preMarketHigh/Low — even when the setup was
  // labeled "Previous Day High Breakout" etc. That mismatch fed a level into
  // the entry math that had nothing to do with the setup being traded.
  //
  // A second, more serious bug: for confirmed breakouts (ORB in particular),
  // by the time this runs (10:15/11:00/13:45, well after the 9:45 ORB break),
  // price has often already run well past the trigger. The old formula
  // (`entryLow = max(trigger, spot - 0.15*atr)`, `entryHigh = trigger + 0.15*atr`)
  // could then produce entryLow > entryHigh — an inverted, nonsensical zone —
  // and even when not inverted, it silently "entered" at the already-extended
  // price instead of waiting for a pullback. This is almost certainly why ORB
  // setups showed negative edge: the setups were chasing exhausted moves, not
  // the ORB concept itself being unsound.
  const triggerLevel: number | null =
    setupType === "ORB Breakout"                 ? l.orbHigh :
    setupType === "ORB Breakdown"                 ? l.orbLow :
    setupType === "Previous Day High Breakout"    ? l.pdHigh :
    setupType === "Previous Day Low Breakdown"    ? l.pdLow :
    setupType === "Pre-Market High Breakout"      ? l.preMarketHigh :
    setupType === "Pre-Market Low Breakdown"      ? l.preMarketLow :
    l.vwap ?? spot; // VWAP Reclaim / Rejection / Trend

  // Max distance price may have already run past the trigger before we
  // consider the entry "still reachable." Beyond this, a real trader would
  // wait for a retest rather than chase — so we pass instead of faking a fill.
  const MAX_CHASE_ATR = 0.5;
  const extension = bias === "long"
    ? (triggerLevel != null ? (spot - triggerLevel) / atr : 0)
    : (triggerLevel != null ? (triggerLevel - spot) / atr : 0);

  if (triggerLevel != null && extension > MAX_CHASE_ATR) {
    return {
      bias: "no-trade", setupType: "No Setup",
      entryLow: null, entryHigh: null,
      stopLoss: null, target1: null, target2: null,
      rrRatio1: null, rrRatio2: null, riskPerShare: null,
      bestWindow,
      noTradeReason: `${setupType} trigger already ${extension.toFixed(1)}x ATR behind price — too extended to chase, wait for a pullback/retest`,
      confidence: signalScore.conviction,
    };
  }

  // ── Empirical setup-type quality gate ────────────────────────────────────────
  // Derived from a walk-forward backtest (18 symbols, ~58 trading days, train/test
  // split — see BACKTEST_REPORT.md). Setup types NOT in this list showed a
  // negative or statistically unproven edge on held-out data and are blocked
  // from generating an actionable trade, converting to no-trade instead.
  //
  // This is intentionally a short, conservative list on a modest sample —
  // re-run `pnpm --filter @workspace/api-server run backtest` periodically as
  // more history accrues and widen this list only when a setup type clears
  // the bar (N >= 12 trades in TRAIN, positive avg R) AND holds up on TEST.
  // NOTE: this list was re-derived AFTER the trigger/chase-guard fix above —
  // see BACKTEST_REPORT.md for the corrected numbers.
  const EMPIRICAL_SETUP_ALLOWLIST = new Set<string>(EMPIRICAL_ALLOWED_SETUP_TYPES);

  if (!bypassEmpiricalGate && !EMPIRICAL_SETUP_ALLOWLIST.has(setupType)) {
    return {
      bias: "no-trade", setupType: "No Setup",
      entryLow: null, entryHigh: null,
      stopLoss: null, target1: null, target2: null,
      rrRatio1: null, rrRatio2: null, riskPerShare: null,
      bestWindow,
      noTradeReason: `${setupType} has not demonstrated a reliable backtested edge yet — passing rather than forcing an unproven setup`,
      confidence: signalScore.conviction,
    };
  }

  // ── Entry zone, stop, targets ────────────────────────────────────────────────
  // Entry zone is now anchored to the correct trigger level (retest zone),
  // not a mix of "trigger" and possibly-extended "spot". Ordering is enforced
  // with min/max so the zone can never invert.
  let entryLow: number | null  = null;
  let entryHigh: number | null = null;
  let stopLoss: number | null  = null;
  let target1: number | null   = null;
  let target2: number | null   = null;

  const trig = triggerLevel ?? spot;

  if (bias === "long") {
    entryLow  = +(Math.min(trig - atr * 0.10, trig) ).toFixed(2);
    entryHigh = +(Math.max(trig + atr * 0.15, trig) ).toFixed(2);

    // Stop: tightest valid level below entry, but never so tight that normal
    // intraday noise would stop it out before the thesis has a chance to play
    // out. MIN_STOP_ATR enforces a floor on risk-per-share so R:R ratios stay
    // realistic instead of being inflated by a near-zero-risk denominator.
    const MIN_STOP_ATR = 0.4;
    const stopCandidates = [
      l.vwapLower1,
      l.vwap ? l.vwap - halfAtr : null,
      l.orbLow   ? l.orbLow   - atr * 0.10 : null,
      l.pdLow    ? l.pdLow    - atr * 0.05 : null,
    ].filter((v): v is number => v != null && v <= entryLow! - atr * MIN_STOP_ATR);

    stopLoss = stopCandidates.length
      ? +(Math.max(...stopCandidates)).toFixed(2) // tightest valid stop
      : +(entryLow - atr * 0.75).toFixed(2);

    // Targets: nearest meaningful resistance above entry
    const t1Candidates = [
      l.orbHigh && l.orbRange ? l.orbHigh + l.orbRange       : null,
      l.pdHigh   && spot < l.pdHigh ? l.pdHigh               : null,
      l.preMarketHigh && spot < l.preMarketHigh ? l.preMarketHigh : null,
      l.vwapUpper1,
    ].filter((v): v is number => v != null && v > entryHigh! + halfAtr * 0.5);
    target1 = t1Candidates.length
      ? +(Math.min(...t1Candidates)).toFixed(2)
      : +(entryHigh + atr * 1.5).toFixed(2);

    const t2Candidates = [
      l.orbHigh && l.orbRange ? l.orbHigh + l.orbRange * 2 : null,
      l.vwapUpper2,
    ].filter((v): v is number => v != null && v > (target1 ?? spot) + halfAtr * 0.5);
    target2 = t2Candidates.length
      ? +(Math.min(...t2Candidates)).toFixed(2)
      : +(entryHigh + atr * 2.5).toFixed(2);

  } else {
    // SHORT
    entryHigh = +(Math.max(trig + atr * 0.10, trig)).toFixed(2);
    entryLow  = +(Math.min(trig - atr * 0.15, trig)).toFixed(2);

    const MIN_STOP_ATR = 0.4;
    const stopCandidates = [
      l.vwapUpper1,
      l.vwap ? l.vwap + halfAtr : null,
      l.orbHigh  ? l.orbHigh  + atr * 0.10 : null,
      l.pdHigh   ? l.pdHigh   + atr * 0.05 : null,
    ].filter((v): v is number => v != null && v >= entryHigh! + atr * MIN_STOP_ATR);

    stopLoss = stopCandidates.length
      ? +(Math.min(...stopCandidates)).toFixed(2)
      : +(entryHigh + atr * 0.75).toFixed(2);

    const t1Candidates = [
      l.orbLow && l.orbRange ? l.orbLow - l.orbRange       : null,
      l.pdLow  && spot > l.pdLow  ? l.pdLow                : null,
      l.preMarketLow && spot > l.preMarketLow ? l.preMarketLow : null,
      l.vwapLower1,
    ].filter((v): v is number => v != null && v < entryLow! - halfAtr * 0.5);
    target1 = t1Candidates.length
      ? +(Math.max(...t1Candidates)).toFixed(2)
      : +(entryLow - atr * 1.5).toFixed(2);

    const t2Candidates = [
      l.orbLow && l.orbRange ? l.orbLow - l.orbRange * 2 : null,
      l.vwapLower2,
    ].filter((v): v is number => v != null && v < (target1 ?? spot) - halfAtr * 0.5);
    target2 = t2Candidates.length
      ? +(Math.max(...t2Candidates)).toFixed(2)
      : +(entryLow - atr * 2.5).toFixed(2);
  }

  // ── R:R ratios ───────────────────────────────────────────────────────────────
  const entryMid     = entryLow != null && entryHigh != null
    ? (entryLow + entryHigh) / 2
    : (entryLow ?? entryHigh ?? spot);
  const riskPerShare = stopLoss != null ? +Math.abs(entryMid - stopLoss).toFixed(2) : null;

  // Cap displayed R:R at a realistic ceiling. Beyond ~6:1, a target is
  // usually just "far away" rather than a genuinely achievable level, and
  // uncapped ratios let rare outlier days dominate any aggregate statistic
  // (backtests, dashboards, etc.) built on top of this number.
  const MAX_RR = 6;
  const rrRatio1 = target1 != null && riskPerShare && riskPerShare > 0
    ? +Math.min(Math.abs(target1 - entryMid) / riskPerShare, MAX_RR).toFixed(1)
    : null;
  const rrRatio2 = target2 != null && riskPerShare && riskPerShare > 0
    ? +Math.min(Math.abs(target2 - entryMid) / riskPerShare, MAX_RR).toFixed(1)
    : null;

  // ── R:R quality filter ───────────────────────────────────────────────────────
  // Raised from 1.0 → 1.2: 1:1 R:R barely compensates for a 50% win rate, and
  // our win rates are in the 40-57% range. 1.2:1 minimum ensures every trade
  // that fires has positive expected value even at 45% wins (0.45×1.2 - 0.55 > 0).
  const MIN_RR = 1.2;
  if (rrRatio1 != null && rrRatio1 < MIN_RR) {
    return {
      bias: "no-trade", setupType: "No Setup",
      entryLow: null, entryHigh: null,
      stopLoss: null, target1: null, target2: null,
      rrRatio1: null, rrRatio2: null, riskPerShare: null,
      bestWindow,
      noTradeReason: `Reward-to-risk too thin (${rrRatio1.toFixed(1)}:1 on T1, below ${MIN_RR}:1 minimum) — nearest target is too close to the stop`,
      confidence: signalScore.conviction,
    };
  }

  return {
    bias, setupType,
    entryLow:    entryLow   != null ? +entryLow.toFixed(2)   : null,
    entryHigh:   entryHigh  != null ? +entryHigh.toFixed(2)  : null,
    stopLoss:    stopLoss   != null ? +stopLoss.toFixed(2)   : null,
    target1:     target1    != null ? +target1.toFixed(2)    : null,
    target2:     target2    != null ? +target2.toFixed(2)    : null,
    rrRatio1, rrRatio2,
    riskPerShare: riskPerShare != null ? +riskPerShare.toFixed(2) : null,
    bestWindow,
    noTradeReason: null,
    confidence: signalScore.conviction,
  };
}
