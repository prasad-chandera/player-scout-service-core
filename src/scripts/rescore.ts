// Recompute every player's readiness from their feature vector and write it back to
// data/players.json.
//
// Why this exists: `readiness` is stored on the player (the frontend reads it directly
// from GET /api/players/:id for the score dial) but it is DERIVED from featureVector +
// the weights in src/services/readiness.service.ts. If they drift, the dial and the
// "why this score" breakdown disagree on screen and the whole explainability claim
// falls over.
//
// Run this after touching any featureVector or any weight.

import fs from 'node:fs'
import path from 'node:path'
// DATA_DIR comes from the store rather than being recomputed here: this file compiles to
// dist/scripts/, so deriving a root from its own location would resolve to dist/ and
// miss data/ entirely. store.ts is the single source of truth for both layouts.
import { DATA_DIR, players } from '../store.js'
import { readinessFor } from '../services/readiness.service.js'

const FILE = path.join(DATA_DIR, 'players.json')

let changed = 0
for (const p of players) {
	const { score } = readinessFor(p)
	if (p.readiness !== score) {
		console.log(
			`  ${p.id.padEnd(20)} ${String(p.readiness).padStart(3)} → ${score}`
		)
		p.readiness = score
		changed++
	}
}

if (changed === 0) {
	console.log('All readiness scores already match the model. Nothing to write.')
} else {
	fs.writeFileSync(FILE, `${JSON.stringify(players, null, 2)}\n`)
	console.log(
		`\nRescored ${changed} of ${players.length} players → data/players.json`
	)
}
