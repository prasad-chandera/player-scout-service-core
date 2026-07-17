// Endpoint 8 — the Moneyball page (docs/02 §5).
//
// value_gap = expected_value - expected_price. For uncapped domestic players the expected
// price IS their auction base price bracket — which is exactly the point: elite-skill
// uncapped players sit at base price.

import type { RequestHandler } from "express";
import { UNDERVALUED_DISCLAIMER, players } from "../store.js";
import { toSummary } from "../services/similarity.service.js";
import type { Role, UndervaluedEntry } from "../types/index.js";

export const list: RequestHandler<unknown, unknown, unknown, { limit?: string; role?: Role }> = (
  req,
  res,
) => {
  const limit = Math.min(50, Math.max(1, Number.parseInt(String(req.query.limit), 10) || 10));
  const { role } = req.query;

  const ranked: UndervaluedEntry[] = players
    .filter((p) => p.competition === "smat")
    .filter((p) => !role || p.role === role)
    .map((p) => ({
      player: toSummary(p),
      expectedPriceLakh: p.expectedPriceLakh,
      expectedValueLakh: p.expectedValueLakh,
      valueGapLakh: p.expectedValueLakh - p.expectedPriceLakh,
      reasons: p.tags,
    }))
    .sort((a, b) => b.valueGapLakh - a.valueGapLakh)
    .slice(0, limit)
    .map((entry, i) => ({ rank: i + 1, ...entry }));

  res.json({ players: ranked, disclaimer: UNDERVALUED_DISCLAIMER });
};
