// GET /api/players and GET /api/players/search — the Cricsheet-backed players list and
// its natural-language search variant. See ../../services/cricsheet.ts for how the
// catalogue (including impactScore and estimatedPriceRange) is built, and
// ../../services/playerSearch.ts for how search queries are interpreted.
//
// The player detail endpoints (profile, similarity, readiness) that used to live here
// read the demo readiness/similarity dataset (../../store.ts) and predate the
// Cricsheet integration. They aren't wired up in this file — ../../routes/players.ts
// still expects getById/getReadiness/getSimilar from it, which is a pre-existing gap
// from an in-progress refactor, unrelated to this endpoint.

import { Request, Response } from 'express'
import { z } from 'zod/v4'
import { ApiResponse } from '../../types/common'
import { CustomError } from '../../middleware/errorHandler'
import { listCricketPlayers } from '../../services/cricsheet'
import { searchPlayers } from '../../services/playerSearch'
import type { CricketPlayersListData } from '../../types/players'
import type { PlayerSearchResult } from '../../types/playerSearch'

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
