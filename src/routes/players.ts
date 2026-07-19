import { Router } from 'express'
import {
	getPlayerDetailsById,
	getPlayerEconomyByPhaseChart,
	getPlayerSimilarityComparison,
	getPlayerSkillRadarChart,
	getPlayersList,
	getPlayersSearch,
	getSimilarPlayers
} from '../controllers/players/players'

const router = Router()

// /players/search and /players/similar must come before /players/:id so neither is
// shadowed by the :id param.
router.get('/players/search', getPlayersSearch)
router.get('/players/similar', getSimilarPlayers)

// GET /players — Cricsheet-backed players list. Public, no auth required.
router.get('/players', getPlayersList)

// The player-detail endpoints (scouting profile header, skill radar, economy-by-phase,
// similarity comparison) must come after the two routes above for the same shadowing
// reason.
router.get('/players/:id', getPlayerDetailsById)
router.get('/players/:id/skill-radar', getPlayerSkillRadarChart)
router.get('/players/:id/economy-by-phase', getPlayerEconomyByPhaseChart)
router.get('/players/:id/similar/:candidateId', getPlayerSimilarityComparison)

export default router
