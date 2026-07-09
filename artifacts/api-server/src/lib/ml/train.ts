/**
 * Trains all 4 score models (momentum, value, lowRisk, overall) from the
 * stored historical dataset, backtests each on a chronological holdout, and
 * persists the winning artifacts + honest accuracy metrics to the DB.
 *
 * This is the "retraining job": rerun this (via `pnpm run train-ml`) on a
 * cadence (e.g. weekly) to keep the model from going stale as new price
 * history accumulates.
 */
import { db, mlModelsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { GradientBoostedTrees } from "./gbm";
import { FEATURE_GROUPS, vectorFor, type FeatureName } from "./features";
import { buildTrainingSet, type TrainingRow } from "./pipeline";
import { PREDICTION_HORIZON_DAYS, TRAINING_UNIVERSE } from "./universe";

type Kind = "overall" | "momentum" | "value" | "lowRisk";

function chronologicalSplit(rows: TrainingRow[], testFraction = 0.2) {
  const uniqueDates = Array.from(new Set(rows.map((r) => r.date))).sort();
  const cutoffIdx = Math.floor(uniqueDates.length * (1 - testFraction));
  const cutoffDate = uniqueDates[cutoffIdx];
  const train = rows.filter((r) => r.date < cutoffDate);
  const test = rows.filter((r) => r.date >= cutoffDate);
  return { train, test, cutoffDate };
}

function evaluate(model: GradientBoostedTrees, X: number[][], y: number[]) {
  const probs = model.predictProba(X);
  const preds = probs.map((p) => (p >= 0.5 ? 1 : 0));
  let correct = 0, truePositive = 0, predictedPositive = 0;
  for (let i = 0; i < y.length; i++) {
    if (preds[i] === y[i]) correct++;
    if (preds[i] === 1) {
      predictedPositive++;
      if (y[i] === 1) truePositive++;
    }
  }
  const accuracy = (correct / y.length) * 100;
  const winRate = predictedPositive > 0 ? (truePositive / predictedPositive) * 100 : 0;
  const baseRate = (y.reduce((a, b) => a + b, 0) / y.length) * 100;
  return { accuracy, winRate, baseRate };
}

export async function trainAllModels(
  log: (msg: string) => void = console.log,
  onlyKinds?: Kind[],
): Promise<void> {
  log(`[train] Fetching history + building training set for ${TRAINING_UNIVERSE.length} symbols…`);
  const rows = await buildTrainingSet(TRAINING_UNIVERSE, log);
  log(`[train] Built ${rows.length} total point-in-time training rows`);
  if (rows.length < 500) {
    throw new Error(`Not enough training data (${rows.length} rows) — did fetchAndStoreHistory run first?`);
  }

  const { train, test, cutoffDate } = chronologicalSplit(rows);
  log(`[train] Chronological split at ${cutoffDate}: ${train.length} train / ${test.length} test rows`);

  const kinds: Kind[] = onlyKinds ?? ["overall", "momentum", "value", "lowRisk"];

  for (const kind of kinds) {
    const group: FeatureName[] = FEATURE_GROUPS[kind];
    const XTrain = train.map((r) => vectorFor(r.features, group));
    const yTrain = train.map((r) => r.label);
    const XTest = test.map((r) => vectorFor(r.features, group));
    const yTest = test.map((r) => r.label);

    log(`[train] Training "${kind}" model on ${group.length} features…`);
    const model = new GradientBoostedTrees();
    await model.fit(XTrain, yTrain);

    const { accuracy, winRate, baseRate } = evaluate(model, XTest, yTest);
    log(`[train] "${kind}" holdout accuracy=${accuracy.toFixed(1)}% winRate=${winRate.toFixed(1)}% baseRate=${baseRate.toFixed(1)}%`);

    const [prevLatest] = await db
      .select({ version: mlModelsTable.version })
      .from(mlModelsTable)
      .where(eq(mlModelsTable.kind, kind))
      .orderBy(desc(mlModelsTable.version))
      .limit(1);
    const nextVersion = (prevLatest?.version ?? 0) + 1;

    await db.update(mlModelsTable).set({ isActive: false }).where(eq(mlModelsTable.kind, kind));
    await db.insert(mlModelsTable).values({
      kind,
      version: nextVersion,
      horizonDays: PREDICTION_HORIZON_DAYS,
      featureNames: group,
      model: model.toJSON(),
      trainSampleSize: train.length,
      testSampleSize: test.length,
      backtestAccuracy: accuracy,
      backtestWinRate: winRate,
      backtestBaseRate: baseRate,
      isActive: true,
    });
    log(`[train] Persisted "${kind}" model v${nextVersion}`);
  }

  log("[train] Done — all 4 models trained and stored.");
}
