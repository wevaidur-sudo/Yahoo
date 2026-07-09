/**
 * EODHD (EOD Historical Data) source.
 * https://eodhd.com
 *
 * Supports:
 *  - 5m bars: ~1 year of intraday history
 *  - 1m bars: ~4 months of intraday history
 *  - 1d bars: decades of daily history
 *
 * Configured via EODHD_API_KEY env var (defaults to "demo").
 * The "demo" key works for US equities and covers the ranges above.
 *
 * Intraday endpoint: /api/intraday/{SYMBOL}.US
 * Daily endpoint:    /api/eod/{SYMBOL}.US
 *
 * Timestamps in the response are UTC (gmtoffset=0) — no conversion needed.
 */

import type { IntradayBar } from "../intraday";
import type { DataSource, BarInterval } from "./types";

const BASE_URL = "https://eodhd.com/api";

function apiKey(): string {
  return process.env.EODHD_API_KEY ?? "demo";
}

const EODHD_INTERVAL: Partial<Record<BarInterval, string>> = {
  "1m":  "1m",
  "5m":  "5m",
  "15m": "15m",
  "1d":  "d",
};

/** Format a Date as "YYYY-MM-DD" for the daily endpoint. */
function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface EodhdIntradayBar {
  timestamp: number; // Unix seconds, UTC
  open:      number;
  high:      number;
  low:       number;
  close:     number;
  volume:    number;
}

interface EodhdDailyBar {
  date:           string; // "YYYY-MM-DD"
  open:           number;
  high:           number;
  low:            number;
  close:          number;
  adjusted_close: number;
  volume:         number;
}

export class EodhdSource implements DataSource {
  readonly name = "eodhd";

  supports(interval: BarInterval): boolean {
    return interval in EODHD_INTERVAL;
  }

  // No maxLookbackDays — EODHD handles the full window natively.
  // The "demo" key provides ~1 year of 5m history; paid keys go further.

  async fetchBars(
    symbol: string,
    interval: BarInterval,
    from: Date,
    to: Date,
  ): Promise<IntradayBar[]> {
    const eodInterval = EODHD_INTERVAL[interval];
    if (!eodInterval) return [];

    if (interval === "1d") {
      return this.fetchDaily(symbol, from, to);
    }
    return this.fetchIntraday(symbol, eodInterval, from, to);
  }

  private async fetchIntraday(
    symbol: string,
    interval: string,
    from: Date,
    to: Date,
  ): Promise<IntradayBar[]> {
    const params = new URLSearchParams({
      api_token: apiKey(),
      interval,
      from: String(Math.floor(from.getTime() / 1000)),
      to:   String(Math.floor(to.getTime()   / 1000)),
      fmt:  "json",
    });

    const url = `${BASE_URL}/intraday/${encodeURIComponent(symbol.toUpperCase())}.US?${params}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });

    if (!resp.ok) {
      throw new Error(`EODHD intraday HTTP ${resp.status} for ${symbol}`);
    }

    const data = (await resp.json()) as EodhdIntradayBar[] | { message?: string };

    if (!Array.isArray(data)) {
      const msg = (data as { message?: string }).message ?? JSON.stringify(data).slice(0, 120);
      throw new Error(`EODHD intraday error for ${symbol}: ${msg}`);
    }

    return data.map((b) => ({
      timestamp: new Date(b.timestamp * 1000),
      open:   b.open,
      high:   b.high,
      low:    b.low,
      close:  b.close,
      volume: b.volume,
    }));
  }

  private async fetchDaily(
    symbol: string,
    from: Date,
    to: Date,
  ): Promise<IntradayBar[]> {
    const params = new URLSearchParams({
      api_token: apiKey(),
      from: toDateStr(from),
      to:   toDateStr(to),
      period: "d",
      fmt:    "json",
    });

    const url = `${BASE_URL}/eod/${encodeURIComponent(symbol.toUpperCase())}.US?${params}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });

    if (!resp.ok) {
      throw new Error(`EODHD daily HTTP ${resp.status} for ${symbol}`);
    }

    const data = (await resp.json()) as EodhdDailyBar[] | { message?: string };

    if (!Array.isArray(data)) {
      const msg = (data as { message?: string }).message ?? JSON.stringify(data).slice(0, 120);
      throw new Error(`EODHD daily error for ${symbol}: ${msg}`);
    }

    return data.map((b) => ({
      timestamp: new Date(`${b.date}T00:00:00.000Z`),
      open:   b.open,
      high:   b.high,
      low:    b.low,
      close:  b.close,
      volume: b.volume,
    }));
  }
}
