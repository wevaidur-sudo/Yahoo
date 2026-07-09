import { Router, type IRouter } from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
// eslint-disable-next-line @typescript-eslint/no-require-imports
import YahooFinance from "yahoo-finance2";
import {
  blackScholes,
  computeStrategyMetrics,
  assessDataQuality,
  timeToExpiryYears,
  FALLBACK_RISK_FREE_RATE,
  type PayoffLeg,
} from "../lib/optionsMath";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yahooFinance = new (YahooFinance as any)({ suppressNotices: ["yahooSurvey"] });

const router: IRouter = Router();

// ─── Technical Indicator Helpers ──────────────────────────────────────────────

function calcSMA(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * EMA seeded with the SMA of the first `period` values — the standard used by
 * Bloomberg, TradingView, and thinkorswim. Returns NaN for the warm-up window.
 */
function calcEMA(values: number[], period: number): number[] {
  if (values.length < period) return values.map(() => NaN);
  const k = 2 / (period + 1);
  const result: number[] = new Array(period - 1).fill(NaN);
  const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(seed);
  for (let i = period; i < values.length; i++) {
    result.push(values[i] * k + result[result.length - 1] * (1 - k));
  }
  return result;
}

/**
 * RSI using Wilder's Smoothed Moving Average — the standard on Bloomberg,
 * TradingView, and all major professional platforms.
 * Seeds with SMA of the first `period` changes, then applies
 * avgGain = (prev × (period-1) + current) / period for every subsequent bar.
 */
function calcRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  const changes: number[] = [];
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);
  // Step 1 — seed with simple average of first `period` changes
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;
  // Step 2 — Wilder's smoothing for all remaining changes
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * MACD(12,26,9) with NaN-safe handling of the corrected SMA-seeded EMA.
 * The MACD line is valid from bar 25 onward; the signal line from bar 33 onward.
 */
function calcMACD(closes: number[]): {
  macd: number | null;
  signal: number | null;
  histogram: number | null;
} {
  // SMA-seeded EMA-26 valid at 26 closes; 9 valid MACD values exist at 34 closes.
  if (closes.length < 34) return { macd: null, signal: null, histogram: null };
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine: number[] = ema12.map((v, i) =>
    isNaN(v) || isNaN(ema26[i]) ? NaN : v - ema26[i],
  );
  const validMacd = macdLine.filter((v) => !isNaN(v));
  if (validMacd.length < 9) return { macd: null, signal: null, histogram: null };
  const signalArr = calcEMA(validMacd, 9);
  const lastMacd = validMacd[validMacd.length - 1];
  const lastSignal = signalArr[signalArr.length - 1];
  if (isNaN(lastSignal)) return { macd: lastMacd, signal: null, histogram: null };
  return { macd: lastMacd, signal: lastSignal, histogram: lastMacd - lastSignal };
}

function calcBollinger(
  closes: number[],
  period = 20,
): { upper: number | null; middle: number | null; lower: number | null } {
  if (closes.length < period) return { upper: null, middle: null, lower: null };
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + Math.pow(v - sma, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: sma + 2 * std, middle: sma, lower: sma - 2 * std };
}

function calcATR(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): number | null {
  if (highs.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1]),
      ),
    );
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── Rules-based signal confluence score ──────────────────────────────────────

interface TechnicalSignal {
  name: string;
  signal: "bullish" | "bearish" | "neutral";
  weight: number;
  value: string;
  note: string;
}

interface SignalScore {
  direction: "bullish" | "bearish" | "neutral";
  /** Normalised weighted score: -100 (max bearish) → +100 (max bullish). */
  score: number;
  bullishCount: number;
  bearishCount: number;
  neutralCount: number;
  signals: TechnicalSignal[];
}

function computeSignalScore(params: {
  spot: number;
  rsi: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  bollingerUpper: number | null;
  bollingerLower: number | null;
  volumeRatio: number | null;
  dayChange: number | null;
}): SignalScore {
  const signals: TechnicalSignal[] = [];

  // RSI — weight up to 15
  if (params.rsi !== null) {
    if (params.rsi < 30)
      signals.push({ name: "RSI (14)", signal: "bullish", weight: 15, value: params.rsi.toFixed(1), note: "Oversold — potential mean reversion" });
    else if (params.rsi > 70)
      signals.push({ name: "RSI (14)", signal: "bearish", weight: 15, value: params.rsi.toFixed(1), note: "Overbought — elevated pullback risk" });
    else if (params.rsi < 45)
      signals.push({ name: "RSI (14)", signal: "bullish", weight: 8, value: params.rsi.toFixed(1), note: "Below midline — room to run higher" });
    else if (params.rsi > 55)
      signals.push({ name: "RSI (14)", signal: "bearish", weight: 8, value: params.rsi.toFixed(1), note: "Above midline — approaching extended territory" });
    else
      signals.push({ name: "RSI (14)", signal: "neutral", weight: 0, value: params.rsi.toFixed(1), note: "Neutral zone (45–55)" });
  }

  // MACD Histogram — weight 20
  if (params.macdHistogram !== null) {
    const dir: "bullish" | "bearish" = params.macdHistogram > 0 ? "bullish" : "bearish";
    signals.push({ name: "MACD Histogram", signal: dir, weight: 20, value: params.macdHistogram.toFixed(4), note: dir === "bullish" ? "Positive — momentum expanding bullish" : "Negative — momentum expanding bearish" });
  }

  // MACD vs Signal crossover — weight 15
  if (params.macd !== null && params.macdSignal !== null) {
    const dir: "bullish" | "bearish" = params.macd > params.macdSignal ? "bullish" : "bearish";
    signals.push({ name: "MACD vs Signal", signal: dir, weight: 15, value: `${params.macd.toFixed(3)} vs ${params.macdSignal.toFixed(3)}`, note: dir === "bullish" ? "MACD above signal line" : "MACD below signal line" });
  }

  // Price vs SMA 20 — weight 10
  if (params.sma20 !== null) {
    const dir: "bullish" | "bearish" = params.spot > params.sma20 ? "bullish" : "bearish";
    signals.push({ name: "Price vs SMA 20", signal: dir, weight: 10, value: `${params.spot.toFixed(2)} vs ${params.sma20.toFixed(2)}`, note: dir === "bullish" ? "Above 20-day average — short-term uptrend" : "Below 20-day average — short-term downtrend" });
  }

  // Price vs SMA 50 — weight 10
  if (params.sma50 !== null) {
    const dir: "bullish" | "bearish" = params.spot > params.sma50 ? "bullish" : "bearish";
    signals.push({ name: "Price vs SMA 50", signal: dir, weight: 10, value: `${params.spot.toFixed(2)} vs ${params.sma50.toFixed(2)}`, note: dir === "bullish" ? "Above 50-day average — medium-term strength" : "Below 50-day average — medium-term weakness" });
  }

  // Price vs SMA 200 — weight 15
  if (params.sma200 !== null) {
    const dir: "bullish" | "bearish" = params.spot > params.sma200 ? "bullish" : "bearish";
    signals.push({ name: "Price vs SMA 200", signal: dir, weight: 15, value: `${params.spot.toFixed(2)} vs ${params.sma200.toFixed(2)}`, note: dir === "bullish" ? "Above 200-day average — secular uptrend" : "Below 200-day average — secular downtrend" });
  }

  // SMA 20 vs SMA 50 alignment (golden/death cross) — weight 10
  if (params.sma20 !== null && params.sma50 !== null) {
    const dir: "bullish" | "bearish" = params.sma20 > params.sma50 ? "bullish" : "bearish";
    signals.push({ name: "SMA Alignment", signal: dir, weight: 10, value: `SMA20 ${params.sma20.toFixed(2)} / SMA50 ${params.sma50.toFixed(2)}`, note: dir === "bullish" ? "Short-term above medium-term (golden alignment)" : "Short-term below medium-term (death-cross alignment)" });
  }

  // Bollinger Band position — weight 10
  if (params.bollingerUpper !== null && params.bollingerLower !== null) {
    const range = params.bollingerUpper - params.bollingerLower;
    if (range > 0) {
      const pct = (params.spot - params.bollingerLower) / range;
      if (pct < 0.15)
        signals.push({ name: "Bollinger Position", signal: "bullish", weight: 10, value: `${(pct * 100).toFixed(0)}% of band`, note: "Near lower band — oversold within range" });
      else if (pct > 0.85)
        signals.push({ name: "Bollinger Position", signal: "bearish", weight: 10, value: `${(pct * 100).toFixed(0)}% of band`, note: "Near upper band — extended, mean-reversion risk" });
      else
        signals.push({ name: "Bollinger Position", signal: "neutral", weight: 0, value: `${(pct * 100).toFixed(0)}% of band`, note: "Mid-band — no directional edge" });
    }
  }

  // Volume confirmation — weight 10
  if (params.volumeRatio !== null && params.dayChange !== null) {
    if (params.volumeRatio > 1.3 && params.dayChange > 0)
      signals.push({ name: "Volume", signal: "bullish", weight: 10, value: `${params.volumeRatio.toFixed(2)}x avg`, note: "Above-average volume on up day — institutional conviction" });
    else if (params.volumeRatio > 1.3 && params.dayChange < 0)
      signals.push({ name: "Volume", signal: "bearish", weight: 10, value: `${params.volumeRatio.toFixed(2)}x avg`, note: "Above-average volume on down day — distribution pressure" });
    else
      signals.push({ name: "Volume", signal: "neutral", weight: 0, value: `${params.volumeRatio.toFixed(2)}x avg`, note: "Average volume — no directional confirmation" });
  }

  // Aggregate
  let weightedSum = 0, maxWeight = 0;
  let bullishCount = 0, bearishCount = 0, neutralCount = 0;
  for (const s of signals) {
    if (s.signal === "bullish") { weightedSum += s.weight; bullishCount++; }
    else if (s.signal === "bearish") { weightedSum -= s.weight; bearishCount++; }
    else { neutralCount++; }
    maxWeight += s.weight;
  }
  const score = maxWeight > 0 ? Math.round((weightedSum / maxWeight) * 100) : 0;
  const direction: "bullish" | "bearish" | "neutral" = score >= 20 ? "bullish" : score <= -20 ? "bearish" : "neutral";
  return { direction, score, bullishCount, bearishCount, neutralCount, signals };
}

// ─── Dynamic research context builder ────────────────────────────────────────
// Extracts every piece of live fundamental, analyst, and news data available
// from Yahoo Finance and formats it as a structured text block for the Gemini
// prompt. All fields are optional — missing data is silently omitted so the
// prompt stays clean regardless of what Yahoo returns.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildResearchContext(summaryData: any, newsItems: any[]): string {
  const fd  = summaryData?.financialData;
  const ks  = summaryData?.defaultKeyStatistics;
  const sd  = summaryData?.summaryDetail;
  const cal = summaryData?.calendarEvents;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const upgrades: any[] = summaryData?.upgradeDowngradeHistory?.history || [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recTrend: any[] = summaryData?.recommendationTrend?.trend || [];

  const sections: string[] = [];

  // ── Analyst consensus ────────────────────────────────────────────────────────
  const consensusParts: string[] = [];
  if (fd?.recommendationKey)
    consensusParts.push(`Consensus: ${fd.recommendationKey.replace(/_/g, " ").toUpperCase()}`);
  if (fd?.numberOfAnalystOpinions)
    consensusParts.push(`Analysts covering: ${fd.numberOfAnalystOpinions}`);
  if (fd?.targetMeanPrice)
    consensusParts.push(`Mean price target: ${fd.targetMeanPrice.toFixed(2)}`);
  if (fd?.targetLowPrice && fd?.targetHighPrice)
    consensusParts.push(`Target range: ${fd.targetLowPrice.toFixed(2)} – ${fd.targetHighPrice.toFixed(2)}`);
  if (consensusParts.length)
    sections.push(`ANALYST CONSENSUS\n${consensusParts.map(p => `  ${p}`).join("\n")}`);

  // ── Recommendation trend (current month breakdown) ───────────────────────────
  const cm = recTrend.find((t) => t.period === "0m");
  if (cm) {
    sections.push(
      `RECOMMENDATION TREND (current month)\n` +
      `  Strong Buy: ${cm.strongBuy}  Buy: ${cm.buy}  Hold: ${cm.hold}  Sell: ${cm.sell}  Strong Sell: ${cm.strongSell}`
    );
  }

  // ── Upcoming earnings ────────────────────────────────────────────────────────
  const nextEarningsRaw = cal?.earnings?.earningsDate?.[0];
  if (nextEarningsRaw) {
    const d = new Date(typeof nextEarningsRaw === "number" ? nextEarningsRaw * 1000 : nextEarningsRaw);
    const daysAway = Math.round((d.getTime() - Date.now()) / 86_400_000);
    const when = daysAway > 0 ? `in ${daysAway} days` : daysAway === 0 ? "TODAY" : `${Math.abs(daysAway)} days ago`;
    sections.push(`UPCOMING EARNINGS\n  ${d.toDateString()} (${when})`);
  }

  // ── Valuation ────────────────────────────────────────────────────────────────
  const valParts: string[] = [];
  if (sd?.trailingPE)    valParts.push(`P/E (TTM): ${sd.trailingPE.toFixed(1)}`);
  if (ks?.forwardPE)     valParts.push(`P/E (Fwd): ${ks.forwardPE.toFixed(1)}`);
  if (ks?.pegRatio)      valParts.push(`PEG: ${ks.pegRatio.toFixed(2)}`);
  if (ks?.priceToBook)   valParts.push(`P/B: ${ks.priceToBook.toFixed(2)}`);
  if (valParts.length)
    sections.push(`VALUATION\n${valParts.map(p => `  ${p}`).join("\n")}`);

  // ── Fundamental quality ──────────────────────────────────────────────────────
  const fundParts: string[] = [];
  if (fd?.revenueGrowth   != null) fundParts.push(`Revenue growth (YoY): ${(fd.revenueGrowth * 100).toFixed(1)}%`);
  if (fd?.earningsGrowth  != null) fundParts.push(`Earnings growth (YoY): ${(fd.earningsGrowth * 100).toFixed(1)}%`);
  if (fd?.grossMargins    != null) fundParts.push(`Gross margin: ${(fd.grossMargins * 100).toFixed(1)}%`);
  if (fd?.ebitdaMargins   != null) fundParts.push(`EBITDA margin: ${(fd.ebitdaMargins * 100).toFixed(1)}%`);
  if (fd?.returnOnEquity  != null) fundParts.push(`ROE: ${(fd.returnOnEquity * 100).toFixed(1)}%`);
  if (fd?.returnOnAssets  != null) fundParts.push(`ROA: ${(fd.returnOnAssets * 100).toFixed(1)}%`);
  if (fd?.freeCashflow    != null) fundParts.push(`Free cash flow: ${(fd.freeCashflow / 1e9).toFixed(2)}B`);
  if (fd?.debtToEquity    != null) fundParts.push(`Debt/Equity: ${fd.debtToEquity.toFixed(2)}`);
  if (fd?.currentRatio    != null) fundParts.push(`Current ratio: ${fd.currentRatio.toFixed(2)}`);
  if (fundParts.length)
    sections.push(`FUNDAMENTALS\n${fundParts.map(p => `  ${p}`).join("\n")}`);

  // ── Short interest ───────────────────────────────────────────────────────────
  const shortParts: string[] = [];
  if (ks?.shortRatio           != null) shortParts.push(`Days to cover: ${ks.shortRatio.toFixed(1)}`);
  if (ks?.shortPercentOfFloat  != null) shortParts.push(`Short % of float: ${(ks.shortPercentOfFloat * 100).toFixed(1)}%`);
  if (ks?.sharesShortPriorMonth != null && ks?.sharesShort != null) {
    const chg = ((ks.sharesShort - ks.sharesShortPriorMonth) / ks.sharesShortPriorMonth) * 100;
    shortParts.push(`Short interest change MoM: ${chg > 0 ? "+" : ""}${chg.toFixed(1)}%`);
  }
  if (shortParts.length)
    sections.push(`SHORT INTEREST\n${shortParts.map(p => `  ${p}`).join("\n")}`);

  // ── Recent analyst upgrades/downgrades (last 5) ──────────────────────────────
  const recentActions = upgrades.slice(0, 5);
  if (recentActions.length) {
    const rows = recentActions.map((u) => {
      const d = new Date(u.epochGradeDate * 1000);
      const daysAgo = Math.round((Date.now() - d.getTime()) / 86_400_000);
      const change = u.fromGrade ? `${u.fromGrade} → ${u.toGrade}` : u.toGrade;
      return `  ${u.firm}: ${u.action?.toUpperCase()} ${change} (${daysAgo}d ago)`;
    });
    sections.push(`RECENT ANALYST ACTIONS\n${rows.join("\n")}`);
  }

  // ── News (with publisher and age) ────────────────────────────────────────────
  if (newsItems.length) {
    const rows = newsItems.map((n, i) => {
      const ageSecs = n.providerPublishTime
        ? Math.round(Date.now() / 1000 - n.providerPublishTime)
        : null;
      const ageLabel = ageSecs != null
        ? ageSecs < 3600 ? `${Math.round(ageSecs / 60)}m ago`
          : ageSecs < 86400 ? `${Math.round(ageSecs / 3600)}h ago`
          : `${Math.round(ageSecs / 86400)}d ago`
        : "recent";
      const source = n.publisher ? ` — ${n.publisher}` : "";
      return `  ${i + 1}. [${ageLabel}] ${n.title}${source}`;
    });
    sections.push(`RECENT NEWS\n${rows.join("\n")}`);
  } else {
    sections.push("RECENT NEWS\n  No recent news available");
  }

  return sections.join("\n\n");
}

// ─── Risk-free rate (live 13-week T-bill yield, cached) ───────────────────────

let riskFreeRateCache: { value: number; fetchedAt: number } | null = null;
const RISK_FREE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getRiskFreeRate(): Promise<number> {
  const now = Date.now();
  if (riskFreeRateCache && now - riskFreeRateCache.fetchedAt < RISK_FREE_CACHE_TTL_MS) {
    return riskFreeRateCache.value;
  }
  try {
    // ^IRX = 13-week Treasury bill discount rate, quoted as e.g. 5.25 meaning 5.25%.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = (await (yahooFinance as any).quote("^IRX")) as any;
    const pct = q?.regularMarketPrice;
    if (typeof pct === "number" && pct > 0 && pct < 25) {
      const rate = pct / 100;
      riskFreeRateCache = { value: rate, fetchedAt: now };
      return rate;
    }
  } catch {
    // fall through to fallback
  }
  riskFreeRateCache = { value: FALLBACK_RISK_FREE_RATE, fetchedAt: now };
  return FALLBACK_RISK_FREE_RATE;
}

// ─── Gemini client ────────────────────────────────────────────────────────────

function getGemini() {
  const key = process.env["GEMINI_API_KEY"];
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return new GoogleGenerativeAI(key);
}

// ─── GET /finance/analysis/:symbol ────────────────────────────────────────────

router.get("/finance/analysis/:symbol", async (req, res): Promise<void> => {
  const symbol = (req.params.symbol || "").toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: "Symbol is required" });
    return;
  }

  try {
    const now = new Date();
    const threeMonthsAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    const [quote, history, summary, newsResult, optionsData, riskFreeRate] =
      await Promise.allSettled([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (yahooFinance as any).quote(symbol) as Promise<any>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (yahooFinance as any).chart(symbol, {
          period1: threeMonthsAgo,
          period2: now,
          interval: "1d",
        }) as Promise<any>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (yahooFinance as any).quoteSummary(symbol, {
          modules: [
            "summaryDetail",
            "defaultKeyStatistics",
            "financialData",
            "calendarEvents",
            "upgradeDowngradeHistory",
            "recommendationTrend",
          ],
        }) as Promise<any>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (yahooFinance as any).search(symbol, {
          newsCount: 6,
          quotesCount: 0,
        }) as Promise<any>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (yahooFinance as any).options(symbol) as Promise<any>,
        getRiskFreeRate(),
      ]);

    if (quote.status === "rejected") {
      res.status(404).json({ error: `Symbol not found: ${symbol}` });
      return;
    }

    const q = quote.value;
    const spot: number = q.regularMarketPrice ?? 0;
    const r = riskFreeRate.status === "fulfilled" ? riskFreeRate.value : FALLBACK_RISK_FREE_RATE;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const histQuotes: any[] =
      history.status === "fulfilled" ? history.value?.quotes || [] : [];

    const closes = histQuotes.map((p: any) => p.close).filter(Boolean) as number[];
    const highs = histQuotes.map((p: any) => p.high).filter(Boolean) as number[];
    const lows = histQuotes.map((p: any) => p.low).filter(Boolean) as number[];
    const volumes = histQuotes.map((p: any) => p.volume).filter(Boolean) as number[];

    // ── Technical indicators
    const rsi = calcRSI(closes);
    const { macd, signal: macdSignal, histogram: macdHistogram } = calcMACD(closes);
    const bb = calcBollinger(closes);
    const sma20 = calcSMA(closes, 20);
    const sma50 = calcSMA(closes, 50);
    const sma200 = calcSMA(closes, 200);
    const atr = calcATR(highs, lows, closes);
    const avgVol = volumes.length
      ? volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(volumes.length, 20)
      : null;
    const volumeRatio =
      avgVol && q.regularMarketVolume ? q.regularMarketVolume / avgVol : null;

    const technicalIndicators = {
      rsi: rsi ? +rsi.toFixed(2) : null,
      macd: macd ? +macd.toFixed(4) : null,
      macdSignal: macdSignal ? +macdSignal.toFixed(4) : null,
      macdHistogram: macdHistogram ? +macdHistogram.toFixed(4) : null,
      bollingerUpper: bb.upper ? +bb.upper.toFixed(2) : null,
      bollingerMiddle: bb.middle ? +bb.middle.toFixed(2) : null,
      bollingerLower: bb.lower ? +bb.lower.toFixed(2) : null,
      sma20: sma20 ? +sma20.toFixed(2) : null,
      sma50: sma50 ? +sma50.toFixed(2) : null,
      sma200: sma200 ? +sma200.toFixed(2) : null,
      atr: atr ? +atr.toFixed(2) : null,
      volumeRatio: volumeRatio ? +volumeRatio.toFixed(2) : null,
    };

    // ── Formula-based signal score (computed before AI, independent of LLM)
    const signalScore = computeSignalScore({
      spot,
      rsi,
      macd,
      macdSignal,
      macdHistogram,
      sma20,
      sma50,
      sma200,
      bollingerUpper: bb.upper,
      bollingerLower: bb.lower,
      volumeRatio,
      dayChange: q.regularMarketChange ?? null,
    });

    // ── Options chain summary (real market data only — no invented numbers)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let optChain: any = null;
    let putCallRatio: number | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rawCalls: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rawPuts: any[] = [];
    let expirationDate: Date | null = null;

    if (optionsData.status === "fulfilled" && optionsData.value?.options?.length) {
      const chain = optionsData.value.options[0];
      rawCalls = chain.calls || [];
      rawPuts = chain.puts || [];
      expirationDate = chain.expirationDate;
      const totalCallVol = rawCalls.reduce((s: number, c: any) => s + (c.volume || 0), 0);
      const totalPutVol = rawPuts.reduce((s: number, p: any) => s + (p.volume || 0), 0);
      putCallRatio = totalCallVol ? +(totalPutVol / totalCallVol).toFixed(2) : null;

      const topCalls = [...rawCalls].sort((a: any, b: any) => (b.volume || 0) - (a.volume || 0)).slice(0, 3);
      const topPuts = [...rawPuts].sort((a: any, b: any) => (b.volume || 0) - (a.volume || 0)).slice(0, 3);

      optChain = {
        expirationDate,
        topCalls: topCalls.map((c: any) => ({
          strike: c.strike,
          lastPrice: c.lastPrice,
          bid: c.bid,
          ask: c.ask,
          volume: c.volume,
          openInterest: c.openInterest,
          impliedVolatility: c.impliedVolatility ? +(c.impliedVolatility * 100).toFixed(1) : null,
          inTheMoney: c.inTheMoney,
        })),
        topPuts: topPuts.map((p: any) => ({
          strike: p.strike,
          lastPrice: p.lastPrice,
          bid: p.bid,
          ask: p.ask,
          volume: p.volume,
          openInterest: p.openInterest,
          impliedVolatility: p.impliedVolatility ? +(p.impliedVolatility * 100).toFixed(1) : null,
          inTheMoney: p.inTheMoney,
        })),
        putCallRatio,
      };
    }

    // ── News (rich — preserve publisher and publication timestamp)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newsItems: any[] =
      newsResult.status === "fulfilled"
        ? (newsResult.value?.news || []).slice(0, 6).filter(Boolean)
        : [];

    const summaryData = summary.status === "fulfilled" ? summary.value : null;

    // ── Build rich research context for Gemini ─────────────────────────────────
    const dynamicContext = buildResearchContext(summaryData, newsItems);

    // ── Build Gemini prompt — qualitative overlay ONLY.
    // The signal score (direction + confidence) is computed deterministically
    // from formulas above. Gemini's role is to add qualitative context that
    // formulas cannot: news, macro, sector, earnings risk, narrative.
    const prompt = `You are a professional quantitative analyst with 20+ years of experience. A rules-based algorithm has already scored the technical indicators below — your role is to provide the QUALITATIVE OVERLAY that formulas cannot capture: news context, macro environment, sector rotation, earnings risk, and non-quantitative factors.

CRITICAL INSTRUCTION: Do NOT simply echo the technical indicator readings in your direction call. Your direction and confidence should reflect your qualitative judgment that incorporates NEWS and MACRO CONTEXT. It is valid and expected to DISAGREE with the technical signal score when fundamentals or news warrant it — that disagreement is where your value lies. Do NOT invent precise dollar figures for options premiums or probabilities — those are computed from live market data separately.

═══ MARKET DATA ═══════════════════════════════════════════════════════════════
Symbol: ${symbol}
Price:  ${spot.toFixed(2)}  (${q.regularMarketChange?.toFixed(2) ?? "0"} / ${q.regularMarketChangePercent?.toFixed(2) ?? "0"}%)
Range:  Day ${q.regularMarketDayLow?.toFixed(2) ?? "?"} – ${q.regularMarketDayHigh?.toFixed(2) ?? "?"}  |  52W ${q.fiftyTwoWeekLow?.toFixed(2) ?? "?"} – ${q.fiftyTwoWeekHigh?.toFixed(2) ?? "?"}
Volume: ${(q.regularMarketVolume || 0).toLocaleString()} (${technicalIndicators.volumeRatio ?? "?"}x avg)
Cap:    ${q.marketCap ? (q.marketCap / 1e9).toFixed(2) + "B" : "N/A"}  |  Beta: ${summaryData?.summaryDetail?.beta?.toFixed(2) ?? "N/A"}  |  Market: ${q.marketState ?? "REGULAR"}

═══ FORMULA-BASED SIGNAL SCORE (computed before you — reference this) ══════════
Direction: ${signalScore.direction.toUpperCase()}  |  Score: ${signalScore.score > 0 ? "+" : ""}${signalScore.score} / 100  (${signalScore.bullishCount} bullish, ${signalScore.bearishCount} bearish, ${signalScore.neutralCount} neutral signals)
${signalScore.signals.map(s => `  ${s.signal.padEnd(7)} ${s.name.padEnd(20)} ${s.value}`).join("\n")}

═══ TECHNICAL INDICATORS ═══════════════════════════════════════════════════════
RSI(14):         ${technicalIndicators.rsi ?? "N/A"}${technicalIndicators.rsi !== null ? ` — ${technicalIndicators.rsi > 70 ? "OVERBOUGHT" : technicalIndicators.rsi < 30 ? "OVERSOLD" : "NEUTRAL"}` : ""}
MACD:            ${technicalIndicators.macd ?? "N/A"}  |  Signal: ${technicalIndicators.macdSignal ?? "N/A"}  |  Histogram: ${technicalIndicators.macdHistogram ?? "N/A"}
Bollinger Bands: Upper ${technicalIndicators.bollingerUpper ?? "?"}  |  Mid ${technicalIndicators.bollingerMiddle ?? "?"}  |  Lower ${technicalIndicators.bollingerLower ?? "?"}
Moving Averages: SMA20 ${technicalIndicators.sma20 ?? "N/A"}  |  SMA50 ${technicalIndicators.sma50 ?? "N/A"}  |  SMA200 ${technicalIndicators.sma200 ?? "N/A"}
ATR(14):         ${technicalIndicators.atr ?? "N/A"}

═══ OPTIONS FLOW (nearest expiry${optChain?.expirationDate ? ": " + new Date(optChain.expirationDate).toDateString() : ""}) ════════════════════════
${optChain
  ? `Put/Call Volume Ratio: ${optChain.putCallRatio ?? "N/A"}
Top Calls: ${optChain.topCalls.map((c: any) => `${c.strike} (IV ${c.impliedVolatility}%, vol ${c.volume}, OI ${c.openInterest})`).join(" | ")}
Top Puts:  ${optChain.topPuts.map((p: any) => `${p.strike} (IV ${p.impliedVolatility}%, vol ${p.volume}, OI ${p.openInterest})`).join(" | ")}`
  : "Options data unavailable"}

═══ LIVE RESEARCH CONTEXT ══════════════════════════════════════════════════════
${dynamicContext}

Return ONLY a valid JSON object with this exact structure (no markdown, no explanation outside JSON):
{
  "trend": {
    "direction": "bullish" | "bearish" | "neutral",
    "confidence": <integer 0-100, your qualitative conviction>,
    "summary": "<one sharp sentence>",
    "reasoning": "<2-3 sentences with specific data references>",
    "priceTargets": {
      "support": <number or null>,
      "resistance": <number or null>,
      "oneWeek": <number or null>,
      "oneMonth": <number or null>
    }
  },
  "intraday": {
    "bias": "bullish" | "bearish" | "neutral",
    "setup": "<specific intraday setup and what to watch for>",
    "keyLevels": [
      { "price": <number>, "type": "support" | "resistance" | "pivot", "significance": "<why this level matters>" }
    ],
    "topPick": <true | false>,
    "topPickReason": "<reason if topPick=true, else null>"
  },
  "optionsSnapshot": {
    "sentiment": "bullish" | "bearish" | "neutral",
    "unusualActivity": "<describe any notable flow or activity, qualitative only>",
    "topCallStrike": <strike price chosen from the calls list above, or null>,
    "topCallRationale": "<why this call, qualitative>",
    "topPutStrike": <strike price chosen from the puts list above, or null>,
    "topPutRationale": "<why this put, qualitative>"
  }
}`;

    const genAI = getGemini();
    const model = genAI.getGenerativeModel({
      model: "gemini-3.1-flash-lite",
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 8192,
      } as any,
    });

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    let aiOutput: any;
    try {
      aiOutput = JSON.parse(text);
    } catch {
      req.log.error({ text }, "Gemini returned invalid JSON");
      res.status(500).json({ error: "AI analysis returned invalid response" });
      return;
    }

    // ── Rebuild optionsSnapshot picks with REAL Black-Scholes numbers ──────────
    const T = expirationDate ? timeToExpiryYears(expirationDate, now) : null;
    const usedContracts: Array<{ label: string; volume?: number | null; openInterest?: number | null; bid?: number | null; ask?: number | null }> = [];

    function buildRealPick(strikeChoice: number | null | undefined, rationale: string | undefined, pool: any[], type: "call" | "put") {
      if (strikeChoice == null || !pool.length || T == null) return null;
      const contract = pool.reduce((best, c) => (Math.abs(c.strike - strikeChoice) < Math.abs(best.strike - strikeChoice) ? c : best), pool[0]);
      const iv = contract.impliedVolatility; // decimal from Yahoo
      const midPrice = contract.bid != null && contract.ask != null && contract.bid > 0 && contract.ask > 0
        ? (contract.bid + contract.ask) / 2
        : contract.lastPrice;
      const bs = iv > 0 ? blackScholes({ spot, strike: contract.strike, timeToExpiryYears: T, riskFreeRate: r, volatility: iv, optionType: type }) : null;
      usedContracts.push({ label: `${type.toUpperCase()} $${contract.strike}`, volume: contract.volume, openInterest: contract.openInterest, bid: contract.bid, ask: contract.ask });
      return {
        strike: contract.strike,
        expiry: expirationDate ? new Date(expirationDate).toDateString() : "",
        premium: midPrice != null ? +midPrice.toFixed(2) : null,
        rationale: rationale || "",
        impliedVolatility: iv ? +(iv * 100).toFixed(1) : null,
        delta: bs ? bs.delta : null,
        theoreticalPrice: bs ? bs.theoreticalPrice : null,
        probabilityITM: bs ? bs.probabilityITM : null,
      };
    }

    const topCallPick = buildRealPick(aiOutput.optionsSnapshot?.topCallStrike, aiOutput.optionsSnapshot?.topCallRationale, rawCalls, "call");
    const topPutPick = buildRealPick(aiOutput.optionsSnapshot?.topPutStrike, aiOutput.optionsSnapshot?.topPutRationale, rawPuts, "put");

    const optionsSnapshot = optChain
      ? {
          sentiment: aiOutput.optionsSnapshot?.sentiment ?? "neutral",
          putCallRatio,
          unusualActivity: aiOutput.optionsSnapshot?.unusualActivity ?? "",
          topCallPick,
          topPutPick,
        }
      : null;

    const dataQuality = assessDataQuality({
      quoteTimeMs: q.regularMarketTime ? new Date(q.regularMarketTime).getTime() : null,
      now,
      contracts: usedContracts,
    });
    (dataQuality as any).riskFreeRate = +(r * 100).toFixed(2);

    res.json({
      symbol,
      generatedAt: new Date().toISOString(),
      signalScore,
      trend: aiOutput.trend,
      intraday: aiOutput.intraday,
      technicalIndicators,
      optionsSnapshot,
      dataQuality,
    });
  } catch (err: unknown) {
    req.log.error({ err, symbol }, "Analysis error");
    res.status(500).json({ error: "Failed to generate analysis" });
  }
});

// ─── POST /finance/options-strategy/:symbol ───────────────────────────────────

router.post(
  "/finance/options-strategy/:symbol",
  async (req, res): Promise<void> => {
    const symbol = (req.params.symbol || "").toUpperCase();
    const { investmentAmount } = req.body || {};

    if (!symbol) {
      res.status(400).json({ error: "Symbol is required" });
      return;
    }
    if (!investmentAmount || typeof investmentAmount !== "number" || investmentAmount <= 0) {
      res.status(400).json({ error: "investmentAmount must be a positive number" });
      return;
    }

    try {
      const now = new Date();
      const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const [quote, history, optionsData, riskFreeRate] = await Promise.allSettled([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (yahooFinance as any).quote(symbol) as Promise<any>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (yahooFinance as any).chart(symbol, {
          period1: monthAgo,
          period2: now,
          interval: "1d",
        }) as Promise<any>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (yahooFinance as any).options(symbol) as Promise<any>,
        getRiskFreeRate(),
      ]);

      if (quote.status === "rejected") {
        res.status(404).json({ error: `Symbol not found: ${symbol}` });
        return;
      }

      const q = quote.value;
      const currentPrice: number = q.regularMarketPrice ?? 0;
      const r = riskFreeRate.status === "fulfilled" ? riskFreeRate.value : FALLBACK_RISK_FREE_RATE;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const histQuotes: any[] =
        history.status === "fulfilled" ? history.value?.quotes || [] : [];
      const closes = histQuotes.map((p: any) => p.close).filter(Boolean) as number[];
      const highs = histQuotes.map((p: any) => p.high).filter(Boolean) as number[];
      const lows = histQuotes.map((p: any) => p.low).filter(Boolean) as number[];

      const rsi = calcRSI(closes);
      const { macd, histogram } = calcMACD(closes);
      const atr = calcATR(highs, lows, closes);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let allChains: any[] = [];
      if (optionsData.status === "fulfilled" && optionsData.value?.options?.length) {
        allChains = optionsData.value.options.slice(0, 3);
      }

      const chainSummary = allChains.map((chain: any) => {
        const expDate = new Date(chain.expirationDate).toDateString();
        const calls: any[] = (chain.calls || [])
          .filter((c: any) => c.volume > 0)
          .sort((a: any, b: any) => (b.openInterest || 0) - (a.openInterest || 0))
          .slice(0, 5);
        const puts: any[] = (chain.puts || [])
          .filter((p: any) => p.volume > 0)
          .sort((a: any, b: any) => (b.openInterest || 0) - (a.openInterest || 0))
          .slice(0, 5);

        return `Expiry: ${expDate}
  Calls: ${calls.map((c: any) => `$${c.strike} IV=${c.impliedVolatility ? (c.impliedVolatility * 100).toFixed(0) : "?"}% OI=${c.openInterest} vol=${c.volume}`).join(" | ")}
  Puts:  ${puts.map((p: any) => `$${p.strike} IV=${p.impliedVolatility ? (p.impliedVolatility * 100).toFixed(0) : "?"}% OI=${p.openInterest} vol=${p.volume}`).join(" | ")}`;
      });

      const prompt = `You are an elite options strategist. A trader wants to deploy capital in ${symbol} options. Choose the STRUCTURE of the best strategy (which strikes/expiries/legs, buy or sell, relative contract ratios) — you do NOT need to calculate premiums, cost, max profit/loss, breakeven, or probability; those will be computed precisely from live market data afterward. Focus your judgement on strategy selection and reasoning.

STOCK DATA:
Symbol: ${symbol}
Current Price: $${currentPrice.toFixed(2)}
Change Today: ${q.regularMarketChange?.toFixed(2) ?? "0"} (${q.regularMarketChangePercent?.toFixed(2) ?? "0"}%)
52W Range: $${q.fiftyTwoWeekLow?.toFixed(2) ?? "?"} – $${q.fiftyTwoWeekHigh?.toFixed(2) ?? "?"}
RSI(14): ${rsi?.toFixed(1) ?? "N/A"}
MACD: ${macd?.toFixed(3) ?? "N/A"} | Histogram: ${histogram?.toFixed(3) ?? "N/A"}
ATR(14): $${atr?.toFixed(2) ?? "N/A"}

AVAILABLE OPTIONS CHAINS (choose strikes/expiries ONLY from these):
${chainSummary.length ? chainSummary.join("\n\n") : "No options data available"}

TRADER'S CAPITAL: $${investmentAmount.toLocaleString()}

Design ONE strategy from: Long Call, Long Put, Bull Call Spread, Bear Put Spread, Iron Condor, Straddle, Strangle, Covered Call, Cash-Secured Put, or Butterfly Spread. Prefer defined-risk strategies unless capital > $10,000.

Return ONLY valid JSON (no markdown):
{
  "strategyName": "<strategy name>",
  "strategyType": "bullish" | "bearish" | "neutral" | "volatile",
  "legs": [
    {
      "type": "call" | "put" | "stock",
      "action": "buy" | "sell",
      "strike": <number or null, must match an available strike for options>,
      "expiry": "<date string matching one of the available expiries, or null for stock>",
      "contractRatio": <integer, relative ratio of this leg vs other legs, e.g. 1 for most strategies, 2 for a ratio spread>
    }
  ],
  "riskLevel": "low" | "medium" | "high",
  "reasoning": "<3-4 sentences: why this strategy, why these strikes/expiry, what's the catalyst>",
  "entryTiming": "<specific entry conditions and timing>",
  "exitStrategy": "<take profit target, stop loss, and time decay management>"
}`;

      const genAI = getGemini();
      const model = genAI.getGenerativeModel({
        model: "gemini-3.1-flash-lite",
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: 8192,
        } as any,
      });

      const result = await model.generateContent(prompt);
      const text = result.response.text();

      let aiOutput: any;
      try {
        aiOutput = JSON.parse(text);
      } catch {
        req.log.error({ text }, "Gemini returned invalid JSON for options strategy");
        res.status(500).json({ error: "AI strategy returned invalid response" });
        return;
      }

      const aiLegs: any[] = Array.isArray(aiOutput.legs) ? aiOutput.legs : [];
      if (!aiLegs.length) {
        res.status(500).json({ error: "AI did not return a valid strategy structure" });
        return;
      }

      // ── Resolve each leg to a REAL contract from the fetched chain ────────────
      const usedContracts: Array<{ label: string; volume?: number | null; openInterest?: number | null; bid?: number | null; ask?: number | null }> = [];
      const resolvedLegs: (PayoffLeg & { impliedVolatility?: number | null; delta?: number | null; theoreticalPrice?: number | null; expiryDate?: Date })[] = [];
      let earliestExpiry: Date | null = null;
      const ivSamples: number[] = [];

      for (const leg of aiLegs) {
        const ratio = Math.max(1, Math.round(leg.contractRatio ?? 1));
        if (leg.type === "stock") {
          resolvedLegs.push({ type: "stock", action: leg.action === "sell" ? "sell" : "buy", premium: currentPrice, contracts: ratio * 100 });
          continue;
        }

        const chain = allChains.find((c: any) => new Date(c.expirationDate).toDateString() === leg.expiry) ?? allChains[0];
        if (!chain) continue;
        const pool: any[] = leg.type === "put" ? chain.puts || [] : chain.calls || [];
        if (!pool.length) continue;

        const targetStrike = typeof leg.strike === "number" ? leg.strike : pool[0].strike;
        const contract = pool.reduce((best: any, c: any) => (Math.abs(c.strike - targetStrike) < Math.abs(best.strike - targetStrike) ? c : best), pool[0]);

        const midPrice = contract.bid != null && contract.ask != null && contract.bid > 0 && contract.ask > 0
          ? (contract.bid + contract.ask) / 2
          : contract.lastPrice;
        const expiryDate = new Date(chain.expirationDate);
        if (!earliestExpiry || expiryDate < earliestExpiry) earliestExpiry = expiryDate;

        const T = timeToExpiryYears(expiryDate, now);
        const iv = contract.impliedVolatility;
        if (iv > 0) ivSamples.push(iv);
        const bs = iv > 0 ? blackScholes({ spot: currentPrice, strike: contract.strike, timeToExpiryYears: T, riskFreeRate: r, volatility: iv, optionType: leg.type === "put" ? "put" : "call" }) : null;

        usedContracts.push({ label: `${leg.type.toUpperCase()} $${contract.strike}`, volume: contract.volume, openInterest: contract.openInterest, bid: contract.bid, ask: contract.ask });

        resolvedLegs.push({
          type: leg.type === "put" ? "put" : "call",
          action: leg.action === "sell" ? "sell" : "buy",
          strike: contract.strike,
          premium: midPrice != null ? +midPrice.toFixed(2) : 0,
          contracts: ratio,
          impliedVolatility: iv ? +(iv * 100).toFixed(1) : null,
          delta: bs ? bs.delta : null,
          theoreticalPrice: bs ? bs.theoreticalPrice : null,
          expiryDate,
        });
      }

      if (!resolvedLegs.length) {
        res.status(500).json({ error: "Could not resolve strategy legs against live options data" });
        return;
      }

      // ── Determine scale (# of contracts) to fit the investment budget ─────────
      const unitMetrics = computeStrategyMetrics({
        legs: resolvedLegs,
        spot: currentPrice,
        avgVolatility: ivSamples.length ? ivSamples.reduce((a, b) => a + b, 0) / ivSamples.length : 0.3,
        timeToExpiryYears: earliestExpiry ? timeToExpiryYears(earliestExpiry, now) : 30 / 365,
        riskFreeRate: r,
      });

      // Capital required to open ONE unit of this structure: a debit strategy
      // requires its net cost; a credit strategy requires margin approximately
      // equal to its max loss; an uncapped-risk structure has no well-defined
      // capital requirement at all (flagged, never silently forced to fit).
      let requiredCapitalPerUnit: number;
      let unlimitedRiskWarning: string | null = null;
      if (unitMetrics.netCost > 0) {
        requiredCapitalPerUnit = unitMetrics.netCost;
      } else if (typeof unitMetrics.maxLoss === "number") {
        requiredCapitalPerUnit = Math.abs(unitMetrics.maxLoss);
      } else {
        requiredCapitalPerUnit = Infinity;
        unlimitedRiskWarning =
          "This strategy has undefined (unlimited) risk. Position sized to the minimum 1 contract as a safeguard — actual capital at risk is NOT bounded by your stated investment amount and depends on your broker's margin requirements.";
      }

      let multiplier: number;
      if (!isFinite(requiredCapitalPerUnit)) {
        multiplier = 1;
      } else if (requiredCapitalPerUnit > investmentAmount) {
        res.status(422).json({
          error: "The " + (aiOutput.strategyName ?? "selected strategy") + " requires at least $" + requiredCapitalPerUnit.toLocaleString(undefined, { maximumFractionDigits: 2 }) + " of capital per contract, which exceeds your $" + investmentAmount.toLocaleString() + " budget. Try a larger amount or ask for a narrower spread.",
        });
        return;
      } else {
        multiplier = Math.max(1, Math.floor(investmentAmount / requiredCapitalPerUnit));
      }
      multiplier = Math.min(multiplier, 500); // sanity cap

      const scaledLegs = resolvedLegs.map((leg) => ({ ...leg, contracts: leg.contracts * multiplier }));

      const finalMetrics = computeStrategyMetrics({
        legs: scaledLegs,
        spot: currentPrice,
        avgVolatility: ivSamples.length ? ivSamples.reduce((a, b) => a + b, 0) / ivSamples.length : 0.3,
        timeToExpiryYears: earliestExpiry ? timeToExpiryYears(earliestExpiry, now) : 30 / 365,
        riskFreeRate: r,
      });

      const dataQuality = assessDataQuality({
        quoteTimeMs: q.regularMarketTime ? new Date(q.regularMarketTime).getTime() : null,
        now,
        contracts: usedContracts,
      });
      (dataQuality as any).riskFreeRate = +(r * 100).toFixed(2);
      if (unlimitedRiskWarning) dataQuality.liquidityWarnings.push(unlimitedRiskWarning);

      const formatMoney = (v: number | "unlimited") => (v === "unlimited" ? "Unlimited" : `$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}${v < 0 ? " (loss)" : ""}`);

      res.json({
        symbol,
        investmentAmount,
        strategyName: aiOutput.strategyName ?? "Custom Strategy",
        strategyType: aiOutput.strategyType ?? "neutral",
        legs: scaledLegs.map((leg) => ({
          type: leg.type,
          action: leg.action,
          strike: leg.strike ?? null,
          expiry: (leg as any).expiryDate ? (leg as any).expiryDate.toDateString() : null,
          premium: leg.premium ?? null,
          contracts: leg.contracts,
          impliedVolatility: (leg as any).impliedVolatility ?? null,
          delta: (leg as any).delta ?? null,
          theoreticalPrice: (leg as any).theoreticalPrice ?? null,
        })),
        totalCost: finalMetrics.netCost,
        maxProfit: formatMoney(finalMetrics.maxProfit),
        maxLoss: formatMoney(finalMetrics.maxLoss),
        breakeven: finalMetrics.breakevens.length ? finalMetrics.breakevens.map((b) => `$${b.toFixed(2)}`).join(" / ") : "N/A",
        breakevens: finalMetrics.breakevens,
        probability: finalMetrics.probabilityOfProfit ?? 50,
        probabilityMethod: "Black-Scholes risk-neutral lognormal distribution using live implied volatility",
        riskLevel: aiOutput.riskLevel ?? "medium",
        reasoning: aiOutput.reasoning ?? "",
        entryTiming: aiOutput.entryTiming ?? "",
        exitStrategy: aiOutput.exitStrategy ?? "",
        dataQuality,
      });
    } catch (err: unknown) {
      req.log.error({ err, symbol }, "Options strategy error");
      res.status(500).json({ error: "Failed to generate options strategy" });
    }
  },
);

export default router;
