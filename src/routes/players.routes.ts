import { Router } from "express";
import * as playersController from "../controllers/players.controller.js";

const router = Router();

// 1. List/search.
router.get("/players", playersController.list);

// 11. The frozen feature dictionary. Registration order is load-bearing: this must come
// BEFORE /players/:id, or Express would match "meta" as a player id and 404.
router.get("/meta/features", playersController.getFeatures);

// 2, 3, 5. Player profile, similarity, readiness.
router.get("/players/:id", playersController.getById);
router.get("/players/:id/similar", playersController.getSimilar);
router.get("/players/:id/readiness", playersController.getReadiness);

export default router;
