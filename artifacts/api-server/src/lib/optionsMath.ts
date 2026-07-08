/**
 * Real, formula-based options math: Black-Scholes pricing, Greeks, and
 * lognormal-distribution probability-of-profit for arbitrary multi-leg
 * strategies. This module exists so numeric outputs (prices, probabilities,
 * P&L) are derived from finance theory, never guessed by an LLM.
 */

// ─── Normal distribution helpers ──────────────────────────────────────────────

/** Abramowitz & Stegun approximation of the error function (accurate to ~1e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

export function normCDF(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export function normPDF(x: number): number {
  return Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);
}

// ─── Risk-free rate ────────────────────────────────────────────────────────────

/** Fallback annualized risk-free rate if the live treasury quote can't be fetched. */
export const FALLBACK_RISK_FREE_RATE = 0.045;

// ─── Time helpers ──────────────────────────────────────────────────────────────

export function timeToExpiryYears(expiry: Date | string | number, now: Date): number {
  const expiryDate = expiry instanceof Date ? expiry : new Date(expiry);
  const ms = expiryDate.getTime() - now.getTime();
  return Math.max(ms / (365.25 * 24 * 60 * 60 * 1000), 1 / 365.25 / 24); // floor at ~1 hour
}

// ─── Black-Scholes pricing & Greeks ────────────────────────────────────────────

export interface BlackScholesInputs {
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  volatility: number; // decimal, e.g. 0.32 for 32%
  optionType: "call" | "put";
}

export interface BlackScholesResult {
  theoreticalPrice: number;
  delta: number;
  gamma: number;
  /** Per calendar day. */
  theta: number;
  /** Per 1 percentage-point change in IV. */
  vega: number;
  /** Per 1 percentage-point change in rates. */
  rho: number;
  /** Risk-neutral probability the option finishes in-the-money. */
  probabilityITM: number;
}

export function blackScholes(inputs: BlackScholesInputs): BlackScholesResult | null {
  const { spot, strike, timeToExpiryYears: T, riskFreeRate: r, volatility: sigma, optionType } = inputs;
  if (!(spot > 0) || !(strike > 0) || !(T > 0) || !(sigma > 0)) return null;

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (r + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  let price: number, delta: number, probabilityITM: number, theta: number, rho: number;

  if (optionType === "call") {
    price = spot * normCDF(d1) - strike * Math.exp(-r * T) * normCDF(d2);
    delta = normCDF(d1);
    probabilityITM = normCDF(d2);
    theta =
      (-((spot * normPDF(d1) * sigma) / (2 * sqrtT)) - r * strike * Math.exp(-r * T) * normCDF(d2)) / 365;
    rho = (strike * T * Math.exp(-r * T) * normCDF(d2)) / 100;
  } else {
    price = strike * Math.exp(-r * T) * normCDF(-d2) - spot * normCDF(-d1);
    delta = normCDF(d1) - 1;
    probabilityITM = normCDF(-d2);
    theta =
      (-((spot * normPDF(d1) * sigma) / (2 * sqrtT)) + r * strike * Math.exp(-r * T) * normCDF(-d2)) / 365;
    rho = (-strike * T * Math.exp(-r * T) * normCDF(-d2)) / 100;
  }

  const gamma = normPDF(d1) / (spot * sigma * sqrtT);
  const vega = (spot * normPDF(d1) * sqrtT) / 100;

  return {
    theoreticalPrice: +price.toFixed(4),
    delta: +delta.toFixed(4),
    gamma: +gamma.toFixed(6),
    theta: +theta.toFixed(4),
    vega: +vega.toFixed(4),
    rho: +rho.toFixed(4),
    probabilityITM: +(probabilityITM * 100).toFixed(2),
  };
}

// ─── Multi-leg payoff & probability-of-profit engine ──────────────────────────

export interface PayoffLeg {
  type: "call" | "put" | "stock";
  action: "buy" | "sell";
  strike?: number | null;
  /** Premium per share (options) or entry price (stock). */
  premium?: number | null;
  contracts: number; // number of option contracts (100 shares) or share lots for stock
}

/** Net payoff (profit/loss in dollars) of a leg combination at a given terminal stock price. */
function payoffAt(price: number, legs: PayoffLeg[]): number {
  let total = 0;
  for (const leg of legs) {
    const qty = leg.contracts || 0;
    const premium = leg.premium ?? 0;
    const sign = leg.action === "buy" ? 1 : -1;

    if (leg.type === "stock") {
      // shares, not contracts; premium = entry price
      total += sign * qty * (price - premium);
      continue;
    }

    const strike = leg.strike ?? 0;
    const intrinsic = leg.type === "call" ? Math.max(price - strike, 0) : Math.max(strike - price, 0);
    // Buying: pay premium up front, receive intrinsic value at expiry.
    // Selling: receive premium up front, pay out intrinsic value at expiry.
    const perShare = sign > 0 ? intrinsic - premium : premium - intrinsic;
    total += sign > 0 ? perShare * qty * 100 : (premium - intrinsic) * qty * 100;
  }
  return total;
}

export interface StrategyMetrics {
  /** Net debit (positive) or credit (negative) to open the position, in dollars. */
  netCost: number;
  maxProfit: number | "unlimited";
  maxLoss: number | "unlimited";
  breakevens: number[];
  /** Risk-neutral probability of finishing with payoff > 0 at expiry, 0-100. */
  probabilityOfProfit: number | null;
}

/**
 * Computes exact payoff-based metrics for an arbitrary combination of legs by
 * sampling a wide price grid (rather than special-casing named strategies),
 * then integrating the risk-neutral lognormal terminal-price distribution to
 * get a real probability of profit.
 */
/**
 * Analytic asymptotic slope of the payoff function as the terminal stock price
 * approaches infinity. Since the stock price is floored at 0, the ONLY way a
 * position can have truly unbounded risk/reward is via this upper tail:
 *  - long call / long stock: payoff keeps rising linearly  -> +slope
 *  - short call / short stock: payoff keeps falling linearly -> -slope
 *  - puts (long or short): intrinsic value -> 0 as price -> infinity, so puts
 *    contribute nothing to the asymptotic slope; their extremes are always
 *    bounded and captured by evaluating the payoff near price = 0.
 * This replaces a fragile numeric-slope heuristic that misclassified bounded
 * long-put profit (whose max occurs at price -> 0, not "unlimited loss").
 */
function asymptoticSlope(legs: PayoffLeg[]): number {
  return legs.reduce((slope, leg) => {
    const sign = leg.action === "buy" ? 1 : -1;
    if (leg.type === "stock") return slope + sign * leg.contracts;
    if (leg.type === "call") return slope + sign * leg.contracts * 100;
    return slope; // puts contribute 0 asymptotic slope
  }, 0);
}

export function computeStrategyMetrics(params: {
  legs: PayoffLeg[];
  spot: number;
  avgVolatility: number; // decimal
  timeToExpiryYears: number;
  riskFreeRate: number;
}): StrategyMetrics {
  const { legs, spot, avgVolatility, timeToExpiryYears: T, riskFreeRate: r } = params;

  const netCost = legs.reduce((sum, leg) => {
    const sign = leg.action === "buy" ? 1 : -1;
    if (leg.type === "stock") return sum + sign * leg.contracts * (leg.premium ?? 0);
    return sum + sign * leg.contracts * 100 * (leg.premium ?? 0);
  }, 0);

  // Bound the sampling grid to comfortably span every strike involved, plus a
  // near-zero floor (the true worst case for e.g. a covered call or cash-secured
  // put is the stock going to $0, which is a *bounded*, computable value).
  const strikes = legs.map((l) => l.strike).filter((s): s is number => typeof s === "number" && s > 0);
  const maxStrike = strikes.length ? Math.max(...strikes) : spot;
  const lowerBound = Math.max(spot * 0.001, 0.01);
  const upperBound = Math.max(spot * 3, maxStrike * 2);
  const steps = 6000;
  const stepSize = (upperBound - lowerBound) / steps;

  let maxProfit = -Infinity;
  let maxLoss = Infinity;
  const breakevens: number[] = [];
  let prevPrice = lowerBound;
  let prevPayoff = payoffAt(prevPrice, legs);

  for (let i = 1; i <= steps; i++) {
    const price = lowerBound + i * stepSize;
    const payoff = payoffAt(price, legs);
    if (payoff > maxProfit) maxProfit = payoff;
    if (payoff < maxLoss) maxLoss = payoff;

    // Detect sign change -> breakeven crossing (linear interpolation).
    if ((prevPayoff <= 0 && payoff > 0) || (prevPayoff >= 0 && payoff < 0)) {
      const frac = prevPayoff === payoff ? 0 : -prevPayoff / (payoff - prevPayoff);
      breakevens.push(+(prevPrice + frac * (price - prevPrice)).toFixed(2));
    }
    prevPrice = price;
    prevPayoff = payoff;
  }

  // Unbounded risk/reward can only occur on the upper tail (price floors at 0
  // on the lower side, so that side is always bounded and already captured
  // by the grid above).
  const slope = asymptoticSlope(legs);
  const unlimitedProfit = slope > 0.0001;
  const unlimitedLoss = slope < -0.0001;

  let probabilityOfProfit: number | null = null;
  if (avgVolatility > 0 && T > 0 && spot > 0) {
    // Integrate the risk-neutral lognormal density of the terminal price across
    // the same grid, summing probability mass where payoff(price) > 0. The grid
    // is wide enough (3x spot / 2x max strike) that any mass beyond it shares
    // the same payoff sign as the boundary, so normalizing by sampled mass is a
    // sound approximation of the true probability.
    const mu = Math.log(spot) + (r - (avgVolatility * avgVolatility) / 2) * T;
    const sigma = avgVolatility * Math.sqrt(T);
    let profitMass = 0;
    let totalMass = 0;
    for (let i = 0; i <= steps; i++) {
      const price = lowerBound + i * stepSize;
      if (price <= 0) continue;
      const z = (Math.log(price) - mu) / sigma;
      const density = normPDF(z) / (price * sigma);
      totalMass += density * stepSize;
      const payoff = payoffAt(price, legs);
      if (payoff > 0) profitMass += density * stepSize;
    }
    probabilityOfProfit = totalMass > 0 ? +((profitMass / totalMass) * 100).toFixed(1) : null;
  }

  return {
    netCost: +netCost.toFixed(2),
    maxProfit: unlimitedProfit ? "unlimited" : +maxProfit.toFixed(2),
    maxLoss: unlimitedLoss ? "unlimited" : +maxLoss.toFixed(2),
    breakevens: [...new Set(breakevens)].sort((a, b) => a - b),
    probabilityOfProfit,
  };
}

// ─── Data quality checks ───────────────────────────────────────────────────────

export interface DataQualityFlags {
  quoteAgeSeconds: number | null;
  quoteStale: boolean;
  liquidityWarnings: string[];
}

export function assessDataQuality(params: {
  quoteTimeMs?: number | null;
  now: Date;
  contracts: Array<{ label: string; volume?: number | null; openInterest?: number | null; bid?: number | null; ask?: number | null }>;
}): DataQualityFlags {
  const { quoteTimeMs, now, contracts } = params;
  const quoteAgeSeconds = quoteTimeMs ? Math.round((now.getTime() - quoteTimeMs) / 1000) : null;
  const quoteStale = quoteAgeSeconds !== null && quoteAgeSeconds > 900; // >15 min is stale for a "live" quote

  const liquidityWarnings: string[] = [];
  for (const c of contracts) {
    const oi = c.openInterest ?? 0;
    const vol = c.volume ?? 0;
    if (oi < 50 && vol < 10) {
      liquidityWarnings.push(`${c.label}: thin liquidity (OI ${oi}, volume ${vol}) — fills may be poor`);
    }
    if (c.bid != null && c.ask != null && c.bid > 0) {
      const spreadPct = ((c.ask - c.bid) / ((c.ask + c.bid) / 2)) * 100;
      if (spreadPct > 15) {
        liquidityWarnings.push(`${c.label}: wide bid/ask spread (${spreadPct.toFixed(0)}%) — real fill price may differ from mid`);
      }
    }
  }

  return { quoteAgeSeconds, quoteStale, liquidityWarnings };
}
