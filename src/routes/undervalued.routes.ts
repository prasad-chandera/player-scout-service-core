import { Router } from "express";
import * as undervaluedController from "../controllers/undervalued.controller.js";

const router = Router();

// 8. The Moneyball page.
router.get("/undervalued", undervaluedController.list);

export default router;
