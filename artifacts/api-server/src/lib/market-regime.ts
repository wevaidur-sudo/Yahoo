/**
 * Market regime detector — macro-level context for individual stock predictions.
 *
 * The probability of a short setup succeeding on an individual stock is
 * dramatically higher when the broad market is in a downtrend (SPY below
 * its 20-day SMA) and fear is elevated (VIX > 20). This module quantifies
 * that context as a leading signal modifier.
 *
 * Signals:
 *   SPY Trend (20-day SMA)   +5 / -5 pts — risk-on vs risk-off
 *   VIX Level                +5 / -5 pts — fear/complacency modifier
 *   SPY momentum (5 vs 20)   +5 /  0 pts — acceleration confirmation
 *
 * MAX contribution: ±10 pts (capped: regime never overrides a strong individual setup)
 */

export interface MarketRegimeResult {
  direction: "bullish" | "bearish" | "neutral";
  /** Score range: -10 (full bear regime) to +10 (full bull regime) */
  score: number;
  spyAbove20SMA: boolean | null;
  spyAbove5SMA: boolean | null;
  vixLevel: number | null;
  /** "fear" = VIX > 25, "elevated" = 20-25, "normal" = 15-20, "complacent" = < 15 */
  vixRegime: "fear" | "elevated" | "normal" | "complacent" | null;
  note: string;
}

// Simple SMA helper (no external deps)
function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getMarketRegime(yahooFinance: any): Promise<MarketRegimeResult> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000);

  try {
    const [spyResult, vixResult] = await Promise.allSettled([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (yahooFinance as any).chart("SPY", {
        period1: thirtyDaysAgo,
        period2: now,
        interval: "1d",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as Promise<any>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (yahooFinance as any).quote("^VIX") as Promise<any>,
    ]);

    // ── SPY trend analysis ─────────────────────────────────────────────────
    let spyAbove20SMA: boolean | null = null;
    let spyAbove5SMA: boolean | null  = null;

    if (spyResult.status === "fulfilled") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const quotes: any[] = spyResult.value?.quotes ?? [];
      const closes = quotes
        .filter((q: any) => q.close != null)
        .map((q: any) => q.close as number);

      if (closes.length >= 20) {
        const lastClose = closes[closes.length - 1];
        const sma20 = sma(closes, 20);
        const sma5  = sma(closes, 5);
        spyAbove20SMA = sma20 != null ? lastClose > sma20 : null;
        spyAbove5SMA  = sma5  != null ? lastClose > sma5  : null;
      }
    }

    // ── VIX level ──────────────────────────────────────────────────────────
    let vixLevel: number | null = null;
    if (vixResult.status === "fulfilled") {
      const price = vixResult.value?.regularMarketPrice;
      if (typeof price === "number" && price > 0) vixLevel = +price.toFixed(2);
    }

    // ── Regime classification ──────────────────────────────────────────────
    let vixRegime: MarketRegimeResult["vixRegime"] = null;
    if (vixLevel != null) {
      if      (vixLevel >= 25) vixRegime = "fear";
      else if (vixLevel >= 20) vixRegime = "elevated";
      else if (vixLevel >= 15) vixRegime = "normal";
      else                     vixRegime = "complacent";
    }

    // ── Scoring ────────────────────────────────────────────────────────────
    let score = 0;

    // SPY 20-day SMA: most important regime indicator
    if (spyAbove20SMA === true)  score += 5;
    if (spyAbove20SMA === false) score -= 5;

    // SPY 5-day SMA: short-term momentum confirmation
    if (spyAbove5SMA === true && spyAbove20SMA === true)  score += 3;  // strong bull momentum
    if (spyAbove5SMA === false && spyAbove20SMA === false) score -= 3; // strong bear momentum

    // VIX modifier
    if (vixRegime === "complacent") score += 2;  // low fear = risk-on
    if (vixRegime === "normal")     score += 0;  // neutral
    if (vixRegime === "elevated")   score -= 2;  // mild risk-off
    if (vixRegime === "fear")       score -= 5;  // high fear = risk-off (shorts preferred)

    // Cap at ±10
    score = Math.max(-10, Math.min(10, score));

    const direction: MarketRegimeResult["direction"] =
      score >= 4 ? "bullish" : score <= -4 ? "bearish" : "neutral";

    // ── Note ──────────────────────────────────────────────────────────────
    const spyDesc = spyAbove20SMA == null
      ? "SPY trend unknown"
      : spyAbove20SMA
      ? `SPY above 20-day SMA (risk-on)`
      : `SPY below 20-day SMA (risk-off)`;

    const vixDesc = vixLevel != null
      ? `VIX ${vixLevel} (${vixRegime})`
      : "VIX unavailable";

    const regimeDesc =
      direction === "bullish" ? "Bull regime — long setups have macro tailwind" :
      direction === "bearish" ? "Bear regime — short setups have macro tailwind; fade all longs until SPY reclaims 20-SMA" :
      "Neutral regime — market in transition; treat individual setups on their own merit";

    const note = `${spyDesc} | ${vixDesc}. ${regimeDesc}.`;

    return { direction, score, spyAbove20SMA, spyAbove5SMA, vixLevel, vixRegime, note };

  } catch {
    return {
      direction: "neutral", score: 0,
      spyAbove20SMA: null, spyAbove5SMA: null,
      vixLevel: null, vixRegime: null,
      note: "Market regime data unavailable — using neutral modifier",
    };
  }
}
