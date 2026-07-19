// Types for the natural-language player search endpoint (../services/playerSearch.ts
// does the LLM parsing, ../services/geminiClient.ts wraps the Gemini call itself).
//
// Design: the LLM's only job is to turn free text into PlayerSearchCriteria — a small,
// fast, structured-output call. It never sees the player catalogue. Applying those
// criteria against the (already in-memory, already-scored) player list is plain
// deterministic filtering/sorting, same cost as the existing /api/players endpoint.

import type { CricketPlayer, DomesticCompetition, PlayerRole } from './players'

export type PlayerSearchSort =
	| 'impactScore'
	| 'matches'
	| 'priceAsc'
	| 'priceDesc'
	| 'youngest'

/** Structured interpretation of a free-text search query, produced by the LLM. */
export interface PlayerSearchCriteria {
	role: PlayerRole | null
	competition: DomesticCompetition | null
	/** Case-insensitive substring match against any team the player has represented. */
	team: string | null
	/** Budget ceiling in lakhs (the LLM converts "10 crore" -> 1000 itself). */
	maxPriceLakh: number | null
	minPriceLakh: number | null
	minImpactScore: number | null
	minMatches: number | null
	sortBy: PlayerSearchSort
	/** How many results the query seems to want (e.g. "top 5"); defaults applied by the caller. */
	limit: number | null
	/**
	 * One-sentence, plain-English restatement of what's being searched for — shown to
	 * the user so they can see how their query was understood, and to be upfront when
	 * a request (e.g. a specific match-phase breakdown) was mapped to the closest
	 * available signal rather than answered exactly.
	 */
	interpretation: string
}

export interface PlayerSearchResult {
	query: string
	interpretation: string
	criteria: PlayerSearchCriteria
	players: CricketPlayer[]
	total: number
}
