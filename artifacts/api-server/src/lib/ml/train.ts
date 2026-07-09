/**
 * Trains all 4 score models (momentum, value, lowRisk, overall) from the
 * stored historical dataset, validates each with WALK-FORWARD cross-
 * validation (5 rolling folds), then trains a final model on ALL data and
 * persists the winning artifacts + honest accuracy metrics to the DB.
 *
 * Walk-forward validation:
 *   - Minimum 60% of the date range is always used as the initial training
 *     window (to avoid tiny, unrepresentative early folds).
 *   - The remaining 40% is split into N equal test windows.
 *   - For each fold k: train on dates[0..cutoff_k], test on the next window.
 *   - Reported accuracy is the mean across all folds — a far more honest
 *     estimate than a single holdout because it averages performance across
 *     multiple market regimes.
 *   - The production model is trained on ALL rows (no held-out data), so it
 *     benefits from the full dataset when scoring live stocks.
 */
import { db, mlModelsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { GradientBoostedTrees } from "./gbm";
import { FEATURE_GROUPS, vectorFor, type FeatureName } from "./features";
import { buildTrainingSet, type TrainingRow } from "./pipeline";
import { PREDICTION_HORIZON_DAYS, TRAINING_UNIVERSE, WALK_FORWARD_FOLDS } from "./universe";

// Number of calendar-days buffer to subtract from the fold cutoff so that
// no training label's horizon date falls inside the test window.
// With 21-day trading horizon, ~31 calendar days is a conservative buffer.
const LABEL_HORIZON_BUFFER_DAYS = Math.ceil(PREDICTION_HORIZON_DAYS * 1.5);

type Kind = "overall" | "momentum" | "value" | "lowRisk";

// ── Utilities ────────────────────────────────────────────────────────────────

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

// ── Walk-forward validation ──────────────────────────────────────────────────

interface FoldResult {
  fold: number;
  cutoffDate: string;
  testEndDate: string;
  trainRows: number;
  testRows: number;
  accuracy: number;
  winRate: number;
  baseRate: number;
}

interface WalkForwardResult {
  /** Mean accuracy across all folds (the headline reported number). */
  accuracy: number;
  winRate: number;
  baseRate: number;
  folds: FoldResult[];
  /** Total number of test rows evaluated (sum across folds, or holdout size in fallback). */
  testSampleSize: number;
}

/**
 * Runs N-fold walk-forward validation for a single model kind.
 * Each fold trains a fresh model on historical data up to a cutoff date,
 * then evaluates on the next unseen window. Fold models are discarded after
 * evaluation; the caller is responsible for training the production model.
 */
async function walkForwardValidation(
  rows: TrainingRow[],
  kind: Kind,
  group: FeatureName[],
  nFolds: number,
  log: (msg: string) => void,
): Promise<WalkForwardResult> {
  const uniqueDates = Array.from(new Set(rows.map((r) => r.date))).sort();
  const totalDates = uniqueDates.length;

  // Need enough dates to split into meaningful windows.
  // Initial window = 60% of all dates; remaining 40% split across nFolds.
  const minTrainDates = Math.floor(totalDates * 0.6);
  const remaining = totalDates - minTrainDates;
  const foldSize = Math.floor(remaining / nFolds);

  if (foldSize < 10) {
    // Fall back to single chronological split — too few dates for rolling CV.
    log(
      `[train] "${kind}" walk-forward: insufficient date range ` +
        `(${totalDates} unique dates, need ≥ ${nFolds * 10 + minTrainDates}) — ` +
        `falling back to single 80/20 split`,
    );
    const { train, test } = chronologicalSplit(rows);
    // Apply label-horizon buffer to the fallback split too: exclude the last
    // LABEL_HORIZON_BUFFER_DAYS of "train" rows whose labels may bleed into test.
    const safeFallbackCutoff = (() => {
      const uniqueD = Array.from(new Set(train.map((r) => r.date))).sort();
      const safeIdx = Math.max(0, uniqueD.length - 1 - LABEL_HORIZON_BUFFER_DAYS);
      return uniqueD[safeIdx];
    })();
    const safeTrain = train.filter((r) => r.date <= safeFallbackCutoff);
    const XTrain = safeTrain.map((r) => vectorFor(r.features, group));
    const yTrain = safeTrain.map((r) => r.label);
    const XTest = test.map((r) => vectorFor(r.features, group));
    const yTest = test.map((r) => r.label);
    const m = new GradientBoostedTrees();
    await m.fit(XTrain, yTrain);
    const metrics = evaluate(m, XTest, yTest);
    return { ...metrics, folds: [], testSampleSize: test.length };
  }

  const foldResults: FoldResult[] = [];

  for (let fold = 0; fold < nFolds; fold++) {
    // Training window: everything before this fold's cutoff
    const trainEndIdx = minTrainDates + fold * foldSize;
    // Test window: [trainEnd, trainEnd + foldSize) or end of date list
    const testEndIdx = Math.min(trainEndIdx + foldSize, totalDates);

    const cutoffDate = uniqueDates[trainEndIdx - 1];
    const testEndDate = uniqueDates[testEndIdx - 1];

    // Pull the training cutoff back by LABEL_HORIZON_BUFFER_DAYS so that no
    // training row's label horizon date falls inside this fold's test window.
    // This eliminates temporal leakage caused by the prediction horizon.
    const safeTrainCutoffIdx = Math.max(0, trainEndIdx - 1 - LABEL_HORIZON_BUFFER_DAYS);
    const safeTrainCutoffDate = uniqueDates[safeTrainCutoffIdx];

    const trainRows = rows.filter((r) => r.date <= safeTrainCutoffDate);
    const testRows = rows.filter((r) => r.date > cutoffDate && r.date <= testEndDate);

    if (testRows.length < 50) {
      log(`[train] "${kind}" fold ${fold + 1}/${nFolds}: too few test rows (${testRows.length}) — skipping`);
      continue;
    }

    const XTrain = trainRows.map((r) => vectorFor(r.features, group));
    const yTrain = trainRows.map((r) => r.label);
    const XTest = testRows.map((r) => vectorFor(r.features, group));
    const yTest = testRows.map((r) => r.label);

    const foldModel = new GradientBoostedTrees();
    await foldModel.fit(XTrain, yTrain);

    const { accuracy, winRate, baseRate } = evaluate(foldModel, XTest, yTest);

    log(
      `[train] "${kind}" fold ${fold + 1}/${nFolds}: ` +
        `accuracy=${accuracy.toFixed(1)}%  winRate=${winRate.toFixed(1)}%  ` +
        `trainThrough=${cutoffDate}  testRows=${testRows.length}`,
    );

    foldResults.push({
      fold: fold + 1,
      cutoffDate,
      testEndDate,
      trainRows: trainRows.length,
      testRows: testRows.length,
      accuracy,
      winRate,
      baseRate,
    });
  }

  if (foldResults.length === 0) {
    // All folds were skipped — guard fallback, same leakage fix applied.
    const { train, test } = chronologicalSplit(rows);
    const uniqueD = Array.from(new Set(train.map((r) => r.date))).sort();
    const safeIdx = Math.max(0, uniqueD.length - 1 - LABEL_HORIZON_BUFFER_DAYS);
    const safeCutoff = uniqueD[safeIdx];
    const safeTrain = train.filter((r) => r.date <= safeCutoff);
    const m = new GradientBoostedTrees();
    await m.fit(
      safeTrain.map((r) => vectorFor(r.features, group)),
      safeTrain.map((r) => r.label),
    );
    const metrics = evaluate(
      m,
      test.map((r) => vectorFor(r.features, group)),
      test.map((r) => r.label),
    );
    return { ...metrics, folds: [], testSampleSize: test.length };
  }

  const n = foldResults.length;
  const accuracy = foldResults.reduce((s, f) => s + f.accuracy, 0) / n;
  const winRate = foldResults.reduce((s, f) => s + f.winRate, 0) / n;
  const baseRate = foldResults.reduce((s, f) => s + f.baseRate, 0) / n;
  const testSampleSize = foldResults.reduce((s, f) => s + f.testRows, 0);

  log(
    `[train] "${kind}" walk-forward MEAN: ` +
      `accuracy=${accuracy.toFixed(1)}%  winRate=${winRate.toFixed(1)}%  ` +
      `baseRate=${baseRate.toFixed(1)}%  (${n} folds, ${testSampleSize} total test rows)`,
  );

  return { accuracy, winRate, baseRate, folds: foldResults, testSampleSize };
}

// ── Main entry point ─────────────────────────────────────────────────────────

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

  const kinds: Kind[] = onlyKinds ?? ["overall", "momentum", "value", "lowRisk"];

  for (const kind of kinds) {
    const group: FeatureName[] = FEATURE_GROUPS[kind];
    log(`[train] "${kind}" — ${group.length} features, ${WALK_FORWARD_FOLDS}-fold walk-forward validation…`);

    // ── Step 1: Walk-forward validation (honest accuracy estimate) ──────────
    const wfResult = await walkForwardValidation(rows, kind, group, WALK_FORWARD_FOLDS, log);

    // ── Step 2: Train final production model on ALL rows ────────────────────
    // Using 100% of data here (no holdout) so the production model has the
    // maximum signal from recent data. The honest accuracy number comes from
    // walk-forward above, not from this final fit.
    log(`[train] "${kind}" — training final model on all ${rows.length} rows…`);
    const productionModel = new GradientBoostedTrees();
    await productionModel.fit(
      rows.map((r) => vectorFor(r.features, group)),
      rows.map((r) => r.label),
    );

    // ── Step 3: Persist to DB ───────────────────────────────────────────────
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
      model: productionModel.toJSON(),
      // trainSampleSize reflects how many rows the production model saw
      trainSampleSize: rows.length,
      // testSampleSize reflects total walk-forward test coverage (or holdout size in fallback)
      testSampleSize: wfResult.testSampleSize,
      backtestAccuracy: wfResult.accuracy,
      backtestWinRate: wfResult.winRate,
      backtestBaseRate: wfResult.baseRate,
      isActive: true,
    });

    log(
      `[train] Persisted "${kind}" model v${nextVersion} ` +
        `— walk-forward accuracy=${wfResult.accuracy.toFixed(1)}%`,
    );
  }

  log("[train] Done — all models trained with walk-forward validation and stored.");
}
