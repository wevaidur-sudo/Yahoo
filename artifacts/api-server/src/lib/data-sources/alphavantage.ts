/**
 * Alpha Vantage data source.
 * https://www.alphavantage.co
 *
 * Supports:
 *  - 5m bars: up to ~30 trading days on the free tier (outputsize=full).
 *             Premium plans support full historical intraday via the `month`
 *             parameter — see fetchIntradayMonth() below.
 *  - 1d bars: up to 20 years of daily history (outputsize=full).
 *
 * Requires the ALPHA_VANTAGE_API_KEY environment variable.
 *
 * Rate limits (free tier): 25 requests/day, 5 requests/minute.
 * A 12-second inter-request delay is applied to stay under the per-minute cap.
 *
 * Timestamps in the API response are US Eastern Time; we convert to UTC.
 */

import { getETOffset } from "../intraday";
import type { IntradayBar } from "../intraday";
import type { DataSource, BarInterval } from "./types";

const BASE_URL = "https://www.alphavantage.co/query";

/** Max lookback for intraday (5m) on a standard (free/basic) plan. */
const INTRADAY_MAX_DAYS = 30;

const AV_INTERVAL: Partial<Record<BarInterval, string>> = {
  "1m":  "1min",
  "5m":  "5min",
  "15m": "15min",
  "1d":  "daily",
};

function apiKey(): string {
  const key = process.env.ALPHA_VANTAGE_API_KEY;
  if (!key) throw new Error("ALPHA_VANTAGE_API_KEY environment variable is not set");
  return key;
}

/**
 * Parse an Alpha Vantage "YYYY-MM-DD HH:MM:SS" ET timestamp string to a UTC Date.
 * For daily bars the time portion is absent; we use midnight UTC.
 */
function avTimestampToUtc(ts: string): Date {
  const hasTime = ts.includes(" ");
  if (!hasTime) {
    // Daily bar — "YYYY-MM-DD"
    return new Date(`${ts}T00:00:00.000Z`);
  }
  // Intraday — "YYYY-MM-DD HH:MM:SS" in ET
  const [datePart, timePart] = ts.split(" ");
  const [y, m, d]    = datePart.split("-").map(Number);
  const [hh, mm, ss] = timePart.split(":").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  const offsetHours = getETOffset(probe); // 4 (EDT) or 5 (EST)
  return new Date(Date.UTC(y, m - 1, d, hh + offsetHours, mm, ss ?? 0));
}

interface AvResponse {
  "Error Message"?: string;
  "Note"?: string;        // rate-limit notice
  "Information"?: string; // rate-limit / premium notice
  [key: string]: unknown;
}

async function avFetch(params: Record<string, string>): Promise<AvResponse> {
  const qs = new URLSearchParams({ ...params, apikey: apiKey() }).toString();
  const url = `${BASE_URL}?${qs}`;

  const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) {
    throw new Error(`Alpha Vantage HTTP ${resp.status} for ${params.function}`);
  }

  const json = (await resp.json()) as AvResponse;

  if (json["Error Message"]) {
    throw new Error(`Alpha Vantage error: ${json["Error Message"]}`);
  }
  if (json["Note"] || json["Information"]) {
    const msg = (json["Note"] ?? json["Information"]) as string;
    // Rate-limit note — surface as an error so the manager can fall through.
    throw new Error(`Alpha Vantage rate limit / plan restriction: ${msg}`);
  }

  return json;
}

/**
 * Parse an Alpha Vantage time-series object into IntradayBar[].
 * The object keys are ET timestamp strings; values have the numbered OHLCV fields.
 */
function parseTimeSeries(
  series: Record<string, Record<string, string>>,
  isIntraday: boolean,
): IntradayBar[] {
  const bars: IntradayBar[] = [];

  for (const [ts, row] of Object.entries(series)) {
    const timestamp = avTimestampToUtc(ts);
    const open   = parseFloat(row["1. open"]  ?? row["1. open"]);
    const high   = parseFloat(row["2. high"]  ?? row["2. high"]);
    const low    = parseFloat(row["3. low"]   ?? row["3. low"]);
    const close  = parseFloat(row["4. close"] ?? row["4. close"]);
    const volume = parseFloat(row["5. volume"] ?? "0") || 0;

    if (isNaN(open) || isNaN(close)) continue;
    bars.push({ timestamp, open, high, low, close, volume });
  }

  // AV returns data newest-first; sort ascending.
  return bars.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

/**
 * Fetch the most recent intraday bars (up to ~30 trading days).
 * Works on free and all paid plans.
 */
async function fetchIntradayRecent(
  symbol: string,
  avInterval: string,
): Promise<IntradayBar[]> {
  const data = await avFetch({
    function:    "TIME_SERIES_INTRADAY",
    symbol,
    interval:    avInterval,
    outputsize:  "full",
    extended_hours: "false",
  });

  const seriesKey = `Time Series (${avInterval})`;
  const series = data[seriesKey] as Record<string, Record<string, string>> | undefined;
  if (!series) {
    console.warn(`[alphavantage] no '${seriesKey}' key in response for ${symbol}`);
    return [];
  }

  return parseTimeSeries(series, true);
}

/**
 * Fetch a specific calendar month of intraday bars.
 * Requires a premium Alpha Vantage plan. Returns [] on free-tier rejection
 * so the manager can fall through gracefully.
 */
async function fetchIntradayMonth(
  symbol: string,
  avInterval: string,
  month: string, // "YYYY-MM"
): Promise<IntradayBar[]> {
  const data = await avFetch({
    function:    "TIME_SERIES_INTRADAY",
    symbol,
    interval:    avInterval,
    month,
    outputsize:  "full",
    extended_hours: "false",
  });

  const seriesKey = `Time Series (${avInterval})`;
  const series = data[seriesKey] as Record<string, Record<string, string>> | undefined;
  if (!series) return [];

  return parseTimeSeries(series, true);
}

/**
 * Build a list of "YYYY-MM" month strings covering [from, to].
 */
function monthsInRange(from: Date, to: Date): string[] {
  const months: string[] = [];
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  while (cur <= end) {
    months.push(`${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, "0")}`);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return months;
}

export class AlphaVantageSource implements DataSource {
  readonly name = "alphavantage";

  supports(interval: BarInterval): boolean {
    return interval in AV_INTERVAL;
  }

  // maxLookbackDays is intentionally omitted (returns undefined = no limit).
  //
  // The manager uses this value to clamp the request window before calling
  // fetchBars(). If we returned 30 here, the manager would silently truncate
  // long requests, accept the 30-day result as "sufficient coverage", and
  // never fall through to Yahoo — even on free-tier plans that cannot serve
  // the full window.
  //
  // Instead we let the manager pass the full requested window to us:
  //  • ≤30 days → fetchIntradayRecent() (works on free + premium)
  //  • >30 days → month-by-month fetch (premium only); throws on free tier
  //               so the manager falls through to Yahoo automatically.

  async fetchBars(
    symbol: string,
    interval: BarInterval,
    from: Date,
    to: Date,
  ): Promise<IntradayBar[]> {
    const avInterval = AV_INTERVAL[interval];
    if (!avInterval) return [];

    // ── Daily bars ────────────────────────────────────────────────────────────
    if (interval === "1d") {
      const data = await avFetch({
        function:   "TIME_SERIES_DAILY",
        symbol,
        outputsize: "full",
      });

      const series = data["Time Series (Daily)"] as
        | Record<string, Record<string, string>>
        | undefined;

      if (!series) {
        console.warn(`[alphavantage] no 'Time Series (Daily)' in response for ${symbol}`);
        return [];
      }

      const bars = parseTimeSeries(series, false);
      return bars.filter((b) => b.timestamp >= from && b.timestamp <= to);
    }

    // ── Intraday bars ─────────────────────────────────────────────────────────
    const calendarDays =
      (to.getTime() - from.getTime()) / 86_400_000;

    if (calendarDays <= INTRADAY_MAX_DAYS) {
      // Short window — single recent fetch is sufficient.
      const bars = await fetchIntradayRecent(symbol, avInterval);
      return bars.filter((b) => b.timestamp >= from && b.timestamp <= to);
    }

    // Long window — attempt month-by-month fetch (premium plan).
    // If the first month call fails with a rate/plan error the manager will
    // catch the throw and fall through to Yahoo.
    const months = monthsInRange(from, to);
    console.info(
      `[alphavantage] ${symbol}/${interval}: extended history requested (${months.length} months) — requires premium plan`,
    );

    const allBars: IntradayBar[] = [];
    for (const month of months) {
      try {
        const bars = await fetchIntradayMonth(symbol, avInterval, month);
        allBars.push(...bars);
        // Respect the 5-req/min free-tier limit (12 s between calls).
        if (months.indexOf(month) < months.length - 1) {
          await new Promise((r) => setTimeout(r, 12_000));
        }
      } catch (err) {
        console.warn(
          `[alphavantage] month ${month} fetch failed for ${symbol}: ${(err as Error).message}`,
        );
        // If even the first month fails, propagate so the manager falls through.
        if (allBars.length === 0) throw err;
        break; // partial data is better than nothing
      }
    }

    return allBars
      .filter((b) => b.timestamp >= from && b.timestamp <= to)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }
}
