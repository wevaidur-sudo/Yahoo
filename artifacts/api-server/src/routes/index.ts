import { Router, type IRouter } from "express";
import healthRouter from "./health";
import financeRouter from "./finance";
import analysisRouter from "./analysis";
import mlRouter from "./ml";

const router: IRouter = Router();

router.use(healthRouter);
router.use(financeRouter);
router.use(analysisRouter);
router.use(mlRouter);

export default router;
