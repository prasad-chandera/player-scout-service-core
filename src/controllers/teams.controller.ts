// Endpoints 9 and 10 — franchises and team fit (docs/02 §6).

import type { RequestHandler } from 'express'
import { getTeam, players, teams } from '../store.js'
import { teamNotFound } from '../utils/errors.js'
import { fitFor } from '../services/teamFit.service.js'
import type { TeamFitBody } from '../types/index.js'

/** 9. GET /api/teams */
export const list: RequestHandler = (_req, res) => {
	res.json({ teams })
}

/** 10. POST /api/teams/:id/fit */
export const fit: RequestHandler<{ id: string }, unknown, TeamFitBody> = (
	req,
	res
) => {
	const team = getTeam(req.params.id)
	if (!team) throw teamNotFound(req.params.id)

	const { limit = 5, maxPriceLakh } = req.body ?? {}

	res.json({
		team: { id: team.id, name: team.name },
		recommendations: fitFor(team, players, {
			limit: Math.min(50, Math.max(1, Number(limit) || 5)),
			maxPriceLakh:
				maxPriceLakh === undefined ? undefined : Number(maxPriceLakh)
		})
	})
}
