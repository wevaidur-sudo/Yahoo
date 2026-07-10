# Intraday Signal Engine — Backtest Report

Generated: 2026-07-10T05:25:31.289Z

## Methodology
- Symbols (1): AAPL
- Data: EODHD 5m bars (~1 year) + daily bars (~500 days) for PDH/PDL/ATR/avg-volume. Yahoo as fallback. Results cached in ohlcv_bars DB table.
- Decision windows tested per trading day (ET): 10:15, 11:00, 13:45
- Uses the exact production code path: `computeIntradayLevels` → `computeIntradaySignals` → `generateTradeSetup`
- **Walk-forward split**: first 65% of each symbol's trading days = TRAIN (used only to derive the setup-type quality gate below), last 35% = TEST (held out, scored with the gate frozen from TRAIN — this is genuine out-of-sample evidence, not a re-fit)
- Trade outcome: simulated bar-by-bar until stop or target1 hit, or scored mark-to-close if neither hit by session end
- **No commissions, spread, or slippage modeled.** Pre-market signals are inactive in this backtest (Yahoo 5m history excludes pre/post bars) — they are live in production, which uses 1m bars with pre/post included.

## Setup-Type Quality Gate (derived from TRAIN only, N ≥ 12)
| Setup Type | N (train) | Win Rate | Avg R | Verdict |
|---|---|---|---|---|
| ORB Breakdown | 7 | 57.1% | +0.07R | ⛔ insufficient data |
| ORB Breakout | 8 | 50.0% | -0.04R | ⛔ insufficient data |
| Previous Day High Breakout | 11 | 63.6% | +0.05R | ⛔ insufficient data |
| Previous Day Low Breakdown | 10 | 80.0% | +0.61R | ⛔ insufficient data |

**Allowed setup types (shipped to production):** none met the bar

## TRAIN Results (in-sample — for reference only, not evidence)
- N=36, win rate 63.9%, avg +0.19R

## TEST Results (held-out — this is the real evidence)
| | N | Win Rate | Avg R |
|---|---|---|---|
| Unfiltered (all setup types) | 28 | 60.7% | +0.12R |
| **With quality gate applied** | 0 | **0.0%** | **+0.00R** |

Filtering out setup types that showed negative or unreliable edge on TRAIN, and re-scoring only
on TEST (data the gate never saw), moved win rate from 60.7% to
0.0% and average R from 0.12R to 0.00R.
The gate did NOT clearly improve out-of-sample expectancy — treat the allowlist as provisional, not proven.

## Full Breakdown (all trades, both phases combined)
### By Setup Type
| Setup Type | N | Win Rate | Avg R |
|---|---|---|---|
| ORB Breakdown | 10 | 60.0% | +0.11R |
| ORB Breakout | 13 | 53.8% | -0.01R |
| Previous Day High Breakout | 27 | 55.6% | +0.02R |
| Previous Day Low Breakdown | 14 | 85.7% | +0.62R |

### By Conviction Bucket
| Conviction | N | Win Rate | Avg R |
|---|---|---|---|
| 25-40 | 1 | 0.0% | -0.46R |
| 40-60 | 32 | 62.5% | +0.18R |
| 60-80 | 30 | 63.3% | +0.16R |
| 80-100 | 1 | 100.0% | +0.06R |

### By Bias
| Bias | N | Win Rate | Avg R |
|---|---|---|---|
| long | 40 | 55.0% | +0.01R |
| short | 24 | 75.0% | +0.41R |

## Operational Stats
- Total setups generated: 64
- Filtered as no-trade (conviction/R:R gates, before the setup-type gate): 683
- Fetch/compute errors: 6

## Caveats (read before acting on this)
This is walk-forward evidence, which is meaningfully stronger than a single in-sample run — but
the TEST sample (~28 trades) is still modest. Treat the setup-type gate as
**provisional and subject to revision** as more data accrues; rerun `pnpm run backtest` monthly
and update `EMPIRICAL_SETUP_ALLOWLIST` in `intraday-signals.ts` from the new TRAIN verdicts.
No backtest — however rigorous — is a substitute for paper-trading before risking real capital,
because live fills, slippage, and regime changes are not captured here.
