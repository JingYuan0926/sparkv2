// Spark store — room-scoped knowledge: Solution Cards + Living Context.
// Zero-dependency: uses Node's built-in node:sqlite (SQLite + FTS5).
import { DatabaseSync } from 'node:sqlite';
import { queryCoverage } from './semantic.ts';

export const SECTIONS = ['goal', 'stack', 'decisions', 'status', 'map'] as const;
export type Section = (typeof SECTIONS)[number];

export interface Solution {
  id: number;
  problem: string;
  solution: string;
  context: string | null;
  tags: string[];
  status: 'verified' | 'unverified';
  helped: number;
  author: string | null;
  created_at: string;
  updated_at: string;
  score?: number;
  relevance?: number; // 0..1 normalized relevance from searchSmart
}

export interface Activity {
  kind: 'solution' | 'context';
  ref: string;
  summary: string;
  at: string;
}

const W_VERIFIED = 2.0; // boost for confirmed cards
const W_HELPED = 0.5; // per-reuse boost (capped)
const HELPED_CAP = 6;

function nowIso(): string {
  return new Date().toISOString();
}

function normTags(tags: string[] | undefined | null): string {
  if (!tags) return '';
  return tags
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .join(',');
}

function splitTags(s: string | null): string[] {
  if (!s) return [];
  return s.split(',').filter(Boolean);
}

// Build a forgiving FTS5 MATCH expression: OR of quoted tokens.
// Returns '' when there is nothing searchable (caller falls back to recent).
function ftsQuery(raw: string): string {
  const tokens = (raw.match(/[A-Za-z0-9_]+/g) || []).filter((t) => t.length >= 2);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA busy_timeout = 15000;');
    // The WAL switch + schema creation can race when many processes open a fresh DB
    // at the same moment (cold-start). Retry with a short backoff until it settles.
    for (let attempt = 0; ; attempt++) {
      try {
        this.db.exec('PRAGMA journal_mode = WAL;');
        this.migrate();
        break;
      } catch (e) {
        if (attempt >= 8) throw e;
        const until = Date.now() + 40 * (attempt + 1);
        while (Date.now() < until) {} // brief sync backoff (node:sqlite is synchronous)
      }
    }
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS solutions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id     TEXT    NOT NULL,
        problem     TEXT    NOT NULL,
        solution    TEXT    NOT NULL,
        context     TEXT,
        tags        TEXT    NOT NULL DEFAULT '',
        status      TEXT    NOT NULL DEFAULT 'unverified',
        helped      INTEGER NOT NULL DEFAULT 0,
        author      TEXT,
        created_at  TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_solutions_room ON solutions(room_id);
      CREATE INDEX IF NOT EXISTS idx_solutions_updated ON solutions(room_id, updated_at);

      CREATE VIRTUAL TABLE IF NOT EXISTS solutions_fts USING fts5(
        problem, solution, tags, content='solutions', content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS solutions_ai AFTER INSERT ON solutions BEGIN
        INSERT INTO solutions_fts(rowid, problem, solution, tags)
        VALUES (new.id, new.problem, new.solution, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS solutions_ad AFTER DELETE ON solutions BEGIN
        INSERT INTO solutions_fts(solutions_fts, rowid, problem, solution, tags)
        VALUES ('delete', old.id, old.problem, old.solution, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS solutions_au AFTER UPDATE ON solutions BEGIN
        INSERT INTO solutions_fts(solutions_fts, rowid, problem, solution, tags)
        VALUES ('delete', old.id, old.problem, old.solution, old.tags);
        INSERT INTO solutions_fts(rowid, problem, solution, tags)
        VALUES (new.id, new.problem, new.solution, new.tags);
      END;

      CREATE TABLE IF NOT EXISTS context_sections (
        room_id     TEXT NOT NULL,
        section     TEXT NOT NULL,
        content     TEXT NOT NULL DEFAULT '',
        updated_at  TEXT NOT NULL,
        updated_by  TEXT,
        PRIMARY KEY (room_id, section)
      );

      CREATE TABLE IF NOT EXISTS rooms (
        room_id     TEXT PRIMARY KEY,
        token       TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
    `);
  }

  // Returns the room's token, creating the room with `proposed` on first join (v3 auth).
  ensureRoomToken(room: string, proposed: string): string {
    const existing = this.db.prepare('SELECT token FROM rooms WHERE room_id = ?').get(room) as any;
    if (existing) return existing.token;
    this.db
      .prepare('INSERT INTO rooms (room_id, token, created_at) VALUES (?, ?, ?)')
      .run(room, proposed, nowIso());
    return proposed;
  }

  checkRoomToken(room: string, token: string): boolean {
    const row = this.db.prepare('SELECT token FROM rooms WHERE room_id = ?').get(room) as any;
    if (!row) return false;
    return row.token === token;
  }

  private rowToSolution(r: any): Solution {
    return {
      id: Number(r.id),
      problem: r.problem,
      solution: r.solution,
      context: r.context ?? null,
      tags: splitTags(r.tags),
      status: r.status,
      helped: Number(r.helped),
      author: r.author ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }

  recordSolution(
    room: string,
    input: { problem: string; solution: string; context?: string; tags?: string[]; author?: string },
  ): Solution {
    const problem = (input.problem || '').trim();
    const solution = (input.solution || '').trim();
    if (!problem || !solution) {
      throw new Error('record_solution requires non-empty `problem` and `solution`');
    }
    const ts = nowIso();
    const stmt = this.db.prepare(`
      INSERT INTO solutions (room_id, problem, solution, context, tags, status, helped, author, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'unverified', 0, ?, ?, ?)
    `);
    const res = stmt.run(
      room,
      problem,
      solution,
      input.context?.trim() || null,
      normTags(input.tags),
      input.author || null,
      ts,
      ts,
    );
    return this.getSolution(room, Number(res.lastInsertRowid))!;
  }

  getSolution(room: string, id: number): Solution | null {
    const r = this.db
      .prepare('SELECT * FROM solutions WHERE room_id = ? AND id = ?')
      .get(room, id) as any;
    return r ? this.rowToSolution(r) : null;
  }

  searchSolutions(room: string, query: string, tagsFilter?: string[], limit = 5): Solution[] {
    const match = ftsQuery(query || '');
    let rows: any[];
    if (!match) {
      rows = this.db
        .prepare('SELECT *, 0 AS rank FROM solutions WHERE room_id = ? ORDER BY updated_at DESC LIMIT ?')
        .all(room, limit * 4) as any[];
    } else {
      rows = this.db
        .prepare(`
          SELECT s.*, solutions_fts.rank AS rank
          FROM solutions_fts
          JOIN solutions s ON s.id = solutions_fts.rowid
          WHERE solutions_fts MATCH ? AND s.room_id = ?
          ORDER BY rank
          LIMIT ?
        `)
        .all(match, room, limit * 4) as any[];
    }

    const wantTags = (tagsFilter || []).map((t) => t.trim().toLowerCase()).filter(Boolean);
    let cards = rows.map((r) => {
      const sol = this.rowToSolution(r);
      // Lower score = better. rank is negative (better matches more negative).
      const boost =
        (sol.status === 'verified' ? W_VERIFIED : 0) + W_HELPED * Math.min(sol.helped, HELPED_CAP);
      sol.score = Number(r.rank) - boost;
      return sol;
    });

    if (wantTags.length) {
      cards = cards.filter((c) => wantTags.every((t) => c.tags.includes(t)));
    }
    cards.sort((a, b) => (a.score! - b.score!));
    return cards.slice(0, limit);
  }

  // v4: relevance-ranked search. Scores every candidate by query-coverage (0..1) — how much
  // of the query's meaning the card actually covers — boosted for exact lexical (FTS) hits and
  // lightly for verified/reused. Cards below RELEVANCE_THRESHOLD are dropped, so irrelevant
  // cards are never returned (no false positives) and an empty result is a clear "no match".
  static RELEVANCE_THRESHOLD = 0.34;

  searchSmart(room: string, query: string, tagsFilter?: string[], limit = 5): Solution[] {
    const wantTags = (tagsFilter || []).map((t) => t.trim().toLowerCase()).filter(Boolean);
    // Empty/blank query → recent (used by the dashboard's "list" view).
    if (!query || !query.trim()) return this.searchSolutions(room, query, tagsFilter, limit);

    const all = (this.db.prepare('SELECT * FROM solutions WHERE room_id = ?').all(room) as any[])
      .map((r) => this.rowToSolution(r))
      .filter((c) => !wantTags.length || wantTags.every((t) => c.tags.includes(t)));

    // Exact-lexical hits get a bonus so precise term matches aren't beaten by loose overlap.
    const ftsHits = new Set(this.searchSolutions(room, query, tagsFilter, 50).map((c) => c.id));

    const scored = all
      .map((c) => ({ c, cov: queryCoverage(query, `${c.problem} ${c.solution} ${c.tags.join(' ')}`) }))
      // Threshold on PURE coverage (the real semantic signal), before any bonus — so a single
      // incidental shared word can't lift an irrelevant card over the bar (false positive).
      .filter((x) => x.cov >= Store.RELEVANCE_THRESHOLD)
      .map((x) => {
        const fts = ftsHits.has(x.c.id) ? 0.05 : 0; // small rank nudge for exact-term hits
        const tie = (x.c.status === 'verified' ? 0.02 : 0) + Math.min(x.c.helped, 6) * 0.003;
        return { c: x.c, rel: Math.min(1, x.cov + fts + tie) };
      })
      .sort((a, b) => b.rel - a.rel);

    return scored.slice(0, limit).map((x) => ({
      ...x.c,
      relevance: Math.round(x.rel * 100) / 100,
      score: -x.rel,
    }));
  }

  updateSolution(
    room: string,
    id: number,
    fields: { problem?: string; solution?: string; context?: string; tags?: string[]; status?: 'verified' | 'unverified' },
  ): Solution | null {
    const ex = this.getSolution(room, id);
    if (!ex) return null;
    const ts = nowIso();
    this.db
      .prepare(`UPDATE solutions SET problem=?, solution=?, context=?, tags=?, status=?, updated_at=? WHERE room_id=? AND id=?`)
      .run(
        fields.problem?.trim() || ex.problem,
        fields.solution?.trim() || ex.solution,
        fields.context !== undefined ? fields.context?.trim() || null : ex.context,
        fields.tags !== undefined ? normTags(fields.tags) : ex.tags.join(','),
        fields.status || ex.status,
        ts,
        room,
        id,
      );
    return this.getSolution(room, id);
  }

  deleteSolution(room: string, id: number): boolean {
    const res = this.db.prepare('DELETE FROM solutions WHERE room_id=? AND id=?').run(room, id);
    return Number(res.changes) > 0;
  }

  confirmSolution(room: string, id: number): Solution | null {
    const existing = this.getSolution(room, id);
    if (!existing) return null;
    const ts = nowIso();
    this.db
      .prepare(`UPDATE solutions SET status='verified', helped = helped + 1, updated_at = ? WHERE room_id = ? AND id = ?`)
      .run(ts, room, id);
    return this.getSolution(room, id);
  }

  getContext(room: string): Record<Section, { content: string; updated_at: string | null }> {
    const rows = this.db
      .prepare('SELECT section, content, updated_at FROM context_sections WHERE room_id = ?')
      .all(room) as any[];
    const map = new Map(rows.map((r) => [r.section, r]));
    const out = {} as Record<Section, { content: string; updated_at: string | null }>;
    for (const s of SECTIONS) {
      const r = map.get(s);
      out[s] = { content: r?.content ?? '', updated_at: r?.updated_at ?? null };
    }
    return out;
  }

  updateContext(room: string, section: string, content: string, author?: string): { section: string; updated_at: string } {
    if (!(SECTIONS as readonly string[]).includes(section)) {
      throw new Error(`unknown section "${section}". Valid: ${SECTIONS.join(', ')}`);
    }
    const ts = nowIso();
    this.db
      .prepare(`
        INSERT INTO context_sections (room_id, section, content, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(room_id, section) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at, updated_by = excluded.updated_by
      `)
      .run(room, section, content, ts, author || null);
    return { section, updated_at: ts };
  }

  listRecent(room: string, limit = 10): Activity[] {
    const sols = this.db
      .prepare('SELECT id, problem, status, updated_at FROM solutions WHERE room_id = ? ORDER BY updated_at DESC LIMIT ?')
      .all(room, limit) as any[];
    const ctx = this.db
      .prepare('SELECT section, updated_at FROM context_sections WHERE room_id = ? ORDER BY updated_at DESC LIMIT ?')
      .all(room, limit) as any[];
    const acts: Activity[] = [
      ...sols.map((s) => ({
        kind: 'solution' as const,
        ref: `#${s.id}`,
        summary: `[${s.status}] ${s.problem}`,
        at: s.updated_at,
      })),
      ...ctx.map((c) => ({
        kind: 'context' as const,
        ref: c.section,
        summary: `context "${c.section}" updated`,
        at: c.updated_at,
      })),
    ];
    acts.sort((a, b) => (a.at < b.at ? 1 : -1));
    return acts.slice(0, limit);
  }
}
