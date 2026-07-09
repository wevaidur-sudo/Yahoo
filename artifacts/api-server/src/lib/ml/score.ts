/**
 * Live scoring path: loads the most recently trained model for each score
 * kind and runs inference on a live feature vector. Falls back to `null`
 * (surfaced as "not yet trained") if no model has been trained yet — the
 * API never silently substitutes the old formula for these fields.
 */
import { db, mlModelsTable, symbolScoresTable, symbolScoreHistoryTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { GradientBoostedTrees, type SerializedGBM } from "./gbm";
import { FEATURE_GROUPS, vectorFor, type FeatureName, type FundamentalSnapshot, computeFeaturesAt, type Bar } from "./features";

/** How long a cached per-symbol score is considered fresh before recomputing. */
const SCORE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface QuantScoreResult {
  available: boolean;
  overall: number | null;
  momentum: number | null;
  value: number | null;
  lowRisk: number | null;
  horizonDays: number | null;
  backtestAccuracy: number | null;
  backtestWinRate: number | null;
  backtestBaseRate: number | null;
  modelTrainedAt: string | null;
  trainSampleSize: number | null;
}

type Kind = "overall" | "momentum" | "value" | "lowRisk";

async function loadActiveModel(kind: Kind) {
  const [row] = await db
    .select()
    .from(mlModelsTable)
    .where(eq(mlModelsTable.kind, kind))
    .orderBy(desc(mlModelsTable.trainedAt))
    .limit(1);
  return row ?? null;
}

/** Maps a raw [0,1] probability to a Danelfin-style 1-10 score. */
function probToScore(p: number): number {
  return Math.max(1, Math.min(10, Math.round(1 + p * 9)));
}

async function loadCachedScore(symbol: string) {
  const [row] = await db
    .select()
    .from(symbolScoresTable)
    .where(eq(symbolScoresTable.symbol, symbol))
    .limit(1);
  return row ?? null;
}

/** Persists (upserts) the freshly-computed score for fast lookups, AND
 * appends an immutable row to the score history table so past predictions
 * remain queryable/auditable even after the cache row is later overwritten. */
async function persistScore(
  symbol: string,
  scores: Record<Kind, number>,
  versions: Record<Kind, number>,
  horizonDays: number,
): Promise<void> {
  const now = new Date();
  const asOfDate = now.toISOString().slice(0, 10);

  await db
    .insert(symbolScoresTable)
    .values({
      symbol,
      overallScore: scores.overall,
      momentumScore: scores.momentum,
      valueScore: scores.value,
      lowRiskScore: scores.lowRisk,
      overallModelVersion: versions.overall,
      momentumModelVersion: versions.momentum,
      valueModelVersion: versions.value,
      lowRiskModelVersion: versions.lowRisk,
      computedAt: now,
    })
    .onConflictDoUpdate({
      target: symbolScoresTable.symbol,
      set: {
        overallScore: scores.overall,
        momentumScore: scores.momentum,
        valueScore: scores.value,
        lowRiskScore: scores.lowRisk,
        overallModelVersion: versions.overall,
        momentumModelVersion: versions.momentum,
        valueModelVersion: versions.value,
        lowRiskModelVersion: versions.lowRisk,
        computedAt: now,
      },
    });

  await db
    .insert(symbolScoreHistoryTable)
    .values({
      symbol,
      asOfDate,
      overallScore: scores.overall,
      momentumScore: scores.momentum,
      valueScore: scores.value,
      lowRiskScore: scores.lowRisk,
      overallModelVersion: versions.overall,
      momentumModelVersion: versions.momentum,
      valueModelVersion: versions.value,
      lowRiskModelVersion: versions.lowRisk,
      horizonDays,
      computedAt: now,
    })
    .onConflictDoUpdate({
      target: [symbolScoreHistoryTable.symbol, symbolScoreHistoryTable.asOfDate],
      set: {
        overallScore: scores.overall,
        momentumScore: scores.momentum,
        valueScore: scores.value,
        lowRiskScore: scores.lowRisk,
        overallModelVersion: versions.overall,
        momentumModelVersion: versions.momentum,
        valueModelVersion: versions.value,
        lowRiskModelVersion: versions.lowRisk,
        horizonDays,
        computedAt: now,
      },
    });
}

export async function computeQuantScore(
  symbol: string,
  bars: Bar[],
  fundamentals: FundamentalSnapshot,
): Promise<QuantScoreResult> {
  const empty: QuantScoreResult = {
    available: false,
    overall: null,
    momentum: null,
    value: null,
    lowRisk: null,
    horizonDays: null,
    backtestAccuracy: null,
    backtestWinRate: null,
    backtestBaseRate: null,
    modelTrainedAt: null,
    trainSampleSize: null,
  };

  const kinds: Kind[] = ["overall", "momentum", "value", "lowRisk"];
  const rows = await Promise.all(kinds.map((k) => loadActiveModel(k)));
  if (rows.some((r) => r == null)) return empty; // need all 4 trained
  const metaFromOverall = rows[kinds.indexOf("overall")]!;
  const currentVersions: Record<Kind, number> = {
    overall: rows[0]!.version,
    momentum: rows[1]!.version,
    value: rows[2]!.version,
    lowRisk: rows[3]!.version,
  };

  // Serve from the DB-backed cache when it's fresh AND every one of the 4
  // sub-model versions matches what's currently active — this is
  // version-aware per kind so a partial retrain (e.g. only "lowRisk" was
  // retrained via trainOnly) correctly invalidates the whole cached row
  // instead of silently mixing a stale sub-score with fresh ones.
  const cached = await loadCachedScore(symbol);
  const cacheFresh =
    cached != null &&
    cached.overallModelVersion === currentVersions.overall &&
    cached.momentumModelVersion === currentVersions.momentum &&
    cached.valueModelVersion === currentVersions.value &&
    cached.lowRiskModelVersion === currentVersions.lowRisk &&
    Date.now() - cached.computedAt.getTime() < SCORE_CACHE_TTL_MS;

  let scores: Record<Kind, number>;
  if (cacheFresh) {
    scores = {
      overall: cached.overallScore,
      momentum: cached.momentumScore,
      value: cached.valueScore,
      lowRisk: cached.lowRiskScore,
    };
  } else {
    const lastIdx = bars.length - 1;
    const features = computeFeaturesAt(bars, lastIdx, fundamentals);
    if (!features) return empty; // not enough history for this symbol yet

    scores = { overall: 0, momentum: 0, value: 0, lowRisk: 0 };
    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[i];
      const row = rows[i]!;
      const model = GradientBoostedTrees.fromJSON(row.model as SerializedGBM);
      const group = (row.featureNames as FeatureName[]) ?? FEATURE_GROUPS[kind];
      const vector = vectorFor(features, group);
      const prob = model.predictProbaOne(vector);
      scores[kind] = probToScore(prob);
    }

    await persistScore(symbol, scores, currentVersions, metaFromOverall.horizonDays);
  }

  return {
    available: true,
    overall: scores.overall,
    momentum: scores.momentum,
    value: scores.value,
    lowRisk: scores.lowRisk,
    horizonDays: metaFromOverall.horizonDays,
    backtestAccuracy: metaFromOverall.backtestAccuracy,
    backtestWinRate: metaFromOverall.backtestWinRate,
    backtestBaseRate: metaFromOverall.backtestBaseRate,
    modelTrainedAt: metaFromOverall.trainedAt.toISOString(),
    trainSampleSize: metaFromOverall.trainSampleSize,
  };
}
