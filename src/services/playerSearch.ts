// Natural-language player search (GET /api/players/search?q=...): "best impactful
// batter in powerplay", "find me the best all-rounder within 10 crore budget", etc.
//
// The LLM's only job is turning that free text into PlayerSearchCriteria — a small
// prompt in, a small structured JSON object out. It never sees the player catalogue
// (~1500 players) at all, which keeps the call fast and cheap. Applying those criteria
// is then plain deterministic filtering/sorting over the already-cached, already-scored
// player list from cricsheet.ts — the same near-zero cost as the /api/players endpoint.
//
// LLM choice: Gemini's free tier (Google AI Studio API key), not the Anthropic client
// already used for scouting-report explanations (claude.ts) — that one is billed
// per-token, and this feature was explicitly asked to use a free model. Gemini's Flash
// (and Flash-Lite) models are also genuinely fast, which is the other half of the ask.
//
// Coverage gap this is upfront about: some queries name a match phase ("in powerplay",
// "at the death") that CricketPlayer doesn't currently expose a dedicated stat for.
// Rather than the LLM inventing a number, the system prompt tells it to fall back to
// overall impactScore for that role and say so plainly in `interpretation` — the UI
// should show that sentence rather than imply a phase-specific ranking that isn't real.

import { GoogleGenAI } from '@google/genai'
import { z } from 'zod/v4'
import config from '../configs/config'
import {
	getAllPlayerDerivedDetails,
	getPlayerIndex,
	type PlayerDerivedDetails
} from './cricsheet'
import { scoreNameMatch } from './playerNameMatch'
import {
	findSimilarPlayers,
	PlayerNameNotRecognizedError,
	SimilarSeedPlayerNotFoundError
} from './similarPlayers'
import type { CricketPlayer } from '../types/players'
import type {
	PlayerSearchCriteria,
	PlayerSearchResult,
	PlayerSearchSort
} from '../types/playerSearch'

// gemini-2.5-flash-lite is restricted to accounts that already had access to it before
// its retirement ("no longer available to new users") — gemini-3.1-flash-lite is the
// current fast/cheap tier for everyone else, per ai.google.dev/gemini-api/docs/models.
export const MODEL: string = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite'
export const hasKey = (): boolean =>
	Boolean(config.aiConfig.GOOGLE_GENAI_API_KEY)

// Gemini rejects a shorter deadline outright ("Manually set deadline 8s is too short.
// Minimum allowed deadline is 10s.") rather than just enforcing its own floor, so this
// can't be tuned below 10s.
const REQUEST_TIMEOUT_MS = 12000
/** Hard cap on results returned, regardless of what limit the query seems to imply — a
 *  focused most-relevant-first list beats a long, weakly-ranked one. */
const TOP_RESULT_LIMIT = 10
const MAX_RESULT_LIMIT = 100
/** Repeat/near-repeat searches (a user retrying, a UI re-querying) skip the LLM entirely. */
const QUERY_CACHE_TTL_MS = 60 * 60 * 1000

let client: GoogleGenAI | null = null
function gemini(): GoogleGenAI {
	// Constructed lazily so the server boots fine with no key at all (mirrors claude.ts).
	if (!client)
		client = new GoogleGenAI({ apiKey: config.aiConfig.GOOGLE_GENAI_API_KEY })
	return client
}

const ROLE_VALUES = ['batter', 'bowler', 'allrounder'] as const
const COMPETITION_VALUES = ['ipl', 'smat'] as const
const SORT_VALUES = [
	'impactScore',
	'matches',
	'priceAsc',
	'priceDesc',
	'youngest'
] as const

/** Validates/sanitizes the LLM's JSON output — never trust a model's structured output blindly. */
const searchCriteriaSchema = z.object({
	playerName: z.string().trim().min(1).max(100).nullable().catch(null),
	similarTo: z.string().trim().min(1).max(100).nullable().catch(null),
	role: z.enum(ROLE_VALUES).nullable().catch(null),
	competition: z.enum(COMPETITION_VALUES).nullable().catch(null),
	team: z.string().trim().min(1).max(100).nullable().catch(null),
	maxPriceLakh: z.number().positive().nullable().catch(null),
	minPriceLakh: z.number().positive().nullable().catch(null),
	minImpactScore: z.number().min(0).max(100).nullable().catch(null),
	minMatches: z.number().int().min(0).nullable().catch(null),
	keywords: z.array(z.string().trim().min(1).max(40)).max(5).catch([]),
	sortBy: z.enum(SORT_VALUES).catch('impactScore'),
	limit: z
		.number()
		.int()
		.positive()
		.max(MAX_RESULT_LIMIT)
		.nullable()
		.catch(null),
	interpretation: z.string().trim().min(1).max(300).catch('')
})

/** Gemini's `responseJsonSchema` — a standard JSON Schema object, kept in lockstep with searchCriteriaSchema above. */
const RESPONSE_JSON_SCHEMA = {
	type: 'object',
	properties: {
		playerName: { type: ['string', 'null'] },
		similarTo: { type: ['string', 'null'] },
		role: { type: ['string', 'null'], enum: [...ROLE_VALUES, null] },
		competition: {
			type: ['string', 'null'],
			enum: [...COMPETITION_VALUES, null]
		},
		team: { type: ['string', 'null'] },
		maxPriceLakh: { type: ['number', 'null'] },
		minPriceLakh: { type: ['number', 'null'] },
		minImpactScore: { type: ['number', 'null'] },
		minMatches: { type: ['integer', 'null'] },
		keywords: { type: 'array', items: { type: 'string' } },
		sortBy: { type: 'string', enum: [...SORT_VALUES] },
		limit: { type: ['integer', 'null'] },
		interpretation: { type: 'string' }
	},
	required: [
		'playerName',
		'similarTo',
		'role',
		'competition',
		'team',
		'maxPriceLakh',
		'minPriceLakh',
		'minImpactScore',
		'minMatches',
		'keywords',
		'sortBy',
		'limit',
		'interpretation'
	]
}

const SYSTEM_PROMPT = `You turn a cricket scout's free-text player search into structured filter criteria. You never see the actual player data — only the search text.

Fields available on every player: name, role ("batter" | "bowler" | "allrounder"), competition ("ipl" | "smat" — Syed Mushtaq Ali Trophy, India's domestic T20), the teams/franchises they've played for, matches played, an impactScore from 0-100 (an overall scouting quality score — higher is better), estimatedPriceRange (an auction-value band in Indian lakhs; 1 crore = 100 lakh), and a small set of scouting tags (short callouts like "Elite death bowling" or "Proven at IPL level" — only some players have any).

Rules:
1. If the query asks for OTHER players who compare statistically to a named player — phrasing like "players like X", "who plays like X", "similar to X", "players comparable to X", "someone like X" — set similarTo to that player's name exactly as written (do not correct spelling, expand initials, or guess a full name) and leave playerName null. This is a different question from rule 2 below: "players like Sachin Tendulkar" wants OTHER players whose career stats compare to his, not Sachin Tendulkar himself. interpretation should restate that, e.g. "Showing players with a career profile similar to Sachin Tendulkar."
2. Else if the query names one specific player directly (e.g. just "Virat Kohli", "MS Dhoni", "how good is Bumrah?", "stats for Sachin Tendulkar", or just a first name/fragment like "sachin") rather than asking for players by role/stat/budget or for players similar to them, set playerName to that text exactly as written — do not correct spelling, expand initials, or guess a full name — and leave role/competition/team/price/impact/matches null unless the query also states an explicit extra qualifier alongside the name. interpretation should simply restate that you're showing that player, e.g. "Showing Virat Kohli." Otherwise leave both playerName and similarTo null.
3. For every other field, only set it when the query actually implies it. Leave everything else null.
4. Budget language ("under 10 crore", "within 50 lakh", "cheap", "expensive") maps to maxPriceLakh/minPriceLakh, converting crore to lakh yourself (10 crore = 1000).
5. "Best"/"top"/"most impactful" with no other quality signal means sortBy "impactScore". "Cheapest"/"budget" means sortBy "priceAsc". "Youngest"/"uncapped"/"emerging" means sortBy "youngest".
6. There is NO per-match-phase stat available (no separate powerplay/middle-overs/death-overs number). If the query names a phase (powerplay, death overs, middle overs, chase), do NOT invent a field for it — just set role/sortBy from the rest of the query, and say so plainly in interpretation, e.g. "Showing batters ranked by overall impact score — a powerplay-specific breakdown isn't tracked separately yet."
7. interpretation is always a single plain sentence restating what will actually be shown, written for the person who typed the query.
8. If the query names a specific team or franchise (and no specific player), put it in team (a substring is fine, e.g. "Bengaluru" for "Royal Challengers Bengaluru").
9. keywords is for short descriptive/style words the query uses that don't map to any field above (e.g. "death bowler" -> ["death", "bowler"], "finisher" -> ["finisher"], "proven performer" -> ["proven"]) — lowercase, each 1-2 words, at most 5. Leave it [] when nothing extra is being described.`

interface QueryCacheEntry {
	criteria: PlayerSearchCriteria
	expiresAt: number
}

const queryCache = new Map<string, QueryCacheEntry>()

function normalizeQuery(query: string): string {
	return query.trim().toLowerCase().replace(/\s+/g, ' ')
}

function fallbackCriteria(interpretation: string): PlayerSearchCriteria {
	return {
		playerName: null,
		similarTo: null,
		role: null,
		competition: null,
		team: null,
		maxPriceLakh: null,
		minPriceLakh: null,
		minImpactScore: null,
		minMatches: null,
		keywords: [],
		sortBy: 'impactScore',
		limit: null,
		interpretation
	}
}

/** Calls Gemini to turn `query` into PlayerSearchCriteria, with a short cache for repeat searches. */
async function parseSearchQuery(query: string): Promise<PlayerSearchCriteria> {
	const cacheKey = normalizeQuery(query)
	const cached = queryCache.get(cacheKey)
	if (cached && cached.expiresAt > Date.now()) return cached.criteria

	const response = await gemini().models.generateContent({
		model: MODEL,
		contents: query,
		config: {
			systemInstruction: SYSTEM_PROMPT,
			responseMimeType: 'application/json',
			responseJsonSchema: RESPONSE_JSON_SCHEMA,
			temperature: 0,
			httpOptions: { timeout: REQUEST_TIMEOUT_MS }
		}
	})

	const raw: unknown = JSON.parse(response.text ?? '{}')
	const parsed = searchCriteriaSchema.safeParse(raw)
	const criteria: PlayerSearchCriteria = parsed.success
		? parsed.data
		: fallbackCriteria(
				"Couldn't fully interpret that search — showing top players by impact score."
			)

	queryCache.set(cacheKey, {
		criteria,
		expiresAt: Date.now() + QUERY_CACHE_TTL_MS
	})
	return criteria
}

/**
 * Hard categorical exclusions only — role and competition are discrete facts a query
 * explicitly names, not something a "close enough" player should sneak past. An
 * allrounder is the one exception on role: they genuinely do both jobs, so a request for
 * "bowlers" or "batters" still lets them through (ranked below an exact-role match by
 * computeCriteriaRelevance below). Every other criterion (team/price/impact/matches/
 * keywords) is a matter of degree, not a fact a player either has or doesn't, so those are
 * scored rather than filtered — see computeCriteriaRelevance. Splitting it this way is
 * what lets an over-narrow query (e.g. a budget nobody quite fits) still return the
 * closest available players instead of an empty list.
 */
function matchesCriteria(
	player: CricketPlayer,
	criteria: PlayerSearchCriteria
): boolean {
	if (
		criteria.role &&
		player.role !== criteria.role &&
		player.role !== 'allrounder'
	) {
		return false
	}
	if (criteria.competition && player.competition !== criteria.competition) {
		return false
	}
	return true
}

function compareBySortOrder(
	sortBy: PlayerSearchSort
): (a: CricketPlayer, b: CricketPlayer) => number {
	switch (sortBy) {
		case 'matches':
			return (a, b) => b.matches - a.matches
		case 'priceAsc':
			return (a, b) =>
				a.estimatedPriceRange.minLakh - b.estimatedPriceRange.minLakh
		case 'priceDesc':
			return (a, b) =>
				b.estimatedPriceRange.maxLakh - a.estimatedPriceRange.maxLakh
		case 'youngest':
			// Age is only known for players Wikidata/Wikipedia matched (see
			// playerProfiles.ts); push unknown ages to the back rather than let them
			// sort as if they were the oldest or youngest.
			return (a, b) => {
				if (!a.age && !b.age) return 0
				if (!a.age) return 1
				if (!b.age) return -1
				return a.age.years - b.age.years || a.age.days - b.age.days
			}
		case 'impactScore':
		default:
			return (a, b) => b.impactScore - a.impactScore
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value))
}

/**
 * How well `player` satisfies the graded (non-categorical) parts of `criteria`, 0-100.
 * matchesCriteria has already enforced role/competition as hard pass/fail facts — this
 * scores every other criterion (team, price, impact, matches, keywords) by degree instead
 * of pass/fail, so a player who's close on one axis still ranks reasonably instead of
 * being excluded outright, and the top of the list is genuinely the closest match to the
 * query rather than just whoever has the highest raw impactScore. Same 0-100 scoring
 * convention matchScore uses in similarPlayers.ts, applied to query fit instead of
 * player-to-player similarity.
 */
function computeCriteriaRelevance(
	player: CricketPlayer,
	criteria: PlayerSearchCriteria,
	tags: string[]
): number {
	let scoreSum = 0
	let signals = 0

	if (criteria.role) {
		scoreSum += player.role === criteria.role ? 100 : 70
		signals += 1
	}

	if (criteria.team) {
		const team = criteria.team.toLowerCase()
		const exactTeam = player.teams.some((t) => t.toLowerCase() === team)
		const partialTeam = player.teams.some((t) => t.toLowerCase().includes(team))
		scoreSum += exactTeam ? 100 : partialTeam ? 70 : 20
		signals += 1
	}

	if (criteria.maxPriceLakh !== null || criteria.minPriceLakh !== null) {
		const overMax =
			criteria.maxPriceLakh !== null
				? Math.max(
						0,
						player.estimatedPriceRange.minLakh - criteria.maxPriceLakh
					)
				: 0
		const underMin =
			criteria.minPriceLakh !== null
				? Math.max(
						0,
						criteria.minPriceLakh - player.estimatedPriceRange.maxLakh
					)
				: 0
		const referenceBudget = criteria.maxPriceLakh ?? criteria.minPriceLakh ?? 1
		const overshootRatio = (overMax + underMin) / referenceBudget
		scoreSum += clamp(100 - overshootRatio * 100, 10, 100)
		signals += 1
	}

	if (criteria.minImpactScore !== null) {
		const margin = player.impactScore - criteria.minImpactScore
		scoreSum += clamp(70 + margin, 10, 100)
		signals += 1
	}

	if (criteria.minMatches !== null) {
		const margin = player.matches - criteria.minMatches
		scoreSum += clamp(70 + margin / 5, 10, 100)
		signals += 1
	}

	if (criteria.keywords.length > 0) {
		const keywordScore =
			tags.length > 0
				? Math.max(
						...criteria.keywords.flatMap((keyword) =>
							tags.map((tag) => scoreNameMatch(keyword, tag))
						)
					)
				: 0
		scoreSum += keywordScore
		signals += 1
	}

	// No graded criteria at all (e.g. just role/competition, or an empty query) — fit is
	// wide open, so quality alone (below) decides the ranking.
	const fitScore = signals > 0 ? scoreSum / signals : 100

	// Blend fit with overall quality so, among equally-fitting players, the stronger
	// scout prospect still floats to the top.
	return fitScore * 0.7 + player.impactScore * 0.3
}

function applySearchCriteria(
	players: CricketPlayer[],
	criteria: PlayerSearchCriteria,
	derivedById: Map<string, PlayerDerivedDetails>
): CricketPlayer[] {
	const limit = Math.min(criteria.limit ?? TOP_RESULT_LIMIT, TOP_RESULT_LIMIT)
	const matched = players.filter((player) => matchesCriteria(player, criteria))
	// 'impactScore' is both the explicit "best/top" ask and the default fallback sort —
	// in both cases, relevance to the actual query beats a single raw stat. The other
	// sort orders (priceAsc/priceDesc/youngest/matches) are literal asks and stay literal.
	const sorted =
		criteria.sortBy === 'impactScore'
			? matched.sort(
					(a, b) =>
						computeCriteriaRelevance(
							b,
							criteria,
							derivedById.get(b.id)?.tags ?? []
						) -
						computeCriteriaRelevance(
							a,
							criteria,
							derivedById.get(a.id)?.tags ?? []
						)
				)
			: matched.sort(compareBySortOrder(criteria.sortBy))
	return sorted.slice(0, limit)
}

/**
 * Parses `query` via Gemini and returns the matching players from the existing
 * Cricsheet-backed catalogue. Throws if GOOGLE_GENAI_API_KEY isn't configured or the
 * Gemini call fails outright (timeout, network, invalid key) — the controller is
 * responsible for turning that into a clear API error, same as claude.ts's callers do.
 */
export async function searchPlayers(
	query: string
): Promise<PlayerSearchResult> {
	if (!hasKey()) {
		throw new Error(
			'Player search needs GOOGLE_GENAI_API_KEY configured (Gemini free tier) — see src/services/playerSearch.ts.'
		)
	}

	const [criteria, allPlayers, derivedById] = await Promise.all([
		parseSearchQuery(query),
		getPlayerIndex(),
		getAllPlayerDerivedDetails()
	])

	// "Players like X" / "similar to X" asks for OTHER players with a comparable career
	// profile, not X themselves — a fundamentally different question from a name lookup
	// (see the playerName branch below). Delegated wholesale to the existing stat-
	// similarity engine (findSimilarPlayers in similarPlayers.ts) rather than
	// reimplementing skill-radar/impact-score comparison here — same query text, since
	// that engine already parses "players similar to X"-style phrasing itself.
	if (criteria.similarTo) {
		const limit = Math.min(criteria.limit ?? TOP_RESULT_LIMIT, TOP_RESULT_LIMIT)
		try {
			const similar = await findSimilarPlayers(query, limit)
			return {
				query,
				interpretation:
					criteria.interpretation ||
					`Showing players with a career profile similar to ${similar.playerName}.`,
				criteria,
				players: similar.players,
				total: similar.total
			}
		} catch (error) {
			if (
				error instanceof PlayerNameNotRecognizedError ||
				error instanceof SimilarSeedPlayerNotFoundError
			) {
				return {
					query,
					interpretation: error.message,
					criteria,
					players: [],
					total: 0
				}
			}
			throw error
		}
	}

	// A query naming a specific player (e.g. "Virat Kohli", or just a fragment like
	// "sachin") is resolved against the catalogue by name first, rather than falling
	// through to the generic role/price/etc. filters — which, left all null, would
	// otherwise match every player and silently return the top-impact list instead of the
	// player(s) asked for. scoreNameMatch is graded (see ./playerNameMatch.ts), so this
	// returns an exact identity match on top and ranks partial/fuzzy matches below it,
	// instead of an exact-or-nothing result.
	if (criteria.playerName) {
		const limit = Math.min(criteria.limit ?? TOP_RESULT_LIMIT, TOP_RESULT_LIMIT)
		const players = allPlayers
			.filter((player) => matchesCriteria(player, criteria))
			.map((player) => ({
				player,
				score: scoreNameMatch(criteria.playerName as string, player.name)
			}))
			.filter(({ score }) => score > 0)
			.sort(
				(a, b) =>
					b.score - a.score || b.player.impactScore - a.player.impactScore
			)
			.slice(0, limit)
			.map(({ player }) => player)

		return {
			query,
			interpretation:
				players.length > 0
					? criteria.interpretation
					: `No player found matching "${criteria.playerName}".`,
			criteria,
			players,
			total: players.length
		}
	}

	const players = applySearchCriteria(allPlayers, criteria, derivedById)

	return {
		query,
		interpretation: criteria.interpretation,
		criteria,
		players,
		total: players.length
	}
}
