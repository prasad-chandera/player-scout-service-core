// AI-assisted "similar players" search (GET /api/players/similar?query=...): "players
// similar to Virat Kohli", "who plays like Bumrah", etc.
//
// Same split of responsibilities as playerSearch.ts: the LLM's only job is pulling the
// player name out of the free-text query — a small prompt in, a small JSON object out.
// It never sees the player catalogue (~1500 players). Resolving that name to a catalogue
// player and ranking every other player against them by matchScore is then plain
// deterministic math over the already-cached, already-scored catalogue from cricsheet.ts.
//
// matchScore is two-stage:
//   1. Impact gate: a candidate whose overall impactScore differs from the seed
//      player's by more than IMPACT_SCORE_GATE_THRESHOLD is excluded outright, before
//      any skill comparison. A skill-shape match between a star and a fringe player
//      isn't a genuine "similar player" recommendation for a scout — "similar" has to
//      mean comparable overall quality AND comparable skill shape, not skill shape
//      alone. impactScore is deliberately kept out of the distance calc below: folding
//      it in as just another dimension would let a big quality gap get averaged away
//      by close skill-radar axes instead of ruling the candidate out.
//   2. Skill-shape similarity: among players that pass the gate, each is reduced to a
//      5-dimension feature vector (the skill-radar axes, normalized to 0-1) and
//      compared by normalized Euclidean distance, then scaled down when the two
//      players' roles don't match. Distance (not cosine) is used deliberately —
//      ../services/similarity.ts (the older, unwired demo dataset's similarity engine)
//      documents how raw cosine saturates near 100% once every vector lives in the same
//      positive orthant, which is exactly the shape this catalogue's feature vectors
//      have (every player is a working pro, so scores cluster). Euclidean distance
//      doesn't have that failure mode: two players who are both "good" but at different
//      absolute levels still land at a real distance apart.

import { GoogleGenAI } from '@google/genai'
import { z } from 'zod/v4'
import config from '../configs/config'
import {
	getAllPlayerDerivedDetails,
	getPlayerIndex,
	type PlayerDerivedDetails
} from './cricsheet'
import { findPlayerByName } from './playerNameMatch'
import type { CricketPlayer, PlayerRole } from '../types/players'
import type {
	SimilarPlayer,
	SimilarPlayersQueryIntent,
	SimilarPlayersResult
} from '../types/similarPlayers'

// See playerSearch.ts for why gemini-3.1-flash-lite (Gemini's free tier) rather than the
// billed Anthropic client (claude.ts).
export const MODEL: string = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite'
export const hasKey = (): boolean =>
	Boolean(config.aiConfig.GOOGLE_GENAI_API_KEY)

// Gemini enforces a 10s floor on its own deadline; see playerSearch.ts.
const REQUEST_TIMEOUT_MS = 12000
export const DEFAULT_SIMILAR_PLAYERS_LIMIT = 5
export const MAX_SIMILAR_PLAYERS_LIMIT = 20
/** Repeat/near-repeat searches (a user retrying, a UI re-querying) skip the LLM entirely. */
const QUERY_CACHE_TTL_MS = 60 * 60 * 1000

let client: GoogleGenAI | null = null
function gemini(): GoogleGenAI {
	// Constructed lazily so the server boots fine with no key at all (mirrors claude.ts/playerSearch.ts).
	if (!client)
		client = new GoogleGenAI({ apiKey: config.aiConfig.GOOGLE_GENAI_API_KEY })
	return client
}

/** Validates/sanitizes the LLM's JSON output — never trust a model's structured output blindly. */
const queryIntentSchema = z.object({
	playerName: z.string().trim().min(1).max(100).nullable().catch(null),
	interpretation: z.string().trim().min(1).max(300).catch('')
})

/** Gemini's `responseJsonSchema` — a standard JSON Schema object, kept in lockstep with queryIntentSchema above. */
const RESPONSE_JSON_SCHEMA = {
	type: 'object',
	properties: {
		playerName: { type: ['string', 'null'] },
		interpretation: { type: 'string' }
	},
	required: ['playerName', 'interpretation']
}

const SYSTEM_PROMPT = `You extract a cricket player's name from a scout's request to find players similar to someone, e.g. "players similar to Virat Kohli", "who plays like Bumrah", "find me someone comparable to MS Dhoni".

Rules:
1. playerName is the ONE specific cricket player named in the query, exactly as written — do not correct spelling, expand initials, or guess a full name.
2. Set playerName to null when the query does not name a specific player to compare against — e.g. it's unrelated to cricket scouting entirely, or it asks for players by role/stat/budget rather than "similar to <someone>".
3. interpretation is always one plain sentence: if playerName is set, restate the request (e.g. "Finding players similar to Virat Kohli"); if null, briefly say why no player name could be identified, so the user knows what to fix.`

interface QueryCacheEntry {
	intent: SimilarPlayersQueryIntent
	expiresAt: number
}

const queryCache = new Map<string, QueryCacheEntry>()

function normalizeQuery(query: string): string {
	return query.trim().toLowerCase().replace(/\s+/g, ' ')
}

function fallbackIntent(interpretation: string): SimilarPlayersQueryIntent {
	return { playerName: null, interpretation }
}

/** Calls Gemini to pull a player name out of `query`, with a short cache for repeat searches. */
async function resolveQueryIntent(
	query: string
): Promise<SimilarPlayersQueryIntent> {
	const cacheKey = normalizeQuery(query)
	const cached = queryCache.get(cacheKey)
	if (cached && cached.expiresAt > Date.now()) return cached.intent

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
	const parsed = queryIntentSchema.safeParse(raw)
	const intent: SimilarPlayersQueryIntent = parsed.success
		? parsed.data
		: fallbackIntent(
				'Couldn\'t interpret that search — please include a player\'s name, e.g. "players similar to Virat Kohli".'
			)

	queryCache.set(cacheKey, {
		intent,
		expiresAt: Date.now() + QUERY_CACHE_TTL_MS
	})
	return intent
}

/** The query named no player the catalogue could ever match — a 400, not a 404. */
export class PlayerNameNotRecognizedError extends Error {}

/** The query named a player, but no catalogue player matches that name. */
export class SimilarSeedPlayerNotFoundError extends Error {}

/** The skill-radar chart's axes are documented as 0-10 — see SkillRadarScores in ../types/playerDetails.ts. */
const SKILL_RADAR_MAX = 10

/**
 * Max allowed gap between two players' impactScore (0-100) for the candidate to be
 * considered a "similar player" at all — see the impact-gate note at the top of this
 * file. 15 points is roughly one estimatedPriceRange tier (scoring.ts's bands sit at
 * 60/70/80/90), so the gate keeps candidates within about a tier of the seed player's
 * overall quality rather than matching pure skill shape across wildly different levels.
 */
const IMPACT_SCORE_GATE_THRESHOLD = 15

/** True when `candidateImpactScore` is close enough to `seedImpactScore` to even be considered. */
function passesImpactGate(
	seedImpactScore: number,
	candidateImpactScore: number
): boolean {
	return (
		Math.abs(seedImpactScore - candidateImpactScore) <=
		IMPACT_SCORE_GATE_THRESHOLD
	)
}

/** A player reduced to a 5-dimension, 0-1 normalized feature vector for skill-shape comparison. */
export interface SimilarityFeatures {
	batting: number
	bowling: number
	fielding: number
	pressure: number
	consistency: number
}

const FEATURE_KEYS: (keyof SimilarityFeatures)[] = [
	'batting',
	'bowling',
	'fielding',
	'pressure',
	'consistency'
]

/**
 * A player with no derived details at all (should not happen — every catalogue player
 * gets one during the index build) falls back to the neutral midpoint on every skill
 * axis rather than 0, so a data gap reads as "average", not "has no skills whatsoever".
 */
function toFeatures(
	derived: PlayerDerivedDetails | undefined
): SimilarityFeatures {
	const radar = derived?.skillRadar
	const neutral = SKILL_RADAR_MAX / 2
	return {
		batting: (radar?.batting ?? neutral) / SKILL_RADAR_MAX,
		bowling: (radar?.bowling ?? neutral) / SKILL_RADAR_MAX,
		fielding: (radar?.fielding ?? neutral) / SKILL_RADAR_MAX,
		pressure: (radar?.pressure ?? neutral) / SKILL_RADAR_MAX,
		consistency: (radar?.consistency ?? neutral) / SKILL_RADAR_MAX
	}
}

/** Normalized Euclidean distance between two feature vectors, mapped to a 0-1 similarity (1 = identical). */
function statSimilarity(a: SimilarityFeatures, b: SimilarityFeatures): number {
	const sumSquares = FEATURE_KEYS.reduce((sum, key) => {
		const diff = a[key] - b[key]
		return sum + diff * diff
	}, 0)
	const distance = Math.sqrt(sumSquares / FEATURE_KEYS.length)
	return Math.max(0, 1 - distance)
}

const SAME_ROLE_FACTOR = 1
/** Either player being an all-rounder means a real skill overlap with a specialist, just not a full match. */
const ALLROUNDER_OVERLAP_FACTOR = 0.9
const DIFFERENT_ROLE_FACTOR = 0.75

function roleFactor(a: PlayerRole, b: PlayerRole): number {
	if (a === b) return SAME_ROLE_FACTOR
	if (a === 'allrounder' || b === 'allrounder') return ALLROUNDER_OVERLAP_FACTOR
	return DIFFERENT_ROLE_FACTOR
}

/**
 * 0-100 matchScore for a candidate that has already passed the impact gate: skill-shape
 * similarity scaled down by how much the two players' roles diverge.
 */
function computeMatchScore(
	seedRole: PlayerRole,
	seedFeatures: SimilarityFeatures,
	candidateRole: PlayerRole,
	candidateFeatures: SimilarityFeatures
): number {
	const similarity = statSimilarity(seedFeatures, candidateFeatures)
	const factor = roleFactor(seedRole, candidateRole)
	return Math.round(similarity * factor * 100)
}

/** The full per-axis + gate breakdown behind one pair's matchScore — see compareSimilarity. */
export interface SimilarityComparison {
	/** Identical to what this pair would score inside a GET /players/similar list — same formula, same inputs. */
	matchScore: number
	/** Whether this pair would actually appear together in a GET /players/similar list (see the impact gate note at the top of this file). */
	impactGatePassed: boolean
	/** Per-axis agreement, 0 (opposite) to 1 (identical) — the input ../services/playerComparison.ts turns into each row's shareOfSimilarity. */
	featureAgreement: Record<keyof SimilarityFeatures, number>
}

/**
 * Compares two specific players outside the ranked-list flow — used by
 * ../services/playerComparison.ts (GET /players/:id/similar/:candidateId) to explain a
 * pair's matchScore in detail. Deliberately reuses the exact same feature vectors and
 * matchScore formula findSimilarPlayers ranks its list by, so the percentage shown in a
 * detail view can never disagree with the percentage the list showed for the same pair.
 */
export function compareSimilarity(
	seedPlayer: CricketPlayer,
	seedDerived: PlayerDerivedDetails | undefined,
	candidatePlayer: CricketPlayer,
	candidateDerived: PlayerDerivedDetails | undefined
): SimilarityComparison {
	const seedFeatures = toFeatures(seedDerived)
	const candidateFeatures = toFeatures(candidateDerived)

	const matchScore = computeMatchScore(
		seedPlayer.role,
		seedFeatures,
		candidatePlayer.role,
		candidateFeatures
	)

	const featureAgreement = FEATURE_KEYS.reduce(
		(acc, key) => {
			acc[key] = 1 - Math.abs(seedFeatures[key] - candidateFeatures[key])
			return acc
		},
		{} as Record<keyof SimilarityFeatures, number>
	)

	return {
		matchScore,
		impactGatePassed: passesImpactGate(
			seedPlayer.impactScore,
			candidatePlayer.impactScore
		),
		featureAgreement
	}
}

/**
 * Parses `query` via Gemini to find the named player, then returns the catalogue players
 * most similar to them, ranked by matchScore descending.
 *
 * @param minMatchScore - When set, only players scoring at or above this (0-100)
 *   threshold are returned, e.g. `80` for "strong matches only". Applied before `limit`,
 *   so `limit` caps the number of *qualifying* players, not the number considered.
 * @throws {@link PlayerNameNotRecognizedError} if the query names no specific player
 *   (e.g. it's unrelated to cricket, or asks for players by role/budget instead).
 * @throws {@link SimilarSeedPlayerNotFoundError} if the extracted name matches no player
 *   in the catalogue.
 * @throws `Error` if `GOOGLE_GENAI_API_KEY` isn't configured or the Gemini call fails
 *   outright (timeout, network, invalid key) — the controller turns this into a clear
 *   API error, same as playerSearch.ts's callers do.
 */
export async function findSimilarPlayers(
	query: string,
	limit: number = DEFAULT_SIMILAR_PLAYERS_LIMIT,
	minMatchScore?: number
): Promise<SimilarPlayersResult> {
	if (!hasKey()) {
		throw new Error(
			'Similar players needs GOOGLE_GENAI_API_KEY configured (Gemini free tier) — see src/services/similarPlayers.ts.'
		)
	}

	const [intent, allPlayers, derivedById] = await Promise.all([
		resolveQueryIntent(query),
		getPlayerIndex(),
		getAllPlayerDerivedDetails()
	])

	if (!intent.playerName) {
		throw new PlayerNameNotRecognizedError(
			intent.interpretation ||
				'Please include a player name in your search, e.g. "players similar to Virat Kohli".'
		)
	}

	const seedPlayer = findPlayerByName(intent.playerName, allPlayers)
	if (!seedPlayer) {
		throw new SimilarSeedPlayerNotFoundError(
			`No player found matching "${intent.playerName}".`
		)
	}

	const seedFeatures = toFeatures(derivedById.get(seedPlayer.id))

	// Computed and ranked before slicing to `limit` so `total` below reflects every
	// player that actually qualifies, not just how many fit on this page — otherwise
	// total always just echoes players.length (the page size) back.
	const qualifying = allPlayers
		.filter((player) => player.id !== seedPlayer.id)
		.filter((player) =>
			passesImpactGate(seedPlayer.impactScore, player.impactScore)
		)
		.map((player) => {
			const derived = derivedById.get(player.id)
			const matchScore = computeMatchScore(
				seedPlayer.role,
				seedFeatures,
				player.role,
				toFeatures(derived)
			)
			return { player, derived, matchScore }
		})
		.filter(({ matchScore }) =>
			minMatchScore === undefined ? true : matchScore >= minMatchScore
		)
		.sort((a, b) => b.matchScore - a.matchScore)

	const players: SimilarPlayer[] = qualifying
		.slice(0, limit)
		.map(({ player, derived, matchScore }) => ({
			...player,
			tags: derived?.tags ?? player.tags,
			matchScore
		}))

	const seedDerived = derivedById.get(seedPlayer.id)

	return {
		query,
		playerName: intent.playerName,
		seedPlayer: { ...seedPlayer, tags: seedDerived?.tags ?? seedPlayer.tags },
		players,
		total: qualifying.length
	}
}
