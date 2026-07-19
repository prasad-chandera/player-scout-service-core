import { Router } from 'express'
import {
	getPlayersList,
	getPlayersSearch
} from '../controllers/players/players'

const router = Router()

// /players/search must come before /players so it isn't ever shadowed by a future
// /players/:id-style route — no such route exists today, but this keeps the order safe.
router.get('/players/search', getPlayersSearch)

// GET /players — Cricsheet-backed players list. Public, no auth required.
router.get('/players', getPlayersList)

export default router
