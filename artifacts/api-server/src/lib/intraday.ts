/**
 * Intraday data structures and level computation.
 *
 * Computes VWAP (with std-dev bands), Opening Range Breakout, gap analysis,
 * relative volume, pre-market H/L, and previous-day levels from Yahoo Finance
 * bar data. All computations are deterministic — no AI, no randomness.
 */

export interface IntradayBar {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IntradayLevels {
  // Volume-Weighted Average Price (anchored to today's regular session open)
  vwap: number | null;
  vwapUpper1: number | null; // VWAP + 1 std dev
  vwapLower1: number | null; // VWAP - 1 std dev
  vwapUpper2: number | null; // VWAP + 2 std dev
  vwapLower2: number | null; // VWAP - 2 std dev
  // Opening Range — first 15 minutes of regular session (9:30–9:45 ET)
  orbHigh: number | null;
  orbLow: number | null;
  orbRange: number | null;
  orbBroken: "up" | "down" | "none" | null; // null = still inside ORB window
  // Previous Day levels
  pdHigh: number | null;
  pdLow: number | null;
  pdClose: number | null;
  // Pre-market session levels (4:00–9:30 AM ET)
  preMarketHigh: number | null;
  preMarketLow: number | null;
  // Gap from previous close to today's regular-session open
  gap: number | null;          // percentage, positive = gap up
  gapDirection: "up" | "down" | "flat" | null;
  gapFilled: boolean | null;
  // Session stats
  sessionOpen: number | null;
  cumulativeVolume: number | null;
  rvol: number | null;         // relative volume vs historical daily average
  avgDailyVolume: number | null;
  // Average True Range from last 5 daily bars — used for position-sizing
  intradayAtr: number | null;
}

export interface MarketHours {
  preMarketStart: Date; // 4:00 AM ET
  marketOpen: Date;     // 9:30 AM ET
  orbEnd: Date;         // 9:45 AM ET
  marketClose: Date;    // 4:00 PM ET
  afterHoursEnd: Date;  // 8:00 PM ET
}

export type MarketState = "pre-market" | "open" | "post-market" | "closed";

// ─── Timezone helpers ──────────────────────────────────────────────────────────

/** Returns the number of hours to ADD to ET to get UTC (4 for EDT, 5 for EST). */
export function getETOffset(date: Date): number {
  const m = date.getUTCMonth() + 1; // 1-12
  if (m > 3 && m < 11) return 4;   // clearly EDT
  if (m < 3 || m > 11) return 5;   // clearly EST
  if (m === 3) {
    // EDT starts on the second Sunday of March
    const secondSun = firstSundayOfMonth(date.getUTCFullYear(), 3) + 7;
    return date.getUTCDate() >= secondSun ? 4 : 5;
  }
  // November: EDT ends on the first Sunday
  return date.getUTCDate() < firstSundayOfMonth(date.getUTCFullYear(), 11) ? 4 : 5;
}

function firstSundayOfMonth(year: number, month: number): number {
  const dow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return dow === 0 ? 1 : 8 - dow;
}

/** Compute key market hours for the calendar day (in UTC) containing `date`. */
export function getMarketHours(date: Date): MarketHours {
  const offset = getETOffset(date);
  const y = date.getUTCFullYear();
  const mo = date.getUTCMonth();
  const d = date.getUTCDate();
  const utc = (h: number, m: number) =>
    new Date(Date.UTC(y, mo, d, h + offset, m, 0));
  return {
    preMarketStart: utc(4, 0),
    marketOpen:     utc(9, 30),
    orbEnd:         utc(9, 45),
    marketClose:    utc(16, 0),
    afterHoursEnd:  utc(20, 0),
  };
}

export function getMarketState(now: Date, hours: MarketHours): MarketState {
  if (now >= hours.marketOpen && now < hours.marketClose)   return "open";
  if (now >= hours.preMarketStart && now < hours.marketOpen) return "pre-market";
  if (now >= hours.marketClose && now < hours.afterHoursEnd) return "post-market";
  return "closed";
}

// ─── Bar parsing ───────────────────────────────────────────────────────────────

/** Convert a Yahoo Finance chart quotes array into typed IntradayBar[]. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseYahooBars(quotes: any[]): IntradayBar[] {
  return quotes
    .filter((q) => q.date && q.open != null && q.close != null)
    .map((q) => ({
      timestamp: new Date(q.date),
      open:   q.open   as number,
      high:   q.high   as number,
      low:    q.low    as number,
      close:  q.close  as number,
      volume: (q.volume ?? 0) as number,
    }));
}

// ─── Core computation ──────────────────────────────────────────────────────────

export function computeIntradayLevels(params: {
  minuteBars: IntradayBar[];   // 1m bars (2-3 days, includes pre-market if Yahoo provides it)
  dailyBars: IntradayBar[];    // 1d bars (30 days) for PDH/PDL/PDC + ATR
  spot: number;
  avgDailyVolume: number | null; // from quote.averageDailyVolume3Month or similar
  now: Date;
}): IntradayLevels {
  const { minuteBars, dailyBars, spot, avgDailyVolume, now } = params;
  const hours = getMarketHours(now);

  // ── Previous Day High / Low / Close (from daily bars, bar before today midnight)
  const todayMidnightUTC = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const prevDayBars = dailyBars.filter((b) => b.timestamp < todayMidnightUTC);
  const prevDay = prevDayBars[prevDayBars.length - 1] ?? null;
  const pdHigh  = prevDay?.high  != null ? +(prevDay.high.toFixed(2))  : null;
  const pdLow   = prevDay?.low   != null ? +(prevDay.low.toFixed(2))   : null;
  const pdClose = prevDay?.close != null ? +(prevDay.close.toFixed(2)) : null;

  // ── ATR (Average True Range) from last 14 daily bars — used for stop sizing
  // 14-bar Wilder ATR is the standard; 5-bar is too sensitive to single-day spikes
  // and produces unstable stop/target levels that amplify sizing noise.
  const ATR_PERIOD = 14;
  let intradayAtr: number | null = null;
  if (dailyBars.length >= ATR_PERIOD) {
    const recent = dailyBars.slice(-ATR_PERIOD);
    const trs = recent.map((b, i) => {
      if (i === 0) return b.high - b.low;
      const prev = recent[i - 1];
      return Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close));
    });
    intradayAtr = +(trs.reduce((a, c) => a + c, 0) / trs.length).toFixed(2);
  }

  // ── Split 1m bars: pre-market (4–9:30 ET) vs regular session (9:30–16:00 ET)
  const preMarketBars = minuteBars.filter(
    (b) => b.timestamp >= hours.preMarketStart && b.timestamp < hours.marketOpen,
  );
  const sessionBars = minuteBars.filter(
    (b) => b.timestamp >= hours.marketOpen && b.timestamp < hours.marketClose,
  );

  const preMarketHigh = preMarketBars.length
    ? +(Math.max(...preMarketBars.map((b) => b.high)).toFixed(2))
    : null;
  const preMarketLow = preMarketBars.length
    ? +(Math.min(...preMarketBars.map((b) => b.low)).toFixed(2))
    : null;
  const sessionOpen = sessionBars.length ? +(sessionBars[0].open.toFixed(2)) : null;

  // ── Gap analysis
  let gap: number | null = null;
  let gapDirection: "up" | "down" | "flat" | null = null;
  let gapFilled: boolean | null = null;

  if (pdClose != null && sessionOpen != null) {
    gap = +((sessionOpen - pdClose) / pdClose * 100).toFixed(2);
    if      (Math.abs(gap) < 0.10) gapDirection = "flat";
    else if (gap > 0)              gapDirection = "up";
    else                           gapDirection = "down";

    if (gapDirection === "up") {
      gapFilled = sessionBars.some((b) => b.low <= pdClose);
    } else if (gapDirection === "down") {
      gapFilled = sessionBars.some((b) => b.high >= pdClose);
    }
  }

  // ── VWAP — typical price method, anchored to 9:30 AM ET
  // σ bands use the per-bar variance of typical price weighted by volume.
  let vwap: number | null = null;
  let vwapUpper1: number | null = null;
  let vwapLower1: number | null = null;
  let vwapUpper2: number | null = null;
  let vwapLower2: number | null = null;

  if (sessionBars.length > 0) {
    let cumTPV  = 0; // Σ(typicalPrice × volume)
    let cumTPV2 = 0; // Σ(typicalPrice² × volume)  — for variance
    let cumVol  = 0; // Σ(volume)

    for (const bar of sessionBars) {
      const tp  = (bar.high + bar.low + bar.close) / 3;
      const vol = bar.volume;
      cumTPV  += tp * vol;
      cumTPV2 += tp * tp * vol;
      cumVol  += vol;
    }

    if (cumVol > 0) {
      const v        = cumTPV / cumVol;
      const variance = Math.max(0, cumTPV2 / cumVol - v * v);
      const std      = Math.sqrt(variance);
      vwap       = +v.toFixed(2);
      vwapUpper1 = +(v + std).toFixed(2);
      vwapLower1 = +(v - std).toFixed(2);
      vwapUpper2 = +(v + 2 * std).toFixed(2);
      vwapLower2 = +(v - 2 * std).toFixed(2);
    }
  }

  // ── Opening Range — first 15 minutes of regular session (9:30–9:45 ET)
  const orbWindowBars = sessionBars.filter((b) => b.timestamp < hours.orbEnd);
  const postOrbBars   = sessionBars.filter((b) => b.timestamp >= hours.orbEnd);

  let orbHigh:   number | null = null;
  let orbLow:    number | null = null;
  let orbRange:  number | null = null;
  let orbBroken: "up" | "down" | "none" | null = null;

  if (orbWindowBars.length > 0) {
    orbHigh  = +(Math.max(...orbWindowBars.map((b) => b.high)).toFixed(2));
    orbLow   = +(Math.min(...orbWindowBars.map((b) => b.low)).toFixed(2));
    orbRange = +(orbHigh - orbLow).toFixed(2);

    if (postOrbBars.length > 0) {
      const postHigh = Math.max(...postOrbBars.map((b) => b.high));
      const postLow  = Math.min(...postOrbBars.map((b) => b.low));
      if      (postHigh > orbHigh) orbBroken = "up";
      else if (postLow  < orbLow)  orbBroken = "down";
      else                         orbBroken = "none";
    }
    // orbBroken remains null while we're still inside the 9:30–9:45 window
  }

  // ── Relative Volume (RVOL)
  // Compare current cumulative session volume to expected volume at this
  // point in the day based on the 3-month average daily volume.
  const cumulativeVolume = sessionBars.length
    ? sessionBars.reduce((s, b) => s + b.volume, 0)
    : null;

  let rvol: number | null = null;
  if (avgDailyVolume && avgDailyVolume > 0 && cumulativeVolume != null && now >= hours.marketOpen) {
    const sessionMs = hours.marketClose.getTime() - hours.marketOpen.getTime();
    const elapsedMs = Math.min(
      Math.max(0, now.getTime() - hours.marketOpen.getTime()),
      sessionMs,
    );
    const fraction = elapsedMs / sessionMs;
    if (fraction > 0.01) {
      rvol = +(cumulativeVolume / (avgDailyVolume * fraction)).toFixed(2);
    }
  }

  return {
    vwap, vwapUpper1, vwapLower1, vwapUpper2, vwapLower2,
    orbHigh, orbLow, orbRange, orbBroken,
    pdHigh, pdLow, pdClose,
    preMarketHigh, preMarketLow,
    gap, gapDirection, gapFilled,
    sessionOpen,
    cumulativeVolume,
    rvol,
    avgDailyVolume: avgDailyVolume != null ? Math.round(avgDailyVolume) : null,
    intradayAtr,
  };
}
