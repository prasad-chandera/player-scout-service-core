import { Router } from "express";
import * as explainController from "../controllers/explain.controller.js";

const router = Router();

// 6, 7. Claude scouting report and side-by-side comparison.
router.post("/explain/player", explainController.player);
router.post("/explain/comparison", explainController.comparison);

export default router;
