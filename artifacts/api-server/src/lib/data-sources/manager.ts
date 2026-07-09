/**
 * DataSourceManager — multi-source OHLCV fetcher with DB caching.
 *
 * Priority order for intraday (5m) data:
 *   1. DB cache — fastest, zero network cost
 *   2. EODHD   — ~1 year of 5m history (demo key works)
 *   3. Yahoo   — ~60 days of 5m, fallback
 *
 * For daily (1d) data:
 *   1. DB cache
 *   2. EODHD (decades of daily data)
 *   3. Yahoo  (fallback)
 *
 * Coverage validation: a source result is accepted only when its bar density
 * is plausible for the interval (no large internal holes). Otherwise the
 * manager falls through to the next source.
 */

import type { IntradayBar } from "../intraday";
import type { BarInterval, DataSource } from "./types";
import { EodhdSource } from "./eodhd";
import { YahooSource } from "./yahoo";

const eodhd = new EodhdSource();
const yahoo = new YahooSource();

/** Ordered source lists for each interval. */
const INTRADAY_SOURCES: DataSource[] = [eodhd, yahoo];
const DAILY_SOURCES:    DataSource[] = [eodhd, yahoo];

const DAY_MS = 86_400_000;

// ─── Optional DB integration ──────────────────────────────────────────────────
// The DB is imported lazily so backtest can run without DATABASE_URL set.
// If the env var is absent the cache layer is simply skipped.

let dbModule: typeof import("@workspace/db") | null = null;

async function getDb() {
  if (!process.env.DATABASE_URL) return null;
  if (dbModule) return dbModule;
  try {
    dbModule = await import("@workspace/db");
    return dbModule;
  } catch {
    return null;
  }
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

async function loadFromCache(
  symbol: string,
  interval: BarInterval,
  from: Date,
  to: Date,
): Promise<IntradayBar[]> {
  const db = await getDb();
  if (!db) return [];

  try {
    const { ohlcvBarsTable } = db;
    const { gte, lte, eq, and } = await import("drizzle-orm");
    const rows = await db.db
      .select()
      .from(ohlcvBarsTable)
      .where(
        and(
          eq(ohlcvBarsTable.symbol, symbol.toUpperCase()),
          eq(ohlcvBarsTable.interval, interval),
          gte(ohlcvBarsTable.timestamp, from),
          lte(ohlcvBarsTable.timestamp, to),
        ),
      )
      .orderBy(ohlcvBarsTable.timestamp);

    return rows.map((r) => ({
      timestamp: r.timestamp,
      open:   r.open,
      high:   r.high,
      low:    r.low,
      close:  r.close,
      volume: r.volume,
    }));
  } catch {
    return [];
  }
}

async function persistToCache(
  bars: IntradayBar[],
  symbol: string,
  interval: BarInterval,
  source: string,
): Promise<void> {
  if (bars.length === 0) return;
  const db = await getDb();
  if (!db) return;

  try {
    const { ohlcvBarsTable } = db;
    const rows = bars.map((b) => ({
      symbol:    symbol.toUpperCase(),
      interval,
      source,
      timestamp: b.timestamp,
      open:      b.open,
      high:      b.high,
      low:       b.low,
      close:     b.close,
      volume:    b.volume,
    }));

    const { sql } = await import("drizzle-orm");
    // Insert in chunks to stay under Postgres parameter limits (~65 k params).
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await db.db
        .insert(ohlcvBarsTable)
        .values(rows.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: [ohlcvBarsTable.symbol, ohlcvBarsTable.interval, ohlcvBarsTable.timestamp],
          set: {
            open:      sql`excluded.open`,
            high:      sql`excluded.high`,
            low:       sql`excluded.low`,
            close:     sql`excluded.close`,
            volume:    sql`excluded.volume`,
            source:    sql`excluded.source`,
            fetchedAt: sql`now()`,
          },
        });
    }
  } catch (err) {
    // Cache persistence failures are non-fatal.
    console.warn(
      `[data-sources] cache persist failed for ${symbol}/${interval}:`,
      (err as Error).message,
    );
  }
}

// ─── Coverage validation ──────────────────────────────────────────────────────

/**
 * Expected bars per trading day for each interval (regular session, 6.5 h).
 * Used for density checks — not for span checks.
 */
const EXPECTED_BARS_PER_TRADING_DAY: Partial<Record<BarInterval, number>> = {
  "1m":  390,
  "5m":  78,
  "15m": 26,
  "1d":  1,
};

/**
 * Rough count of trading days for a given number of calendar days.
 * Assumes ~252 trading days/year (71% of calendar days).
 */
function estimateTradingDaysInSpan(calendarDays: number): number {
  return Math.ceil(Math.max(1, calendarDays) * 0.71);
}

/**
 * Check whether a set of bars is non-trivially populated.
 *
 * We deliberately do NOT enforce a span-coverage fraction here — a source
 * such as Yahoo is only able to return ~60 days of 5m history regardless of
 * how many days were requested, and that is valid data.  The goal of this
 * check is purely to reject:
 *  - Empty arrays (0 bars)
 *  - Trivially thin results (a handful of bars that clearly represent a
 *    failed or near-empty fetch, not a real partial dataset)
 *
 * The minimum is very lenient (5% of expected bars for the actual bar span)
 * so real-but-partial datasets are never discarded.
 */
function isCoverageSufficient(
  bars: IntradayBar[],
  _from: Date,
  _to: Date,
  interval: BarInterval,
): boolean {
  if (bars.length === 0) return false;

  // Compute density over the actual span of the returned bars, not the
  // requested window.  This way Yahoo's ~60-day result is never penalised
  // for being unable to provide a 365-day history.
  const spanCalDays =
    (bars[bars.length - 1].timestamp.getTime() - bars[0].timestamp.getTime()) / DAY_MS;
  const spanTradingDays = estimateTradingDaysInSpan(spanCalDays);
  const barsPerDay   = EXPECTED_BARS_PER_TRADING_DAY[interval] ?? 1;
  const minExpected  = spanTradingDays * barsPerDay * 0.05; // 5% threshold

  return bars.length >= Math.max(1, minExpected);
}

/**
 * For cache results, additionally check that bars are internally continuous —
 * i.e. the cache doesn't have large multi-day holes that would skew the backtest.
 *
 * Compares unique trading days present against the trading days expected for
 * the *actual bar span* (not the requested window), so a Yahoo-seeded cache
 * covering 60 real days isn't rejected because we originally asked for 365.
 */
function isCacheInternallyContinuous(
  bars: IntradayBar[],
  _from: Date,
  _to: Date,
  interval: BarInterval,
): boolean {
  if (interval === "1d") return true; // daily: density check is sufficient
  if (bars.length === 0) return false;

  // Count unique calendar dates present in the cache.
  const daySet = new Set<string>();
  for (const b of bars) {
    daySet.add(b.timestamp.toISOString().slice(0, 10));
  }

  // Estimate how many trading days should be in the span covered by these bars.
  const spanCalDays =
    (bars[bars.length - 1].timestamp.getTime() - bars[0].timestamp.getTime()) / DAY_MS;
  const estimatedDays = estimateTradingDaysInSpan(spanCalDays);

  // Require ≥ 60% of expected trading days within the span to have bars.
  return daySet.size >= estimatedDays * 0.60;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface FetchOptions {
  /** Skip DB cache read (still writes fetched data to cache). Default: false. */
  skipCache?: boolean;
  /**
   * Delay between source attempts to avoid hammering rate limits.
   * Default: 300 ms. Set 0 in tests.
   */
  retryDelayMs?: number;
}

/**
 * Fetch OHLCV bars for `symbol` over [from, to), trying multiple sources
 * in priority order and persisting results to the DB cache.
 */
export async function fetchBars(
  symbol: string,
  interval: BarInterval,
  from: Date,
  to: Date,
  opts: FetchOptions = {},
): Promise<IntradayBar[]> {
  const { skipCache = false, retryDelayMs = 300 } = opts;

  // 1. Try DB cache first.
  if (!skipCache) {
    const cached = await loadFromCache(symbol, interval, from, to);
    if (
      isCoverageSufficient(cached, from, to, interval) &&
      isCacheInternallyContinuous(cached, from, to, interval)
    ) {
      return cached;
    }
    // Partial cache hit: log and fall through to fetch fresh data.
    if (cached.length > 0) {
      console.info(
        `[data-sources] cache for ${symbol}/${interval} has ${cached.length} bars but` +
        ` insufficient coverage — fetching from source`,
      );
    }
  }

  // 2. Try external sources in priority order.
  const sources = interval === "1d" ? DAILY_SOURCES : INTRADAY_SOURCES;

  for (const source of sources) {
    if (!source.supports(interval)) continue;

    // Clamp the request window to what this source can actually serve.
    // This is critical for fallback sources like Yahoo whose 5m history
    // is only ~58 days — requesting 365 days from them will return empty
    // or be rejected by coverage checks.
    const maxDays = source.maxLookbackDays?.(interval);
    const effectiveFrom = maxDays
      ? new Date(Math.max(from.getTime(), to.getTime() - maxDays * DAY_MS))
      : from;

    if (effectiveFrom > to) continue; // source window entirely in the future — skip

    try {
      const bars = await source.fetchBars(symbol, interval, effectiveFrom, to);

      if (!isCoverageSufficient(bars, effectiveFrom, to, interval)) {
        console.info(
          `[data-sources] ${source.name} returned ${bars.length} bars for` +
          ` ${symbol}/${interval} — insufficient coverage, trying next source`,
        );
        if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }

      // Persist asynchronously — don't block the caller.
      persistToCache(bars, symbol, interval, source.name).catch(() => undefined);
      return bars;
    } catch (err) {
      console.warn(
        `[data-sources] ${source.name} failed for ${symbol}/${interval}: ${(err as Error).message}`,
      );
    }

    if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
  }

  // All sources exhausted — return whatever coverage we have from cache
  // rather than returning nothing, as partial data is better for diagnostics.
  const fallbackCached = skipCache
    ? []
    : await loadFromCache(symbol, interval, from, to);

  if (fallbackCached.length > 0) {
    console.warn(
      `[data-sources] all sources failed for ${symbol}/${interval};` +
      ` returning ${fallbackCached.length} cached bars (partial coverage)`,
    );
    return fallbackCached;
  }

  return [];
}
