// Team Fit — "best player FOR RCB" rather than "best player" (docs/02 §6).
// This is a new query over the vectors + readiness + price we already have, not a new system.

import { toSummary } from './similarity'
import type {
	Player,
	Role,
	TeamFitRecommendation,
	TeamNeed,
	TeamProfile
} from '../types/index'

interface NeedSpec {
	/** Indexes into the frozen FEATURES ordering. */
	indexes: number[]
	roles: Role[]
}

// Which feature slots define each need role.
export const NEED_FEATURES: Record<string, NeedSpec> = {
	'death-bowler': { indexes: [1, 2, 7], roles: ['bowler', 'allrounder'] },
	'powerplay-bowler': { indexes: [0, 3], roles: ['bowler', 'allrounder'] },
	'wicket-taking-spinner': { indexes: [3, 5], roles: ['bowler'] },
	finisher: { indexes: [1, 7], roles: ['batter', 'allrounder'] },
	'powerplay-batter': { indexes: [0, 9], roles: ['batter'] },
	'middle-order-spin-hitter': {
		indexes: [4, 6],
		roles: ['batter', 'allrounder']
	},
	'spin-allrounder': { indexes: [4, 6, 8], roles: ['allrounder'] },
	fielding: { indexes: [8], roles: ['batter', 'bowler', 'allrounder'] }
}

export interface FitOptions {
	limit?: number
	maxPriceLakh?: number
}

/**
 * Fit = weighted sum of the player's features relevant to each needed role x need weight,
 * filtered by budget. Scores are normalized against the best fit in the pool so the top
 * recommendation always reads 100.
 */
export function fitFor(
	team: TeamProfile,
	players: Player[],
	{ limit = 5, maxPriceLakh }: FitOptions = {}
): TeamFitRecommendation[] {
	const budget = maxPriceLakh ?? team.budgetLakh

	const scored = players
		.filter((p) => p.competition === 'smat' && p.expectedPriceLakh <= budget)
		.map((p) => {
			let best: { fit: number; need: TeamNeed } = {
				fit: 0,
				need: team.needs[0] as TeamNeed
			}
			for (const need of team.needs) {
				const spec = NEED_FEATURES[need.role]
				if (!spec || !spec.roles.includes(p.role)) continue
				const mean =
					spec.indexes.reduce(
						(sum, i) => sum + (p.featureVector[i] as number),
						0
					) / spec.indexes.length
				const fit = need.weight * mean
				if (fit > best.fit) best = { fit, need }
			}
			return { player: p, ...best }
		})
		.filter((s) => s.fit > 0)

	const maxFit = Math.max(...scored.map((s) => s.fit), 0.0001)

	return scored
		.sort((a, b) => b.fit - a.fit)
		.slice(0, limit)
		.map((s) => ({
			player: toSummary(s.player),
			fitScore: Math.round((s.fit / maxFit) * 100),
			matchedNeed: s.need.role,
			reason: `Matches ${team.name}'s need for a ${s.need.label.toLowerCase()} — ${
				s.player.tags[0]
			} at ₹${s.player.expectedPriceLakh}L expected price.`
		}))
}
