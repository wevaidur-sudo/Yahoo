# Intraday Signal Engine — Backtest Report

Generated: 2026-07-09T20:45:50.941Z

## Methodology
- Symbols (18): AAPL, MSFT, NVDA, AMZN, TSLA, META, GOOGL, SPY, QQQ, AMD, NFLX, JPM, XOM, UNH, COST, AVGO, CRM, ORCL
- Data: EODHD 5m bars (~1 year) + daily bars (~500 days) for PDH/PDL/ATR/avg-volume. Yahoo as fallback. Results cached in ohlcv_bars DB table.
- Decision windows tested per trading day (ET): 10:15, 11:00, 13:45
- Uses the exact production code path: `computeIntradayLevels` → `computeIntradaySignals` → `generateTradeSetup`
- **Walk-forward split**: first 65% of each symbol's trading days = TRAIN (used only to derive the setup-type quality gate below), last 35% = TEST (held out, scored with the gate frozen from TRAIN — this is genuine out-of-sample evidence, not a re-fit)
- Trade outcome: simulated bar-by-bar until stop or target1 hit, or scored mark-to-close if neither hit by session end
- **No commissions, spread, or slippage modeled.** Pre-market signals are inactive in this backtest (Yahoo 5m history excludes pre/post bars) — they are live in production, which uses 1m bars with pre/post included.

## Setup-Type Quality Gate (derived from TRAIN only, N ≥ 12)
| Setup Type | N (train) | Win Rate | Avg R | Verdict |
|---|---|---|---|---|
| ORB Breakdown | 51 | 47.1% | -0.04R | ⛔ negative edge |
| ORB Breakout | 53 | 47.2% | -0.10R | ⛔ negative edge |
| Pre-Market High Breakout | 27 | 44.4% | +0.03R | ✅ ALLOWED |
| Pre-Market Low Breakdown | 10 | 70.0% | +0.16R | ⛔ insufficient data |
| Previous Day High Breakout | 108 | 45.4% | -0.15R | ⛔ negative edge |
| Previous Day Low Breakdown | 103 | 69.9% | +0.32R | ✅ ALLOWED |

**Allowed setup types (shipped to production):** Pre-Market High Breakout, Previous Day Low Breakdown

## TRAIN Results (in-sample — for reference only, not evidence)
- N=352, win rate 53.7%, avg +0.03R

## TEST Results (held-out — this is the real evidence)
| | N | Win Rate | Avg R |
|---|---|---|---|
| Unfiltered (all setup types) | 200 | 54.0% | +0.09R |
| **With quality gate applied** | 67 | **56.7%** | **+0.11R** |

Filtering out setup types that showed negative or unreliable edge on TRAIN, and re-scoring only
on TEST (data the gate never saw), moved win rate from 54.0% to
56.7% and average R from 0.09R to 0.11R.
The gate improved out-of-sample expectancy.

## Full Breakdown (all trades, both phases combined)
### By Setup Type
| Setup Type | N | Win Rate | Avg R |
|---|---|---|---|
| ORB Breakdown | 79 | 43.0% | -0.10R |
| ORB Breakout | 80 | 53.8% | +0.03R |
| Pre-Market High Breakout | 36 | 47.2% | +0.13R |
| Pre-Market Low Breakdown | 17 | 58.8% | +0.45R |
| Previous Day High Breakout | 178 | 49.4% | -0.08R |
| Previous Day Low Breakdown | 161 | 65.2% | +0.23R |
| VWAP Rejection | 1 | 0.0% | -1.00R |

### By Conviction Bucket
| Conviction | N | Win Rate | Avg R |
|---|---|---|---|
| 25-40 | 15 | 53.3% | +0.19R |
| 40-60 | 194 | 57.2% | +0.08R |
| 60-80 | 252 | 52.4% | +0.07R |
| 80-100 | 91 | 50.5% | -0.06R |

### By Bias
| Bias | N | Win Rate | Avg R |
|---|---|---|---|
| long | 294 | 50.3% | -0.02R |
| short | 258 | 57.8% | +0.14R |

## Operational Stats
- Total setups generated: 552
- Filtered as no-trade (conviction/R:R gates, before the setup-type gate): 4074
- Fetch/compute errors: 12

## Caveats (read before acting on this)
This is walk-forward evidence, which is meaningfully stronger than a single in-sample run — but
the TEST sample (~200 trades) is still modest. Treat the setup-type gate as
**provisional and subject to revision** as more data accrues; rerun `pnpm run backtest` monthly
and update `EMPIRICAL_SETUP_ALLOWLIST` in `intraday-signals.ts` from the new TRAIN verdicts.
No backtest — however rigorous — is a substitute for paper-trading before risking real capital,
because live fills, slippage, and regime changes are not captured here.
