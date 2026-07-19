// "Why are these two players similar" detail view (GET /players/:id/similar/:candidateId)
// — opened after a scout sees a candidate in the GET /players/similar list and wants the
// reasoning behind its matchScore.
//
// The comparison table (which skill axes drove the match, and by how much) is entirely
// deterministic: it reuses compareSimilarity from ../services/similarPlayers.ts, the
// exact feature vectors and matchScore formula that endpoint's list is ranked by, so the
// percentage shown here can never disagree with the percentage the list showed for the
// same pair.
//
// An LLM is used for exactly one thing: phrasing a one-sentence verdict and calling out
// notable differences in plain English. Per this project's standing rule for narration
// (see ../services/claude.ts) it is handed only numbers already computed above and told
// never to invent one. And because narration here is a nice-to-have on top of data that's
// already fully useful without it — unlike playerSearch.ts/similarPlayers.ts, where the
// AI call itself produces data the response can't exist without — a missing key or a
// failed call falls back to a deterministic template instead of failing the request.

import { GoogleGenAI } from '@google/genai'
import { z } from 'zod/v4'
import config from '../configs/config'
import {
	getAllPlayerDerivedDetails,
	getCricketPlayerById,
	type PlayerDerivedDetails
} from './cricsheet'
import { compareSimilarity } from './similarPlayers'
import type { CricketPlayer } from '../types/players'
import type { SkillRadarScores } from '../types/playerDetails'
import type {
	PlayerComparisonFeatureRow,
	PlayerComparisonResult
} from '../types/playerComparison'

export const MODEL: string = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite'
export const hasKey = (): boolean =>
	Boolean(config.aiConfig.GOOGLE_GENAI_API_KEY)

const REQUEST_TIMEOUT_MS = 12000
export const DEFAULT_COMPARISON_ROW_LIMIT = 3
export const MAX_COMPARISON_ROW_LIMIT = 5

let client: GoogleGenAI | null = null
function gemini(): GoogleGenAI {
	// Constructed lazily so the server boots fine with no key at all (mirrors similarPlayers.ts/playerSearch.ts).
	if (!client)
		client = new GoogleGenAI({ apiKey: config.aiConfig.GOOGLE_GENAI_API_KEY })
	return client
}

/** Thrown when `id` or `candidateId` matches no catalogue player. */
export class PlayerComparisonNotFoundError extends Error {}

const FEATURE_LABELS: Record<string, string> = {
	batting: 'Batting',
	bowling: 'Bowling',
	fielding: 'Fielding',
	pressure: 'Pressure handling',
	consistency: 'Consistency'
}

function formatSkillRadarValue(
	scores: SkillRadarScores | undefined,
	key: keyof SkillRadarScores
): string {
	const value = scores?.[key]
	return typeof value === 'number' ? `${value.toFixed(1)}/10` : '—'
}

/** Turns raw per-axis agreement into display rows, normalized so shares sum to 100 across the full feature set. */
function buildComparisonRows(
	seedDerived: PlayerDerivedDetails | undefined,
	candidateDerived: PlayerDerivedDetails | undefined,
	featureAgreement: Record<string, number>
): PlayerComparisonFeatureRow[] {
	const totalAgreement =
		Object.values(featureAgreement).reduce((sum, value) => sum + value, 0) || 1

	return Object.entries(featureAgreement)
		.map(([feature, agreement]) => ({
			feature,
			label: FEATURE_LABELS[feature] ?? feature,
			seedValue: formatSkillRadarValue(
				seedDerived?.skillRadar,
				feature as keyof SkillRadarScores
			),
			candidateValue: formatSkillRadarValue(
				candidateDerived?.skillRadar,
				feature as keyof SkillRadarScores
			),
			shareOfSimilarity: Math.round((agreement / totalAgreement) * 100)
		}))
		.sort((a, b) => b.shareOfSimilarity - a.shareOfSimilarity)
}

// ----------------------------- AI narrative -----------------------------

const narrativeSchema = z.object({
	verdict: z.string().trim().min(1).max(300),
	differences: z.array(z.string().trim().min(1).max(200)).min(1).max(5)
})

const NARRATIVE_RESPONSE_JSON_SCHEMA = {
	type: 'object',
	properties: {
		verdict: { type: 'string' },
		differences: { type: 'array', items: { type: 'string' } }
	},
	required: ['verdict', 'differences']
}

const SYSTEM_PROMPT = `You are a T20 cricket scout explaining why a stats engine matched two players as "similar".

Rules:
1. Use ONLY the numbers given to you in the input. Never invent, estimate, or recall a statistic from memory.
2. verdict is one plain sentence naming the shared strength(s) behind the highest-ranked comparison rows (the ones with the largest shareOfSimilarity).
3. differences lists 1-3 short, concrete callouts of where the two players' numbers actually diverge, even though they matched overall. Never leave this empty — a comparison with no caveats isn't credible. If impactGatePassed is false, one difference must mention the overall impactScore gap.
4. Every claim must quote a number present in the input.`

interface NarrativePlayerSummary {
	name: string
	role: string
	matches: number
	impactScore: number
}

interface NarrativePayload {
	seedPlayer: NarrativePlayerSummary
	candidatePlayer: NarrativePlayerSummary
	matchScore: number
	impactGatePassed: boolean
	comparisons: PlayerComparisonFeatureRow[]
}

interface Narrative {
	verdict: string
	differences: string[]
}

/** Calls Gemini to phrase the verdict/differences. Returns null (never throws) on any failure — the caller falls back to a template. */
async function generateNarrative(
	payload: NarrativePayload
): Promise<Narrative | null> {
	if (!hasKey()) return null

	try {
		const response = await gemini().models.generateContent({
			model: MODEL,
			contents: JSON.stringify(payload),
			config: {
				systemInstruction: SYSTEM_PROMPT,
				responseMimeType: 'application/json',
				responseJsonSchema: NARRATIVE_RESPONSE_JSON_SCHEMA,
				temperature: 0,
				httpOptions: { timeout: REQUEST_TIMEOUT_MS }
			}
		})

		const raw: unknown = JSON.parse(response.text ?? '{}')
		const parsed = narrativeSchema.safeParse(raw)
		return parsed.success ? parsed.data : null
	} catch (error) {
		// A narrative failure shouldn't fail the whole comparison — see the module doc.
		// eslint-disable-next-line no-console
		console.error(
			'[playerComparison] Gemini narrative call failed; falling back to a template:',
			error
		)
		return null
	}
}

function templateNarrative(
	seedPlayer: CricketPlayer,
	candidatePlayer: CricketPlayer,
	matchScore: number,
	impactGatePassed: boolean,
	comparisons: PlayerComparisonFeatureRow[]
): Narrative {
	const topRow = comparisons[0]
	const verdict = topRow
		? `${seedPlayer.name} and ${candidatePlayer.name} rank ${matchScore}% similar, driven mainly by ${topRow.label.toLowerCase()} (${topRow.seedValue} vs ${topRow.candidateValue}).`
		: `${seedPlayer.name} and ${candidatePlayer.name} rank ${matchScore}% similar.`

	const differences: string[] = []
	const weakestRow = [...comparisons].sort(
		(a, b) => a.shareOfSimilarity - b.shareOfSimilarity
	)[0]
	if (weakestRow) {
		differences.push(
			`${weakestRow.label} is where they diverge most: ${seedPlayer.name} ${weakestRow.seedValue} vs ${candidatePlayer.name} ${weakestRow.candidateValue}.`
		)
	}
	if (!impactGatePassed) {
		differences.push(
			`Overall impact score differs meaningfully: ${seedPlayer.name} ${seedPlayer.impactScore} vs ${candidatePlayer.name} ${candidatePlayer.impactScore}.`
		)
	}

	return { verdict, differences }
}

/**
 * Explains the matchScore between two specific catalogue players — the detail view
 * behind a candidate in a GET /players/similar list.
 *
 * @param rowLimit - How many comparison rows to return, ranked by shareOfSimilarity
 *   descending. Defaults to {@link DEFAULT_COMPARISON_ROW_LIMIT}, capped at
 *   {@link MAX_COMPARISON_ROW_LIMIT}. Only truncates the list; shares are computed over
 *   the full feature set regardless of this cap.
 * @throws {@link PlayerComparisonNotFoundError} if either id matches no catalogue player.
 */
export async function comparePlayersSimilarity(
	seedId: string,
	candidateId: string,
	rowLimit: number = DEFAULT_COMPARISON_ROW_LIMIT
): Promise<PlayerComparisonResult> {
	const [seedPlayer, candidatePlayer, derivedById] = await Promise.all([
		getCricketPlayerById(seedId),
		getCricketPlayerById(candidateId),
		getAllPlayerDerivedDetails()
	])

	if (!seedPlayer) {
		throw new PlayerComparisonNotFoundError(`No player with id "${seedId}".`)
	}
	if (!candidatePlayer) {
		throw new PlayerComparisonNotFoundError(
			`No player with id "${candidateId}".`
		)
	}

	const seedDerived = derivedById.get(seedId)
	const candidateDerived = derivedById.get(candidateId)

	const { matchScore, impactGatePassed, featureAgreement } = compareSimilarity(
		seedPlayer,
		seedDerived,
		candidatePlayer,
		candidateDerived
	)

	const allComparisons = buildComparisonRows(
		seedDerived,
		candidateDerived,
		featureAgreement
	)
	const comparisons = allComparisons.slice(0, rowLimit)

	const narrative = await generateNarrative({
		seedPlayer: {
			name: seedPlayer.name,
			role: seedPlayer.role,
			matches: seedPlayer.matches,
			impactScore: seedPlayer.impactScore
		},
		candidatePlayer: {
			name: candidatePlayer.name,
			role: candidatePlayer.role,
			matches: candidatePlayer.matches,
			impactScore: candidatePlayer.impactScore
		},
		matchScore,
		impactGatePassed,
		comparisons: allComparisons
	})

	const { verdict, differences } =
		narrative ??
		templateNarrative(
			seedPlayer,
			candidatePlayer,
			matchScore,
			impactGatePassed,
			allComparisons
		)

	return {
		seedPlayer,
		candidatePlayer,
		matchScore,
		impactGatePassed,
		verdict,
		comparisons,
		differences,
		narrativeSource: narrative ? 'ai' : 'template'
	}
}
