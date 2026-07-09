/**
 * Offline data pipeline: pull multi-year daily OHLCV for the training
 * universe from Yahoo Finance, persist it, then build a point-in-time
 * feature/label training set from the stored history.
 *
 * Labels are RISK-ADJUSTED: a row is labelled 1 if the stock's forward
 * return over PREDICTION_HORIZON_DAYS exceeds SPY's return over the same
 * window by more than OUTPERFORM_THRESHOLD. This removes the market-
 * direction component so the model learns genuine stock-picking signal
 * rather than a proxy for "did the whole market go up?".
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
import YahooFinance from "yahoo-finance2";
import { db, historicalPricesTable, fundamentalsCacheTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  computeFeaturesAt,
  EMPTY_FUNDAMENTALS,
  FEATURE_NAMES,
  type Bar,
  type FundamentalSnapshot,
} from "./features";
import {
  TRAINING_UNIVERSE,
  SPY_BENCHMARK,
  HISTORY_YEARS,
  PREDICTION_HORIZON_DAYS,
  OUTPERFORM_THRESHOLD,
} from "./universe";
import { setFetchProgress, setBuildingTrainingSet } from "./progress";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yahooFinance = new (YahooFinance as any)({ suppressNotices: ["yahooSurvey"] });

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches and upserts multi-year daily history for every symbol in the
 * universe PLUS the SPY benchmark (always needed for risk-adjusted labels).
 */
export async function fetchAndStoreHistory(
  symbols: string[] = TRAINING_UNIVERSE,
  years: number = HISTORY_YEARS,
  log: (msg: string) => void = console.log,
): Promise<void> {
  const now = new Date();
  const start = new Date(now.getTime() - years * 365 * 24 * 60 * 60 * 1000);

  // Always include SPY so risk-adjusted labels can be computed.
  const allSymbols = symbols.includes(SPY_BENCHMARK)
    ? symbols
    : [SPY_BENCHMARK, ...symbols];

  for (let i = 0; i < allSymbols.length; i++) {
    const symbol = allSymbols[i];
    setFetchProgress("fetching-history", symbol, i + 1, allSymbols.length);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chart = (await (yahooFinance as any).chart(symbol, {
        period1: start,
        period2: now,
        interval: "1d",
      })) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const quotes: any[] = chart?.quotes || [];
      const rows = quotes
        .filter((q) => q.close != null && q.open != null && q.high != null && q.low != null)
        .map((q) => ({
          symbol,
          date: new Date(q.date).toISOString().slice(0, 10),
          open: q.open,
          high: q.high,
          low: q.low,
          close: q.close,
          volume: q.volume ?? 0,
        }));

      for (const row of rows) {
        await db
          .insert(historicalPricesTable)
          .values(row)
          .onConflictDoUpdate({
            target: [historicalPricesTable.symbol, historicalPricesTable.date],
            set: { open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume },
          });
      }
      log(`[pipeline] ${symbol}: stored ${rows.length} bars`);
    } catch (err) {
      log(`[pipeline] ${symbol}: FAILED — ${(err as Error).message}`);
    }
    await sleep(250); // be polite to Yahoo's unofficial endpoint
  }
}

/** Fetches fundamentals for every symbol and upserts them into the cache table. */
export async function fetchAndCacheFundamentals(
  symbols: string[] = TRAINING_UNIVERSE,
  log: (msg: string) => void = console.log,
): Promise<void> {
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    setFetchProgress("fetching-fundamentals", symbol, i + 1, symbols.length);
    const snap = await fetchFundamentalsLive(symbol);
    await db
      .insert(fundamentalsCacheTable)
      .values({ symbol, ...snap })
      .onConflictDoUpdate({
        target: fundamentalsCacheTable.symbol,
        set: { ...snap, fetchedAt: new Date() },
      });
    log(`[pipeline] ${symbol}: cached fundamentals`);
  }
}

async function fetchFundamentalsLive(symbol: string): Promise<FundamentalSnapshot> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const summary = (await (yahooFinance as any).quoteSummary(symbol, {
      modules: ["summaryDetail", "defaultKeyStatistics", "financialData"],
    })) as any;
    const sd = summary?.summaryDetail;
    const ks = summary?.defaultKeyStatistics;
    const fd = summary?.financialData;
    return {
      trailingPE: sd?.trailingPE ?? null,
      forwardPE: ks?.forwardPE ?? null,
      pegRatio: ks?.pegRatio ?? null,
      priceToBook: ks?.priceToBook ?? null,
      revenueGrowth: fd?.revenueGrowth ?? null,
      earningsGrowth: fd?.earningsGrowth ?? null,
      grossMargins: fd?.grossMargins ?? null,
      returnOnEquity: fd?.returnOnEquity ?? null,
      debtToEquity: fd?.debtToEquity ?? null,
    };
  } catch {
    return EMPTY_FUNDAMENTALS;
  }
}

export interface TrainingRow {
  symbol: string;
  date: string;
  features: Record<(typeof FEATURE_NAMES)[number], number>;
  label: 0 | 1;
}

/**
 * Builds point-in-time training rows from stored history using RISK-ADJUSTED
 * labels: label=1 iff stockReturn − spyReturn > OUTPERFORM_THRESHOLD over
 * the prediction horizon.
 *
 * SPY must be present in the DB (fetchAndStoreHistory always stores it).
 * Fundamentals are fetched once per symbol (current snapshot) and reused
 * across historical rows — a known approximation for the Value feature group
 * only; Momentum and Low-Risk features are fully point-in-time correct.
 */
export async function buildTrainingSet(
  symbols: string[] = TRAINING_UNIVERSE,
  log: (msg: string) => void = console.log,
): Promise<TrainingRow[]> {
  setBuildingTrainingSet();
  // ── Load SPY benchmark history into a date→close map ─────────────────────
  const spyBars = (
    await db
      .select()
      .from(historicalPricesTable)
      .where(eq(historicalPricesTable.symbol, SPY_BENCHMARK))
  ).sort((a, b) => a.date.localeCompare(b.date));

  if (spyBars.length < 250) {
    throw new Error(
      `SPY benchmark history missing or too short (${spyBars.length} bars). ` +
      `Run fetchAndStoreHistory first — it always fetches SPY.`,
    );
  }

  // Index by date for O(1) lookup
  const spyCloseByDate = new Map<string, number>(
    spyBars.map((b) => [b.date, b.close]),
  );

  // Build a sorted list of SPY dates/closes for horizon lookups
  const spyDateList = spyBars.map((b) => b.date);

  log(`[pipeline] Loaded ${spyBars.length} SPY bars for risk-adjusted labels`);

  // ── Build training rows for each stock ────────────────────────────────────
  const rows: TrainingRow[] = [];
  // Filter out SPY itself from training symbols
  const trainingSymbols = symbols.filter((s) => s !== SPY_BENCHMARK);

  for (const symbol of trainingSymbols) {
    const bars = (
      await db.select().from(historicalPricesTable).where(eq(historicalPricesTable.symbol, symbol))
    )
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r): Bar => ({ date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));

    if (bars.length < 250) {
      log(`[pipeline] ${symbol}: insufficient history (${bars.length} bars), skipping`);
      continue;
    }

    const [cached] = await db
      .select()
      .from(fundamentalsCacheTable)
      .where(eq(fundamentalsCacheTable.symbol, symbol));
    const fundamentals: FundamentalSnapshot = cached
      ? {
          trailingPE: cached.trailingPE,
          forwardPE: cached.forwardPE,
          pegRatio: cached.pegRatio,
          priceToBook: cached.priceToBook,
          revenueGrowth: cached.revenueGrowth,
          earningsGrowth: cached.earningsGrowth,
          grossMargins: cached.grossMargins,
          returnOnEquity: cached.returnOnEquity,
          debtToEquity: cached.debtToEquity,
        }
      : EMPTY_FUNDAMENTALS;

    let built = 0;
    let skippedNoSpy = 0;

    for (let i = 200; i < bars.length - PREDICTION_HORIZON_DAYS; i++) {
      const features = computeFeaturesAt(bars, i, fundamentals);
      if (!features) continue;

      const entryDate = bars[i].date;
      const futureDate = bars[i + PREDICTION_HORIZON_DAYS].date;

      // Find SPY's close on the same entry and future dates.
      // SPY and the stock trade on the same calendar so dates almost always
      // match; if not (holiday quirk), skip this row rather than mislabel it.
      const spyEntry = spyCloseByDate.get(entryDate);
      const spyFuture = spyCloseByDate.get(futureDate);
      if (spyEntry == null || spyFuture == null) {
        // Try the nearest available SPY date within ±2 days
        const spyEntryResolved = spyEntry ?? resolveNearest(spyCloseByDate, spyDateList, entryDate, 2);
        const spyFutureResolved = spyFuture ?? resolveNearest(spyCloseByDate, spyDateList, futureDate, 2);
        if (spyEntryResolved == null || spyFutureResolved == null) {
          skippedNoSpy++;
          continue;
        }
        const stockReturn = bars[i + PREDICTION_HORIZON_DAYS].close / bars[i].close - 1;
        const spyReturn = spyFutureResolved / spyEntryResolved - 1;
        const label: 0 | 1 = stockReturn - spyReturn > OUTPERFORM_THRESHOLD ? 1 : 0;
        rows.push({ symbol, date: entryDate, features, label });
        built++;
        continue;
      }

      const stockReturn = bars[i + PREDICTION_HORIZON_DAYS].close / bars[i].close - 1;
      const spyReturn = spyFuture / spyEntry - 1;
      const label: 0 | 1 = stockReturn - spyReturn > OUTPERFORM_THRESHOLD ? 1 : 0;
      rows.push({ symbol, date: entryDate, features, label });
      built++;
    }

    log(
      `[pipeline] ${symbol}: built ${built} training rows` +
        (skippedNoSpy > 0 ? ` (${skippedNoSpy} skipped — no SPY date match)` : ""),
    );
  }

  return rows;
}

/**
 * Resolves the closest SPY close price on or before `targetDate` within
 * `maxDays` previous trading days. Never returns a future date's price —
 * using a forward date as benchmark substitute would introduce look-ahead bias.
 */
function resolveNearest(
  closeByDate: Map<string, number>,
  sortedDates: string[],
  targetDate: string,
  maxDays: number,
): number | null {
  // Binary-search: lo = first index where sortedDates[lo] >= targetDate
  let lo = 0, hi = sortedDates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedDates[mid] < targetDate) lo = mid + 1;
    else hi = mid;
  }
  // Check exact match first
  if (lo < sortedDates.length && sortedDates[lo] === targetDate) {
    const v = closeByDate.get(sortedDates[lo]);
    if (v != null) return v;
  }
  // Walk backward only — no future dates to avoid look-ahead bias
  for (let i = lo - 1; i >= 0 && lo - 1 - i < maxDays; i--) {
    const v = closeByDate.get(sortedDates[i]);
    if (v != null) return v;
  }
  return null;
}
