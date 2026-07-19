// Pre-generate a Claude scouting report for every player.
//
// docs/02 §7 and docs/03 §AI-3 are explicit about this: never depend on a live API call
// during the judged demo. Run this once before demoing — afterwards every
// POST /api/explain/player is a disk read, so cost ≈ 0 and latency ≈ 0 on stage.

import 'dotenv/config'
import { players } from '../store'
import { MODEL, explainPlayer, hasKey } from '../services/claude'

if (!hasKey()) {
	console.error(
		'No ANTHROPIC_API_KEY set. Nothing to warm — the API already serves canned fallback\n' +
			'reports without it, so the demo works either way. Set the key to generate real ones.'
	)
	process.exit(1)
}

;(async () => {
	const regenerate = process.argv.includes('--force')
	console.log(
		`Warming ${players.length} explanations with ${MODEL}${regenerate ? ' (forced)' : ''}...\n`
	)

	let generated = 0
	let reused = 0

	// Serial on purpose: this runs once, and it keeps us well clear of rate limits.
	for (const player of players) {
		const { cached } = await explainPlayer(player, { regenerate })
		if (cached) reused++
		else generated++
		console.log(`  ${cached ? 'cached ' : 'wrote  '} ${player.id}`)
	}

	console.log(`\nDone. ${generated} generated, ${reused} already cached.`)
})()
