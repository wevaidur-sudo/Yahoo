import { Router, type IRouter } from "express";
import healthRouter from "./health";
import financeRouter from "./finance";
import analysisRouter from "./analysis";

const router: IRouter = Router();

router.use(healthRouter);
router.use(financeRouter);
router.use(analysisRouter);

export default router;
