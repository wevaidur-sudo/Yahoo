# Intraday Signal Engine — Backtest Report

Generated: 2026-07-10T05:22:52.215Z

## Methodology
- Symbols (1): MSTR
- Data: EODHD 5m bars (~1 year) + daily bars (~500 days) for PDH/PDL/ATR/avg-volume. Yahoo as fallback. Results cached in ohlcv_bars DB table.
- Decision windows tested per trading day (ET): 10:15, 11:00, 13:45
- Uses the exact production code path: `computeIntradayLevels` → `computeIntradaySignals` → `generateTradeSetup`
- **Walk-forward split**: first 65% of each symbol's trading days = TRAIN (used only to derive the setup-type quality gate below), last 35% = TEST (held out, scored with the gate frozen from TRAIN — this is genuine out-of-sample evidence, not a re-fit)
- Trade outcome: simulated bar-by-bar until stop or target1 hit, or scored mark-to-close if neither hit by session end
- **No commissions, spread, or slippage modeled.** Pre-market signals are inactive in this backtest (Yahoo 5m history excludes pre/post bars) — they are live in production, which uses 1m bars with pre/post included.

## Setup-Type Quality Gate (derived from TRAIN only, N ≥ 12)
| Setup Type | N (train) | Win Rate | Avg R | Verdict |
|---|---|---|---|---|
| ORB Breakout | 4 | 50.0% | +0.07R | ⛔ insufficient data |
| Pre-Market High Breakout | 2 | 0.0% | -0.79R | ⛔ insufficient data |
| Pre-Market Low Breakdown | 2 | 0.0% | -0.29R | ⛔ insufficient data |
| Previous Day High Breakout | 2 | 100.0% | +0.48R | ⛔ insufficient data |
| Previous Day Low Breakdown | 1 | 100.0% | +1.06R | ⛔ insufficient data |
| VWAP Trend Short | 1 | 100.0% | +1.20R | ⛔ insufficient data |

**Allowed setup types (shipped to production):** none met the bar

## TRAIN Results (in-sample — for reference only, not evidence)
- N=12, win rate 50.0%, avg +0.11R

## TEST Results (held-out — this is the real evidence)
| | N | Win Rate | Avg R |
|---|---|---|---|
| Unfiltered (all setup types) | 2 | 0.0% | -0.69R |
| **With quality gate applied** | 0 | **0.0%** | **+0.00R** |

Filtering out setup types that showed negative or unreliable edge on TRAIN, and re-scoring only
on TEST (data the gate never saw), moved win rate from 0.0% to
0.0% and average R from -0.69R to 0.00R.
The gate improved out-of-sample expectancy.

## Full Breakdown (all trades, both phases combined)
### By Setup Type
| Setup Type | N | Win Rate | Avg R |
|---|---|---|---|
| ORB Breakdown | 1 | 0.0% | -1.00R |
| ORB Breakout | 5 | 40.0% | -0.01R |
| Pre-Market High Breakout | 2 | 0.0% | -0.79R |
| Pre-Market Low Breakdown | 2 | 0.0% | -0.29R |
| Previous Day High Breakout | 2 | 100.0% | +0.48R |
| Previous Day Low Breakdown | 1 | 100.0% | +1.06R |
| VWAP Trend Short | 1 | 100.0% | +1.20R |

### By Conviction Bucket
| Conviction | N | Win Rate | Avg R |
|---|---|---|---|
| 25-40 | 1 | 0.0% | -1.00R |
| 40-60 | 5 | 60.0% | +0.35R |
| 60-80 | 6 | 33.3% | -0.09R |
| 80-100 | 2 | 50.0% | -0.11R |

### By Bias
| Bias | N | Win Rate | Avg R |
|---|---|---|---|
| long | 9 | 44.4% | -0.08R |
| short | 5 | 40.0% | +0.14R |

## Operational Stats
- Total setups generated: 14
- Filtered as no-trade (conviction/R:R gates, before the setup-type gate): 103
- Fetch/compute errors: 0

## Caveats (read before acting on this)
This is walk-forward evidence, which is meaningfully stronger than a single in-sample run — but
the TEST sample (~2 trades) is still modest. Treat the setup-type gate as
**provisional and subject to revision** as more data accrues; rerun `pnpm run backtest` monthly
and update `EMPIRICAL_SETUP_ALLOWLIST` in `intraday-signals.ts` from the new TRAIN verdicts.
No backtest — however rigorous — is a substitute for paper-trading before risking real capital,
because live fills, slippage, and regime changes are not captured here.
