// GET /api/players/:id, .../skill-radar and .../economy-by-phase — the three
// player-details endpoints backing the scouting profile UI (header card, skill radar
// chart, economy-by-phase bar chart).
//
// Pure composition layer: ../../services/cricsheet.ts owns ingestion/caching and
// already computes every figure these need (impactScore, estimatedPriceRange, the
// skill radar and economy-by-phase derived during the same index build, and the
// percentile-based scouting tags). This module just looks a player up and shapes the
// result into each endpoint's response contract — see ../types/playerDetails.ts.

import { getCricketPlayerById, getPlayerDerivedDetails } from './cricsheet'
import type {
	PlayerDetails,
	PlayerEconomyByPhase,
	PlayerSkillRadar
} from '../types/playerDetails'

/**
 * GET /api/players/:id — the scouting profile header card (name, role, price band,
 * readiness score, scouting tags). Returns `undefined` when no player has this id; the
 * controller is responsible for turning that into a 404.
 */
export async function getPlayerDetails(
	id: string
): Promise<PlayerDetails | undefined> {
	const [player, derived] = await Promise.all([
		getCricketPlayerById(id),
		getPlayerDerivedDetails(id)
	])
	if (!player || !derived) return undefined

	return {
		id: player.id,
		name: player.name,
		role: player.role,
		battingHand: player.battingHand,
		bowlingStyle: player.bowlingStyle,
		age: player.age,
		competition: player.competition,
		matches: player.matches,
		teams: player.teams,
		currentIPLTeam: player.currentIPLTeam,
		imageUrl: player.imageUrl,
		readinessScore: player.impactScore,
		estimatedPriceRange: player.estimatedPriceRange,
		tags: derived.tags
	}
}

/**
 * GET /api/players/:id/skill-radar — the five-axis radar chart. Returns `undefined`
 * when no player has this id.
 */
export async function getPlayerSkillRadar(
	id: string
): Promise<PlayerSkillRadar | undefined> {
	const derived = await getPlayerDerivedDetails(id)
	if (!derived) return undefined
	return { playerId: id, scores: derived.skillRadar }
}

/**
 * GET /api/players/:id/economy-by-phase — the powerplay/middle/death bar chart.
 * Returns `undefined` when no player has this id.
 */
export async function getPlayerEconomyByPhase(
	id: string
): Promise<PlayerEconomyByPhase | undefined> {
	const derived = await getPlayerDerivedDetails(id)
	if (!derived) return undefined
	return { playerId: id, phases: derived.economyByPhase }
}
