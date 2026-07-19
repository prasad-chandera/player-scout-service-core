// Types for the player-comparison endpoint (GET /players/:id/similar/:candidateId) — the
// "why are these two similar" detail view a scout opens after seeing a candidate in the
// GET /players/similar list. Builds directly on the same skill-radar feature vector and
// matchScore formula ../services/similarPlayers.ts uses to rank that list (see
// compareSimilarity there), so the percentage shown here always agrees with the
// percentage the list showed for the same pair.

import type { CricketPlayer } from './players'

/** One skill-radar axis compared between the two players. */
export interface PlayerComparisonFeatureRow {
	/** The SkillRadarScores key this row compares, e.g. "pressure". */
	feature: string
	/** Human-readable label, e.g. "Pressure handling". */
	label: string
	/** The seed player's raw score on this axis, formatted for display (e.g. "9.6/10"). */
	seedValue: string
	/** The candidate's raw score on this axis, formatted for display. */
	candidateValue: string
	/**
	 * 0-100 share of the overall match attributable to this axis — how close the two
	 * players are on this axis, relative to the other axes. Rows sum to 100 across the
	 * full feature set; a row-count cap on the endpoint truncates the list, it doesn't
	 * rescale the shares of what's left.
	 */
	shareOfSimilarity: number
}

/** GET /players/:id/similar/:candidateId response payload. */
export interface PlayerComparisonResult {
	seedPlayer: CricketPlayer
	candidatePlayer: CricketPlayer
	/** Same 0-100 score and formula GET /players/similar ranks candidates by for this pair. */
	matchScore: number
	/**
	 * False when this pair's impactScore gap is wide enough that they would NOT actually
	 * appear together in a GET /players/similar list, despite matching on skill shape —
	 * see the impact gate in ../services/similarPlayers.ts. Surfaced so a caller comparing
	 * two arbitrary player ids (not necessarily ones GET /players/similar returned
	 * together) can tell the two apart.
	 */
	impactGatePassed: boolean
	/** One-sentence summary of why the two players matched. */
	verdict: string
	/** Skill axes ranked by shareOfSimilarity, descending. */
	comparisons: PlayerComparisonFeatureRow[]
	/** Notable ways the two players differ, despite the overall match — never empty. */
	differences: string[]
	/**
	 * Whether `verdict`/`differences` came from an LLM narrating the numbers above, or a
	 * deterministic template (no GOOGLE_GENAI_API_KEY configured, or the call failed) —
	 * surfaced so the UI can be upfront about it, the same spirit as flagging a scouting
	 * report as "generated from computed stats only" when no live model ran.
	 */
	narrativeSource: 'ai' | 'template'
}
