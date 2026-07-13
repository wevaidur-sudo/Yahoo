/**
 * ML Prediction Engine — logistic regression trained on historical outcomes.
 *
 * This module learns from every prediction the engine makes. Each time the
 * analysis endpoint fires, it records the input features (signal scores,
 * conviction, regime, etc.). After market close, outcomes can be recorded
 * (was the directional call correct? what R-multiple was achieved?).
 *
 * Over time, the model learns which FEATURE COMBINATIONS actually produce
 * correct predictions — going beyond hard-coded weights to empirically
 * discovered patterns.
 *
 * Cold start: returns neutral (0pts) until ≥ 30 outcomes are recorded.
 * Full training: logistic regression (gradient descent, 200 iterations).
 *
 * MAX contribution: ±15 pts
 */

import { db } from "@workspace/db";
import { predictionSignalsTable, predictionOutcomesTable } from "@workspace/db";
import { eq, isNotNull, desc } from "drizzle-orm";

export interface MLFeatures {
  symbol: string;
  sessionDate: string; // "YYYY-MM-DD"
  intradayConviction: number; // 0-100
  intradayDirection: 1 | -1 | 0; // 1=bullish, -1=bearish, 0=no-trade
  gapPct: number;
  rvol: number;
  preMarketScore: number; // -20 to +20
  optionsFlowScore: number; // -15 to +15
  newsSentimentScore: number; // -15 to +15
  regimeScore: number; // -10 to +10
  hourOfDay: number; // 9.5 = 9:30 AM ET
  setupType: string;
}

export interface MLPredictionResult {
  direction: "bullish" | "bearish" | "neutral";
  /** Probability that the directional call is correct (0.5 = no edge) */
  probability: number;
  /** Score: (probability - 0.5) * 30 → range -15 to +15 */
  score: number;
  /** True if we have enough data to trust the model */
  hasSufficientData: boolean;
  /** Number of training samples used */
  trainingSampleCount: number;
  note: string;
}

// ── Logistic regression helpers ───────────────────────────────────────────────

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));
}

function featureVector(f: MLFeatures): number[] {
  // Normalize features to roughly -1 to +1 scale for stable gradient descent
  return [
    1,                                    // bias term
    f.intradayConviction / 100,           // 0–1
    f.intradayDirection,                  // -1, 0, +1
    f.gapPct / 5,                         // typical gap ±5%
    Math.min(3, Math.max(0, f.rvol)) / 3, // cap at 3x
    f.preMarketScore / 20,                // -1 to +1
    f.optionsFlowScore / 15,              // -1 to +1
    f.newsSentimentScore / 15,            // -1 to +1
    f.regimeScore / 10,                   // -1 to +1
    (f.hourOfDay - 12) / 6,              // normalize around noon
    // Interaction terms — learn non-linear combinations
    (f.intradayConviction / 100) * f.intradayDirection,
    (f.preMarketScore / 20) * f.intradayDirection,
    (f.regimeScore / 10) * f.intradayDirection,
  ];
}

interface TrainingSample {
  features: number[];
  label: number; // 1 = correct prediction, 0 = wrong
}

function trainLogisticRegression(
  samples: TrainingSample[],
  iterations = 300,
  lr = 0.1,
  l2 = 0.01,
): number[] {
  if (samples.length === 0) return [];
  const dim = samples[0].features.length;
  const weights = new Array(dim).fill(0);

  for (let iter = 0; iter < iterations; iter++) {
    const grad = new Array(dim).fill(0);
    for (const { features, label } of samples) {
      const dot = weights.reduce((s, w, i) => s + w * features[i], 0);
      const pred = sigmoid(dot);
      const err  = pred - label;
      for (let i = 0; i < dim; i++) {
        grad[i] += err * features[i];
      }
    }
    for (let i = 0; i < dim; i++) {
      // L2 regularization to prevent overfitting on small datasets
      weights[i] -= lr * (grad[i] / samples.length + l2 * weights[i]);
    }
  }
  return weights;
}

// ── In-memory model cache (retrained when new outcomes arrive) ────────────────
let cachedWeights: number[] | null = null;
let cacheTimestamp = 0;
let cachedSampleCount = 0;

const CACHE_TTL_MS = 60 * 60 * 1000; // retrain at most once per hour
const MIN_SAMPLES  = 30;              // minimum outcomes needed before trusting model

async function getTrainedWeights(): Promise<{ weights: number[] | null; sampleCount: number }> {
  const now = Date.now();
  if (cachedWeights && now - cacheTimestamp < CACHE_TTL_MS) {
    return { weights: cachedWeights, sampleCount: cachedSampleCount };
  }

  try {
    // Load joined predictions + outcomes from DB
    const rows = await db
      .select({
        intradayConviction: predictionSignalsTable.intradayConviction,
        intradayDirection:  predictionSignalsTable.intradayDirection,
        gapPct:             predictionSignalsTable.gapPct,
        rvol:               predictionSignalsTable.rvol,
        preMarketScore:     predictionSignalsTable.preMarketScore,
        optionsFlowScore:   predictionSignalsTable.optionsFlowScore,
        newsSentimentScore: predictionSignalsTable.newsSentimentScore,
        regimeScore:        predictionSignalsTable.regimeScore,
        hourOfDay:          predictionSignalsTable.hourOfDay,
        directionCorrect:   predictionOutcomesTable.directionCorrect,
      })
      .from(predictionSignalsTable)
      .innerJoin(
        predictionOutcomesTable,
        eq(predictionSignalsTable.id, predictionOutcomesTable.predictionId),
      )
      .where(isNotNull(predictionOutcomesTable.directionCorrect))
      .orderBy(desc(predictionSignalsTable.recordedAt))
      .limit(500); // use last 500 outcomes for recency bias

    if (rows.length < MIN_SAMPLES) {
      cachedSampleCount = rows.length;
      cachedWeights = null;
      cacheTimestamp = now;
      return { weights: null, sampleCount: rows.length };
    }

    const samples: TrainingSample[] = rows.map((r) => ({
      features: featureVector({
        symbol: "", sessionDate: "", setupType: "",
        intradayConviction: r.intradayConviction ?? 0,
        intradayDirection:  (r.intradayDirection ?? 0) as (1 | -1 | 0),
        gapPct:             r.gapPct ?? 0,
        rvol:               r.rvol ?? 1,
        preMarketScore:     r.preMarketScore ?? 0,
        optionsFlowScore:   r.optionsFlowScore ?? 0,
        newsSentimentScore: r.newsSentimentScore ?? 0,
        regimeScore:        r.regimeScore ?? 0,
        hourOfDay:          r.hourOfDay ?? 10,
      }),
      label: r.directionCorrect ? 1 : 0,
    }));

    const weights = trainLogisticRegression(samples);
    cachedWeights = weights;
    cachedSampleCount = rows.length;
    cacheTimestamp = now;
    return { weights, sampleCount: rows.length };
  } catch {
    return { weights: null, sampleCount: 0 };
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Record a prediction's input features for future ML training.
 * Call this when computing a new analysis — returns the inserted row ID.
 */
export async function recordPrediction(features: MLFeatures): Promise<number | null> {
  try {
    const [row] = await db.insert(predictionSignalsTable).values({
      symbol:             features.symbol,
      sessionDate:        features.sessionDate,
      intradayConviction: features.intradayConviction,
      intradayDirection:  features.intradayDirection,
      gapPct:             features.gapPct,
      rvol:               features.rvol,
      preMarketScore:     features.preMarketScore,
      optionsFlowScore:   features.optionsFlowScore,
      newsSentimentScore: features.newsSentimentScore,
      regimeScore:        features.regimeScore,
      hourOfDay:          features.hourOfDay,
      setupType:          features.setupType,
    }).returning({ id: predictionSignalsTable.id });
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Record the actual outcome for a previous prediction (call at market close).
 * This is what trains the ML model over time.
 */
export async function recordOutcome(params: {
  predictionId: number;
  directionCorrect: boolean;
  maxRMultiple: number | null; // max favorable excursion / risk
  finalRMultiple: number | null; // final P&L in R units
}): Promise<void> {
  try {
    await db.insert(predictionOutcomesTable).values({
      predictionId:     params.predictionId,
      directionCorrect: params.directionCorrect,
      maxRMultiple:     params.maxRMultiple,
      finalRMultiple:   params.finalRMultiple,
    });
    // Invalidate model cache so next prediction retrains
    cacheTimestamp = 0;
  } catch { /* non-critical */ }
}

/**
 * Compute ML prediction score for a set of features.
 */
export async function mlPredict(features: MLFeatures): Promise<MLPredictionResult> {
  const { weights, sampleCount } = await getTrainedWeights();

  if (!weights || sampleCount < MIN_SAMPLES) {
    return {
      direction: "neutral", probability: 0.5, score: 0,
      hasSufficientData: false,
      trainingSampleCount: sampleCount,
      note: `ML model cold-start: ${sampleCount}/${MIN_SAMPLES} outcomes needed — check back after ${MIN_SAMPLES - sampleCount} more predictions are recorded and their results logged`,
    };
  }

  const fv   = featureVector(features);
  const dot  = weights.reduce((s, w, i) => s + w * (fv[i] ?? 0), 0);
  const prob = sigmoid(dot);

  // Convert probability to score: 0.5 = no edge (0pts), 1.0 = max bullish (+15), 0.0 = max bearish (-15)
  const score  = Math.max(-15, Math.min(15, Math.round((prob - 0.5) * 30)));
  const direction: MLPredictionResult["direction"] =
    score > 3 ? "bullish" : score < -3 ? "bearish" : "neutral";

  // Confidence label
  const confLabel =
    Math.abs(score) >= 12 ? "high" :
    Math.abs(score) >= 6  ? "moderate" :
    "low";

  const note = sampleCount >= MIN_SAMPLES
    ? `ML model (${sampleCount} samples, ${confLabel} confidence): ${(prob * 100).toFixed(0)}% probability that the directional call is correct — ${direction === "neutral" ? "no significant edge vs base rate" : `${direction} edge detected`}`
    : `ML model learning: ${sampleCount} outcomes recorded`;

  return {
    direction, probability: +prob.toFixed(3), score,
    hasSufficientData: true,
    trainingSampleCount: sampleCount,
    note,
  };
}
