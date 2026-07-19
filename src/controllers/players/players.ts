// GET /api/players, GET /api/players/search and the GET /api/players/:id player-detail
// endpoints — all backed by the Cricsheet catalogue. See ../../services/cricsheet.ts
// for how the catalogue (including impactScore and estimatedPriceRange) is built,
// ../../services/playerSearch.ts for how search queries are interpreted, and
// ../../services/playerDetails.ts for how the per-player detail views are assembled.
//
// An older, unrelated demo readiness/similarity dataset (../../store.ts) used to back a
// different set of player-detail endpoints before the Cricsheet integration; that
// dataset is unwired (data/*.json is empty on disk) and unrelated to the endpoints
// below, which read exclusively from the live Cricsheet-backed catalogue.

import { Request, Response } from 'express'
import { z } from 'zod/v4'
import { ApiResponse } from '../../types/common'
import { CustomError } from '../../middleware/errorHandler'
import { listCricketPlayers } from '../../services/cricsheet'
import { searchPlayers } from '../../services/playerSearch'
import {
	findSimilarPlayers,
	PlayerNameNotRecognizedError,
	SimilarSeedPlayerNotFoundError
} from '../../services/similarPlayers'
import {
	comparePlayersSimilarity,
	PlayerComparisonNotFoundError
} from '../../services/playerComparison'
import {
	getPlayerDetails,
	getPlayerEconomyByPhase,
	getPlayerSkillRadar
} from '../../services/playerDetails'
import type { CricketPlayersListData } from '../../types/players'
import type { PlayerSearchResult } from '../../types/playerSearch'
import type { SimilarPlayersResult } from '../../types/similarPlayers'
import type { PlayerComparisonResult } from '../../types/playerComparison'
import type {
	PlayerDetails,
	PlayerEconomyByPhase,
	PlayerSkillRadar
} from '../../types/playerDetails'

const DOMESTIC_COMPETITIONS = ['ipl', 'smat'] as const
const MAX_PAGE_SIZE = 100

const playersListQuerySchema = z.object({
	name: z.string().trim().min(1).max(100).optional(),
	team: z.string().trim().min(1).max(100).optional(),
	competition: z.enum(DOMESTIC_COMPETITIONS).optional(),
	page: z.coerce.number().int().min(1).optional().default(1),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(MAX_PAGE_SIZE)
		.optional()
		.default(20)
})

/**
 * GET /api/players — lists Indian IPL and Syed Mushtaq Ali Trophy cricket players.
 *
 * Data comes from Cricsheet via {@link listCricketPlayers}; see
 * `../../services/cricsheet.service.ts` for how the catalogue is built and its known
 * coverage gaps. This endpoint does not require authentication.
 *
 * Query parameters (all optional):
 * - `name` — case-insensitive substring match on player name.
 * - `team` — case-insensitive substring match on any team the player has represented
 *   (an IPL franchise, or a Syed Mushtaq Ali Trophy state/zone side).
 * - `competition` — one of `ipl`, `smat`.
 * - `page` — 1-indexed page number, defaults to 1.
 * - `limit` — page size, defaults to 20, capped at {@link MAX_PAGE_SIZE}.
 */
export const getPlayersList = async (req: Request, res: Response) => {
	const response: ApiResponse & { data: CricketPlayersListData | null } = {
		status: 'FAILED',
		error: null,
		message: null,
		data: null
	}

	try {
		const parsedQuery = playersListQuerySchema.safeParse(req.query)
		if (!parsedQuery.success) {
			response.error = 'BAD_REQUEST'
			response.message = 'Invalid query parameters for the players list.'
			throw new CustomError(response.error, response.message, parsedQuery.error)
		}

		response.data = await listCricketPlayers(parsedQuery.data)
		response.status = 'SUCCESS'
		res.json(response)
	} catch (error) {
		if (!response.message) {
			if (error instanceof Error) {
				response.message = error.toString().replace('Error: ', '')
			} else {
				response.message = 'Failed to fetch players list.'
			}
		}
		const customError = new CustomError(
			response.error || 'INTERNAL_SERVER_ERROR',
			response.message,
			error instanceof CustomError ? error.validationResult : null
		)
		customError.throwError(req, res)
	}
}

const playersSearchQuerySchema = z.object({
	query: z.string().trim().min(2).max(300)
})

/**
 * GET /api/players/search?q=... — natural-language player search, e.g. "best
 * impactful batter in powerplay" or "find me the best all-rounder within 10 crore
 * budget". See `../../services/playerSearch.ts` for how the query is interpreted
 * (Gemini's free tier turns it into structured filters) and applied against the same
 * catalogue `getPlayersList` serves.
 *
 * Query parameters:
 * - `q` (required) — the free-text search query, 2-300 characters.
 */
export const getPlayersSearch = async (req: Request, res: Response) => {
	const response: ApiResponse & { data: PlayerSearchResult | null } = {
		status: 'FAILED',
		error: null,
		message: null,
		data: null
	}

	try {
		const parsedQuery = playersSearchQuerySchema.safeParse(req.query)
		if (!parsedQuery.success) {
			response.error = 'BAD_REQUEST'
			response.message = 'Search query is required.'
			throw new CustomError(response.error, response.message, parsedQuery.error)
		}

		response.data = await searchPlayers(parsedQuery.data.query)
		response.status = 'SUCCESS'
		res.json(response)
	} catch (error) {
		if (!response.message) {
			if (error instanceof Error) {
				response.message = error.toString().replace('Error: ', '')
			} else {
				response.message = 'Failed to search players.'
			}
		}
		const customError = new CustomError(
			response.error || 'INTERNAL_SERVER_ERROR',
			response.message,
			error instanceof CustomError ? error.validationResult : null
		)
		customError.throwError(req, res)
	}
}

const DEFAULT_SIMILAR_PLAYERS_LIMIT = 5
const MAX_SIMILAR_PLAYERS_LIMIT = 20

const playersSimilarQuerySchema = z.object({
	query: z.string().trim().min(2).max(300),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(MAX_SIMILAR_PLAYERS_LIMIT)
		.optional()
		.default(DEFAULT_SIMILAR_PLAYERS_LIMIT),
	minMatchScore: z.coerce.number().min(0).max(100).optional()
})

/**
 * GET /api/players/similar?query=... — AI-assisted similar-players search. Given a
 * free-text query naming a player (e.g. "players similar to Virat Kohli", "who plays
 * like Bumrah"), returns the catalogue players most alike them, each carrying a
 * `matchScore` (0-100) on top of the usual player fields. See
 * `../../services/similarPlayers.ts` for how the query is interpreted (Gemini extracts
 * the player name — it never sees the catalogue) and how matchScore is computed
 * (deterministic skill-radar/impact-score/role comparison over the same catalogue
 * `getPlayersList` serves).
 *
 * Query parameters:
 * - `query` (required) — free text naming the player to find similar players for,
 *   2-300 characters. A query with no recognizable player name (or one unrelated to
 *   cricket scouting entirely) returns a 400 explaining why; a recognized name with no
 *   catalogue match returns a 404.
 * - `limit` (optional) — how many similar players to return, defaults to
 *   {@link DEFAULT_SIMILAR_PLAYERS_LIMIT}, capped at {@link MAX_SIMILAR_PLAYERS_LIMIT}.
 * - `minMatchScore` (optional) — only return players whose matchScore is at or above
 *   this 0-100 threshold, e.g. `minMatchScore=80` for "strong matches only". Applied
 *   before `limit`, so `limit` caps the number of qualifying players returned.
 */
export const getSimilarPlayers = async (req: Request, res: Response) => {
	const response: ApiResponse & { data: SimilarPlayersResult | null } = {
		status: 'FAILED',
		error: null,
		message: null,
		data: null
	}

	try {
		const parsedQuery = playersSimilarQuerySchema.safeParse(req.query)
		if (!parsedQuery.success) {
			response.error = 'BAD_REQUEST'
			response.message = 'A player name is required to find similar players.'
			throw new CustomError(response.error, response.message, parsedQuery.error)
		}

		response.data = await findSimilarPlayers(
			parsedQuery.data.query,
			parsedQuery.data.limit,
			parsedQuery.data.minMatchScore
		)
		response.status = 'SUCCESS'
		res.json(response)
	} catch (error) {
		if (error instanceof PlayerNameNotRecognizedError) {
			response.error = 'BAD_REQUEST'
			response.message = error.message
		} else if (error instanceof SimilarSeedPlayerNotFoundError) {
			response.error = 'ENTITY_NOT_FOUND'
			response.message = error.message
		} else if (!response.message) {
			if (error instanceof Error) {
				response.message = error.toString().replace('Error: ', '')
			} else {
				response.message = 'Failed to find similar players.'
			}
		}
		const customError = new CustomError(
			response.error || 'INTERNAL_SERVER_ERROR',
			response.message,
			error instanceof CustomError ? error.validationResult : null
		)
		customError.throwError(req, res)
	}
}

const playerIdParamsSchema = z.object({
	id: z.string().trim().min(1).max(100)
})

function playerNotFoundError(id: string): CustomError {
	return new CustomError('ENTITY_NOT_FOUND', `No player with id "${id}".`, null)
}

/**
 * GET /api/players/:id — the scouting profile header card: name, role, price band,
 * readiness score and scouting tags. See `../../services/playerDetails.ts` for how
 * this is assembled from the Cricsheet-backed catalogue.
 *
 * Path parameters:
 * - `id` (required) — the player's Cricsheet registry id, as returned by GET /api/players.
 */
export const getPlayerDetailsById = async (req: Request, res: Response) => {
	const response: ApiResponse & { data: PlayerDetails | null } = {
		status: 'FAILED',
		error: null,
		message: null,
		data: null
	}

	try {
		const parsedParams = playerIdParamsSchema.safeParse(req.params)
		if (!parsedParams.success) {
			response.error = 'BAD_REQUEST'
			response.message = 'A player id is required.'
			throw new CustomError(
				response.error,
				response.message,
				parsedParams.error
			)
		}

		const details = await getPlayerDetails(parsedParams.data.id)
		if (!details) throw playerNotFoundError(parsedParams.data.id)

		response.data = details
		response.status = 'SUCCESS'
		res.json(response)
	} catch (error) {
		if (!response.message) {
			if (error instanceof Error) {
				response.message = error.toString().replace('Error: ', '')
			} else {
				response.message = 'Failed to fetch player details.'
			}
		}
		const customError = new CustomError(
			error instanceof CustomError
				? error.error
				: response.error || 'INTERNAL_SERVER_ERROR',
			response.message,
			error instanceof CustomError ? error.validationResult : null
		)
		customError.throwError(req, res)
	}
}

/**
 * GET /api/players/:id/skill-radar — the five-axis skill radar chart (batting/bowling/
 * fielding/pressure/consistency, each 0-10). See `../../services/playerDetails.ts` and
 * `computeSkillRadar` in `../../services/scoring.ts` for the underlying formula.
 *
 * Path parameters:
 * - `id` (required) — the player's Cricsheet registry id.
 */
export const getPlayerSkillRadarChart = async (req: Request, res: Response) => {
	const response: ApiResponse & { data: PlayerSkillRadar | null } = {
		status: 'FAILED',
		error: null,
		message: null,
		data: null
	}

	try {
		const parsedParams = playerIdParamsSchema.safeParse(req.params)
		if (!parsedParams.success) {
			response.error = 'BAD_REQUEST'
			response.message = 'A player id is required.'
			throw new CustomError(
				response.error,
				response.message,
				parsedParams.error
			)
		}

		const radar = await getPlayerSkillRadar(parsedParams.data.id)
		if (!radar) throw playerNotFoundError(parsedParams.data.id)

		response.data = radar
		response.status = 'SUCCESS'
		res.json(response)
	} catch (error) {
		if (!response.message) {
			if (error instanceof Error) {
				response.message = error.toString().replace('Error: ', '')
			} else {
				response.message = 'Failed to fetch skill radar.'
			}
		}
		const customError = new CustomError(
			error instanceof CustomError
				? error.error
				: response.error || 'INTERNAL_SERVER_ERROR',
			response.message,
			error instanceof CustomError ? error.validationResult : null
		)
		customError.throwError(req, res)
	}
}

/**
 * GET /api/players/:id/economy-by-phase — the powerplay/middle/death bar chart data.
 * See `../../services/playerDetails.ts` and `computeEconomyByPhase` in
 * `../../services/scoring.ts` for the underlying formula.
 *
 * Path parameters:
 * - `id` (required) — the player's Cricsheet registry id.
 */
export const getPlayerEconomyByPhaseChart = async (
	req: Request,
	res: Response
) => {
	const response: ApiResponse & { data: PlayerEconomyByPhase | null } = {
		status: 'FAILED',
		error: null,
		message: null,
		data: null
	}

	try {
		const parsedParams = playerIdParamsSchema.safeParse(req.params)
		if (!parsedParams.success) {
			response.error = 'BAD_REQUEST'
			response.message = 'A player id is required.'
			throw new CustomError(
				response.error,
				response.message,
				parsedParams.error
			)
		}

		const economyByPhase = await getPlayerEconomyByPhase(parsedParams.data.id)
		if (!economyByPhase) throw playerNotFoundError(parsedParams.data.id)

		response.data = economyByPhase
		response.status = 'SUCCESS'
		res.json(response)
	} catch (error) {
		if (!response.message) {
			if (error instanceof Error) {
				response.message = error.toString().replace('Error: ', '')
			} else {
				response.message = 'Failed to fetch economy by phase.'
			}
		}
		const customError = new CustomError(
			error instanceof CustomError
				? error.error
				: response.error || 'INTERNAL_SERVER_ERROR',
			response.message,
			error instanceof CustomError ? error.validationResult : null
		)
		customError.throwError(req, res)
	}
}

const DEFAULT_COMPARISON_ROW_LIMIT = 3
const MAX_COMPARISON_ROW_LIMIT = 5

const playerComparisonParamsSchema = z.object({
	id: z.string().trim().min(1).max(100),
	candidateId: z.string().trim().min(1).max(100)
})

const playerComparisonQuerySchema = z.object({
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(MAX_COMPARISON_ROW_LIMIT)
		.optional()
		.default(DEFAULT_COMPARISON_ROW_LIMIT)
})

/**
 * GET /api/players/:id/similar/:candidateId — explains why `candidateId` matched `id` in
 * a GET /api/players/similar list: the matchScore breakdown by skill axis, plus a
 * one-sentence verdict and notable differences. See
 * `../../services/playerComparison.ts` for how the comparison table is computed
 * (deterministic, reusing the exact same formula the list is ranked by) and how the
 * verdict/differences are narrated (Gemini when configured, a deterministic template
 * otherwise — see `narrativeSource` on the response).
 *
 * Path parameters:
 * - `id` (required) — the seed player's Cricsheet registry id.
 * - `candidateId` (required) — the candidate player's Cricsheet registry id.
 *
 * Query parameters:
 * - `limit` (optional) — how many comparison rows to return, ranked by
 *   shareOfSimilarity descending. Defaults to {@link DEFAULT_COMPARISON_ROW_LIMIT},
 *   capped at {@link MAX_COMPARISON_ROW_LIMIT}.
 */
export const getPlayerSimilarityComparison = async (
	req: Request,
	res: Response
) => {
	const response: ApiResponse & { data: PlayerComparisonResult | null } = {
		status: 'FAILED',
		error: null,
		message: null,
		data: null
	}

	try {
		const parsedParams = playerComparisonParamsSchema.safeParse(req.params)
		if (!parsedParams.success) {
			response.error = 'BAD_REQUEST'
			response.message = 'A player id and a candidate id are both required.'
			throw new CustomError(
				response.error,
				response.message,
				parsedParams.error
			)
		}

		const parsedQuery = playerComparisonQuerySchema.safeParse(req.query)
		if (!parsedQuery.success) {
			response.error = 'BAD_REQUEST'
			response.message = 'Invalid query parameters for the player comparison.'
			throw new CustomError(response.error, response.message, parsedQuery.error)
		}

		response.data = await comparePlayersSimilarity(
			parsedParams.data.id,
			parsedParams.data.candidateId,
			parsedQuery.data.limit
		)
		response.status = 'SUCCESS'
		res.json(response)
	} catch (error) {
		if (error instanceof PlayerComparisonNotFoundError) {
			response.error = 'ENTITY_NOT_FOUND'
			response.message = error.message
		} else if (!response.message) {
			if (error instanceof Error) {
				response.message = error.toString().replace('Error: ', '')
			} else {
				response.message = 'Failed to compare players.'
			}
		}
		const customError = new CustomError(
			response.error || 'INTERNAL_SERVER_ERROR',
			response.message,
			error instanceof CustomError ? error.validationResult : null
		)
		customError.throwError(req, res)
	}
}
