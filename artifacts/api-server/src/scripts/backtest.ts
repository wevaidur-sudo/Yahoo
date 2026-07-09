/**
 * Basic backtest harness for the intraday signal engine + trade setup generator.
 *
 * Purpose: replace "the weights feel reasonable" with actual historical
 * evidence — win rate, average R-multiple, and expectancy per setup type
 * and conviction bucket, computed by replaying the exact same deterministic
 * code path used in production (`computeIntradayLevels`, `computeIntradaySignals`,
 * `generateTradeSetup`) against real historical bars.
 *
 * DATA SOURCES (tried in priority order):
 *  1. DB cache      (ohlcv_bars table) — zero network cost, populated on first run
 *  2. Alpha Vantage — ~30 days of 5m on free plan; full history on premium
 *  3. Yahoo         — ~60-day 5m fallback; also primary for daily bars
 *
 * KNOWN LIMITATIONS (read before trusting the numbers):
 *  - No pre/post market bars in historical 5m data (pre-market signals work
 *    live because the app fetches 1m bars with pre/post included).
 *  - No commissions, spread, or slippage modeled — fills assumed at printed price.
 *  - Only 3 fixed decision times per day tested, not continuous monitoring.
 */

import {
  computeIntradayLevels,
  getETOffset,
  type IntradayBar,
} from "../lib/intraday";
import { computeIntradaySignals, generateTradeSetup } from "../lib/intraday-signals";
import { fetchBars as fetchBarsMultiSource } from "../lib/data-sources/manager";

const SYMBOLS = [
  "AAPL", "MSFT", "NVDA", "AMZN", "TSLA", "META", "GOOGL", "SPY",
  "QQQ", "AMD", "NFLX", "JPM", "XOM", "UNH", "COST", "AVGO", "CRM", "ORCL",
];

// Fraction of each symbol's available days used as the TRAIN window (used to
// pick the setup-type allowlist). The remaining days are the held-out TEST
// window, scored with the allowlist derived from train only — this is a
// walk-forward split, not an in-sample fit, so the reported test numbers are
// honest evidence of out-of-sample performance.
const TRAIN_FRACTION = 0.65;

// Decision times to test, in ET decimal hours — matches the app's own
// "best entry window" guidance (opening momentum, late morning, afternoon).
const DECISION_TIMES_ET = [10.25, 11.0, 13.75];

// Minimum trailing daily bars needed before ATR/avg-volume can be trusted.
const MIN_DAILY_HISTORY = 25;

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
  phase: "train" | "test";
}

async function fetchBars(symbol: string, interval: "5m" | "1d", days: number): Promise<IntradayBar[]> {
  const to   = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  return fetchBarsMultiSource(symbol, interval, from, to, { retryDelayMs: 500 });
}

async function backtestSymbol(symbol: string): Promise<{ trades: TradeResult[]; noTradeCount: number; errors: number }> {
  const trades: TradeResult[] = [];
  let noTradeCount = 0;
  let errors = 0;

  let bars5m: IntradayBar[];
  let dailyBars: IntradayBar[];
  try {
    [bars5m, dailyBars] = await Promise.all([
      fetchBars(symbol, "5m", 365),  // Alpha Vantage (premium) or Yahoo fallback ~60 days
      fetchBars(symbol, "1d", 500),  // Yahoo/Alpha Vantage daily goes back years
    ]);
  } catch (err) {
    console.error(`  [${symbol}] fetch failed:`, (err as Error).message);
    return { trades, noTradeCount, errors: 1 };
  }

  // Hard guards: refuse to run on dangerously thin data.
  // A zero-result run with no logged errors is more misleading than a hard fail.
  const uniqueDays5m = new Set(bars5m.map((b) => etDateKey(b.timestamp))).size;
  if (bars5m.length === 0 || uniqueDays5m < 15) {
    console.error(
      `  [${symbol}] 5m data insufficient: ${uniqueDays5m} trading day(s) fetched` +
      ` (need ≥ 15). All sources may have failed or been rate-limited. Skipping.`,
    );
    return { trades, noTradeCount, errors: 1 };
  }
  if (dailyBars.length < MIN_DAILY_HISTORY) {
    console.error(
      `  [${symbol}] daily bar data insufficient: ${dailyBars.length} bars fetched` +
      ` (need ≥ ${MIN_DAILY_HISTORY} for ATR/avg-volume). All sources may have failed. Skipping.`,
    );
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
  const splitIdx = Math.floor(days.length * TRAIN_FRACTION);

  for (const [dayIdx, day] of days.entries()) {
    const phase: "train" | "test" = dayIdx < splitIdx ? "train" : "test";
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

        // Always measure against the FULL setup-type universe here — the
        // gate is derived FROM this measurement (on TRAIN) and then applied
        // as a separate post-hoc filter when scoring TEST (see main()).
        // Baking the production gate into generation during backtesting would
        // be circular: it would silently exclude the very setup types being
        // evaluated, on both TRAIN and TEST.
        const setup = generateTradeSetup({
          spot, levels, signalScore, now,
          bypassEmpiricalGate: true,
        });

        if (setup.bias === "no-trade" || setup.entryLow == null || setup.entryHigh == null ||
            setup.stopLoss == null || setup.target1 == null || setup.rrRatio1 == null) {
          noTradeCount++;
          continue;
        }

        const entryMid = (setup.entryLow + setup.entryHigh) / 2;
        const remaining = dayBars.filter((b) => b.timestamp > now);

        // Require an actual touch of the entry zone before tracking stop/target
        // — entry zones are often a pullback/retest band, not "fill immediately
        // at the current price." A setup that never gets filled never became a
        // real trade and must not be scored as one.
        const fillIdx = remaining.findIndex(
          (b) => b.low <= setup.entryHigh! && b.high >= setup.entryLow!,
        );
        if (fillIdx === -1) {
          noTradeCount++; // never filled — not a real trade, excluded from R stats
          continue;
        }
        const postFill = remaining.slice(fillIdx);

        let outcome: TradeResult["outcome"] = "open-at-close";
        let rMultiple = 0;

        for (const bar of postFill) {
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
          const lastClose = postFill.length ? postFill[postFill.length - 1].close : spot;
          const risk = setup.riskPerShare ?? Math.abs(entryMid - setup.stopLoss);
          rMultiple = setup.bias === "long"
            ? (lastClose - entryMid) / risk
            : (entryMid - lastClose) / risk;
          // Cap unresolved marks at a realistic ceiling: a disciplined trader
          // would have taken profit at/around target2, not held indefinitely.
          // Without this, a handful of runaway trend days dominate the whole
          // average-R statistic and make it meaningless.
          const cap = setup.rrRatio2 ?? setup.rrRatio1 * 1.5;
          rMultiple = Math.max(-1.5, Math.min(rMultiple, cap));
        }

        trades.push({
          symbol, date: day, decisionEt,
          setupType: setup.setupType, bias: setup.bias,
          conviction: setup.confidence, rrRatio1: setup.rrRatio1,
          outcome, rMultiple: +rMultiple.toFixed(2),
          phase,
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

function stats(trades: TradeResult[]) {
  const wins = trades.filter((t) => t.rMultiple > 0).length;
  const losses = trades.filter((t) => t.rMultiple <= 0).length;
  const winRate = trades.length ? (wins / trades.length) * 100 : 0;
  const avgR = trades.length ? trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length : 0;
  const avgWinR = wins ? trades.filter((t) => t.rMultiple > 0).reduce((s, t) => s + t.rMultiple, 0) / wins : 0;
  const avgLossR = losses ? trades.filter((t) => t.rMultiple <= 0).reduce((s, t) => s + t.rMultiple, 0) / losses : 0;
  return { n: trades.length, wins, losses, winRate, avgR, avgWinR, avgLossR };
}

/** Minimum trade count in TRAIN before a setup type is trusted enough to allow. */
const MIN_TRAIN_N = 12;

async function main() {
  console.log(`Backtesting ${SYMBOLS.length} symbols across ${DECISION_TIMES_ET.length} daily decision windows (walk-forward ${Math.round(TRAIN_FRACTION * 100)}/${Math.round((1 - TRAIN_FRACTION) * 100)} train/test split)...\n`);

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

  const trainTrades = allTrades.filter((t) => t.phase === "train");
  const testTrades  = allTrades.filter((t) => t.phase === "test");

  // ── Derive the setup-type allowlist from TRAIN data only ──────────────────
  const byType = new Map<string, TradeResult[]>();
  for (const t of trainTrades) {
    if (!byType.has(t.setupType)) byType.set(t.setupType, []);
    byType.get(t.setupType)!.push(t);
  }
  const allowlist = new Set<string>();
  const typeVerdicts: string[] = [];
  for (const [type, ts] of [...byType.entries()].sort()) {
    const s = stats(ts);
    const allowed = s.n >= MIN_TRAIN_N && s.avgR > 0;
    if (allowed) allowlist.add(type);
    typeVerdicts.push(
      `| ${type} | ${s.n} | ${s.winRate.toFixed(1)}% | ${s.avgR >= 0 ? "+" : ""}${s.avgR.toFixed(2)}R | ${allowed ? "✅ ALLOWED" : s.n < MIN_TRAIN_N ? "⛔ insufficient data" : "⛔ negative edge"} |`,
    );
  }

  // ── Score TEST trades both with and without the allowlist gate ───────────
  const testUnfiltered = stats(testTrades);
  const testFiltered = stats(testTrades.filter((t) => allowlist.has(t.setupType)));
  const trainOverall = stats(trainTrades);

  const report = `# Intraday Signal Engine — Backtest Report

Generated: ${new Date().toISOString()}

## Methodology
- Symbols (${SYMBOLS.length}): ${SYMBOLS.join(", ")}
- Data: Alpha Vantage 5m bars (premium: years of history; free: ~30 days; Yahoo fallback ~60 days) + daily bars (~500 days) for PDH/PDL/ATR/avg-volume. Results cached in ohlcv_bars DB table.
- Decision windows tested per trading day (ET): ${DECISION_TIMES_ET.map((t) => `${Math.floor(t)}:${String(Math.round((t % 1) * 60)).padStart(2, "0")}`).join(", ")}
- Uses the exact production code path: \`computeIntradayLevels\` → \`computeIntradaySignals\` → \`generateTradeSetup\`
- **Walk-forward split**: first ${Math.round(TRAIN_FRACTION * 100)}% of each symbol's trading days = TRAIN (used only to derive the setup-type quality gate below), last ${Math.round((1 - TRAIN_FRACTION) * 100)}% = TEST (held out, scored with the gate frozen from TRAIN — this is genuine out-of-sample evidence, not a re-fit)
- Trade outcome: simulated bar-by-bar until stop or target1 hit, or scored mark-to-close if neither hit by session end
- **No commissions, spread, or slippage modeled.** Pre-market signals are inactive in this backtest (Yahoo 5m history excludes pre/post bars) — they are live in production, which uses 1m bars with pre/post included.

## Setup-Type Quality Gate (derived from TRAIN only, N ≥ ${MIN_TRAIN_N})
| Setup Type | N (train) | Win Rate | Avg R | Verdict |
|---|---|---|---|---|
${typeVerdicts.join("\n")}

**Allowed setup types (shipped to production):** ${[...allowlist].join(", ") || "none met the bar"}

## TRAIN Results (in-sample — for reference only, not evidence)
- N=${trainOverall.n}, win rate ${trainOverall.winRate.toFixed(1)}%, avg ${trainOverall.avgR >= 0 ? "+" : ""}${trainOverall.avgR.toFixed(2)}R

## TEST Results (held-out — this is the real evidence)
| | N | Win Rate | Avg R |
|---|---|---|---|
| Unfiltered (all setup types) | ${testUnfiltered.n} | ${testUnfiltered.winRate.toFixed(1)}% | ${testUnfiltered.avgR >= 0 ? "+" : ""}${testUnfiltered.avgR.toFixed(2)}R |
| **With quality gate applied** | ${testFiltered.n} | **${testFiltered.winRate.toFixed(1)}%** | **${testFiltered.avgR >= 0 ? "+" : ""}${testFiltered.avgR.toFixed(2)}R** |

Filtering out setup types that showed negative or unreliable edge on TRAIN, and re-scoring only
on TEST (data the gate never saw), moved win rate from ${testUnfiltered.winRate.toFixed(1)}% to
${testFiltered.winRate.toFixed(1)}% and average R from ${testUnfiltered.avgR.toFixed(2)}R to ${testFiltered.avgR.toFixed(2)}R.
${testFiltered.avgR > testUnfiltered.avgR ? "The gate improved out-of-sample expectancy." : "The gate did NOT clearly improve out-of-sample expectancy — treat the allowlist as provisional, not proven."}

## Full Breakdown (all trades, both phases combined)
### By Setup Type
| Setup Type | N | Win Rate | Avg R |
|---|---|---|---|
${summarize(allTrades, (t) => t.setupType)}

### By Conviction Bucket
| Conviction | N | Win Rate | Avg R |
|---|---|---|---|
${summarize(allTrades, (t) => bucketConviction(t.conviction))}

### By Bias
| Bias | N | Win Rate | Avg R |
|---|---|---|---|
${summarize(allTrades, (t) => t.bias)}

## Operational Stats
- Total setups generated: ${allTrades.length}
- Filtered as no-trade (conviction/R:R gates, before the setup-type gate): ${totalNoTrade}
- Fetch/compute errors: ${totalErrors}

## Caveats (read before acting on this)
This is walk-forward evidence, which is meaningfully stronger than a single in-sample run — but
the TEST sample (~${testTrades.length} trades) is still modest. Treat the setup-type gate as
**provisional and subject to revision** as more data accrues; rerun \`pnpm run backtest\` monthly
and update \`EMPIRICAL_SETUP_ALLOWLIST\` in \`intraday-signals.ts\` from the new TRAIN verdicts.
No backtest — however rigorous — is a substitute for paper-trading before risking real capital,
because live fills, slippage, and regime changes are not captured here.
`;

  const fs = await import("node:fs/promises");
  // dist-scripts/backtest.mjs → one level up → artifacts/api-server/BACKTEST_REPORT.md
  await fs.writeFile(new URL("../BACKTEST_REPORT.md", import.meta.url), report);

  console.log("\n" + report);
  console.log("\nFull report written to artifacts/api-server/BACKTEST_REPORT.md");
  console.log("\nALLOWLIST_JSON=" + JSON.stringify([...allowlist]));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
