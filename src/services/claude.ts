// The LLM explanation layer (docs/02 §7, docs/03 §AI-3).
//
// Claude is the NARRATION, not the intelligence. Every number it writes was computed by
// the analytics pipeline and handed to it in the prompt. It is instructed to invent nothing.
//
// Two deliberate departures from docs/03 §AI-3, which predates current model behaviour:
//   1. No `temperature`. Sampling parameters were removed on current Opus models and now
//      return a 400. Tone is steered by the system prompt instead.
//   2. Structured output via `output_config.format` rather than a tool forced with
//      `tool_choice`. Same guarantee (parseable JSON, no regex extraction from prose),
//      less machinery.

import Anthropic from '@anthropic-ai/sdk'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
	CACHE_DIR,
	FALLBACK_EXPLANATIONS,
	players as allPlayers
} from '../store'
import { MODEL_VERSION, readinessFor, topContributors } from './readiness'
import { similarTo } from './similarity'
import type { ComparisonExplanation, Explanation, Player } from '../types/index'

export const MODEL: string = process.env.CLAUDE_MODEL || 'claude-opus-4-8'
export const hasKey = (): boolean => Boolean(process.env.ANTHROPIC_API_KEY)

let client: Anthropic | null = null
function anthropic(): Anthropic {
	// Constructed lazily so the server boots fine with no key at all.
	if (!client) client = new Anthropic()
	return client
}

// Rule 6 is not decoration: a scouting report with no weaknesses is not credible.
const SYSTEM_PROMPT = `You are a professional T20 cricket scout writing a report for an IPL franchise.

Rules:
1. Use ONLY the statistics provided in the user message. Never invent, estimate,
   or recall any statistic from memory.
2. Every numeric claim must quote a number present in the input.
3. If a statistic is marked low-sample or missing, you may mention the skill only
   with an explicit caveat.
4. Mention comparable players only if they appear in the "similarPlayers" input.
5. Be concrete and concise. No hype words ("incredible", "amazing").
6. Weaknesses are mandatory — a report with no weaknesses is not credible.`

/** Matches the SDK's JSONOutputFormat["schema"]. */
type JsonSchema = Record<string, unknown>

const EXPLANATION_SCHEMA: JsonSchema = {
	type: 'object',
	properties: {
		summary: {
			type: 'string',
			description:
				'2-3 sentences. Lead with the defining skill and the number that proves it.'
		},
		strengths: {
			type: 'array',
			items: { type: 'string' },
			description: '2-4 strengths, each quoting a supplied number.'
		},
		weaknesses: {
			type: 'array',
			items: { type: 'string' },
			description:
				'1-3 weaknesses, each quoting a supplied number. Never empty.'
		},
		comparablePlayers: {
			type: 'array',
			items: {
				type: 'object',
				properties: { name: { type: 'string' }, note: { type: 'string' } },
				required: ['name', 'note'],
				additionalProperties: false
			}
		}
	},
	required: ['summary', 'strengths', 'weaknesses', 'comparablePlayers'],
	additionalProperties: false
}

const COMPARISON_SCHEMA: JsonSchema = {
	type: 'object',
	properties: {
		verdict: { type: 'string' },
		rows: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					label: { type: 'string' },
					a: { type: 'string' },
					b: { type: 'string' },
					note: { type: 'string' }
				},
				required: ['label', 'a', 'b', 'note'],
				additionalProperties: false
			}
		},
		differences: { type: 'array', items: { type: 'string' } }
	},
	required: ['verdict', 'rows', 'differences'],
	additionalProperties: false
}

// ----------------------------- grounding payload -----------------------------

interface PlayerPayload {
	player: {
		name: string
		role: string
		age: number
		competition: string
		matches: number
	}
	stats: Record<string, number>
	readiness: { score: number; topContributors: string[] }
	similarPlayers: {
		name: string
		similarity: number
		sharedStrengths: string[]
	}[]
	lowSampleFlags: string[]
}

/**
 * Percentile rank of a raw stat across the comparable pool. This is what lets Claude
 * write "top decile" claims that are actually checkable rather than vibes.
 */
function percentile(
	value: number | undefined,
	pool: Player[],
	key: string,
	higherIsBetter = true
): number | null {
	const values = pool
		.map((p) => p.rawStats[key])
		.filter((v): v is number => typeof v === 'number')
	if (!values.length || typeof value !== 'number') return null
	const below = values.filter((v) =>
		higherIsBetter ? v < value : v > value
	).length
	return Math.round((below / values.length) * 100)
}

// Economy and batter dot-ball % are "lower is better"; everything else is not.
const LOWER_IS_BETTER = new Set(['economy', 'powerplayEconomy', 'deathEconomy'])

function statsWithPercentiles(player: Player): Record<string, number> {
	const pool = allPlayers.filter((p) => p.role === player.role)
	const stats: Record<string, number> = {}
	for (const [key, value] of Object.entries(player.rawStats)) {
		stats[key] = value
		const higherIsBetter =
			!LOWER_IS_BETTER.has(key) &&
			!(key === 'dotBallPct' && player.role === 'batter')
		const pctRank = percentile(value, pool, key, higherIsBetter)
		if (pctRank !== null) stats[`${key}Percentile`] = pctRank
	}
	return stats
}

/** Features whose sample is too thin to make a confident claim about. */
function lowSampleFlags(player: Player): string[] {
	return Object.entries(player.coverage ?? {})
		.filter(([, ok]) => ok === false)
		.map(([key]) => key)
}

export function buildPayload(player: Player): PlayerPayload {
	const similar = similarTo(player, allPlayers, { limit: 3 })
	return {
		player: {
			name: player.name,
			role: player.role,
			age: player.age,
			competition: player.competition.toUpperCase(),
			matches: player.matches
		},
		stats: statsWithPercentiles(player),
		readiness: {
			score: readinessFor(player).score,
			topContributors: topContributors(player)
		},
		similarPlayers: similar.map((s) => ({
			name: s.player.name,
			similarity: Number(s.similarity.toFixed(2)),
			sharedStrengths: s.topContributions.map((c) => c.feature)
		})),
		lowSampleFlags: lowSampleFlags(player)
	}
}

// -------------------------------- disk cache ---------------------------------

function statsHash(payload: unknown): string {
	return crypto
		.createHash('sha256')
		.update(JSON.stringify(payload))
		.digest('hex')
		.slice(0, 16)
}

function cacheKey(kind: string, id: string, hash: string): string {
	return `${kind}.${id}.${hash}.${MODEL_VERSION}.json`
}

async function readCache<T>(file: string): Promise<T | null> {
	try {
		return JSON.parse(
			await fs.readFile(path.join(CACHE_DIR, file), 'utf8')
		) as T
	} catch {
		return null
	}
}

async function writeCache(file: string, value: unknown): Promise<void> {
	await fs.mkdir(CACHE_DIR, { recursive: true })
	await fs.writeFile(path.join(CACHE_DIR, file), JSON.stringify(value, null, 2))
}

// -------------------------------- fallbacks ----------------------------------

function genericExplanation(player: Player): Explanation {
	const contributors = topContributors(player)
	return {
		summary: `${player.name} (${player.role}, ${player.competition.toUpperCase()}, ${
			player.matches
		} matches) carries an IPL readiness score of ${player.readiness}, driven primarily by ${
			player.tags[0] ?? 'overall profile'
		}.`,
		strengths: player.tags.map((t) => t[0]!.toUpperCase() + t.slice(1)),
		weaknesses: [
			`Full scouting report not yet generated — score is driven by ${contributors.join(', ')}; see the readiness breakdown for the complete picture.`
		],
		comparablePlayers: []
	}
}

function fallbackComparison(a: Player, b: Player): ComparisonExplanation {
	const sim = similarTo(a, [b], { limit: 1 })[0]
	const pct = sim ? Math.round(sim.similarity * 100) : 0
	return {
		verdict: `${b.name} matches ${a.name}'s skill profile at ${pct}% similarity, at ₹${b.expectedPriceLakh}L against ₹${a.expectedPriceLakh}L expected price.`,
		rows: (sim?.topContributions ?? []).map((c) => ({
			label: c.label,
			a: c.referenceValue,
			b: c.candidateValue,
			note: 'top shared strength'
		})),
		differences: [
			`${a.name} plays in ${a.competition.toUpperCase()}; ${b.name} in ${b.competition.toUpperCase()}. Pressure metrics are not drawn from the same contexts.`
		]
	}
}

// ---------------------------------- calls ------------------------------------

async function callClaude<T>(
	system: string,
	payload: unknown,
	schema: JsonSchema
): Promise<T> {
	const response = await anthropic().messages.create({
		model: MODEL,
		max_tokens: 1024,
		system,
		// No `temperature` — sampling params 400 on current Opus models. See the header note.
		output_config: { format: { type: 'json_schema', schema } },
		messages: [{ role: 'user', content: JSON.stringify(payload, null, 2) }]
	})

	const text = response.content.find((b) => b.type === 'text')?.text
	if (!text) throw new Error('Claude returned no text block')
	return JSON.parse(text) as T
}

export interface ExplainResult<T> {
	explanation: T
	cached: boolean
}

export interface ExplainOptions {
	regenerate?: boolean
}

/**
 * Returns { explanation, cached }. Never throws for LLM reasons — an unset key or a
 * network failure falls back to a canned report. docs/02 §7: never depend on a live
 * call during the judged demo.
 */
export async function explainPlayer(
	player: Player,
	{ regenerate = false }: ExplainOptions = {}
): Promise<ExplainResult<Explanation>> {
	const payload = buildPayload(player)
	const file = cacheKey('player', player.id, statsHash(payload))

	if (!regenerate) {
		const hit = await readCache<Explanation>(file)
		if (hit) return { explanation: hit, cached: true }
	}

	if (!hasKey()) {
		return {
			explanation:
				FALLBACK_EXPLANATIONS[player.id] ?? genericExplanation(player),
			cached: true
		}
	}

	try {
		const explanation = await callClaude<Explanation>(
			SYSTEM_PROMPT,
			payload,
			EXPLANATION_SCHEMA
		)
		await writeCache(file, explanation)
		return { explanation, cached: false }
	} catch (err) {
		console.error(
			`Claude call failed for ${player.id}, serving fallback:`,
			err instanceof Error ? err.message : err
		)
		return {
			explanation:
				FALLBACK_EXPLANATIONS[player.id] ?? genericExplanation(player),
			cached: true
		}
	}
}

export async function explainComparison(
	a: Player,
	b: Player,
	{ regenerate = false }: ExplainOptions = {}
): Promise<ExplainResult<ComparisonExplanation>> {
	const payload = {
		playerA: buildPayload(a),
		playerB: buildPayload(b),
		similarity: Number(
			similarTo(a, [b], { limit: 1 })[0]?.similarity.toFixed(2) ?? 0
		)
	}
	const file = cacheKey('comparison', `${a.id}-${b.id}`, statsHash(payload))

	if (!regenerate) {
		const hit = await readCache<ComparisonExplanation>(file)
		if (hit) return { explanation: hit, cached: true }
	}

	if (!hasKey()) return { explanation: fallbackComparison(a, b), cached: true }

	try {
		const system = `${SYSTEM_PROMPT}\n\nYou are comparing two players side by side. The "verdict" is one sentence a scout could say out loud. Each row compares one feature; "note" is at most four words.`
		const explanation = await callClaude<ComparisonExplanation>(
			system,
			payload,
			COMPARISON_SCHEMA
		)
		await writeCache(file, explanation)
		return { explanation, cached: false }
	} catch (err) {
		console.error(
			`Claude comparison failed for ${a.id}/${b.id}, serving fallback:`,
			err instanceof Error ? err.message : err
		)
		return { explanation: fallbackComparison(a, b), cached: true }
	}
}
