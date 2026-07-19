// IPL Readiness Score — a transparent weighted sum, not an opaque ML model (docs/02 §4).
// Every score decomposes into visible per-feature contributions, which is the whole point:
// the UI can show its work, and no prediction can embarrass us that we can't explain.
//
// These weights ARE the model. Changing them changes every score on screen.

import { FEATURES } from '../store'
import type {
	Player,
	ReadinessBreakdownRow,
	ReadinessResponse,
	Role
} from '../types/index'

export const MODEL_VERSION = 'weighted-v1'

/** Every feature key must be present, or a score silently becomes NaN. */
type FeatureWeights = Record<string, number>

// Keyed by feature; each role's weights sum to 1.0.
const BOWLER_WEIGHTS: FeatureWeights = {
	deathImpact: 0.22,
	dotBallPct: 0.15,
	containmentOrRotation: 0.13,
	powerplayImpact: 0.12,
	wicketOrBoundaryPct: 0.12,
	pressure: 0.1,
	vsLeft: 0.04,
	vsRight: 0.04,
	fielding: 0.05,
	consistency: 0.03
}

const BATTER_WEIGHTS: FeatureWeights = {
	pressure: 0.2,
	deathImpact: 0.18,
	powerplayImpact: 0.14,
	wicketOrBoundaryPct: 0.14,
	containmentOrRotation: 0.12,
	vsLeft: 0.07,
	vsRight: 0.05,
	dotBallPct: 0.05,
	fielding: 0.03,
	consistency: 0.02
}

// All-rounders are scored on the mean of both profiles — they have to do both jobs.
const ALLROUNDER_WEIGHTS: FeatureWeights = Object.fromEntries(
	FEATURES.map((f) => [
		f.key,
		((BOWLER_WEIGHTS[f.key] as number) + (BATTER_WEIGHTS[f.key] as number)) / 2
	])
)

export const WEIGHTS: Record<Role, FeatureWeights> = {
	bowler: BOWLER_WEIGHTS,
	batter: BATTER_WEIGHTS,
	allrounder: ALLROUNDER_WEIGHTS
}

export function weightsFor(role: Role): FeatureWeights {
	return WEIGHTS[role] ?? ALLROUNDER_WEIGHTS
}

/**
 * readiness = 100 x sum(weight_i x normalized_feature_i), with sum(weight_i) = 1.
 * Contributions sum to the score — the frontend renders them as a "why this score" panel.
 */
export function readinessFor(player: Player): ReadinessResponse {
	const weights = weightsFor(player.role)
	const rows: ReadinessBreakdownRow[] = FEATURES.map((f) => {
		const weight = weights[f.key] as number
		const normalizedValue = player.featureVector[f.index] as number
		return {
			feature: f.key,
			label: f.label,
			weight,
			normalizedValue,
			contribution: 100 * weight * normalizedValue
		}
	})

	// Round the score first, then distribute rounding across contributions so the
	// breakdown always sums to exactly the number on the dial.
	const rawScore = rows.reduce((sum, r) => sum + r.contribution, 0)
	const score = Math.round(rawScore)

	const breakdown: ReadinessBreakdownRow[] = rows
		.map((r) => ({ ...r, contribution: Math.round(r.contribution * 10) / 10 }))
		.sort((a, b) => b.contribution - a.contribution)

	const drift = score - breakdown.reduce((sum, r) => sum + r.contribution, 0)
	if (Math.abs(drift) > 1e-9 && breakdown[0]) {
		breakdown[0].contribution =
			Math.round((breakdown[0].contribution + drift) * 10) / 10
	}

	return { playerId: player.id, score, breakdown, modelVersion: MODEL_VERSION }
}

/** The 3 features doing the most work for this player — used for tags and the LLM payload. */
export function topContributors(player: Player, n = 3): string[] {
	return readinessFor(player)
		.breakdown.slice(0, n)
		.map((r) => r.feature)
}
