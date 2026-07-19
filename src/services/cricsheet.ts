// Cricsheet integration (https://cricsheet.org) — the shared data source behind every
// endpoint in this project that needs real cricket player/match data.
//
// Cricsheet has no live query API: it publishes bulk per-competition archives (a zip of
// one JSON file per match). This service downloads the relevant archives, parses every
// match, and folds them into an in-memory player index that the rest of the app
// queries synchronously. The index — including every player's impactScore and
// estimatedPriceRange — is built once and cached on a TTL (config.cricsheetConfig)
// rather than recomputed per request, so the players-list endpoint stays O(players) for
// filtering/pagination only. See ./scoring.ts for the scoring formulas themselves.
//
// Scope (docs/02-sections-detailed.md §1): IPL and the Syed Mushtaq Ali Trophy only.
// Ranji Trophy and Vijay Hazare Trophy are not published by Cricsheet at all, so they
// are out of scope until another match-data source is wired in. Both competitions are
// T20s, which the phase-based metrics below (powerplay/middle/death overs) assume.
//
// Archives ingested, and why:
//   - "india"  (by-country bucket, /downloads/india_json.zip) — NOT a source of listed
//     players. Used only to seed the "who counts as Indian" identity set (see below),
//     via each match's roster — no ball-by-ball parsing is done on this archive.
//   - "sma"    (/downloads/sma_json.zip) — the Syed Mushtaq Ali Trophy, India's
//     domestic T20 competition contested by BCCI state/zone sides. Every participant
//     is Indian by BCCI eligibility rules, so this also seeds the identity set.
//   - "ipl"    (/downloads/ipl_json.zip) — Indian Premier League. Rosters mix Indian
//     and overseas players and Cricsheet does not label which is which, so IPL
//     appearances are only credited to players already confirmed Indian via the
//     "india" or "sma" sources above. An Indian player who has appeared *only* in IPL,
//     with no Cricsheet-visible international or Syed Mushtaq Ali Trophy record, is a
//     known gap of this data source and will not appear.
//
// battingHand, bowlingStyle and age are not computed here at all — Cricsheet publishes
// no biographical data (no DOB, no handedness, no bowling arm/type) for any player, and
// nothing below fabricates one. See the doc comment in ../types/players.ts.
//
// impactScore and estimatedPriceRange ARE computed here, from figures Cricsheet does
// publish (deliveries, wickets, match outcomes, player-of-match). Where the brief's
// formula calls for something Cricsheet has no dataset for at all (opponent rank, venue
// pitch rating, age, fitness/availability), a proxy derived from the ingested matches
// themselves is used instead — each documented at its use site and in ./scoring.ts.
//
// Scoring scope: a player is scored on IPL alone when their IPL career is substantial
// (>= MIN_SUBSTANTIAL_IPL_MATCHES matches). Below that — including players with no IPL
// record at all — their Syed Mushtaq Ali Trophy totals are folded in too (see
// resolveScoringTotals), so a player who hasn't played much IPL is scored on their
// actual body of work rather than a handful of cameo appearances. `matches`/`innings`
// on CricketPlayer reflect whichever scope was used.

import axios from 'axios'
import JSZip from 'jszip'
import config from '../configs/config'
import {
	computeAuctionScore,
	computeCareerPerformanceScore,
	computeImpactScore,
	computeRecentFormScore,
	estimatedPriceRangeFromAuctionScore,
	fieldingScore as computeFieldingScore,
	type BattingCareerStats,
	type BowlingCareerStats,
	type DifficultyTally,
	type FieldingStats,
	type InningsFormEntry,
	type MatchImpactTally
} from './scoring'
import { fetchPlayerProfiles } from './playerProfiles'
import type {
	CricketPlayer,
	CricketPlayersFilter,
	CricketPlayersListData,
	DomesticCompetition,
	PlayerRole
} from '../types/players'

/** The subset of a Cricsheet match JSON file this service reads. */
interface CricsheetMatchInfo {
	team_type: string
	teams: string[]
	dates?: string[]
	players?: Record<string, string[]>
	registry?: {
		people?: Record<string, string>
	}
	/** Present once the match has a decisive result; absent for ties/no-results/abandoned matches. */
	outcome?: {
		winner?: string
		by?: { runs?: number; wickets?: number }
	}
	/** Names as they appear in `players`, not registry ids — resolved via resolvePlayerId. */
	player_of_match?: string[]
	venue?: string
}

interface CricsheetFielder {
	name?: string
}

interface CricsheetWicket {
	player_out: string
	kind: string
	fielders?: CricsheetFielder[]
}

interface CricsheetDelivery {
	batter: string
	bowler: string
	non_striker: string
	runs: { batter: number; extras: number; total: number }
	extras?: { wides?: number; noballs?: number; byes?: number; legbyes?: number }
	wickets?: CricsheetWicket[]
}

interface CricsheetOver {
	/** 0-indexed over number. Falls back to array position when absent (see readOverNumber). */
	over?: number
	deliveries: CricsheetDelivery[]
}

interface CricsheetInnings {
	team?: string
	overs?: CricsheetOver[]
	/** true on the (0-2 additional) super-over innings entries appended after a tie. */
	super_over?: boolean
}

interface CricsheetMatch {
	info: CricsheetMatchInfo
	innings?: CricsheetInnings[]
}

/**
 * Dismissal kinds credited to the bowler. Run outs, obstruction, timed out and the
 * retirements are not the bowler's doing, so they're excluded.
 */
const BOWLER_CREDITED_DISMISSAL_KINDS = new Set([
	'bowled',
	'caught',
	'caught and bowled',
	'lbw',
	'stumped',
	'hit wicket'
])

/** T20 over-phase boundaries (0-indexed over numbers), used for the phase-based metrics in scoring.ts. */
const POWERPLAY_LAST_OVER = 5
const DEATH_FIRST_OVER = 15

const HALF_CENTURY_RUNS = 50
const CENTURY_RUNS = 100

/** Matchday achievement bonus points (docs bonus table). */
const BONUS_PLAYER_OF_MATCH = 5
const BONUS_WINNING_KNOCK = 4
const BONUS_DEFENDED_TARGET = 4
const BONUS_MATCH_WINNING_SPELL = 4
const BONUS_SUPER_OVER_PERFORMANCE = 5
const BONUS_KNOCK_IN_CHASE = 3

/** Runs threshold for a "winning knock" / "knock in chase" bonus — a genuine match-shaping contribution, not just any not-out. */
const NOTABLE_KNOCK_RUNS = 30
/** Wickets threshold for a "match winning spell" bonus. */
const MATCH_WINNING_WICKETS = 3

function createBattingStats(): BattingCareerStats {
	return {
		innings: 0,
		runs: 0,
		ballsFaced: 0,
		outs: 0,
		fours: 0,
		sixes: 0,
		fifties: 0,
		hundreds: 0,
		dotBallsFaced: 0,
		runsInWins: 0,
		runsWhileChasing: 0
	}
}

function createBowlingStats(): BowlingCareerStats {
	return {
		innings: 0,
		wickets: 0,
		ballsBowled: 0,
		runsConceded: 0,
		maidens: 0,
		dotBallsBowled: 0,
		powerplayWickets: 0,
		deathOverBallsBowled: 0,
		deathOverRunsConceded: 0
	}
}

function createFieldingStats(): FieldingStats {
	return { catches: 0, runOuts: 0, stumpings: 0 }
}

/** Running per-competition totals for one player; never exposed directly. */
interface CompetitionTotals {
	matches: number
	teams: Set<string>
	batting: BattingCareerStats
	bowling: BowlingCareerStats
	fielding: FieldingStats
	recentInnings: InningsFormEntry[]
	matchImpact: MatchImpactTally
	difficulty: DifficultyTally
}

function createCompetitionTotals(): CompetitionTotals {
	return {
		matches: 0,
		teams: new Set(),
		batting: createBattingStats(),
		bowling: createBowlingStats(),
		fielding: createFieldingStats(),
		recentInnings: [],
		matchImpact: { bonusPoints: 0 },
		difficulty: { opponentMultiplierSum: 0, venueMultiplierSum: 0 }
	}
}

function mergeBattingStats(
	a: BattingCareerStats,
	b: BattingCareerStats
): BattingCareerStats {
	return {
		innings: a.innings + b.innings,
		runs: a.runs + b.runs,
		ballsFaced: a.ballsFaced + b.ballsFaced,
		outs: a.outs + b.outs,
		fours: a.fours + b.fours,
		sixes: a.sixes + b.sixes,
		fifties: a.fifties + b.fifties,
		hundreds: a.hundreds + b.hundreds,
		dotBallsFaced: a.dotBallsFaced + b.dotBallsFaced,
		runsInWins: a.runsInWins + b.runsInWins,
		runsWhileChasing: a.runsWhileChasing + b.runsWhileChasing
	}
}

function mergeBowlingStats(
	a: BowlingCareerStats,
	b: BowlingCareerStats
): BowlingCareerStats {
	return {
		innings: a.innings + b.innings,
		wickets: a.wickets + b.wickets,
		ballsBowled: a.ballsBowled + b.ballsBowled,
		runsConceded: a.runsConceded + b.runsConceded,
		maidens: a.maidens + b.maidens,
		dotBallsBowled: a.dotBallsBowled + b.dotBallsBowled,
		powerplayWickets: a.powerplayWickets + b.powerplayWickets,
		deathOverBallsBowled: a.deathOverBallsBowled + b.deathOverBallsBowled,
		deathOverRunsConceded: a.deathOverRunsConceded + b.deathOverRunsConceded
	}
}

/**
 * Combines an IPL and a Syed Mushtaq Ali Trophy totals bag into one scoring scope —
 * used when a player's IPL sample is too small to score on its own. See
 * resolveScoringTotals, the only caller.
 */
function mergeCompetitionTotals(
	a: CompetitionTotals,
	b: CompetitionTotals
): CompetitionTotals {
	return {
		matches: a.matches + b.matches,
		teams: new Set([...a.teams, ...b.teams]),
		batting: mergeBattingStats(a.batting, b.batting),
		bowling: mergeBowlingStats(a.bowling, b.bowling),
		fielding: {
			catches: a.fielding.catches + b.fielding.catches,
			runOuts: a.fielding.runOuts + b.fielding.runOuts,
			stumpings: a.fielding.stumpings + b.fielding.stumpings
		},
		recentInnings: [...a.recentInnings, ...b.recentInnings],
		matchImpact: {
			bonusPoints: a.matchImpact.bonusPoints + b.matchImpact.bonusPoints
		},
		difficulty: {
			opponentMultiplierSum:
				a.difficulty.opponentMultiplierSum + b.difficulty.opponentMultiplierSum,
			venueMultiplierSum:
				a.difficulty.venueMultiplierSum + b.difficulty.venueMultiplierSum
		}
	}
}

/**
 * A player's IPL matches below which their IPL sample alone is too thin to score
 * fairly (a couple of cameo appearances vs. a full domestic season). Roughly a third
 * of a single IPL season's league matches.
 */
const MIN_SUBSTANTIAL_IPL_MATCHES = 5

/**
 * Scores every player primarily on their IPL career. When a player hasn't played much
 * IPL (below MIN_SUBSTANTIAL_IPL_MATCHES — including players with no IPL record at
 * all), their Syed Mushtaq Ali Trophy totals are folded in too, so the score reflects
 * their actual body of work instead of a handful of IPL cameos (or nothing at all).
 */
function resolveScoringTotals(entry: PlayerIndexEntry): CompetitionTotals {
	if (entry.ipl.matches >= MIN_SUBSTANTIAL_IPL_MATCHES) return entry.ipl
	return mergeCompetitionTotals(entry.ipl, entry.smat)
}

/** Mutable accumulator used while folding matches into the index; never exposed. */
interface PlayerIndexEntry {
	id: string
	name: string
	ipl: CompetitionTotals
	smat: CompetitionTotals
	/** Date (YYYY-MM-DD) of the most recent IPL match they've played, if any. */
	latestIplDate?: string
	/** The team they played for in that most recent IPL match. */
	latestIplTeam?: string
	/** Earliest ingested match date across both competitions — used for the age-potential proxy (scoring.ts). */
	firstMatchDate?: string
	/** Most recent ingested match date across both competitions — used for the fitness/availability proxy. */
	latestMatchDate?: string
}

/**
 * Downloads a Cricsheet competition archive.
 *
 * @param slug - Archive slug as used in the download URL, e.g. `"india"`, `"ipl"`,
 *   `"sma"` (resolves to `${CRICSHEET_BASE_URL}/downloads/${slug}_json.zip`).
 * @returns The raw zip file contents.
 */
async function downloadArchive(slug: string): Promise<Buffer> {
	const url = `${config.cricsheetConfig.CRICSHEET_BASE_URL}/downloads/${slug}_json.zip`
	const response = await axios.get<ArrayBuffer>(url, {
		responseType: 'arraybuffer',
		timeout: config.cricsheetConfig.CRICSHEET_REQUEST_TIMEOUT_MS
	})
	return Buffer.from(response.data)
}

/**
 * Unzips a Cricsheet archive and parses every match file within it.
 *
 * @param archive - Raw zip bytes, as returned by {@link downloadArchive}.
 * @returns Every successfully parsed match in the archive. Entries that fail to parse
 *   (or lack an `info` block) are skipped rather than failing the whole archive.
 */
async function extractMatches(archive: Buffer): Promise<CricsheetMatch[]> {
	const zip = await JSZip.loadAsync(archive)

	// Each entry's decompression is an independent I/O-bound operation (JSZip's
	// inflate runs on libuv's thread pool) — awaiting them one at a time in a loop
	// serializes ~1000+ per archive for no reason and was the single biggest
	// contributor to a cold build's latency. Firing them all at once lets the thread
	// pool actually overlap the work.
	const parsedEntries = await Promise.all(
		Object.values(zip.files)
			.filter((entry) => !entry.dir && entry.name.endsWith('.json'))
			.map(async (entry): Promise<CricsheetMatch | null> => {
				try {
					const text = await entry.async('string')
					const parsed = JSON.parse(text) as CricsheetMatch
					return parsed?.info ? parsed : null
				} catch {
					// Malformed archive entry — skip it rather than discarding the whole load.
					return null
				}
			})
	)

	return parsedEntries.filter(
		(match): match is CricsheetMatch => match !== null
	)
}

async function fetchArchiveMatches(slug: string): Promise<CricsheetMatch[]> {
	const archive = await downloadArchive(slug)
	return extractMatches(archive)
}

/** Resolves a player's stable Cricsheet identifier, falling back to their name. */
function resolvePlayerId(
	people: Record<string, string> | undefined,
	name: string
): string {
	return people?.[name] ?? name
}

function getOrCreateEntry(
	index: Map<string, PlayerIndexEntry>,
	id: string,
	name: string
): PlayerIndexEntry {
	let entry = index.get(id)
	if (!entry) {
		entry = {
			id,
			name,
			ipl: createCompetitionTotals(),
			smat: createCompetitionTotals()
		}
		index.set(id, entry)
	} else {
		entry.name = name
	}
	return entry
}

/**
 * Walks every match India's international side has played and returns the set of
 * player ids who represented India — the nationality signal Cricsheet doesn't publish
 * directly. No ball-by-ball parsing: only the team roster is read.
 */
function seedIndianIdentity(matches: CricsheetMatch[]): Set<string> {
	const ids = new Set<string>()
	for (const { info } of matches) {
		if (info.team_type !== 'international' || !info.teams.includes('India')) {
			continue
		}
		for (const playerName of info.players?.['India'] ?? []) {
			ids.add(resolvePlayerId(info.registry?.people, playerName))
		}
	}
	return ids
}

/**
 * Ranks teams within one competition by win rate and maps each to the docs' opponent-
 * difficulty multiplier (top 3 -> 1.20, next 3 -> 1.10, everyone else -> 1.00).
 *
 * Cricsheet has no team-ranking dataset, so this is entirely derived from the ingested
 * matches: a team's "rank" is just how often it won within this same archive. Teams
 * with too few decisive matches to rank meaningfully (< MIN_MATCHES_TO_RANK) are left
 * out of the map and default to the 1.00 "Others" multiplier at lookup time.
 */
const MIN_MATCHES_TO_RANK_TEAM = 5
const TOP_TIER_TEAM_COUNT = 3
const SECOND_TIER_TEAM_COUNT = 6

function buildTeamStrengthRatings(
	matches: CricsheetMatch[]
): Map<string, number> {
	const record = new Map<string, { wins: number; matches: number }>()

	for (const { info } of matches) {
		if (info.teams.length !== 2) continue
		for (const team of info.teams) {
			const teamRecord = record.get(team) ?? { wins: 0, matches: 0 }
			teamRecord.matches += 1
			if (info.outcome?.winner === team) teamRecord.wins += 1
			record.set(team, teamRecord)
		}
	}

	const ranked = Array.from(record.entries())
		.filter(([, r]) => r.matches >= MIN_MATCHES_TO_RANK_TEAM)
		.sort((a, b) => b[1].wins / b[1].matches - a[1].wins / a[1].matches)

	const ratings = new Map<string, number>()
	ranked.forEach(([team], rank) => {
		if (rank < TOP_TIER_TEAM_COUNT) ratings.set(team, 1.2)
		else if (rank < SECOND_TIER_TEAM_COUNT) ratings.set(team, 1.1)
		else ratings.set(team, 1.0)
	})
	return ratings
}

/**
 * Rates each venue's pitch as bowling-friendly (1.15x), balanced (1.00x) or batting-
 * friendly (0.90x), from the average first-innings total at that venue across the
 * ingested matches — Cricsheet has no pitch-rating dataset, so scoring conditions are
 * used as the proxy. Venues with too few sampled matches default to "balanced" (1.00)
 * at lookup time.
 */
const MIN_MATCHES_TO_RATE_VENUE = 3

function buildVenueDifficultyRatings(
	matches: CricsheetMatch[]
): Map<string, number> {
	const totals = new Map<string, { runs: number; matches: number }>()

	for (const { info, innings } of matches) {
		if (!info.venue) continue
		const firstInnings = innings?.find((i) => !i.super_over)
		if (!firstInnings) continue

		let runs = 0
		for (const over of firstInnings.overs ?? []) {
			for (const delivery of over.deliveries ?? []) {
				runs += delivery.runs.total
			}
		}

		const venueTotals = totals.get(info.venue) ?? { runs: 0, matches: 0 }
		venueTotals.runs += runs
		venueTotals.matches += 1
		totals.set(info.venue, venueTotals)
	}

	const rated = Array.from(totals.entries())
		.filter(([, t]) => t.matches >= MIN_MATCHES_TO_RATE_VENUE)
		.map(([venue, t]) => [venue, t.runs / t.matches] as const)
		.sort((a, b) => b[1] - a[1])

	const ratings = new Map<string, number>()
	const tierSize = Math.ceil(rated.length / 3)
	rated.forEach(([venue], index) => {
		if (index < tierSize) ratings.set(venue, 0.9)
		else if (index >= rated.length - tierSize) ratings.set(venue, 1.15)
		else ratings.set(venue, 1.0)
	})
	return ratings
}

/** 0-indexed over number, falling back to array position for the rare archive entry that omits it. */
function readOverNumber(over: CricsheetOver, position: number): number {
	return over.over ?? position
}

function isWide(delivery: CricsheetDelivery): boolean {
	return delivery.extras?.wides !== undefined
}

function isLegalDelivery(delivery: CricsheetDelivery): boolean {
	return (
		delivery.extras?.wides === undefined &&
		delivery.extras?.noballs === undefined
	)
}

function bowlerRunsConceded(delivery: CricsheetDelivery): number {
	const byes = delivery.extras?.byes ?? 0
	const legbyes = delivery.extras?.legbyes ?? 0
	return delivery.runs.total - byes - legbyes
}

/** Per-player figures accumulated for a single match, across every one of its (non-super-over) innings. Used only to compute matchday bonuses once the whole match has been folded. */
interface MatchPlayerTally {
	team: string
	runsScored: number
	ballsFaced: number
	wicketsTaken: number
	battedWhileChasing: boolean
	chaseRuns: number
	tookWicketInSuperOver: boolean
	scoredInSuperOver: boolean
}

function createMatchPlayerTally(team: string | undefined): MatchPlayerTally {
	return {
		team: team ?? '',
		runsScored: 0,
		ballsFaced: 0,
		wicketsTaken: 0,
		battedWhileChasing: false,
		chaseRuns: 0,
		tookWicketInSuperOver: false,
		scoredInSuperOver: false
	}
}

/**
 * A super over is a one-over tie-breaker — far too small a sample to fold into career
 * batting/bowling averages, so unlike a normal innings it never touches career totals.
 * It only ever feeds the "Super Over Performance" matchday bonus.
 */
function creditSuperOverPerformance(
	innings: CricsheetInnings,
	eligibleIds: Set<string>,
	matchTally: Map<string, MatchPlayerTally>,
	teamOf: Map<string, string>,
	people: Record<string, string> | undefined
): void {
	for (const over of innings.overs ?? []) {
		for (const delivery of over.deliveries ?? []) {
			const batterId = resolvePlayerId(people, delivery.batter)
			const bowlerId = resolvePlayerId(people, delivery.bowler)

			if (eligibleIds.has(batterId) && delivery.runs.batter > 0) {
				const tally =
					matchTally.get(batterId) ??
					createMatchPlayerTally(teamOf.get(batterId))
				tally.scoredInSuperOver = true
				matchTally.set(batterId, tally)
			}

			if (eligibleIds.has(bowlerId)) {
				const tookWicket = (delivery.wickets ?? []).some((wicket) =>
					BOWLER_CREDITED_DISMISSAL_KINDS.has(wicket.kind)
				)
				if (tookWicket) {
					const tally =
						matchTally.get(bowlerId) ??
						createMatchPlayerTally(teamOf.get(bowlerId))
					tally.tookWicketInSuperOver = true
					matchTally.set(bowlerId, tally)
				}
			}
		}
	}
}

/**
 * Folds every delivery of one innings into the relevant players' career batting/
 * bowling aggregates, recent-form entries and fielding tallies, and returns each
 * involved player's runs/wickets for this innings so the caller can accumulate
 * match-level totals for the bonus pass.
 *
 * `delivery.batter`/`bowler`/`non_striker` and `wicket.player_out`/`fielders[].name`
 * are all raw display names in Cricsheet's JSON, not registry ids — every one of them
 * is resolved via `people` before being compared against `eligibleIds` (which holds
 * resolved ids, built by the caller from the same registry).
 */
function creditInnings(
	innings: CricsheetInnings,
	isChasingInnings: boolean,
	eligibleIds: Set<string>,
	index: Map<string, PlayerIndexEntry>,
	competition: DomesticCompetition,
	matchDate: string | undefined,
	isWin: (team: string | undefined) => boolean,
	matchTally: Map<string, MatchPlayerTally>,
	teamOf: Map<string, string>,
	people: Record<string, string> | undefined
): void {
	const battingInningsStats = new Map<
		string,
		{
			runs: number
			balls: number
			fours: number
			sixes: number
			dots: number
			chaseRuns: number
		}
	>()
	const bowlingInningsStats = new Map<
		string,
		{
			wickets: number
			balls: number
			runsConceded: number
			dots: number
			powerplayWickets: number
			deathBalls: number
			deathRuns: number
		}
	>()
	const battedIds = new Set<string>()
	const bowledIds = new Set<string>()
	const outIds = new Set<string>()

	;(innings.overs ?? []).forEach((over, position) => {
		const overNumber = readOverNumber(over, position)
		const isPowerplay = overNumber <= POWERPLAY_LAST_OVER
		const isDeath = overNumber >= DEATH_FIRST_OVER

		let overLegalBalls = 0
		let overRuns = 0
		let overBowlerId: string | undefined

		for (const delivery of over.deliveries ?? []) {
			const batterId = resolvePlayerId(people, delivery.batter)
			const nonStrikerId = resolvePlayerId(people, delivery.non_striker)
			const bowlerId = resolvePlayerId(people, delivery.bowler)
			const legal = isLegalDelivery(delivery)
			const wide = isWide(delivery)
			overBowlerId = bowlerId

			if (eligibleIds.has(batterId)) {
				battedIds.add(batterId)
				const stats = battingInningsStats.get(batterId) ?? {
					runs: 0,
					balls: 0,
					fours: 0,
					sixes: 0,
					dots: 0,
					chaseRuns: 0
				}
				stats.runs += delivery.runs.batter
				if (!wide) stats.balls += 1
				if (delivery.runs.batter === 4) stats.fours += 1
				if (delivery.runs.batter === 6) stats.sixes += 1
				if (!wide && delivery.runs.total === 0) stats.dots += 1
				if (isChasingInnings) stats.chaseRuns += delivery.runs.batter
				battingInningsStats.set(batterId, stats)
			}
			if (eligibleIds.has(nonStrikerId)) battedIds.add(nonStrikerId)

			if (eligibleIds.has(bowlerId)) {
				bowledIds.add(bowlerId)
				const stats = bowlingInningsStats.get(bowlerId) ?? {
					wickets: 0,
					balls: 0,
					runsConceded: 0,
					dots: 0,
					powerplayWickets: 0,
					deathBalls: 0,
					deathRuns: 0
				}
				const conceded = bowlerRunsConceded(delivery)
				if (legal) {
					stats.balls += 1
					if (conceded === 0) stats.dots += 1
					if (isDeath) {
						stats.deathBalls += 1
						stats.deathRuns += conceded
					}
				}
				stats.runsConceded += conceded
				bowlingInningsStats.set(bowlerId, stats)

				for (const wicket of delivery.wickets ?? []) {
					if (BOWLER_CREDITED_DISMISSAL_KINDS.has(wicket.kind)) {
						stats.wickets += 1
						if (isPowerplay) stats.powerplayWickets += 1
					}
				}
			}

			overLegalBalls += legal ? 1 : 0
			overRuns += delivery.runs.total

			for (const wicket of delivery.wickets ?? []) {
				const outId = resolvePlayerId(people, wicket.player_out)
				if (eligibleIds.has(outId)) outIds.add(outId)

				if (
					wicket.kind === 'run out' ||
					wicket.kind === 'caught' ||
					wicket.kind === 'stumped'
				) {
					for (const fielder of wicket.fielders ?? []) {
						if (!fielder.name) continue
						const fielderId = resolvePlayerId(people, fielder.name)
						if (!eligibleIds.has(fielderId)) continue
						const entry = index.get(fielderId)
						if (!entry) continue
						const fielding = entry[competition].fielding
						if (wicket.kind === 'run out') fielding.runOuts += 1
						else if (wicket.kind === 'stumped') fielding.stumpings += 1
						else fielding.catches += 1
					}
				}
			}
		}

		// A maiden requires a completed, extras-free legal over — 6 legal deliveries and
		// 0 runs conceded off the over as a whole — credited only to the over's bowler.
		if (
			overLegalBalls === 6 &&
			overRuns === 0 &&
			overBowlerId &&
			eligibleIds.has(overBowlerId)
		) {
			const entry = index.get(overBowlerId)
			if (entry) entry[competition].bowling.maidens += 1
		}
	})

	for (const id of new Set([...battedIds, ...bowledIds])) {
		const entry = index.get(id)
		if (!entry) continue
		const totals = entry[competition]

		const bat = battingInningsStats.get(id)
		const bowl = bowlingInningsStats.get(id)

		if (bat) {
			totals.batting.innings += 1
			totals.batting.runs += bat.runs
			totals.batting.ballsFaced += bat.balls
			totals.batting.fours += bat.fours
			totals.batting.sixes += bat.sixes
			totals.batting.dotBallsFaced += bat.dots
			if (outIds.has(id)) totals.batting.outs += 1
			if (bat.runs >= CENTURY_RUNS) totals.batting.hundreds += 1
			else if (bat.runs >= HALF_CENTURY_RUNS) totals.batting.fifties += 1
			if (isWin(teamOf.get(id))) totals.batting.runsInWins += bat.runs
			if (isChasingInnings) totals.batting.runsWhileChasing += bat.chaseRuns
		}

		if (bowl) {
			totals.bowling.innings += 1
			totals.bowling.wickets += bowl.wickets
			totals.bowling.ballsBowled += bowl.balls
			totals.bowling.runsConceded += bowl.runsConceded
			totals.bowling.dotBallsBowled += bowl.dots
			totals.bowling.powerplayWickets += bowl.powerplayWickets
			totals.bowling.deathOverBallsBowled += bowl.deathBalls
			totals.bowling.deathOverRunsConceded += bowl.deathRuns
		}

		if (matchDate) {
			totals.recentInnings.push({
				date: matchDate,
				runsScored: bat?.runs ?? 0,
				ballsFaced: bat?.balls ?? 0,
				wicketsTaken: bowl?.wickets ?? 0,
				runsConceded: bowl?.runsConceded ?? 0,
				ballsBowled: bowl?.balls ?? 0
			})
		}

		const tally = matchTally.get(id) ?? createMatchPlayerTally(teamOf.get(id))
		tally.runsScored += bat?.runs ?? 0
		tally.ballsFaced += bat?.balls ?? 0
		tally.wicketsTaken += bowl?.wickets ?? 0
		if (isChasingInnings && bat) {
			tally.battedWhileChasing = true
			tally.chaseRuns += bat.chaseRuns
		}
		matchTally.set(id, tally)
	}
}

/**
 * Applies the matchday achievement bonuses (docs table) to each involved player's
 * matchImpact tally, once per match. Cricsheet gives us the winner, the margin (runs
 * vs wickets, i.e. defended vs chased) and the official player-of-match — every bonus
 * below is derived directly from those, no proxy needed.
 */
function applyMatchBonuses(
	info: CricsheetMatchInfo,
	matchTally: Map<string, MatchPlayerTally>,
	index: Map<string, PlayerIndexEntry>,
	competition: DomesticCompetition,
	playerOfMatchIds: Set<string>,
	hadSuperOver: boolean
): void {
	const winner = info.outcome?.winner
	const wonByDefending = info.outcome?.by?.runs !== undefined
	const wonByChasing = info.outcome?.by?.wickets !== undefined

	for (const [id, tally] of matchTally) {
		const entry = index.get(id)
		if (!entry) continue
		const totals = entry[competition]
		let bonus = 0

		if (playerOfMatchIds.has(id)) bonus += BONUS_PLAYER_OF_MATCH

		const won = winner !== undefined && winner === tally.team
		if (won && tally.runsScored >= NOTABLE_KNOCK_RUNS)
			bonus += BONUS_WINNING_KNOCK
		if (won && wonByDefending && tally.wicketsTaken >= 1)
			bonus += BONUS_DEFENDED_TARGET
		if (won && tally.wicketsTaken >= MATCH_WINNING_WICKETS)
			bonus += BONUS_MATCH_WINNING_SPELL
		if (
			won &&
			wonByChasing &&
			tally.battedWhileChasing &&
			tally.chaseRuns >= NOTABLE_KNOCK_RUNS
		) {
			bonus += BONUS_KNOCK_IN_CHASE
		}
		if (
			hadSuperOver &&
			(tally.tookWicketInSuperOver || tally.scoredInSuperOver)
		) {
			bonus += BONUS_SUPER_OVER_PERFORMANCE
		}

		totals.matchImpact.bonusPoints += bonus
	}
}

/**
 * Folds every match in `matches` into `index` for `competition`, crediting each
 * roster player's team/match count, ball-by-ball figures, and matchday bonuses. When
 * `restrictTo` is provided (the IPL pass), only players already confirmed Indian are
 * credited — see the module doc for why.
 */
function foldDomesticMatches(
	matches: CricsheetMatch[],
	index: Map<string, PlayerIndexEntry>,
	competition: DomesticCompetition,
	teamStrength: Map<string, number>,
	venueDifficulty: Map<string, number>,
	options: { restrictTo?: Set<string>; collectIds?: Set<string> }
): void {
	for (const match of matches) {
		const { info } = match
		const eligibleIds = new Set<string>()
		const teamOf = new Map<string, string>()
		const matchDate = info.dates?.[0]
		const venueMultiplier = info.venue
			? (venueDifficulty.get(info.venue) ?? 1.0)
			: 1.0

		for (const team of info.teams) {
			const opponentTeam = info.teams.find((t) => t !== team)
			const opponentMultiplier = opponentTeam
				? (teamStrength.get(opponentTeam) ?? 1.0)
				: 1.0

			for (const playerName of info.players?.[team] ?? []) {
				const id = resolvePlayerId(info.registry?.people, playerName)
				if (options.restrictTo && !options.restrictTo.has(id)) continue

				const entry = getOrCreateEntry(index, id, playerName)
				const totals = entry[competition]
				totals.teams.add(team)
				totals.matches += 1
				totals.difficulty.opponentMultiplierSum += opponentMultiplier
				totals.difficulty.venueMultiplierSum += venueMultiplier

				if (matchDate) {
					if (!entry.firstMatchDate || matchDate < entry.firstMatchDate) {
						entry.firstMatchDate = matchDate
					}
					if (!entry.latestMatchDate || matchDate > entry.latestMatchDate) {
						entry.latestMatchDate = matchDate
					}
					if (
						competition === 'ipl' &&
						(!entry.latestIplDate || matchDate > entry.latestIplDate)
					) {
						entry.latestIplDate = matchDate
						entry.latestIplTeam = team
					}
				}

				teamOf.set(id, team)
				eligibleIds.add(id)
				options.collectIds?.add(id)
			}
		}

		if (eligibleIds.size === 0) continue

		const isWin = (team: string | undefined): boolean =>
			team !== undefined && info.outcome?.winner === team

		const people = info.registry?.people
		const matchTally = new Map<string, MatchPlayerTally>()
		let normalInningsIndex = 0
		let hadSuperOver = false

		for (const innings of match.innings ?? []) {
			if (innings.super_over) {
				hadSuperOver = true
				creditSuperOverPerformance(
					innings,
					eligibleIds,
					matchTally,
					teamOf,
					people
				)
				continue
			}
			const isChasingInnings = normalInningsIndex === 1
			creditInnings(
				innings,
				isChasingInnings,
				eligibleIds,
				index,
				competition,
				matchDate,
				isWin,
				matchTally,
				teamOf,
				people
			)
			normalInningsIndex += 1
		}

		const playerOfMatchIds = new Set(
			(info.player_of_match ?? []).map((name) =>
				resolvePlayerId(info.registry?.people, name)
			)
		)
		applyMatchBonuses(
			info,
			matchTally,
			index,
			competition,
			playerOfMatchIds,
			hadSuperOver
		)
	}
}

/** Aggregate figures across both competitions, used only to classify {@link PlayerRole}. */
interface CareerTotals {
	battingInnings: number
	runs: number
	bowlingInnings: number
	wickets: number
}

const MIN_SUBSTANTIAL_BATTING_INNINGS = 10
const MIN_SUBSTANTIAL_BATTING_RUNS = 200
const MIN_SUBSTANTIAL_BOWLING_INNINGS = 10
const MIN_SUBSTANTIAL_BOWLING_WICKETS = 10

/**
 * Classifies a player's role from career totals across IPL + Syed Mushtaq Ali Trophy.
 * Cricsheet has no role field to read directly, so this is a heuristic: the
 * thresholds are a rough bar for "this isn't just a handful of part-time overs or
 * tail-end runs".
 */
function classifyRole(totals: CareerTotals): PlayerRole {
	const hasSubstantialBatting =
		totals.battingInnings >= MIN_SUBSTANTIAL_BATTING_INNINGS &&
		totals.runs >= MIN_SUBSTANTIAL_BATTING_RUNS
	const hasSubstantialBowling =
		totals.bowlingInnings >= MIN_SUBSTANTIAL_BOWLING_INNINGS &&
		totals.wickets >= MIN_SUBSTANTIAL_BOWLING_WICKETS

	if (hasSubstantialBatting && hasSubstantialBowling) return 'allrounder'
	if (hasSubstantialBowling) return 'bowler'
	return 'batter'
}

const MS_PER_DAY = 24 * 60 * 60 * 1000
const DAYS_PER_YEAR = 365.25

function daysBetween(earlier: string, later: string): number {
	return Math.max(
		0,
		(new Date(later).getTime() - new Date(earlier).getTime()) / MS_PER_DAY
	)
}

/**
 * Downloads and parses every configured Cricsheet archive, building the in-memory
 * index of Indian IPL and Syed Mushtaq Ali Trophy players — including each player's
 * impactScore and estimatedPriceRange, computed once here rather than per request.
 * See the module doc for the ingestion order and why IPL is filtered against the
 * other two sources.
 */
async function buildPlayerIndex(): Promise<CricketPlayer[]> {
	const index = new Map<string, PlayerIndexEntry>()

	const [indiaMatches, smatMatches, iplMatches] = await Promise.all([
		fetchArchiveMatches('india'),
		fetchArchiveMatches('sma'),
		fetchArchiveMatches('ipl')
	])

	const indianIds = seedIndianIdentity(indiaMatches)

	const smatTeamStrength = buildTeamStrengthRatings(smatMatches)
	const iplTeamStrength = buildTeamStrengthRatings(iplMatches)
	const venueDifficulty = buildVenueDifficultyRatings([
		...smatMatches,
		...iplMatches
	])

	foldDomesticMatches(
		smatMatches,
		index,
		'smat',
		smatTeamStrength,
		venueDifficulty,
		{
			collectIds: indianIds
		}
	)
	foldDomesticMatches(
		iplMatches,
		index,
		'ipl',
		iplTeamStrength,
		venueDifficulty,
		{
			restrictTo: indianIds
		}
	)

	const newestMatchDate = [...smatMatches, ...iplMatches].reduce<
		string | undefined
	>((latest, { info }) => {
		const date = info.dates?.[0]
		if (!date) return latest
		return !latest || date > latest ? date : latest
	}, undefined)

	const players = Array.from(index.values()).map((entry): CricketPlayer => {
		const competition: DomesticCompetition =
			entry.ipl.matches > 0 ? 'ipl' : 'smat'
		const totals = resolveScoringTotals(entry)
		const teams = new Set<string>([...entry.ipl.teams, ...entry.smat.teams])

		const role = classifyRole({
			battingInnings: entry.ipl.batting.innings + entry.smat.batting.innings,
			runs: entry.ipl.batting.runs + entry.smat.batting.runs,
			bowlingInnings: entry.ipl.bowling.innings + entry.smat.bowling.innings,
			wickets: entry.ipl.bowling.wickets + entry.smat.bowling.wickets
		})

		const matchesPlayed = totals.matches
		const fielding = totals.fielding
		const careerPerformanceScore = computeCareerPerformanceScore({
			role,
			batting: totals.batting,
			bowling: totals.bowling,
			fielding,
			matchesPlayed
		})
		const recentFormScore = computeRecentFormScore(role, totals.recentInnings)
		const fieldingScoreValue = computeFieldingScore(fielding, matchesPlayed)

		const impactScore = computeImpactScore({
			role,
			batting: totals.batting,
			bowling: totals.bowling,
			fielding,
			recentInnings: totals.recentInnings,
			matchImpact: totals.matchImpact,
			difficulty: totals.difficulty,
			matchesPlayed,
			yearsSinceDebut: 0,
			daysSinceLastAppearance: 0
		})

		const yearsSinceDebut = entry.firstMatchDate
			? daysBetween(
					entry.firstMatchDate,
					newestMatchDate ?? entry.firstMatchDate
				) / DAYS_PER_YEAR
			: 0
		const daysSinceLastAppearance =
			entry.latestMatchDate && newestMatchDate
				? daysBetween(entry.latestMatchDate, newestMatchDate)
				: 0

		const smatHasInnings =
			entry.smat.batting.innings > 0 || entry.smat.bowling.innings > 0
		const domesticPerformanceScore = smatHasInnings
			? computeCareerPerformanceScore({
					role,
					batting: entry.smat.batting,
					bowling: entry.smat.bowling,
					fielding: entry.smat.fielding,
					matchesPlayed: entry.smat.matches
				})
			: careerPerformanceScore

		const auctionScore = computeAuctionScore({
			impactScore,
			recentFormScore,
			fieldingScore: fieldingScoreValue,
			yearsSinceDebut,
			daysSinceLastAppearance,
			matchesPlayed: entry.ipl.matches + entry.smat.matches,
			domesticPerformanceScore
		})

		return {
			id: entry.id,
			name: entry.name,
			role,
			battingHand: null,
			bowlingStyle: null,
			age: null,
			imageUrl: null,
			competition,
			matches: totals.matches,
			innings: Math.max(totals.batting.innings, totals.bowling.innings),
			impactScore,
			estimatedPriceRange: estimatedPriceRangeFromAuctionScore(auctionScore),
			tags: [],
			teams: Array.from(teams).sort(),
			currentIPLTeam: entry.latestIplTeam ?? null
		}
	})

	const sortedPlayers = players.sort((a, b) => b.impactScore - a.impactScore)

	// Deliberately not awaited: Wikidata/Wikipedia are rate-limited and a cold lookup
	// across ~1500 players can take minutes (see playerProfiles.ts), which would make
	// every cache (re)build — and the very first GET /api/players after a cold
	// start — wait on a dependency this service doesn't control. Cricsheet-derived
	// data (impactScore, matches, etc.) never depended on this, so there's no reason
	// to hold it hostage to it. Enrichment patches these same player objects in place
	// once it resolves, so battingHand/bowlingStyle/age/imageUrl/the full name appear
	// a little later rather than blocking every request until they're ready.
	fetchPlayerProfiles(sortedPlayers.map((player) => player.id))
		.then((profiles) => {
			for (const player of sortedPlayers) {
				const profile = profiles.get(player.id)
				if (!profile) continue
				if (profile.fullName) player.name = profile.fullName
				player.battingHand = profile.battingHand
				player.bowlingStyle = profile.bowlingStyle
				player.age = profile.age
				player.imageUrl = profile.imageUrl
			}
		})
		.catch((error: unknown) => {
			// eslint-disable-next-line no-console
			console.error(
				'[cricsheet] Player profile enrichment failed; continuing without it:',
				error
			)
		})

	return sortedPlayers
}

let cache: { players: CricketPlayer[]; loadedAt: number } | null = null
let inflightBuild: Promise<CricketPlayer[]> | null = null

/**
 * Returns the cached player index, rebuilding it if it is missing or stale. Concurrent
 * callers during a cold start or refresh share a single in-flight rebuild rather than
 * each triggering their own archive downloads.
 */
async function getPlayerIndex(): Promise<CricketPlayer[]> {
	const isFresh =
		cache !== null &&
		Date.now() - cache.loadedAt < config.cricsheetConfig.CRICSHEET_CACHE_TTL_MS

	if (isFresh && cache) return cache.players

	if (!inflightBuild) {
		inflightBuild = buildPlayerIndex()
			.then((players) => {
				cache = { players, loadedAt: Date.now() }
				return players
			})
			.finally(() => {
				inflightBuild = null
			})
	}

	return inflightBuild
}

/**
 * Kicks off the (multi-second) archive download/parse/score build immediately,
 * without waiting for it or for a request to trigger it. Call this once at process
 * startup so a cold cache never shows up as latency on the first real
 * GET /api/players request. Errors are logged, not thrown — a failed warm-up just
 * means the first real request falls back to the normal lazy build above.
 */
export function warmCricketPlayersCache(): void {
	getPlayerIndex().catch((error: unknown) => {
		// eslint-disable-next-line no-console
		console.error('[cricsheet] Failed to warm the player index cache:', error)
	})
}

/**
 * Lists Indian IPL and Syed Mushtaq Ali Trophy cricket players sourced from Cricsheet,
 * filtered and paginated in memory.
 *
 * @param filter - Name/team substring filters, an optional competition filter, and
 *   1-indexed pagination. `page`/`limit` are trusted as already validated.
 * @returns The matching page of players plus pagination metadata.
 */
export async function listCricketPlayers(
	filter: CricketPlayersFilter
): Promise<CricketPlayersListData> {
	const players = await getPlayerIndex()

	const nameQuery = filter.name?.toLowerCase()
	const teamQuery = filter.team?.toLowerCase()

	const matched = players.filter((player) => {
		if (nameQuery && !player.name.toLowerCase().includes(nameQuery))
			return false
		if (
			teamQuery &&
			!player.teams.some((team) => team.toLowerCase().includes(teamQuery))
		)
			return false
		if (filter.competition && player.competition !== filter.competition)
			return false
		return true
	})

	const total = matched.length
	const totalPages = total === 0 ? 0 : Math.ceil(total / filter.limit)
	const start = (filter.page - 1) * filter.limit

	return {
		players: matched.slice(start, start + filter.limit),
		page: filter.page,
		limit: filter.limit,
		total,
		totalPages
	}
}
