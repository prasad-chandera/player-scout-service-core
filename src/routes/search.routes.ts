import { Router } from 'express'
import * as searchController from '../controllers/search.controller.js'

const router = Router()

// 4. "Find the next Bumrah".
router.post('/search/similar', searchController.searchSimilar)

export default router
