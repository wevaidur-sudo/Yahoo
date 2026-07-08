import { Router, type IRouter } from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
// eslint-disable-next-line @typescript-eslint/no-require-imports
import YahooFinance from "yahoo-finance2";

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

    // Fetch all data in parallel
    const [quote, history, summary, newsResult, optionsData] =
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
      ]);

    if (quote.status === "rejected") {
      res.status(404).json({ error: `Symbol not found: ${symbol}` });
      return;
    }

    const q = quote.value;
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

    // ── Options chain summary
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let optChain: any = null;
    let putCallRatio: number | null = null;
    if (optionsData.status === "fulfilled" && optionsData.value?.options?.length) {
      const chain = optionsData.value.options[0];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calls: any[] = chain.calls || [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const puts: any[] = chain.puts || [];
      const totalCallVol = calls.reduce((s: number, c: any) => s + (c.volume || 0), 0);
      const totalPutVol = puts.reduce((s: number, p: any) => s + (p.volume || 0), 0);
      putCallRatio = totalCallVol ? +(totalPutVol / totalCallVol).toFixed(2) : null;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const topCalls = [...calls].sort((a: any, b: any) => (b.volume || 0) - (a.volume || 0)).slice(0, 3);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const topPuts = [...puts].sort((a: any, b: any) => (b.volume || 0) - (a.volume || 0)).slice(0, 3);

      optChain = {
        expirationDate: chain.expirationDate,
        topCalls: topCalls.map((c: any) => ({
          strike: c.strike,
          lastPrice: c.lastPrice,
          volume: c.volume,
          openInterest: c.openInterest,
          impliedVolatility: c.impliedVolatility ? +(c.impliedVolatility * 100).toFixed(1) : null,
          inTheMoney: c.inTheMoney,
        })),
        topPuts: topPuts.map((p: any) => ({
          strike: p.strike,
          lastPrice: p.lastPrice,
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

    // ── Fundamentals
    const summaryData =
      summary.status === "fulfilled" ? summary.value : null;

    // ── Build Gemini prompt
    const prompt = `You are a professional quantitative analyst and options trader with 20+ years of experience. Analyze the following real-time stock data and deliver sharp, high-precision, actionable predictions. Be bold — not generic.

STOCK: ${symbol}
Current Price: $${q.regularMarketPrice?.toFixed(2) ?? "N/A"}
Change: ${q.regularMarketChange?.toFixed(2) ?? "0"} (${q.regularMarketChangePercent?.toFixed(2) ?? "0"}%)
Day Range: $${q.regularMarketDayLow?.toFixed(2) ?? "?"} – $${q.regularMarketDayHigh?.toFixed(2) ?? "?"}
52W Range: $${q.fiftyTwoWeekLow?.toFixed(2) ?? "?"} – $${q.fiftyTwoWeekHigh?.toFixed(2) ?? "?"}
Market State: ${q.marketState ?? "REGULAR"}
Volume: ${(q.regularMarketVolume || 0).toLocaleString()} vs Avg ${Math.round(avgVol || 0).toLocaleString()}
Market Cap: $${q.marketCap ? (q.marketCap / 1e9).toFixed(2) + "B" : "N/A"}
Beta: ${summaryData?.summaryDetail?.beta?.toFixed(2) ?? "N/A"}
P/E (Trailing): ${summaryData?.summaryDetail?.trailingPE?.toFixed(2) ?? "N/A"}
Forward P/E: ${summaryData?.summaryDetail?.forwardPE?.toFixed(2) ?? "N/A"}

TECHNICAL INDICATORS:
- RSI(14): ${technicalIndicators.rsi ?? "N/A"} ${technicalIndicators.rsi !== null ? (technicalIndicators.rsi > 70 ? "(OVERBOUGHT)" : technicalIndicators.rsi < 30 ? "(OVERSOLD)" : "(NEUTRAL)") : ""}
- MACD: ${technicalIndicators.macd ?? "N/A"} | Signal: ${technicalIndicators.macdSignal ?? "N/A"} | Histogram: ${technicalIndicators.macdHistogram ?? "N/A"}
- Bollinger Bands: Upper $${technicalIndicators.bollingerUpper ?? "?"} | Mid $${technicalIndicators.bollingerMiddle ?? "?"} | Lower $${technicalIndicators.bollingerLower ?? "?"}
- SMA 20: $${technicalIndicators.sma20 ?? "N/A"} | SMA 50: $${technicalIndicators.sma50 ?? "N/A"} | SMA 200: $${technicalIndicators.sma200 ?? "N/A"}
- ATR(14): ${technicalIndicators.atr ?? "N/A"} (daily volatility range)
- Volume Ratio (today vs 20d avg): ${technicalIndicators.volumeRatio ?? "N/A"}x

OPTIONS CHAIN (nearest expiry${optChain?.expirationDate ? ": " + new Date(optChain.expirationDate).toDateString() : ""}):
${optChain ? `- Put/Call Ratio: ${optChain.putCallRatio ?? "N/A"}
- Top Calls by Volume: ${optChain.topCalls.map((c: any) => `$${c.strike} (IV ${c.impliedVolatility}%, vol ${c.volume}, OI ${c.openInterest})`).join(" | ")}
- Top Puts by Volume: ${optChain.topPuts.map((p: any) => `$${p.strike} (IV ${p.impliedVolatility}%, vol ${p.volume}, OI ${p.openInterest})`).join(" | ")}` : "Options data unavailable"}

RECENT NEWS:
${headlines.length ? headlines.map((h, i) => `${i + 1}. ${h}`).join("\n") : "No recent news available"}

Return ONLY a valid JSON object with this exact structure (no markdown, no explanation outside JSON):
{
  "trend": {
    "direction": "bullish" | "bearish" | "neutral",
    "confidence": <integer 0-100>,
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
    "putCallRatio": <number or null>,
    "unusualActivity": "<describe any notable flow or activity>",
    "topCallPick": { "strike": <number>, "expiry": "<date string>", "premium": <number or null>, "rationale": "<why this call>" },
    "topPutPick": { "strike": <number>, "expiry": "<date string>", "premium": <number or null>, "rationale": "<why this put>" }
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

    res.json({
      symbol,
      generatedAt: new Date().toISOString(),
      trend: aiOutput.trend,
      intraday: aiOutput.intraday,
      technicalIndicators,
      optionsSnapshot: aiOutput.optionsSnapshot ?? null,
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

      const [quote, history, optionsData] = await Promise.allSettled([
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
      ]);

      if (quote.status === "rejected") {
        res.status(404).json({ error: `Symbol not found: ${symbol}` });
        return;
      }

      const q = quote.value;
      const currentPrice: number = q.regularMarketPrice ?? 0;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const histQuotes: any[] =
        history.status === "fulfilled" ? history.value?.quotes || [] : [];
      const closes = histQuotes.map((p: any) => p.close).filter(Boolean) as number[];
      const highs = histQuotes.map((p: any) => p.high).filter(Boolean) as number[];
      const lows = histQuotes.map((p: any) => p.low).filter(Boolean) as number[];

      const rsi = calcRSI(closes);
      const { macd, histogram } = calcMACD(closes);
      const atr = calcATR(highs, lows, closes);

      // ── Options chains for nearest 3 expiries
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let allChains: any[] = [];
      if (optionsData.status === "fulfilled" && optionsData.value?.options?.length) {
        allChains = optionsData.value.options.slice(0, 3);
      }

      const chainSummary = allChains.map((chain: any) => {
        const expDate = new Date(chain.expirationDate).toDateString();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const calls: any[] = (chain.calls || [])
          .filter((c: any) => c.volume > 0)
          .sort((a: any, b: any) => (b.openInterest || 0) - (a.openInterest || 0))
          .slice(0, 5);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const puts: any[] = (chain.puts || [])
          .filter((p: any) => p.volume > 0)
          .sort((a: any, b: any) => (b.openInterest || 0) - (a.openInterest || 0))
          .slice(0, 5);

        return `Expiry: ${expDate}
  Calls: ${calls.map((c: any) => `$${c.strike} last=$${c.lastPrice?.toFixed(2)} IV=${c.impliedVolatility ? (c.impliedVolatility * 100).toFixed(0) : "?"}% OI=${c.openInterest} vol=${c.volume} ITM=${c.inTheMoney}`).join(" | ")}
  Puts:  ${puts.map((p: any) => `$${p.strike} last=$${p.lastPrice?.toFixed(2)} IV=${p.impliedVolatility ? (p.impliedVolatility * 100).toFixed(0) : "?"}% OI=${p.openInterest} vol=${p.volume} ITM=${p.inTheMoney}`).join(" | ")}`;
      });

      const prompt = `You are an elite options strategist with 20+ years of experience managing multi-million-dollar derivatives portfolios. A trader wants to deploy capital in ${symbol} options.

STOCK DATA:
Symbol: ${symbol}
Current Price: $${currentPrice.toFixed(2)}
Change Today: ${q.regularMarketChange?.toFixed(2) ?? "0"} (${q.regularMarketChangePercent?.toFixed(2) ?? "0"}%)
Beta: ${q.beta?.toFixed(2) ?? "N/A"}
52W Range: $${q.fiftyTwoWeekLow?.toFixed(2) ?? "?"} – $${q.fiftyTwoWeekHigh?.toFixed(2) ?? "?"}
RSI(14): ${rsi?.toFixed(1) ?? "N/A"}
MACD: ${macd?.toFixed(3) ?? "N/A"} | Histogram: ${histogram?.toFixed(3) ?? "N/A"}
ATR(14): $${atr?.toFixed(2) ?? "N/A"}

AVAILABLE OPTIONS CHAINS:
${chainSummary.length ? chainSummary.join("\n\n") : "No options data available"}

TRADER'S CAPITAL: $${investmentAmount.toLocaleString()}

Design the SINGLE best options strategy that:
1. Fits within the $${investmentAmount.toLocaleString()} budget
2. Maximizes profit probability given the technical setup
3. Has clearly defined risk — no undefined risk strategies unless capital is > $10,000

Choose from: Long Call, Long Put, Bull Call Spread, Bear Put Spread, Iron Condor, Straddle, Strangle, Covered Call, Cash-Secured Put, or Butterfly Spread.

Return ONLY valid JSON (no markdown):
{
  "strategyName": "<strategy name>",
  "strategyType": "bullish" | "bearish" | "neutral" | "volatile",
  "legs": [
    {
      "type": "call" | "put" | "stock",
      "action": "buy" | "sell",
      "strike": <number or null>,
      "expiry": "<date string or null>",
      "premium": <number per share or null>,
      "contracts": <integer>
    }
  ],
  "totalCost": <total capital required as number>,
  "maxProfit": "<describe max profit precisely, e.g. '$1,240 per contract'>",
  "maxLoss": "<describe max loss precisely>",
  "breakeven": "<breakeven price(s)>",
  "probability": <estimated probability of profit 0-100>,
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

      res.json({
        symbol,
        investmentAmount,
        ...aiOutput,
      });
    } catch (err: unknown) {
      req.log.error({ err, symbol }, "Options strategy error");
      res.status(500).json({ error: "Failed to generate options strategy" });
    }
  },
);

export default router;
