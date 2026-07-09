/**
 * Live scoring path: loads the most recently trained model for each score
 * kind and runs inference on a live feature vector. Falls back to `null`
 * (surfaced as "not yet trained") if no model has been trained yet — the
 * API never silently substitutes the old formula for these fields.
 */
import { db, mlModelsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { GradientBoostedTrees, type SerializedGBM } from "./gbm";
import { FEATURE_GROUPS, vectorFor, type FeatureName, type FundamentalSnapshot, computeFeaturesAt, type Bar } from "./features";

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

export async function computeQuantScore(
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

  const lastIdx = bars.length - 1;
  const features = computeFeaturesAt(bars, lastIdx, fundamentals);
  if (!features) return empty; // not enough history for this symbol yet

  const kinds: Kind[] = ["overall", "momentum", "value", "lowRisk"];
  const rows = await Promise.all(kinds.map((k) => loadActiveModel(k)));
  if (rows.some((r) => r == null)) return empty; // need all 4 trained

  const scores: Record<Kind, number> = { overall: 0, momentum: 0, value: 0, lowRisk: 0 };
  let metaFromOverall: (typeof rows)[number] | null = null;

  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    const row = rows[i]!;
    if (kind === "overall") metaFromOverall = row;
    const model = GradientBoostedTrees.fromJSON(row.model as SerializedGBM);
    const group = (row.featureNames as FeatureName[]) ?? FEATURE_GROUPS[kind];
    const vector = vectorFor(features, group);
    const prob = model.predictProbaOne(vector);
    scores[kind] = probToScore(prob);
  }

  return {
    available: true,
    overall: scores.overall,
    momentum: scores.momentum,
    value: scores.value,
    lowRisk: scores.lowRisk,
    horizonDays: metaFromOverall!.horizonDays,
    backtestAccuracy: metaFromOverall!.backtestAccuracy,
    backtestWinRate: metaFromOverall!.backtestWinRate,
    backtestBaseRate: metaFromOverall!.backtestBaseRate,
    modelTrainedAt: metaFromOverall!.trainedAt.toISOString(),
    trainSampleSize: metaFromOverall!.trainSampleSize,
  };
}
