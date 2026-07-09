import {
  pgTable,
  serial,
  text,
  real,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  boolean,
} from "drizzle-orm/pg-core";

/**
 * Daily OHLCV bars pulled from Yahoo Finance for the training symbol universe.
 * This is the raw substrate the feature-engineering pipeline reads from to
 * build point-in-time training rows — kept separate from any live/derived data.
 */
export const historicalPricesTable = pgTable(
  "ml_historical_prices",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    date: text("date").notNull(), // ISO date (YYYY-MM-DD), daily bar
    open: real("open").notNull(),
    high: real("high").notNull(),
    low: real("low").notNull(),
    close: real("close").notNull(),
    volume: real("volume").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ml_historical_prices_symbol_date_idx").on(t.symbol, t.date),
    index("ml_historical_prices_symbol_idx").on(t.symbol),
  ],
);

/**
 * A trained gradient-boosted-tree model artifact for one score "kind"
 * (overall / momentum / value / lowRisk). Model internals (trees) are
 * serialized as JSON so inference can run in-process without native deps.
 * The most recent row per `kind` (highest `trainedAt`) is the active model.
 */
export const mlModelsTable = pgTable(
  "ml_models",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(), // "overall" | "momentum" | "value" | "lowRisk"
    version: integer("version").notNull(),
    horizonDays: integer("horizon_days").notNull(),
    featureNames: jsonb("feature_names").notNull().$type<string[]>(),
    model: jsonb("model").notNull().$type<unknown>(), // serialized GradientBoostedTrees
    trainSampleSize: integer("train_sample_size").notNull(),
    testSampleSize: integer("test_sample_size").notNull(),
    backtestAccuracy: real("backtest_accuracy").notNull(), // 0-100, holdout accuracy
    backtestWinRate: real("backtest_win_rate").notNull(), // 0-100, precision on positive predictions
    backtestBaseRate: real("backtest_base_rate").notNull(), // 0-100, share of positive labels in holdout
    trainedAt: timestamp("trained_at", { withTimezone: true }).notNull().defaultNow(),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [index("ml_models_kind_trained_at_idx").on(t.kind, t.trainedAt)],
);

/**
 * Cached most-recent quant score per symbol (one row per symbol, upserted),
 * so repeated lookups within the freshness window don't need to recompute
 * features/inference. Tracks the exact model version used for *each* of the
 * 4 sub-scores independently so a partial retrain (e.g. just "lowRisk") is
 * detected and invalidates only what's stale.
 */
export const symbolScoresTable = pgTable(
  "ml_symbol_scores",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    overallScore: real("overall_score").notNull(),
    momentumScore: real("momentum_score").notNull(),
    valueScore: real("value_score").notNull(),
    lowRiskScore: real("low_risk_score").notNull(),
    overallModelVersion: integer("overall_model_version").notNull(),
    momentumModelVersion: integer("momentum_model_version").notNull(),
    valueModelVersion: integer("value_model_version").notNull(),
    lowRiskModelVersion: integer("low_risk_model_version").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ml_symbol_scores_symbol_idx").on(t.symbol)],
);

/**
 * Append-only history of every quant score computed for a symbol, so past
 * predictions can be queried/audited/displayed (e.g. "score 10 trading days
 * ago") without recomputing anything — this is the historical record the
 * live `symbolScoresTable` cache row does NOT preserve (it's overwritten).
 * Also underlies future "did the prediction come true" analysis once actual
 * forward returns are known.
 */
export const symbolScoreHistoryTable = pgTable(
  "ml_symbol_score_history",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    asOfDate: text("as_of_date").notNull(), // ISO date (YYYY-MM-DD) the score was computed for
    overallScore: real("overall_score").notNull(),
    momentumScore: real("momentum_score").notNull(),
    valueScore: real("value_score").notNull(),
    lowRiskScore: real("low_risk_score").notNull(),
    overallModelVersion: integer("overall_model_version").notNull(),
    momentumModelVersion: integer("momentum_model_version").notNull(),
    valueModelVersion: integer("value_model_version").notNull(),
    lowRiskModelVersion: integer("low_risk_model_version").notNull(),
    horizonDays: integer("horizon_days").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ml_symbol_score_history_symbol_date_idx").on(t.symbol, t.asOfDate),
    index("ml_symbol_score_history_symbol_idx").on(t.symbol),
  ],
);

/**
 * Cached current fundamentals snapshot per training symbol, so the training
 * pipeline doesn't need a live network round-trip per symbol on every run.
 * Reused across all of that symbol's historical rows (see Value sub-score
 * caveat documented in features.ts/pipeline.ts).
 */
export const fundamentalsCacheTable = pgTable(
  "ml_fundamentals_cache",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    trailingPE: real("trailing_pe"),
    forwardPE: real("forward_pe"),
    pegRatio: real("peg_ratio"),
    priceToBook: real("price_to_book"),
    revenueGrowth: real("revenue_growth"),
    earningsGrowth: real("earnings_growth"),
    grossMargins: real("gross_margins"),
    returnOnEquity: real("return_on_equity"),
    debtToEquity: real("debt_to_equity"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ml_fundamentals_cache_symbol_idx").on(t.symbol)],
);

export type HistoricalPriceRow = typeof historicalPricesTable.$inferSelect;
export type InsertHistoricalPriceRow = typeof historicalPricesTable.$inferInsert;
export type MlModelRow = typeof mlModelsTable.$inferSelect;
export type InsertMlModelRow = typeof mlModelsTable.$inferInsert;
export type SymbolScoreRow = typeof symbolScoresTable.$inferSelect;
export type InsertSymbolScoreRow = typeof symbolScoresTable.$inferInsert;
export type SymbolScoreHistoryRow = typeof symbolScoreHistoryTable.$inferSelect;
export type InsertSymbolScoreHistoryRow = typeof symbolScoreHistoryTable.$inferInsert;
