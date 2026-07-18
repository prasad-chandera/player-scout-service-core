// Endpoint 4 — the search bar ("Find the next Bumrah").
//
// Deliberately NOT an LLM call (docs/03 §4, §AI-4). A lookup table covers the demo
// and never fails on stage; query parsing is a v1 non-goal.

import type { RequestHandler } from 'express'
import { SEARCH_ALIASES, getPlayer, players } from '../store.js'
import { badRequest, playerNotFound } from '../utils/errors.js'
import { similarTo } from '../services/similarity.service.js'
import type { SearchSimilarBody } from '../types/index.js'

/** Lowercase the text, match known names/aliases against the lookup. */
function resolveReference({
	referencePlayerId,
	description
}: SearchSimilarBody): string | undefined {
	if (referencePlayerId) return referencePlayerId
	if (!description) return undefined

	const text = description.toLowerCase()

	// Longest alias first, so "suryakumar yadav" wins over "sky" on a string that has both.
	const aliases = Object.keys(SEARCH_ALIASES).sort(
		(a, b) => b.length - a.length
	)
	for (const alias of aliases) {
		if (text.includes(alias)) return SEARCH_ALIASES[alias]
	}

	return players.find((p) => text.includes(p.name.toLowerCase()))?.id
}

export const searchSimilar: RequestHandler<
	unknown,
	unknown,
	SearchSimilarBody
> = (req, res) => {
	const {
		referencePlayerId,
		description,
		limit = 10,
		excludeIpl = false
	} = req.body ?? {}

	const refId = resolveReference({ referencePlayerId, description })
	if (!refId) {
		throw badRequest(
			'UNRESOLVED_QUERY',
			"Couldn't identify a reference player in the query"
		)
	}

	const reference = getPlayer(refId)
	if (!reference) throw playerNotFound(refId)

	res.json({
		reference: { id: reference.id, name: reference.name },
		results: similarTo(reference, players, {
			limit: Math.min(20, Math.max(1, Number(limit) || 10)),
			excludeIpl: Boolean(excludeIpl)
		})
	})
}
