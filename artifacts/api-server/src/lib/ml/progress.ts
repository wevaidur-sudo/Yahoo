/**
 * In-memory progress tracker for the ML retraining pipeline. Purely
 * observational (never affects control flow) — lets the API surface
 * "what is the background training job doing right now" to the UI without
 * polling logs. State is process-local; it resets on server restart, which
 * is fine since a restart also means any in-flight job was killed.
 */

export type TrainingPhase =
  | "idle"
  | "fetching-history"
  | "fetching-fundamentals"
  | "building-training-set"
  | "training-model"
  | "done"
  | "error";

export interface TrainingProgressSnapshot {
  phase: TrainingPhase;
  /** e.g. "AAPL" while fetching history/fundamentals for that symbol. */
  currentSymbol: string | null;
  /** Symbols processed so far in the current fetch phase. */
  symbolsDone: number;
  /** Total symbols in the training universe for the current fetch phase. */
  symbolsTotal: number;
  /** Which score model is currently training, e.g. "momentum". */
  currentModelKind: string | null;
  /** Walk-forward fold currently running (1-based), null outside training. */
  currentFold: number | null;
  /** Total walk-forward folds configured. */
  totalFolds: number | null;
  /** Human-readable one-liner mirroring the last log line, for display. */
  message: string;
  /** When this job started, ISO timestamp, null if never run this process. */
  startedAt: string | null;
  /** When this snapshot was last updated, ISO timestamp. */
  updatedAt: string;
}

const state: TrainingProgressSnapshot = {
  phase: "idle",
  currentSymbol: null,
  symbolsDone: 0,
  symbolsTotal: 0,
  currentModelKind: null,
  currentFold: null,
  totalFolds: null,
  message: "No training job has run yet in this session.",
  startedAt: null,
  updatedAt: new Date().toISOString(),
};

function touch(): void {
  state.updatedAt = new Date().toISOString();
}

export function getTrainingProgress(): TrainingProgressSnapshot {
  return { ...state };
}

export function resetTrainingProgress(): void {
  state.phase = "fetching-history";
  state.currentSymbol = null;
  state.symbolsDone = 0;
  state.symbolsTotal = 0;
  state.currentModelKind = null;
  state.currentFold = null;
  state.totalFolds = null;
  state.message = "Starting training job…";
  state.startedAt = new Date().toISOString();
  touch();
}

export function setFetchProgress(
  phase: "fetching-history" | "fetching-fundamentals",
  symbol: string,
  done: number,
  total: number,
): void {
  state.phase = phase;
  state.currentSymbol = symbol;
  state.symbolsDone = done;
  state.symbolsTotal = total;
  state.message =
    phase === "fetching-history"
      ? `Fetching price history: ${symbol} (${done}/${total})`
      : `Fetching fundamentals: ${symbol} (${done}/${total})`;
  touch();
}

export function setBuildingTrainingSet(): void {
  state.phase = "building-training-set";
  state.currentSymbol = null;
  state.message = "Building point-in-time training rows from stored history…";
  touch();
}

export function setTrainingFold(kind: string, fold: number, totalFolds: number): void {
  state.phase = "training-model";
  state.currentModelKind = kind;
  state.currentFold = fold;
  state.totalFolds = totalFolds;
  state.message = `Training "${kind}" model — walk-forward fold ${fold}/${totalFolds}`;
  touch();
}

export function setTrainingFinalFit(kind: string): void {
  state.phase = "training-model";
  state.currentModelKind = kind;
  state.currentFold = null;
  state.message = `Training "${kind}" — fitting final production model on all data…`;
  touch();
}

export function setDone(): void {
  state.phase = "done";
  state.currentSymbol = null;
  state.currentModelKind = null;
  state.currentFold = null;
  state.message = "Training job complete — models are up to date.";
  touch();
}

export function setError(errMessage: string): void {
  state.phase = "error";
  state.message = `Training job failed: ${errMessage}`;
  touch();
}
