# FinanceScope

A market intelligence platform for real-time stock, crypto, ETF, and futures data. Features a machine-learning pipeline for market analysis and AI-driven stock analysis via Google Gemini.

## Stack

- **Frontend:** React 19, Vite, Tailwind CSS 4, Radix UI, Wouter (routing), React Query
- **Backend:** Node.js 24, Express 5, Drizzle ORM, PostgreSQL
- **Data:** yahoo-finance2 (primary), Tiingo API (fallback for delisted tickers)
- **AI:** Google Gemini SDK for qualitative analysis overlay
- **ML:** Custom GBM pipeline for signal scoring
- **Monorepo:** pnpm workspaces

## Project Structure

```
artifacts/
  api-server/          # Express backend + ML training scripts
  yahoo-finance-scraper/ # React frontend
  mockup-sandbox/      # UI component dev environment
lib/
  db/                  # Drizzle ORM schema + config
  api-spec/            # OpenAPI spec (source of truth for codegen)
  api-zod/             # Generated Zod schemas + React Query hooks
  ml/                  # ML feature generation and scoring
```

## Running the App

Three workflows are configured and start automatically:

| Workflow | Command |
|----------|---------|
| API Server | `pnpm --filter @workspace/api-server run dev` |
| Frontend | `pnpm --filter @workspace/yahoo-finance-scraper run dev` |
| Mockup Sandbox | `pnpm --filter @workspace/mockup-sandbox run dev` |

## Database

Uses Replit's built-in PostgreSQL (`DATABASE_URL` is auto-injected). To push schema changes:

```bash
pnpm --filter @workspace/db push
```

The schema includes an `ohlcv_bars` table that caches OHLCV bars fetched during backtests. Run the above push command once after provisioning the database so the cache is available.

## Backtesting

```bash
pnpm --filter @workspace/api-server run backtest
```

Data sources tried in order for intraday (5m) bars:
1. **DB cache** (`ohlcv_bars`) — zero network cost, populated on first run
2. **Alpha Vantage** — ~30 days on free plan; full history on premium (month-by-month fetch)
3. **Yahoo Finance** — ~60-day fallback (automatically clamped to its supported window)

For daily (1d) bars the order is DB cache → Yahoo → Alpha Vantage (up to 20 years).

## Required Secrets

| Secret | Purpose |
|--------|---------|
| `ALPHA_VANTAGE_API_KEY` | OHLCV bar data (intraday + daily) |
| `GEMINI_API_KEY` | AI-powered qualitative analysis |
| `SESSION_SECRET` | Express session signing |

## Type Codegen

After changing the OpenAPI spec (`lib/api-spec`), regenerate types:

```bash
pnpm --filter @workspace/api-spec run codegen
```

## ML Training

```bash
pnpm --filter @workspace/api-server run train-ml
```

## User Preferences

- Keep existing project structure and stack — do not restructure or migrate.
