/**
 * Offline data pipeline: pull multi-year daily OHLCV for the training
 * universe from Yahoo Finance, persist it, then build a point-in-time
 * feature/label training set from the stored history.
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
import { TRAINING_UNIVERSE, HISTORY_YEARS, PREDICTION_HORIZON_DAYS, OUTPERFORM_THRESHOLD } from "./universe";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yahooFinance = new (YahooFinance as any)({ suppressNotices: ["yahooSurvey"] });

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetches and upserts multi-year daily history for every symbol in the universe. */
export async function fetchAndStoreHistory(
  symbols: string[] = TRAINING_UNIVERSE,
  years: number = HISTORY_YEARS,
  log: (msg: string) => void = console.log,
): Promise<void> {
  const now = new Date();
  const start = new Date(now.getTime() - years * 365 * 24 * 60 * 60 * 1000);

  for (const symbol of symbols) {
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

/** Fetches fundamentals for every symbol and upserts them into the cache table (chunked-safe: call per-symbol-subset). */
export async function fetchAndCacheFundamentals(
  symbols: string[] = TRAINING_UNIVERSE,
  log: (msg: string) => void = console.log,
): Promise<void> {
  for (const symbol of symbols) {
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
 * Builds point-in-time training rows from stored history. Fundamentals are
 * fetched once per symbol (current snapshot) and reused across that symbol's
 * historical rows — historical point-in-time fundamentals aren't available
 * from this free data source, so this is a known, documented approximation
 * for the Value feature group only (Momentum/Low-Risk features are fully
 * point-in-time correct since they derive purely from price history).
 */
export async function buildTrainingSet(
  symbols: string[] = TRAINING_UNIVERSE,
  log: (msg: string) => void = console.log,
): Promise<TrainingRow[]> {
  const rows: TrainingRow[] = [];

  for (const symbol of symbols) {
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

    for (let i = 200; i < bars.length - PREDICTION_HORIZON_DAYS; i++) {
      const features = computeFeaturesAt(bars, i, fundamentals);
      if (!features) continue;
      const entryClose = bars[i].close;
      const futureClose = bars[i + PREDICTION_HORIZON_DAYS].close;
      const forwardReturn = futureClose / entryClose - 1;
      const label: 0 | 1 = forwardReturn > OUTPERFORM_THRESHOLD ? 1 : 0;
      rows.push({ symbol, date: bars[i].date, features, label });
    }
    log(`[pipeline] ${symbol}: built ${bars.length - 200 - PREDICTION_HORIZON_DAYS} training rows`);
  }

  return rows;
}
