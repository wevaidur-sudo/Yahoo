import app from "./app";
import { logger } from "./lib/logger";
import { startRetrainingScheduler } from "./lib/ml/scheduler";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Start the weekly ML retraining scheduler in the background.
  // Any error during scheduler setup is non-fatal — log and continue.
  startRetrainingScheduler().catch((schedulerErr) => {
    logger.error({ err: schedulerErr }, "[ml-scheduler] Failed to initialise scheduler");
  });
});
