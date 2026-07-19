// Domain types for the Cricsheet-backed cricket player catalogue
// (../services/cricsheet.service.ts). Deliberately separate from ./index.ts, which
// models the unrelated readiness/similarity demo dataset loaded from store.ts.
//
// Scope: IPL and the Syed Mushtaq Ali Trophy only (docs/02-sections-detailed.md §1).
// Ranji Trophy and Vijay Hazare Trophy are not published by Cricsheet at all, so
// they're out of scope until another match-data source is wired in. India's
// international archive is still fetched internally by the service, purely to confirm
// nationality — a player never appears in this list unless they've actually played
// IPL and/or the Syed Mushtaq Ali Trophy.
//
// name, battingHand, bowlingStyle, age and imageUrl are not available from Cricsheet at
// all — see ../services/playerProfiles.ts, which cross-references Wikidata/Wikipedia
// to fill in what it can. Coverage is partial (obscure domestic-only players usually
// have no Wikidata entry) and every one of these fields stays null when unmatched.
// readiness and expectedPriceLakh belonged to docs/02 §4's demo readiness dial, which
// doesn't apply to this catalogue, and were dropped rather than left permanently null.
// tags is kept as a forward-looking extension point — currently always empty; see the
// field's own doc comment.

/** Coarse role bucket used to normalize a player's stats against their peers. */
export type PlayerRole = 'batter' | 'bowler' | 'allrounder'

/** The two domestic competitions currently ingested. */
export type DomesticCompetition = 'ipl' | 'smat'

/** A player's age expressed as whole years plus the remaining days. */
export interface PlayerAge {
	years: number
	days: number
}

/** An auction-score-derived price band (see scoring.ts) — the current bid tier, not a guarantee. */
export interface EstimatedPriceRange {
	minLakh: number
	maxLakh: number
	label: string
}

/**
 * An Indian IPL and/or Syed Mushtaq Ali Trophy cricketer, aggregated from Cricsheet
 * match data.
 */
export interface CricketPlayer {
	/**
	 * Cricsheet registry identifier (an 8-character hex string, stable across every
	 * match in the dataset). Falls back to the raw player name for the rare match
	 * predating registry coverage, where no identifier is published.
	 */
	id: string
	/**
	 * The player's full name when a Wikidata/Wikipedia match was found (see
	 * ../services/playerProfiles.ts); otherwise Cricsheet's own display name, which is
	 * commonly abbreviated (e.g. `"V Kohli"`).
	 */
	name: string
	/**
	 * Batter/bowler/all-rounder, classified from aggregate IPL + Syed Mushtaq Ali
	 * Trophy batting and bowling innings/runs/wickets. See `classifyRole` in
	 * cricsheet.service.ts.
	 */
	role: PlayerRole
	/** From Wikipedia's infobox via ../services/playerProfiles.ts. Null when unmatched. */
	battingHand: 'right' | 'left' | null
	/** From Wikipedia's infobox via ../services/playerProfiles.ts (freeform, e.g. `"Right-arm medium"`). Null when unmatched. */
	bowlingStyle: string | null
	/** From Wikidata's date-of-birth claim via ../services/playerProfiles.ts. Null when unmatched. */
	age: PlayerAge | null
	/**
	 * A Wikimedia Commons photo URL via ../services/playerProfiles.ts. Null when
	 * unmatched. Commons images carry their own (usually CC-BY-SA) license — attribute
	 * per-image if this is ever surfaced to end users.
	 */
	imageUrl: string | null
	/** `"ipl"` if the player has ever played IPL, otherwise `"smat"`. Purely a display/eligibility tag — see `matches` for the scope actually used to score the player. */
	competition: DomesticCompetition
	/**
	 * Matches counted toward `impactScore`. IPL-only when the player has a substantial
	 * IPL career; otherwise IPL + Syed Mushtaq Ali Trophy combined, so a player who
	 * hasn't played much IPL is still scored on their real body of work rather than a
	 * handful of cameo appearances. See `resolveScoringTotals` in cricsheet.ts.
	 */
	matches: number
	/** Innings counted toward `impactScore`, in the same scope as `matches` — one entry per (match, innings) the player batted and/or bowled in. */
	innings: number
	/**
	 * 0-100 scouting score: 40% career performance + 35% recent form (last 5 innings)
	 * + 15% match impact + 10% opponent/venue difficulty. See ../services/scoring.ts
	 * for the full formula and every proxy used for data Cricsheet doesn't publish.
	 */
	impactScore: number
	/** Auction-score-derived price band (../services/scoring.ts) — a market estimate, not a historical price. */
	estimatedPriceRange: EstimatedPriceRange
	/** Scouting tags (e.g. role/form callouts). Always `[]` for now — nothing populates this yet. */
	tags: string[]
	/** Every IPL franchise and/or Syed Mushtaq Ali Trophy state/zone side represented. */
	teams: string[]
	/** Team in the most recent IPL match they played, or `null` if never played IPL. */
	currentIPLTeam: string | null
}

/** Filters accepted by `listCricketPlayers`. */
export interface CricketPlayersFilter {
	/** Case-insensitive substring match against the player's name. */
	name?: string
	/** Case-insensitive substring match against any team the player has represented. */
	team?: string
	competition?: DomesticCompetition
	/** 1-indexed page number. */
	page: number
	/** Page size, capped by the caller (the controller caps it at 100). */
	limit: number
}

/** Paginated result returned by `listCricketPlayers`. */
export interface CricketPlayersListData {
	players: CricketPlayer[]
	page: number
	limit: number
	total: number
	totalPages: number
}
