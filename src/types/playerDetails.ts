// Types for the player-details endpoints — GET /api/players/:id (header/profile card),
// GET /api/players/:id/skill-radar (radar chart) and GET /api/players/:id/economy-by-phase
// (bar chart). Each mirrors one of the three data groups the scouting profile UI renders.
//
// See ../services/playerDetails.ts for how each response is assembled from the
// Cricsheet-backed catalogue (../services/cricsheet.ts) and ../services/scoring.ts for
// the underlying formulas (computeSkillRadar, computeEconomyByPhase).

import type {
	DomesticCompetition,
	EstimatedPriceRange,
	PlayerAge,
	PlayerRole
} from './players'

/** T20 over-phase bucket, in innings order — see POWERPLAY_LAST_OVER/DEATH_FIRST_OVER in cricsheet.ts. */
export type MatchPhase = 'powerplay' | 'middle' | 'death'

/** GET /api/players/:id — the scouting profile header card. */
export interface PlayerDetails {
	id: string
	name: string
	role: PlayerRole
	battingHand: 'right' | 'left' | null
	bowlingStyle: string | null
	age: PlayerAge | null
	competition: DomesticCompetition
	matches: number
	teams: string[]
	currentIPLTeam: string | null
	imageUrl: string | null
	/** 0-100 overall scouting score (the "IPL Ready" dial) — identical to CricketPlayer.impactScore. */
	readinessScore: number
	/** Auction-score-derived price band — the same estimate CricketPlayer.estimatedPriceRange carries. */
	estimatedPriceRange: EstimatedPriceRange
	/**
	 * Short scouting callouts (e.g. "Elite death bowling"), derived from this player's
	 * percentile standing against same-role peers — see buildScoutingTags in
	 * ../services/cricsheet.ts. Empty when nothing clears the bar, never fabricated.
	 */
	tags: string[]
}

/** 0-10 scale per axis, for the skill radar chart. */
export interface SkillRadarScores {
	batting: number
	bowling: number
	fielding: number
	pressure: number
	consistency: number
}

/** GET /api/players/:id/skill-radar */
export interface PlayerSkillRadar {
	playerId: string
	scores: SkillRadarScores
}

/**
 * One phase's derived figures. `economy`/`strikeRate`/`wicketPct` are null when the
 * player had no legal deliveries bowled/faced in that phase (e.g. a specialist batter
 * has no bowling figures at all).
 */
export interface PhaseEconomyEntry {
	phase: MatchPhase
	/** Runs conceded per over. Null when this player bowled no legal deliveries in the phase. */
	economy: number | null
	/** Runs scored per 100 balls faced. Null when this player faced no legal deliveries in the phase. */
	strikeRate: number | null
	/** Wickets taken per 100 balls bowled. Null when this player bowled no legal deliveries in the phase. */
	wicketPct: number | null
	/** % of this player's legal deliveries (batted + bowled) in the phase that were dot balls. */
	dotPct: number | null
}

/** GET /api/players/:id/economy-by-phase */
export interface PlayerEconomyByPhase {
	playerId: string
	/** Always exactly 3 entries, in `powerplay, middle, death` order. */
	phases: PhaseEconomyEntry[]
}
