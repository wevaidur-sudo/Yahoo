---
name: AI Analysis Architecture
description: How the AI analysis tab splits formula-based technical scoring from LLM qualitative commentary in FinanceScope.
---

## Rule
The AI analysis pipeline has two strictly separated layers:
1. **Technical Signal Score** — computed deterministically in `artifacts/api-server/src/routes/analysis.ts` from standard financial formulas. Never touches LLM. Returns direction + score (−100/+100) + per-signal breakdown.
2. **AI Qualitative Commentary** — Gemini provides narrative, news context, macro overlay, price targets. Gemini is explicitly told NOT to echo the indicator readings — it adds qualitative judgment the formulas cannot.

## Indicator math standards
- **RSI**: Wilder's Smoothed Moving Average (seed first `period` changes with SMA, then `avgGain = (prev*(period-1) + current) / period`). NOT simple average of last N bars.
- **EMA**: SMA-seeded at position `period` (first `period` values averaged), NaN-padded warm-up window. NOT seeded with `values[0]`.
- **MACD(12,26,9)**: NaN-safe — filter warm-up NaNs from MACD line before computing 9-period signal EMA. Minimum-history gate is 34 closes (not 35).

## Signal score normalization
**Critical**: Neutral signals must carry their category's full weight in the denominator (contributing 0 to numerator). Do NOT use `weight: 0` for neutral — that causes score saturation from sparse data. Example: RSI neutral → `weight: 15` in denominator, 0 in numerator. This keeps the score proportional to true confluence strength.

Scoring categories and max weights: RSI=15, MACD Histogram=20, MACD vs Signal=15, Price vs SMA20=10, Price vs SMA50=10, Price vs SMA200=15, SMA Alignment=10, Bollinger Position=10, Volume=10. Total possible=115.

Direction thresholds: score ≥ +20 → bullish, score ≤ −20 → bearish, else neutral.

**Why:** A single bullish RSI with everything neutral should score ~13/115 ≈ 13 → neutral direction, NOT ±100 (which would happen if neutral weight=0 collapsed the denominator to 15).

## API schema
`SignalScore` and `TechnicalSignal` are in `lib/api-spec/openapi.yaml`. `StockAnalysis.signalScore` is required. Run codegen after any spec change.

## Frontend framing
- Prominent amber disclaimer at the very top of the AI tab (always visible, not dismissible).
- Signal Score section: "Formula-Based" badge, bidirectional −100/+100 bar, signal breakdown grid.
- AI section: "AI-Generated" badge, direction labeled "AI Assessment (not a signal)", confidence bar labeled "AI Conviction — LLM self-assessment, not a probability".
