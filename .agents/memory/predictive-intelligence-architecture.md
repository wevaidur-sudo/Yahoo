---
name: Predictive Intelligence Architecture
description: How the 5-module leading-indicator system was built and wired into the analysis pipeline.
---

# Predictive Intelligence Architecture

## Rule
Five leading-indicator modules sit ABOVE the existing intraday signal engine. They fire before price confirms a move. Apply them via `applyPredictiveSignals()` in `intraday-signals.ts`, which merges them into the base `IntradaySignalScore` using a new fixed denominator = 105 (intraday) + sum of module maxWeights.

**Why:** The original engine was a lagging confluence detector — every signal required price to have already moved. These modules fire on pre-move data: PM activity, options positioning, news before open, macro regime, and ML pattern recognition.

## How to apply
1. Compute base intraday signals with `computeIntradaySignals()`
2. Run all 5 predictive modules in parallel via `Promise.allSettled`
3. Assemble `PredictiveSignalInput[]` from results
4. Call `applyPredictiveSignals(base, inputs)` → `enhancedSignalScore`
5. Call `generateTradeSetup()` again with `enhancedSignalScore` → `enhancedTradeSetup`
6. Use enhanced versions in response + Gemini prompt
7. Record prediction via `recordPrediction(mlFeatures)` (fire-and-forget)

## Module weights (max contribution)
| Module | Max | File |
|---|---|---|
| Pre-Market Momentum | ±30 | `lib/pre-market-intelligence.ts` |
| Options Flow | ±15 | `lib/options-flow.ts` |
| News Catalyst (Gemini) | ±15 | `lib/news-sentiment.ts` |
| Market Regime (SPY+VIX) | ±10 | `lib/market-regime.ts` |
| ML Model Edge | ±15 | `lib/ml-predictor.ts` |

## Key constraints
- Structural no-trade overrides (RVOL, thin volume, ATR) are preserved even when predictive signals are bullish — they're immovable barriers.
- Conviction-only no-trade (score < 35%) CAN be lifted by strong predictive signals.
- ML cold-starts neutral until 30 outcomes are recorded in DB.
- News sentiment uses model `gemini-3.1-flash-lite` (same as main analysis) — `gemini-2.0-flash-lite` does not work in this environment.
- Market regime requires `yahooFinance` instance (any-typed) to fetch SPY 30-day bars + VIX quote.

## DB tables (schema/predictions.ts)
- `prediction_signals` — input features per analysis call
- `prediction_outcomes` — actual outcome after market close (direction correct? R-multiple?)
Both exported from `lib/db/src/schema/index.ts`. Push with `pnpm --filter @workspace/db run push`.

## Response shape
```json
{
  "signalScore": { "direction", "conviction", "signals": [...intraday + predictive...] },
  "tradeSetup": { ... },
  "predictiveIntelligence": {
    "preMarketMomentum": { "direction", "score", "velocityPctPerHour", "blockTradeDetected", ... },
    "optionsFlow": { "direction", "score", "unusualCallStrikes", "ivSkewPct", "fullChainPCR", ... },
    "newsCatalyst": { "direction", "score", "rawScore", "isEarningsDriven", "catalystSummary", ... },
    "marketRegime": { "direction", "score", "spyAbove20SMA", "vixLevel", "vixRegime", ... },
    "mlPrediction": { "direction", "probability", "score", "hasSufficientData", "trainingSampleCount", ... }
  }
}
```

## Frontend
`PredictiveIntelligenceCard.tsx` renders all 5 modules as collapsible rows with bidirectional score bars, placed in `AIAnalysisTab.tsx` between `TradeSetupCard` and the intraday signal score section.
