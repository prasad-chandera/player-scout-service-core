// Cosine similarity over the frozen 10-slot feature vector (docs/03 §AI-1).
// 50 players x 10 dims — a full scan is microseconds. No vector DB, no embeddings.
//
// ---------------------------------------------------------------------------------
// DEVIATION FROM docs/03 §AI-1: vectors are mean-centred before the cosine.
//
// docs/02 §3 flags the risk ("cosine ignores magnitude, so a uniformly mediocre player
// can be 'shaped like' Bumrah at a lower level") and suggests showing readiness next to
// similarity as the mitigation. On real data the problem is worse than that framing
// suggests, and the mitigation doesn't reach it.
//
// Every feature is normalised so that 1 is always good, so every vector lives in the
// positive orthant with a pool mean of ~0.7 per slot. All 50 vectors therefore point
// into one narrow cone, and raw cosine saturates: measured against Bumrah, the entire
// bowler pool scored 98.4%–99.8% — a 2.9-point spread across players from elite to
// ordinary. Every candidate reads "100%" after rounding, which makes the headline
// number of the whole product meaningless.
//
// Subtracting the pool mean per feature first (i.e. Pearson correlation over the
// vector) fixes it: the same pool then spreads across ~169 points, and the top results
// land in the 60–90% band that docs/01 §6's demo script assumes.
//
// This is also the more honest question to ask. Raw cosine asks "are these two players
// good at the same absolute levels?" — to which the answer is always roughly yes,
// because everyone in the dataset is a professional. Centred cosine asks "does this
// player deviate from the pool average in the same way the reference does?", which is
// what a scout actually means by "find me another Bumrah".
//
// The mean is computed once at boot over the whole dataset and never varies by query,
// so similarity(A, B) is a stable property of the pair — toggling `excludeIpl` changes
// which players you see, never their scores.
// ---------------------------------------------------------------------------------

import { FEATURES, players as allPlayers } from "../store.js";
import type { FeatureContribution, Player, PlayerSummary, SimilarityResult } from "../types/index.js";

/** Per-feature pool mean, fixed at boot. */
const POOL_MEAN: number[] = FEATURES.map(
  (_, i) => allPlayers.reduce((sum, p) => sum + (p.featureVector[i] as number), 0) / allPlayers.length,
);

export const centre = (v: number[]): number[] => v.map((x, i) => x - (POOL_MEAN[i] as number));

/**
 * Plain cosine — exported for reference and testing. See the note above for why the
 * engine uses `similarity()` rather than calling this on raw vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Cosine over mean-centred vectors, clamped to [0,1] — an anti-correlated player is
 * "0% similar", not "-40% similar", which is not a thing a scout would say.
 */
export function similarity(a: number[], b: number[]): number {
  return Math.max(0, cosineSimilarity(centre(a), centre(b)));
}

export interface ContributionTerm {
  index: number;
  contribution: number;
}

/**
 * The explainability trick: the cosine numerator is a sum of elementwise products, so
 * each feature's share of that sum is its contribution to the match. Centred, a term is
 * positive when both players deviate from the pool the same way — which is exactly what
 * "similar because: death economy, dot-ball %" means.
 *
 * Shares are taken over the positive terms only. Negative terms are the ways the two
 * players DIFFER; folding them into the denominator would let a single contributor
 * exceed 100%, and we only ever surface the top few as reasons they match.
 */
export function contributions(a: number[], b: number[]): ContributionTerm[] {
  const ca = centre(a);
  const cb = centre(b);
  const terms = ca.map((ai, i) => ai * (cb[i] as number));
  const positive = terms.reduce((sum, t) => sum + Math.max(0, t), 0) || 1;
  return terms.map((t, index) => ({ index, contribution: Math.max(0, t) / positive }));
}

const pct = (v: number | undefined): string => (v === undefined ? "—" : `${Math.round(v * 100)}%`);

/**
 * Human-readable raw stat per feature slot — these strings go straight into the
 * comparison table, so they are strings by contract (see ../types/index.ts).
 */
export function rawFeatureValue(p: Player, featureKey: string): string {
  const s = p.rawStats;
  switch (featureKey) {
    case "powerplayImpact":
      return p.role === "batter"
        ? `SR ${p.phaseStats[0]?.strikeRate ?? "—"}`
        : `econ ${p.phaseStats[0]?.economy ?? "—"}`;
    case "deathImpact":
      return p.role === "batter"
        ? `SR ${p.phaseStats[2]?.strikeRate ?? "—"}`
        : `econ ${p.phaseStats[2]?.economy ?? "—"}`;
    case "dotBallPct":
      return pct(s.dotBallPct);
    case "wicketOrBoundaryPct":
      return s.wickets !== undefined ? `${s.wickets} wkts` : pct(s.boundaryPct);
    case "fielding":
      return `${s.catches ?? 0} ct, ${s.runOuts ?? 0} ro`;
    default: {
      if (featureKey === "pressure") return `${(p.skillGroups.pressure * 10).toFixed(1)}/10`;
      if (featureKey === "consistency") return `${(p.skillGroups.consistency * 10).toFixed(1)}/10`;
      const idx = FEATURES.findIndex((f) => f.key === featureKey);
      return `idx ${(p.featureVector[idx] ?? 0).toFixed(2)}`;
    }
  }
}

/** Compare within role only; all-rounders match both pools. */
function inPool(reference: Player, p: Player, excludeIpl: boolean): boolean {
  if (p.id === reference.id) return false;
  if (excludeIpl && p.competition === "ipl") return false;
  return p.role === reference.role || p.role === "allrounder" || reference.role === "allrounder";
}

export interface SimilarToOptions {
  limit?: number;
  excludeIpl?: boolean;
}

export function similarTo(
  reference: Player,
  pool: Player[],
  { limit = 5, excludeIpl = false }: SimilarToOptions = {},
): SimilarityResult[] {
  return pool
    .filter((p) => inPool(reference, p, excludeIpl))
    .map((p) => {
      const score = similarity(reference.featureVector, p.featureVector);
      const topContributions: FeatureContribution[] = contributions(
        reference.featureVector,
        p.featureVector,
      )
        .map(({ index, contribution }) => {
          const feature = FEATURES[index] as (typeof FEATURES)[number];
          return {
            feature: feature.key,
            label: feature.label,
            contribution,
            referenceValue: rawFeatureValue(reference, feature.key),
            candidateValue: rawFeatureValue(p, feature.key),
          };
        })
        .sort((x, y) => y.contribution - x.contribution)
        .slice(0, 3);
      return { player: toSummary(p), similarity: score, topContributions };
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

export function toSummary(p: Player): PlayerSummary {
  const { id, name, role, readiness, expectedPriceLakh, tags } = p;
  return { id, name, role, readiness, expectedPriceLakh, tags };
}
