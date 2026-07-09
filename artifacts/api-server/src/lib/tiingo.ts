// Tiingo client — used as a fallback data source for symbols Yahoo Finance
// no longer serves (delisted / inactive tickers). Tiingo keeps EOD price
// history and metadata for delisted tickers available indefinitely.
//
// Docs: https://www.tiingo.com/documentation/end-of-day

const TIINGO_BASE_URL = "https://api.tiingo.com";

interface TiingoMeta {
  ticker: string;
  name: string;
  exchangeCode: string | null;
  startDate: string | null;
  endDate: string | null;
  description?: string;
}

interface TiingoPriceRow {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  adjClose: number | null;
}

function getApiKey(): string | null {
  const key = process.env["TIINGO_API_KEY"];
  return key && key.trim().length > 0 ? key : null;
}

function isConfigured(): boolean {
  return getApiKey() != null;
}

async function tiingoFetch<T>(path: string): Promise<T | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const separator = path.includes("?") ? "&" : "?";
  const url = `${TIINGO_BASE_URL}${path}${separator}token=${apiKey}`;

  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Tiingo request failed: ${res.status} ${res.statusText}`);
  }

  return (await res.json()) as T;
}

/**
 * Fetches ticker metadata from Tiingo. Works for delisted tickers as long as
 * Tiingo has ever tracked them — `endDate` will be set for delisted symbols.
 */
export async function getTiingoMeta(symbol: string): Promise<TiingoMeta | null> {
  return tiingoFetch<TiingoMeta>(`/tiingo/daily/${encodeURIComponent(symbol)}`);
}

/**
 * Fetches EOD price history from Tiingo, optionally bounded by a date range.
 * Returns rows even past a ticker's delisting date (up to its last trading day).
 */
export async function getTiingoPrices(
  symbol: string,
  opts: { startDate?: Date; endDate?: Date } = {},
): Promise<TiingoPriceRow[]> {
  const params = new URLSearchParams();
  if (opts.startDate) params.set("startDate", opts.startDate.toISOString().slice(0, 10));
  if (opts.endDate) params.set("endDate", opts.endDate.toISOString().slice(0, 10));

  const qs = params.toString();
  const path = `/tiingo/daily/${encodeURIComponent(symbol)}/prices${qs ? `?${qs}` : ""}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await tiingoFetch<any[]>(path);
  if (!rows) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rows.map((row: any) => ({
    date: row.date,
    open: row.open ?? null,
    high: row.high ?? null,
    low: row.low ?? null,
    close: row.close ?? null,
    volume: row.volume ?? null,
    adjClose: row.adjClose ?? null,
  }));
}

/** A ticker counts as delisted once Tiingo reports a non-null `endDate`. */
export function isDelisted(meta: TiingoMeta): boolean {
  return meta.endDate != null;
}

export const tiingo = {
  isConfigured,
  getMeta: getTiingoMeta,
  getPrices: getTiingoPrices,
  isDelisted,
};

export type { TiingoMeta, TiingoPriceRow };
