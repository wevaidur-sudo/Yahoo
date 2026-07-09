/**
 * Automated retraining scheduler.
 *
 * Runs the full ML pipeline (fetch history → fetch fundamentals → train all 4
 * models) on a weekly cadence. On startup it checks the DB for the most recent
 * model and either:
 *   - Triggers an immediate run if no models exist yet, or the last run was
 *     more than RETRAIN_INTERVAL_MS ago.
 *   - Schedules the first run for when the interval is next due, then repeats
 *     weekly via setInterval.
 *
 * Design guarantees:
 *   - Singleton: startRetrainingScheduler() is idempotent; subsequent calls
 *     are no-ops so accidental double-init cannot create duplicate timers.
 *   - Timer handles are retained and can be cleared via stopRetrainingScheduler().
 *   - The repeating setInterval is only armed after a run actually executes
 *     (not after a skipped "already running" guard-exit).
 *   - All errors are caught and logged; nothing propagates to crash the server.
 */
import { db, mlModelsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { logger } from "../logger";
import { fetchAndStoreHistory, fetchAndCacheFundamentals } from "./pipeline";
import { trainAllModels } from "./train";
import { TRAINING_UNIVERSE } from "./universe";

/** One week in milliseconds. */
const RETRAIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SchedulerStatus {
  isRunning: boolean;
  lastRunAt: string | null;   // ISO timestamp
  nextRunAt: string | null;   // ISO timestamp
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// Internal singleton state
// ---------------------------------------------------------------------------

let started = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

const state: {
  isRunning: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  lastError: string | null;
} = {
  isRunning: false,
  lastRunAt: null,
  nextRunAt: null,
  lastError: null,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Returns a snapshot of the scheduler state (safe to serialise as JSON). */
export function getSchedulerStatus(): SchedulerStatus {
  return {
    isRunning: state.isRunning,
    lastRunAt: state.lastRunAt?.toISOString() ?? null,
    nextRunAt: state.nextRunAt?.toISOString() ?? null,
    lastError: state.lastError,
  };
}

/** Clears all pending timers. Useful for clean shutdown or testing. */
export function stopRetrainingScheduler(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (timeoutHandle !== null) {
    clearTimeout(timeoutHandle);
    timeoutHandle = null;
  }
  started = false;
  logger.info("[ml-scheduler] Scheduler stopped");
}

/**
 * Start the scheduler. Idempotent — subsequent calls are no-ops.
 * Non-blocking: any immediate run fires in the background.
 */
export async function startRetrainingScheduler(): Promise<void> {
  if (started) {
    logger.info("[ml-scheduler] Already started — skipping duplicate init");
    return;
  }
  started = true;

  // Arm the repeating weekly interval *after* a run actually completes.
  function armInterval(): void {
    if (intervalHandle !== null) return; // guard against double-arm
    intervalHandle = setInterval(() => {
      void runJob();
    }, RETRAIN_INTERVAL_MS);
  }

  // Find the most recently trained model across all kinds.
  const [latest] = await db
    .select({ trainedAt: mlModelsTable.trainedAt })
    .from(mlModelsTable)
    .orderBy(desc(mlModelsTable.trainedAt))
    .limit(1);

  const now = Date.now();

  if (!latest) {
    logger.info(
      "[ml-scheduler] No trained models found — triggering initial training in background",
    );
    state.nextRunAt = new Date(now + RETRAIN_INTERVAL_MS);
    void runJob().then((ran) => {
      if (ran) armInterval();
    });
    return;
  }

  state.lastRunAt = latest.trainedAt;
  const msSinceLast = now - latest.trainedAt.getTime();

  if (msSinceLast >= RETRAIN_INTERVAL_MS) {
    const daysSince = Math.round(msSinceLast / 86_400_000);
    logger.info(
      { daysSince },
      "[ml-scheduler] Last training overdue — triggering retrain in background",
    );
    state.nextRunAt = new Date(now + RETRAIN_INTERVAL_MS);
    void runJob().then((ran) => {
      if (ran) armInterval();
    });
  } else {
    const msUntilNext = RETRAIN_INTERVAL_MS - msSinceLast;
    state.nextRunAt = new Date(now + msUntilNext);
    const hoursUntil = Math.round(msUntilNext / 3_600_000);
    logger.info(
      { hoursUntil, nextRunAt: state.nextRunAt.toISOString() },
      "[ml-scheduler] Retrain scheduled",
    );
    timeoutHandle = setTimeout(() => {
      timeoutHandle = null;
      void runJob().then((ran) => {
        if (ran) armInterval();
      });
    }, msUntilNext);
  }
}

// ---------------------------------------------------------------------------
// Internal: the actual training job
// ---------------------------------------------------------------------------

/**
 * Runs the full pipeline: fetch history → fetch fundamentals → train models.
 * Returns `true` if the job actually ran, `false` if it was skipped because
 * a run was already in progress. Callers use this to decide whether to arm
 * the repeating interval.
 */
async function runJob(): Promise<boolean> {
  if (state.isRunning) {
    logger.warn("[ml-scheduler] Retrain already in progress — skipping this tick");
    return false;
  }

  state.isRunning = true;
  state.lastError = null;
  logger.info(
    { symbols: TRAINING_UNIVERSE.length },
    "[ml-scheduler] Retraining job started",
  );

  try {
    await fetchAndStoreHistory(TRAINING_UNIVERSE);
    await fetchAndCacheFundamentals(TRAINING_UNIVERSE);
    await trainAllModels((msg: string) => logger.info(msg));

    state.lastRunAt = new Date();
    state.nextRunAt = new Date(Date.now() + RETRAIN_INTERVAL_MS);
    logger.info(
      { nextRunAt: state.nextRunAt.toISOString() },
      "[ml-scheduler] Retraining job complete",
    );
    return true;
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "[ml-scheduler] Retraining job failed");
    return true; // still "ran" — arm the interval so we retry next week
  } finally {
    state.isRunning = false;
  }
}
