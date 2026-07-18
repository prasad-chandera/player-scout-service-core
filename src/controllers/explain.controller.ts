// Endpoints 6 and 7 — the Claude explanation layer.
//
// The backend assembles the stats payload itself from the dataset; the frontend never
// sends stats. That prevents prompt tampering and keeps explanations reproducible.

import type { RequestHandler } from 'express'
import { getPlayer } from '../store.js'
import { badRequest, playerNotFound } from '../utils/errors.js'
import { explainComparison, explainPlayer } from '../services/claude.service.js'
import type {
	ExplainComparisonBody,
	ExplainPlayerBody
} from '../types/index.js'

/** 6. POST /api/explain/player */
export const player: RequestHandler<
	unknown,
	unknown,
	ExplainPlayerBody
> = async (req, res) => {
	const { playerId, regenerate = false } = req.body ?? {}
	if (!playerId)
		throw badRequest('MISSING_PLAYER_ID', 'Body must include a playerId')

	const found = getPlayer(playerId)
	if (!found) throw playerNotFound(playerId)

	const { explanation, cached } = await explainPlayer(found, { regenerate })
	res.json({ playerId, cached, explanation })
}

/** 7. POST /api/explain/comparison */
export const comparison: RequestHandler<
	unknown,
	unknown,
	ExplainComparisonBody
> = async (req, res) => {
	const { playerAId, playerBId, regenerate = false } = req.body ?? {}
	if (!playerAId || !playerBId) {
		throw badRequest(
			'MISSING_PLAYER_ID',
			'Body must include both playerAId and playerBId'
		)
	}

	const a = getPlayer(playerAId)
	if (!a) throw playerNotFound(playerAId)
	const b = getPlayer(playerBId)
	if (!b) throw playerNotFound(playerBId)

	const { explanation, cached } = await explainComparison(a, b, { regenerate })
	res.json({ cached, explanation })
}
