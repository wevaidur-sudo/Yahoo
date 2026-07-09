# Intraday Signal Engine — Backtest Report

Generated: 2026-07-09T17:19:12.108Z

## Methodology
- Symbols: AAPL, MSFT, NVDA, AMZN, TSLA, META, GOOGL, SPY
- Data: Yahoo Finance 5m bars (~58 days, no pre/post market) + 1d bars (~150 days) for PDH/PDL/ATR/avg-volume
- Decision windows tested per trading day (ET): 10:15, 11:00, 13:45
- Uses the exact production code path: `computeIntradayLevels` → `computeIntradaySignals` → `generateTradeSetup`
- Trade outcome: simulated bar-by-bar until stop or target1 hit, or scored mark-to-close if neither hit by session end
- **No commissions, spread, or slippage modeled.** Pre-market signals are inactive in this backtest (Yahoo 5m history excludes pre/post bars) — they are live in production, which uses 1m bars with pre/post included.

## Overall Results
- Total setups generated: 639
- Filtered as no-trade (incl. new R:R quality filter): 305
- Fetch/compute errors: 0
- Win rate: **30.8%**
- Average R-multiple per trade: **-0.03R**
- Average winner: +2.12R — Average loser: -0.99R
- Expectancy: negative (the system is currently losing on average across this sample)

## By Setup Type
| Setup Type | N | Win Rate | Avg R |
|---|---|---|---|
| ORB Breakdown | 197 | 32.5% | -0.06R |
| ORB Breakout | 294 | 27.6% | -0.17R |
| Pre-Market High Breakout | 1 | 0.0% | -1.00R |
| Pre-Market Low Breakdown | 9 | 44.4% | +0.43R |
| Previous Day High Breakout | 8 | 37.5% | -0.11R |
| Previous Day Low Breakdown | 24 | 20.8% | -0.13R |
| VWAP Reclaim | 22 | 18.2% | -0.27R |
| VWAP Rejection | 48 | 37.5% | +0.20R |
| VWAP Trend Long | 9 | 55.6% | +2.68R |
| VWAP Trend Short | 27 | 48.1% | +0.66R |

## By Conviction Bucket
| Conviction | N | Win Rate | Avg R |
|---|---|---|---|
| 25-40 | 53 | 34.0% | +0.05R |
| 40-60 | 85 | 32.9% | +0.32R |
| 60-80 | 47 | 25.5% | -0.17R |
| 80-100 | 454 | 30.6% | -0.09R |

## By Bias
| Bias | N | Win Rate | Avg R |
|---|---|---|---|
| long | 334 | 27.8% | -0.10R |
| short | 305 | 34.1% | +0.06R |

## Caveats (read before acting on this)
This is a **starting point**, not statistical proof. With ~8 symbols × ~45 usable days × 3 windows,
the sample is too small to confirm or reject the signal weights with confidence — treat it as
"does this look directionally sane" rather than "this is validated." To get real evidence:
increase symbol count and history length, add walk-forward validation (don't reuse the same
period to tune and test), and eventually paper-trade before risking capital.
