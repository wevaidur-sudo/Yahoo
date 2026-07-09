/**
 * Yahoo Finance data source (unofficial — via yahoo-finance2).
 *
 * Limitations:
 *  - 5m bars: ~60 days history
 *  - 1m bars: last few days only
 *  - No pre/post market bars on historical endpoints (only on recent 1m chart)
 */
import YahooFinance from "yahoo-finance2";
import { parseYahooBars } from "../intraday";
import type { DataSource, BarInterval } from "./types";
import type { IntradayBar } from "../intraday";

// yahoo-finance2 v3 requires instantiation
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yf = new (YahooFinance as any)({ suppressNotices: ["yahooSurvey"] });

/** Map our internal interval names to Yahoo Finance interval strings. */
const YF_INTERVAL: Record<BarInterval, string> = {
  "1m":  "1m",
  "5m":  "5m",
  "15m": "15m",
  "1d":  "1d",
};

/** Yahoo Finance's practical lookback limits (calendar days). */
const YF_MAX_LOOKBACK: Partial<Record<BarInterval, number>> = {
  "1m":  7,   // ~7 days of 1-minute history
  "5m":  58,  // ~60 days of 5-minute history (conservative)
  "15m": 58,
  // "1d" is left undefined — Yahoo daily goes back decades
};

export class YahooSource implements DataSource {
  readonly name = "yahoo";

  supports(interval: BarInterval): boolean {
    return interval in YF_INTERVAL;
  }

  maxLookbackDays(interval: BarInterval): number | undefined {
    return YF_MAX_LOOKBACK[interval];
  }

  async fetchBars(
    symbol: string,
    interval: BarInterval,
    from: Date,
    to: Date,
  ): Promise<IntradayBar[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await (yf as any).chart(symbol, {
      period1: from,
      period2: to,
      interval: YF_INTERVAL[interval],
    })) as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    return parseYahooBars(result?.quotes ?? []);
  }
}
