/**
 * Basic backtest harness for the intraday signal engine + trade setup generator.
 *
 * Purpose: replace "the weights feel reasonable" with actual historical
 * evidence — win rate, average R-multiple, and expectancy per setup type
 * and conviction bucket, computed by replaying the exact same deterministic
 * code path used in production (`computeIntradayLevels`, `computeIntradaySignals`,
 * `generateTradeSetup`) against real historical bars.
 *
 * KNOWN LIMITATIONS (read before trusting the numbers):
 *  - Yahoo's free 5m bars only go back ~60 days, and do NOT include pre/post
 *    market bars, so pre-market H/L signals are always null in this backtest
 *    (they DO work live, where the app fetches 1m bars with pre/post included).
 *  - No commissions, spread, or slippage modeled — entries/exits assume fills
 *    at the exact printed price.
 *  - Only 3 fixed decision times per day are tested, not continuous monitoring.
 *  - Sample size (~8 symbols x ~45 usable days x 3 windows) is a starting
 *    point, not statistically conclusive — treat this as a smoke test for
 *    "is the expectancy at least positive and are the weights directionally
 *    sane," not a certification of profitability.
 */

import YahooFinance from "yahoo-finance2";
import {
  parseYahooBars,
  computeIntradayLevels,
  getETOffset,
  type IntradayBar,
} from "../lib/intraday";
import { computeIntradaySignals, generateTradeSetup } from "../lib/intraday-signals";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yahooFinance = new (YahooFinance as any)({ suppressNotices: ["yahooSurvey"] });

const SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMZN", "TSLA", "META", "GOOGL", "SPY"];

// Decision times to test, in ET decimal hours — matches the app's own
// "best entry window" guidance (opening momentum, late morning, afternoon).
const DECISION_TIMES_ET = [10.25, 11.0, 13.75];

// ─── Local copies of the indicator helpers used in analysis.ts ────────────────
// (Kept local rather than importing from the route file, which isn't a module
// meant to be imported elsewhere.)

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

function calcMACDHistogram(closes: number[]): number | null {
  if (closes.length < 34) return null;
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12.map((v, i) => (isNaN(v) || isNaN(ema26[i]) ? NaN : v - ema26[i]));
  const validMacd = macdLine.filter((v) => !isNaN(v));
  if (validMacd.length < 9) return null;
  const signalArr = calcEMA(validMacd, 9);
  const lastMacd = validMacd[validMacd.length - 1];
  const lastSignal = signalArr[signalArr.length - 1];
  if (isNaN(lastSignal)) return null;
  return lastMacd - lastSignal;
}

/** Resample 5m bars into 15m bars by grouping every 3 consecutive bars. */
function resampleTo15m(bars: IntradayBar[]): IntradayBar[] {
  const out: IntradayBar[] = [];
  for (let i = 0; i < bars.length; i += 3) {
    const chunk = bars.slice(i, i + 3);
    if (chunk.length === 0) continue;
    out.push({
      timestamp: chunk[0].timestamp,
      open: chunk[0].open,
      high: Math.max(...chunk.map((b) => b.high)),
      low: Math.min(...chunk.map((b) => b.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, b) => s + b.volume, 0),
    });
  }
  return out;
}

/** ET calendar-day key (YYYY-MM-DD in ET) for a UTC timestamp. */
function etDateKey(d: Date): string {
  const offset = getETOffset(d);
  const et = new Date(d.getTime() - offset * 3600_000);
  return et.toISOString().slice(0, 10);
}

interface TradeResult {
  symbol: string;
  date: string;
  decisionEt: number;
  setupType: string;
  bias: "long" | "short";
  conviction: number;
  rrRatio1: number;
  outcome: "win" | "loss" | "open-at-close";
  rMultiple: number;
}

async function fetchBars(symbol: string, interval: "5m" | "1d", days: number): Promise<IntradayBar[]> {
  const period2 = new Date();
  const period1 = new Date(period2.getTime() - days * 86400_000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (await (yahooFinance as any).chart(symbol, {
    period1,
    period2,
    interval,
  })) as any;
  return parseYahooBars(result?.quotes ?? []);
}

async function backtestSymbol(symbol: string): Promise<{ trades: TradeResult[]; noTradeCount: number; errors: number }> {
  const trades: TradeResult[] = [];
  let noTradeCount = 0;
  let errors = 0;

  let bars5m: IntradayBar[];
  let dailyBars: IntradayBar[];
  try {
    [bars5m, dailyBars] = await Promise.all([
      fetchBars(symbol, "5m", 58),
      fetchBars(symbol, "1d", 150),
    ]);
  } catch (err) {
    console.error(`  [${symbol}] fetch failed:`, (err as Error).message);
    return { trades, noTradeCount, errors: 1 };
  }

  // Group 5m bars by ET trading day.
  const byDay = new Map<string, IntradayBar[]>();
  for (const b of bars5m) {
    const key = etDateKey(b.timestamp);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(b);
  }
  const days = [...byDay.keys()].sort();

  // Need ~25 daily bars of trailing history before we trust ATR/avgVolume.
  const MIN_DAILY_HISTORY = 25;

  for (const day of days) {
    const dayBars = byDay.get(day)!.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    if (dayBars.length < 20) continue; // partial/holiday-shortened day, skip

    const dayMidnightUTC = new Date(`${day}T00:00:00.000Z`);
    const priorDaily = dailyBars.filter((b) => b.timestamp < dayMidnightUTC);
    if (priorDaily.length < MIN_DAILY_HISTORY) continue;

    const avgDailyVolume =
      priorDaily.slice(-20).reduce((s, b) => s + b.volume, 0) / Math.min(20, priorDaily.length);

    for (const decisionEt of DECISION_TIMES_ET) {
      try {
        // "now" = the decision timestamp, expressed in UTC for this ET day.
        const offset = getETOffset(dayMidnightUTC);
        const now = new Date(dayMidnightUTC.getTime() + (decisionEt + offset) * 3600_000);

        const barsUpToNow = dayBars.filter((b) => b.timestamp <= now);
        if (barsUpToNow.length < 4) continue; // need at least past the ORB window
        const spot = barsUpToNow[barsUpToNow.length - 1].close;

        const levels = computeIntradayLevels({
          minuteBars: barsUpToNow,
          dailyBars: priorDaily,
          spot,
          avgDailyVolume,
          now,
        });

        const closes5m = barsUpToNow.map((b) => b.close);
        const rsi5m = calcRSI(closes5m, 14);
        const bars15m = resampleTo15m(barsUpToNow);
        const closes15m = bars15m.map((b) => b.close);
        const rsi15m = calcRSI(closes15m, 14);
        const macdHistogram15m = calcMACDHistogram(closes15m);

        const signalScore = computeIntradaySignals({
          spot,
          levels,
          rsi5m,
          rsi15m,
          macdHistogram15m,
          dayChange: levels.sessionOpen != null ? ((spot - levels.sessionOpen) / levels.sessionOpen) * 100 : null,
        });

        const setup = generateTradeSetup({ spot, levels, signalScore, now });

        if (setup.bias === "no-trade" || setup.entryLow == null || setup.entryHigh == null ||
            setup.stopLoss == null || setup.target1 == null || setup.rrRatio1 == null) {
          noTradeCount++;
          continue;
        }

        const entryMid = (setup.entryLow + setup.entryHigh) / 2;
        const remaining = dayBars.filter((b) => b.timestamp > now);

        let outcome: TradeResult["outcome"] = "open-at-close";
        let rMultiple = 0;

        for (const bar of remaining) {
          if (setup.bias === "long") {
            const hitStop = bar.low <= setup.stopLoss;
            const hitTarget = bar.high >= setup.target1;
            if (hitStop && hitTarget) { outcome = "loss"; rMultiple = -1; break; } // conservative: stop-first tie-break
            if (hitStop) { outcome = "loss"; rMultiple = -1; break; }
            if (hitTarget) { outcome = "win"; rMultiple = setup.rrRatio1; break; }
          } else {
            const hitStop = bar.high >= setup.stopLoss;
            const hitTarget = bar.low <= setup.target1;
            if (hitStop && hitTarget) { outcome = "loss"; rMultiple = -1; break; }
            if (hitStop) { outcome = "loss"; rMultiple = -1; break; }
            if (hitTarget) { outcome = "win"; rMultiple = setup.rrRatio1; break; }
          }
        }

        if (outcome === "open-at-close") {
          const lastClose = remaining.length ? remaining[remaining.length - 1].close : spot;
          const risk = setup.riskPerShare ?? Math.abs(entryMid - setup.stopLoss);
          rMultiple = setup.bias === "long"
            ? (lastClose - entryMid) / risk
            : (entryMid - lastClose) / risk;
        }

        trades.push({
          symbol, date: day, decisionEt,
          setupType: setup.setupType, bias: setup.bias,
          conviction: setup.confidence, rrRatio1: setup.rrRatio1,
          outcome, rMultiple: +rMultiple.toFixed(2),
        });
      } catch (err) {
        errors++;
        console.error(`  [${symbol} ${day} ${decisionEt}] error:`, (err as Error).message);
      }
    }
  }

  return { trades, noTradeCount, errors };
}

function bucketConviction(c: number): string {
  if (c < 40) return "25-40";
  if (c < 60) return "40-60";
  if (c < 80) return "60-80";
  return "80-100";
}

function summarize(trades: TradeResult[], groupBy: (t: TradeResult) => string): string {
  const groups = new Map<string, TradeResult[]>();
  for (const t of trades) {
    const key = groupBy(t);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  const rows: string[] = [];
  for (const [key, ts] of [...groups.entries()].sort()) {
    const wins = ts.filter((t) => t.rMultiple > 0).length;
    const winRate = (wins / ts.length) * 100;
    const avgR = ts.reduce((s, t) => s + t.rMultiple, 0) / ts.length;
    rows.push(
      `| ${key} | ${ts.length} | ${winRate.toFixed(1)}% | ${avgR >= 0 ? "+" : ""}${avgR.toFixed(2)}R |`,
    );
  }
  return rows.join("\n");
}

async function main() {
  console.log(`Backtesting ${SYMBOLS.length} symbols across ${DECISION_TIMES_ET.length} daily decision windows...\n`);

  const allTrades: TradeResult[] = [];
  let totalNoTrade = 0;
  let totalErrors = 0;

  for (const symbol of SYMBOLS) {
    process.stdout.write(`  ${symbol}...`);
    const { trades, noTradeCount, errors } = await backtestSymbol(symbol);
    allTrades.push(...trades);
    totalNoTrade += noTradeCount;
    totalErrors += errors;
    console.log(` ${trades.length} trades, ${noTradeCount} filtered no-trade`);
  }

  const wins = allTrades.filter((t) => t.rMultiple > 0).length;
  const losses = allTrades.filter((t) => t.rMultiple <= 0).length;
  const winRate = allTrades.length ? (wins / allTrades.length) * 100 : 0;
  const avgR = allTrades.length ? allTrades.reduce((s, t) => s + t.rMultiple, 0) / allTrades.length : 0;
  const avgWinR = wins ? allTrades.filter((t) => t.rMultiple > 0).reduce((s, t) => s + t.rMultiple, 0) / wins : 0;
  const avgLossR = losses ? allTrades.filter((t) => t.rMultiple <= 0).reduce((s, t) => s + t.rMultiple, 0) / losses : 0;

  const report = `# Intraday Signal Engine — Backtest Report

Generated: ${new Date().toISOString()}

## Methodology
- Symbols: ${SYMBOLS.join(", ")}
- Data: Yahoo Finance 5m bars (~58 days, no pre/post market) + 1d bars (~150 days) for PDH/PDL/ATR/avg-volume
- Decision windows tested per trading day (ET): ${DECISION_TIMES_ET.map((t) => `${Math.floor(t)}:${String(Math.round((t % 1) * 60)).padStart(2, "0")}`).join(", ")}
- Uses the exact production code path: \`computeIntradayLevels\` → \`computeIntradaySignals\` → \`generateTradeSetup\`
- Trade outcome: simulated bar-by-bar until stop or target1 hit, or scored mark-to-close if neither hit by session end
- **No commissions, spread, or slippage modeled.** Pre-market signals are inactive in this backtest (Yahoo 5m history excludes pre/post bars) — they are live in production, which uses 1m bars with pre/post included.

## Overall Results
- Total setups generated: ${allTrades.length}
- Filtered as no-trade (incl. new R:R quality filter): ${totalNoTrade}
- Fetch/compute errors: ${totalErrors}
- Win rate: **${winRate.toFixed(1)}%**
- Average R-multiple per trade: **${avgR >= 0 ? "+" : ""}${avgR.toFixed(2)}R**
- Average winner: +${avgWinR.toFixed(2)}R — Average loser: ${avgLossR.toFixed(2)}R
- Expectancy: ${avgR >= 0 ? "positive" : "negative"} (${avgR >= 0 ? "the system's average R is above breakeven" : "the system is currently losing on average across this sample"})

## By Setup Type
| Setup Type | N | Win Rate | Avg R |
|---|---|---|---|
${summarize(allTrades, (t) => t.setupType)}

## By Conviction Bucket
| Conviction | N | Win Rate | Avg R |
|---|---|---|---|
${summarize(allTrades, (t) => bucketConviction(t.conviction))}

## By Bias
| Bias | N | Win Rate | Avg R |
|---|---|---|---|
${summarize(allTrades, (t) => t.bias)}

## Caveats (read before acting on this)
This is a **starting point**, not statistical proof. With ~${SYMBOLS.length} symbols × ~45 usable days × ${DECISION_TIMES_ET.length} windows,
the sample is too small to confirm or reject the signal weights with confidence — treat it as
"does this look directionally sane" rather than "this is validated." To get real evidence:
increase symbol count and history length, add walk-forward validation (don't reuse the same
period to tune and test), and eventually paper-trade before risking capital.
`;

  const fs = await import("node:fs/promises");
  await fs.writeFile(new URL("../../BACKTEST_REPORT.md", import.meta.url), report);

  console.log("\n" + report);
  console.log("\nFull report written to artifacts/api-server/BACKTEST_REPORT.md");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
