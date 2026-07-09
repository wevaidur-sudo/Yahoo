CREATE TABLE "ml_fundamentals_cache" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"trailing_pe" real,
	"forward_pe" real,
	"peg_ratio" real,
	"price_to_book" real,
	"revenue_growth" real,
	"earnings_growth" real,
	"gross_margins" real,
	"return_on_equity" real,
	"debt_to_equity" real,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ml_historical_prices" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"date" text NOT NULL,
	"open" real NOT NULL,
	"high" real NOT NULL,
	"low" real NOT NULL,
	"close" real NOT NULL,
	"volume" real NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ml_models" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"horizon_days" integer NOT NULL,
	"feature_names" jsonb NOT NULL,
	"model" jsonb NOT NULL,
	"train_sample_size" integer NOT NULL,
	"test_sample_size" integer NOT NULL,
	"backtest_accuracy" real NOT NULL,
	"backtest_win_rate" real NOT NULL,
	"backtest_base_rate" real NOT NULL,
	"trained_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ml_symbol_score_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"as_of_date" text NOT NULL,
	"overall_score" real NOT NULL,
	"momentum_score" real NOT NULL,
	"value_score" real NOT NULL,
	"low_risk_score" real NOT NULL,
	"overall_model_version" integer NOT NULL,
	"momentum_model_version" integer NOT NULL,
	"value_model_version" integer NOT NULL,
	"low_risk_model_version" integer NOT NULL,
	"horizon_days" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ml_symbol_scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"overall_score" real NOT NULL,
	"momentum_score" real NOT NULL,
	"value_score" real NOT NULL,
	"low_risk_score" real NOT NULL,
	"overall_model_version" integer NOT NULL,
	"momentum_model_version" integer NOT NULL,
	"value_model_version" integer NOT NULL,
	"low_risk_model_version" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ml_fundamentals_cache_symbol_idx" ON "ml_fundamentals_cache" USING btree ("symbol");--> statement-breakpoint
CREATE UNIQUE INDEX "ml_historical_prices_symbol_date_idx" ON "ml_historical_prices" USING btree ("symbol","date");--> statement-breakpoint
CREATE INDEX "ml_historical_prices_symbol_idx" ON "ml_historical_prices" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "ml_models_kind_trained_at_idx" ON "ml_models" USING btree ("kind","trained_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ml_symbol_score_history_symbol_date_idx" ON "ml_symbol_score_history" USING btree ("symbol","as_of_date");--> statement-breakpoint
CREATE INDEX "ml_symbol_score_history_symbol_idx" ON "ml_symbol_score_history" USING btree ("symbol");--> statement-breakpoint
CREATE UNIQUE INDEX "ml_symbol_scores_symbol_idx" ON "ml_symbol_scores" USING btree ("symbol");