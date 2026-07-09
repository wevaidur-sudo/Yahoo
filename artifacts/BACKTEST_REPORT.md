# Intraday Signal Engine — Backtest Report

Generated: 2026-07-09T19:02:37.658Z

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
| ORB Breakdown | 37 | 29.7% | -0.16R | ⛔ negative edge |
| ORB Breakout | 61 | 23.0% | -0.41R | ⛔ negative edge |
| Pre-Market High Breakout | 52 | 50.0% | -0.03R | ⛔ negative edge |
| Pre-Market Low Breakdown | 43 | 55.8% | +0.18R | ✅ ALLOWED |
| Previous Day High Breakout | 81 | 38.3% | -0.30R | ⛔ negative edge |
| Previous Day Low Breakdown | 76 | 65.8% | +0.48R | ✅ ALLOWED |
| VWAP Reclaim | 6 | 16.7% | -0.55R | ⛔ insufficient data |
| VWAP Rejection | 12 | 50.0% | +0.03R | ✅ ALLOWED |
| VWAP Trend Long | 7 | 42.9% | +0.10R | ⛔ insufficient data |
| VWAP Trend Short | 15 | 40.0% | -0.34R | ⛔ negative edge |

**Allowed setup types (shipped to production):** Pre-Market Low Breakdown, Previous Day Low Breakdown, VWAP Rejection

## TRAIN Results (in-sample — for reference only, not evidence)
- N=390, win rate 44.1%, avg -0.05R

## TEST Results (held-out — this is the real evidence)
| | N | Win Rate | Avg R |
|---|---|---|---|
| Unfiltered (all setup types) | 189 | 37.0% | -0.18R |
| **With quality gate applied** | 61 | **41.0%** | **-0.08R** |

Filtering out setup types that showed negative or unreliable edge on TRAIN, and re-scoring only
on TEST (data the gate never saw), moved win rate from 37.0% to
41.0% and average R from -0.18R to -0.08R.
The gate improved out-of-sample expectancy.

## Full Breakdown (all trades, both phases combined)
### By Setup Type
| Setup Type | N | Win Rate | Avg R |
|---|---|---|---|
| ORB Breakdown | 53 | 32.1% | -0.13R |
| ORB Breakout | 91 | 19.8% | -0.44R |
| Pre-Market High Breakout | 67 | 50.7% | +0.03R |
| Pre-Market Low Breakdown | 63 | 50.8% | +0.14R |
| Previous Day High Breakout | 131 | 36.6% | -0.31R |
| Previous Day Low Breakdown | 113 | 56.6% | +0.26R |
| VWAP Reclaim | 10 | 20.0% | -0.62R |
| VWAP Rejection | 16 | 56.3% | +0.06R |
| VWAP Trend Long | 13 | 61.5% | +0.19R |
| VWAP Trend Short | 22 | 45.5% | -0.18R |

### By Conviction Bucket
| Conviction | N | Win Rate | Avg R |
|---|---|---|---|
| 25-40 | 42 | 47.6% | -0.07R |
| 40-60 | 83 | 44.6% | +0.09R |
| 60-80 | 38 | 31.6% | -0.17R |
| 80-100 | 416 | 41.6% | -0.12R |

### By Bias
| Bias | N | Win Rate | Avg R |
|---|---|---|---|
| long | 312 | 35.3% | -0.26R |
| short | 267 | 49.4% | +0.11R |

## Operational Stats
- Total setups generated: 579
- Filtered as no-trade (conviction/R:R gates, before the setup-type gate): 1527
- Fetch/compute errors: 0

## Caveats (read before acting on this)
This is walk-forward evidence, which is meaningfully stronger than a single in-sample run — but
the TEST sample (~189 trades) is still modest. Treat the setup-type gate as
**provisional and subject to revision** as more data accrues; rerun `pnpm run backtest` monthly
and update `EMPIRICAL_SETUP_ALLOWLIST` in `intraday-signals.ts` from the new TRAIN verdicts.
No backtest — however rigorous — is a substitute for paper-trading before risking real capital,
because live fills, slippage, and regime changes are not captured here.
