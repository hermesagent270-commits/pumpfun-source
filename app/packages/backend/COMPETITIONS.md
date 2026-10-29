# Native /competitions read operations implementation

Status: five operations of the 67 documented developer API operations are now served natively
alongside the existing seven `/users` operations and six `/posts` operations (total 18 native operations).

| Operation | Path | Response |
| --- | --- | --- |
| `get_competitions` | `GET /v1/competitions` | 200 `{ "upcoming": Competition[], "live": Competition[], "past": Competition[] }` |
| `get_competitions_by_idOrSlug` | `GET /v1/competitions/{idOrSlug}` | 200 `{ "competition": Competition, "leaderboard": Leaderboard }`, 404 on miss |
| `get_competitions_by_id_entries_by_entryId` | `GET /v1/competitions/{id}/entries/{entryId}` | 200 `{ "entry": LeaderboardRow, "members": Member[] }`, 404 on miss |
| `get_competitions_by_id_entries_by_entryId_highlights` | `GET /v1/competitions/{id}/entries/{entryId}/highlights` | 200 `{ "entryId": string, "tokens": EntryHighlightToken[] }`, 404 on miss |
| `get_competitions_by_id_highlights` | `GET /v1/competitions/{id}/highlights` | 200 `{ "competitionId": string, "builtAtMs": number, "isFinal": boolean, "rows": HighlightRow[] }`, 404 on miss |

Unimplemented routes continue to fall through to fixture replay, and to `501 COMPATIBILITY_NOT_IMPLEMENTED`
when no fixture matches.

## Source layout

- `src/competitions-store.ts` - `CompetitionStore`, deterministic in-memory store with O(1)
  competition lookup by ID and slug, ranked board calculation with tie-breaking, entry detail,
  per-entry highlights, and competition-wide highlight reels filtered by winning legs and per-member caps.
  Hydrates participant and member profile information from `UserStore`. `defaultCompetitionStore` is the singleton.
- `src/competitions-seed.json` - hand-authored synthetic competition fixtures (upcoming, live person,
  ended squad, and ended person tie-breaker competitions), all strictly conforming to the schemas in
  `contracts/developer.openapi.json`.
- `src/competitions-routes.ts` - the five native Fastify route handlers.
- `src/app.ts` - `buildApp()` registers competition routes before generic fixture replay and excludes
  all five OpenAPI path patterns in `NATIVE_ROUTES`.
- `src/schema-validator.ts` - JSON Schema validator resolving `$ref` against the OpenAPI root,
  honoring `additionalProperties: false`, required keys, and `anyOf` enums.
- `test/competitions.test.ts` - comprehensive functional, deterministic bucket, limit boundary,
  tie-breaking, route ordering, and schema tests.
- `test/contract-conformance.test.ts` - validates each native `/competitions` response against its
  documented 200 schema in `contracts/developer.openapi.json`.

## Data source and its limits

The competition seed is hand-authored synthetic data shaped strictly to the contract schemas in
`contracts/developer.openapi.json`. It is **not** captured production traffic, and no real
pump.fun trade competitions or ledger settlements exist behind these rows.

`app/AGENTS.md` forbids fabricated domain responses, so this data is labelled wherever it surfaces:

- `DATA_SOURCE = 'synthetic-seed-play'` in `src/competitions-store.ts`.
- Every successful native response carries `X-Reconstruction-Data-Source: synthetic-seed-play`.
  Error responses carry no marker because they contain no domain data.
- Contract and functional tests assert the marker header is present on every 200 response.
- Participant and roster member profiles reuse `UserStore` and its existing seed data
  (`src/users-seed.json`) rather than inventing a parallel user model.

## Documented assumptions

The contract does not specify every behavior. Each was decided deliberately; changing any of them
is a contract decision, not a bug fix.

34. **Lookup miss on `GET /competitions/{idOrSlug}` and sub-resources**: Returns `404 {"error":"NOT_FOUND"}`
    when `idOrSlug`, `id`, or `entryId` does not exist, or when an entry does not belong to the requested
    competition. The OpenAPI specification documents only 200 and transport-level errors in its response
    table, so 404 is an addition conforming to the `Error` component envelope.
35. **Determinism and bucket assignment in `GET /competitions`**: Competitions are partitioned into
    `upcoming`, `live`, and `past` strictly by their seeded `phase` field (`phase: 'upcoming'` -> `upcoming`,
    `phase: 'registration' | 'live'` -> `live`, `phase: 'ended'` -> `past`) rather than comparing wall-clock
    `Date.now()` to `registrationOpensAt` or `endsAt`. This guarantees identical bucket assignments across runs.
36. **Bucket ordering in `GET /competitions`**: Within `upcoming`, competitions sort by `startsAt` ascending.
    Within `live`, competitions sort by `startsAt` ascending. Within `past`, competitions sort by `endsAt`
    descending, capped at at most 50 items per the contract note.
37. **Empty bucket representation in `GET /competitions`**: If a bucket has no qualifying competitions,
    it is returned as an empty array `[]` rather than null or omitted, satisfying the required array schemas.
38. **Dual resolution in `GET /competitions/{idOrSlug}`**: The path parameter `:idOrSlug` matches against
    competition `id` (UUID) first, then case-insensitively against `slug`.
39. **Response shape of `GET /competitions/{idOrSlug}`**: Returns `{ competition, leaderboard }` conforming
    to the OpenAPI schema. The ranking array is named `leaderboard`, as the contract requires with
    `additionalProperties: false`; the name `board` is not used anywhere in the response.
40. **Anonymous viewer omission**: In `GET /competitions/{idOrSlug}`, the `viewer` property is omitted
    entirely for anonymous requests, matching the OpenAPI description ("Absent on the API host" / "omitted,
    never null, when anonymous").
41. **Leaderboard pagination and clamping on `GET /competitions/{idOrSlug}`**: `limit` defaults to 100 with
    a ceiling of 100. Non-positive or negative values clamp to 0 (returning empty entries). Values above 100
    clamp to 100. Non-numeric or missing values default to 100.
42. **`positionsLimit` clamping and squad behavior**: In `GET /competitions/{idOrSlug}`, `positionsLimit`
    defaults to 3 and clamps between 0 and 5. For person competitions that are not final, `topPositions`
    is sliced to `positionsLimit`. Squad competitions (`kind: 'group'`) or finalized competitions (`isFinal: true`)
    always return `topPositions: []` and `positionsCount: 0` per the contract.
43. **Ranking order and tie-breakers**: Board ranks are 1-based and ordered strictly by `pnlUsd` descending.
    Tied `pnlUsd` values break ties on earlier registration timestamp (`registeredAt` ascending), then lexically
    on `entryId` ascending. Struck entries (`struck: true`) have rank 0 and are omitted from `leaderboard.entries`,
    `totalRanked`, `participants`, `top`, and `winners`. Before the first board build (`builtAtMs = 0`,
    derived from the maximum entry refresh time), every entry has rank 0 and public ranked lists are empty.
    Registered non-struck entries still count as `participants` before that build.
    A person entry with an explicitly supplied `walletAddress: null` also has rank 0 and is
    excluded from ranked boards, top, winners and competition highlights; it remains registered,
    non-struck and accessible by entry detail. This follows factory `139209-8d4ffb7afbfa`'s
    "no scoring wallet" rank-0 state. Omitted wallet facts are not treated as known absence.
44. **`top` and `winners` calculation on `Competition`**: For competitions in phase `registration` or `live`,
    `top` carries ranks 1..3 from the active board build; for other phases, `top` is `[]`. For competitions
    in phase `ended`, `winners` carries ranks 1..N (where N is the highest `rankTo` in `prizes`, or 3 if `prizes`
    is empty), with `prize` populated from the matching prize tier; for other phases, `winners` is `[]`.
    In `GET /competitions/{idOrSlug}`, `top` and `winners` rows slice `topPositions` to the request's
    `positionsLimit`, like `leaderboard.entries`; the list buckets use the default of 3.
45. **Struck entry availability in `GET /competitions/:id/entries/:entryId`**: Struck entries (`struck: true`,
    rank 0) are excluded from public boards but remain accessible via direct entry detail lookup, matching the
    contract specification. Member legs are sorted by `pnlUsd` descending.
46. **Entry highlights limit clamping in `GET /competitions/:id/entries/:entryId/highlights`**: `limit`
    defaults to 10, with ceiling 10. Non-positive or zero values clamp to 1. Values above 10 clamp to 10.
    Tokens are sorted by `pnlUsd` descending.
47. **Competition highlights clamping and per-member limit in `GET /competitions/:id/highlights`**: `limit`
    defaults to 20 (ceiling 20, minimum 1). `perMemberLimit` defaults to 1 (ceiling 10, minimum 1). Highlights
    only include winning legs (`pnlUsd > 0`) from non-struck ranked entries. Each member contributes at most
    `perMemberLimit` rows before total rows are capped by `limit`. Rows are ordered strictly by `pnlUsd` descending.
48. **Route registration precedence**: Sub-resource routes (`/v1/competitions/:id/entries/:entryId/highlights`,
    `/v1/competitions/:id/entries/:entryId`, `/v1/competitions/:id/highlights`) are registered before
    `/v1/competitions/:idOrSlug` to prevent `:idOrSlug` from capturing multi-segment paths.
49. **UserStore hydration**: Competition entries and members hydrate profile information (username,
    profileImageUrl, walletAddress, isVerified) from the shared `UserStore` and its synthetic seed
    (`users-seed.json`), preventing divergent user identities. For person entries, an optional
    `RawEntry.walletAddress` supplies the board wallet snapshotted at competition start: a string
    overrides today's profile wallet and null records known absence. The same snapshot is served
    in the person's member detail. Omission retains the legacy profile fallback, including its
    limitation that it does not establish a historical wallet; a missing profile never implies an
    explicit absent snapshot. Group entries ignore this person-only field and retain their separate
    member-wallet inputs. Squad rows and pre-build entry rows set `walletAddress: null` per contract.
    These are operator-supplied local model facts, not a recovered snapshot writer or production
    data. The synthetic provenance and unqualified compatibility boundary are unchanged.
50. **`leaderboard.startSec` and `endSec`**: `startSec` is `startsAt`. `endSec` is the scoring window end the
    served legs were read at: the last board build (`builtAtMs`, in seconds) while the board is not final, and
    `endsAt` once `isFinal` is true. Before the first build `builtAtMs` and `endSec` are both 0.

## Not implemented

The following competition-related endpoints belong to internal operations, mutation flows, or uncatalogued
moderation tooling and are not part of the developer OpenAPI read operations implemented here:

- `POST /v1/competitions/{id}/register` (competition entry registration)
- `GET /v1/competitions/tos` and `POST /v1/competitions/tos/accept` (terms-of-service agreement flows)
- `POST /v1/competitions/{id}/entries/{entryId}/strike` and `/unstrike` (moderator disqualification mutations)
- `GET /v1/competitions/{id}/entries/{entryId}/positions` (expanded live positions list)
- `GET /v1/competitions/{id}/moderation/entries` (privileged moderation dashboard)

Any request targeting these unimplemented paths continues to return `501 COMPATIBILITY_NOT_IMPLEMENTED`.

## Verification

```sh
cd app/packages/backend
npx tsx --test test/*.test.ts     # counts grow as operations are added; the run prints the current totals
../../node_modules/.bin/tsc --noEmit -p tsconfig.json
```
