/**
 * Comprehensive tests for native /competitions operations.
 *
 * Verifies:
 * - Contract conformance for every 200 response via assertSchema(..., specRoot).
 * - Deterministic bucket partitioning (upcoming, live, past) and ordering.
 * - ID and slug dual-resolution returning identical objects.
 * - Unknown competition (404) and unknown entry (404) behavior.
 * - Board ranking, limit, and positionsLimit boundaries.
 * - Route ordering: sub-resources are not shadowed by parameterized paths.
 * - Struck entry handling: excluded from public boards but accessible by entry ID.
 * - Tie-breaking behavior on identical PnL.
 * - Highlights filtering: positive PnL only, per-member limit enforcement.
 * - Regression: /users, /posts, fixture replay, and 501 compatibility.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from './with-api-key.js';
import { assertSchema, type SchemaNode, type SchemaRoot } from '../src/schema-validator.js';
import { SYNTHETIC_HEADER } from '../src/users-routes.js';
import { DATA_SOURCE } from '../src/users-store.js';
import { CompetitionStore, type RawCompetition } from '../src/competitions-store.js';

interface OpenApiDocument {
  paths: Record<string, Record<string, {
    responses?: Record<string, { content?: Record<string, { schema?: SchemaNode }> }>;
  }>>;
  components?: { schemas?: Record<string, SchemaNode> };
}

const SPEC_PATH = fileURLToPath(new URL('../../../contracts/developer.openapi.json', import.meta.url));
const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8')) as OpenApiDocument;
const specRoot = spec as unknown as SchemaRoot;

function documentedSchema(path: string, method: string, status: number): SchemaNode {
  const schema = spec.paths[path]?.[method.toLowerCase()]?.responses?.[String(status)]?.content?.['application/json']?.schema;
  assert.ok(schema, `No documented schema for ${method.toUpperCase()} ${path} ${status}`);
  return schema;
}

const errorSchema = spec.components?.schemas?.Error as SchemaNode;
assert.ok(errorSchema, 'components.schemas.Error must exist');

const UPCOMING_ID = '11111111-1111-4000-8000-000000000001';
const UPCOMING_SLUG = 'solana-autumn-arena';

const LIVE_ID = '11111111-1111-4000-8000-000000000002';
const LIVE_SLUG = 'degen-derby-2024';
const LIVE_ENTRY_1 = '22222222-2222-4000-8000-000000000001'; // Alice
const LIVE_ENTRY_2 = '22222222-2222-4000-8000-000000000002'; // Bob
const LIVE_ENTRY_3 = '22222222-2222-4000-8000-000000000003'; // User 3
const LIVE_STRUCK_ENTRY = '22222222-2222-4000-8000-000000000004'; // Banned / Struck

const SQUAD_ENDED_ID = '11111111-1111-4000-8000-000000000003';
const SQUAD_ENDED_SLUG = 'squad-showdown-s1';
const SQUAD_ENTRY_1 = '33333333-3333-4000-8000-000000000001';

const TIE_ENDED_ID = '11111111-1111-4000-8000-000000000004';
const TIE_ENDED_SLUG = 'winter-warfare';
const TIE_ENTRY_1 = '44444444-4444-4000-8000-000000000001';
const TIE_ENTRY_2 = '44444444-4444-4000-8000-000000000002';

const UNKNOWN_UUID = '99999999-9999-4000-8000-999999999999';

describe('GET /v1/competitions', () => {
  test('returns 200 with three buckets conforming to schema and marked with synthetic header', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/competitions' });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers[SYNTHETIC_HEADER.toLowerCase()], DATA_SOURCE);

      const json = res.json();
      assertSchema(json, documentedSchema('/competitions', 'get', 200), 'GET /competitions', specRoot);

      assert.ok(Array.isArray(json.upcoming));
      assert.ok(Array.isArray(json.live));
      assert.ok(Array.isArray(json.past));

      assert.equal(json.upcoming.length, 1);
      assert.equal(json.upcoming[0].id, UPCOMING_ID);

      assert.equal(json.live.length, 1);
      assert.equal(json.live[0].id, LIVE_ID);

      assert.equal(json.past.length, 2);
    } finally {
      await app.close();
    }
  });

  test('bucket determinism: two consecutive calls return identical ordering and structure', async () => {
    const app = buildApp([]);
    try {
      const res1 = await app.inject({ method: 'GET', url: '/v1/competitions' });
      const res2 = await app.inject({ method: 'GET', url: '/v1/competitions' });
      assert.deepEqual(res1.json(), res2.json());
    } finally {
      await app.close();
    }
  });

  test('empty buckets return empty array rather than null or missing', async () => {
    // Custom store with only one live competition
    const singleSeed: RawCompetition[] = [
      {
        id: LIVE_ID,
        slug: LIVE_SLUG,
        kind: 'person',
        title: 'Solo Live',
        description: 'Single live competition',
        prizeCopy: 'No prize',
        imageUrl: null,
        prizes: [],
        registrationOpensAt: '2024-01-01T00:00:00.000Z',
        registrationClosesAt: '2024-02-01T00:00:00.000Z',
        startsAt: '2024-01-01T00:00:00.000Z',
        endsAt: '2024-02-01T00:00:00.000Z',
        minMembers: 1,
        maxMembers: 1,
        maxEntries: 10,
        phase: 'live',
        isFinal: false,
        joinable: true,
        entries: [],
      },
    ];
    const customStore = new CompetitionStore(singleSeed);
    const app = buildApp([], { competitionStore: customStore });
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/competitions' });
      assert.equal(res.statusCode, 200);
      const json = res.json();
      assertSchema(json, documentedSchema('/competitions', 'get', 200), 'GET /competitions empty buckets', specRoot);
      assert.deepEqual(json.upcoming, []);
      assert.equal(json.live.length, 1);
      assert.deepEqual(json.past, []);
    } finally {
      await app.close();
    }
  });

  test('live bucket is ordered by startsAt ascending, not endsAt', async () => {
    // Contract: live is "startsAt ascending". The earlier start ends last here.
    const liveCompetition = (id: string, slug: string, startsAt: string, endsAt: string): RawCompetition => ({
      id,
      slug,
      kind: 'person',
      title: slug,
      description: slug,
      prizeCopy: 'No prize',
      imageUrl: null,
      prizes: [],
      registrationOpensAt: '2024-01-01T00:00:00.000Z',
      registrationClosesAt: endsAt,
      startsAt,
      endsAt,
      minMembers: 1,
      maxMembers: 1,
      maxEntries: 10,
      phase: 'live',
      isFinal: false,
      joinable: true,
      entries: [],
    });
    const store = new CompetitionStore([
      liveCompetition('11111111-1111-4000-8000-0000000000b1', 'starts-later-ends-first', '2024-02-01T00:00:00.000Z', '2024-02-15T00:00:00.000Z'),
      liveCompetition('11111111-1111-4000-8000-0000000000a1', 'starts-first-ends-last', '2024-01-01T00:00:00.000Z', '2024-03-01T00:00:00.000Z'),
    ]);
    const app = buildApp([], { competitionStore: store });
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/competitions' });
      assert.equal(res.statusCode, 200);
      const json = res.json();
      assertSchema(json, documentedSchema('/competitions', 'get', 200), 'GET /competitions live order', specRoot);
      assert.deepEqual(
        json.live.map((competition: { slug: string }) => competition.slug),
        ['starts-first-ends-last', 'starts-later-ends-first'],
      );
    } finally {
      await app.close();
    }
  });
});

describe('GET /v1/competitions/:idOrSlug', () => {
  test('resolves competition by id and conforms to schema', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({ method: 'GET', url: `/v1/competitions/${LIVE_ID}` });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers[SYNTHETIC_HEADER.toLowerCase()], DATA_SOURCE);

      const json = res.json();
      assertSchema(json, documentedSchema('/competitions/{idOrSlug}', 'get', 200), 'GET /competitions/:id', specRoot);

      assert.equal(json.competition.id, LIVE_ID);
      assert.equal(json.competition.slug, LIVE_SLUG);
      assert.equal(json.competition.kind, 'person');
      assert.equal(json.leaderboard.isFinal, false);
      assert.equal(json.leaderboard.totalRanked, 3);
      assert.equal(json.leaderboard.entries.length, 3);
    } finally {
      await app.close();
    }
  });

  test('resolves competition by slug returning the identical payload', async () => {
    const app = buildApp([]);
    try {
      const byId = await app.inject({ method: 'GET', url: `/v1/competitions/${LIVE_ID}` });
      const bySlug = await app.inject({ method: 'GET', url: `/v1/competitions/${LIVE_SLUG}` });

      assert.equal(bySlug.statusCode, 200);
      assert.deepEqual(bySlug.json(), byId.json());
    } finally {
      await app.close();
    }
  });

  test('case-insensitive slug resolution', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({ method: 'GET', url: `/v1/competitions/DEGEN-DERBY-2024` });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().competition.id, LIVE_ID);
    } finally {
      await app.close();
    }
  });

  test('unknown id or slug returns 404 NOT_FOUND conforming to Error component', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({ method: 'GET', url: `/v1/competitions/${UNKNOWN_UUID}` });
      assert.equal(res.statusCode, 404);
      const json = res.json();
      assert.equal(json.statusCode, 404);
      assert.equal(json.error, 'NOT_FOUND');
      assertSchema(json, errorSchema, '404 error schema', specRoot);
    } finally {
      await app.close();
    }
  });

  test('struck entry is omitted from leaderboard entries and totalRanked', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({ method: 'GET', url: `/v1/competitions/${LIVE_ID}` });
      assert.equal(res.statusCode, 200);
      const json = res.json();

      // Total registered entries in seed is 4, but 1 is struck
      assert.equal(json.competition.entriesCount, 4);
      assert.equal(json.competition.participants, 3);
      assert.equal(json.leaderboard.totalRanked, 3);
      assert.equal(json.leaderboard.entries.length, 3);

      const entryIds = json.leaderboard.entries.map((e: { entryId: string }) => e.entryId);
      assert.ok(!entryIds.includes(LIVE_STRUCK_ENTRY));
    } finally {
      await app.close();
    }
  });

  test('ranking boundary: limit smaller than board size', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({ method: 'GET', url: `/v1/competitions/${LIVE_ID}?limit=2` });
      assert.equal(res.statusCode, 200);
      const json = res.json();
      assert.equal(json.leaderboard.totalRanked, 3); // Total ranked is still 3
      assert.equal(json.leaderboard.entries.length, 2); // Sliced to limit=2
      assert.equal(json.leaderboard.entries[0].rank, 1);
      assert.equal(json.leaderboard.entries[1].rank, 2);
    } finally {
      await app.close();
    }
  });

  test('ranking boundary: limit larger than board size', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({ method: 'GET', url: `/v1/competitions/${LIVE_ID}?limit=50` });
      assert.equal(res.statusCode, 200);
      const json = res.json();
      assert.equal(json.leaderboard.totalRanked, 3);
      assert.equal(json.leaderboard.entries.length, 3);
    } finally {
      await app.close();
    }
  });

  test('positionsLimit clamping: values above 5 clamp to 5', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({ method: 'GET', url: `/v1/competitions/${LIVE_ID}?positionsLimit=10` });
      assert.equal(res.statusCode, 200);
      const json = res.json();
      // Entry 1 has 4 positions in seed; clamped limit of 5 returns all 4
      assert.equal(json.leaderboard.entries[0].topPositions.length, 4);
    } finally {
      await app.close();
    }
  });

  test('positionsLimit: 0 returns empty topPositions (count only)', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({ method: 'GET', url: `/v1/competitions/${LIVE_ID}?positionsLimit=0` });
      assert.equal(res.statusCode, 200);
      const json = res.json();
      assert.equal(json.leaderboard.entries[0].positionsCount, 4);
      assert.equal(json.leaderboard.entries[0].topPositions.length, 0);
    } finally {
      await app.close();
    }
  });

  test('positionsLimit also slices competition.top rows', async () => {
    const app = buildApp([]);
    try {
      for (const [positionsLimit, expected] of [[0, 0], [1, 1], [5, 4]]) {
        const res = await app.inject({ method: 'GET', url: `/v1/competitions/${LIVE_ID}?positionsLimit=${positionsLimit}` });
        assert.equal(res.statusCode, 200);
        const json = res.json();
        assertSchema(json, documentedSchema('/competitions/{idOrSlug}', 'get', 200), `GET /competitions positionsLimit=${positionsLimit}`, specRoot);
        // Entry 1 has 4 positions in seed; top and leaderboard rows describe the same entry
        assert.equal(json.competition.top[0].entryId, LIVE_ENTRY_1);
        assert.equal(json.competition.top[0].positionsCount, 4);
        assert.equal(json.competition.top[0].topPositions.length, expected, `top[0] at positionsLimit=${positionsLimit}`);
        assert.deepEqual(json.competition.top[0].topPositions, json.leaderboard.entries[0].topPositions);
      }
    } finally {
      await app.close();
    }
  });

  test('positionsLimit also slices winners rows of an ended person competition that is not final', async () => {
    const seed = JSON.parse(readFileSync(new URL('../src/competitions-seed.json', import.meta.url), 'utf8')) as RawCompetition[];
    const live = seed.find(c => c.id === LIVE_ID);
    assert.ok(live);
    const ended: RawCompetition = { ...live, phase: 'ended', isFinal: false };
    const app = buildApp([], { competitionStore: new CompetitionStore([ended]) });
    try {
      for (const [positionsLimit, expected] of [[0, 0], [5, 4]]) {
        const res = await app.inject({ method: 'GET', url: `/v1/competitions/${LIVE_ID}?positionsLimit=${positionsLimit}` });
        assert.equal(res.statusCode, 200);
        const json = res.json();
        assertSchema(json, documentedSchema('/competitions/{idOrSlug}', 'get', 200), `GET /competitions winners positionsLimit=${positionsLimit}`, specRoot);
        assert.equal(json.competition.winners[0].entryId, LIVE_ENTRY_1);
        assert.equal(json.competition.winners[0].topPositions.length, expected, `winners[0] at positionsLimit=${positionsLimit}`);
      }
    } finally {
      await app.close();
    }
  });

  test('squad competition: walletAddress is null, topPositions is [], positionsCount is 0', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({ method: 'GET', url: `/v1/competitions/${SQUAD_ENDED_ID}` });
      assert.equal(res.statusCode, 200);
      const json = res.json();
      assertSchema(json, documentedSchema('/competitions/{idOrSlug}', 'get', 200), 'GET /competitions squad', specRoot);

      assert.equal(json.competition.kind, 'group');
      const entry = json.leaderboard.entries[0];
      assert.equal(entry.walletAddress, null);
      assert.equal(entry.positionsCount, 0);
      assert.deepEqual(entry.topPositions, []);
      assert.equal(entry.memberCount, 2);
    } finally {
      await app.close();
    }
  });

  test('finalized competition carries winners with prizes and empty top', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({ method: 'GET', url: `/v1/competitions/${SQUAD_ENDED_ID}` });
      assert.equal(res.statusCode, 200);
      const json = res.json();

      assert.equal(json.competition.isFinal, true);
      assert.deepEqual(json.competition.top, []); // top is [] on ended
      assert.ok(json.competition.winners.length > 0);
      assert.equal(json.competition.winners[0].prize, '$30,000');
      assert.equal(json.competition.winners[1].prize, '$20,000');
    } finally {
      await app.close();
    }
  });

  test('tie-breaking on identical PnL: earlier registration ranks first', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({ method: 'GET', url: `/v1/competitions/${TIE_ENDED_ID}` });
      assert.equal(res.statusCode, 200);
      const json = res.json();
      assert.equal(json.leaderboard.entries.length, 2);
      assert.equal(json.leaderboard.entries[0].entryId, TIE_ENTRY_1);
      assert.equal(json.leaderboard.entries[0].rank, 1);
      assert.equal(json.leaderboard.entries[1].entryId, TIE_ENTRY_2);
      assert.equal(json.leaderboard.entries[1].rank, 2);
    } finally {
      await app.close();
    }
  });

  test('leaderboard.endSec is the last build while live and endsAt once final', async () => {
    const app = buildApp([]);
    try {
      // Contract: "the last build while live, endsAt once final"; builtAtMs is "0 before the first build"
      const cases: Array<[string, boolean, (json: any) => number]> = [
        [LIVE_ID, false, json => Math.trunc(json.leaderboard.builtAtMs / 1000)],
        [UPCOMING_ID, false, () => 0],
        [TIE_ENDED_ID, true, json => Math.trunc(Date.parse(json.competition.endsAt) / 1000)],
        [SQUAD_ENDED_ID, true, json => Math.trunc(Date.parse(json.competition.endsAt) / 1000)],
      ];
      for (const [id, isFinal, expectedEndSec] of cases) {
        const res = await app.inject({ method: 'GET', url: `/v1/competitions/${id}` });
        assert.equal(res.statusCode, 200);
        const json = res.json();
        assertSchema(json, documentedSchema('/competitions/{idOrSlug}', 'get', 200), `GET /competitions/${id}`, specRoot);
        assert.equal(json.leaderboard.isFinal, isFinal);
        assert.equal(json.leaderboard.startSec, Math.trunc(Date.parse(json.competition.startsAt) / 1000));
        assert.equal(json.leaderboard.endSec, expectedEndSec(json), `endSec of ${id}`);
      }
      // The live seed board was built well before its endsAt
      const live = (await app.inject({ method: 'GET', url: `/v1/competitions/${LIVE_ID}` })).json();
      assert.ok(live.leaderboard.endSec < Math.trunc(Date.parse(live.competition.endsAt) / 1000));
    } finally {
      await app.close();
    }
  });
});

describe('competition before the first board build', () => {
  function unbuiltCompetition(phase: 'registration' | 'live'): RawCompetition {
    const seed = JSON.parse(readFileSync(new URL('../src/competitions-seed.json', import.meta.url), 'utf8')) as RawCompetition[];
    const live = seed.find(c => c.id === LIVE_ID);
    assert.ok(live);
    return {
      ...live,
      phase,
      entries: live.entries.map(entry => ({
        ...entry,
        pnlUsd: 0,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        buySpendSol: 0,
        membersFresh: 0,
        lastRefreshedAtMs: 0,
        positions: [],
        highlightTokens: [],
      })),
    };
  }

  for (const phase of ['registration', 'live'] as const) {
    test(`${phase} entry highlights stay empty before the first build even with retained token rows`, async () => {
      const seed = JSON.parse(readFileSync(new URL('../src/competitions-seed.json', import.meta.url), 'utf8')) as RawCompetition[];
      const source = seed.find(c => c.id === LIVE_ID);
      assert.ok(source);
      assert.ok(source.entries.some(entry => (entry.highlightTokens?.length ?? 0) > 0));
      const competition = {
        ...source,
        phase,
        entries: source.entries.map(entry => ({ ...entry, lastRefreshedAtMs: 0 })),
      };
      const app = buildApp([], { competitionStore: new CompetitionStore([competition]) });
      try {
        const highlights = await app.inject({ method: 'GET', url: `/v1/competitions/${LIVE_ID}/entries/${LIVE_ENTRY_1}/highlights` });
        assert.equal(highlights.statusCode, 200);
        assertSchema(highlights.json(), documentedSchema('/competitions/{id}/entries/{entryId}/highlights', 'get', 200), 'unbuilt entry highlights', specRoot);
        assert.deepEqual(highlights.json().tokens, []);
      } finally {
        await app.close();
      }
    });

    test(`${phase} entries remain registered but unranked before the first build`, async () => {
      const app = buildApp([], { competitionStore: new CompetitionStore([unbuiltCompetition(phase)]) });
      try {
        const detail = await app.inject({ method: 'GET', url: `/v1/competitions/${LIVE_ID}` });
        assert.equal(detail.statusCode, 200);
        const json = detail.json();
        assertSchema(json, documentedSchema('/competitions/{idOrSlug}', 'get', 200), 'unbuilt competition', specRoot);
        assert.equal(json.leaderboard.builtAtMs, 0);
        assert.equal(json.leaderboard.endSec, 0);
        assert.equal(json.leaderboard.totalRanked, 0);
        assert.deepEqual(json.leaderboard.entries, []);
        assert.equal(json.competition.entriesCount, 4);
        assert.equal(json.competition.participants, 3); // Registered, non-struck entries still count.
        assert.deepEqual(json.competition.top, []);
        assert.deepEqual(json.competition.winners, []);

        const list = await app.inject({ method: 'GET', url: '/v1/competitions' });
        assert.equal(list.statusCode, 200);
        assertSchema(list.json(), documentedSchema('/competitions', 'get', 200), 'unbuilt competition list', specRoot);
        assert.deepEqual(list.json().live[0], json.competition);

        const entry = await app.inject({ method: 'GET', url: `/v1/competitions/${LIVE_ID}/entries/${LIVE_ENTRY_1}` });
        assert.equal(entry.statusCode, 200);
        assertSchema(entry.json(), documentedSchema('/competitions/{id}/entries/{entryId}', 'get', 200), 'unbuilt entry', specRoot);
        assert.equal(entry.json().entry.rank, 0);
        assert.equal(entry.json().entry.walletAddress, null);
      } finally {
        await app.close();
      }
    });
  }

  test('a completed build ranks zero-PnL entries and retains the person wallet', async () => {
    const competition = unbuiltCompetition('live');
    for (const entry of competition.entries) entry.lastRefreshedAtMs = 1714560000000;
    const app = buildApp([], { competitionStore: new CompetitionStore([competition]) });
    try {
      const detail = await app.inject({ method: 'GET', url: `/v1/competitions/${LIVE_ID}` });
      assert.equal(detail.statusCode, 200);
      const json = detail.json();
      assert.equal(json.leaderboard.totalRanked, 3);
      assert.deepEqual(json.leaderboard.entries.map((entry: { rank: number }) => entry.rank), [1, 2, 3]);
      assert.equal(json.competition.top.length, 3);
      assert.ok(json.leaderboard.entries[0].walletAddress);
      const struck = await app.inject({ method: 'GET', url: `/v1/competitions/${LIVE_ID}/entries/${LIVE_STRUCK_ENTRY}` });
      assert.equal(struck.statusCode, 200);
      assert.equal(struck.json().entry.rank, 0);
      assert.ok(struck.json().entry.walletAddress);
    } finally {
      await app.close();
    }
  });
});

describe('GET /v1/competitions/:id/entries/:entryId', () => {
  test('returns 200 with entry and members matching published schema', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/competitions/${LIVE_ID}/entries/${LIVE_ENTRY_1}`,
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers[SYNTHETIC_HEADER.toLowerCase()], DATA_SOURCE);

      const json = res.json();
      assertSchema(json, documentedSchema('/competitions/{id}/entries/{entryId}', 'get', 200), 'GET entry detail', specRoot);

      assert.equal(json.entry.entryId, LIVE_ENTRY_1);
      assert.equal(json.entry.participantId, 'user-001');
      assert.equal(json.entry.username, 'alice_pump');
      assert.equal(json.entry.isVerified, true);
      assert.equal(json.members.length, 1);
      assert.equal(json.members[0].userId, 'user-001');
      assert.equal(json.members[0].isVerified, true);
    } finally {
      await app.close();
    }
  });

  test('squad entry returns member breakdown sorted by pnlUsd descending', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/competitions/${SQUAD_ENDED_ID}/entries/${SQUAD_ENTRY_1}`,
      });
      assert.equal(res.statusCode, 200);
      const json = res.json();
      assertSchema(json, documentedSchema('/competitions/{id}/entries/{entryId}', 'get', 200), 'GET squad entry', specRoot);

      assert.equal(json.members.length, 2);
      assert.ok(json.members[0].pnlUsd >= json.members[1].pnlUsd);
      assert.equal(json.members[0].userId, 'user-001');
      assert.equal(json.members[1].userId, 'user-002');
    } finally {
      await app.close();
    }
  });

  test('struck entry is still served by entry detail lookup (rank 0)', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/competitions/${LIVE_ID}/entries/${LIVE_STRUCK_ENTRY}`,
      });
      assert.equal(res.statusCode, 200);
      const json = res.json();
      assertSchema(json, documentedSchema('/competitions/{id}/entries/{entryId}', 'get', 200), 'GET struck entry', specRoot);
      assert.equal(json.entry.entryId, LIVE_STRUCK_ENTRY);
      assert.equal(json.entry.struck, true);
      assert.equal(json.entry.rank, 0);
    } finally {
      await app.close();
    }
  });

  test('unknown competition returns 404', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/competitions/${UNKNOWN_UUID}/entries/${LIVE_ENTRY_1}`,
      });
      assert.equal(res.statusCode, 404);
      assert.equal(res.json().error, 'NOT_FOUND');
    } finally {
      await app.close();
    }
  });

  test('unknown entry returns 404', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/competitions/${LIVE_ID}/entries/${UNKNOWN_UUID}`,
      });
      assert.equal(res.statusCode, 404);
      assert.equal(res.json().error, 'NOT_FOUND');
    } finally {
      await app.close();
    }
  });
});

describe('GET /v1/competitions/:id/entries/:entryId/highlights', () => {
  test('returns 200 with entryId and tokens conforming to schema', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/competitions/${LIVE_ID}/entries/${LIVE_ENTRY_1}/highlights`,
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers[SYNTHETIC_HEADER.toLowerCase()], DATA_SOURCE);

      const json = res.json();
      assertSchema(
        json,
        documentedSchema('/competitions/{id}/entries/{entryId}/highlights', 'get', 200),
        'GET entry highlights',
        specRoot,
      );

      assert.equal(json.entryId, LIVE_ENTRY_1);
      assert.equal(json.tokens.length, 2);
      assert.ok(json.tokens[0].pnlUsd >= json.tokens[1].pnlUsd);
      assert.equal(json.tokens[0].members[0].userId, 'user-001');
    } finally {
      await app.close();
    }
  });

  test('limit parameter slices returned tokens', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/competitions/${LIVE_ID}/entries/${LIVE_ENTRY_1}/highlights?limit=1`,
      });
      assert.equal(res.statusCode, 200);
      const json = res.json();
      assert.equal(json.tokens.length, 1);
    } finally {
      await app.close();
    }
  });

  test('unknown competition or entry returns 404', async () => {
    const app = buildApp([]);
    try {
      const res1 = await app.inject({
        method: 'GET',
        url: `/v1/competitions/${UNKNOWN_UUID}/entries/${LIVE_ENTRY_1}/highlights`,
      });
      assert.equal(res1.statusCode, 404);

      const res2 = await app.inject({
        method: 'GET',
        url: `/v1/competitions/${LIVE_ID}/entries/${UNKNOWN_UUID}/highlights`,
      });
      assert.equal(res2.statusCode, 404);
    } finally {
      await app.close();
    }
  });
});

describe('GET /v1/competitions/:id/highlights', () => {
  test('returns 200 with competition highlights conforming to schema', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/competitions/${LIVE_ID}/highlights`,
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers[SYNTHETIC_HEADER.toLowerCase()], DATA_SOURCE);

      const json = res.json();
      assertSchema(
        json,
        documentedSchema('/competitions/{id}/highlights', 'get', 200),
        'GET competition highlights',
        specRoot,
      );

      assert.equal(json.competitionId, LIVE_ID);
      assert.equal(json.isFinal, false);
      assert.ok(Array.isArray(json.rows));
      assert.ok(json.rows.length > 0);

      // Verify wins only (pnlUsd > 0)
      for (const row of json.rows) {
        assert.ok(row.pnlUsd > 0, 'Every row must have pnlUsd > 0');
      }

      // Default perMemberLimit is 1: each userId appears at most once
      const userIds = json.rows.map((r: { userId: string }) => r.userId);
      assert.equal(new Set(userIds).size, userIds.length);
    } finally {
      await app.close();
    }
  });

  test('perMemberLimit allows multiple winning legs per member', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/competitions/${LIVE_ID}/highlights?perMemberLimit=2`,
      });
      assert.equal(res.statusCode, 200);
      const json = res.json();

      // Alice (user-001) has two winning highlight tokens in LIVE_ENTRY_1
      const aliceLegs = json.rows.filter((r: { userId: string }) => r.userId === 'user-001');
      assert.equal(aliceLegs.length, 2);
    } finally {
      await app.close();
    }
  });

  test('limit parameter caps total highlight rows returned', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/competitions/${LIVE_ID}/highlights?limit=1`,
      });
      assert.equal(res.statusCode, 200);
      const json = res.json();
      assert.equal(json.rows.length, 1);
    } finally {
      await app.close();
    }
  });

  test('unknown competition returns 404', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/competitions/${UNKNOWN_UUID}/highlights`,
      });
      assert.equal(res.statusCode, 404);
      assert.equal(res.json().error, 'NOT_FOUND');
    } finally {
      await app.close();
    }
  });
});

describe('route ordering and disambiguation', () => {
  test(':idOrSlug does not swallow /competitions/:id/highlights', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/competitions/${LIVE_ID}/highlights`,
      });
      assert.equal(res.statusCode, 200);
      const json = res.json();
      assert.ok('competitionId' in json, 'Must return highlights payload, not competition detail');
    } finally {
      await app.close();
    }
  });

  test('/v1/competitions/:id/entries/:entryId does not swallow .../highlights', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/competitions/${LIVE_ID}/entries/${LIVE_ENTRY_1}/highlights`,
      });
      assert.equal(res.statusCode, 200);
      const json = res.json();
      assert.ok('tokens' in json, 'Must return entry highlights, not entry detail');
    } finally {
      await app.close();
    }
  });
});

describe('regression: users, posts, and fixtures unaffected', () => {
  test('native /users still responds', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/users?limit=1' });
      assert.equal(res.statusCode, 200);
    } finally {
      await app.close();
    }
  });

  test('native /posts still responds', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/posts?ids=00000000-0000-4000-8000-000000000001' });
      assert.equal(res.statusCode, 200);
    } finally {
      await app.close();
    }
  });

  test('unimplemented routes still return 501', async () => {
    const app = buildApp([]);
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/unimplemented-route-xyz' });
      assert.equal(res.statusCode, 501);
      assert.equal(res.json().error, 'COMPATIBILITY_NOT_IMPLEMENTED');
    } finally {
      await app.close();
    }
  });
});
