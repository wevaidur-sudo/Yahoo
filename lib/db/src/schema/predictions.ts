/**
 * ML prediction tracking schema.
 *
 * prediction_signals: stores input features for each analysis call
 * prediction_outcomes: stores actual market outcomes (filled post-session)
 *
 * Together these tables provide the training dataset for the ML predictor.
 */
import {
  pgTable,
  serial,
  text,
  real,
  integer,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const predictionSignalsTable = pgTable(
  "prediction_signals",
  {
    id: serial("id").primaryKey(),
    /** Ticker symbol, upper-case */
    symbol: text("symbol").notNull(),
    /** Trading day in ET: "YYYY-MM-DD" */
    sessionDate: text("session_date").notNull(),
    /** Existing engine: intraday conviction score 0–100 */
    intradayConviction: real("intraday_conviction"),
    /** Existing engine: 1 = bullish, -1 = bearish, 0 = no-trade */
    intradayDirection: integer("intraday_direction"),
    /** Gap from previous close: % */
    gapPct: real("gap_pct"),
    /** Relative volume at time of prediction */
    rvol: real("rvol"),
    /** Pre-market momentum score: -20 to +20 */
    preMarketScore: real("pre_market_score"),
    /** Options flow score: -15 to +15 */
    optionsFlowScore: real("options_flow_score"),
    /** News sentiment score: -15 to +15 */
    newsSentimentScore: real("news_sentiment_score"),
    /** Market regime score: -10 to +10 */
    regimeScore: real("regime_score"),
    /** Hour of day (ET) when prediction was made: 9.5 = 9:30 AM */
    hourOfDay: real("hour_of_day"),
    /** Setup type from trade setup generator */
    setupType: text("setup_type"),
    /** When this prediction was recorded */
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("pred_signals_sym_date_idx").on(t.symbol, t.sessionDate),
    index("pred_signals_recorded_idx").on(t.recordedAt),
  ],
);

export const predictionOutcomesTable = pgTable(
  "prediction_outcomes",
  {
    id: serial("id").primaryKey(),
    /** FK to prediction_signals */
    predictionId: integer("prediction_id")
      .notNull()
      .references(() => predictionSignalsTable.id, { onDelete: "cascade" }),
    /** Was the directional call correct? */
    directionCorrect: boolean("direction_correct"),
    /** Max favorable excursion / risk (R-multiple at best point) */
    maxRMultiple: real("max_r_multiple"),
    /** Final P&L in R units (negative = loss) */
    finalRMultiple: real("final_r_multiple"),
    /** When the outcome was recorded */
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("pred_outcomes_pred_idx").on(t.predictionId),
  ],
);

export type InsertPredictionSignal = typeof predictionSignalsTable.$inferInsert;
export type PredictionSignal = typeof predictionSignalsTable.$inferSelect;
export type InsertPredictionOutcome = typeof predictionOutcomesTable.$inferInsert;
export type PredictionOutcome = typeof predictionOutcomesTable.$inferSelect;
