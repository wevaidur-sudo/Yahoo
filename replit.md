# FinanceScope

A full-stack market intelligence platform that scrapes, analyzes, and visualizes Yahoo Finance data with AI-powered insights and backtesting capabilities.

## Architecture

This is a pnpm monorepo with two main artifacts and shared libraries:

- **`artifacts/yahoo-finance-scraper/`** — React + Vite frontend (preview path: `/`)
- **`artifacts/api-server/`** — Express API server (preview path: `/api`, port: `$PORT`)
- **`lib/db/`** — Drizzle ORM schema + PostgreSQL client
- **`lib/api-spec/`** — OpenAPI YAML specification
- **`lib/api-zod/`** — Zod schemas generated from the OpenAPI spec
- **`lib/api-client-react/`** — TanStack Query hooks generated via orval

## Stack

- **Frontend**: React, Vite, Tailwind CSS, Radix UI, TanStack Query, Recharts, Wouter
- **Backend**: Express (Node.js), ESBuild bundler
- **Database**: PostgreSQL via Drizzle ORM
- **Data**: `yahoo-finance2` for market data, Playwright for scraping
- **AI**: Google Gemini (`@google/generative-ai`) for qualitative analysis

## How to Run

Both workflows start automatically:

- **API Server**: `pnpm --filter @workspace/api-server run dev`
- **Frontend**: `pnpm --filter @workspace/yahoo-finance-scraper run dev`

## Database

Schema is managed with Drizzle Kit. To push schema changes to the development DB:

```bash
pnpm --filter @workspace/db run push
```

## Required Secrets

| Secret | Purpose |
|--------|---------|
| `SESSION_SECRET` | Express session signing |
| `GEMINI_API_KEY` | Google Gemini AI analysis |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `EODHD_API_KEY` | EOD Historical Data API (set to `demo` by default) |
| `DATABASE_URL` | Auto-provisioned by Replit |

## Notes

- `yahoo-finance2` emits a warning about requiring Node ≥ 22 (current env is Node 20) — this is cosmetic; core features work.
- The API server builds to `dist/index.mjs` via ESBuild before starting.

## User Preferences
