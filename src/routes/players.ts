import { Router } from 'express'
import { getPlayersList } from '../controllers/players/players'

const router = Router()

// GET /players — Cricsheet-backed players list. Public, no auth required.
router.get('/players', getPlayersList)

export default router
