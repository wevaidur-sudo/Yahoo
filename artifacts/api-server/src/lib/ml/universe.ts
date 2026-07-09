/**
 * Training universe: a diversified set of liquid, long-listed US large/mid
 * caps across all 11 GICS sectors. ~200 symbols gives the model enough
 * cross-sectional variance to generalise beyond the idiosyncrasies of a
 * handful of mega-caps while remaining tractable for weekly retraining.
 */
export const TRAINING_UNIVERSE: string[] = [
  // ── Technology (30) ──────────────────────────────────────────────────────
  "AAPL", "MSFT", "NVDA", "GOOGL", "META", "ORCL", "CRM", "ADBE", "AMD", "AVGO",
  "INTC", "QCOM", "TXN", "AMAT", "MU", "NOW", "SNPS", "CDNS", "LRCX", "KLAC",
  "ADI", "MCHP", "FTNT", "PANW", "CRWD", "NET", "SNOW", "PLTR", "APP", "ABNB",

  // ── Consumer Discretionary (20) ──────────────────────────────────────────
  "AMZN", "TSLA", "HD", "MCD", "NKE", "SBUX", "TGT", "LOW", "BKNG", "CMG",
  "DHI", "LEN", "YUM", "HLT", "MAR", "ROST", "ORLY", "AZO", "GM", "F",

  // ── Consumer Staples (15) ────────────────────────────────────────────────
  "WMT", "COST", "PG", "KO", "PEP", "PM", "MO", "MDLZ", "CL", "GIS",
  "K", "HSY", "STZ", "EL", "MNST",

  // ── Financials (25) ──────────────────────────────────────────────────────
  "JPM", "BAC", "GS", "V", "MA", "AXP", "WFC", "MS", "C", "BLK",
  "SCHW", "CB", "PGR", "AON", "MMC", "ICE", "CME", "SPGI", "MCO", "COF",
  "USB", "TFC", "FI", "PYPL", "SYF",

  // ── Healthcare (20) ──────────────────────────────────────────────────────
  "JNJ", "UNH", "PFE", "ABBV", "LLY", "MRK", "TMO", "ABT", "DHR", "SYK",
  "MDT", "ELV", "HUM", "CI", "CVS", "ISRG", "VRTX", "REGN", "GILD", "AMGN",

  // ── Energy (12) ──────────────────────────────────────────────────────────
  "XOM", "CVX", "COP", "EOG", "SLB", "PSX", "VLO", "MPC", "OXY", "HES",
  "BKR", "HAL",

  // ── Industrials (20) ─────────────────────────────────────────────────────
  "CAT", "BA", "GE", "HON", "UPS", "RTX", "LMT", "NOC", "GD", "DE",
  "EMR", "ETN", "ROK", "PH", "FDX", "CSX", "NSC", "UNP", "MMM", "ITW",

  // ── Materials (10) ───────────────────────────────────────────────────────
  "LIN", "APD", "SHW", "ECL", "NEM", "FCX", "NUE", "VMC", "MLM", "CF",

  // ── Real Estate (8) ──────────────────────────────────────────────────────
  "PLD", "AMT", "EQIX", "CCI", "PSA", "AVB", "O", "SPG",

  // ── Utilities (8) ────────────────────────────────────────────────────────
  "NEE", "DUK", "SO", "AEP", "EXC", "SRE", "XEL", "WEC",

  // ── Communication Services (12) ──────────────────────────────────────────
  "DIS", "NFLX", "CMCSA", "T", "VZ", "TMUS", "WBD", "TTWO", "EA", "OMC",
  "IPG", "FOXA",
];

/**
 * Benchmark ticker used for risk-adjusted labelling.
 * SPY closely tracks the S&P 500 total return and is fetched alongside the
 * training universe so we can compute excess-return labels.
 */
export const SPY_BENCHMARK = "SPY";

/** How many trading days ahead we're predicting outperformance over. */
export const PREDICTION_HORIZON_DAYS = 21; // ~1 calendar month

/**
 * Minimum EXCESS return (stock return − SPY return) over the horizon to
 * count as a positive ("outperform") label.
 * Using 0 means we simply ask "did this stock beat the market?", which is
 * a purer signal than a fixed absolute hurdle that ignores market direction.
 */
export const OUTPERFORM_THRESHOLD = 0.0; // beat the benchmark

/** How many years of daily history to pull per symbol for training. */
export const HISTORY_YEARS = 4;

/** Number of rolling walk-forward folds used for backtest validation. */
export const WALK_FORWARD_FOLDS = 5;
