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
import { getPlayerIndex } from './cricsheet'
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
const DEFAULT_RESULT_LIMIT = 20
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
	role: z.enum(ROLE_VALUES).nullable().catch(null),
	competition: z.enum(COMPETITION_VALUES).nullable().catch(null),
	team: z.string().trim().min(1).max(100).nullable().catch(null),
	maxPriceLakh: z.number().positive().nullable().catch(null),
	minPriceLakh: z.number().positive().nullable().catch(null),
	minImpactScore: z.number().min(0).max(100).nullable().catch(null),
	minMatches: z.number().int().min(0).nullable().catch(null),
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
		sortBy: { type: 'string', enum: [...SORT_VALUES] },
		limit: { type: ['integer', 'null'] },
		interpretation: { type: 'string' }
	},
	required: [
		'role',
		'competition',
		'team',
		'maxPriceLakh',
		'minPriceLakh',
		'minImpactScore',
		'minMatches',
		'sortBy',
		'limit',
		'interpretation'
	]
}

const SYSTEM_PROMPT = `You turn a cricket scout's free-text player search into structured filter criteria. You never see the actual player data — only the search text.

Fields available on every player: role ("batter" | "bowler" | "allrounder"), competition ("ipl" | "smat" — Syed Mushtaq Ali Trophy, India's domestic T20), the teams/franchises they've played for, matches played, an impactScore from 0-100 (an overall scouting quality score — higher is better), and estimatedPriceRange (an auction-value band in Indian lakhs; 1 crore = 100 lakh).

Rules:
1. Only set a field when the query actually implies it. Leave everything else null.
2. Budget language ("under 10 crore", "within 50 lakh", "cheap", "expensive") maps to maxPriceLakh/minPriceLakh, converting crore to lakh yourself (10 crore = 1000).
3. "Best"/"top"/"most impactful" with no other quality signal means sortBy "impactScore". "Cheapest"/"budget" means sortBy "priceAsc". "Youngest"/"uncapped"/"emerging" means sortBy "youngest".
4. There is NO per-match-phase stat available (no separate powerplay/middle-overs/death-overs number). If the query names a phase (powerplay, death overs, middle overs, chase), do NOT invent a field for it — just set role/sortBy from the rest of the query, and say so plainly in interpretation, e.g. "Showing batters ranked by overall impact score — a powerplay-specific breakdown isn't tracked separately yet."
5. interpretation is always a single plain sentence restating what will actually be shown, written for the person who typed the query.
6. If the query names a specific team or franchise, put it in team (a substring is fine, e.g. "Bengaluru" for "Royal Challengers Bengaluru").`

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
		role: null,
		competition: null,
		team: null,
		maxPriceLakh: null,
		minPriceLakh: null,
		minImpactScore: null,
		minMatches: null,
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

function matchesCriteria(
	player: CricketPlayer,
	criteria: PlayerSearchCriteria
): boolean {
	if (criteria.role && player.role !== criteria.role) return false
	if (criteria.competition && player.competition !== criteria.competition) {
		return false
	}
	if (
		criteria.team &&
		!player.teams.some((team) =>
			team.toLowerCase().includes((criteria.team as string).toLowerCase())
		)
	) {
		return false
	}
	if (
		criteria.maxPriceLakh !== null &&
		player.estimatedPriceRange.minLakh > criteria.maxPriceLakh
	) {
		return false
	}
	if (
		criteria.minPriceLakh !== null &&
		player.estimatedPriceRange.maxLakh < criteria.minPriceLakh
	) {
		return false
	}
	if (
		criteria.minImpactScore !== null &&
		player.impactScore < criteria.minImpactScore
	) {
		return false
	}
	if (criteria.minMatches !== null && player.matches < criteria.minMatches) {
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

function applySearchCriteria(
	players: CricketPlayer[],
	criteria: PlayerSearchCriteria
): CricketPlayer[] {
	const limit = criteria.limit ?? DEFAULT_RESULT_LIMIT
	return players
		.filter((player) => matchesCriteria(player, criteria))
		.sort(compareBySortOrder(criteria.sortBy))
		.slice(0, limit)
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

	const [criteria, allPlayers] = await Promise.all([
		parseSearchQuery(query),
		getPlayerIndex()
	])

	const players = applySearchCriteria(allPlayers, criteria)

	return {
		query,
		interpretation: criteria.interpretation,
		criteria,
		players,
		total: players.length
	}
}
