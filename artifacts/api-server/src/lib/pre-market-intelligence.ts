/**
 * Pre-market intelligence — LEADING indicators from 4:00–9:30 AM ET data.
 *
 * Unlike every other signal in the engine (which reacts to moves already made),
 * these signals fire BEFORE the regular session opens. They capture institutional
 * positioning, momentum direction, and volume patterns that reliably precede
 * major intraday moves.
 *
 * Signals:
 *   PM Momentum           weight ≤ 20 — trajectory of price across PM session
 *   Block Trade Detection weight ≤ 10 — abnormal single-bar volume = smart money
 *   Earnings Proximity    weight  = 0 — no directional weight, but caps conviction
 *
 * MAX contribution: 30 pts
 */

import type { IntradayBar } from "./intraday";

export interface PreMarketResult {
  /** Net directional bias from PM activity */
  direction: "bullish" | "bearish" | "neutral";
  /** Momentum score: positive = bullish, negative = bearish, range ±20 */
  momentumScore: number;
  /** Block trade score: positive = bullish buying, negative = bearish selling, range ±10 */
  blockTradeScore: number;
  /** PM price velocity: % per hour from PM open → PM close */
  velocityPctPerHour: number;
  /** Pre-market volume vs expected (1.0 = normal, 2.0 = double normal) */
  volumeSurge: number;
  /** True if any single bar had > 5× average PM bar volume */
  blockTradeDetected: boolean;
  /** Calendar days until next earnings (null = not scheduled / unknown) */
  earningsInDays: number | null;
  /** Human-readable summary */
  note: string;
}

/**
 * Compute pre-market predictive intelligence from 1-minute pre-market bars.
 *
 * @param preMarketBars   1m bars from 4:00–9:30 AM ET today
 * @param pdClose         Previous day's closing price (for gap reference)
 * @param avgDailyVolume  3-month average daily volume from quote
 * @param earningsTs      Unix timestamp (ms) of next earnings event, or null
 * @param now             Current time
 */
export function computePreMarketIntelligence(params: {
  preMarketBars: IntradayBar[];
  pdClose: number | null;
  avgDailyVolume: number | null;
  earningsTs: number | null;
  now: Date;
}): PreMarketResult {
  const { preMarketBars, pdClose, avgDailyVolume, earningsTs, now } = params;

  // ── Earnings proximity ─────────────────────────────────────────────────────
  let earningsInDays: number | null = null;
  if (earningsTs != null) {
    const diffMs = earningsTs - now.getTime();
    if (diffMs > 0 && diffMs < 30 * 24 * 60 * 60 * 1000) {
      earningsInDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
    }
  }

  if (preMarketBars.length < 3) {
    return {
      direction: "neutral", momentumScore: 0, blockTradeScore: 0,
      velocityPctPerHour: 0, volumeSurge: 1.0, blockTradeDetected: false,
      earningsInDays,
      note: earningsInDays != null && earningsInDays <= 5
        ? `Earnings in ${earningsInDays}d — elevated volatility expected; treat all setups as higher-risk`
        : "No pre-market data — cannot compute leading momentum",
    };
  }

  // ── PM momentum: segment bars into thirds and track directional trajectory ─
  const third = Math.floor(preMarketBars.length / 3);
  const early = preMarketBars.slice(0, third);
  const mid   = preMarketBars.slice(third, 2 * third);
  const late  = preMarketBars.slice(2 * third);

  const avgClose = (bars: IntradayBar[]) =>
    bars.reduce((s, b) => s + b.close, 0) / bars.length;

  const earlyAvg = avgClose(early);
  const midAvg   = avgClose(mid);
  const lateAvg  = avgClose(late);

  // Is price progressively higher? → bullish PM momentum
  // Is price progressively lower?  → bearish PM momentum
  const trend1 = midAvg > earlyAvg;  // first half trending up?
  const trend2 = lateAvg > midAvg;   // second half trending up?

  let momentumScore = 0;
  if (trend1 && trend2) {
    // Consistent uptrend across full PM session — strongest bullish signal
    const move = (lateAvg - earlyAvg) / earlyAvg * 100;
    momentumScore = Math.min(20, Math.round(move * 8)); // 2.5% PM rise → ~20pts
    momentumScore = Math.max(5, momentumScore); // minimum 5pts for any confirmed uptrend
  } else if (!trend1 && !trend2) {
    // Consistent downtrend across full PM session
    const move = (earlyAvg - lateAvg) / earlyAvg * 100;
    momentumScore = -Math.min(20, Math.round(move * 8));
    momentumScore = Math.min(-5, momentumScore);
  } else if (trend2 && !trend1) {
    // Recovered in late PM — late-session buying (moderately bullish)
    const move = (lateAvg - midAvg) / midAvg * 100;
    momentumScore = Math.min(10, Math.round(move * 6));
  } else {
    // Faded in late PM — late-session selling (moderately bearish)
    const move = (midAvg - lateAvg) / midAvg * 100;
    momentumScore = -Math.min(10, Math.round(move * 6));
  }

  // ── Velocity: % change per hour from PM open → PM close ───────────────────
  const pmOpen  = preMarketBars[0].open;
  const pmClose = preMarketBars[preMarketBars.length - 1].close;
  const pmDurationHours = (
    preMarketBars[preMarketBars.length - 1].timestamp.getTime() -
    preMarketBars[0].timestamp.getTime()
  ) / (1000 * 60 * 60);
  const velocityPctPerHour = pmDurationHours > 0
    ? ((pmClose - pmOpen) / pmOpen * 100) / pmDurationHours
    : 0;

  // ── Volume surge detection ─────────────────────────────────────────────────
  // Pre-market typically represents ~8% of average daily volume.
  // A surge to 2x expected PM volume signals institutional activity.
  const totalPMVolume = preMarketBars.reduce((s, b) => s + b.volume, 0);
  const expectedPMVolume = avgDailyVolume ? avgDailyVolume * 0.08 : null;
  const volumeSurge = expectedPMVolume && expectedPMVolume > 0
    ? totalPMVolume / expectedPMVolume
    : 1.0;

  // ── Block trade detection ─────────────────────────────────────────────────
  // A single 1m bar with volume > 5× the average PM bar volume signals a
  // large institutional block print — this is NOT visible in VWAP/RSI yet.
  const avgBarVolume = totalPMVolume / preMarketBars.length;
  const maxBarVolume = Math.max(...preMarketBars.map((b) => b.volume));
  const blockTradeDetected = maxBarVolume > avgBarVolume * 5;

  // Block trade direction: which bar had the spike? Up bar or down bar?
  let blockTradeScore = 0;
  if (blockTradeDetected) {
    const blockBar = preMarketBars.reduce((best, b) =>
      b.volume > best.volume ? b : best, preMarketBars[0]);
    const isUpBar = blockBar.close > blockBar.open;
    // Block trade on an up-bar = institutional buying = bullish
    // Block trade on a down-bar = institutional selling = bearish
    blockTradeScore = isUpBar ? 10 : -10;
  }

  // ── Direction summary ──────────────────────────────────────────────────────
  const totalScore = momentumScore + blockTradeScore;
  const direction: PreMarketResult["direction"] =
    totalScore > 3 ? "bullish" : totalScore < -3 ? "bearish" : "neutral";

  // ── Note construction ──────────────────────────────────────────────────────
  const velStr = `${velocityPctPerHour > 0 ? "+" : ""}${velocityPctPerHour.toFixed(2)}%/hr`;
  const earningsNote = earningsInDays != null && earningsInDays <= 5
    ? ` ⚠ Earnings in ${earningsInDays}d.` : "";

  let note: string;
  if (Math.abs(momentumScore) >= 15) {
    note = `Strong ${direction} PM momentum (${velStr}); price ${momentumScore > 0 ? "accelerated higher" : "cascaded lower"} across full pre-market session — institutional directional positioning.${earningsNote}`;
  } else if (blockTradeDetected) {
    note = `Block trade detected (${(maxBarVolume / avgBarVolume).toFixed(1)}× avg bar volume) — ${blockTradeScore > 0 ? "institutional buying" : "institutional selling"} printed in pre-market; price hasn't fully reflected this yet.${earningsNote}`;
  } else if (volumeSurge >= 2) {
    note = `Pre-market volume ${volumeSurge.toFixed(1)}× expected — elevated institutional interest before open; momentum ${velStr}.${earningsNote}`;
  } else if (direction !== "neutral") {
    note = `${direction.charAt(0).toUpperCase() + direction.slice(1)} PM momentum at ${velStr}; consistent directional drift in pre-market session.${earningsNote}`;
  } else {
    note = `Neutral PM price action (${velStr}); no clear institutional bias before the open.${earningsNote}`;
  }

  return {
    direction, momentumScore, blockTradeScore,
    velocityPctPerHour: +velocityPctPerHour.toFixed(3),
    volumeSurge: +volumeSurge.toFixed(2),
    blockTradeDetected,
    earningsInDays,
    note,
  };
}
