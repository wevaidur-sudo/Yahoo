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
import {
  parseYahooBars,
  computeIntradayLevels,
  getMarketHours,
  getMarketState,
  getETOffset,
  type IntradayLevels,
} from "../lib/intraday";
import {
  computeIntradaySignals,
  generateTradeSetup,
  applyPredictiveSignals,
  type IntradaySignalScore,
  type PredictiveSignalInput,
} from "../lib/intraday-signals";
import { computePreMarketIntelligence } from "../lib/pre-market-intelligence";
import { analyzeOptionsFlow }           from "../lib/options-flow";
import { getMarketRegime }              from "../lib/market-regime";
import { scoreNewsSentiment }           from "../lib/news-sentiment";
import { mlPredict, recordPrediction, type MLFeatures } from "../lib/ml-predictor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yahooFinance = new (YahooFinance as any)({ suppressNotices: ["yahooSurvey"] });

const router: IRouter = Router();

// ─── Resilience helpers ───────────────────────────────────────────────────────

/**
 * Wraps a promise factory in a hard wall-clock timeout.
 * If the inner promise doesn't settle within `ms`, rejects with a timeout error.
 */
function withTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Yahoo Finance call timed out after ${ms}ms`)), ms);
    fn().then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Retries a thunk up to `maxRetries` times with exponential back-off.
 * Designed for transient Yahoo Finance 429 / connection-reset errors.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 1,
  baseDelayMs = 500,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt));
    }
  }
  throw lastErr;
}

// ─── Cost model constants ─────────────────────────────────────────────────────
// Schwab / TD Ameritrade / E*TRADE standard rate. Used for every options leg.
const COMMISSION_PER_CONTRACT = 0.65; // USD per contract, per leg, one-way

// ─── Technical Indicator Helpers (reused for intraday bar computation) ─────────

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

/** Wilder RSI — same implementation as Bloomberg / TradingView. */
function calcRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  const changes: number[] = [];
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcMACD(closes: number[]): {
  macd: number | null;
  signal: number | null;
  histogram: number | null;
} {
  if (closes.length < 34) return { macd: null, signal: null, histogram: null };
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine: number[] = ema12.map((v, i) => (isNaN(v) || isNaN(ema26[i]) ? NaN : v - ema26[i]));
  const validMacd = macdLine.filter((v) => !isNaN(v));
  if (validMacd.length < 9) return { macd: null, signal: null, histogram: null };
  const signalArr = calcEMA(validMacd, 9);
  const lastMacd = validMacd[validMacd.length - 1];
  const lastSignal = signalArr[signalArr.length - 1];
  if (isNaN(lastSignal)) return { macd: lastMacd, signal: null, histogram: null };
  return { macd: lastMacd, signal: lastSignal, histogram: lastMacd - lastSignal };
}

function calcATR(highs: number[], lows: number[], closes: number[], period = 14): number | null {
  if (highs.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── Risk-free rate (13-week T-bill, 1-hour cache) ─────────────────────────────

let riskFreeRateCache: { value: number; fetchedAt: number } | null = null;

async function getRiskFreeRate(): Promise<number> {
  const now = Date.now();
  if (riskFreeRateCache && now - riskFreeRateCache.fetchedAt < 60 * 60 * 1000) {
    return riskFreeRateCache.value;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = (await (yahooFinance as any).quote("^IRX")) as any;
    const pct = q?.regularMarketPrice;
    if (typeof pct === "number" && pct > 0 && pct < 25) {
      riskFreeRateCache = { value: pct / 100, fetchedAt: now };
      return pct / 100;
    }
  } catch { /* fall through */ }
  riskFreeRateCache = { value: FALLBACK_RISK_FREE_RATE, fetchedAt: now };
  return FALLBACK_RISK_FREE_RATE;
}

function getGemini() {
  const key = process.env["GEMINI_API_KEY"];
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return new GoogleGenerativeAI(key);
}

// ─── Intraday Gemini prompt ─────────────────────────────────────────────────────

function buildIntradayPrompt(params: {
  symbol: string;
  spot: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  q: any;
  signalScore: IntradaySignalScore;
  levels: IntradayLevels;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  newsItems: any[];
  marketState: string;
  sessionMinutes: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  optChain: any;
}): string {
  const { symbol, spot, q, signalScore, levels: l, newsItems, marketState, sessionMinutes, optChain } = params;

  const fmt    = (v: number | null, d = 2) => v != null ? `$${v.toFixed(d)}` : "N/A";
  const fmtPct = (v: number | null)        => v != null ? `${v > 0 ? "+" : ""}${v.toFixed(2)}%` : "N/A";

  const vwapPct = l.vwap != null ? ((spot - l.vwap) / l.vwap * 100) : null;
  const vwapPos = vwapPct != null
    ? (vwapPct > 0 ? `+${vwapPct.toFixed(2)}% above` : `${vwapPct.toFixed(2)}% below`)
    : "N/A";

  const orbStatus =
    l.orbBroken === "up"   ? "BROKEN UP ✓" :
    l.orbBroken === "down" ? "BROKEN DOWN ✓" :
    l.orbBroken === "none" ? "INTACT — no break" :
    "FORMING (inside 9:30–9:45 window)";

  const gapStr = l.gap != null && l.gapDirection !== "flat"
    ? `${l.gapDirection === "up" ? "▲" : "▼"} ${Math.abs(l.gap).toFixed(2)}% gap ${l.gapDirection} — ${l.gapFilled ? "FILLED" : "UNFILLED"}`
    : "Flat open (no meaningful gap)";

  const sessionStr = sessionMinutes > 0
    ? `${Math.floor(sessionMinutes / 60)}h ${sessionMinutes % 60}m into session`
    : marketState === "pre-market" ? "Pre-market" : "Session not yet open";

  const signalsSummary = signalScore.signals
    .map((s) => `  ${s.signal === "bullish" ? "▲" : s.signal === "bearish" ? "▼" : "─"} ${s.name.padEnd(24)} ${s.value}`)
    .join("\n");

  const newsStr = newsItems.length
    ? newsItems.map((n, i) => {
        const ageSecs = n.providerPublishTime ? Math.round(Date.now() / 1000 - n.providerPublishTime) : null;
        const age     = ageSecs != null
          ? (ageSecs < 3600 ? `${Math.round(ageSecs / 60)}m` : ageSecs < 86400 ? `${Math.round(ageSecs / 3600)}h` : `${Math.round(ageSecs / 86400)}d`) + " ago"
          : "recent";
        return `  ${i + 1}. [${age}] ${n.title}${n.publisher ? ` — ${n.publisher}` : ""}`;
      }).join("\n")
    : "  No recent news available";

  const optionsStr = optChain
    ? `Put/Call Ratio: ${optChain.putCallRatio ?? "N/A"}
Top Calls: ${optChain.topCalls.map((c: any) => `$${c.strike} (IV ${c.impliedVolatility}%, vol ${c.volume}, OI ${c.openInterest})`).join(" | ")}
Top Puts:  ${optChain.topPuts.map((p: any) => `$${p.strike} (IV ${p.impliedVolatility}%, vol ${p.volume}, OI ${p.openInterest})`).join(" | ")}`
    : "Options data unavailable";

  return `You are an elite intraday trader with 20+ years of prop desk experience. Your focus is EXCLUSIVELY on today's session. No multi-week forecasts, no P/E multiples, no analyst ratings — only what matters for today's price action.

═══ LIVE SESSION DATA ════════════════════════════════════════════════════════
Symbol:  ${symbol}
Price:   ${fmt(spot)}  (${(q.regularMarketChange ?? 0) > 0 ? "+" : ""}${(q.regularMarketChange ?? 0).toFixed(2)} / ${fmtPct(q.regularMarketChangePercent ?? null)})
Volume:  ${(q.regularMarketVolume || 0).toLocaleString()}${l.rvol != null ? `  (RVOL: ${l.rvol.toFixed(2)}x)` : ""}
State:   ${marketState.toUpperCase()}  |  ${sessionStr}
Day Range: ${fmt(q.regularMarketDayLow ?? null)} – ${fmt(q.regularMarketDayHigh ?? null)}

═══ INTRADAY KEY LEVELS ══════════════════════════════════════════════════════
VWAP:            ${fmt(l.vwap)}  [Price is ${vwapPos}]
VWAP +1σ / -1σ:  ${fmt(l.vwapUpper1)} / ${fmt(l.vwapLower1)}
VWAP +2σ / -2σ:  ${fmt(l.vwapUpper2)} / ${fmt(l.vwapLower2)}
Opening Range:   High ${fmt(l.orbHigh)} / Low ${fmt(l.orbLow)} / Range $${l.orbRange?.toFixed(2) ?? "N/A"}  [${orbStatus}]
Gap:             ${gapStr}
Pre-Market:      High ${fmt(l.preMarketHigh)} / Low ${fmt(l.preMarketLow)}
Previous Day:    High ${fmt(l.pdHigh)} / Low ${fmt(l.pdLow)} / Close ${fmt(l.pdClose)}
Session Open:    ${fmt(l.sessionOpen)}
Intraday ATR:    ${l.intradayAtr != null ? `$${l.intradayAtr.toFixed(2)}` : "N/A"}

═══ INTRADAY SIGNAL SCORE (deterministic — computed before you) ══════════════
Direction:  ${signalScore.direction.toUpperCase()}  |  Conviction: ${signalScore.conviction}/100
${signalScore.noTradeReason ? `⚠ NO-TRADE FLAG: ${signalScore.noTradeReason}\n` : ""}${signalsSummary}

═══ OPTIONS FLOW (nearest expiry) ════════════════════════════════════════════
${optionsStr}

═══ TODAY'S NEWS / CATALYSTS ═════════════════════════════════════════════════
${newsStr}

INSTRUCTIONS:
1. Your role is the QUALITATIVE overlay — formulas already scored the signals
2. Focus on catalysts, tape interpretation, and intraday level significance
3. Price targets MUST be intraday levels (not annual price targets)
4. If no clean setup exists, say so explicitly — protecting capital is valid
5. Do NOT invent probabilities, Greeks, or guaranteed outcomes

Return ONLY valid JSON (no markdown, no explanation outside JSON):
{
  "trend": {
    "direction": "bullish" | "bearish" | "neutral",
    "confidence": <integer 0-100, your qualitative intraday conviction>,
    "summary": "<one sharp sentence: today's session thesis>",
    "reasoning": "<2-3 sentences referencing specific intraday levels and catalysts>",
    "priceTargets": {
      "support": <nearest meaningful intraday support or null>,
      "resistance": <nearest meaningful intraday resistance or null>,
      "sessionTarget": <realistic intraday price target for today's session or null>
    }
  },
  "intraday": {
    "bias": "bullish" | "bearish" | "neutral",
    "setup": "<specific named setup with price levels: e.g. 'ORB breakout above $X targeting $Y, invalidated below $Z'>",
    "keyLevels": [
      { "price": <number>, "type": "support" | "resistance" | "pivot", "significance": "<why this level matters specifically today>" }
    ],
    "topPick": <true | false — high-conviction intraday setup?>,
    "topPickReason": "<if topPick=true: the specific edge — RVOL, clean level, catalyst. null otherwise>"
  },
  "optionsSnapshot": {
    "sentiment": "bullish" | "bearish" | "neutral",
    "unusualActivity": "<notable flow: elevated IV, unusual volume at a strike, large OI concentration>",
    "topCallStrike": <strike chosen from the provided chain, or null>,
    "topCallRationale": "<intraday rationale — why this call for today's session>",
    "topPutStrike": <strike from the provided chain, or null>,
    "topPutRationale": "<intraday rationale>"
  }
}`;
}

// ─── GET /finance/analysis/:symbol ────────────────────────────────────────────

router.get("/finance/analysis/:symbol", async (req, res): Promise<void> => {
  const symbol = (req.params.symbol || "").toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: "Symbol is required" });
    return;
  }

  try {
    const now          = new Date();
    const threeDaysAgo = new Date(now.getTime() -  3 * 24 * 60 * 60 * 1000);
    const tenDaysAgo   = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Fetch all data in parallel — 8 concurrent requests
    const [quote, minuteData, fiveMinData, fifteenMinData, dailyData, newsResult, optionsData, riskFreeRate] =
      await Promise.allSettled([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (yahooFinance as any).quote(symbol) as Promise<any>,
        // 1m bars — today + yesterday + one buffer day (pre-market included by Yahoo)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (yahooFinance as any).chart(symbol, { period1: threeDaysAgo, period2: now, interval: "1m" }) as Promise<any>,
        // 5m bars — 10 days for stable RSI-14
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (yahooFinance as any).chart(symbol, { period1: tenDaysAgo, period2: now, interval: "5m" }) as Promise<any>,
        // 15m bars — 10 days for RSI-14 + MACD(12,26,9)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (yahooFinance as any).chart(symbol, { period1: tenDaysAgo, period2: now, interval: "15m" }) as Promise<any>,
        // Daily bars — 30 days for PDH/PDL/PDC + ATR
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (yahooFinance as any).chart(symbol, { period1: thirtyDaysAgo, period2: now, interval: "1d" }) as Promise<any>,
        // News — catalyst context for the AI overlay
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (yahooFinance as any).search(symbol, { newsCount: 6, quotesCount: 0 }) as Promise<any>,
        // Options chain — nearest expiry
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (yahooFinance as any).options(symbol) as Promise<any>,
        getRiskFreeRate(),
      ]);

    if (quote.status === "rejected") {
      res.status(404).json({ error: `Symbol not found: ${symbol}` });
      return;
    }

    const q    = quote.value;
    const spot = (q.regularMarketPrice ?? 0) as number;
    const r    = riskFreeRate.status === "fulfilled" ? riskFreeRate.value : FALLBACK_RISK_FREE_RATE;

    // ── Parse bar data ─────────────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const getQuotes = (result: PromiseSettledResult<any>) =>
      result.status === "fulfilled" ? (result.value?.quotes ?? []) : [];

    const minuteBars     = parseYahooBars(getQuotes(minuteData));
    const fiveMinBars    = parseYahooBars(getQuotes(fiveMinData));
    const fifteenMinBars = parseYahooBars(getQuotes(fifteenMinData));
    const dailyBars      = parseYahooBars(getQuotes(dailyData));

    // Average daily volume from the quote object (most reliable source)
    const avgDailyVolume: number | null =
      q.averageDailyVolume3Month ?? q.averageDailyVolume10Day ?? q.averageVolume ?? null;

    // ── Intraday levels (deterministic) ───────────────────────────────────────
    const intradayLevels = computeIntradayLevels({ minuteBars, dailyBars, spot, avgDailyVolume, now });

    // ── Multi-timeframe RSI and MACD (on intraday closes) ─────────────────────
    const fiveMinCloses    = fiveMinBars.map((b) => b.close);
    const fifteenMinCloses = fifteenMinBars.map((b) => b.close);
    const rsi5m            = calcRSI(fiveMinCloses);
    const rsi15m           = calcRSI(fifteenMinCloses);
    const { histogram: macdHistogram15m } = calcMACD(fifteenMinCloses);

    // ── Intraday signal engine ────────────────────────────────────────────────
    const signalScore = computeIntradaySignals({
      spot, levels: intradayLevels,
      rsi5m, rsi15m, macdHistogram15m,
      dayChange: q.regularMarketChange ?? null,
    });

    // ── Trade setup generator ─────────────────────────────────────────────────
    const tradeSetup = generateTradeSetup({ spot, levels: intradayLevels, signalScore, now });

    // Hoist marketHours early — needed both for pre-market bar filtering below
    // and for the Gemini prompt / response later.
    const marketHours = getMarketHours(now);

    // ── News ──────────────────────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newsItems: any[] = newsResult.status === "fulfilled"
      ? (newsResult.value?.news ?? []).slice(0, 6).filter(Boolean)
      : [];

    // ── Options chain (nearest expiry) ────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let optChain: any = null;
    let putCallRatio: number | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rawCalls: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rawPuts:  any[] = [];
    let expirationDate: Date | null = null;

    if (optionsData.status === "fulfilled" && optionsData.value?.options?.length) {
      const chain  = optionsData.value.options[0];
      rawCalls     = chain.calls || [];
      rawPuts      = chain.puts  || [];
      expirationDate = chain.expirationDate;
      const totalCallVol = rawCalls.reduce((s: number, c: any) => s + (c.volume || 0), 0);
      const totalPutVol  = rawPuts.reduce((s: number, p: any)  => s + (p.volume || 0), 0);
      putCallRatio = totalCallVol ? +(totalPutVol / totalCallVol).toFixed(2) : null;

      const topCalls = [...rawCalls].sort((a: any, b: any) => (b.volume || 0) - (a.volume || 0)).slice(0, 3);
      const topPuts  = [...rawPuts].sort((a: any, b: any)  => (b.volume || 0) - (a.volume || 0)).slice(0, 3);

      optChain = {
        expirationDate,
        topCalls: topCalls.map((c: any) => ({
          strike: c.strike, lastPrice: c.lastPrice, bid: c.bid, ask: c.ask,
          volume: c.volume, openInterest: c.openInterest,
          impliedVolatility: c.impliedVolatility ? +(c.impliedVolatility * 100).toFixed(1) : null,
          inTheMoney: c.inTheMoney,
        })),
        topPuts: topPuts.map((p: any) => ({
          strike: p.strike, lastPrice: p.lastPrice, bid: p.bid, ask: p.ask,
          volume: p.volume, openInterest: p.openInterest,
          impliedVolatility: p.impliedVolatility ? +(p.impliedVolatility * 100).toFixed(1) : null,
          inTheMoney: p.inTheMoney,
        })),
        putCallRatio,
      };
    }

    // ── Predictive intelligence (5 leading indicators — fire BEFORE price confirms) ────
    const etHour        = ((now.getUTCHours() - getETOffset(now) + 24) % 24) + now.getUTCMinutes() / 60;
    const preMarketBars = minuteBars.filter(
      (b) => b.timestamp >= marketHours.preMarketStart && b.timestamp < marketHours.marketOpen,
    );

    const geminiApiKey = process.env["GEMINI_API_KEY"] ?? "";

    const [pmResult, optFlowResult, regimeResult, newsSentimentResult] = await Promise.allSettled([
      Promise.resolve(computePreMarketIntelligence({
        preMarketBars, pdClose: intradayLevels.pdClose, avgDailyVolume,
        earningsTs: q.earningsTimestamp != null ? (q.earningsTimestamp as number) * 1000 : null,
        now,
      })),
      Promise.resolve(analyzeOptionsFlow({ rawCalls, rawPuts, spot })),
      getMarketRegime(yahooFinance as Parameters<typeof getMarketRegime>[0]),
      scoreNewsSentiment({ symbol, spot, newsItems, quote: q, geminiApiKey }),
    ]);

    const pmIntel      = pmResult.status           === "fulfilled" ? pmResult.value          : null;
    const optFlowIntel = optFlowResult.status      === "fulfilled" ? optFlowResult.value      : null;
    const regimeIntel  = regimeResult.status       === "fulfilled" ? regimeResult.value       : null;
    const newsIntel    = newsSentimentResult.status === "fulfilled" ? newsSentimentResult.value : null;

    // Build predictive signal inputs for the scoring engine
    const predictiveInputs: PredictiveSignalInput[] = [];

    if (pmIntel) {
      const pmScore = pmIntel.momentumScore + pmIntel.blockTradeScore;
      predictiveInputs.push({
        name: "Pre-Market Momentum",
        direction: pmIntel.direction,
        score: pmScore,
        maxWeight: 30,
        value: `${pmIntel.velocityPctPerHour >= 0 ? "+" : ""}${pmIntel.velocityPctPerHour.toFixed(2)}%/hr${pmIntel.blockTradeDetected ? " ⚡ Block trade" : ""}`,
        note: pmIntel.note,
      });
    }
    if (optFlowIntel) {
      predictiveInputs.push({
        name: "Options Flow",
        direction: optFlowIntel.direction,
        score: optFlowIntel.score,
        maxWeight: 15,
        value: optFlowIntel.fullChainPCR != null
          ? `PCR ${optFlowIntel.fullChainPCR}${Math.abs(optFlowIntel.ivSkewPct) > 0.5 ? ` | IV skew ${optFlowIntel.ivSkewPct > 0 ? "+" : ""}${optFlowIntel.ivSkewPct.toFixed(1)}%` : ""}`
          : "No options data",
        note: optFlowIntel.note,
      });
    }
    if (newsIntel) {
      predictiveInputs.push({
        name: "News Catalyst",
        direction: newsIntel.direction,
        score: newsIntel.score,
        maxWeight: 15,
        value: `Sentiment ${newsIntel.rawScore >= 0 ? "+" : ""}${newsIntel.rawScore}/100${newsIntel.isEarningsDriven ? " | Earnings" : ""}`,
        note: newsIntel.note,
      });
    }
    if (regimeIntel) {
      predictiveInputs.push({
        name: "Market Regime",
        direction: regimeIntel.direction,
        score: regimeIntel.score,
        maxWeight: 10,
        value: [
          regimeIntel.vixLevel != null ? `VIX ${regimeIntel.vixLevel} (${regimeIntel.vixRegime ?? "?"})` : null,
          regimeIntel.spyAbove20SMA === true  ? "SPY ▲ above 20-SMA" :
          regimeIntel.spyAbove20SMA === false ? "SPY ▼ below 20-SMA" : null,
        ].filter(Boolean).join(" | "),
        note: regimeIntel.note,
      });
    }

    // ML prediction (reads/trains from DB)
    const mlFeaturesObj: MLFeatures = {
      symbol,
      sessionDate: now.toISOString().split("T")[0]!,
      intradayConviction: signalScore.conviction,
      intradayDirection:  signalScore.direction === "bullish" ? 1 : signalScore.direction === "bearish" ? -1 : 0,
      gapPct:            intradayLevels.gap  ?? 0,
      rvol:              intradayLevels.rvol ?? 1,
      preMarketScore:    pmIntel ? pmIntel.momentumScore + pmIntel.blockTradeScore : 0,
      optionsFlowScore:  optFlowIntel?.score ?? 0,
      newsSentimentScore: newsIntel?.score ?? 0,
      regimeScore:       regimeIntel?.score ?? 0,
      hourOfDay:         etHour,
      setupType:         tradeSetup.setupType ?? "no-trade",
    };

    const mlResult = await mlPredict(mlFeaturesObj).catch(() => null);

    if (mlResult?.hasSufficientData) {
      predictiveInputs.push({
        name: "ML Model Edge",
        direction: mlResult.direction,
        score: mlResult.score,
        maxWeight: 15,
        value: `${(mlResult.probability * 100).toFixed(0)}% correct probability (${mlResult.trainingSampleCount} samples)`,
        note: mlResult.note,
      });
    }

    // Apply predictive signals to base score to get the enhanced combined score
    const enhancedSignalScore = applyPredictiveSignals(signalScore, predictiveInputs);
    const enhancedTradeSetup  = generateTradeSetup({ spot, levels: intradayLevels, signalScore: enhancedSignalScore, now });

    // Record prediction for ML training — fire-and-forget, never blocks response
    recordPrediction(mlFeaturesObj).catch((e) =>
      req.log.warn({ err: String(e) }, "ML: recordPrediction failed"),
    );

    // Assemble predictiveIntelligence for the response
    const predictiveIntelligence = {
      preMarketMomentum: pmIntel ? {
        direction: pmIntel.direction,
        score: pmIntel.momentumScore + pmIntel.blockTradeScore,
        velocityPctPerHour: pmIntel.velocityPctPerHour,
        volumeSurge: pmIntel.volumeSurge,
        blockTradeDetected: pmIntel.blockTradeDetected,
        earningsInDays: pmIntel.earningsInDays,
        note: pmIntel.note,
      } : null,
      optionsFlow: optFlowIntel ? {
        direction: optFlowIntel.direction,
        score: optFlowIntel.score,
        unusualCallStrikes: optFlowIntel.unusualCallStrikes,
        unusualPutStrikes: optFlowIntel.unusualPutStrikes,
        ivSkewPct: optFlowIntel.ivSkewPct,
        fullChainPCR: optFlowIntel.fullChainPCR,
        note: optFlowIntel.note,
      } : null,
      newsCatalyst: newsIntel ? {
        direction: newsIntel.direction,
        score: newsIntel.score,
        rawScore: newsIntel.rawScore,
        isEarningsDriven: newsIntel.isEarningsDriven,
        catalystSummary: newsIntel.catalystSummary,
        note: newsIntel.note,
      } : null,
      marketRegime: regimeIntel ? {
        direction: regimeIntel.direction,
        score: regimeIntel.score,
        spyAbove20SMA: regimeIntel.spyAbove20SMA,
        vixLevel: regimeIntel.vixLevel,
        vixRegime: regimeIntel.vixRegime,
        note: regimeIntel.note,
      } : null,
      mlPrediction: mlResult ? {
        direction: mlResult.direction,
        probability: mlResult.probability,
        score: mlResult.score,
        hasSufficientData: mlResult.hasSufficientData,
        trainingSampleCount: mlResult.trainingSampleCount,
        note: mlResult.note,
      } : null,
    };

    // ── Market session context ────────────────────────────────────────────────
    const marketState    = getMarketState(now, marketHours);
    const sessionMinutes = now >= marketHours.marketOpen
      ? Math.round((now.getTime() - marketHours.marketOpen.getTime()) / 60000)
      : 0;

    // ── Gemini qualitative overlay ────────────────────────────────────────────
    // Use enhancedSignalScore so Gemini sees the full combined conviction
    const prompt = buildIntradayPrompt({
      symbol, spot, q, signalScore: enhancedSignalScore, levels: intradayLevels,
      newsItems, marketState, sessionMinutes, optChain,
    });

    const genAI = getGemini();
    const model = genAI.getGenerativeModel({
      model: "gemini-3.1-flash-lite",
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 4096,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });

    const aiResult = await model.generateContent(prompt);
    const text     = aiResult.response.text();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let aiOutput: any;
    try {
      aiOutput = JSON.parse(text);
    } catch {
      req.log.error({ text }, "Gemini returned invalid JSON");
      res.status(500).json({ error: "AI analysis returned invalid response" });
      return;
    }

    // ── Build Black-Scholes–backed options picks from AI's chosen strikes ─────
    const T = expirationDate ? timeToExpiryYears(expirationDate, now) : null;
    const usedContracts: Array<{
      label: string; volume?: number | null; openInterest?: number | null;
      bid?: number | null; ask?: number | null;
    }> = [];

    function buildRealPick(
      strikeChoice: number | null | undefined,
      rationale: string | undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool: any[],
      type: "call" | "put",
    ) {
      if (strikeChoice == null || !pool.length || T == null) return null;
      const contract = pool.reduce(
        (best: any, c: any) => Math.abs(c.strike - strikeChoice) < Math.abs(best.strike - strikeChoice) ? c : best,
        pool[0],
      );
      const iv      = contract.impliedVolatility;
      const midPrice = contract.bid > 0 && contract.ask > 0
        ? (contract.bid + contract.ask) / 2
        : contract.lastPrice;
      const bs = iv > 0
        ? blackScholes({ spot, strike: contract.strike, timeToExpiryYears: T, riskFreeRate: r, volatility: iv, optionType: type })
        : null;
      usedContracts.push({ label: `${type.toUpperCase()} $${contract.strike}`, volume: contract.volume, openInterest: contract.openInterest, bid: contract.bid, ask: contract.ask });
      return {
        strike: contract.strike,
        expiry: expirationDate ? new Date(expirationDate).toDateString() : "",
        premium: midPrice != null ? +midPrice.toFixed(2) : null,
        rationale: rationale ?? "",
        impliedVolatility: iv ? +(iv * 100).toFixed(1) : null,
        delta: bs?.delta ?? null,
        theoreticalPrice: bs?.theoreticalPrice ?? null,
        probabilityITM: bs?.probabilityITM ?? null,
      };
    }

    const topCallPick = buildRealPick(aiOutput.optionsSnapshot?.topCallStrike, aiOutput.optionsSnapshot?.topCallRationale, rawCalls, "call");
    const topPutPick  = buildRealPick(aiOutput.optionsSnapshot?.topPutStrike,  aiOutput.optionsSnapshot?.topPutRationale,  rawPuts,  "put");

    const optionsSnapshot = optChain ? {
      sentiment: aiOutput.optionsSnapshot?.sentiment ?? "neutral",
      putCallRatio,
      unusualActivity: aiOutput.optionsSnapshot?.unusualActivity ?? "",
      topCallPick,
      topPutPick,
    } : null;

    // ── Data quality metadata ─────────────────────────────────────────────────
    const dataQuality = assessDataQuality({
      quoteTimeMs: q.regularMarketTime ? new Date(q.regularMarketTime).getTime() : null,
      now,
      contracts: usedContracts,
    });
    (dataQuality as any).riskFreeRate = +(r * 100).toFixed(2);

    res.json({
      symbol,
      generatedAt: new Date().toISOString(),
      intradayLevels,
      signalScore: enhancedSignalScore,
      tradeSetup:  enhancedTradeSetup,
      predictiveIntelligence,
      trend:           aiOutput.trend,
      intraday:        aiOutput.intraday,
      optionsSnapshot,
      dataQuality,
    });
  } catch (err: unknown) {
    req.log.error({ err, symbol }, "Analysis error");
    res.status(500).json({ error: "Failed to generate analysis" });
  }
});

// ─── POST /finance/options-strategy/:symbol ────────────────────────────────────

router.post("/finance/options-strategy/:symbol", async (req, res): Promise<void> => {
  const symbol = (req.params.symbol || "").toUpperCase();
  const { investmentAmount, accountSize } = req.body || {};
  const validAccountSize =
    typeof accountSize === "number" && isFinite(accountSize) && accountSize > 0
      ? accountSize : null;

  if (!symbol) {
    res.status(400).json({ error: "Symbol is required" });
    return;
  }
  if (!investmentAmount || typeof investmentAmount !== "number" || investmentAmount <= 0) {
    res.status(400).json({ error: "investmentAmount must be a positive number" });
    return;
  }

  try {
    const now      = new Date();
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [quote, history, optionsData, riskFreeRate] = await Promise.allSettled([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (yahooFinance as any).quote(symbol) as Promise<any>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (yahooFinance as any).chart(symbol, { period1: monthAgo, period2: now, interval: "1d" }) as Promise<any>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (yahooFinance as any).options(symbol) as Promise<any>,
      getRiskFreeRate(),
    ]);

    if (quote.status === "rejected") {
      res.status(404).json({ error: `Symbol not found: ${symbol}` });
      return;
    }

    const q            = quote.value;
    const currentPrice = (q.regularMarketPrice ?? 0) as number;
    const r            = riskFreeRate.status === "fulfilled" ? riskFreeRate.value : FALLBACK_RISK_FREE_RATE;

    // ── Fix 5: Hard staleness gate ────────────────────────────────────────────
    // During regular market hours a quote older than 15 min means Yahoo Finance
    // is rate-limiting or the symbol is halted — stale prices make every Greeks
    // calculation unreliable. Block immediately; outside regular hours (pre/post
    // market, weekends) stale quotes are expected and we proceed with a warning.
    const _quoteTsMs   = q.regularMarketTime ? new Date(q.regularMarketTime).getTime() : null;
    const _quoteAgeSec = _quoteTsMs ? Math.round((now.getTime() - _quoteTsMs) / 1000) : null;
    const _mktHours    = getMarketHours(now);
    const _mktState    = getMarketState(now, _mktHours);
    if (_mktState === "open" && _quoteAgeSec !== null && _quoteAgeSec > 900) {
      res.status(422).json({
        error: `Quote data for ${symbol} is ${Math.round(_quoteAgeSec / 60)} min old. ` +
          `Options pricing requires current prices during market hours. ` +
          `Yahoo Finance may be rate-limiting — wait 30 seconds and try again.`,
      });
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const histQuotes: any[] = history.status === "fulfilled" ? history.value?.quotes ?? [] : [];
    const closes  = histQuotes.map((p: any) => p.close).filter(Boolean) as number[];
    const highs   = histQuotes.map((p: any) => p.high).filter(Boolean)  as number[];
    const lows    = histQuotes.map((p: any) => p.low).filter(Boolean)   as number[];

    const rsi  = calcRSI(closes);
    const { macd, histogram } = calcMACD(closes);
    const atr  = calcATR(highs, lows, closes);

    // ── DTE constants (same thresholds as top-pick flow) ────────────────────
    const MIN_DTE_STANDALONE   = 7;   // hard floor — never 0DTE or same-week
    const IDEAL_DTE_STANDALONE = 21;  // professional minimum for directional plays

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let allChains: any[] = [];
    if (optionsData.status === "fulfilled" && optionsData.value?.options?.length) {
      const rawChains: any[] = optionsData.value.options;
      const calcDTE = (chain: any) =>
        Math.ceil((new Date(chain.expirationDate).getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
      const validChains = rawChains.filter((chain: any) => calcDTE(chain) >= MIN_DTE_STANDALONE);
      const idealChains = validChains.filter((chain: any) => calcDTE(chain) >= IDEAL_DTE_STANDALONE);
      allChains = (idealChains.length ? idealChains : validChains).slice(0, 3);
    }

    const chainSummary = allChains.map((chain: any) => {
      const expiryDate = new Date(chain.expirationDate);
      const expDate    = expiryDate.toDateString();
      const dte        = Math.round((expiryDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

      // Show near-ATM contracts (strikes within ±15% of spot) sorted by OI.
      const nearATMCall = (c: any) => c.volume > 0 && c.strike >= currentPrice * 0.85 && c.strike <= currentPrice * 1.15;
      const nearATMPut  = (p: any) => p.volume > 0 && p.strike >= currentPrice * 0.85 && p.strike <= currentPrice * 1.15;

      const callPool: any[] = (chain.calls || []).filter(nearATMCall)
        .sort((a: any, b: any) => (b.openInterest || 0) - (a.openInterest || 0)).slice(0, 7);
      const putPool: any[]  = (chain.puts  || []).filter(nearATMPut)
        .sort((a: any, b: any) => (b.openInterest || 0) - (a.openInterest || 0)).slice(0, 7);

      // Fallback: if no near-ATM contracts found, use most liquid overall
      const callList = callPool.length
        ? callPool
        : (chain.calls || []).filter((c: any) => c.volume > 0)
            .sort((a: any, b: any) => (b.openInterest || 0) - (a.openInterest || 0)).slice(0, 5);
      const putList = putPool.length
        ? putPool
        : (chain.puts  || []).filter((p: any) => p.volume > 0)
            .sort((a: any, b: any) => (b.openInterest || 0) - (a.openInterest || 0)).slice(0, 5);

      return `Expiry: ${expDate} (${dte} DTE)
  Calls: ${callList.map((c: any) => `${c.strike} IV=${c.impliedVolatility ? (c.impliedVolatility * 100).toFixed(0) : "?"}% OI=${c.openInterest} vol=${c.volume} last=${c.lastPrice?.toFixed(2)}`).join(" | ")}
  Puts:  ${putList.map((p: any) => `${p.strike} IV=${p.impliedVolatility ? (p.impliedVolatility * 100).toFixed(0) : "?"}% OI=${p.openInterest} vol=${p.volume} last=${p.lastPrice?.toFixed(2)}`).join(" | ")}`;
    });

    const prompt = `You are a professional options strategist. Design the best options strategy for a ${investmentAmount.toLocaleString()} maximum budget on ${symbol} (currently ${currentPrice.toFixed(2)}).

STOCK DATA:
Symbol: ${symbol}  |  Price: ${currentPrice.toFixed(2)}
Change: ${q.regularMarketChange?.toFixed(2) ?? "0"} (${q.regularMarketChangePercent?.toFixed(2) ?? "0"}%)
RSI(14-day): ${rsi?.toFixed(1) ?? "N/A"}  |  MACD histogram: ${histogram?.toFixed(3) ?? "N/A"}
ATR(14-day): ${atr?.toFixed(2) ?? "N/A"}

AVAILABLE OPTIONS CHAINS (only expirations with ≥${MIN_DTE_STANDALONE} DTE — 0DTE and near-term expiries excluded):
${chainSummary.length ? chainSummary.join("\n\n") : "No options data available"}

PROFESSIONAL SELECTION RULES — ALL must be satisfied:

1. MINIMUM DTE: Use an expiration with ≥${IDEAL_DTE_STANDALONE} DTE. Never use same-week or 0DTE options.

2. STRIKE QUALITY: Target ATM or 1-2 strikes OTM (delta ~0.35–0.50). Deep OTM penny contracts (<$0.10 premium) have near-zero probability of profit and are forbidden.

3. PROBABILITY OF PROFIT: Target ≥ 35% PoP. If a quality single-leg costs more than ${investmentAmount.toLocaleString()}, switch to a vertical spread — buy the near-ATM strike, sell a strike further OTM — to reduce cost while keeping meaningful PoP.

4. BUDGET: Total net debit × 100 × contracts ≤ ${investmentAmount.toLocaleString()}.

5. LIQUIDITY: Only use contracts with OI > 50 and volume > 10.

DECISION LOGIC:
- Can a near-ATM single leg (delta ≥ 0.30, ATM premium ≤ ${(investmentAmount / 100).toFixed(2)}) be found? → Use it.
- Otherwise → vertical spread: buy near-ATM strike, sell further OTM strike, net debit ≤ ${(investmentAmount / 100).toFixed(2)}.
- Never choose a contract purely because it is cheap.

Return ONLY valid JSON (no markdown):
{
  "strategyName": "<strategy name>",
  "strategyType": "bullish" | "bearish" | "neutral" | "volatile",
  "legs": [
    {
      "type": "call" | "put" | "stock",
      "action": "buy" | "sell",
      "strike": <number or null>,
      "expiry": "<date string matching an available expiry, or null for stock>",
      "contractRatio": <integer, relative ratio vs other legs>
    }
  ],
  "riskLevel": "low" | "medium" | "high",
  "reasoning": "<2-3 sentences: why this strike, expiry, and structure are appropriate>",
  "entryTiming": "<specific entry conditions and timing>",
  "exitStrategy": "<take profit at 75-100% gain, cut at 40-50% loss>"
}`;

    const genAI = getGemini();
    const model = genAI.getGenerativeModel({
      model: "gemini-3.1-flash-lite",
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 4096,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });

    const aiResult = await model.generateContent(prompt);
    const text     = aiResult.response.text();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let aiOutput: any;
    try {
      aiOutput = JSON.parse(text);
    } catch {
      req.log.error({ text }, "Gemini returned invalid JSON for options strategy");
      res.status(500).json({ error: "AI strategy returned invalid response" });
      return;
    }

    // Guard: if no qualifying chains exist, fail fast before paying for an AI call
    if (!allChains.length) {
      res.status(422).json({
        error: `No options chains with ≥${MIN_DTE_STANDALONE} days to expiry found for ${symbol}. This symbol may have illiquid options or only same-day expiries available right now. Try a different symbol.`,
      });
      return;
    }

    const aiLegs: any[] = Array.isArray(aiOutput.legs) ? aiOutput.legs : [];
    if (!aiLegs.length) {
      res.status(500).json({ error: "AI did not return a valid strategy structure" });
      return;
    }

    // ── Strike distance guard ────────────────────────────────────────────────
    // How far from ATM we allow a resolved strike to be (as a fraction of spot).
    // This prevents the AI from accidentally picking a contract the AI was shown
    // but that is clearly not near the money (e.g., $8 strike on a $150 stock).
    const MAX_STRIKE_DISTANCE_FRAC = 0.25;  // 25% from spot
    const MIN_OI_FLOOR = 10;                // at least some open interest
    const MIN_VOL_FLOOR = 1;                // at least some volume

    // Resolve each leg to a real contract from the fetched chain
    const usedContracts: Array<{ label: string; volume?: number | null; openInterest?: number | null; bid?: number | null; ask?: number | null }> = [];
    const resolvedLegs: (PayoffLeg & { impliedVolatility?: number | null; delta?: number | null; theoreticalPrice?: number | null; expiryDate?: Date })[] = [];
    // Half-spread slippage (dollars) for each leg — parallel to resolvedLegs.
    // When you BUY you pay the ask; when you SELL you receive the bid.
    // In both cases the friction is (ask - bid) / 2 per share.
    const legSlippage: number[] = [];
    // Fix 4: Track when the nearest-available strike differs from what the AI requested.
    // Users see AI reasoning written for the requested strike — we must show them the delta.
    const legMismatches: Array<{ type: string; requestedStrike: number | null; filledStrike: number; diff: number }> = [];
    let earliestExpiry: Date | null = null;
    const ivSamples: number[] = [];

    for (const leg of aiLegs) {
      const ratio = Math.max(1, Math.round(leg.contractRatio ?? 1));
      if (leg.type === "stock") {
        resolvedLegs.push({ type: "stock", action: leg.action === "sell" ? "sell" : "buy", premium: currentPrice, contracts: ratio * 100 });
        legSlippage.push(0); // stock slippage modeled separately; omit here
        continue;
      }
      const chain  = allChains.find((c: any) => new Date(c.expirationDate).toDateString() === leg.expiry) ?? allChains[0];
      if (!chain) continue;

      // Build candidate pool — enforce minimum liquidity server-side
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawPool: any[] = leg.type === "put" ? chain.puts || [] : chain.calls || [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pool: any[] = rawPool.filter((c: any) =>
        (c.openInterest ?? 0) >= MIN_OI_FLOOR &&
        (c.volume ?? 0) >= MIN_VOL_FLOOR &&
        Math.abs(c.strike - currentPrice) / currentPrice <= MAX_STRIKE_DISTANCE_FRAC
      );
      // Fallback: if no near-ATM liquid contract, accept any contract within 35% of spot
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const effectivePool = pool.length ? pool : rawPool.filter((c: any) =>
        Math.abs(c.strike - currentPrice) / currentPrice <= 0.35
      );
      if (!effectivePool.length) continue;

      const targetStrike = typeof leg.strike === "number" ? leg.strike : effectivePool[0].strike;
      const contract     = effectivePool.reduce((best: any, c: any) =>
        Math.abs(c.strike - targetStrike) < Math.abs(best.strike - targetStrike) ? c : best, effectivePool[0]);
      const midPrice     = contract.bid > 0 && contract.ask > 0 ? (contract.bid + contract.ask) / 2 : contract.lastPrice;
      const expiryDate   = new Date(chain.expirationDate);
      if (!earliestExpiry || expiryDate < earliestExpiry) earliestExpiry = expiryDate;
      const T  = timeToExpiryYears(expiryDate, now);
      const iv = contract.impliedVolatility;
      if (iv > 0) ivSamples.push(iv);
      const bs = iv > 0 ? blackScholes({ spot: currentPrice, strike: contract.strike, timeToExpiryYears: T, riskFreeRate: r, volatility: iv, optionType: leg.type === "put" ? "put" : "call" }) : null;
      // Track per-leg half-spread slippage: both BUY (pay ask) and SELL (receive bid)
      // incur half-spread friction in the same direction.
      const halfSpread = contract.bid > 0 && contract.ask > 0
        ? (contract.ask - contract.bid) / 2
        : (midPrice != null ? midPrice * 0.05 : 0); // fallback: 5% of mid when no B/A
      legSlippage.push(halfSpread * ratio * 100);
      // Fix 4: record strike mismatch when nearest-available differs from AI request
      const requestedStrike = typeof leg.strike === "number" ? leg.strike : null;
      if (requestedStrike !== null && Math.abs(contract.strike - requestedStrike) > 0.01) {
        legMismatches.push({
          type: leg.type,
          requestedStrike,
          filledStrike: contract.strike,
          diff: +(contract.strike - requestedStrike).toFixed(2),
        });
      }
      usedContracts.push({ label: `${leg.type.toUpperCase()} ${contract.strike}`, volume: contract.volume, openInterest: contract.openInterest, bid: contract.bid, ask: contract.ask });
      resolvedLegs.push({
        type: leg.type === "put" ? "put" : "call", action: leg.action === "sell" ? "sell" : "buy",
        strike: contract.strike, premium: midPrice != null ? +midPrice.toFixed(2) : 0,
        contracts: ratio,
        impliedVolatility: iv ? +(iv * 100).toFixed(1) : null,
        delta: bs?.delta ?? null, theoreticalPrice: bs?.theoreticalPrice ?? null, expiryDate,
      });
    }

    if (!resolvedLegs.length) {
      res.status(500).json({ error: "Could not resolve strategy legs against live options data" });
      return;
    }

    // ── Per-unit commission + slippage (Schwab/TD standard, one-way open) ────
    const optionLegsUnit = resolvedLegs.filter((l) => l.type !== "stock");
    const unitContracts  = optionLegsUnit.reduce((s, l) => s + l.contracts, 0);
    const unitCommission = unitContracts * COMMISSION_PER_CONTRACT;
    const unitSlippage   = legSlippage.reduce((s, v) => s + v, 0);
    const unitFriction   = unitCommission + unitSlippage;

    const unitMetrics = computeStrategyMetrics({
      legs: resolvedLegs, spot: currentPrice,
      avgVolatility: ivSamples.length ? ivSamples.reduce((a, b) => a + b, 0) / ivSamples.length : 0.3,
      timeToExpiryYears: earliestExpiry ? timeToExpiryYears(earliestExpiry, now) : 30 / 365,
      riskFreeRate: r,
    });

    let requiredCapitalPerUnit: number;
    let unlimitedRiskWarning: string | null = null;
    if (unitMetrics.netCost > 0) {
      requiredCapitalPerUnit = unitMetrics.netCost;
    } else if (typeof unitMetrics.maxLoss === "number") {
      requiredCapitalPerUnit = Math.abs(unitMetrics.maxLoss);
    } else {
      requiredCapitalPerUnit = Infinity;
      unlimitedRiskWarning = "This strategy has undefined (unlimited) risk. Position sized to 1 contract as a safeguard.";
    }

    let multiplier: number;
    if (!isFinite(requiredCapitalPerUnit)) {
      multiplier = 1;
    } else if (requiredCapitalPerUnit > investmentAmount) {
      res.status(422).json({ error: `The ${aiOutput.strategyName ?? "selected strategy"} requires at least ${requiredCapitalPerUnit.toLocaleString(undefined, { maximumFractionDigits: 2 })} per contract, which exceeds your ${investmentAmount.toLocaleString()} budget. Try a larger amount or ask for a narrower spread.` });
      return;
    } else {
      multiplier = Math.max(1, Math.floor(investmentAmount / requiredCapitalPerUnit));
    }
    multiplier = Math.min(multiplier, 500);

    const scaledLegs   = resolvedLegs.map((leg) => ({ ...leg, contracts: leg.contracts * multiplier }));
    const finalMetrics = computeStrategyMetrics({
      legs: scaledLegs, spot: currentPrice,
      avgVolatility: ivSamples.length ? ivSamples.reduce((a, b) => a + b, 0) / ivSamples.length : 0.3,
      timeToExpiryYears: earliestExpiry ? timeToExpiryYears(earliestExpiry, now) : 30 / 365,
      riskFreeRate: r,
    });

    // ── Scaled friction & effective metrics ───────────────────────────────────
    const scaledCommission  = unitCommission * multiplier;
    const scaledSlippage    = unitSlippage   * multiplier;
    const scaledFriction    = scaledCommission + scaledSlippage;
    // Friction always reduces profit and deepens loss magnitude.
    const effectiveNetCost   = finalMetrics.netCost + scaledFriction;
    const effectiveMaxProfit = typeof finalMetrics.maxProfit === "number"
      ? finalMetrics.maxProfit - scaledFriction : finalMetrics.maxProfit;
    const effectiveMaxLoss   = typeof finalMetrics.maxLoss === "number"
      ? finalMetrics.maxLoss   - scaledFriction : finalMetrics.maxLoss;

    // ── Fix 3: Hard block on unlimited-risk strategies ────────────────────────
    // Naked short legs (short call/put with no covering long) have theoretically
    // unlimited downside. We refuse to size or return these; the AI prompt already
    // instructs defined-risk only, but this is the server-side enforcement layer.
    if (effectiveMaxLoss === "unlimited" || finalMetrics.maxLoss === "unlimited") {
      res.status(422).json({
        error:
          `${aiOutput.strategyName ?? "This strategy"} contains a naked short leg with unlimited downside risk. ` +
          `Only defined-risk structures (vertical spreads, covered calls, cash-secured puts, iron condors) are permitted. ` +
          `Regenerate — the AI will choose a capped-risk alternative.`,
      });
      return;
    }

    // ── Position sizing — 2% rule ─────────────────────────────────────────────
    const riskDollars = typeof effectiveMaxLoss === "number" ? Math.abs(effectiveMaxLoss) : null;

    // Fix 2: Hard block — if accountSize was supplied, enforce 2% risk limit.
    // A position that risks more than 2% of account is rejected, not warned.
    if (validAccountSize && riskDollars != null) {
      const maxAllowed2 = validAccountSize * 0.02;
      if (riskDollars > maxAllowed2) {
        const riskPct = +(riskDollars / validAccountSize * 100).toFixed(1);
        res.status(422).json({
          error:
            `Position risk (${riskDollars.toFixed(0)}, ${riskPct}% of your ${validAccountSize.toLocaleString()} account) ` +
            `exceeds the 2% rule (${maxAllowed2.toFixed(0)} maximum). ` +
            `Reduce your trade capital, choose a tighter spread, or increase your account size.`,
          positionSizing: {
            accountSize: validAccountSize,
            riskDollars: +riskDollars.toFixed(2),
            riskPercent: +riskPct,
            maxAllowedFor2Pct: +maxAllowed2.toFixed(2),
            exceedsRule: true,
          },
        });
        return;
      }
    }

    const positionSizing = validAccountSize && riskDollars != null ? (() => {
      const riskPct     = riskDollars / validAccountSize * 100;
      const maxAllowed2 = validAccountSize * 0.02;
      return {
        accountSize:       validAccountSize,
        riskDollars:       +riskDollars.toFixed(2),
        riskPercent:       +riskPct.toFixed(2),
        maxAllowedFor2Pct: +maxAllowed2.toFixed(2),
        exceedsRule:       false,
        recommendation:    `Risk (${riskDollars.toFixed(0)}) is ${riskPct.toFixed(1)}% of your ${validAccountSize.toLocaleString()} account — within the 2% professional guideline.`,
      };
    })() : null;

    const dataQuality = assessDataQuality({ quoteTimeMs: q.regularMarketTime ? new Date(q.regularMarketTime).getTime() : null, now, contracts: usedContracts });
    (dataQuality as any).riskFreeRate = +(r * 100).toFixed(2);
    if (unlimitedRiskWarning) dataQuality.liquidityWarnings.push(unlimitedRiskWarning);

    const formatMoney = (v: number | "unlimited", forceAbs = false) =>
      v === "unlimited" ? "Unlimited"
        : `${(forceAbs ? Math.abs(v as number) : (v as number)).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

    // ── Professional PoP quality gate ────────────────────────────────────────
    // Reject strategies the math confirms are near-worthless. 0DTE-induced
    // "100%" readings and deep-OTM sub-25% readings are both caught here.
    const MIN_POP_STANDALONE = 25;
    const computedPoP = finalMetrics.probabilityOfProfit;
    const popValid = typeof computedPoP === "number" && isFinite(computedPoP);
    if (!popValid || computedPoP < MIN_POP_STANDALONE || computedPoP > 99) {
      res.status(422).json({
        error: `The computed probability of profit (${popValid ? computedPoP.toFixed(0) : "unknown"}%) does not meet the minimum quality threshold. This usually means the options chain contains stale or illiquid data. Try a different symbol or a larger budget to access higher-quality strikes.`,
      });
      return;
    }

    res.json({
      symbol, investmentAmount,
      strategyName: aiOutput.strategyName ?? "Custom Strategy",
      strategyType: aiOutput.strategyType ?? "neutral",
      legs: scaledLegs.map((leg) => ({
        type: leg.type, action: leg.action, strike: leg.strike ?? null,
        expiry: (leg as any).expiryDate ? (leg as any).expiryDate.toDateString() : null,
        premium: leg.premium ?? null, contracts: leg.contracts,
        impliedVolatility: (leg as any).impliedVolatility ?? null,
        delta: (leg as any).delta ?? null, theoreticalPrice: (leg as any).theoreticalPrice ?? null,
      })),
      // ── Theoretical (mid-price, pre-cost) ────────────────────────────────
      totalCost:  finalMetrics.netCost,
      maxProfit:  formatMoney(finalMetrics.maxProfit),
      maxLoss:    formatMoney(finalMetrics.maxLoss),
      breakeven:  finalMetrics.breakevens.length ? finalMetrics.breakevens.map((b) => `${b.toFixed(2)}`).join(" / ") : "N/A",
      breakevens: finalMetrics.breakevens,
      // ── After commissions + slippage ─────────────────────────────────────
      commission:         +scaledCommission.toFixed(2),
      slippage:           +scaledSlippage.toFixed(2),
      friction:           +scaledFriction.toFixed(2),
      effectiveCost:      +effectiveNetCost.toFixed(2),
      effectiveMaxProfit: formatMoney(effectiveMaxProfit),
      effectiveMaxLoss:   formatMoney(effectiveMaxLoss, true),
      // ── Position sizing ──────────────────────────────────────────────────
      positionSizing,
      // ── Fix 4: Leg mismatch transparency ─────────────────────────────────
      // Tells the UI when the nearest-available strike differs from what the AI
      // described in its reasoning. The user can then calibrate trust accordingly.
      legMismatches,
      // ── Data latency note (always present) ───────────────────────────────
      dataLatencyNote: "Market data sourced from Yahoo Finance (free tier). Quotes may be delayed up to 15 minutes during market hours. Always verify current price and bid/ask with your broker before placing any order.",
      probability: computedPoP,
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
});

// ─── GET /finance/top-pick ─────────────────────────────────────────────────────
// Scans a watchlist, picks the highest-conviction actionable setup, and
// auto-generates a ≤$100 options strategy for it.

// ── Static core universe ────────────────────────────────────────────────────
// 72 high-liquidity names spanning all 11 GICS sectors with active options
// chains. Intentionally excludes Utilities and Real Estate (low intraday
// momentum) and avoids clustering in any single sector.
const CORE_WATCHLIST: readonly string[] = [
  // Technology (11) ── reduced from original 8/15 concentration
  "AAPL","MSFT","NVDA","AMD","META","GOOGL","AMZN","TSLA","AVGO","CRM","ORCL",
  // Financials (9) ── banks, asset managers, payment networks
  "JPM","GS","BAC","MS","V","MA","C","WFC","BLK",
  // Healthcare (8) ── pharma, biotech, managed care
  "UNH","LLY","ABBV","JNJ","PFE","MRK","AMGN","GILD",
  // Energy (5) ── majors + services
  "XOM","CVX","COP","SLB","OXY",
  // Industrials (7) ── machinery, aerospace, logistics
  "CAT","DE","HON","BA","GE","RTX","UPS",
  // Consumer Discretionary (6)
  "COST","HD","MCD","NKE","SBUX","TGT",
  // Consumer Staples (5)
  "PG","KO","WMT","PM","CL",
  // Materials (4)
  "FCX","NEM","LIN","DOW",
  // Communication Services (5)
  "NFLX","DIS","T","VZ","CMCSA",
  // Utilities (3) ── rate-sensitive; active on macro days
  "NEE","DUK","SO",
  // Real Estate / REITs (3) ── rate-sensitive; move on Fed days
  "AMT","PLD","EQIX",
  // Broad-market index ETFs (4) ── basket momentum reads
  "SPY","QQQ","IWM","DIA",
  // Sector ETFs (8) ── rotation signals
  "XLF","XLE","XLV","XLK","XLI","XLY","GLD","SLV",
];

// Deduplicate at module load time (guard against future editing accidents)
const CORE_UNIVERSE: string[] = [...new Set(CORE_WATCHLIST)];

// ── Dynamic daily mover screen ──────────────────────────────────────────────
// Every trading day the market surfaces its own best candidates: earnings
// beats, sector rotation, macro catalysts. This cache fetches Yahoo Finance's
// most-active, day-gainers, and day-losers screens once per calendar day (ET)
// and injects qualifying names alongside the static core so the scanner always
// includes today's "in play" stocks — not just a fixed list decided weeks ago.

interface DynamicMoverCache { symbols: string[]; dateKey: string }
let dynamicMoverCache: DynamicMoverCache | null = null;

/** Returns the ET calendar date as a string — used to key the daily cache. */
function etDateKey(now: Date): string {
  return now.toLocaleDateString("en-US", { timeZone: "America/New_York" });
}

/**
 * Fetches today's market movers from Yahoo Finance screens, filters for
 * liquid US-listed equities not already in the static core, and returns
 * up to 25 unique symbols. Results are cached for the full trading day.
 */
async function fetchDynamicMovers(now: Date): Promise<string[]> {
  const dateKey = etDateKey(now);
  if (dynamicMoverCache?.dateKey === dateKey) return dynamicMoverCache.symbols;

  try {
    // Pull three screens concurrently; failures are non-fatal
    const [actives, gainers, losers] = await Promise.allSettled([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (yahooFinance as any).screener({ scrIds: "most_actives", count: 30 }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (yahooFinance as any).screener({ scrIds: "day_gainers",  count: 20 }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (yahooFinance as any).screener({ scrIds: "day_losers",   count: 20 }),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extract = (r: PromiseSettledResult<any>): string[] =>
      r.status === "fulfilled"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? (r.value?.quotes ?? []).map((q: any) => q.symbol as string).filter(Boolean)
        : [];

    const candidates = [...new Set([
      ...extract(actives),
      ...extract(gainers),
      ...extract(losers),
    ])].slice(0, 50);

    if (!candidates.length) {
      dynamicMoverCache = { symbols: [], dateKey };
      return [];
    }

    // Validate: US-listed common equity, price ≥ $5, avg daily vol ≥ 500k,
    // no ADR dot notation, not already in the static core.
    const quoteChecks = await Promise.allSettled(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      candidates.map((sym) => (yahooFinance as any).quote(sym) as Promise<any>),
    );

    const qualified = quoteChecks
      .filter((r): r is PromiseFulfilledResult<NonNullable<unknown>> => r.status === "fulfilled")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((r) => (r as PromiseFulfilledResult<any>).value)
      .filter((q) =>
        q.quoteType === "EQUITY" &&
        q.market === "us_market" &&
        (q.regularMarketPrice ?? 0) >= 5 &&
        ((q.averageDailyVolume3Month ?? q.averageDailyVolume10Day ?? 0) as number) >= 500_000 &&
        !(q.symbol as string).includes(".") && // exclude ADR dot notation
        !CORE_UNIVERSE.includes(q.symbol as string),
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((q: any) => q.symbol as string)
      .slice(0, 25);

    dynamicMoverCache = { symbols: qualified, dateKey };
    return qualified;
  } catch {
    // Dynamic screen failure is non-fatal — fall back to static core only
    dynamicMoverCache = { symbols: [], dateKey };
    return [];
  }
}

// ── Scoring helpers ─────────────────────────────────────────────────────────

/**
 * Score symbols in concurrent batches of `batchSize` to stay well within
 * Yahoo Finance's soft rate limits when the universe grows to 90+ names.
 */
async function scoreUniverse(
  symbols: string[],
  now: Date,
  batchSize = 25,
): Promise<NonNullable<Awaited<ReturnType<typeof scoreSymbol>>>[]> {
  const results: NonNullable<Awaited<ReturnType<typeof scoreSymbol>>>[] = [];
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map((sym) => scoreSymbol(sym, now)));
    for (const r of settled) {
      if (r.status === "fulfilled" && r.value !== null) results.push(r.value);
    }
    // Brief pause between batches to stay inside Yahoo Finance's soft rate limits.
    // Without this, 90+ concurrent symbols trigger IP-based throttling silently.
    if (i + batchSize < symbols.length) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  return results;
}

// Cache top-pick result for 2 minutes so refreshes are instant.
// Also store the ET date so a day rollover always invalidates the cache
// even if it's within the 2-minute TTL window.
let topPickCache: { result: unknown; cachedAt: number; dateKey: string } | null = null;
const TOP_PICK_TTL_MS = 2 * 60 * 1000;

const SETUP_BONUS: Record<string, number> = {
  "Previous Day Low Breakdown":  1.50,
  "Pre-Market High Breakout":    1.20,
  "Pre-Market Low Breakdown":    1.15,
  "ORB Breakdown":               1.10,
  "Previous Day High Breakout":  1.05,
  "VWAP Trend Short":            1.00,
};

async function scoreSymbol(symbol: string, now: Date) {
  const tenDaysAgo    = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const threeDaysAgo  = new Date(now.getTime() -  3 * 24 * 60 * 60 * 1000);

  // Each Yahoo Finance call is wrapped in a 10-second hard timeout and one
  // automatic retry (500ms back-off). This prevents a single slow/throttled
  // symbol from hanging an entire 25-symbol batch indefinitely.
  const yCall = <T>(fn: () => Promise<T>) => withTimeout(10_000, () => withRetry(fn));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [quote, minuteData, fiveMinData, fifteenMinData, dailyData] = await Promise.allSettled([
    yCall(() => (yahooFinance as any).quote(symbol) as Promise<any>),
    yCall(() => (yahooFinance as any).chart(symbol, { period1: threeDaysAgo,  period2: now, interval: "1m"  }) as Promise<any>),
    yCall(() => (yahooFinance as any).chart(symbol, { period1: tenDaysAgo,    period2: now, interval: "5m"  }) as Promise<any>),
    yCall(() => (yahooFinance as any).chart(symbol, { period1: tenDaysAgo,    period2: now, interval: "15m" }) as Promise<any>),
    yCall(() => (yahooFinance as any).chart(symbol, { period1: thirtyDaysAgo, period2: now, interval: "1d"  }) as Promise<any>),
  ]);

  if (quote.status === "rejected") return null;
  const q    = quote.value;
  const spot = (q.regularMarketPrice ?? 0) as number;
  if (!spot) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getQuotes = (r: PromiseSettledResult<any>) =>
    r.status === "fulfilled" ? (r.value?.quotes ?? []) : [];

  const minuteBars     = parseYahooBars(getQuotes(minuteData));
  const fiveMinBars    = parseYahooBars(getQuotes(fiveMinData));
  const fifteenMinBars = parseYahooBars(getQuotes(fifteenMinData));
  const dailyBars      = parseYahooBars(getQuotes(dailyData));
  const avgDailyVolume: number | null =
    q.averageDailyVolume3Month ?? q.averageDailyVolume10Day ?? null;

  const levels     = computeIntradayLevels({ minuteBars, dailyBars, spot, avgDailyVolume, now });
  const rsi5m      = calcRSI(fiveMinBars.map((b) => b.close));
  const rsi15m     = calcRSI(fifteenMinBars.map((b) => b.close));
  const { histogram: macdHistogram15m } = calcMACD(fifteenMinBars.map((b) => b.close));

  const signalScore = computeIntradaySignals({
    spot, levels, rsi5m, rsi15m, macdHistogram15m,
    dayChange: q.regularMarketChange ?? null,
  });
  const tradeSetup = generateTradeSetup({ spot, levels, signalScore, now });

  if (tradeSetup.bias === "no-trade") return null;

  const bonus = SETUP_BONUS[tradeSetup.setupType] ?? 1.0;
  const score = signalScore.conviction * (tradeSetup.rrRatio1 ?? 1.2) * bonus;

  return {
    symbol,
    score,
    name:          q.longName ?? q.shortName ?? symbol,
    price:         spot,
    change:        q.regularMarketChange ?? 0,
    changePercent: q.regularMarketChangePercent ?? 0,
    signalScore,
    tradeSetup,
    levels,
  };
}

router.get("/finance/top-pick", async (req, res): Promise<void> => {
  // Serve from cache if fresh
  const now = new Date();
  const nowDateKey = etDateKey(now);
  // Serve from cache only if it's within TTL AND still the same ET calendar day.
  // A day rollover must bypass the cache so dynamic movers refresh immediately.
  if (
    topPickCache &&
    topPickCache.dateKey === nowDateKey &&
    Date.now() - topPickCache.cachedAt < TOP_PICK_TTL_MS
  ) {
    res.json(topPickCache.result);
    return;
  }
  try {

    // Build today's scan universe: static core + dynamic daily movers
    const dynamicSymbols = await fetchDynamicMovers(now);
    const scanUniverse = [...CORE_UNIVERSE, ...dynamicSymbols];

    // Score all symbols in batched-concurrent passes
    const scored = (await scoreUniverse(scanUniverse, now))
      .sort((a, b) => b.score - a.score);

    if (!scored.length) {
      res.json({ pick: null, reason: "No actionable setups found across watchlist right now." });
      return;
    }

    const winner = scored[0];

    // ── Generate options strategy for winner at ≤$100 ──────────────────────────
    let optionsStrategy: Record<string, unknown> | null = null;
    try {
      const BUDGET = 100;
      const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const [quoteOpts, histOpts, optionsData, riskFreeRate] = await Promise.allSettled([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (yahooFinance as any).quote(winner.symbol) as Promise<any>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (yahooFinance as any).chart(winner.symbol, { period1: monthAgo, period2: now, interval: "1d" }) as Promise<any>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (yahooFinance as any).options(winner.symbol) as Promise<any>,
        getRiskFreeRate(),
      ]);

      const q2       = quoteOpts.status === "fulfilled" ? quoteOpts.value : null;
      const r        = riskFreeRate.status === "fulfilled" ? riskFreeRate.value : FALLBACK_RISK_FREE_RATE;
      const histQ    = histOpts.status === "fulfilled" ? (histOpts.value?.quotes ?? []) : [];
      const closes   = histQ.map((p: any) => p.close).filter(Boolean) as number[];
      const highs    = histQ.map((p: any) => p.high).filter(Boolean)  as number[];
      const lows     = histQ.map((p: any) => p.low).filter(Boolean)   as number[];
      const rsi      = calcRSI(closes);
      const { histogram } = calcMACD(closes);
      const atr      = calcATR(highs, lows, closes);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // ── DTE constants ────────────────────────────────────────────────────────
      const MIN_DTE   = 7;  // hard floor — never recommend anything expiring sooner
      const IDEAL_DTE = 21; // professional minimum for directional plays

      let allChains: any[] = [];
      if (optionsData.status === "fulfilled" && optionsData.value?.options?.length) {
        const rawChains: any[] = optionsData.value.options;
        // Strip expirations that are too close to act on professionally
        // Use ceiling so that an expiry timestamped e.g. 6.9 days away still
        // counts as 7 DTE — market convention rounds to the nearest trading day.
        const calcDTE = (chain: any) =>
          Math.ceil((new Date(chain.expirationDate).getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
        const validChains = rawChains.filter((chain: any) => calcDTE(chain) >= MIN_DTE);
        // Prefer 21+ DTE; fall back to MIN_DTE-qualified chains if nothing ideal exists
        const idealChains = validChains.filter((chain: any) => calcDTE(chain) >= IDEAL_DTE);
        allChains = (idealChains.length ? idealChains : validChains).slice(0, 3);
      }

      const spot = winner.price;

      const chainSummary = allChains.map((chain: any) => {
        const expiryDate = new Date(chain.expirationDate);
        const expDate = expiryDate.toDateString();
        const dte = Math.round((expiryDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

        // Show near-ATM contracts (strikes within ±15% of spot) sorted by open interest.
        // No premium ceiling — we let the AI and budget math decide, not a filter.
        const nearATMCall = (c: any) => c.volume > 0 && c.strike >= spot * 0.90 && c.strike <= spot * 1.15;
        const nearATMPut  = (p: any) => p.volume > 0 && p.strike >= spot * 0.85 && p.strike <= spot * 1.10;

        const callPool: any[] = (chain.calls || []).filter(nearATMCall)
          .sort((a: any, b: any) => (b.openInterest || 0) - (a.openInterest || 0)).slice(0, 7);
        const putPool:  any[] = (chain.puts  || []).filter(nearATMPut)
          .sort((a: any, b: any) => (b.openInterest || 0) - (a.openInterest || 0)).slice(0, 7);

        // Fallback: if no near-ATM contracts found, use most liquid overall
        const callList = callPool.length
          ? callPool
          : (chain.calls || []).filter((c: any) => c.volume > 0)
              .sort((a: any, b: any) => (b.openInterest || 0) - (a.openInterest || 0)).slice(0, 5);
        const putList = putPool.length
          ? putPool
          : (chain.puts || []).filter((p: any) => p.volume > 0)
              .sort((a: any, b: any) => (b.openInterest || 0) - (a.openInterest || 0)).slice(0, 5);

        return `Expiry: ${expDate} (${dte} DTE)
  Calls: ${callList.map((c: any) => `${c.strike} IV=${c.impliedVolatility ? (c.impliedVolatility * 100).toFixed(0) : "?"}% OI=${c.openInterest} vol=${c.volume} last=${c.lastPrice?.toFixed(2)}`).join(" | ")}
  Puts:  ${putList.map((p: any) => `${p.strike} IV=${p.impliedVolatility ? (p.impliedVolatility * 100).toFixed(0) : "?"}% OI=${p.openInterest} vol=${p.volume} last=${p.lastPrice?.toFixed(2)}`).join(" | ")}`;
      });

      const bias = winner.tradeSetup.bias;
      const prompt = `You are a professional options strategist. Design the best options strategy for a ${BUDGET} maximum budget on ${winner.symbol} (currently ${spot.toFixed(2)}).

TRADE CONTEXT:
- Direction: ${bias.toUpperCase()} — ${winner.tradeSetup.setupType} (${winner.signalScore.conviction}% conviction)
- Stop loss: ${winner.tradeSetup.stopLoss?.toFixed(2) ?? "N/A"} | Target 1: ${winner.tradeSetup.target1?.toFixed(2) ?? "N/A"} | Target 2: ${winner.tradeSetup.target2?.toFixed(2) ?? "N/A"}
- RSI(14d): ${rsi?.toFixed(1) ?? "N/A"} | MACD histogram: ${histogram?.toFixed(3) ?? "N/A"} | ATR(14d): ${atr?.toFixed(2) ?? "N/A"}

AVAILABLE OPTIONS CHAINS (only expirations with ≥${MIN_DTE} DTE — 0DTE and near-term expiries excluded):
${chainSummary.length ? chainSummary.join("\n\n") : "No options data available"}

PROFESSIONAL SELECTION RULES — all must be satisfied:

1. MINIMUM DTE: Use an expiration with ≥${IDEAL_DTE} DTE. Never use same-week or 0DTE options — they expire worthless unless the move happens today, and there is no recovery from bad timing.

2. STRIKE QUALITY: For single-leg longs, target ATM or 1-2 strikes OTM (delta ~0.35–0.50). Deep OTM cheap contracts have near-zero probability of profit and are speculative lottery tickets, not strategies.

3. PROBABILITY OF PROFIT: Target ≥ 35% PoP. If a quality single-leg (delta ≥ 0.30) costs more than ${BUDGET}, switch to a vertical spread — it reduces cost while keeping a meaningful PoP.

4. BUDGET: Total cost ≤ ${BUDGET}.
   - Single-leg: premium × 100 ≤ ${BUDGET} (i.e. premium ≤ ${(BUDGET / 100).toFixed(2)})
   - Spread: net debit × 100 ≤ ${BUDGET}

5. LIQUIDITY: Prefer contracts with OI > 50 and volume > 10 to ensure fills are realistic.

6. DIRECTION: ${bias === "short" ? "BEARISH → use Long Put or Bear Put Spread." : "BULLISH → use Long Call or Bull Call Spread."}

DECISION LOGIC:
- Can a near-ATM single leg (delta ≥ 0.30, premium ≤ ${(BUDGET / 100).toFixed(2)}) be found? → Use it.
- Otherwise → use a vertical spread: buy the near-ATM strike, sell a strike further OTM, net debit ≤ ${(BUDGET / 100).toFixed(2)}.
- Never choose a contract purely because it is cheap. If the only affordable contracts are deep OTM with < 20% PoP, say so in reasoning and use a spread instead.

Return ONLY valid JSON (no markdown):
{
  "strategyName": "<strategy name>",
  "strategyType": "bullish" | "bearish" | "neutral" | "volatile",
  "legs": [
    { "type": "call" | "put", "action": "buy" | "sell", "strike": <number>, "expiry": "<date string matching an available expiry>", "contractRatio": 1 }
  ],
  "riskLevel": "low" | "medium" | "high",
  "reasoning": "<2-3 sentences: why this strike, expiry, and structure are appropriate for this setup>",
  "exitStrategy": "<take profit at 75-100% gain on the option position, cut at 40-50% loss>"
}`;

      const genAI = getGemini();
      const model = genAI.getGenerativeModel({
        model: "gemini-3.1-flash-lite",
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: 1024 } as any,
      });
      const aiResult  = await model.generateContent(prompt);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let aiOutput: any;
      try { aiOutput = JSON.parse(aiResult.response.text()); } catch { aiOutput = null; }

      if (aiOutput?.legs?.length) {
        const aiLegs: any[] = aiOutput.legs;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const resolvedLegs: (PayoffLeg & { impliedVolatility?: number | null; delta?: number | null; expiryDate?: Date })[] = [];
        let earliestExpiry: Date | null = null;
        const ivSamples: number[] = [];

        for (const leg of aiLegs) {
          const chain = allChains.find((c: any) => new Date(c.expirationDate).toDateString() === leg.expiry) ?? allChains[0];
          if (!chain) continue;
          const pool: any[] = leg.type === "put" ? chain.puts || [] : chain.calls || [];
          if (!pool.length) continue;
          const targetStrike = typeof leg.strike === "number" ? leg.strike : pool[0].strike;
          const contract = pool.reduce((best: any, c: any) =>
            Math.abs(c.strike - targetStrike) < Math.abs(best.strike - targetStrike) ? c : best, pool[0]);
          const midPrice  = contract.bid > 0 && contract.ask > 0
            ? (contract.bid + contract.ask) / 2 : contract.lastPrice;
          const expiryDate = new Date(chain.expirationDate);
          if (!earliestExpiry || expiryDate < earliestExpiry) earliestExpiry = expiryDate;
          const iv = contract.impliedVolatility;
          if (iv > 0) ivSamples.push(iv);
          resolvedLegs.push({
            type: leg.type === "put" ? "put" : "call",
            action: leg.action === "sell" ? "sell" : "buy",
            strike: contract.strike,
            premium: midPrice != null ? +midPrice.toFixed(2) : 0,
            contracts: 1,
            impliedVolatility: iv ? +(iv * 100).toFixed(1) : null,
            expiryDate,
          });
        }

        if (resolvedLegs.length) {
          const unitMetrics = computeStrategyMetrics({
            legs: resolvedLegs, spot: winner.price,
            avgVolatility: ivSamples.length ? ivSamples.reduce((a, b) => a + b) / ivSamples.length : 0.3,
            timeToExpiryYears: earliestExpiry ? timeToExpiryYears(earliestExpiry, now) : 30 / 365,
            riskFreeRate: r,
          });

          const netCostPerUnit = unitMetrics.netCost;
          const affordable = netCostPerUnit <= BUDGET;
          const pop = unitMetrics.probabilityOfProfit;

          // ── Professional quality gate ─────────────────────────────────────
          // Reject strategies the math confirms are near-worthless. A PoP
          // below 25% on a debit strategy is deep-OTM speculation regardless
          // of how the AI described it.  Better to show nothing than to show
          // a 0% PoP trade as an "AI-designed" recommendation.
          // Treat null/unknown PoP as a failure — we need computable math
          // to verify quality before surfacing a strategy.
          const MIN_POP = 25;
          const popIsValid = typeof pop === "number" && isFinite(pop);
          if (!popIsValid || pop < MIN_POP) {
            // Strategy failed the quality gate — do not surface it
          } else {
            optionsStrategy = {
              strategyName:  aiOutput.strategyName ?? "Custom Strategy",
              strategyType:  aiOutput.strategyType ?? "neutral",
              riskLevel:     aiOutput.riskLevel ?? "medium",
              reasoning:     aiOutput.reasoning ?? "",
              exitStrategy:  aiOutput.exitStrategy ?? "",
              affordable,
              totalCost:     +netCostPerUnit.toFixed(2),
              maxProfit:     unitMetrics.maxProfit === "unlimited" ? "Unlimited" : `${Math.abs(unitMetrics.maxProfit as number).toFixed(2)}`,
              maxLoss:       unitMetrics.maxLoss   === "unlimited" ? "Unlimited" : `${Math.abs(unitMetrics.maxLoss   as number).toFixed(2)}`,
              probability:   pop ?? 50,
              breakeven:     unitMetrics.breakevens.map((b) => `${b.toFixed(2)}`).join(" / ") || "N/A",
              legs: resolvedLegs.map((leg) => ({
                type: leg.type, action: leg.action, strike: leg.strike ?? null,
                expiry: (leg as any).expiryDate ? (leg as any).expiryDate.toDateString() : null,
                premium: leg.premium ?? null,
                impliedVolatility: (leg as any).impliedVolatility ?? null,
              })),
            };
          }
        }
      }
    } catch (optErr) {
      // options strategy failure is non-fatal — still return the pick
    }

    const payload = {
      generatedAt: now.toISOString(),
      pick: {
        symbol:        winner.symbol,
        name:          winner.name,
        price:         winner.price,
        change:        winner.change,
        changePercent: winner.changePercent,
        score:         +winner.score.toFixed(1),
        tradeSetup:    winner.tradeSetup,
        signalScore: {
          direction:  winner.signalScore.direction,
          conviction: winner.signalScore.conviction,
        },
      },
      optionsStrategy,
      allPicks: scored.slice(0, 5).map((s) => ({
        symbol:     s.symbol,
        bias:       s.tradeSetup.bias,
        setupType:  s.tradeSetup.setupType,
        conviction: s.signalScore.conviction,
        rrRatio1:   s.tradeSetup.rrRatio1,
        score:      +s.score.toFixed(1),
      })),
    };
    topPickCache = { result: payload, cachedAt: Date.now(), dateKey: nowDateKey };
    res.json(payload);
  } catch (err: unknown) {
    res.status(500).json({ error: "Failed to compute top pick" });
  }
});

export default router;
