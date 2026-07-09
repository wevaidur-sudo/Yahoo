/**
 * Stooq data source — completely free, no API key, no sign-up.
 * https://stooq.com
 *
 * Supports:
 *  - 5m bars: years of history for major US/global equities and ETFs
 *  - 1d bars: decades of daily history
 *
 * Response is a plain CSV with columns: Date,Time,Open,High,Low,Close,Volume
 * Timestamps in the CSV are US Eastern Time (ET); we convert to UTC.
 *
 * Symbol mapping:
 *  - US stocks/ETFs → append ".US"  (AAPL → AAPL.US, SPY → SPY.US)
 *  - Already contains a dot → use as-is
 *
 * Known limitations:
 *  - No pre/post market bars
 *  - Very liquid names have the best coverage; thinly traded symbols may return empty
 *  - Stooq occasionally serves a browser-verification page instead of CSV; the
 *    parser detects this and returns [] so the manager falls through to Yahoo.
 */

import { getETOffset } from "../intraday";
import type { IntradayBar } from "../intraday";
import type { DataSource, BarInterval } from "./types";

const STOOQ_INTERVAL: Partial<Record<BarInterval, string>> = {
  "5m": "5",
  "1d": "d",
};

/** Expected CSV header columns (lower-case) for each layout. */
const INTRADAY_HEADERS = ["date", "time", "open", "high", "low", "close", "volume"];
const DAILY_HEADERS    = ["date", "open", "high", "low", "close", "volume"];

function toStooqSymbol(symbol: string): string {
  return symbol.includes(".") ? symbol.toLowerCase() : `${symbol.toLowerCase()}.us`;
}

function padZ(n: number): string {
  return String(n).padStart(2, "0");
}

function toStooqDate(d: Date): string {
  return `${d.getUTCFullYear()}${padZ(d.getUTCMonth() + 1)}${padZ(d.getUTCDate())}`;
}

/**
 * Parse a "YYYY-MM-DD" + "HH:MM:SS" string as ET, return UTC Date.
 * Uses the project's existing DST helper (handles Mar/Nov transitions).
 */
function stooqBarToUtc(dateStr: string, timeStr: string): Date {
  const [y, m, d]    = dateStr.split("-").map(Number);
  const [hh, mm, ss] = (timeStr ?? "00:00:00").split(":").map(Number);
  // Probe the calendar date to find DST offset for that specific day.
  const probe = new Date(Date.UTC(y, m - 1, d));
  const offsetHours = getETOffset(probe); // 4 (EDT) or 5 (EST)
  return new Date(Date.UTC(y, m - 1, d, hh + offsetHours, mm, ss ?? 0));
}

/**
 * Validate that the response body looks like Stooq CSV and not an HTML
 * verification/error page.  Returns false when we detect HTML or a known
 * error marker so the manager can fall through gracefully.
 */
function isValidCsv(text: string, interval: BarInterval): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const firstLine = trimmed.split("\n")[0].toLowerCase().trim();

  // Stooq returns "no data" (sometimes padded/cased differently) when the
  // symbol isn't available for the requested interval.
  if (firstLine.startsWith("no data")) return false;

  // HTML page (challenge, error, or maintenance).
  if (firstLine.startsWith("<!") || firstLine.startsWith("<html")) return false;

  // Verify expected header columns are present.
  const expected = interval === "1d" ? DAILY_HEADERS : INTRADAY_HEADERS;
  const cols = firstLine.split(",").map((c) => c.trim());
  return expected.every((h) => cols.includes(h));
}

/**
 * Parse Stooq CSV text into IntradayBar[].
 * Expected header: Date,Time,Open,High,Low,Close,Volume   (5m)
 *                  Date,Open,High,Low,Close,Volume          (daily — no Time column)
 */
function parseStooqCsv(csv: string, interval: BarInterval): IntradayBar[] {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const hasTime = headers.includes("time");

  const bars: IntradayBar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < (hasTime ? 7 : 6)) continue;

    let colIdx = 0;
    const dateStr = cols[colIdx++].trim();
    const timeStr = hasTime ? cols[colIdx++].trim() : "00:00:00";
    const open   = parseFloat(cols[colIdx++]);
    const high   = parseFloat(cols[colIdx++]);
    const low    = parseFloat(cols[colIdx++]);
    const close  = parseFloat(cols[colIdx++]);
    const volume = parseFloat(cols[colIdx++] ?? "0") || 0;

    if (!dateStr || isNaN(open) || isNaN(close)) continue;

    const timestamp =
      interval === "1d"
        ? new Date(`${dateStr}T00:00:00.000Z`) // daily: midnight UTC is fine for day-level analysis
        : stooqBarToUtc(dateStr, timeStr);

    bars.push({ timestamp, open, high, low, close, volume });
  }

  // Stooq returns data newest-first; reverse to ascending order.
  return bars.reverse();
}

export class StooqSource implements DataSource {
  readonly name = "stooq";

  supports(interval: BarInterval): boolean {
    return interval in STOOQ_INTERVAL;
  }

  async fetchBars(
    symbol: string,
    interval: BarInterval,
    from: Date,
    to: Date,
  ): Promise<IntradayBar[]> {
    const stooqInterval = STOOQ_INTERVAL[interval];
    if (!stooqInterval) return [];

    const s  = toStooqSymbol(symbol);
    const d1 = toStooqDate(from);
    const d2 = toStooqDate(to);

    const url =
      `https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=${stooqInterval}&d1=${d1}&d2=${d2}`;

    let text: string;
    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; intraday-backtest/1.0)",
          Accept: "text/csv,text/plain,*/*",
        },
        signal: AbortSignal.timeout(20_000),
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      text = await resp.text();
    } catch (err) {
      throw new Error(`Stooq network error for ${symbol}: ${(err as Error).message}`);
    }

    // Explicit validation — if Stooq served an HTML challenge or "No data"
    // page we return empty so the manager falls through to Yahoo.
    if (!isValidCsv(text, interval)) {
      console.warn(
        `[stooq] ${symbol}/${interval}: response is not valid CSV (challenge page or no data) — falling through to next source`,
      );
      return [];
    }

    const bars = parseStooqCsv(text, interval);
    if (bars.length === 0) {
      console.warn(`[stooq] ${symbol}/${interval}: CSV parsed to 0 bars`);
    }
    return bars;
  }
}
