# ScoutIQ — Backend

The analytics backend for [ScoutIQ](../scout-iq): the similarity engine, the IPL readiness
scorer, the undervalued index, team fit, and the Claude explanation layer.

Node.js + Express 5 + TypeScript. The frontend (`../scout-iq`) is a separate Next.js project.
This repo serves the API it consumes on `http://localhost:4000`.

**The LLM is not the intelligence.** Every number this API returns is computed here, in plain
arithmetic. Claude only narrates numbers it is handed, and is instructed to invent nothing.

## Quick start

```bash
npm install
npm run dev          # http://localhost:4000
```

No API key and no database are required. Without `ANTHROPIC_API_KEY` the explanation
endpoints serve pre-written reports and still return 200, so every page renders.

To point the frontend at it:

```bash
cd ../scout-iq
cp .env.local.example .env.local     # set NEXT_PUBLIC_USE_MOCK=false
npm run dev
```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | `tsx watch` — no build step in the dev loop |
| `npm run build` | `tsc` → `dist/` |
| `npm start` | Run the compiled output (`node dist/server.js`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run verify` | Contract assertions against a running server (see Verification) |
| `npm run score` | Recompute every readiness score from its feature vector and write back to `data/players.json`. **Run after touching any vector or weight.** |
| `npm run warm-cache` | Pre-generate a Claude report for all 50 players. Run before any demo; add `--force` to regenerate. |

## Endpoints

Base URL `http://localhost:4000`. All responses JSON. Errors are
`{ "error": { "code", "message" } }` with 400 / 404 / 500.

| # | Method | Path | Purpose |
|---|---|---|---|
| 1 | GET | `/api/players` | List/search. `role`, `q`, `minReadiness`, `maxPriceLakh`, `competition`, `page`, `limit` |
| 2 | GET | `/api/players/:id` | Full profile |
| 3 | GET | `/api/players/:id/similar` | Top-N similar. `limit`, `excludeIpl` |
| 4 | POST | `/api/search/similar` | "Find the next Bumrah" — `{ description \| referencePlayerId, limit, excludeIpl }` |
| 5 | GET | `/api/players/:id/readiness` | Score + full breakdown |
| 6 | POST | `/api/explain/player` | `{ playerId, regenerate? }` → scouting report |
| 7 | POST | `/api/explain/comparison` | `{ playerAId, playerBId }` |
| 8 | GET | `/api/undervalued` | The Moneyball page. `limit`, `role` |
| 9 | GET | `/api/teams` | Franchises + needs profiles |
| 10 | POST | `/api/teams/:id/fit` | `{ limit, maxPriceLakh? }` |
| 11 | GET | `/api/meta/features` | The frozen feature dictionary |

Plus `GET /health`.

## The contract

`src/types/index.ts` mirrors [`../scout-iq/src/lib/types.ts`](../scout-iq/src/lib/types.ts).
**That file — not `docs/03-api-endpoints-and-ai.md` — is the source of truth**, because it is
what the UI actually deserializes. The doc is wrong in two places that would break rendering:

| | doc 03 says | reality |
|---|---|---|
| `featureVector` | `{ ordering, values }` | a flat `number[]` |
| `topContributions[].referenceValue` | a number (`6.8`) | a **string** (`"econ 6.8"`) |

## The feature vector

Ten slots, frozen, shared by every role. This ordering is a contract with the frontend —
served by `GET /api/meta/features` so UI labels can never drift out of sync with vector
positions.

```
0 powerplayImpact          5 vsRight
1 deathImpact              6 containmentOrRotation
2 dotBallPct               7 pressure
3 wicketOrBoundaryPct      8 fielding
4 vsLeft                   9 consistency
```

Every value is normalised to 0–1 with **1 always good** — "lower is better" stats like economy
are inverted during normalisation.

## The readiness model

`readiness = 100 × Σ(weight_i × normalized_feature_i)`, weights summing to 1.

There is no trained model, and that's deliberate (docs/02 §4): a proper domestic→IPL model
needs labelled historical transitions, and an opaque score can't be shown on screen. **These
weights are the model** — they live in [`src/lib/readiness.js`](src/lib/readiness.js) and are
reproduced here because changing them changes every number in the UI.

| Feature | Bowler | Batter |
|---|---|---|
| deathImpact | 0.22 | 0.18 |
| dotBallPct | 0.15 | 0.05 |
| containmentOrRotation | 0.13 | 0.12 |
| powerplayImpact | 0.12 | 0.14 |
| wicketOrBoundaryPct | 0.12 | 0.14 |
| pressure | 0.10 | 0.20 |
| vsLeft | 0.04 | 0.07 |
| vsRight | 0.04 | 0.05 |
| fielding | 0.05 | 0.03 |
| consistency | 0.03 | 0.02 |

All-rounders are scored on the mean of both columns. `modelVersion: "weighted-v1"`.

`readiness` is stored on each player (the score dial reads it straight from endpoint 2) but is
**derived** from the vector. `npm run score` recomputes and writes it back — run it after any
change, or the dial and the "why this score" breakdown will disagree on screen.

**Upgrade path:** replace the weights with a logistic regression trained offline on historical
SMAT→IPL transitions. The API shape stays identical.

## The similarity engine — and one deviation from the spec

Cosine similarity over the vectors. 50 players × 10 dims, so a full scan is microseconds: no
vector DB, no embeddings model, no ML runtime. Each feature's share of the cosine numerator is
its **contribution** to the match, which is what powers "similar because: death economy,
dot-ball %" and the comparison table.

**`docs/03 §AI-1` specifies raw cosine on the vectors. This implementation mean-centres them
first, and the difference is not cosmetic.**

`docs/02 §3` anticipates the risk — *"cosine ignores magnitude, so a uniformly mediocre player
can be 'shaped like' Bumrah at a lower level"* — and suggests showing readiness alongside
similarity as the mitigation. On real data the problem is worse than that framing, and the
mitigation doesn't reach it. Because every feature is normalised so 1 is good, the pool mean
sits near 0.7 on every slot and all 50 vectors point into one narrow cone. Measured against
Bumrah with raw cosine, the entire bowler pool scored **98.4%–99.8%** — a 2.9-point spread from
elite to ordinary. Every candidate reads "100%" once rounded, which makes the product's
headline number meaningless.

Subtracting the pool mean per feature first (Pearson correlation over the vector) spreads the
same pool across ~169 points and lands the top results in the 60–90% band the demo script
assumes:

| | raw cosine | mean-centred |
|---|---|---|
| Farhan Qureshi | 99.8% | **89%** |
| Arjun Kumar | 99.5% | **82%** |
| Nikhil Desai | 99.4% | **69%** |
| Tarun Bose | 99.7% | **58%** |
| Imran Shaikh | 98.4% | **22%** |

It is also the more honest question. Raw cosine asks *"are these two good at the same absolute
levels?"* — always roughly yes, because everyone in the dataset is a professional. Centred
cosine asks *"does this player deviate from the pool average the same way the reference does?"*,
which is what a scout means by "find me another Bumrah".

The mean is computed once at boot over the whole dataset, so `similarity(A, B)` is a stable
property of the pair — toggling `excludeIpl` changes which players you see, never their scores.
Reverting to the spec is a one-line change in [`src/lib/similarity.js`](src/lib/similarity.js).

Similarity is still reported **alongside** readiness everywhere, as `docs/02 §3` asks.

## The Claude layer

Grounding rules (verbatim from `docs/03 §AI-3`, non-negotiable): use only supplied statistics;
every numeric claim quotes a number in the input; caveat low-sample skills; comparables only
from the `similarPlayers` input; no hype words; **weaknesses are mandatory** — a report with no
weaknesses is not credible.

The backend assembles the payload itself from the dataset. The frontend never sends stats,
which prevents prompt tampering and keeps reports reproducible. Percentile ranks are computed
across the role pool and included, so "top decile" claims are checkable rather than vibes.

Two deliberate departures from `docs/03 §AI-3`, which predates current model behaviour:

1. **No `temperature`.** The doc specifies `temperature: 0.3`. Sampling parameters were removed
   on current Opus models and now return a **400**. Tone is steered by the system prompt.
2. **`output_config.format` instead of a tool forced with `tool_choice`.** Same guarantee —
   parseable JSON, no regex extraction from prose — with less machinery. This needs
   `@anthropic-ai/sdk` ≥ ~0.9x; older versions don't have the parameter at all.

Model is `CLAUDE_MODEL`, default `claude-opus-4-8`. `docs/03` names `claude-sonnet-5`; either
is reasonable since all facts are supplied, and it's a one-line env change.

**Caching and the demo rule.** Reports are cached to `cache/` keyed on
`(playerId, statsHash, modelVersion)`, so a stats or weight change invalidates automatically.
One call per player, ever — cost ≈ 0 and latency ≈ 0 on stage. `docs/02 §7` is explicit: never
stream a live Claude call during a judged demo without a cached fallback. So:
`npm run warm-cache` before demoing, and if the key is missing *or* the call throws, the API
serves a pre-written report and still returns 200. The demo survives a dead network.

## Data

`data/players.json` — 50 players: 8 IPL reference players and 42 SMAT prospects.

**The stats are fictional**, including those attached to real-name players, exactly as the
frontend's mock data already is. They are plausible (economies 6–9, strike rates 110–160) so
the charts look right, but no claim here is a real record.

Wiring in real data is a replacement of this one file, not a rewrite: `docs/04` documents the
Cricsheet ball-by-ball pipeline (`ipl_json.zip` + `sma_json.zip` + `people.csv` → per-player
aggregates → normalise → vectors), and the only contract is the shape endpoint 2 serves. Join
on Cricsheet registry IDs, never on name strings.

Honest gaps, per `docs/04 §5` — worth saying out loud rather than faking:

| Wanted | Why it's absent | Proxy used |
|---|---|---|
| Yorker % / delivery length | In no public ball-by-ball dataset | Death-overs containment (dot % + bowled/lbw rate in overs 16–20) |
| Misfields, reaction speed | Needs Hawk-Eye tracking | Fielding is catches + run-outs only |
| Bowling speed | Broadcast-only | Bowling-style tag |

The `coverage` flag on each player marks features whose sample is too thin to trust; the
frontend greys those rather than showing them as zero, and the LLM is told to caveat them.

## Layout

```
data/                    players.json, teams.json, features.json, explanations.json
cache/                   generated Claude reports (gitignored)
dist/                    build output (gitignored)
src/
  server.ts              app wiring: cors, json, mount /api, error handling
  store.ts               boot-time load, indexes, validation; owns ROOT/DATA_DIR/CACHE_DIR
  types/index.ts         the contract — mirrors ../scout-iq/src/lib/types.ts
  routes/                paths only, no logic
  controllers/           HTTP: read params, call a service, shape the response
  services/              the analytics — similarity, readiness, teamFit, claude
  middleware/            errorHandler, notFoundHandler
  utils/errors.ts        ApiError + helpers
  scripts/               rescore, warm-cache, verify
```

`routes → controllers → services`. Services know nothing about Express — no `Request`,
no `Response` — so the analytics are testable and callable from the scripts without a
server. Controllers do no arithmetic. Adding an endpoint touches one route file, one
controller, and `routes/index.ts` — never `server.ts`.

Controllers throw `ApiError` directly (`throw playerNotFound(id)`). Express 5 forwards both
synchronous throws and rejected promises to the error handler, so there is no `try/catch`
and no `next(err)` anywhere.

Everything lives in memory: 50 players is small enough that Postgres would only add setup
friction (`docs/04 §6`). The explanation cache is on disk. If the dataset grows to the point
where that stops being true, `src/store.ts` is the only file that needs to know.

### Two things that will bite you

**Import specifiers end in `.js`, not `.ts`.** `import { getPlayer } from "../store.js"` in a
`.ts` file is correct, not a mistake — it's what `module: NodeNext` requires. TypeScript
resolves it to `store.ts`; the emitted JS needs the `.js`.

**`store.ts` must stay exactly one level below `src/` and `dist/`.** It derives the project
root as "one level up from wherever this module ended up", which holds for both `src/store.ts`
and `dist/store.js`. Everything else imports `DATA_DIR` / `CACHE_DIR` from it rather than
recomputing paths — a script under `src/scripts/` doing its own `import.meta.url` + `".."`
would resolve to `dist/` once compiled and silently fail to find `data/`. This is also why
`rootDir` is pinned to `src` in `tsconfig.json`.

## Verification

```bash
npm run typecheck
npm run build && npm start     # run the COMPILED output, not dev
npm run verify                 # in another terminal
```

`npm run verify` asserts the things that actually break the UI rather than re-testing
arithmetic: that all 50 readiness breakdowns sum to their score *and* match the number the
dial reads; that `featureVector` is a flat array and contribution values are strings; that
`excludeIpl` excludes; that every error code is what the client expects; and that
`/api/explain/player` returns 200 with a report even with no API key.

Two of those assertions are regression guards for bugs that already happened once:

- **similarity spread > 15 points, nothing rounds to 100%** — if raw cosine ever comes back,
  the whole pool collapses into a 2.9-point band and every candidate reads 100%.
- **`npm run score` prints "Nothing to write"** — if it rewrites anything, the stored
  readiness has drifted from the model and the dial now disagrees with its own breakdown.

Verify against `npm start`, not `npm run dev`: `tsx` runs from `src/`, which would mask a
`dist/`-only path break.

## Attribution

Ball-by-ball data © [Cricsheet](https://cricsheet.org), ODC-By licence — required in the app
footer once real data is wired in. ESPNcricinfo is for manual spot-checks only; do not scrape it.
