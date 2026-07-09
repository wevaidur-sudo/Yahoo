/**
 * Point-in-time feature engineering shared by both the offline training
 * pipeline and the live scoring path in analysis.ts, so the model always
 * sees features computed the exact same way it was trained on.
 */

export interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FundamentalSnapshot {
  trailingPE: number | null;
  forwardPE: number | null;
  pegRatio: number | null;
  priceToBook: number | null;
  revenueGrowth: number | null;
  earningsGrowth: number | null;
  grossMargins: number | null;
  returnOnEquity: number | null;
  debtToEquity: number | null;
}

export const EMPTY_FUNDAMENTALS: FundamentalSnapshot = {
  trailingPE: null,
  forwardPE: null,
  pegRatio: null,
  priceToBook: null,
  revenueGrowth: null,
  earningsGrowth: null,
  grossMargins: null,
  returnOnEquity: null,
  debtToEquity: null,
};

/** Names of every feature column, in the exact order `buildFeatureVector` emits them. */
export const FEATURE_NAMES = [
  // Momentum group
  "rsi14",
  "macdHistogram",
  "priceVsSma20",
  "priceVsSma50",
  "priceVsSma200",
  "return5d",
  "return20d",
  "return60d",
  // Low-risk / volatility group
  "volatility20d",
  "volatility60d",
  "atrPct",
  "maxDrawdown60d",
  "bollingerWidth",
  // Value / fundamental group
  "trailingPE",
  "forwardPE",
  "pegRatio",
  "priceToBook",
  "revenueGrowth",
  "earningsGrowth",
  "grossMargins",
  "returnOnEquity",
  "debtToEquity",
  // Volume (kept in "overall" only)
  "volumeRatio20d",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

/** Feature-column subsets used to train each Danelfin-style sub-score model. */
export const FEATURE_GROUPS: Record<"momentum" | "value" | "lowRisk" | "overall", FeatureName[]> = {
  momentum: ["rsi14", "macdHistogram", "priceVsSma20", "priceVsSma50", "priceVsSma200", "return5d", "return20d", "return60d"],
  lowRisk: ["volatility20d", "volatility60d", "atrPct", "maxDrawdown60d", "bollingerWidth"],
  value: ["trailingPE", "forwardPE", "pegRatio", "priceToBook", "revenueGrowth", "earningsGrowth", "grossMargins", "returnOnEquity", "debtToEquity"],
  overall: [...FEATURE_NAMES],
};

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function stdDev(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Computes the full feature vector as of index `i` in `bars` (using only
 * bars[0..i], never future data — this is what makes the training set a
 * valid point-in-time series rather than a look-ahead-biased one).
 */
export function computeFeaturesAt(
  bars: Bar[],
  i: number,
  fundamentals: FundamentalSnapshot,
): Record<FeatureName, number> | null {
  if (i < 200) return null; // need enough history for SMA200 etc.

  const closes = bars.slice(0, i + 1).map((b) => b.close);
  const highs = bars.slice(0, i + 1).map((b) => b.high);
  const lows = bars.slice(0, i + 1).map((b) => b.low);
  const volumes = bars.slice(0, i + 1).map((b) => b.volume);
  const spot = closes[closes.length - 1];

  // RSI(14), Wilder smoothing
  const rsi14 = (() => {
    const period = 14;
    if (closes.length < period + 1) return 50;
    const changes = closes.slice(1).map((c, idx) => c - closes[idx]);
    let avgGain = 0, avgLoss = 0;
    for (let k = 0; k < period; k++) {
      if (changes[k] > 0) avgGain += changes[k]; else avgLoss += Math.abs(changes[k]);
    }
    avgGain /= period; avgLoss /= period;
    for (let k = period; k < changes.length; k++) {
      const g = changes[k] > 0 ? changes[k] : 0;
      const l = changes[k] < 0 ? Math.abs(changes[k]) : 0;
      avgGain = (avgGain * (period - 1) + g) / period;
      avgLoss = (avgLoss * (period - 1) + l) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
  })();

  // MACD histogram via EMA(12)/EMA(26)/signal(9)
  const macdHistogram = (() => {
    function ema(values: number[], period: number): number[] {
      if (values.length < period) return values.map(() => NaN);
      const k = 2 / (period + 1);
      const out: number[] = new Array(period - 1).fill(NaN);
      const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
      out.push(seed);
      for (let idx = period; idx < values.length; idx++) out.push(values[idx] * k + out[out.length - 1] * (1 - k));
      return out;
    }
    if (closes.length < 34) return 0;
    const e12 = ema(closes, 12);
    const e26 = ema(closes, 26);
    const macdLine = e12.map((v, idx) => (isNaN(v) || isNaN(e26[idx]) ? NaN : v - e26[idx])).filter((v) => !isNaN(v));
    if (macdLine.length < 9) return 0;
    const sig = ema(macdLine, 9);
    const lastMacd = macdLine[macdLine.length - 1];
    const lastSig = sig[sig.length - 1];
    return isNaN(lastSig) ? 0 : lastMacd - lastSig;
  })();

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);

  const ret = (n: number) => (closes.length > n ? closes[closes.length - 1] / closes[closes.length - 1 - n] - 1 : 0);

  const dailyReturns20 = closes.slice(-21).slice(1).map((c, idx) => c / closes.slice(-21)[idx] - 1);
  const dailyReturns60 = closes.slice(-61).slice(1).map((c, idx) => c / closes.slice(-61)[idx] - 1);

  const volatility20d = dailyReturns20.length > 5 ? stdDev(dailyReturns20) * Math.sqrt(252) * 100 : 30;
  const volatility60d = dailyReturns60.length > 5 ? stdDev(dailyReturns60) * Math.sqrt(252) * 100 : 30;

  const atrPct = (() => {
    const period = 14;
    if (highs.length < period + 1) return 2;
    const trs: number[] = [];
    for (let k = highs.length - period; k < highs.length; k++) {
      trs.push(Math.max(highs[k] - lows[k], Math.abs(highs[k] - closes[k - 1]), Math.abs(lows[k] - closes[k - 1])));
    }
    const atr = trs.reduce((a, b) => a + b, 0) / trs.length;
    return (atr / spot) * 100;
  })();

  const maxDrawdown60d = (() => {
    const window = closes.slice(-60);
    let peak = -Infinity, maxDd = 0;
    for (const c of window) {
      peak = Math.max(peak, c);
      maxDd = Math.min(maxDd, (c - peak) / peak);
    }
    return Math.abs(maxDd) * 100;
  })();

  const bollingerWidth = (() => {
    const period = 20;
    if (closes.length < period) return 4;
    const slice = closes.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const std = stdDev(slice);
    return mean > 0 ? ((4 * std) / mean) * 100 : 4;
  })();

  const avgVol20 = sma(volumes, 20);
  const volumeRatio20d = avgVol20 && avgVol20 > 0 ? volumes[volumes.length - 1] / avgVol20 : 1;

  return {
    rsi14,
    macdHistogram,
    priceVsSma20: sma20 ? spot / sma20 - 1 : 0,
    priceVsSma50: sma50 ? spot / sma50 - 1 : 0,
    priceVsSma200: sma200 ? spot / sma200 - 1 : 0,
    return5d: ret(5),
    return20d: ret(20),
    return60d: ret(60),
    volatility20d,
    volatility60d,
    atrPct,
    maxDrawdown60d,
    bollingerWidth,
    trailingPE: fundamentals.trailingPE ?? 25,
    forwardPE: fundamentals.forwardPE ?? 22,
    pegRatio: fundamentals.pegRatio ?? 2,
    priceToBook: fundamentals.priceToBook ?? 5,
    revenueGrowth: fundamentals.revenueGrowth ?? 0.05,
    earningsGrowth: fundamentals.earningsGrowth ?? 0.05,
    grossMargins: fundamentals.grossMargins ?? 0.4,
    returnOnEquity: fundamentals.returnOnEquity ?? 0.15,
    debtToEquity: fundamentals.debtToEquity ?? 1,
    volumeRatio20d,
  };
}

export function vectorFor(features: Record<FeatureName, number>, group: FeatureName[]): number[] {
  return group.map((name) => features[name]);
}
