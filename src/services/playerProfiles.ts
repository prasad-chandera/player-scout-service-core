// Fills in the biographical fields Cricsheet has no dataset for at all: full name,
// batting hand, bowling style, age and a photo. Cricsheet's own display names are
// scorecard abbreviations ("V Kohli"), and it publishes no DOB, handedness, bowling
// arm/type or images for anyone.
//
// ESPN Cricinfo — the obvious source for this — was tried first and rejected: it
// blocks datacenter/bot traffic at the Akamai edge (every request 403s, including
// robots.txt), which would break identically in production. Wikidata + Wikipedia are
// used instead: both explicitly support programmatic access, and between them they
// cover full name, DOB, a Commons photo, and (via the Wikipedia infobox) batting hand
// and bowling style.
//
// The join: Cricsheet's public people register (people.csv) maps its own player
// identifier to an ESPNcricinfo numeric ID. Wikidata's P2697 claim ("ESPNcricinfo
// player ID") is the same ID space, so a batched SPARQL lookup on P2697 finds the
// Wikidata item (and from it, DOB, a Commons image, and the enwiki article title).
// The enwiki title is then used to fetch that article's infobox wikitext, which is
// regex-parsed for the `batting`/`bowling`/`fullname` fields.
//
// Coverage is necessarily partial: obscure domestic-only (Syed Mushtaq Ali Trophy)
// players usually have no Wikipedia article at all, so they simply don't appear in the
// returned map — the caller treats an absent entry the same as every field being null.
// Every external call here is batched and wrapped so a failure degrades to "no
// profile" rather than breaking the player list this enriches.
//
// Licensing note: Wikidata's structured data is CC0, Wikipedia's prose is CC-BY-SA,
// and Commons images carry their own (usually CC-BY-SA) per-image license — attribute
// Wikipedia/Wikimedia Commons if any of this (name, bio text, photo) is ever surfaced
// to end users, not just used internally for scouting.

import axios from 'axios'
import config from '../configs/config'
import type { PlayerAge } from '../types/players'

const CRICSHEET_PEOPLE_REGISTER_URL =
	'https://cricsheet.org/register/people.csv'
const WIKIDATA_SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql'
const WIKIPEDIA_API_ENDPOINT = 'https://en.wikipedia.org/w/api.php'

// Wikimedia's User-Agent policy (meta.wikimedia.org/wiki/User-Agent_policy) asks bot
// traffic to identify itself and give a way to make contact.
const USER_AGENT = `player-scout-service-core/1.0 (${config.urlsConfig.WEBSITE_URL ?? 'no contact URL configured'})`

const REQUEST_TIMEOUT_MS = 20000
const WIKIDATA_BATCH_SIZE = 300
const WIKIDATA_CONCURRENCY = 3
// The MediaWiki API caps action=query at 50 titles per request for non-bot accounts,
// and anonymous traffic hits its rate limit (429) well before that batch cap does —
// low concurrency plus withRetry's backoff is what actually keeps this reliable.
const WIKIPEDIA_BATCH_SIZE = 50
const WIKIPEDIA_CONCURRENCY = 2

const MS_PER_DAY = 24 * 60 * 60 * 1000
const MAX_RETRIES = 3

export interface PlayerProfile {
	fullName: string | null
	battingHand: 'right' | 'left' | null
	bowlingStyle: string | null
	age: PlayerAge | null
	imageUrl: string | null
}

/**
 * Everything PlayerProfile has except `age`, which is a point-in-time computation
 * (see computeAge) and can't be cached without going stale. This is the shape that's
 * actually worth caching long-term — a name/handedness/bowling-style/DOB/photo lookup
 * that cost a slow, rate-limited round trip to Wikidata/Wikipedia the first time.
 */
interface RawPlayerProfile {
	fullName: string | null
	battingHand: 'right' | 'left' | null
	bowlingStyle: string | null
	dobIso: string | null
	imageUrl: string | null
}

/**
 * Cricsheet id -> raw profile, kept for the lifetime of the process (add-only, no
 * expiry). Cricsheet's own match-data cache rebuilds every CRICSHEET_CACHE_TTL_MS
 * (24h by default), and without this, every one of those rebuilds re-ran the full
 * Wikidata + Wikipedia pipeline for every previously-seen player — the single biggest
 * cost in this file, for data that essentially never changes. With this cache, a
 * rebuild only pays that cost for players it hasn't seen before (new debutants); the
 * first-ever cold start after a process boot is still slow — that data has to come
 * from somewhere — but every rebuild after that is near-instant for players already
 * known.
 */
const rawProfileCache = new Map<string, RawPlayerProfile>()

function logWarning(message: string, error: unknown): void {
	// eslint-disable-next-line no-console
	console.error(`[playerProfiles] ${message}:`, error)
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableStatus(status: number | undefined): boolean {
	return status === 429 || (status !== undefined && status >= 500)
}

/** Honors a numeric `Retry-After` header when present, else exponential backoff. */
function retryDelayMs(error: unknown, attempt: number): number {
	if (axios.isAxiosError(error)) {
		const retryAfter = Number(error.response?.headers?.['retry-after'])
		if (Number.isFinite(retryAfter)) return retryAfter * 1000
	}
	return 2 ** attempt * 1000
}

/**
 * Retries `fn` on 429/5xx responses with backoff (Wikidata/Wikipedia both throttle
 * anonymous traffic — a 429 mid-batch shouldn't just silently drop that batch's data).
 * Anything else (4xx, network error) fails immediately.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await fn()
		} catch (error) {
			const status = axios.isAxiosError(error)
				? error.response?.status
				: undefined
			if (attempt >= MAX_RETRIES || !isRetryableStatus(status)) throw error
			await delay(retryDelayMs(error, attempt))
		}
	}
}

function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = []
	for (let i = 0; i < items.length; i += size)
		chunks.push(items.slice(i, i + size))
	return chunks
}

/** Runs `fn` over `items` with at most `concurrency` calls in flight at once. */
async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T) => Promise<R>
): Promise<R[]> {
	const results: R[] = new Array(items.length)
	let nextIndex = 0

	async function worker(): Promise<void> {
		for (;;) {
			const current = nextIndex
			nextIndex += 1
			if (current >= items.length) return
			results[current] = await fn(items[current])
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, worker)
	)
	return results
}

/**
 * Downloads Cricsheet's people register and returns cricsheetId -> ESPNcricinfo id,
 * restricted to `cricsheetIds` (the register covers every Cricsheet player ever, most
 * of whom aren't in our catalogue). The file has no quoted fields (verified against
 * the live register), so a plain comma split per line is safe.
 */
async function loadCricinfoIdsByCricsheetId(
	cricsheetIds: Set<string>
): Promise<Map<string, string>> {
	const response = await axios.get<string>(CRICSHEET_PEOPLE_REGISTER_URL, {
		responseType: 'text',
		timeout: REQUEST_TIMEOUT_MS
	})

	const lines = response.data.split('\n')
	const header = lines[0]?.split(',') ?? []
	const identifierColumn = header.indexOf('identifier')
	const cricinfoColumn = header.indexOf('key_cricinfo')
	const result = new Map<string, string>()

	if (identifierColumn === -1 || cricinfoColumn === -1) return result

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]
		if (!line) continue
		const columns = line.split(',')
		const identifier = columns[identifierColumn]?.trim()
		const cricinfoId = columns[cricinfoColumn]?.trim()
		if (identifier && cricinfoId && cricsheetIds.has(identifier)) {
			result.set(identifier, cricinfoId)
		}
	}

	return result
}

interface WikidataSparqlBinding {
	espnId?: { value: string }
	dob?: { value: string }
	image?: { value: string }
	enwikiTitle?: { value: string }
}

interface WikidataSparqlResponse {
	results: { bindings: WikidataSparqlBinding[] }
}

interface WikidataProfile {
	dobIso?: string
	imageUrl?: string
	enwikiTitle?: string
}

/**
 * Looks up a batch of ESPNcricinfo ids on Wikidata's P2697 claim ("ESPNcricinfo player
 * ID"), returning each match's date of birth, Commons photo and enwiki article title
 * (whichever of those three the item actually has — all optional).
 */
async function fetchWikidataProfilesBatch(
	espnIds: string[]
): Promise<Map<string, WikidataProfile>> {
	const values = espnIds.map((id) => `"${id}"`).join(' ')
	const query = `SELECT ?espnId ?dob ?image ?enwikiTitle WHERE {
		VALUES ?espnId { ${values} }
		?item wdt:P2697 ?espnId .
		OPTIONAL { ?item wdt:P569 ?dob }
		OPTIONAL { ?item wdt:P18 ?image }
		OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?enwikiTitle }
	}`

	const response = await withRetry(() =>
		axios.post<WikidataSparqlResponse>(
			WIKIDATA_SPARQL_ENDPOINT,
			new URLSearchParams({ query, format: 'json' }),
			{
				headers: {
					Accept: 'application/sparql-results+json',
					'User-Agent': USER_AGENT
				},
				timeout: REQUEST_TIMEOUT_MS
			}
		)
	)

	const result = new Map<string, WikidataProfile>()
	for (const binding of response.data.results.bindings) {
		const espnId = binding.espnId?.value
		if (!espnId) continue
		result.set(espnId, {
			dobIso: binding.dob?.value,
			imageUrl: binding.image?.value,
			enwikiTitle: binding.enwikiTitle?.value
		})
	}
	return result
}

async function fetchWikidataProfiles(
	espnIds: string[]
): Promise<Map<string, WikidataProfile>> {
	const batches = await mapWithConcurrency(
		chunk(espnIds, WIKIDATA_BATCH_SIZE),
		WIKIDATA_CONCURRENCY,
		async (batch) => {
			try {
				return await fetchWikidataProfilesBatch(batch)
			} catch (error) {
				logWarning('Wikidata batch lookup failed', error)
				return new Map<string, WikidataProfile>()
			}
		}
	)

	const merged = new Map<string, WikidataProfile>()
	for (const batch of batches) {
		for (const [espnId, profile] of batch) merged.set(espnId, profile)
	}
	return merged
}

interface WikipediaRevision {
	content?: string
}

interface WikipediaPage {
	title: string
	revisions?: WikipediaRevision[]
}

interface WikipediaQueryResponse {
	query?: { pages?: WikipediaPage[] }
}

interface InfoboxProfile {
	battingHand: 'right' | 'left' | null
	bowlingStyle: string | null
	fullName: string | null
}

/**
 * Strips the wikitext markup an infobox field value can contain down to plain text:
 * refs, nested-free templates, `[[link|display]]`/`[[link]]` wikilinks, bold/italic
 * markers.
 */
function cleanWikitext(raw: string): string {
	let text = raw
	text = text.replace(/<ref[^>]*\/>/gi, '')
	text = text.replace(/<ref[^>]*>.*?<\/ref>/gis, '')
	// Templates aren't nested in these fields in practice; a few passes clears the rare exception.
	for (let pass = 0; pass < 3; pass++)
		text = text.replace(/\{\{[^{}]*\}\}/g, '')
	text = text.replace(/\[\[[^\]|]*\|([^\]]+)\]\]/g, '$1')
	text = text.replace(/\[\[([^\]]+)\]\]/g, '$1')
	text = text.replace(/'''?/g, '')
	return text.trim()
}

/**
 * A small minority of infobox instances pack several parameters onto one physical
 * line (no per-parameter newline), which defeats the "value ends at \n" assumption
 * above and lets a later parameter's raw wikitext leak into this one's capture. A
 * clean field value never legitimately contains `{`, `}`, `|` or `=` — if any survive
 * cleanWikitext, treat the whole match as unparsed noise rather than show it.
 */
function looksLikeCleanValue(value: string): boolean {
	return !/[{}|=]/.test(value)
}

function extractInfoboxField(wikitext: string, field: string): string | null {
	// The value capture must stay on the field's own line: `\s` also matches `\n`, so
	// `=\s*` would happily skip straight past an empty field into the next line's
	// content (observed in practice: an empty `fullname` line "capturing" the
	// following `birth_date` field's value instead).
	const match = wikitext.match(
		new RegExp(`\\|[ \\t]*${field}[ \\t]*=[ \\t]*([^\\n]+)`, 'i')
	)
	if (!match) return null
	const cleaned = cleanWikitext(match[1])
	if (cleaned.length === 0 || !looksLikeCleanValue(cleaned)) return null
	return cleaned
}

function parseBattingHand(value: string | null): 'right' | 'left' | null {
	if (!value) return null
	if (/left/i.test(value)) return 'left'
	if (/right/i.test(value)) return 'right'
	return null
}

/** Fetches a batch of enwiki articles' lead-section wikitext and parses each one's `{{Infobox cricketer}}`. */
async function fetchWikipediaInfoboxesBatch(
	titles: string[]
): Promise<Map<string, InfoboxProfile>> {
	const response = await withRetry(() =>
		axios.get<WikipediaQueryResponse>(WIKIPEDIA_API_ENDPOINT, {
			params: {
				action: 'query',
				titles: titles.join('|'),
				prop: 'revisions',
				rvprop: 'content',
				rvsection: '0',
				format: 'json',
				formatversion: '2'
			},
			headers: { 'User-Agent': USER_AGENT },
			timeout: REQUEST_TIMEOUT_MS
		})
	)

	const result = new Map<string, InfoboxProfile>()
	for (const page of response.data.query?.pages ?? []) {
		const wikitext = page.revisions?.[0]?.content
		if (!wikitext) continue
		result.set(page.title, {
			battingHand: parseBattingHand(extractInfoboxField(wikitext, 'batting')),
			bowlingStyle: extractInfoboxField(wikitext, 'bowling'),
			fullName: extractInfoboxField(wikitext, 'fullname')
		})
	}
	return result
}

async function fetchWikipediaInfoboxes(
	titles: string[]
): Promise<Map<string, InfoboxProfile>> {
	const batches = await mapWithConcurrency(
		chunk(titles, WIKIPEDIA_BATCH_SIZE),
		WIKIPEDIA_CONCURRENCY,
		async (batch) => {
			try {
				return await fetchWikipediaInfoboxesBatch(batch)
			} catch (error) {
				logWarning('Wikipedia infobox lookup failed', error)
				return new Map<string, InfoboxProfile>()
			}
		}
	)

	const merged = new Map<string, InfoboxProfile>()
	for (const batch of batches) {
		for (const [title, infobox] of batch) merged.set(title, infobox)
	}
	return merged
}

function computeAge(dobIso: string): PlayerAge | null {
	const dob = new Date(dobIso)
	if (Number.isNaN(dob.getTime())) return null

	const now = new Date()
	const hadBirthdayThisYear =
		now.getUTCMonth() > dob.getUTCMonth() ||
		(now.getUTCMonth() === dob.getUTCMonth() &&
			now.getUTCDate() >= dob.getUTCDate())

	const years =
		now.getUTCFullYear() - dob.getUTCFullYear() - (hadBirthdayThisYear ? 0 : 1)
	const lastBirthdayYear = now.getUTCFullYear() - (hadBirthdayThisYear ? 0 : 1)
	const lastBirthday = new Date(
		Date.UTC(lastBirthdayYear, dob.getUTCMonth(), dob.getUTCDate())
	)
	const days = Math.round((now.getTime() - lastBirthday.getTime()) / MS_PER_DAY)

	return { years, days }
}

/**
 * Runs the actual Wikidata + Wikipedia pipeline for `cricsheetIds` — this is the slow,
 * rate-limited part. Only ever called for ids `fetchPlayerProfiles` hasn't already
 * cached. Players with no Wikidata match (most obscure domestic-only players) are
 * simply absent from the returned map. Every network call is batched,
 * concurrency-limited and individually degraded on failure, so a Wikidata or Wikipedia
 * outage never throws — it just means fewer (or zero) matches this run.
 */
async function fetchRawProfiles(
	cricsheetIds: string[]
): Promise<Map<string, RawPlayerProfile>> {
	const profiles = new Map<string, RawPlayerProfile>()

	let cricinfoIdByCricsheetId: Map<string, string>
	try {
		cricinfoIdByCricsheetId = await loadCricinfoIdsByCricsheetId(
			new Set(cricsheetIds)
		)
	} catch (error) {
		logWarning('Failed to load the Cricsheet people register', error)
		return profiles
	}

	const cricsheetIdsByCricinfoId = new Map<string, string[]>()
	for (const [cricsheetId, cricinfoId] of cricinfoIdByCricsheetId) {
		const list = cricsheetIdsByCricinfoId.get(cricinfoId) ?? []
		list.push(cricsheetId)
		cricsheetIdsByCricinfoId.set(cricinfoId, list)
	}

	const wikidataByCricinfoId = await fetchWikidataProfiles(
		Array.from(cricsheetIdsByCricinfoId.keys())
	)

	const cricinfoIdsByTitle = new Map<string, string[]>()
	for (const [cricinfoId, wikidataProfile] of wikidataByCricinfoId) {
		if (!wikidataProfile.enwikiTitle) continue
		const list = cricinfoIdsByTitle.get(wikidataProfile.enwikiTitle) ?? []
		list.push(cricinfoId)
		cricinfoIdsByTitle.set(wikidataProfile.enwikiTitle, list)
	}

	const infoboxByTitle = await fetchWikipediaInfoboxes(
		Array.from(cricinfoIdsByTitle.keys())
	)

	for (const [cricinfoId, cricsheetIdList] of cricsheetIdsByCricinfoId) {
		const wikidataProfile = wikidataByCricinfoId.get(cricinfoId)
		if (!wikidataProfile) continue

		const infobox = wikidataProfile.enwikiTitle
			? infoboxByTitle.get(wikidataProfile.enwikiTitle)
			: undefined

		const profile: RawPlayerProfile = {
			fullName: infobox?.fullName ?? wikidataProfile.enwikiTitle ?? null,
			battingHand: infobox?.battingHand ?? null,
			bowlingStyle: infobox?.bowlingStyle ?? null,
			dobIso: wikidataProfile.dobIso ?? null,
			imageUrl: wikidataProfile.imageUrl ?? null
		}

		for (const cricsheetId of cricsheetIdList) {
			profiles.set(cricsheetId, profile)
		}
	}

	return profiles
}

/**
 * Resolves as much biographical profile as Wikidata/Wikipedia have for the given
 * Cricsheet player ids, using rawProfileCache to skip the slow network pipeline
 * entirely for ids already resolved by a previous call in this process's lifetime —
 * see the cache's own doc comment for why that matters. Players with no Wikidata
 * match are simply absent from the returned map.
 */
export async function fetchPlayerProfiles(
	cricsheetIds: string[]
): Promise<Map<string, PlayerProfile>> {
	const missingIds = cricsheetIds.filter((id) => !rawProfileCache.has(id))

	if (missingIds.length > 0) {
		const freshlyResolved = await fetchRawProfiles(missingIds)
		for (const [id, profile] of freshlyResolved) {
			rawProfileCache.set(id, profile)
		}
	}

	const profiles = new Map<string, PlayerProfile>()
	for (const id of cricsheetIds) {
		const raw = rawProfileCache.get(id)
		if (!raw) continue
		profiles.set(id, {
			fullName: raw.fullName,
			battingHand: raw.battingHand,
			bowlingStyle: raw.bowlingStyle,
			age: raw.dobIso ? computeAge(raw.dobIso) : null,
			imageUrl: raw.imageUrl
		})
	}
	return profiles
}
