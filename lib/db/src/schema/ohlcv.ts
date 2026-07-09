/**
 * OHLCV bar cache — stores intraday and daily bars fetched from any source.
 * Acts as a local warehouse so backtests re-use previously fetched data
 * instead of hitting external APIs on every run.
 */
import { pgTable, serial, text, real, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const ohlcvBarsTable = pgTable(
  "ohlcv_bars",
  {
    id: serial("id").primaryKey(),
    /** Ticker symbol, upper-case (e.g. "AAPL") */
    symbol: text("symbol").notNull(),
    /** Bar size: "1m" | "5m" | "15m" | "1d" */
    interval: text("interval").notNull(),
    /** Where the bar came from: "yahoo" | "stooq" | "polygon" */
    source: text("source").notNull(),
    /** Bar open time in UTC */
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    open:   real("open").notNull(),
    high:   real("high").notNull(),
    low:    real("low").notNull(),
    close:  real("close").notNull(),
    volume: real("volume").notNull(),
    /** When this record was written — useful for staleness checks */
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Primary lookup key — guarantees one bar per (symbol, interval, time).
    uniqueIndex("ohlcv_bars_sym_int_ts_idx").on(t.symbol, t.interval, t.timestamp),
    // Range queries: symbol + interval + timestamp range
    index("ohlcv_bars_sym_int_range_idx").on(t.symbol, t.interval, t.timestamp),
  ],
);

export const insertOhlcvBarSchema = createInsertSchema(ohlcvBarsTable).omit({ id: true, fetchedAt: true });
export type InsertOhlcvBar = z.infer<typeof insertOhlcvBarSchema>;
export type OhlcvBar = typeof ohlcvBarsTable.$inferSelect;
