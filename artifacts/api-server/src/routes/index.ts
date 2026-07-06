import { Router, type IRouter } from "express";
import healthRouter from "./health";
import financeRouter from "./finance";

const router: IRouter = Router();

router.use(healthRouter);
router.use(financeRouter);

export default router;
