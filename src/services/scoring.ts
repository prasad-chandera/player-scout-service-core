// Turns the raw per-player figures gathered by cricsheet.ts into the scouting scores
// exposed on CricketPlayer: impactScore, and (via auctionScore) estimatedPriceRange.
//
// Pure and I/O-free by design: cricsheet.ts calls this once per player while building
// the in-memory index (see buildPlayerIndex), so the players-list endpoint itself never
// recomputes a score per request — it only filters/paginates already-scored players.
//
// Cricsheet has no biographical data (no DOB, no auction history, no team/pitch
// ratings, no injury data). Every metric below is either computed directly from ball-
// by-ball figures, or — where the brief's formula calls for something Cricsheet
// doesn't publish — approximated from a proxy that IS derivable from match data. Each
// proxy is documented at its use site. Nothing here fabricates a value Cricsheet has no
// basis for (age, batting hand, bowling style stay null at the type level).

import type { EstimatedPriceRange, PlayerRole } from '../types/players'

/** Career-aggregate batting figures for one player in one scope (career or domestic-only). */
export interface BattingCareerStats {
	innings: number
	runs: number
	ballsFaced: number
	outs: number
	fours: number
	sixes: number
	fifties: number
	hundreds: number
	dotBallsFaced: number
	runsInWins: number
	runsWhileChasing: number
}

/** Career-aggregate bowling figures for one player in one scope. */
export interface BowlingCareerStats {
	innings: number
	wickets: number
	ballsBowled: number
	runsConceded: number
	maidens: number
	dotBallsBowled: number
	powerplayWickets: number
	deathOverBallsBowled: number
	deathOverRunsConceded: number
}

/** Fielding contributions, tracked independently of batting/bowling role. */
export interface FieldingStats {
	catches: number
	runOuts: number
	stumpings: number
}

/** One innings-appearance's figures, used only for the last-5 recent-form window. */
export interface InningsFormEntry {
	date: string
	runsScored: number
	ballsFaced: number
	wicketsTaken: number
	runsConceded: number
	ballsBowled: number
}

/** Sum of matchday achievement bonuses (docs table: Player of Match +5, etc.) — averaged over `matchesPlayed` at scoring time. */
export interface MatchImpactTally {
	bonusPoints: number
}

/**
 * Opponent-strength and venue-pitch multipliers, summed across matches played (divide
 * by `matchesPlayed` at scoring time for the average). Cricsheet has no team-ranking or
 * pitch-rating dataset, so both multipliers are derived from the ingested matches
 * themselves — see buildTeamStrengthRankings and buildVenueDifficultyRatings in
 * cricsheet.ts.
 */
export interface DifficultyTally {
	opponentMultiplierSum: number
	venueMultiplierSum: number
}

/** Everything needed to score one player, for one scope (full career or domestic-only). */
export interface PlayerScoringInput {
	role: PlayerRole
	batting: BattingCareerStats
	bowling: BowlingCareerStats
	fielding: FieldingStats
	recentInnings: InningsFormEntry[]
	matchImpact: MatchImpactTally
	difficulty: DifficultyTally
	matchesPlayed: number
	/** Whole years since this player's first ingested appearance — see computeAuctionScore. */
	yearsSinceDebut: number
	/** Days since this player's most recent ingested appearance, relative to the newest match in the whole dataset. */
	daysSinceLastAppearance: number
}

const RECENT_FORM_WINDOW = 5

const clamp = (value: number, min = 0, max = 100): number =>
	Math.max(min, Math.min(max, value))

/** Scales `value` linearly so `benchmark` lands at 100, clamped to [0, 100]. */
const normalizeUp = (value: number, benchmark: number): number =>
	benchmark <= 0 ? 0 : clamp((value / benchmark) * 100)

/** Scales `value` linearly so `worst` lands at 0 and `best` lands at 100 (best < worst), clamped. */
const normalizeDown = (value: number, best: number, worst: number): number =>
	clamp(((worst - value) / (worst - best)) * 100)

const round1 = (value: number): number => Math.round(value * 10) / 10

function battingCareerScore(stats: BattingCareerStats): number {
	const { innings, runs, ballsFaced, outs, fours, sixes, fifties, hundreds } =
		stats
	if (innings === 0) return 0

	const runsPerInnings = normalizeUp(runs / innings, 40)
	const battingAverage = normalizeUp(runs / Math.max(outs, 1), 35)
	const strikeRate =
		ballsFaced === 0 ? 0 : normalizeUp((runs / ballsFaced) * 100, 150)
	const boundaryPercent =
		ballsFaced === 0 ? 0 : normalizeUp(((fours + sixes) / ballsFaced) * 100, 20)
	const milestones = normalizeUp((fifties + hundreds * 2) / innings, 0.5)
	const winningContribution = normalizeUp(stats.runsInWins / innings, 15)
	const pressureScore = normalizeUp(stats.runsWhileChasing / innings, 15)
	const dotBallPercent =
		ballsFaced === 0
			? 50
			: normalizeDown((stats.dotBallsFaced / ballsFaced) * 100, 30, 65)

	const weighted = [
		[runsPerInnings, 15],
		[battingAverage, 10],
		[strikeRate, 15],
		[boundaryPercent, 5],
		[milestones, 5],
		[winningContribution, 15],
		[pressureScore, 10],
		[dotBallPercent, 5]
	] as const

	const totalWeight = weighted.reduce((sum, [, weight]) => sum + weight, 0)
	const totalScore = weighted.reduce(
		(sum, [score, weight]) => sum + score * weight,
		0
	)
	return totalScore / totalWeight
}

function bowlingCareerScore(stats: BowlingCareerStats): number {
	const { innings, wickets, ballsBowled, runsConceded } = stats
	if (innings === 0) return 0

	const wicketsPerInnings = normalizeUp(wickets / innings, 1.5)
	const strikeRate =
		wickets === 0 ? 0 : normalizeDown(ballsBowled / wickets, 12, 36)
	const oversBowled = ballsBowled / 6
	const economy =
		oversBowled === 0 ? 0 : normalizeDown(runsConceded / oversBowled, 6, 11)
	const average =
		wickets === 0 ? 0 : normalizeDown(runsConceded / wickets, 15, 40)
	const maidensPerInnings = normalizeUp(stats.maidens / innings, 0.1)
	const dotBallPercent =
		ballsBowled === 0
			? 0
			: normalizeUp((stats.dotBallsBowled / ballsBowled) * 100, 45)
	const deathOvers = stats.deathOverBallsBowled / 6
	const deathEconomy =
		deathOvers === 0
			? economy
			: normalizeDown(stats.deathOverRunsConceded / deathOvers, 8, 14)
	const powerplayWickets = normalizeUp(stats.powerplayWickets / innings, 0.3)

	const weighted = [
		[wicketsPerInnings, 20],
		[strikeRate, 15],
		[economy, 20],
		[average, 10],
		[maidensPerInnings, 5],
		[dotBallPercent, 10],
		[deathEconomy, 10],
		[powerplayWickets, 5]
	] as const

	const totalWeight = weighted.reduce((sum, [, weight]) => sum + weight, 0)
	const totalScore = weighted.reduce(
		(sum, [score, weight]) => sum + score * weight,
		0
	)
	return totalScore / totalWeight
}

/** Catches + run-outs + stumpings per match played, normalized. Shared across all roles. */
function fieldingScore(fielding: FieldingStats, matchesPlayed: number): number {
	if (matchesPlayed === 0) return 0
	const contributionsPerMatch =
		(fielding.catches + fielding.runOuts + fielding.stumpings) / matchesPlayed
	return normalizeUp(contributionsPerMatch, 0.4)
}

/**
 * Innings count at which a batting/bowling career score is trusted at full weight.
 * Below this, small-sample noise (one big night out) can otherwise put a debutant
 * above a proven career performer — see shrinkTowardNeutral.
 */
const RELIABLE_INNINGS_THRESHOLD = 15
const NEUTRAL_SCORE = 50

/**
 * Regresses a raw 0-100 score toward the neutral midpoint as `innings` falls short of
 * RELIABLE_INNINGS_THRESHOLD, standard small-sample shrinkage: a single standout
 * innings shouldn't outscore a long, consistently good career. At the threshold and
 * above, the raw score passes through unchanged.
 */
function shrinkTowardNeutral(rawScore: number, innings: number): number {
	const confidence = normalizeUp(innings, RELIABLE_INNINGS_THRESHOLD) / 100
	return rawScore * confidence + NEUTRAL_SCORE * (1 - confidence)
}

/**
 * 40% of the overall impact score. Batter/bowler use their respective metric tables;
 * an all-rounder blends both plus fielding (83/79/90 -> 82.1 in the brief's example,
 * i.e. 45% batting + 45% bowling + 10% fielding). Each discipline's score is shrunk
 * toward neutral first when its innings count is small — see shrinkTowardNeutral.
 */
export function computeCareerPerformanceScore(
	input: Pick<
		PlayerScoringInput,
		'role' | 'batting' | 'bowling' | 'fielding' | 'matchesPlayed'
	>
): number {
	const battingScore = shrinkTowardNeutral(
		battingCareerScore(input.batting),
		input.batting.innings
	)
	const bowlingScore = shrinkTowardNeutral(
		bowlingCareerScore(input.bowling),
		input.bowling.innings
	)
	const fielding = fieldingScore(input.fielding, input.matchesPlayed)

	switch (input.role) {
		case 'batter':
			return battingScore
		case 'bowler':
			return bowlingScore
		case 'allrounder':
			return battingScore * 0.45 + bowlingScore * 0.45 + fielding * 0.1
	}
}

/**
 * 35% of the overall impact score, from the last 5 innings (chronological, whichever
 * discipline the player actually appeared in — an all-rounder's entries can carry both
 * batting and bowling figures for the same innings).
 */
export function computeRecentFormScore(
	role: PlayerRole,
	recentInnings: InningsFormEntry[]
): number {
	const last5 = [...recentInnings]
		.sort((a, b) => a.date.localeCompare(b.date))
		.slice(-RECENT_FORM_WINDOW)
	if (last5.length === 0) return 0

	const runs = last5.reduce((sum, i) => sum + i.runsScored, 0)
	const ballsFaced = last5.reduce((sum, i) => sum + i.ballsFaced, 0)
	const wickets = last5.reduce((sum, i) => sum + i.wicketsTaken, 0)
	const ballsBowled = last5.reduce((sum, i) => sum + i.ballsBowled, 0)
	const runsConceded = last5.reduce((sum, i) => sum + i.runsConceded, 0)

	const battingForm =
		0.6 * normalizeUp(runs / last5.length, 40) +
		0.4 * (ballsFaced === 0 ? 0 : normalizeUp((runs / ballsFaced) * 100, 150))

	const oversBowled = ballsBowled / 6
	const bowlingForm =
		0.6 * normalizeUp(wickets / last5.length, 1.5) +
		0.4 *
			(oversBowled === 0 ? 0 : normalizeDown(runsConceded / oversBowled, 6, 11))

	switch (role) {
		case 'batter':
			return battingForm
		case 'bowler':
			return bowlingForm
		case 'allrounder':
			return (battingForm + bowlingForm) / 2
	}
}

/**
 * 15% of the overall impact score: matchday achievement bonuses (Player of Match,
 * winning knock, defended target, etc. — see the bonus table this implements in
 * cricsheet.ts) averaged per match played.
 */
export function computeMatchImpactScore(
	tally: MatchImpactTally,
	matchesPlayed: number
): number {
	if (matchesPlayed === 0) return 0
	return normalizeUp(tally.bonusPoints / matchesPlayed, 3)
}

/**
 * 10% of the overall impact score: how tough the player's average opponent and venue
 * were, averaged across matches played.
 */
export function computeDifficultyScore(
	tally: DifficultyTally,
	matchesPlayed: number
): number {
	if (matchesPlayed === 0) return 50
	const avgOpponentMultiplier = tally.opponentMultiplierSum / matchesPlayed
	const avgVenueMultiplier = tally.venueMultiplierSum / matchesPlayed

	const opponentScore = normalizeUp(avgOpponentMultiplier - 1.0, 0.2)
	const venueScore = normalizeUp(avgVenueMultiplier - 0.9, 0.25)
	return (opponentScore + venueScore) / 2
}

/** The headline scouting number: 40% career performance + 35% recent form + 15% match impact + 10% difficulty. */
export function computeImpactScore(input: PlayerScoringInput): number {
	const careerPerformance = computeCareerPerformanceScore(input)
	const recentForm = computeRecentFormScore(input.role, input.recentInnings)
	const matchImpact = computeMatchImpactScore(
		input.matchImpact,
		input.matchesPlayed
	)
	const difficulty = computeDifficultyScore(
		input.difficulty,
		input.matchesPlayed
	)

	return round1(
		clamp(
			careerPerformance * 0.4 +
				recentForm * 0.35 +
				matchImpact * 0.15 +
				difficulty * 0.1
		)
	)
}

/**
 * Age potential and fitness/availability both need data Cricsheet doesn't have (DOB,
 * injury history). Both are proxied from the same timeline Cricsheet does give us:
 * - Age potential: a player closer to their Cricsheet debut is treated as having more
 *   room to grow than a player who has been active for a decade — a proxy for youth,
 *   not a substitute for it. This floors at 40 rather than decaying to 0: a proven
 *   decade-plus veteran (the exact profile real auctions pay the most for) isn't worth
 *   *zero* on age-related value just for having a long track record — a hard zero here
 *   was capping every established star's auctionScore well below the top price band
 *   regardless of how good their current form actually was.
 * - Fitness/availability: a player who appeared recently (relative to the newest match
 *   in the whole ingested dataset — Cricsheet archives are a periodic bulk export, not
 *   a live feed, so "recently" is relative to the data, not to today) is scored as more
 *   available than one whose last appearance is old.
 */
function agePotentialScore(yearsSinceDebut: number): number {
	return clamp(100 - yearsSinceDebut * 4, 40)
}

function fitnessAvailabilityScore(daysSinceLastAppearance: number): number {
	return clamp(100 - daysSinceLastAppearance / 3.65)
}

function experienceScore(matchesPlayed: number): number {
	return normalizeUp(matchesPlayed, 100)
}

export interface AuctionScoreInput {
	impactScore: number
	recentFormScore: number
	fieldingScore: number
	yearsSinceDebut: number
	daysSinceLastAppearance: number
	matchesPlayed: number
	/**
	 * Career performance score computed from Syed Mushtaq Ali Trophy figures only (the
	 * domestic competition in scope). Falls back to the overall career performance
	 * score when the player has no SMAT innings at all (e.g. IPL-only record).
	 */
	domesticPerformanceScore: number
}

/** 30% impact + 20% recent form + 15% age potential + 10% fitness + 10% domestic + 10% fielding + 5% experience. */
export function computeAuctionScore(input: AuctionScoreInput): number {
	const agePotential = agePotentialScore(input.yearsSinceDebut)
	const fitness = fitnessAvailabilityScore(input.daysSinceLastAppearance)
	const experience = experienceScore(input.matchesPlayed)

	return round1(
		clamp(
			input.impactScore * 0.3 +
				input.recentFormScore * 0.2 +
				agePotential * 0.15 +
				fitness * 0.1 +
				input.domesticPerformanceScore * 0.1 +
				input.fieldingScore * 0.1 +
				experience * 0.05
		)
	)
}

const BASE_PRICE_LABEL = 'Base Price (₹20L)'

/** Auction score -> estimated price band, per the brief's table. Below 60 sits at the standard IPL base price. */
export function estimatedPriceRangeFromAuctionScore(
	auctionScore: number
): EstimatedPriceRange {
	if (auctionScore >= 90)
		return { minLakh: 1000, maxLakh: 2000, label: '₹10-20 Cr' }
	if (auctionScore >= 80)
		return { minLakh: 500, maxLakh: 1000, label: '₹5-10 Cr' }
	if (auctionScore >= 70)
		return { minLakh: 200, maxLakh: 500, label: '₹2-5 Cr' }
	if (auctionScore >= 60)
		return { minLakh: 50, maxLakh: 200, label: '₹50L-2 Cr' }
	return { minLakh: 20, maxLakh: 20, label: BASE_PRICE_LABEL }
}

export { fieldingScore }
