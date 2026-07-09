/**
 * Fixed training universe: a diversified set of liquid, long-listed US
 * large/mid caps across sectors. Kept as a static list (rather than
 * dynamically fetched) so training runs are reproducible and bounded in
 * size/time — pulling full-market history would be far too slow for an
 * interactive Repl environment.
 */
export const TRAINING_UNIVERSE: string[] = [
  // Technology
  "AAPL", "MSFT", "NVDA", "GOOGL", "META", "ORCL", "CRM", "ADBE", "AMD", "AVGO",
  // Consumer / Retail
  "AMZN", "WMT", "COST", "HD", "NKE", "MCD", "SBUX", "TGT",
  // Financials
  "JPM", "BAC", "GS", "V", "MA", "AXP",
  // Healthcare
  "JNJ", "UNH", "PFE", "ABBV", "LLY", "MRK",
  // Industrials / Energy
  "XOM", "CVX", "CAT", "BA", "GE", "HON",
  // Communication / Media
  "DIS", "NFLX", "CMCSA", "T",
  // Staples / Utilities
  "PG", "KO", "PEP", "NEE",
];

/** How many trading days ahead we're predicting outperformance over. */
export const PREDICTION_HORIZON_DAYS = 10;

/** Minimum forward return to count as a positive ("outperform") label. */
export const OUTPERFORM_THRESHOLD = 0.005; // +0.5% over the horizon

/** How many years of daily history to pull per symbol for training. */
export const HISTORY_YEARS = 4;
