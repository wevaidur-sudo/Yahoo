import type { IntradayBar } from "../intraday";

export type BarInterval = "1m" | "5m" | "15m" | "1d";

export interface DataSource {
  /** Human-readable name used in logs and the cache's `source` column. */
  name: string;

  /**
   * Fetch OHLCV bars for a symbol within [from, to).
   * Implementations should return bars sorted ascending by timestamp.
   * Throw on unrecoverable errors; return [] when no data is available
   * for the window so the manager can fall through to the next source.
   */
  fetchBars(
    symbol: string,
    interval: BarInterval,
    from: Date,
    to: Date,
  ): Promise<IntradayBar[]>;

  /** Whether this source can supply the requested interval. */
  supports(interval: BarInterval): boolean;

  /**
   * Maximum lookback in calendar days this source supports for a given
   * interval. The manager clamps the fetch window to this limit so a
   * fallback source is never called with a range it cannot serve.
   * Return undefined (or omit) to indicate no practical limit.
   */
  maxLookbackDays?(interval: BarInterval): number | undefined;
}
