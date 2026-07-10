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
  type IntradayLevels,
} from "../lib/intraday";
import {
  computeIntradaySignals,
  generateTradeSetup,
  type IntradaySignalScore,
} from "../lib/intraday-signals";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yahooFinance = new (YahooFinance as any)({ suppressNotices: ["yahooSurvey"] });

const router: IRouter = Router();

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

    // ── Market session context ────────────────────────────────────────────────
    const marketHours    = getMarketHours(now);
    const marketState    = getMarketState(now, marketHours);
    const sessionMinutes = now >= marketHours.marketOpen
      ? Math.round((now.getTime() - marketHours.marketOpen.getTime()) / 60000)
      : 0;

    // ── Gemini qualitative overlay ────────────────────────────────────────────
    const prompt = buildIntradayPrompt({
      symbol, spot, q, signalScore, levels: intradayLevels,
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
      signalScore,
      tradeSetup,
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const histQuotes: any[] = history.status === "fulfilled" ? history.value?.quotes ?? [] : [];
    const closes  = histQuotes.map((p: any) => p.close).filter(Boolean) as number[];
    const highs   = histQuotes.map((p: any) => p.high).filter(Boolean)  as number[];
    const lows    = histQuotes.map((p: any) => p.low).filter(Boolean)   as number[];

    const rsi  = calcRSI(closes);
    const { macd, histogram } = calcMACD(closes);
    const atr  = calcATR(highs, lows, closes);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let allChains: any[] = [];
    if (optionsData.status === "fulfilled" && optionsData.value?.options?.length) {
      allChains = optionsData.value.options.slice(0, 3);
    }

    const chainSummary = allChains.map((chain: any) => {
      const expDate = new Date(chain.expirationDate).toDateString();
      const calls: any[] = (chain.calls || []).filter((c: any) => c.volume > 0).sort((a: any, b: any) => (b.openInterest || 0) - (a.openInterest || 0)).slice(0, 5);
      const puts:  any[] = (chain.puts  || []).filter((p: any) => p.volume > 0).sort((a: any, b: any) => (b.openInterest || 0) - (a.openInterest || 0)).slice(0, 5);
      return `Expiry: ${expDate}
  Calls: ${calls.map((c: any) => `$${c.strike} IV=${c.impliedVolatility ? (c.impliedVolatility * 100).toFixed(0) : "?"}% OI=${c.openInterest} vol=${c.volume}`).join(" | ")}
  Puts:  ${puts.map((p: any) => `$${p.strike} IV=${p.impliedVolatility ? (p.impliedVolatility * 100).toFixed(0) : "?"}% OI=${p.openInterest} vol=${p.volume}`).join(" | ")}`;
    });

    const prompt = `You are an elite options strategist. Design the best options strategy for a trader deploying capital in ${symbol}. Choose the structure — which strikes, expiries, and legs to use. Premiums, max profit/loss, and probability will be computed from live market data afterward.

STOCK DATA:
Symbol: ${symbol}  |  Price: $${currentPrice.toFixed(2)}
Change: ${q.regularMarketChange?.toFixed(2) ?? "0"} (${q.regularMarketChangePercent?.toFixed(2) ?? "0"}%)
RSI(14-day): ${rsi?.toFixed(1) ?? "N/A"}  |  MACD histogram: ${histogram?.toFixed(3) ?? "N/A"}
ATR(14-day): $${atr?.toFixed(2) ?? "N/A"}

AVAILABLE OPTIONS CHAINS (choose strikes/expiries ONLY from these):
${chainSummary.length ? chainSummary.join("\n\n") : "No options data available"}

TRADER CAPITAL: $${investmentAmount.toLocaleString()}

Choose ONE strategy from: Long Call, Long Put, Bull Call Spread, Bear Put Spread, Iron Condor, Straddle, Strangle, Covered Call, Cash-Secured Put, Butterfly Spread. Prefer defined-risk strategies unless capital > $10,000.

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
  "reasoning": "<3-4 sentences: why this strategy, these strikes/expiry, what's the catalyst>",
  "entryTiming": "<specific entry conditions and timing>",
  "exitStrategy": "<take profit, stop loss, and time decay management>"
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

    const aiLegs: any[] = Array.isArray(aiOutput.legs) ? aiOutput.legs : [];
    if (!aiLegs.length) {
      res.status(500).json({ error: "AI did not return a valid strategy structure" });
      return;
    }

    // Resolve each leg to a real contract from the fetched chain
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
      const chain  = allChains.find((c: any) => new Date(c.expirationDate).toDateString() === leg.expiry) ?? allChains[0];
      if (!chain) continue;
      const pool: any[] = leg.type === "put" ? chain.puts || [] : chain.calls || [];
      if (!pool.length) continue;
      const targetStrike = typeof leg.strike === "number" ? leg.strike : pool[0].strike;
      const contract     = pool.reduce((best: any, c: any) => Math.abs(c.strike - targetStrike) < Math.abs(best.strike - targetStrike) ? c : best, pool[0]);
      const midPrice     = contract.bid > 0 && contract.ask > 0 ? (contract.bid + contract.ask) / 2 : contract.lastPrice;
      const expiryDate   = new Date(chain.expirationDate);
      if (!earliestExpiry || expiryDate < earliestExpiry) earliestExpiry = expiryDate;
      const T  = timeToExpiryYears(expiryDate, now);
      const iv = contract.impliedVolatility;
      if (iv > 0) ivSamples.push(iv);
      const bs = iv > 0 ? blackScholes({ spot: currentPrice, strike: contract.strike, timeToExpiryYears: T, riskFreeRate: r, volatility: iv, optionType: leg.type === "put" ? "put" : "call" }) : null;
      usedContracts.push({ label: `${leg.type.toUpperCase()} $${contract.strike}`, volume: contract.volume, openInterest: contract.openInterest, bid: contract.bid, ask: contract.ask });
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
      res.status(422).json({ error: `The ${aiOutput.strategyName ?? "selected strategy"} requires at least $${requiredCapitalPerUnit.toLocaleString(undefined, { maximumFractionDigits: 2 })} per contract, which exceeds your $${investmentAmount.toLocaleString()} budget. Try a larger amount or ask for a narrower spread.` });
      return;
    } else {
      multiplier = Math.max(1, Math.floor(investmentAmount / requiredCapitalPerUnit));
    }
    multiplier = Math.min(multiplier, 500);

    const scaledLegs  = resolvedLegs.map((leg) => ({ ...leg, contracts: leg.contracts * multiplier }));
    const finalMetrics = computeStrategyMetrics({
      legs: scaledLegs, spot: currentPrice,
      avgVolatility: ivSamples.length ? ivSamples.reduce((a, b) => a + b, 0) / ivSamples.length : 0.3,
      timeToExpiryYears: earliestExpiry ? timeToExpiryYears(earliestExpiry, now) : 30 / 365,
      riskFreeRate: r,
    });

    const dataQuality = assessDataQuality({ quoteTimeMs: q.regularMarketTime ? new Date(q.regularMarketTime).getTime() : null, now, contracts: usedContracts });
    (dataQuality as any).riskFreeRate = +(r * 100).toFixed(2);
    if (unlimitedRiskWarning) dataQuality.liquidityWarnings.push(unlimitedRiskWarning);

    const formatMoney = (v: number | "unlimited") =>
      v === "unlimited" ? "Unlimited" : `$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}${v < 0 ? " (loss)" : ""}`;

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
      totalCost: finalMetrics.netCost,
      maxProfit: formatMoney(finalMetrics.maxProfit),
      maxLoss:   formatMoney(finalMetrics.maxLoss),
      breakeven:  finalMetrics.breakevens.length ? finalMetrics.breakevens.map((b) => `$${b.toFixed(2)}`).join(" / ") : "N/A",
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
});

// ─── GET /finance/top-pick ─────────────────────────────────────────────────────
// Scans a watchlist, picks the highest-conviction actionable setup, and
// auto-generates a ≤$100 options strategy for it.

const TOP_PICK_WATCHLIST = [
  "AAPL","MSFT","NVDA","AMZN","TSLA","META","GOOGL",
  "SPY","QQQ","AMD","NFLX","JPM","AVGO","COST","XOM",
];

// Cache top-pick result for 2 minutes so refreshes are instant
let topPickCache: { result: unknown; cachedAt: number } | null = null;
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

  const [quote, minuteData, fiveMinData, fifteenMinData, dailyData] = await Promise.allSettled([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (yahooFinance as any).quote(symbol) as Promise<any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (yahooFinance as any).chart(symbol, { period1: threeDaysAgo,  period2: now, interval: "1m"  }) as Promise<any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (yahooFinance as any).chart(symbol, { period1: tenDaysAgo,    period2: now, interval: "5m"  }) as Promise<any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (yahooFinance as any).chart(symbol, { period1: tenDaysAgo,    period2: now, interval: "15m" }) as Promise<any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (yahooFinance as any).chart(symbol, { period1: thirtyDaysAgo, period2: now, interval: "1d"  }) as Promise<any>,
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
  if (topPickCache && Date.now() - topPickCache.cachedAt < TOP_PICK_TTL_MS) {
    res.json(topPickCache.result);
    return;
  }
  try {
    const now = new Date();

    // Score all watchlist symbols concurrently
    const raw = await Promise.allSettled(
      TOP_PICK_WATCHLIST.map((sym) => scoreSymbol(sym, now)),
    );

    const scored = raw
      .filter((r): r is PromiseFulfilledResult<NonNullable<Awaited<ReturnType<typeof scoreSymbol>>>> =>
        r.status === "fulfilled" && r.value !== null,
      )
      .map((r) => r.value)
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
      let allChains: any[] = [];
      if (optionsData.status === "fulfilled" && optionsData.value?.options?.length) {
        allChains = optionsData.value.options.slice(0, 3);
      }

      const chainSummary = allChains.map((chain: any) => {
        const expDate = new Date(chain.expirationDate).toDateString();
        const calls: any[] = (chain.calls || []).filter((c: any) => c.volume > 0 && (c.lastPrice ?? 0) <= 1.0).sort((a: any, b: any) => (b.openInterest || 0) - (a.openInterest || 0)).slice(0, 5);
        const puts:  any[] = (chain.puts  || []).filter((p: any) => p.volume > 0 && (p.lastPrice ?? 0) <= 1.0).sort((a: any, b: any) => (b.openInterest || 0) - (a.openInterest || 0)).slice(0, 5);
        const allCalls: any[] = (chain.calls || []).filter((c: any) => c.volume > 0).sort((a: any, b: any) => (b.openInterest || 0) - (a.openInterest || 0)).slice(0, 5);
        const allPuts:  any[] = (chain.puts  || []).filter((p: any) => p.volume > 0).sort((a: any, b: any) => (b.openInterest || 0) - (a.openInterest || 0)).slice(0, 5);
        const callList = calls.length ? calls : allCalls;
        const putList  = puts.length  ? puts  : allPuts;
        return `Expiry: ${expDate}
  Calls (≤$1.00 pref): ${callList.map((c: any) => `${c.strike} IV=${c.impliedVolatility ? (c.impliedVolatility * 100).toFixed(0) : "?"}% OI=${c.openInterest} vol=${c.volume} last=${c.lastPrice?.toFixed(2)}`).join(" | ")}
  Puts  (≤$1.00 pref): ${putList.map((p: any) => `${p.strike} IV=${p.impliedVolatility ? (p.impliedVolatility * 100).toFixed(0) : "?"}% OI=${p.openInterest} vol=${p.volume} last=${p.lastPrice?.toFixed(2)}`).join(" | ")}`;
      });

      const bias = winner.tradeSetup.bias;
      const prompt = `You are an elite options strategist. Design the best options strategy for a trader with only ${BUDGET} to deploy in ${winner.symbol}.

STOCK DATA:
Symbol: ${winner.symbol}  |  Price: ${winner.price.toFixed(2)}
Intraday bias: ${bias.toUpperCase()} — setup: ${winner.tradeSetup.setupType} (${winner.signalScore.conviction}% conviction)
RSI(14-day): ${rsi?.toFixed(1) ?? "N/A"}  |  MACD histogram: ${histogram?.toFixed(3) ?? "N/A"}
ATR(14-day): ${atr?.toFixed(2) ?? "N/A"}

AVAILABLE OPTIONS CHAINS (prefer contracts with last price ≤ $1.00 so total cost stays under $100):
${chainSummary.length ? chainSummary.join("\n\n") : "No options data available"}

CONSTRAINT: Total strategy cost MUST be ≤ ${BUDGET}. This means:
- For single-leg: choose a strike where the premium × 100 ≤ ${BUDGET} (i.e. premium ≤ ${(BUDGET / 100).toFixed(2)})
- For spreads: net debit × 100 ≤ ${BUDGET}
- The intraday bias is ${bias.toUpperCase()}, so prefer ${bias === "short" ? "puts or bearish spreads" : "calls or bullish spreads"}.

Choose ONE strategy: Long Call, Long Put, Bull Call Spread, Bear Put Spread. Prefer defined-risk, low-cost structures.

Return ONLY valid JSON (no markdown):
{
  "strategyName": "<strategy name>",
  "strategyType": "bullish" | "bearish" | "neutral" | "volatile",
  "legs": [
    { "type": "call" | "put", "action": "buy" | "sell", "strike": <number>, "expiry": "<date string matching an available expiry>", "contractRatio": 1 }
  ],
  "riskLevel": "low" | "medium" | "high",
  "reasoning": "<2-3 sentences: why this strategy fits the ${BUDGET} budget and the ${bias} setup>",
  "exitStrategy": "<take profit at 50-100% gain, cut at 50% loss>"
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
          // If cost > budget, check if we can still present it (e.g. tight spread)
          const affordable = netCostPerUnit <= BUDGET;

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
            probability:   unitMetrics.probabilityOfProfit ?? 50,
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
    topPickCache = { result: payload, cachedAt: Date.now() };
    res.json(payload);
  } catch (err: unknown) {
    res.status(500).json({ error: "Failed to compute top pick" });
  }
});

export default router;
