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
 *   Subtotal             105  (normalised → 100)
 *
 * RVOL modifier applied AFTER directional scoring:
 *   >= 1.5x → conviction × 1.20 (capped 100)  — institutional participation
 *   <  0.60x → no-trade override               — volume too thin
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

  // Raw conviction based on dominance (0-100)
  let conviction = totalWeight > 0 ? Math.round((Math.abs(net) / totalWeight) * 100) : 0;

  // ── RVOL modifier — add as display signal, then adjust conviction ────────────
  let noTradeReason: string | null = null;

  if (l.rvol != null) {
    if (l.rvol >= 1.5) {
      signals.push({
        name: "Relative Volume", signal: "bullish", weight: 0,
        value: `${l.rvol.toFixed(2)}x average`,
        note: `High RVOL ${l.rvol.toFixed(1)}x — institutional participation confirmed; setup reliability elevated`,
      });
      conviction = Math.min(100, Math.round(conviction * 1.20));
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
    if (conviction < 25) {
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

export function generateTradeSetup(params: {
  spot: number;
  levels: IntradayLevels;
  signalScore: IntradaySignalScore;
  now: Date;
}): TradeSetup {
  const { spot, levels: l, signalScore, now } = params;

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

  const bias    = signalScore.direction === "bullish" ? "long" : "short";
  const atr     = l.intradayAtr ?? +(spot * 0.015).toFixed(2); // fallback: ~1.5% of price
  const halfAtr = atr / 2;

  // ── Setup type ───────────────────────────────────────────────────────────────
  let setupType = "VWAP Trend " + (bias === "long" ? "Long" : "Short");
  if (l.orbBroken === "up"   && bias === "long")  setupType = "ORB Breakout";
  else if (l.orbBroken === "down" && bias === "short") setupType = "ORB Breakdown";
  else if (l.vwap && Math.abs(spot - l.vwap) / l.vwap < 0.003 && bias === "long")  setupType = "VWAP Reclaim";
  else if (l.vwap && Math.abs(spot - l.vwap) / l.vwap < 0.003 && bias === "short") setupType = "VWAP Rejection";
  else if (l.pdHigh && spot > l.pdHigh && bias === "long")  setupType = "Previous Day High Breakout";
  else if (l.pdLow  && spot < l.pdLow  && bias === "short") setupType = "Previous Day Low Breakdown";
  else if (l.preMarketHigh && spot > l.preMarketHigh && bias === "long")  setupType = "Pre-Market High Breakout";
  else if (l.preMarketLow  && spot < l.preMarketLow  && bias === "short") setupType = "Pre-Market Low Breakdown";

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
  const EMPIRICAL_SETUP_ALLOWLIST = new Set<string>([
    "Previous Day Low Breakdown",
    "VWAP Rejection",
  ]);

  if (!EMPIRICAL_SETUP_ALLOWLIST.has(setupType)) {
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
  let entryLow: number | null  = null;
  let entryHigh: number | null = null;
  let stopLoss: number | null  = null;
  let target1: number | null   = null;
  let target2: number | null   = null;

  if (bias === "long") {
    const trigger = l.orbBroken === "up" ? l.orbHigh : l.vwap ?? spot;
    entryLow  = +(Math.max(trigger ?? spot, spot - atr * 0.15)).toFixed(2);
    entryHigh = +((trigger ?? spot) + atr * 0.15).toFixed(2);

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
    ].filter((v): v is number => v != null && v <= spot - atr * MIN_STOP_ATR);

    stopLoss = stopCandidates.length
      ? +(Math.max(...stopCandidates)).toFixed(2) // tightest valid stop
      : +(spot - atr * 0.75).toFixed(2);

    // Targets: nearest meaningful resistance above entry
    const t1Candidates = [
      l.orbHigh && l.orbRange ? l.orbHigh + l.orbRange       : null,
      l.pdHigh   && spot < l.pdHigh ? l.pdHigh               : null,
      l.preMarketHigh && spot < l.preMarketHigh ? l.preMarketHigh : null,
      l.vwapUpper1,
    ].filter((v): v is number => v != null && v > (entryHigh ?? spot) + halfAtr * 0.5);
    target1 = t1Candidates.length
      ? +(Math.min(...t1Candidates)).toFixed(2)
      : +(spot + atr * 1.5).toFixed(2);

    const t2Candidates = [
      l.orbHigh && l.orbRange ? l.orbHigh + l.orbRange * 2 : null,
      l.vwapUpper2,
    ].filter((v): v is number => v != null && v > (target1 ?? spot) + halfAtr * 0.5);
    target2 = t2Candidates.length
      ? +(Math.min(...t2Candidates)).toFixed(2)
      : +(spot + atr * 2.5).toFixed(2);

  } else {
    // SHORT
    const trigger = l.orbBroken === "down" ? l.orbLow : l.vwap ?? spot;
    entryHigh = +(Math.min(trigger ?? spot, spot + atr * 0.15)).toFixed(2);
    entryLow  = +((trigger ?? spot) - atr * 0.15).toFixed(2);

    const MIN_STOP_ATR = 0.4;
    const stopCandidates = [
      l.vwapUpper1,
      l.vwap ? l.vwap + halfAtr : null,
      l.orbHigh  ? l.orbHigh  + atr * 0.10 : null,
      l.pdHigh   ? l.pdHigh   + atr * 0.05 : null,
    ].filter((v): v is number => v != null && v >= spot + atr * MIN_STOP_ATR);

    stopLoss = stopCandidates.length
      ? +(Math.min(...stopCandidates)).toFixed(2)
      : +(spot + atr * 0.75).toFixed(2);

    const t1Candidates = [
      l.orbLow && l.orbRange ? l.orbLow - l.orbRange       : null,
      l.pdLow  && spot > l.pdLow  ? l.pdLow                : null,
      l.preMarketLow && spot > l.preMarketLow ? l.preMarketLow : null,
      l.vwapLower1,
    ].filter((v): v is number => v != null && v < (entryLow ?? spot) - halfAtr * 0.5);
    target1 = t1Candidates.length
      ? +(Math.max(...t1Candidates)).toFixed(2)
      : +(spot - atr * 1.5).toFixed(2);

    const t2Candidates = [
      l.orbLow && l.orbRange ? l.orbLow - l.orbRange * 2 : null,
      l.vwapLower2,
    ].filter((v): v is number => v != null && v < (target1 ?? spot) - halfAtr * 0.5);
    target2 = t2Candidates.length
      ? +(Math.max(...t2Candidates)).toFixed(2)
      : +(spot - atr * 2.5).toFixed(2);
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
  // A setup with less than 1:1 reward-to-risk on its first target isn't a
  // professionally acceptable trade, regardless of directional conviction.
  const MIN_RR = 1;
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
