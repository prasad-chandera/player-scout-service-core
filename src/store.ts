// Boot-time load of the whole dataset into memory.
//
// 50 players x 10 dims fits in memory trivially — docs/04 §6 notes the entire dataset is
// small enough to live in the backend process. Postgres is for persistence and the
// explanation cache; neither is needed to serve a query, so neither is here.

import fs from 'node:fs'
import path from 'node:path'
import type {
	Explanation,
	FeatureMeta,
	Player,
	TeamProfile
} from './types/index'

// This file must stay exactly one level below both src/ and dist/, because the project
// root is derived as "one level up from wherever this module ended up":
//   dev   src/store.ts  -> dirname src/  -> .. -> <project root>
//   built dist/store.js -> dirname dist/ -> .. -> <project root>
// Every other module imports these paths rather than recomputing them — a script under
// src/scripts/ would otherwise resolve dist/scripts/.. to dist/ and silently miss data/.
const ROOT = path.resolve(__dirname, '..')

export const DATA_DIR = path.join(ROOT, 'data')
export const CACHE_DIR = path.join(ROOT, 'cache')
export { ROOT }

// JSON.parse yields `any`. This is the one boundary where the dataset enters the type
// system, so the assertions live here and nowhere else — validate() below is what earns
// them, checking at boot the invariants the types claim.
const load = <T>(file: string): T =>
	JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')) as T

interface FeaturesFile {
	version: number
	features: FeatureMeta[]
}

interface ExplanationsFile {
	undervaluedDisclaimer: string
	searchAliases: Record<string, string>
	explanations: Record<string, Explanation>
}

const featuresFile = load<FeaturesFile>('features.json')
const explanationsFile = load<ExplanationsFile>('explanations.json')

export const FEATURES: FeatureMeta[] = featuresFile.features
export const FEATURE_VERSION: number = featuresFile.version
export const players: Player[] = load<Player[]>('players.json')
export const teams: TeamProfile[] = load<TeamProfile[]>('teams.json')

export const FALLBACK_EXPLANATIONS: Record<string, Explanation> =
	explanationsFile.explanations
export const UNDERVALUED_DISCLAIMER: string =
	explanationsFile.undervaluedDisclaimer
export const SEARCH_ALIASES: Record<string, string> =
	explanationsFile.searchAliases

const playersById = new Map(players.map((p) => [p.id, p]))
const teamsById = new Map(teams.map((t) => [t.id, t]))

export const getPlayer = (id: string): Player | undefined => playersById.get(id)
export const getTeam = (id: string): TeamProfile | undefined =>
	teamsById.get(id)

// Fail loudly at boot rather than shipping a vector the UI will silently mis-render.
function validate(): void {
	for (const p of players) {
		if (
			!Array.isArray(p.featureVector) ||
			p.featureVector.length !== FEATURES.length
		) {
			throw new Error(
				`${p.id}: featureVector must have exactly ${FEATURES.length} entries, got ${p.featureVector?.length}`
			)
		}
		if (p.featureVector.some((v) => typeof v !== 'number' || v < 0 || v > 1)) {
			throw new Error(
				`${p.id}: every featureVector entry must be a number in [0,1]`
			)
		}
		if (p.phaseStats?.length !== 3) {
			throw new Error(
				`${p.id}: phaseStats must cover powerplay, middle and death`
			)
		}
	}
	if (playersById.size !== players.length)
		throw new Error('Duplicate player id in players.json')
}
validate()

console.log(`Loaded ${players.length} players and ${teams.length} teams.`)
