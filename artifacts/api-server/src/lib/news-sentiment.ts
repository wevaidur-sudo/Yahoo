/**
 * News catalyst sentiment scorer — Gemini-powered numeric signal.
 *
 * News headlines and earnings releases are genuinely LEADING indicators:
 * an earnings beat at 7 AM is causal for the 9:30 AM move, not a consequence
 * of it. This module asks Gemini to score the news specifically for its
 * intraday directional implication, then converts that to a signal weight
 * that feeds into the conviction score BEFORE price confirms it.
 *
 * MAX contribution: ±15 pts
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

export interface NewsSentimentResult {
  direction: "bullish" | "bearish" | "neutral";
  /** Score range: -15 (strongly bearish news) to +15 (strongly bullish news) */
  score: number;
  /** Raw Gemini sentiment score: -100 to +100 */
  rawScore: number;
  /** Whether an earnings event is the primary driver */
  isEarningsDriven: boolean;
  /** Gemini's one-sentence catalyst summary */
  catalystSummary: string;
  note: string;
}

function buildSentimentPrompt(params: {
  symbol: string;
  spot: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  newsItems: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  quote: any;
}): string {
  const { symbol, spot, newsItems, quote } = params;

  const newsStr = newsItems.length
    ? newsItems.slice(0, 6).map((n: any, i: number) => {
        const ageSecs = n.providerPublishTime
          ? Math.round(Date.now() / 1000 - n.providerPublishTime)
          : null;
        const age = ageSecs != null
          ? (ageSecs < 3600 ? `${Math.round(ageSecs / 60)}m` : `${Math.round(ageSecs / 3600)}h`) + " ago"
          : "recent";
        return `${i + 1}. [${age}] ${n.title}`;
      }).join("\n")
    : "No recent news available";

  const earningsNote = quote.earningsTimestamp
    ? `Next earnings: ${new Date(quote.earningsTimestamp * 1000).toDateString()}`
    : "No upcoming earnings date available";

  return `You are a quantitative news analyst scoring stock news for its INTRADAY directional impact TODAY ONLY.

Symbol: ${symbol} | Current Price: $${spot.toFixed(2)}
Change: ${(quote.regularMarketChangePercent ?? 0).toFixed(2)}%
${earningsNote}

Recent News:
${newsStr}

Score the INTRADAY directional impact of this news on a scale from -100 to +100:
- +100: Extremely bullish catalyst (earnings beat, major upgrade, M&A takeover premium)
- +50:  Moderately bullish (positive guidance, analyst upgrade, positive macro data)
- 0:    Neutral or mixed news / no meaningful catalyst
- -50:  Moderately bearish (earnings miss, downgrade, margin pressure)
- -100: Extremely bearish catalyst (massive earnings miss, accounting fraud, regulatory block)

Consider ONLY news from the last 24 hours. Old news (>1 day) should NOT influence the score.
If the news is clearly pre-priced (stock already moved significantly), reduce score magnitude by 50%.

Return ONLY valid JSON:
{
  "sentimentScore": <integer from -100 to +100>,
  "isEarningsDriven": <true | false>,
  "catalystSummary": "<one sentence: what is the key catalyst and its direction>",
  "confidence": <integer 0-100: how confident are you in this assessment>
}`;
}

export async function scoreNewsSentiment(params: {
  symbol: string;
  spot: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  newsItems: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  quote: any;
  geminiApiKey: string;
}): Promise<NewsSentimentResult> {
  const { symbol, spot, newsItems, quote, geminiApiKey } = params;

  // No-news fast path
  if (!newsItems.length) {
    return {
      direction: "neutral", score: 0, rawScore: 0,
      isEarningsDriven: false,
      catalystSummary: "No recent news available",
      note: "No news catalysts detected — direction driven purely by technical signals",
    };
  }

  try {
    const key = geminiApiKey || (process.env["GEMINI_API_KEY"] ?? "");
    if (!key) throw new Error("GEMINI_API_KEY not set");
    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({
      model: "gemini-3.1-flash-lite",
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 256,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });

    const prompt = buildSentimentPrompt({ symbol, spot, newsItems, quote });
    const result = await model.generateContent(prompt);
    const text   = result.response.text();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Gemini returned invalid JSON for sentiment");
    }

    const rawScore: number = typeof parsed.sentimentScore === "number"
      ? Math.max(-100, Math.min(100, Math.round(parsed.sentimentScore)))
      : 0;

    // Normalize raw score (-100 to +100) → signal score (-15 to +15)
    // Only apply weight when score is meaningful (|raw| >= 20)
    let score = 0;
    if (Math.abs(rawScore) >= 20) {
      score = Math.round((rawScore / 100) * 15);
    }

    const direction: NewsSentimentResult["direction"] =
      score > 3 ? "bullish" : score < -3 ? "bearish" : "neutral";

    const isEarningsDriven = !!parsed.isEarningsDriven;
    const catalystSummary  = typeof parsed.catalystSummary === "string"
      ? parsed.catalystSummary
      : "No significant catalyst identified";

    let note: string;
    if (Math.abs(rawScore) >= 60) {
      note = `${direction === "bullish" ? "Strong bullish" : "Strong bearish"} catalyst: ${catalystSummary} (sentiment ${rawScore > 0 ? "+" : ""}${rawScore}/100)`;
    } else if (Math.abs(rawScore) >= 20) {
      note = `Moderate ${direction} news bias: ${catalystSummary} (sentiment ${rawScore > 0 ? "+" : ""}${rawScore}/100)`;
    } else {
      note = `Neutral/mixed news — no meaningful catalyst: ${catalystSummary}`;
    }

    return { direction, score, rawScore, isEarningsDriven, catalystSummary, note };

  } catch {
    return {
      direction: "neutral", score: 0, rawScore: 0,
      isEarningsDriven: false,
      catalystSummary: "News sentiment analysis unavailable",
      note: "News sentiment scoring failed — excluded from conviction calculation",
    };
  }
}
