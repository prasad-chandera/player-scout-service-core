// Single mount point for the API. server.ts mounts this once under /api, so adding an
// endpoint means touching one route file and this list — never server.ts.

import { Router } from 'express'
import explainRoutes from './explain.routes.js'
import playersRoutes from './players.routes.js'
import searchRoutes from './search.routes.js'
import teamsRoutes from './teams.routes.js'
import undervaluedRoutes from './undervalued.routes.js'

const router = Router()

router.use(playersRoutes)
router.use(searchRoutes)
router.use(explainRoutes)
router.use(undervaluedRoutes)
router.use(teamsRoutes)

export default router
