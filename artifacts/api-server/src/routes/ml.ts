import { Router, type IRouter } from "express";
import { getSchedulerStatus } from "../lib/ml/scheduler";

const router: IRouter = Router();

/**
 * GET /api/ml/status
 * Returns the current state of the automated retraining scheduler so the UI
 * (or an admin) can see when models were last trained and when the next run is.
 */
router.get("/ml/status", (_req, res) => {
  res.json(getSchedulerStatus());
});

export default router;
