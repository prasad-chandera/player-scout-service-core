import { Router } from 'express'
import * as teamsController from '../controllers/teams.controller.js'

const router = Router()

// 9, 10. Franchises and team fit.
router.get('/teams', teamsController.list)
router.post('/teams/:id/fit', teamsController.fit)

export default router
