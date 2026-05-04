/**
 * Tests for backfill-content-uid.ts — two-pass idempotent backfill.
 *
 * All tests run against in-memory mock DB state (no real Postgres required).
 * The backfill module is imported with its `query`/`getClient` replaced by
 * vi.mock at module resolution time.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Minimal type shapes matching the mocked DB service ───────────────────────
interface MockQueryResult<T> {
  rows: T[];
  rowCount: number;
}

// ─── Mock DB service BEFORE importing the module under test ──────────────────
//
// The backfill module calls `query()` and `getClient()` from db.service.
// We intercept them here. Each test adjusts mockState to control responses.

const mockState = {
  masterRows: [] as Array<{
    content_uid: string;
    normalized_title: string;
    content_type: string;
    year: number | null;
    parent_show_uid: string | null;
    season_num: number | null;
    episode_num: number | null;
  }>,
  historyRows: [] as Array<{
    id: number;
    content_name: string | null;
    content_type: string;
    content_uid: string | null;
  }>,
  favoritesRows: [] as Array<{
    id: number;
    content_name: string | null;
    content_type: string;
    content_uid: string | null;
  }>,
  epgRows: [] as Array<{
    id: number;
    title: string | null;
    content_type: string;
    content_uid: string | null;
  }>,
  reviewQueueInserts: [] as Array<{
    uid_a: string;
    reason: string;
    source_table: string;
    source_row_id: number;
  }>,
  updatesApplied: [] as Array<{
    table: string;
    id: number;
    content_uid: string;
  }>,
  txCommitted: false,
  txRolledBack: false,
};

// Mocked client for transaction-based operations
const mockClient = {
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    // History UPDATE
    if (
      /UPDATE sv_watch_history SET content_uid/i.test(sql) &&
      params?.length === 2
    ) {
      const [uid, id] = params as [string, number];
      mockState.updatesApplied.push({
        table: "sv_watch_history",
        id,
        content_uid: uid,
      });
      return { rows: [], rowCount: 1 } as MockQueryResult<never>;
    }
    // Favorites UPDATE
    if (
      /UPDATE sv_favorites SET content_uid/i.test(sql) &&
      params?.length === 2
    ) {
      const [uid, id] = params as [string, number];
      mockState.updatesApplied.push({
        table: "sv_favorites",
        id,
        content_uid: uid,
      });
      return { rows: [], rowCount: 1 } as MockQueryResult<never>;
    }
    // EPG UPDATE
    if (/UPDATE sv_epg SET content_uid/i.test(sql) && params?.length === 2) {
      const [uid, id] = params as [string, number];
      mockState.updatesApplied.push({ table: "sv_epg", id, content_uid: uid });
      return { rows: [], rowCount: 1 } as MockQueryResult<never>;
    }
    // Review queue INSERT
    if (/INSERT INTO sv_content_review_queue/i.test(sql)) {
      const [uid_a, reason, source_table, source_row_id] = (params ?? []) as [
        string,
        string,
        string,
        number,
      ];
      mockState.reviewQueueInserts.push({
        uid_a,
        reason,
        source_table,
        source_row_id,
      });
      return { rows: [], rowCount: 1 } as MockQueryResult<never>;
    }
    // BEGIN / COMMIT / ROLLBACK
    if (/^BEGIN$/i.test(sql.trim())) {
      return { rows: [], rowCount: 0 };
    }
    if (/^COMMIT$/i.test(sql.trim())) {
      mockState.txCommitted = true;
      return { rows: [], rowCount: 0 };
    }
    if (/^ROLLBACK$/i.test(sql.trim())) {
      mockState.txRolledBack = true;
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  }),
  release: vi.fn(),
};

vi.mock("../services/db.service", () => ({
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    // Extract LIMIT from SQL if present (mock applies it in-memory)
    const limitMatch = /LIMIT\s+(\d+)/i.exec(sql);
    const limitN = limitMatch ? parseInt(limitMatch[1]!, 10) : null;
    const applyLimit = <T>(rows: T[]) =>
      limitN !== null ? rows.slice(0, limitN) : rows;

    // SELECT from sv_watch_history (no content_uid)
    if (
      /FROM sv_watch_history/i.test(sql) &&
      /content_uid IS NULL/i.test(sql)
    ) {
      const filtered = applyLimit(
        mockState.historyRows.filter((r) => r.content_uid === null),
      );
      return {
        rows: filtered,
        rowCount: filtered.length,
      } as MockQueryResult<(typeof mockState.historyRows)[0]>;
    }
    // SELECT from sv_favorites
    if (/FROM sv_favorites/i.test(sql) && /content_uid IS NULL/i.test(sql)) {
      const filtered = applyLimit(
        mockState.favoritesRows.filter((r) => r.content_uid === null),
      );
      return {
        rows: filtered,
        rowCount: filtered.length,
      } as MockQueryResult<(typeof mockState.favoritesRows)[0]>;
    }
    // SELECT from sv_epg
    if (/FROM sv_epg/i.test(sql) && /content_uid IS NULL/i.test(sql)) {
      const filtered = applyLimit(
        mockState.epgRows.filter((r) => r.content_uid === null),
      );
      return {
        rows: filtered,
        rowCount: filtered.length,
      } as MockQueryResult<(typeof mockState.epgRows)[0]>;
    }
    // SELECT from sv_content_master — by normalized title + type
    if (/FROM sv_content_master/i.test(sql) && /normalized_title/i.test(sql)) {
      const normTitle = params?.[0] as string | undefined;
      const contentType = params?.[1] as string | undefined;
      const matches = mockState.masterRows.filter(
        (r) =>
          r.normalized_title === normTitle && r.content_type === contentType,
      );
      return { rows: matches, rowCount: matches.length } as MockQueryResult<
        (typeof mockState.masterRows)[0]
      >;
    }
    // SELECT from sv_content_master — by content_uid existence
    if (
      /FROM sv_content_master/i.test(sql) &&
      /content_uid\s*=\s*\$1/i.test(sql)
    ) {
      const uid = params?.[0] as string | undefined;
      const matches = mockState.masterRows.filter((r) => r.content_uid === uid);
      return { rows: matches, rowCount: matches.length } as MockQueryResult<
        (typeof mockState.masterRows)[0]
      >;
    }
    return { rows: [], rowCount: 0 };
  }),
  getClient: vi.fn(async () => mockClient),
  closePool: vi.fn(async () => {}),
}));

// ─── Import module under test AFTER mocks are set up ─────────────────────────
import { runBackfill } from "./backfill-content-uid";

// ─── Helper to reset state between tests ─────────────────────────────────────
function resetState() {
  mockState.masterRows = [];
  mockState.historyRows = [];
  mockState.favoritesRows = [];
  mockState.epgRows = [];
  mockState.reviewQueueInserts = [];
  mockState.updatesApplied = [];
  mockState.txCommitted = false;
  mockState.txRolledBack = false;
  mockClient.query.mockClear();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("backfill-content-uid — Pass 1 (episode-aware)", () => {
  beforeEach(resetState);

  it("matches history row with SnnEnn pattern against parent show in master", async () => {
    // seed: parent show exists in master
    const parentUid = "abcd1234abcd1234";
    const { computeContentUid: cu } =
      await import("../services/content-identity.service");
    const episodeUid = cu({
      type: "episode",
      parentShowUid: parentUid,
      seasonNum: 1,
      episodeNum: 5,
    });

    mockState.masterRows.push(
      {
        content_uid: parentUid,
        normalized_title: "breaking bad",
        content_type: "series",
        year: null,
        parent_show_uid: null,
        season_num: null,
        episode_num: null,
      },
      {
        content_uid: episodeUid,
        normalized_title: "breaking bad",
        content_type: "episode",
        year: null,
        parent_show_uid: parentUid,
        season_num: 1,
        episode_num: 5,
      },
    );
    // seed: history row with episode pattern, currently no content_uid
    mockState.historyRows.push({
      id: 1,
      content_name: "Breaking Bad S01E05",
      content_type: "series",
      content_uid: null,
    });

    const summary = await runBackfill({ dryRun: true, limit: null });

    // dry-run must NOT write
    expect(mockState.updatesApplied).toHaveLength(0);
    // but must record at least 1 match in summary
    expect(summary.history.matched).toBeGreaterThanOrEqual(1);
  });

  it("sets content_uid when --apply is passed and episode uid exists in master", async () => {
    // We need the episode uid in the master so Pass 1 resolves it
    // computeContentUid({ type:"episode", parentShowUid:"abcd1234abcd1234", seasonNum:1, episodeNum:5 })
    // = sha1("episode|abcd1234abcd1234|S1E5").slice(0,16) — we pre-compute and seed it
    // Rather than computing manually, we rely on the service to compute and check existence;
    // we seed the episode uid in masterRows below.

    const parentUid = "abcd1234abcd1234";
    // Import computeContentUid to derive episode uid for seeding
    const { computeContentUid } =
      await import("../services/content-identity.service");
    const episodeUid = computeContentUid({
      type: "episode",
      parentShowUid: parentUid,
      seasonNum: 1,
      episodeNum: 5,
    });

    mockState.masterRows.push({
      content_uid: parentUid,
      normalized_title: "breaking bad",
      content_type: "series",
      year: null,
      parent_show_uid: null,
      season_num: null,
      episode_num: null,
    });
    // The episode uid must be in master so we can set it
    mockState.masterRows.push({
      content_uid: episodeUid,
      normalized_title: "breaking bad",
      content_type: "episode",
      year: null,
      parent_show_uid: parentUid,
      season_num: 1,
      episode_num: 5,
    });
    mockState.historyRows.push({
      id: 1,
      content_name: "Breaking Bad S01E05",
      content_type: "series",
      content_uid: null,
    });

    const summary = await runBackfill({ dryRun: false, limit: null });

    expect(mockState.txCommitted).toBe(true);
    const update = mockState.updatesApplied.find(
      (u) => u.table === "sv_watch_history" && u.id === 1,
    );
    expect(update).toBeDefined();
    expect(update!.content_uid).toBe(episodeUid);
    expect(summary.history.matched).toBe(1);
  });

  it("leaves NULL and writes review_queue when episode parent show not found in master", async () => {
    // No master rows — parent show missing
    mockState.historyRows.push({
      id: 7,
      content_name: "Unknown Show S02E10",
      content_type: "series",
      content_uid: null,
    });

    const summary = await runBackfill({ dryRun: false, limit: null });

    expect(mockState.txCommitted).toBe(true);
    // content_uid must not have been set
    const update = mockState.updatesApplied.find(
      (u) => u.table === "sv_watch_history" && u.id === 7,
    );
    expect(update).toBeUndefined();
    // review queue must have a row
    expect(
      mockState.reviewQueueInserts.some(
        (r) => r.source_table === "sv_watch_history" && r.source_row_id === 7,
      ),
    ).toBe(true);
    expect(summary.history.reviewQueued).toBeGreaterThanOrEqual(1);
  });
});

describe("backfill-content-uid — Pass 2 (movies + series-as-show)", () => {
  beforeEach(resetState);

  it("resolves movie row by normalized title to existing master row", async () => {
    mockState.masterRows.push({
      content_uid: "deadbeef12345678",
      normalized_title: "inception",
      content_type: "movie",
      year: null,
      parent_show_uid: null,
      season_num: null,
      episode_num: null,
    });
    mockState.historyRows.push({
      id: 2,
      content_name: "Inception",
      content_type: "vod",
      content_uid: null,
    });

    const summary = await runBackfill({ dryRun: false, limit: null });

    expect(mockState.txCommitted).toBe(true);
    const update = mockState.updatesApplied.find(
      (u) => u.table === "sv_watch_history" && u.id === 2,
    );
    expect(update).toBeDefined();
    expect(update!.content_uid).toBe("deadbeef12345678");
    expect(summary.history.matched).toBe(1);
  });

  it("logs ambiguous match to review_queue and leaves NULL when multiple master rows match", async () => {
    // Two master rows with same normalized title — ambiguous
    mockState.masterRows.push(
      {
        content_uid: "aaaa111122223333",
        normalized_title: "the office",
        content_type: "series",
        year: null,
        parent_show_uid: null,
        season_num: null,
        episode_num: null,
      },
      {
        content_uid: "bbbb444455556666",
        normalized_title: "the office",
        content_type: "series",
        year: 2005,
        parent_show_uid: null,
        season_num: null,
        episode_num: null,
      },
    );
    mockState.historyRows.push({
      id: 3,
      content_name: "The Office",
      content_type: "series",
      content_uid: null,
    });

    await runBackfill({ dryRun: false, limit: null });

    expect(
      mockState.reviewQueueInserts.some(
        (r) => r.source_table === "sv_watch_history" && r.source_row_id === 3,
      ),
    ).toBe(true);
    expect(
      mockState.updatesApplied.find(
        (u) => u.table === "sv_watch_history" && u.id === 3,
      ),
    ).toBeUndefined();
  });

  it("leaves NULL and does NOT write review_queue when no master row found", async () => {
    mockState.historyRows.push({
      id: 4,
      content_name: "Completely Unknown Movie XYZ",
      content_type: "vod",
      content_uid: null,
    });

    const summary = await runBackfill({ dryRun: false, limit: null });

    expect(
      mockState.updatesApplied.find(
        (u) => u.table === "sv_watch_history" && u.id === 4,
      ),
    ).toBeUndefined();
    // No-match rows should NOT create review_queue noise
    expect(
      mockState.reviewQueueInserts.filter((r) => r.source_row_id === 4),
    ).toHaveLength(0);
    expect(summary.history.noMatch).toBeGreaterThanOrEqual(1);
  });
});

describe("backfill-content-uid — idempotency", () => {
  beforeEach(resetState);

  it("re-run on already-resolved rows is a no-op (rows with content_uid are skipped)", async () => {
    mockState.historyRows.push({
      id: 5,
      content_name: "Breaking Bad S01E05",
      content_type: "series",
      content_uid: "already-set-uid1",
    });

    await runBackfill({ dryRun: false, limit: null });

    // The SELECT query filters WHERE content_uid IS NULL — already-set row never fetched
    expect(mockState.updatesApplied).toHaveLength(0);
    expect(mockState.reviewQueueInserts).toHaveLength(0);
  });
});

describe("backfill-content-uid — dry-run mode", () => {
  beforeEach(resetState);

  it("dry-run returns summary but writes nothing to DB", async () => {
    mockState.masterRows.push({
      content_uid: "deadbeef12345678",
      normalized_title: "inception",
      content_type: "movie",
      year: null,
      parent_show_uid: null,
      season_num: null,
      episode_num: null,
    });
    mockState.historyRows.push({
      id: 6,
      content_name: "Inception",
      content_type: "vod",
      content_uid: null,
    });

    const summary = await runBackfill({ dryRun: true, limit: null });

    // No writes
    expect(mockState.updatesApplied).toHaveLength(0);
    expect(mockState.reviewQueueInserts).toHaveLength(0);
    // But summary correctly accounts for what would happen
    expect(summary.history.matched).toBe(1);
    // Transaction still rolled back (not committed) on dry-run
    expect(mockState.txCommitted).toBe(false);
  });
});

describe("backfill-content-uid — --limit flag", () => {
  beforeEach(resetState);

  it("limits the number of rows processed per table when --limit N is given", async () => {
    // Seed 5 unresolved history rows
    for (let i = 1; i <= 5; i++) {
      mockState.historyRows.push({
        id: i,
        content_name: `Unknown Movie ${i}`,
        content_type: "vod",
        content_uid: null,
      });
    }

    const summary = await runBackfill({ dryRun: true, limit: 2 });

    // With limit=2, at most 2 rows should be considered
    expect(summary.history.total).toBeLessThanOrEqual(2);
  });
});
