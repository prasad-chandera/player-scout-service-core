// Shared cricket player name matching, used by both playerSearch.ts (GET /players/search)
// and similarPlayers.ts (GET /players/similar) to resolve a free-text name onto a
// catalogue player.
//
// Deliberately never a raw substring test for whole-name resolution: that previously let
// a search for "Virat Kohli" resolve to an unrelated player named "T Kohli", because the
// characters "t kohli" happen to appear inside "virat kohli" (`"virat kohli".includes("t
// kohli")` is true) even though they aren't the same person. namesMatch/findPlayerByName
// stay surname-exact, given-name-initials-compatible for that reason — they're used where
// a single confident identity is required (e.g. resolving the seed player for
// /players/similar).
//
// scoreNameMatch below is the graded counterpart for free-text *search*, where a query is
// often a deliberate fragment rather than a full name (a first name, a nickname, a typo).
// It always tries the strict whole-name match first, so an exact identity still outranks
// a fragment guess — but unlike namesMatch it never collapses to all-or-nothing, so e.g.
// "sachin" surfaces both "Sachin Tendulkar" (exact first-name token) and "Sachin Baby"
// (same), instead of zero results.

import type { CricketPlayer } from '../types/players'

function tokenize(name: string): string[] {
	return name
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
}

/**
 * Reduces a block of given-name tokens to their initials. A short (<=3 character) token
 * is treated as an initials blob already, not a short real name — Cricsheet commonly
 * abbreviates two given names into one token (e.g. "MS" for "Mahendra Singh" in "MS
 * Dhoni"), and splitting it into individual letters lets it line up against a fuller
 * enriched name's per-word initials ("Mahendra Singh" -> "m" + "s" -> "ms").
 */
function initialsOf(givenNameTokens: string[]): string {
	return givenNameTokens
		.map((token) => (token.length <= 3 ? token : token[0]))
		.join('')
}

/**
 * Whole-word name equivalence for two Cricsheet-style names, robust to Cricsheet's own
 * "V Kohli"/"MS Dhoni"-style abbreviation vs. Wikidata's fuller enrichment ("Virat
 * Kohli", "Mahendra Singh Dhoni" — see ./playerProfiles.ts). See the file header for why
 * this is never a raw substring test.
 */
export function namesMatch(a: string, b: string): boolean {
	const tokensA = tokenize(a)
	const tokensB = tokenize(b)
	if (tokensA.length === 0 || tokensB.length === 0) return false

	const surnameA = tokensA[tokensA.length - 1]
	const surnameB = tokensB[tokensB.length - 1]
	if (surnameA !== surnameB) return false

	const givenA = initialsOf(tokensA.slice(0, -1))
	const givenB = initialsOf(tokensB.slice(0, -1))
	// A surname-only name on either side (e.g. just "Kohli") can't disagree on a given
	// name it never specified, so the surname match alone is enough.
	if (!givenA || !givenB) return true
	return givenA.startsWith(givenB) || givenB.startsWith(givenA)
}

/**
 * Every catalogue player `name` plausibly refers to: an exact case-insensitive match
 * first (and only that, if one exists), otherwise every whole-word name match (see
 * namesMatch). Returns them in `players`' own order, so a caller sorted by impactScore
 * descending (as getPlayerIndex returns it) gets the most notable match first.
 */
export function findPlayersByName(
	name: string,
	players: CricketPlayer[]
): CricketPlayer[] {
	const normalized = name.trim().toLowerCase()
	const exact = players.filter(
		(player) => player.name.toLowerCase() === normalized
	)
	if (exact.length > 0) return exact

	return players.filter((player) => namesMatch(player.name, name))
}

/** The single best match for `name` — the first result findPlayersByName would return. */
export function findPlayerByName(
	name: string,
	players: CricketPlayer[]
): CricketPlayer | undefined {
	return findPlayersByName(name, players)[0]
}

/** Graded match tiers scoreNameMatch can return — see its own doc comment for what each means. */
const EXACT_MATCH_SCORE = 100
const WHOLE_NAME_MATCH_SCORE = 92
const TOKEN_EXACT_MATCH_SCORE = 78
const TOKEN_PREFIX_MATCH_SCORE = 60
const TOKEN_FUZZY_MATCH_SCORE = 45
/** Below this length a prefix match is mostly noise (e.g. "s" is a prefix of almost anything). */
const MIN_PREFIX_TOKEN_LENGTH = 3
/** Below this length a single-edit "fuzzy" match is mostly noise (e.g. "ms" ~ "ns"). */
const MIN_FUZZY_TOKEN_LENGTH = 4

/** Classic edit-distance DP — fine to run per token pair since every token here is a short (~3-15 char) name fragment. */
function levenshteinDistance(a: string, b: string): number {
	const rows = a.length + 1
	const cols = b.length + 1
	const distances: number[][] = Array.from({ length: rows }, () =>
		new Array<number>(cols).fill(0)
	)
	for (let i = 0; i < rows; i++) distances[i][0] = i
	for (let j = 0; j < cols; j++) distances[0][j] = j
	for (let i = 1; i < rows; i++) {
		for (let j = 1; j < cols; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1
			distances[i][j] = Math.min(
				distances[i - 1][j] + 1,
				distances[i][j - 1] + 1,
				distances[i - 1][j - 1] + cost
			)
		}
	}
	return distances[rows - 1][cols - 1]
}

/**
 * 0-100 how well free text `query` matches `candidate`. Written for player names but
 * equally usable against any other short label (a team, a scouting tag) — every tier
 * below the whole-name tier is plain tokenized text matching with no name-specific
 * assumptions. Graded rather than boolean so a search can surface both an exact identity
 * and partial/fuzzy fragments in one ranked list instead of an exact-or-nothing result:
 *
 *   100 — exact case-insensitive match
 *    92 — whole-name equivalence (see namesMatch) — surname-exact, initials-compatible
 *    78 — some query token exactly equals some candidate token (e.g. "sachin" == "sachin")
 *    60 — some query token is a prefix of a candidate token or vice versa (min length 3)
 *    45 — some query token is a single-edit typo of a candidate token (min length 4)
 *     0 — no relationship found
 */
export function scoreNameMatch(query: string, candidate: string): number {
	const normalizedQuery = query.trim().toLowerCase()
	const normalizedCandidate = candidate.trim().toLowerCase()
	if (!normalizedQuery || !normalizedCandidate) return 0
	if (normalizedQuery === normalizedCandidate) return EXACT_MATCH_SCORE
	if (namesMatch(candidate, query)) return WHOLE_NAME_MATCH_SCORE

	const queryTokens = tokenize(query)
	const candidateTokens = tokenize(candidate)
	let best = 0

	for (const queryToken of queryTokens) {
		for (const candidateToken of candidateTokens) {
			if (queryToken === candidateToken) {
				best = Math.max(best, TOKEN_EXACT_MATCH_SCORE)
				continue
			}
			if (
				queryToken.length >= MIN_PREFIX_TOKEN_LENGTH &&
				candidateToken.length >= MIN_PREFIX_TOKEN_LENGTH &&
				(candidateToken.startsWith(queryToken) ||
					queryToken.startsWith(candidateToken))
			) {
				best = Math.max(best, TOKEN_PREFIX_MATCH_SCORE)
				continue
			}
			if (
				queryToken.length >= MIN_FUZZY_TOKEN_LENGTH &&
				candidateToken.length >= MIN_FUZZY_TOKEN_LENGTH &&
				levenshteinDistance(queryToken, candidateToken) <= 1
			) {
				best = Math.max(best, TOKEN_FUZZY_MATCH_SCORE)
			}
		}
	}

	return best
}
