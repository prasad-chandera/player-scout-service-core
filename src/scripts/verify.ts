// Contract assertions against a running server.
//
//   npm run dev        # or npm start, in another terminal
//   npm run verify
//
// These are not unit tests of the arithmetic — they check the things that actually break
// the UI: shapes the frontend deserializes, invariants a reader would assume, and the two
// regressions that would silently gut the product (a readiness dial that disagrees with
// its own breakdown, and a similarity engine where everything reads 100%).

import type {
	FeatureMeta,
	Player,
	PlayerSummary,
	ReadinessResponse,
	SimilarSearchResponse,
	TeamFitResponse,
	TeamProfile,
	UndervaluedResponse
} from '../types/index'

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:4000'

let failures = 0
function ok(name: string, condition: boolean, detail = ''): void {
	console.log(
		`${condition ? 'PASS' : 'FAIL'}  ${name}${condition ? '' : `  <- ${detail}`}`
	)
	if (!condition) failures++
}

const get = async <T>(p: string): Promise<T> =>
	(await fetch(BASE + p)).json() as Promise<T>
const post = async <T>(p: string, body: unknown): Promise<T> =>
	(
		await fetch(BASE + p, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	).json() as Promise<T>

interface ErrorResponse {
	error?: { code?: string; message?: string }
}

;(async () => {
	// ------------------------------- readiness -------------------------------
	// The dial reads `readiness` off the player; the panel reads `breakdown` off this
	// endpoint. If they ever disagree, the explainability claim is dead on screen.

	const all = await get<{ players: PlayerSummary[] }>('/api/players?limit=100')
	ok(
		'dataset loaded',
		all.players.length === 50,
		`${all.players.length} players`
	)

	let worstDrift = 0
	let worstId = ''
	let mismatched = 0
	for (const summary of all.players) {
		const r = await get<ReadinessResponse>(
			`/api/players/${summary.id}/readiness`
		)
		const sum = r.breakdown.reduce((s, x) => s + x.contribution, 0)
		const drift = Math.abs(sum - r.score)
		if (drift > worstDrift) {
			worstDrift = drift
			worstId = summary.id
		}
		if (r.score !== summary.readiness) mismatched++
	}
	ok(
		'every readiness breakdown sums to its score (<=0.5)',
		worstDrift <= 0.5,
		`worst drift ${worstDrift.toFixed(3)} on ${worstId}`
	)
	ok(
		'every readiness score matches the player summary',
		mismatched === 0,
		`${mismatched} mismatched`
	)

	for (const id of ['arjun-kumar', 'rahul-nair', 'dev-patel']) {
		const r = await get<ReadinessResponse>(`/api/players/${id}/readiness`)
		const w = r.breakdown.reduce((s, x) => s + x.weight, 0)
		ok(`weights sum to 1.0 (${id})`, Math.abs(w - 1) < 1e-9, `sum=${w}`)
	}

	// --------------------------------- shapes ---------------------------------
	// docs/03 gets both of these wrong; the frontend's types.ts is the contract.

	const ak = await get<Player>('/api/players/arjun-kumar')
	ok(
		'featureVector is a flat array of 10 numbers',
		Array.isArray(ak.featureVector) &&
			ak.featureVector.length === 10 &&
			ak.featureVector.every((v) => typeof v === 'number'),
		JSON.stringify(ak.featureVector)
	)

	const sim = await get<SimilarSearchResponse>(
		'/api/players/bumrah01/similar?limit=5&excludeIpl=true'
	)
	const c = sim.results[0]!.topContributions[0]!
	ok(
		'topContributions reference/candidateValue are strings',
		typeof c.referenceValue === 'string' &&
			typeof c.candidateValue === 'string',
		JSON.stringify(c)
	)
	ok(
		'contributions sorted desc, each in [0,1]',
		sim.results[0]!.topContributions.every(
			(x) => x.contribution >= 0 && x.contribution <= 1
		) && c.contribution >= sim.results[0]!.topContributions[1]!.contribution
	)

	// -------------------------------- similarity -------------------------------
	// The regression guard for the mean-centring fix. Raw cosine put this whole pool in a
	// 2.9-point band where everything rounds to 100%; if that ever comes back, these fail.

	const search = await post<SimilarSearchResponse>('/api/search/similar', {
		description: 'find the next bumrah',
		limit: 10,
		excludeIpl: true
	})
	ok(
		'"find the next bumrah" resolves to Bumrah',
		search.reference.id === 'bumrah01'
	)
	ok(
		'top result is an elite death bowler',
		['arjun-kumar', 'farhan-qureshi'].includes(search.results[0]!.player.id),
		search.results[0]!.player.id
	)
	const scores = search.results.map((r) => r.similarity)
	const spread = (Math.max(...scores) - Math.min(...scores)) * 100
	ok(
		'similarity spread is meaningful (>15 pts)',
		spread > 15,
		`${spread.toFixed(1)} pts`
	)
	ok(
		'nothing rounds to 100%',
		!search.results.some((r) => Math.round(r.similarity * 100) >= 100)
	)
	ok(
		'all similarity values in [0,1]',
		search.results.every((r) => r.similarity >= 0 && r.similarity <= 1)
	)

	const pool = await Promise.all(
		search.results.map((r) => get<Player>(`/api/players/${r.player.id}`))
	)
	ok(
		'excludeIpl=true excludes IPL players',
		pool.every((p) => p.competition !== 'ipl')
	)

	// ------------------------------- undervalued -------------------------------

	const uv = await get<UndervaluedResponse>('/api/undervalued?limit=10')
	ok(
		'undervalued sorted by valueGapLakh desc',
		uv.players.every(
			(p, i) => i === 0 || uv.players[i - 1]!.valueGapLakh >= p.valueGapLakh
		)
	)
	ok(
		'undervalued ranks are 1..N',
		uv.players.every((p, i) => p.rank === i + 1)
	)
	ok(
		'undervalued carries the calibrated-claim disclaimer',
		uv.disclaimer.includes('not a market prediction')
	)
	const uvPlayers = await Promise.all(
		uv.players.map((e) => get<Player>(`/api/players/${e.player.id}`))
	)
	ok(
		'undervalued is SMAT-only',
		uvPlayers.every((p) => p.competition === 'smat')
	)

	// ---------------------------------- teams ----------------------------------

	const teams = await get<{ teams: TeamProfile[] }>('/api/teams')
	ok(
		'10 teams, each with a `short`',
		teams.teams.length === 10 && teams.teams.every((t) => Boolean(t.short))
	)

	const fit = await post<TeamFitResponse>('/api/teams/rcb/fit', { limit: 5 })
	ok('team fit returns recommendations', fit.recommendations.length > 0)
	ok(
		'top fitScore is normalised to 100',
		fit.recommendations[0]!.fitScore === 100,
		String(fit.recommendations[0]!.fitScore)
	)
	ok(
		"team fit respects RCB's 800L budget",
		fit.recommendations.every((r) => r.player.expectedPriceLakh <= 800)
	)

	// ---------------------------------- meta -----------------------------------

	const meta = await get<{ version: number; features: FeatureMeta[] }>(
		'/api/meta/features'
	)
	ok(
		'meta/features returns 10 slots indexed 0..9',
		meta.features.length === 10 && meta.features.every((f, i) => f.index === i)
	)

	// --------------------------------- explain ---------------------------------
	// Must be 200 even with no API key — docs/02 §7: the demo survives a dead network.

	const exp = await post<{
		explanation?: { summary?: string; weaknesses?: string[] }
	}>('/api/explain/player', { playerId: 'arjun-kumar' })
	ok('explain/player returns an explanation', Boolean(exp.explanation?.summary))
	ok(
		'explain has non-empty weaknesses (grounding rule 6)',
		(exp.explanation?.weaknesses?.length ?? 0) > 0
	)

	const cmp = await post<{
		explanation?: { verdict?: string; rows?: unknown[] }
	}>('/api/explain/comparison', {
		playerAId: 'bumrah01',
		playerBId: 'arjun-kumar'
	})
	ok(
		'explain/comparison returns verdict + rows',
		Boolean(cmp.explanation?.verdict) && Array.isArray(cmp.explanation?.rows)
	)

	// ---------------------------------- errors ---------------------------------

	ok(
		'unknown player -> 404 PLAYER_NOT_FOUND',
		(await get<ErrorResponse>('/api/players/nonexistent')).error?.code ===
			'PLAYER_NOT_FOUND'
	)
	ok(
		'unknown team -> 404 TEAM_NOT_FOUND',
		(await post<ErrorResponse>('/api/teams/nope/fit', {})).error?.code ===
			'TEAM_NOT_FOUND'
	)
	ok(
		'unresolvable query -> 400 UNRESOLVED_QUERY',
		(
			await post<ErrorResponse>('/api/search/similar', {
				description: 'find me a wizard'
			})
		).error?.code === 'UNRESOLVED_QUERY'
	)
	ok(
		'explain with no playerId -> 400 MISSING_PLAYER_ID',
		(await post<ErrorResponse>('/api/explain/player', {})).error?.code ===
			'MISSING_PLAYER_ID'
	)
	ok(
		'unknown route -> 404 NOT_FOUND',
		(await get<ErrorResponse>('/api/nope')).error?.code === 'NOT_FOUND'
	)

	console.log(
		failures ? `\n${failures} FAILURE(S)` : '\nAll assertions passed.'
	)
	process.exit(failures ? 1 : 0)
})()
