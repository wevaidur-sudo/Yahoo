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

## Required Secrets

| Secret | Purpose |
|--------|---------|
| `GEMINI_API_KEY` | AI-powered qualitative analysis |
| `TIINGO_API_KEY` | Fallback data for delisted tickers |
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
