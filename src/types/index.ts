// The contract with the frontend.
//
// These shapes mirror ../scout-iq/src/lib/types.ts. That file — not
// docs/03-api-endpoints-and-ai.md — is the source of truth, because it is what the UI
// actually deserializes. Where the doc disagrees, the doc is wrong:
//   - featureVector is a flat number[], not { ordering, values }
//   - FeatureContribution.referenceValue/candidateValue are STRINGS ("econ 6.8", "49%")
//
// If a shape changes there, change it here too.

export type Role = 'batter' | 'bowler' | 'allrounder'
export type Competition = 'smat' | 'ipl'
export type Phase = 'powerplay' | 'middle' | 'death'

export interface PlayerSummary {
	id: string
	name: string
	role: Role
	/** 0–100 */
	readiness: number
	expectedPriceLakh: number
	tags: string[]
}

export interface SkillGroups {
	batting: number
	bowling: number
	fielding: number
	pressure: number
	consistency: number
}

export interface PhaseStat {
	phase: Phase
	/** runs per over (bowlers) */
	economy?: number
	/** per 100 balls (batters) */
	strikeRate?: number
	wicketPct?: number
	dotPct: number
}

export interface Player extends PlayerSummary {
	battingHand: 'right' | 'left'
	bowlingStyle?: string
	age: number
	competition: Competition
	matches: number
	expectedValueLakh: number
	rawStats: Record<string, number>
	skillGroups: SkillGroups
	phaseStats: PhaseStat[]
	/** normalized 0–1 vector, ordering per GET /api/meta/features */
	featureVector: number[]
	/**
	 * Backend-only. Features whose sample fell below the minimum — the UI greys these
	 * rather than rendering them as zero, and the LLM is told to caveat them.
	 */
	coverage?: Record<string, boolean>
}

export interface FeatureContribution {
	feature: string
	label: string
	/** share of the cosine numerator, 0–1 */
	contribution: number
	/** raw human-readable stat, not the normalized value */
	referenceValue: string
	candidateValue: string
}

export interface SimilarityResult {
	player: PlayerSummary
	/** 0–1 */
	similarity: number
	topContributions: FeatureContribution[]
}

export interface SimilarSearchResponse {
	reference: { id: string; name: string }
	results: SimilarityResult[]
}

export interface ReadinessBreakdownRow {
	feature: string
	label: string
	weight: number
	normalizedValue: number
	/** 100 × weight × normalizedValue; these sum to the score */
	contribution: number
}

export interface ReadinessResponse {
	playerId: string
	score: number
	breakdown: ReadinessBreakdownRow[]
	modelVersion: string
}

export interface Explanation {
	summary: string
	strengths: string[]
	weaknesses: string[]
	comparablePlayers: { name: string; note: string }[]
}

/** Backend-only — endpoint 7's shape. */
export interface ComparisonExplanation {
	verdict: string
	rows: { label: string; a: string; b: string; note: string }[]
	differences: string[]
}

export interface UndervaluedEntry {
	rank: number
	player: PlayerSummary
	expectedPriceLakh: number
	expectedValueLakh: number
	valueGapLakh: number
	reasons: string[]
}

export interface UndervaluedResponse {
	players: UndervaluedEntry[]
	disclaimer: string
}

export interface TeamNeed {
	role: string
	weight: number
	label: string
}

export interface TeamProfile {
	id: string
	name: string
	short: string
	colors: { primary: string; secondary: string }
	needs: TeamNeed[]
	budgetLakh: number
	prefersIndian: boolean
}

export interface TeamFitRecommendation {
	player: PlayerSummary
	fitScore: number
	matchedNeed: string
	reason: string
}

export interface TeamFitResponse {
	team: { id: string; name: string }
	recommendations: TeamFitRecommendation[]
}

/** GET /api/meta/features — the frozen vector ordering shared with the frontend. */
export interface FeatureMeta {
	key: string
	label: string
	index: number
	higherIsBetter: boolean
	unit: string
}

// ------------------------------- request bodies -------------------------------
// Declared rather than inferred so handlers can narrow `req.body` without `any`.
// Every field is optional: these describe what a client *may* send, and the
// handlers validate before trusting them.

export interface SearchSimilarBody {
	referencePlayerId?: string
	description?: string
	limit?: number
	excludeIpl?: boolean
}

export interface ExplainPlayerBody {
	playerId?: string
	regenerate?: boolean
}

export interface ExplainComparisonBody {
	playerAId?: string
	playerBId?: string
	regenerate?: boolean
}

export interface TeamFitBody {
	limit?: number
	maxPriceLakh?: number
}
