# Intraday Signal Engine — Backtest Report

Generated: 2026-07-09T19:29:01.495Z

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
| ORB Breakdown | 18 | 38.9% | -0.15R | ⛔ negative edge |
| ORB Breakout | 16 | 25.0% | -0.46R | ⛔ negative edge |
| Pre-Market High Breakout | 39 | 41.0% | -0.06R | ⛔ negative edge |
| Pre-Market Low Breakdown | 19 | 52.6% | -0.00R | ⛔ negative edge |
| Previous Day High Breakout | 69 | 36.2% | -0.27R | ⛔ negative edge |
| Previous Day Low Breakdown | 61 | 68.9% | +0.43R | ✅ ALLOWED |

**Allowed setup types (shipped to production):** Previous Day Low Breakdown

## TRAIN Results (in-sample — for reference only, not evidence)
- N=222, win rate 46.8%, avg -0.02R

## TEST Results (held-out — this is the real evidence)
| | N | Win Rate | Avg R |
|---|---|---|---|
| Unfiltered (all setup types) | 111 | 36.9% | -0.07R |
| **With quality gate applied** | 33 | **30.3%** | **-0.23R** |

Filtering out setup types that showed negative or unreliable edge on TRAIN, and re-scoring only
on TEST (data the gate never saw), moved win rate from 36.9% to
30.3% and average R from -0.07R to -0.23R.
The gate did NOT clearly improve out-of-sample expectancy — treat the allowlist as provisional, not proven.

## Full Breakdown (all trades, both phases combined)
### By Setup Type
| Setup Type | N | Win Rate | Avg R |
|---|---|---|---|
| ORB Breakdown | 30 | 33.3% | -0.18R |
| ORB Breakout | 23 | 30.4% | -0.27R |
| Pre-Market High Breakout | 50 | 44.0% | +0.01R |
| Pre-Market Low Breakdown | 32 | 50.0% | +0.19R |
| Previous Day High Breakout | 103 | 35.9% | -0.26R |
| Previous Day Low Breakdown | 94 | 55.3% | +0.20R |
| VWAP Trend Long | 1 | 100.0% | +0.08R |

### By Conviction Bucket
| Conviction | N | Win Rate | Avg R |
|---|---|---|---|
| 25-40 | 10 | 60.0% | +0.52R |
| 40-60 | 66 | 42.4% | -0.10R |
| 60-80 | 134 | 42.5% | +0.01R |
| 80-100 | 123 | 43.9% | -0.10R |

### By Bias
| Bias | N | Win Rate | Avg R |
|---|---|---|---|
| long | 177 | 37.9% | -0.18R |
| short | 156 | 50.0% | +0.12R |

## Operational Stats
- Total setups generated: 333
- Filtered as no-trade (conviction/R:R gates, before the setup-type gate): 1773
- Fetch/compute errors: 0

## Caveats (read before acting on this)
This is walk-forward evidence, which is meaningfully stronger than a single in-sample run — but
the TEST sample (~111 trades) is still modest. Treat the setup-type gate as
**provisional and subject to revision** as more data accrues; rerun `pnpm run backtest` monthly
and update `EMPIRICAL_SETUP_ALLOWLIST` in `intraday-signals.ts` from the new TRAIN verdicts.
No backtest — however rigorous — is a substitute for paper-trading before risking real capital,
because live fills, slippage, and regime changes are not captured here.
