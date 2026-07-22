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
	/** Set when the query names one specific player rather than asking by role/stat/budget. */
	playerName: string | null
	/**
	 * Set instead of playerName when the query asks for OTHER players with a comparable
	 * career/skill profile to a named player (e.g. "players like Sachin Tendulkar") rather
	 * than that player themselves. Delegated wholesale to the stat-similarity engine in
	 * ../services/similarPlayers.ts — see searchPlayers.
	 */
	similarTo: string | null
	role: PlayerRole | null
	competition: DomesticCompetition | null
	/** Case-insensitive substring match against any team the player has represented. */
	team: string | null
	/** Budget ceiling in lakhs (the LLM converts "10 crore" -> 1000 itself). */
	maxPriceLakh: number | null
	minPriceLakh: number | null
	minImpactScore: number | null
	minMatches: number | null
	/**
	 * Descriptive terms from the query that don't map to any field above (a playing-style
	 * phrase, a nickname) — fuzzy-matched against each player's scouting tags to give
	 * queries like "death bowler" or "proven performer" some pull on ranking even though
	 * there's no dedicated structured field for them.
	 */
	keywords: string[]
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
	/** Capped at the `limit` searchPlayers was called with — see `total` below. */
	players: CricketPlayer[]
	/**
	 * Size of the matched set, capped at MAX_RESULT_LIMIT — never higher than what a
	 * caller could actually retrieve by passing `limit: MAX_RESULT_LIMIT`, since there's
	 * no pagination past that ceiling. Can still exceed players.length when `limit` is
	 * below MAX_RESULT_LIMIT; call searchPlayers again with a bigger `limit` to see more.
	 */
	total: number
}
