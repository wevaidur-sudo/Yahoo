# Intraday Signal Engine — Backtest Report

Generated: 2026-07-09T17:26:27.264Z

## Methodology
- Symbols (18): AAPL, MSFT, NVDA, AMZN, TSLA, META, GOOGL, SPY, QQQ, AMD, NFLX, JPM, XOM, UNH, COST, AVGO, CRM, ORCL
- Data: Yahoo Finance 5m bars (~58 days, no pre/post market) + 1d bars (~150 days) for PDH/PDL/ATR/avg-volume
- Decision windows tested per trading day (ET): 10:15, 11:00, 13:45
- Uses the exact production code path: `computeIntradayLevels` → `computeIntradaySignals` → `generateTradeSetup`
- **Walk-forward split**: first 65% of each symbol's trading days = TRAIN (used only to derive the setup-type quality gate below), last 35% = TEST (held out, scored with the gate frozen from TRAIN — this is genuine out-of-sample evidence, not a re-fit)
- Trade outcome: simulated bar-by-bar until stop or target1 hit, or scored mark-to-close if neither hit by session end
- **No commissions, spread, or slippage modeled.** Pre-market signals are inactive in this backtest (Yahoo 5m history excludes pre/post bars) — they are live in production, which uses 1m bars with pre/post included.

## Setup-Type Quality Gate (derived from TRAIN only, N ≥ 12)
| Setup Type | N (train) | Win Rate | Avg R | Verdict |
|---|---|---|---|---|
| Previous Day Low Breakdown | 31 | 41.9% | +0.08R | ✅ ALLOWED |
| VWAP Rejection | 44 | 54.5% | +0.08R | ✅ ALLOWED |

**Allowed setup types (shipped to production):** Previous Day Low Breakdown, VWAP Rejection

## TRAIN Results (in-sample — for reference only, not evidence)
- N=75, win rate 49.3%, avg +0.08R

## TEST Results (held-out — this is the real evidence)
| | N | Win Rate | Avg R |
|---|---|---|---|
| Unfiltered (all setup types) | 50 | 50.0% | +0.08R |
| **With quality gate applied** | 50 | **50.0%** | **+0.08R** |

Filtering out setup types that showed negative or unreliable edge on TRAIN, and re-scoring only
on TEST (data the gate never saw), moved win rate from 50.0% to
50.0% and average R from 0.08R to 0.08R.
The gate did NOT clearly improve out-of-sample expectancy — treat the allowlist as provisional, not proven.

## Full Breakdown (all trades, both phases combined)
### By Setup Type
| Setup Type | N | Win Rate | Avg R |
|---|---|---|---|
| Previous Day Low Breakdown | 63 | 46.0% | +0.16R |
| VWAP Rejection | 62 | 53.2% | -0.00R |

### By Conviction Bucket
| Conviction | N | Win Rate | Avg R |
|---|---|---|---|
| 25-40 | 17 | 52.9% | -0.05R |
| 40-60 | 52 | 44.2% | +0.10R |
| 60-80 | 23 | 47.8% | +0.09R |
| 80-100 | 33 | 57.6% | +0.10R |

### By Bias
| Bias | N | Win Rate | Avg R |
|---|---|---|---|
| short | 125 | 49.6% | +0.08R |

## Operational Stats
- Total setups generated: 125
- Filtered as no-trade (conviction/R:R gates, before the setup-type gate): 1999
- Fetch/compute errors: 0

## Caveats (read before acting on this)
This is walk-forward evidence, which is meaningfully stronger than a single in-sample run — but
the TEST sample (~50 trades) is still modest. Treat the setup-type gate as
**provisional and subject to revision** as more data accrues; rerun `pnpm run backtest` monthly
and update `EMPIRICAL_SETUP_ALLOWLIST` in `intraday-signals.ts` from the new TRAIN verdicts.
No backtest — however rigorous — is a substitute for paper-trading before risking real capital,
because live fills, slippage, and regime changes are not captured here.
