// Single mount point for the API. server.ts mounts this once under /api, so adding an
// endpoint means touching one route file and this list — never server.ts.

import { Router } from 'express'
import playersRoutes from './players'

const router = Router()

// playersMetaRoutes (GET /meta/features) must come before playersRoutes: its own
// GET /players/:id would otherwise treat a request to /meta/features as :id="meta"
// followed by an unmatched "/features" segment. They don't collide today since
// "/meta/features" and "/players/:id" share no path prefix, but keeping this order
// preserves the invariant if that ever changes.
router.use(playersRoutes)

export default router
