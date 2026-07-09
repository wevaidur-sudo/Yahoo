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
 *
 * Anti-bot challenge:
 *  - Stooq serves a SHA-256 proof-of-work challenge page on first access.
 *    We solve it in Node.js (synchronous crypto, ~1-10ms for d=4), POST the
 *    solution to /__verify, cache the resulting session cookie, then retry
 *    the original request.  The cookie is reused across all subsequent
 *    fetches within the same process lifetime.
 */

import { createHash } from "node:crypto";
import { getETOffset } from "../intraday";
import type { IntradayBar } from "../intraday";
import type { DataSource, BarInterval } from "./types";

// ─── Proof-of-work challenge solver ───────────────────────────────────────────

/**
 * Stooq's challenge: find integer n ≥ 0 such that
 *   hex(SHA-256(c + n)).startsWith("0".repeat(d))
 * where c and d are extracted from the challenge HTML.
 *
 * Uses Node's synchronous crypto (not Web Crypto) to avoid async overhead
 * across ~32 768 expected iterations for d=4.
 */
function solvePoW(c: string, d: number): number {
  const target = "0".repeat(d);
  for (let n = 0; ; n++) {
    const hex = createHash("sha256").update(`${c}${n}`).digest("hex");
    if (hex.startsWith(target)) return n;
  }
}

/**
 * Parse the challenge `c` and `d` values from the JS embedded in the HTML page.
 * Stooq embeds: `const c="<base64url>",d=<int>`
 */
function parseChallenge(html: string): { c: string; d: number } | null {
  const m = html.match(/const c="([^"]+)",d=(\d+)/);
  if (!m) return null;
  return { c: m[1], d: parseInt(m[2], 10) };
}

/** Collect all Set-Cookie values from a Headers object as a single string. */
function extractCookies(headers: Headers): string {
  // Node fetch exposes multiple Set-Cookie headers via getSetCookie() (Node 18+)
  // or via a comma-joined get("set-cookie"). We handle both.
  const raw: string[] = [];
  if (typeof (headers as any).getSetCookie === "function") {
    (headers as any).getSetCookie().forEach((v: string) => raw.push(v.split(";")[0].trim()));
  } else {
    const joined = headers.get("set-cookie");
    if (joined) {
      joined.split(",").forEach((v) => raw.push(v.split(";")[0].trim()));
    }
  }
  return raw.join("; ");
}

/** Merge two cookie strings, overwriting keys from the first with those from the second. */
function mergeCookies(base: string, incoming: string): string {
  const map = new Map<string, string>();
  for (const part of [base, incoming]) {
    for (const kv of part.split(";").map((s) => s.trim()).filter(Boolean)) {
      const eq = kv.indexOf("=");
      if (eq > 0) map.set(kv.slice(0, eq), kv.slice(eq + 1));
    }
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** Module-level cookie cache — survives across calls within a process. */
let cachedCookie = "";
let cacheExpiry  = 0; // epoch ms; refresh before it stales

const BASE_URL    = "https://stooq.com";
const VERIFY_PATH = "/__verify";
const COMMON_HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
  Accept:       "text/html,application/xhtml+xml,text/csv,text/plain,*/*",
  "Accept-Language": "en-US,en;q=0.5",
};

/**
 * Attempt to solve Stooq's PoW challenge and obtain a verified session cookie.
 *
 * @param challengeHtml  The HTML body of the challenge page.
 * @param priorCookies   Any cookies already set by the challenge page response.
 * @returns              A combined cookie string to use on the retried request,
 *                       or null if solving failed.
 */
async function solveAndVerify(challengeHtml: string, priorCookies: string): Promise<string | null> {
  const parsed = parseChallenge(challengeHtml);
  if (!parsed) {
    console.warn("[stooq] could not parse PoW challenge from response HTML");
    return null;
  }

  const { c, d } = parsed;
  console.info(`[stooq] solving PoW challenge (difficulty d=${d})…`);
  const t0 = Date.now();
  const n  = solvePoW(c, d);
  console.info(`[stooq] PoW solved: n=${n} in ${Date.now() - t0}ms`);

  const verifyHeaders: Record<string, string> = {
    ...COMMON_HEADERS,
    "Content-Type": "application/x-www-form-urlencoded",
    Referer:        `${BASE_URL}/`,
    Origin:         BASE_URL,
  };
  if (priorCookies) verifyHeaders["Cookie"] = priorCookies;

  let verifyResp: Response;
  try {
    verifyResp = await fetch(`${BASE_URL}${VERIFY_PATH}`, {
      method:   "POST",
      headers:  verifyHeaders,
      body:     `c=${encodeURIComponent(c)}&n=${n}`,
      redirect: "manual",           // don't follow — we want the Set-Cookie
    });
  } catch (err) {
    console.warn("[stooq] /__verify request failed:", (err as Error).message);
    return null;
  }

  const verifyCookies = extractCookies(verifyResp.headers);
  if (!verifyCookies) {
    console.warn(`[stooq] /__verify (HTTP ${verifyResp.status}) returned no Set-Cookie header`);
    return null;
  }

  return mergeCookies(priorCookies, verifyCookies);
}

/**
 * Wrapper around fetch() that transparently handles Stooq's PoW challenge.
 *
 * On first call (or when the cached session expires) it detects the challenge
 * page, solves the PoW, obtains a session cookie, and retries automatically.
 * The cookie is stored in module scope and reused for the process lifetime.
 */
async function stooqFetch(url: string): Promise<string> {
  const makeHeaders = (cookie: string): Record<string, string> => ({
    ...COMMON_HEADERS,
    ...(cookie ? { Cookie: cookie } : {}),
  });

  // First attempt — use cached cookie if available and not expired.
  let resp = await fetch(url, {
    headers: makeHeaders(Date.now() < cacheExpiry ? cachedCookie : ""),
    signal:  AbortSignal.timeout(20_000),
  });
  let text = await resp.text();

  // If we got the challenge page, solve it.
  if (!resp.ok || text.trimStart().startsWith("<!")) {
    const priorCookies = extractCookies(resp.headers);
    const newCookie    = await solveAndVerify(text, priorCookies);

    if (!newCookie) {
      // Could not solve — return raw text so isValidCsv() can catch it.
      return text;
    }

    // Retry with the verified cookie.
    resp = await fetch(url, {
      headers: makeHeaders(newCookie),
      signal:  AbortSignal.timeout(20_000),
    });
    text = await resp.text();

    if (!text.trimStart().startsWith("<!")) {
      // Success — cache the cookie for ~4 hours.
      cachedCookie = newCookie;
      cacheExpiry  = Date.now() + 4 * 60 * 60 * 1000;
      console.info("[stooq] session established; cookie cached for 4 h");
    } else {
      console.warn("[stooq] still receiving challenge page after verification — Stooq may have changed its scheme");
    }
  }

  return text;
}

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
      `${BASE_URL}/q/d/l/?s=${encodeURIComponent(s)}&i=${stooqInterval}&d1=${d1}&d2=${d2}`;

    let text: string;
    try {
      // stooqFetch transparently handles the PoW challenge if Stooq serves one.
      text = await stooqFetch(url);
    } catch (err) {
      throw new Error(`Stooq network error for ${symbol}: ${(err as Error).message}`);
    }

    // Explicit validation — if we still received an HTML page (challenge
    // could not be solved), "Access denied" (Stooq blocks this IP range), or a
    // "No data" response, fall through to Yahoo.
    // NOTE: Stooq's IP-level block is separate from the PoW challenge — the
    // challenge can be solved correctly but Stooq still returns "Access denied"
    // for cloud/datacenter IPs. The PoW solver is kept because it works from
    // non-datacenter IPs (self-hosted, deployed VPS, etc.).
    if (!isValidCsv(text, interval)) {
      const reason = text.trim().toLowerCase() === "access denied"
        ? "IP-blocked by Stooq (cloud/datacenter IPs blocked even after PoW verification)"
        : "challenge unsolved or no data";
      console.warn(
        `[stooq] ${symbol}/${interval}: response is not valid CSV (${reason}) — falling through to next source`,
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
