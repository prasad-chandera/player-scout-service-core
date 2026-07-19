// Types for the AI-assisted similar-players endpoint (GET /players/similar?query=...).
//
// Mirrors playerSearch.ts's design: the LLM's only job is pulling a player name out of a
// free-text query (see ../services/similarPlayers.ts) — it never sees the player
// catalogue. Resolving that name to a catalogue player and ranking every other player by
// matchScore is deterministic, over the same cached, already-scored list
// ../services/cricsheet.ts builds for every other players endpoint.

import type { CricketPlayer } from './players'

/** The LLM's interpretation of a free-text "similar players" query. */
export interface SimilarPlayersQueryIntent {
	/**
	 * The player name as written in the query, verbatim (not corrected or expanded).
	 * Null when the query names no specific player to compare against — e.g. it's
	 * unrelated to cricket scouting, or asks for players by role/stat/budget rather
	 * than "similar to <someone>".
	 */
	playerName: string | null
	/**
	 * One plain sentence: restates the request when a player name was found, or
	 * explains why one couldn't be identified when it wasn't. Shown to the user
	 * either way, so an unresolved query still gets a helpful message rather than a
	 * bare validation error.
	 */
	interpretation: string
}

/** A catalogue player ranked by similarity to the seed player one query resolved to. */
export interface SimilarPlayer extends CricketPlayer {
	/**
	 * 0-100 similarity to the seed player, derived from skill-radar/impact-score
	 * proximity and role overlap — see computeMatchScore in
	 * ../services/similarPlayers.ts. Only meaningful relative to the other players in
	 * the same response; not comparable across different seed players or queries.
	 */
	matchScore: number
}

/** GET /players/similar?query=... response payload. */
export interface SimilarPlayersResult {
	query: string
	/** The player name the query was interpreted as. */
	playerName: string
	/** The catalogue player every entry in `players` was compared against. */
	seedPlayer: CricketPlayer
	/** Ranked by matchScore, descending. Never includes the seed player itself. */
	players: SimilarPlayer[]
	total: number
}
