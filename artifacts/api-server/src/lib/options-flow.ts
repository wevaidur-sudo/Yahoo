/**
 * Options flow analyzer — unusual institutional positioning detector.
 *
 * Options traders (especially institutions and hedge funds) often position
 * BEFORE price moves. By scanning the full options chain for unusual
 * volume/open-interest ratios and IV skew, we can detect directional bets
 * that haven't yet shown up in the stock price.
 *
 * Signals:
 *   Unusual call vs put flow     weight ≤ 15 — net unusual volume asymmetry
 *   IV skew                      weight ≤  8 — put IV vs call IV divergence
 *
 * MAX contribution: 15 pts (unusual flow dominates; IV skew is a tiebreaker)
 */

export interface OptionsFlowResult {
  direction: "bullish" | "bearish" | "neutral";
  /** Net score: positive = bullish flow, negative = bearish, range ±15 */
  score: number;
  /** Strikes with unusual call activity (vol/OI > threshold) */
  unusualCallStrikes: number[];
  /** Strikes with unusual put activity (vol/OI > threshold) */
  unusualPutStrikes: number[];
  /** Put IV minus Call IV at ATM (positive = bearish skew, negative = bullish skew) */
  ivSkewPct: number;
  /** Overall put/call ratio from full chain (not just top strikes) */
  fullChainPCR: number | null;
  note: string;
}

const UNUSUAL_VOL_OI_RATIO = 3.0; // volume must be 3× open interest to be flagged
const MIN_VOLUME_THRESHOLD  = 10;  // ignore zero-volume contracts

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function analyzeOptionsFlow(params: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawCalls: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawPuts: any[];
  spot: number;
}): OptionsFlowResult {
  const { rawCalls, rawPuts, spot } = params;

  if (!rawCalls.length && !rawPuts.length) {
    return {
      direction: "neutral", score: 0,
      unusualCallStrikes: [], unusualPutStrikes: [],
      ivSkewPct: 0, fullChainPCR: null,
      note: "Options data unavailable — cannot detect institutional flow",
    };
  }

  // ── Unusual volume detection ───────────────────────────────────────────────
  // Flag any contract where today's volume is 3× (or more) the open interest.
  // This means NEW positions are being opened aggressively — not just rolls.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unusualContracts = (contracts: any[]): { strikes: number[]; totalUnusualVol: number } => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unusual = contracts.filter((c: any) => {
      const vol = c.volume ?? 0;
      const oi  = c.openInterest ?? 0;
      return vol >= MIN_VOLUME_THRESHOLD && oi > 0 && (vol / oi) >= UNUSUAL_VOL_OI_RATIO;
    });
    return {
      strikes: unusual.map((c: any) => c.strike as number),
      totalUnusualVol: unusual.reduce((s: number, c: any) => s + (c.volume ?? 0), 0),
    };
  };

  const { strikes: unusualCallStrikes, totalUnusualVol: unusualCallVol } = unusualContracts(rawCalls);
  const { strikes: unusualPutStrikes,  totalUnusualVol: unusualPutVol  } = unusualContracts(rawPuts);

  // ── Full-chain put/call ratio ──────────────────────────────────────────────
  const totalCallVol = rawCalls.reduce((s: number, c: any) => s + (c.volume ?? 0), 0);
  const totalPutVol  = rawPuts.reduce((s: number, p: any) => s + (p.volume ?? 0), 0);
  const fullChainPCR = totalCallVol > 0 ? +(totalPutVol / totalCallVol).toFixed(2) : null;

  // ── IV Skew: put IV vs call IV at equidistant strikes from ATM ────────────
  // Bearish skew: put IV > call IV — market is pricing in downside risk
  // Bullish skew: call IV > put IV — market is pricing in upside potential
  let ivSkewPct = 0;
  const ATM_RANGE = spot * 0.03; // look within 3% of spot for ATM contracts

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const atmCalls = rawCalls.filter((c: any) => Math.abs(c.strike - spot) <= ATM_RANGE && (c.impliedVolatility ?? 0) > 0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const atmPuts  = rawPuts.filter((p: any)  => Math.abs(p.strike - spot) <= ATM_RANGE && (p.impliedVolatility ?? 0) > 0);

  if (atmCalls.length > 0 && atmPuts.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const avgCallIV = atmCalls.reduce((s: number, c: any) => s + c.impliedVolatility, 0) / atmCalls.length;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const avgPutIV  = atmPuts.reduce((s: number, p: any)  => s + p.impliedVolatility, 0) / atmPuts.length;
    ivSkewPct = +((avgPutIV - avgCallIV) * 100).toFixed(1); // positive = put premium (bearish skew)
  }

  // ── Scoring ───────────────────────────────────────────────────────────────
  // Net unusual volume asymmetry (calls vs puts)
  const totalUnusual = unusualCallVol + unusualPutVol;
  let unusualFlowScore = 0;

  if (totalUnusual > 0) {
    // What fraction of unusual volume is in calls vs puts?
    const callFraction = unusualCallVol / totalUnusual;
    // callFraction = 0.8 → mostly calls → bullish
    // callFraction = 0.2 → mostly puts → bearish
    const asymmetry = (callFraction - 0.5) * 2; // -1 to +1
    unusualFlowScore = Math.round(asymmetry * 15); // max ±15
  } else if (fullChainPCR != null) {
    // Fall back to full-chain PCR if no unusual activity detected
    // PCR < 0.5 = lots of calls → bullish flow; PCR > 1.5 = lots of puts → bearish
    if (fullChainPCR < 0.5)       unusualFlowScore = 8;
    else if (fullChainPCR < 0.75) unusualFlowScore = 4;
    else if (fullChainPCR > 1.5)  unusualFlowScore = -8;
    else if (fullChainPCR > 1.0)  unusualFlowScore = -4;
  }

  // IV skew tiebreaker (max ±5, included within the 15pt cap)
  let ivSkewScore = 0;
  if (Math.abs(ivSkewPct) > 3) {
    // Large put premium = market makers hedging downside = bearish
    ivSkewScore = ivSkewPct > 3 ? -5 : 5;
  }

  const score = Math.max(-15, Math.min(15, unusualFlowScore + ivSkewScore));
  const direction: OptionsFlowResult["direction"] =
    score > 3 ? "bullish" : score < -3 ? "bearish" : "neutral";

  // ── Note ──────────────────────────────────────────────────────────────────
  let note: string;
  if (unusualCallStrikes.length > 0 || unusualPutStrikes.length > 0) {
    const callStr = unusualCallStrikes.length
      ? `unusual CALL activity at $${unusualCallStrikes.slice(0, 3).join(", $")}`
      : null;
    const putStr = unusualPutStrikes.length
      ? `unusual PUT activity at $${unusualPutStrikes.slice(0, 3).join(", $")}`
      : null;
    const flowDesc = [callStr, putStr].filter(Boolean).join(" + ");
    note = `Smart money positioning detected: ${flowDesc} (vol/OI > 3×) — new institutional positions opened BEFORE today's session.`;
    if (Math.abs(ivSkewPct) > 3) {
      note += ` IV skew ${ivSkewPct > 0 ? "bearish" : "bullish"} (${ivSkewPct > 0 ? "+" : ""}${ivSkewPct.toFixed(1)}% put premium).`;
    }
  } else if (fullChainPCR != null) {
    const pcrDesc = fullChainPCR < 0.7
      ? `Low PCR ${fullChainPCR} — call-heavy flow signals bullish institutional positioning`
      : fullChainPCR > 1.3
      ? `High PCR ${fullChainPCR} — put-heavy flow signals bearish hedging or downside bets`
      : `Neutral PCR ${fullChainPCR} — balanced options flow, no directional bias`;
    note = pcrDesc;
    if (Math.abs(ivSkewPct) > 3) {
      note += `. IV skew: ${ivSkewPct > 0 ? "puts" : "calls"} carry ${Math.abs(ivSkewPct).toFixed(1)}% premium — market pricing in ${ivSkewPct > 0 ? "downside" : "upside"} risk.`;
    }
  } else {
    note = "Insufficient options data to detect institutional flow";
  }

  return {
    direction, score,
    unusualCallStrikes, unusualPutStrikes,
    ivSkewPct, fullChainPCR,
    note,
  };
}
