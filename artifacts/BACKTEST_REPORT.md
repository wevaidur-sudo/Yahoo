# Intraday Signal Engine — Backtest Report

Generated: 2026-07-09T18:38:53.992Z

## Methodology
- Symbols (18): AAPL, MSFT, NVDA, AMZN, TSLA, META, GOOGL, SPY, QQQ, AMD, NFLX, JPM, XOM, UNH, COST, AVGO, CRM, ORCL
- Data: Stooq 5m bars (years of history, no pre/post market; Yahoo as fallback ~60 days) + daily bars (~500 days) for PDH/PDL/ATR/avg-volume. Results cached in ohlcv_bars DB table.
- Decision windows tested per trading day (ET): 10:15, 11:00, 13:45
- Uses the exact production code path: `computeIntradayLevels` → `computeIntradaySignals` → `generateTradeSetup`
- **Walk-forward split**: first 65% of each symbol's trading days = TRAIN (used only to derive the setup-type quality gate below), last 35% = TEST (held out, scored with the gate frozen from TRAIN — this is genuine out-of-sample evidence, not a re-fit)
- Trade outcome: simulated bar-by-bar until stop or target1 hit, or scored mark-to-close if neither hit by session end
- **No commissions, spread, or slippage modeled.** Pre-market signals are inactive in this backtest (Yahoo 5m history excludes pre/post bars) — they are live in production, which uses 1m bars with pre/post included.

## Setup-Type Quality Gate (derived from TRAIN only, N ≥ 12)
| Setup Type | N (train) | Win Rate | Avg R | Verdict |
|---|---|---|---|---|


**Allowed setup types (shipped to production):** none met the bar

## TRAIN Results (in-sample — for reference only, not evidence)
- N=0, win rate 0.0%, avg +0.00R

## TEST Results (held-out — this is the real evidence)
| | N | Win Rate | Avg R |
|---|---|---|---|
| Unfiltered (all setup types) | 0 | 0.0% | +0.00R |
| **With quality gate applied** | 0 | **0.0%** | **+0.00R** |

Filtering out setup types that showed negative or unreliable edge on TRAIN, and re-scoring only
on TEST (data the gate never saw), moved win rate from 0.0% to
0.0% and average R from 0.00R to 0.00R.
The gate did NOT clearly improve out-of-sample expectancy — treat the allowlist as provisional, not proven.

## Full Breakdown (all trades, both phases combined)
### By Setup Type
| Setup Type | N | Win Rate | Avg R |
|---|---|---|---|


### By Conviction Bucket
| Conviction | N | Win Rate | Avg R |
|---|---|---|---|


### By Bias
| Bias | N | Win Rate | Avg R |
|---|---|---|---|


## Operational Stats
- Total setups generated: 0
- Filtered as no-trade (conviction/R:R gates, before the setup-type gate): 0
- Fetch/compute errors: 18

## Caveats (read before acting on this)
This is walk-forward evidence, which is meaningfully stronger than a single in-sample run — but
the TEST sample (~0 trades) is still modest. Treat the setup-type gate as
**provisional and subject to revision** as more data accrues; rerun `pnpm run backtest` monthly
and update `EMPIRICAL_SETUP_ALLOWLIST` in `intraday-signals.ts` from the new TRAIN verdicts.
No backtest — however rigorous — is a substitute for paper-trading before risking real capital,
because live fills, slippage, and regime changes are not captured here.
