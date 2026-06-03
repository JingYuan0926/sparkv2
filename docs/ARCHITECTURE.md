# Spark — Architecture

Technical design for the local MVP (v1), with the forward path to cloud (v3).

---

## Overview

Spark is a **knowledge service for AI coding agents**, exposed to Claude Code as an **MCP
server**. Agents call Spark's tools to read shared project context and search/record solved
problems. State lives in a **room-scoped** store.

```
┌─────────────────────┐        ┌─────────────────────┐
│ Claude Code (term A) │       │ Claude Code (term B) │
│   ↕ MCP (stdio)      │       │   ↕ MCP (stdio)      │
│  spark-mcp (node)    │       │  spark-mcp (node)    │
└─────────┬───────────┘        └──────────┬──────────┘
          │  read/write                   │
          └──────────────┬────────────────┘
                         ▼
                 spark.db  (SQLite, WAL, FTS5)
                 room-scoped rows
```

In v1 there is **no server process** — each Claude Code instance spawns its own MCP server
subprocess, and they coordinate purely through the shared SQLite file.

---

## Components

| Component | v1 | Notes |
|---|---|---|
| **MCP server** | `mcp-server/` (TypeScript, stdio) | Registers the 6 tools; reads `SPARK_ROOM` + `SPARK_DB` from env |
| **Store** | local `spark.db` (SQLite) | WAL mode for safe multi-process access; FTS5 for search |
| **Install skill** | `.claude/skills/spark/` | Build + register MCP in `.mcp.json` + set room code |
| **Hooks** | — (v2) | `SessionStart` auto-orient, `Stop`/`PreCompact` auto-summary |

---

## The shared-SQLite mechanism (why it works locally)

- Each Claude Code instance launches its **own** `spark-mcp` subprocess (standard MCP stdio
  behavior).
- All subprocesses open the **same `spark.db` file**.
- **WAL (Write-Ahead Logging)** mode lets multiple processes read concurrently and serializes
  writes safely. For a small team on one machine this is more than enough.
- Result: shared state with zero hosted infrastructure.

This is deliberately the same shape as cloud: replace "open the same file" with "call the
same API," and SQLite with Postgres. The `room_id` scoping already present becomes the tenant
key.

---

## Data model (v1)

```sql
-- Solution cards
CREATE TABLE solutions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id     TEXT    NOT NULL,
  problem     TEXT    NOT NULL,
  solution    TEXT    NOT NULL,
  context     TEXT,                       -- language/framework/error/repo, free text
  tags        TEXT,                       -- comma-separated, normalized lowercase
  status      TEXT    NOT NULL DEFAULT 'unverified',  -- 'verified' | 'unverified'
  helped      INTEGER NOT NULL DEFAULT 0, -- reuse-success counter
  author      TEXT,                       -- agent / user label
  created_at  TEXT    NOT NULL,           -- ISO timestamp
  updated_at  TEXT    NOT NULL
);

-- Full-text index over the searchable fields (external-content FTS5)
CREATE VIRTUAL TABLE solutions_fts USING fts5(
  problem, solution, tags,
  content='solutions', content_rowid='id'
);
-- + INSERT/UPDATE/DELETE triggers to keep solutions_fts in sync

-- Living Context: one row per (room, section)
CREATE TABLE context_sections (
  room_id     TEXT NOT NULL,
  section     TEXT NOT NULL,   -- 'goal' | 'stack' | 'decisions' | 'status' | 'map'
  content     TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL,
  updated_by  TEXT,
  PRIMARY KEY (room_id, section)
);

CREATE INDEX idx_solutions_room ON solutions(room_id);
```

Timestamps are written by the server (not via SQLite `CURRENT_TIMESTAMP`) so behavior is
identical when we move to a hosted API.

---

## MCP tools (specification)

All tools operate within the current `room_id`.

### `search_solutions(query, tags?, limit?)`
- **In:** `query: string`, `tags?: string[]`, `limit?: number = 5`
- **Behavior:** FTS5 match on `query` (+ optional tag filter), ranked (see Ranking).
- **Out:** array of `{ id, problem, solution, status, helped, tags, score }`.

### `record_solution(problem, solution, context?, tags?)`
- **In:** `problem: string`, `solution: string`, `context?: string`, `tags?: string[]`
- **Behavior:** insert a card; `status='unverified'`, `helped=0`. **Only for solved problems.**
- **Out:** `{ id }`.

### `confirm_solution(id)`
- **In:** `id: number`
- **Behavior:** set `status='verified'`, `helped = helped + 1`, touch `updated_at`.
- **Out:** `{ id, status, helped }`.

### `get_context()`
- **In:** none
- **Behavior:** read all `context_sections` for the room, assembled in canonical order.
- **Out:** `{ goal, stack, decisions, status, map }` (+ per-section `updated_at`).

### `update_context(section, content)`
- **In:** `section: 'goal'|'stack'|'decisions'|'status'|'map'`, `content: string`
- **Behavior:** upsert the section, set `updated_at`/`updated_by`.
- **Out:** `{ section, updated_at }`.

### `list_recent(limit?)`
- **In:** `limit?: number = 10`
- **Behavior:** most recent solutions + context updates, newest first.
- **Out:** array of activity entries.

---

## Ranking

Search results are ordered by a blend:

```
score = bm25(solutions_fts)                 -- text relevance (lower = better in FTS5)
        − w_verified · (status = 'verified') -- boost verified
        − w_helped   · log(1 + helped)       -- boost frequently-reused
```

Implemented as an `ORDER BY` over the FTS `bm25()` rank adjusted by the boosts. Weights are
tunable constants. Intent: a verified, often-reused card beats a marginally-better text match
that nobody has confirmed.

---

## Continuity (v2 design)

- **`SessionStart` hook** runs a small command that reads the room's context + a few recent
  solutions and emits them as `additionalContext` → the agent starts oriented.
- **`Stop` / `PreCompact` hook** asks for / writes a short "what changed this session" digest
  into the `status` section (and optionally a lightweight progress entry).
- Both are installed by the `spark` skill. They call the same store the MCP server uses.

Keeping these as hooks (not core MCP) means v1 stays simple and the automation is a clean,
optional layer.

---

## Cloud migration path (v3)

| v1 (local) | v3 (cloud) |
|---|---|
| `spark.db` SQLite file | Postgres (Supabase) |
| Open same file | Call same hosted REST API |
| `room_id` from env | `room_id` = tenant key + auth token |
| No auth | Per-room tokens, join via link/code |
| FTS5 keyword | FTS + (v4) embeddings |

The MCP server's tool surface **does not change** — only its storage backend swaps from
"local SQLite" to "HTTP calls to the Spark API." Agents and the skill are unaffected.

---

## Security & quality notes

- **Quality:** `record_solution` is for solved problems only; `verified`/`helped` ranking
  keeps unproven cards from dominating. Cheap analog of Stack Overflow votes/accepts.
- **Isolation:** all queries are `room_id`-scoped; cloud adds token auth per room.
- **Blast radius (v1):** local file only; no network, no secrets. Safe to experiment.
- **Input handling:** parameterized SQL only; tags normalized; sizes bounded to keep the
  context doc cheap to inject.
