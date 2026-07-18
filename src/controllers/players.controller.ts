// Endpoints 1, 2, 3, 5 and 11 (docs/03).
//
// Controllers own HTTP: read params, call a service, shape the response. They throw
// ApiError directly — Express 5 forwards both sync throws and rejected promises to the
// error handler, so there is no try/catch or next(err) to write.

import type { RequestHandler } from 'express'
import { FEATURES, FEATURE_VERSION, getPlayer, players } from '../store.js'
import { playerNotFound } from '../utils/errors.js'
import { readinessFor } from '../services/readiness.service.js'
import { similarTo, toSummary } from '../services/similarity.service.js'
import type { Role } from '../types/index.js'

const intParam = (value: unknown, fallback: number): number => {
	const n = Number.parseInt(String(value), 10)
	return Number.isFinite(n) ? n : fallback
}

interface ListQuery {
	role?: Role
	q?: string
	minReadiness?: string
	maxPriceLakh?: string
	competition?: string
	page?: string
	limit?: string
}

/** 1. GET /api/players — list/search with filters. */
export const list: RequestHandler<unknown, unknown, unknown, ListQuery> = (
	req,
	res
) => {
	const { role, q, minReadiness, maxPriceLakh, competition } = req.query
	const page = Math.max(1, intParam(req.query.page, 1))
	const limit = Math.min(100, Math.max(1, intParam(req.query.limit, 20)))

	const matched = players
		.filter((p) => {
			if (role && p.role !== role) return false
			if (q && !p.name.toLowerCase().includes(String(q).toLowerCase()))
				return false
			if (minReadiness && p.readiness < Number(minReadiness)) return false
			if (maxPriceLakh && p.expectedPriceLakh > Number(maxPriceLakh))
				return false
			if (competition && p.competition !== competition) return false
			return true
		})
		.sort((a, b) => b.readiness - a.readiness)

	const start = (page - 1) * limit
	res.json({
		page,
		total: matched.length,
		players: matched.slice(start, start + limit).map(toSummary)
	})
}

/** 11. GET /api/meta/features — the frozen dictionary. */
export const getFeatures: RequestHandler = (_req, res) => {
	res.json({ version: FEATURE_VERSION, features: FEATURES })
}

/** 2. GET /api/players/:id — full profile for the detail page. */
export const getById: RequestHandler<{ id: string }> = (req, res) => {
	const player = getPlayer(req.params.id)
	if (!player) throw playerNotFound(req.params.id)
	res.json(player)
}

/** 3. GET /api/players/:id/similar — top-N similar with contribution breakdown. */
export const getSimilar: RequestHandler<
	{ id: string },
	unknown,
	unknown,
	{ limit?: string; excludeIpl?: string }
> = (req, res) => {
	const reference = getPlayer(req.params.id)
	if (!reference) throw playerNotFound(req.params.id)

	const limit = Math.min(20, Math.max(1, intParam(req.query.limit, 5)))
	const excludeIpl = req.query.excludeIpl === 'true'

	res.json({
		reference: { id: reference.id, name: reference.name },
		results: similarTo(reference, players, { limit, excludeIpl })
	})
}

/** 5. GET /api/players/:id/readiness — score with the full transparency breakdown. */
export const getReadiness: RequestHandler<{ id: string }> = (req, res) => {
	const player = getPlayer(req.params.id)
	if (!player) throw playerNotFound(req.params.id)
	res.json(readinessFor(player))
}
