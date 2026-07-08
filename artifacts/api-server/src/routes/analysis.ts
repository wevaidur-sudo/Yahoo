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

function calcEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    ema.push(values[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function calcRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcMACD(closes: number[]): {
  macd: number | null;
  signal: number | null;
  histogram: number | null;
} {
  if (closes.length < 35)
    return { macd: null, signal: null, histogram: null };
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = calcEMA(macdLine.slice(-9), 9);
  const lastMacd = macdLine[macdLine.length - 1];
  const lastSignal = signalLine[signalLine.length - 1];
  return {
    macd: lastMacd,
    signal: lastSignal,
    histogram: lastMacd - lastSignal,
  };
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
          modules: ["summaryDetail", "defaultKeyStatistics", "financialData"],
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

    // ── News headlines
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const headlines: string[] =
      newsResult.status === "fulfilled"
        ? (newsResult.value?.news || [])
            .slice(0, 5)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((n: any) => n.title)
            .filter(Boolean)
        : [];

    const summaryData = summary.status === "fulfilled" ? summary.value : null;

    // ── Build Gemini prompt — ask ONLY for qualitative judgment + a strike choice.
    // All prices/probabilities/greeks for the chosen contracts are computed
    // afterward with Black-Scholes from real market IV, never invented by the model.
    const prompt = `You are a professional quantitative analyst with 20+ years of experience. Analyze the following real-time stock data and give a sharp, well-reasoned qualitative read. Do NOT invent precise dollar figures for options premiums or probabilities — those will be computed separately from live market data. You MAY reference the technical levels and news given.

STOCK: ${symbol}
Current Price: $${spot.toFixed(2)}
Change: ${q.regularMarketChange?.toFixed(2) ?? "0"} (${q.regularMarketChangePercent?.toFixed(2) ?? "0"}%)
Day Range: $${q.regularMarketDayLow?.toFixed(2) ?? "?"} – $${q.regularMarketDayHigh?.toFixed(2) ?? "?"}
52W Range: $${q.fiftyTwoWeekLow?.toFixed(2) ?? "?"} – $${q.fiftyTwoWeekHigh?.toFixed(2) ?? "?"}
Market State: ${q.marketState ?? "REGULAR"}
Volume: ${(q.regularMarketVolume || 0).toLocaleString()} vs Avg ${Math.round(avgVol || 0).toLocaleString()}
Market Cap: $${q.marketCap ? (q.marketCap / 1e9).toFixed(2) + "B" : "N/A"}
Beta: ${summaryData?.summaryDetail?.beta?.toFixed(2) ?? "N/A"}
P/E (Trailing): ${summaryData?.summaryDetail?.trailingPE?.toFixed(2) ?? "N/A"}

TECHNICAL INDICATORS:
- RSI(14): ${technicalIndicators.rsi ?? "N/A"} ${technicalIndicators.rsi !== null ? (technicalIndicators.rsi > 70 ? "(OVERBOUGHT)" : technicalIndicators.rsi < 30 ? "(OVERSOLD)" : "(NEUTRAL)") : ""}
- MACD: ${technicalIndicators.macd ?? "N/A"} | Signal: ${technicalIndicators.macdSignal ?? "N/A"} | Histogram: ${technicalIndicators.macdHistogram ?? "N/A"}
- Bollinger Bands: Upper $${technicalIndicators.bollingerUpper ?? "?"} | Mid $${technicalIndicators.bollingerMiddle ?? "?"} | Lower $${technicalIndicators.bollingerLower ?? "?"}
- SMA 20: $${technicalIndicators.sma20 ?? "N/A"} | SMA 50: $${technicalIndicators.sma50 ?? "N/A"} | SMA 200: $${technicalIndicators.sma200 ?? "N/A"}
- ATR(14): ${technicalIndicators.atr ?? "N/A"}
- Volume Ratio: ${technicalIndicators.volumeRatio ?? "N/A"}x

AVAILABLE OPTIONS CONTRACTS (nearest expiry${optChain?.expirationDate ? ": " + new Date(optChain.expirationDate).toDateString() : ""}) — choose your top pick strike ONLY from these lists:
${optChain ? `Put/Call Volume Ratio: ${optChain.putCallRatio ?? "N/A"}
Calls: ${optChain.topCalls.map((c: any) => `$${c.strike} (IV ${c.impliedVolatility}%, vol ${c.volume}, OI ${c.openInterest})`).join(" | ")}
Puts: ${optChain.topPuts.map((p: any) => `$${p.strike} (IV ${p.impliedVolatility}%, vol ${p.volume}, OI ${p.openInterest})`).join(" | ")}` : "Options data unavailable"}

RECENT NEWS:
${headlines.length ? headlines.map((h, i) => `${i + 1}. ${h}`).join("\n") : "No recent news available"}

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
      model: "gemini-2.5-flash",
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
        model: "gemini-2.5-flash",
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
          error: `The ${aiOutput.strategyName ?? "selected strategy"} requires at least ${requiredCapitalPerUnit.toLocaleString(undefined, { maximumFractionDigits: 2 })} of capital per contract, which exceeds your ${investmentAmount.toLocaleString()} budget. Try a larger amount or ask for a narrower spread.`,
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
