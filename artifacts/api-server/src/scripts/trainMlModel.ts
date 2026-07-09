/**
 * Retraining job entrypoint. Run via:
 *   pnpm --filter @workspace/api-server run train-ml
 *
 * Intended to be run periodically (e.g. weekly via a scheduled job) so the
 * model doesn't go stale as new price history accumulates. Safe to re-run:
 * fetches incrementally (upserts by symbol+date) and always retrains fresh.
 */
import { fetchAndStoreHistory, fetchAndCacheFundamentals } from "../lib/ml/pipeline";
import { trainAllModels } from "../lib/ml/train";
import { TRAINING_UNIVERSE } from "../lib/ml/universe";

async function main() {
  console.log(`[train-ml] Starting full retraining job for ${TRAINING_UNIVERSE.length} symbols…`);
  await fetchAndStoreHistory(TRAINING_UNIVERSE);
  await fetchAndCacheFundamentals(TRAINING_UNIVERSE);
  await trainAllModels();
  console.log("[train-ml] Retraining job complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[train-ml] FAILED:", err);
  process.exit(1);
});
