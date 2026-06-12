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

| Component | Status | Notes |
|---|---|---|
| **MCP server** | `mcp-server/` (TypeScript, stdio) | Registers the 8 tools; reads `SPARK_ROOM` + `SPARK_DB` from env |
| **Store** | local `spark.db` (SQLite) | WAL mode for safe multi-process access; FTS5 for search |
| **Install skill** | `skills/spark/` (bundled in the plugin) | Writes `.env` (room) + CLAUDE.md usage rules |
| **Hooks** | `hooks/hooks.json` (bundled in the plugin) | `SessionStart` auto-orient, `SessionEnd`/`PreCompact` auto-summary, `PostToolUseFailure` search-on-failing-Bash |

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

### `update_solution(id, problem?, solution?, context?, tags?)`
- **In:** `id: number` + any fields to change
- **Behavior:** fix/improve a card **in place** (instead of recording a near-duplicate).
- **Out:** the updated card.

### `delete_solution(id)`
- **In:** `id: number`
- **Behavior:** permanently remove a wrong/obsolete/duplicate card. Irreversible.
- **Out:** `{ ok }`.

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

## Continuity (shipped — bundled in the plugin)

All hooks live in `hooks/hooks.json` (referenced from `plugin.json`) and run the CLI with
`--from-hook` — silent in projects without a `SPARK_ROOM`, silent on any backend failure,
and they fall back to the plugin-bundled Supabase creds (hooks don't inherit the MCP server's
env block):

- **`SessionStart`** (`spark orient`) reads the room's context + recent solutions and prints
  them to stdout → injected into the agent's context. The agent starts oriented.
- **`SessionEnd` / `PreCompact`** (`spark summarize-hook`) prepends a timestamped digest line
  to the `status` section. Digest lines are matched by their timestamp stamp, so hand-written
  notes (including markdown checkboxes) are preserved below the capped digest block.
- **`PostToolUseFailure`** (matcher `Bash`, `spark posttooluse-hook`) — when a command fails,
  the hook searches the room for the error text and injects matching cards via
  `hookSpecificOutput.additionalContext`. Silent on no match; already-injected cards are not
  repeated within a session. Note: failures arrive as a string `error` field
  ("Exit code N\n<output>") — successes are a different event (`PostToolUse`) and never reach
  this hook.

Keeping these as hooks (not core MCP) means the core stays simple and the automation is a
clean layer that installing the plugin activates.

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
