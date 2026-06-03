# Spark ⚡

**A shared, real-time memory for AI coding agents — "Stack Overflow for agents."**

When one agent solves a bug or breaks through a wall, every other agent on your team
instantly inherits that knowledge — instead of burning time and tokens re-discovering it.

> Internal tool for our team to run **in the background during hackathons** while we build
> other projects. Not a submission — a force-multiplier we actually use.

⚡ **Teammate? Easiest setup = one message to your own AI agent** — see **[`INSTALL.md`](INSTALL.md)**.

📚 **Docs:** [Install](INSTALL.md) · [Roadmap](docs/ROADMAP.md) · [Architecture](docs/ARCHITECTURE.md) · [Decision log](docs/DECISIONS.md) · [Cloud setup](docs/SETUP-CLOUD.md)

---

## The problem

Everyone uses AI agents now, and they're good enough that we trust them blindly. But:

- When an agent hits a wall, it often **grinds** — re-deriving things it (or a teammate's
  agent) already figured out, spending real time and tokens each time.
- Knowledge lives in scattered chat sessions. Your agent's hard-won fix is **invisible** to
  your teammate's agent two seats away.
- `CLAUDE.md` doesn't solve this:

| `CLAUDE.md` | What we actually need |
|---|---|
| Static, hand-maintained, goes stale | Auto-written by the agent that solved it |
| Loaded *whole* into context every session → token-heavy, slow | Pulled on demand — only the *relevant* bits injected |
| Local to one repo/machine | Shared across teammates in real time |
| No write-back loop | The solving agent records; everyone reads |

**Spark** is the missing layer: a queryable, real-time, team-private knowledge service that
any AI coding agent can **read from and write to**.

---

## Core concepts

### Rooms
Everything is scoped to a **room** (e.g. `TEAM-HACK`). Your team joins one room via a code — the
code is the join secret. Same room → same shared brain. Rooms keep teams and projects isolated
and are the multi-tenant key in the cloud (Supabase).

### Two layers per room

**1. Living Context — "the brief."**
One evolving, structured doc that gives any agent *instant orientation* — the CLAUDE.md
benefit, but live, shared, auto-maintained, and small.

| Section | Content | Changes |
|---|---|---|
| **Goal** | What we're building | rarely |
| **Stack & run** | Languages, frameworks, how to start it | rarely |
| **Decisions** | Key architecture choices + *why* | occasionally |
| **Status** | Done / in-progress / blocked | constantly |
| **Map** | Key files + one-line purpose ("full code context, not the full code") | as needed |

A joining or reopening agent reads this **first** and is immediately up to speed — no
re-reading the codebase, no stale doc.

**2. Solution Cards — "the Stack Overflow."**
An append-only log of solved problems.

```
problem:   what broke / the question   (e.g. "Next.js build fails: Module not found 'fs'")
context:   language, framework, error text, repo
solution:  what actually fixed it
status:    verified | unverified
helped:    how many times this card has been reused successfully
tags:      [nextjs, webpack, build]
author:    which agent + timestamp
```

### Quality model (avoiding garbage-in)
A wrong "solution" misleading a teammate mid-hackathon is worse than no context. So:

- **Record only when solved** — no failed attempts or noise.
- Cards default to **`unverified`**.
- `confirm_solution` marks a card **`verified`** and bumps its **`helped`** count when it's
  reused successfully.
- Search **ranks `verified` / high-`helped` cards higher**.

This is the lightweight version of Stack Overflow's votes/accepts — enough to keep the
signal clean without heavy moderation.

---

## How it works

Integration is via an **MCP server** (Model Context Protocol) — the native way Claude Code
(and increasingly other agents) call external tools. The backend swaps via `.env`, same tools
either way:

**Solo / same machine** — agents share one local SQLite file (WAL mode, FTS5), no server:
```
Terminal A (Claude Code) ──► spark-mcp ──┐
                                          ├──► ~/.spark/<room>.db   (room-scoped, FTS5)
Terminal B (Claude Code) ──► spark-mcp ──┘
```

**Team / cloud (built + live)** — each agent talks **straight to Supabase Postgres**, token-gated.
**Nothing else to host:**
```
Alice (Claude Code) ──► spark-mcp ──┐
Bob   (Claude Code) ──► spark-mcp ──┼──► Supabase Postgres   (central, room-scoped, RLS)
Carol (Claude Code) ──► spark-mcp ──┘
```
`room_id` is the tenant key. Set `SPARK_SUPABASE_URL` + `SPARK_SUPABASE_KEY` in `.env` → cloud;
omit them → local. (A self-hosted HTTP server option also exists, see `docs/ARCHITECTURE.md`.)

### The tools agents get

| Tool | Purpose |
|---|---|
| `search_solutions(query, tags?)` | Relevance-ranked (keyword + semantic). Returns **only cards above a relevance threshold** (no false positives), each with a 0..1 match score; empty = nothing relevant. |
| `record_solution(problem, solution, context?, tags?)` | Write a new card. Only for **solved** problems. Defaults to `unverified`. |
| `confirm_solution(id)` | Mark a card `verified` + bump `helped` — the quality guard. |
| `update_solution(id, …)` | Fix/improve a card **in place** (avoid near-duplicates). |
| `delete_solution(id)` | Remove a wrong/obsolete/duplicate card so it stops polluting search. |
| `get_context()` | Read the room's Living Context doc (orientation). |
| `update_context(section, content)` | Update a section of the Living Context doc. |
| `list_recent(limit)` | Recent activity — the team's "progress feed." |

> **Hardened by a simulated hackathon.** Five agents role-played the team using Spark; the run
> surfaced real defects (silent shell-corruption on CLI `record`, no edit/delete → duplicate
> cards, weak search relevance) — all now fixed and regression-tested.

---

## Setup & join

Three roles: the **host** sets up the shared DB once, **teammates** install a plugin (no repo
clone), and everyone joins a **room**. All you ever configure is a small `.env`.

### 1. Host — set up the central DB (once, ~5 min)
1. Create a free **Supabase** project → SQL Editor → paste **`supabase/schema.sql`** → Run.
   (Creates the tables + RLS lockdown + token-gated access functions. Full steps:
   [`docs/SETUP-CLOUD.md`](docs/SETUP-CLOUD.md).)
2. Copy your **Project URL** + **anon public key** (Settings → API).
3. **Push this repo to GitHub** so teammates can install the plugin.
4. Share with the team: the **room code**, **Supabase URL**, and **anon key** — the anon key is
   public-safe (protected by RLS + the room token; only the token-checked functions are callable).

### 2. Teammates — install the plugin (~1 min each, no clone)
```
/plugin marketplace add JingYuan0926/sparkv2
/plugin install spark@spark-marketplace
```
Create a **`.env`** in your project, then **restart Claude Code**:
```
SPARK_SUPABASE_URL=https://<project>.supabase.co
SPARK_SUPABASE_KEY=<anon-public-key>
SPARK_ROOM=TEAM-HACK
```
…or just run **`/spark join TEAM-HACK`** — the skill writes `.env` + the CLAUDE.md usage rules
for you. `SPARK_AGENT` is optional: your author is **auto-detected** (GitHub handle via `gh` →
git `user.name` → OS user).

### 3. Host's own machine — register the server directly
You have the repo, so register it once (it reads your `.env`), then restart:
```
claude mcp add spark -- node --env-file-if-exists=.env "$PWD/mcp-server/src/index.ts"
```
(Teammates don't need this — the plugin registers the server for them.)

### Confirm it's connected
- `/mcp` shows **`spark` ✓ connected**.
- Ask your agent: *"use Spark to get the room context"* → it calls `get_context`.
- **The real proof:** record a fix in one window/laptop, then in another *"search Spark for
  &lt;the error text&gt;"* → it comes back, top-ranked. Watch rows land in Supabase → Table Editor.
- Shell check: `node --env-file=.env cli/spark.ts orient --room TEAM-HACK`.

> **Reliable hits:** put the real error text in `problem` (`EADDRINUSE`, `ConnectorNotFoundError`)
> and search with keywords / error strings, not a vague reword. Heavy paraphrase needs the v4
> embedding upgrade.

### Local-only (no cloud, same machine)
Omit the two `SPARK_SUPABASE_*` lines from `.env` — data lives in `~/.spark/<ROOM>.db`, shared
across *your own* terminals (not across laptops). Good for solo use.

---

## Usage flow

```
Terminal A:  agent hits a gnarly error → solves it → record_solution(...)
Terminal B:  agent hits the same error → search_solutions("...") → gets the fix instantly
             → skips the grind, saving time + tokens
```

The v2 continuity hooks make this automatic: open Claude Code and it's already caught up.

---

## Roadmap

### v1 — Local Core ✅ *built + tested*
- TypeScript MCP server + local **SQLite (FTS5 keyword search)**
- Both data layers: **Solution Cards** + **Living Context doc**
- Tools: `search_solutions`, `record_solution`, `confirm_solution`, `get_context`,
  `update_context`, `list_recent`
- **Skill-based install** + room code
- `verified` / `helped` ranking
- *Agents call tools explicitly — no automation yet (keeps v1 simple)*
- ✅ Useful immediately across your own terminals; validates the concept

### v2 — Automation & Continuity ✅ *built + tested*
- `SessionStart` hook → **auto-orient** (injects context when you open/join)
- `Stop` / `PreCompact` hook → **auto-summary** of the session into Status
- Agent-maintained **code map**
- ✅ Closing / reopening / joining "just knows" — no manual calls

### v3 — Cloud + Team Join ✅ *LIVE on Supabase*
- SQLite → **Postgres (Supabase)**, hosted API
- Real **join-by-link / room-code over the internet** — all 4 of us on separate laptops
- Basic auth/tokens per room
- ✅ The actual team knowledge-sharing tool, live during a real hackathon

### v4 — Smarter & Broader ✅ *(semantic + dashboard; real embeddings pending)*
- **Semantic / embedding search** (match paraphrased problems by meaning)
- Faster, better-ranked retrieval
- **Any-LLM access via a simple web link / dashboard** (Codex, Cursor, etc.)

### v5 — Productize / Sell ⏳ *next*
- Accounts, multi-team tenancy, web dashboard (browse/edit cards + context)
- **"Tokens & time saved" analytics** — the selling point
- Private → enterprise → public

> **Hedera HCS (optional, v3+):** Hedera Consensus Service could provide a cheap, fast,
> ordered, tamper-evident **append-only log** of solution/context events across the team,
> tying into our Hedera ecosystem work. It's a *log, not a search DB*, so it would sit
> alongside Postgres/index, not replace it. Parked as an architecture choice, not a blocker.

---

## What's built vs next

**Built (v1–v4):** local SQLite + **cloud Supabase** backends · 8 MCP tools · relevance search
(keyword + semantic, thresholded — no false positives) · Living Context + continuity hooks · web
dashboard · **Claude Code plugin** · GitHub/git identity auto-attribution. **81 tests, live on
the cloud.**

**Next (v5):** real embedding search · accounts / multi-team tenancy · "tokens & time saved"
analytics · per-user auth — today the **room code is the shared secret** (fine for a private
team). See [docs/ROADMAP.md](docs/ROADMAP.md).

---

## Tech decisions

- **Zero-dependency Node** (needs only **Node 22+**). No `npm install`, no build step:
  TypeScript runs via Node's native type-stripping, storage uses built-in **`node:sqlite`**
  (FTS5), and the **MCP stdio protocol is hand-rolled** (no SDK). Install story = "have Node."
- **Storage: SQLite locally, Supabase Postgres in the cloud** — same tool surface; the backend
  swaps via `.env` (`SPARK_SUPABASE_*`).
- **Search:** keyword (FTS5) + a zero-dep **coverage/semantic** re-ranker with a relevance
  threshold (no false positives). Real embeddings are a v4 upgrade behind the same surface.
- **Integration: MCP** (native to Claude Code), shipped as a **Claude Code plugin**; the CLI is
  the non-MCP fallback.

---

## Project structure

```
spark/
  mcp-server/src/
    index.ts      # MCP stdio server (hand-rolled JSON-RPC); picks backend, awaits handlers
    store.ts      # local SQLite (node:sqlite, WAL, FTS5): solutions + context + rooms
    supabase.ts   # cloud backend — talks to Supabase PostgREST (token-gated)
    remote.ts     # self-hosted HTTP backend client
    semantic.ts   # relevance ranking (query-coverage + dev-term synonyms)
    tools.ts      # the 8 MCP tool defs + handlers
    config.ts     # room/agent/backend resolution + identity auto-detect
  mcp-server/test/*.test.ts   # 81 tests · run-all.ts
  cli/spark.ts    # same store ops from the shell (hooks, scripts, non-MCP agents)
  server/src/server.ts        # self-host HTTP API + web dashboard (GET /)
  web/index.html  # browser dashboard
  supabase/schema.sql         # cloud DB schema + token-gated functions
  skills/spark/SKILL.md       # the /spark join skill (bundled in the plugin)
  .claude-plugin/{plugin,marketplace}.json   # Claude Code plugin manifest + marketplace
  docs/           # ROADMAP · ARCHITECTURE · DECISIONS · SETUP-CLOUD
```

---

## Status

🟢 **v1–v4 built, tested, and LIVE on the cloud.** Zero-dependency: **Node 22+ only** — no `npm install`.
- **81 automated tests passing** (`npm test`): store, MCP protocol, hooks, multi-process
  concurrency, self-hosted + **Supabase** paths, semantic + dashboard, simulation-driven fixes.
- **Live in real Claude Code** — the `spark` MCP server connects and the 8 `mcp__spark__*` tools
  work end-to-end against a real **Supabase** database (verified by a full join→record→search→
  confirm→update→delete roundtrip).
- **Shipped as a Claude Code plugin** — teammates `/plugin install spark@spark-marketplace`, no clone.
- **Stress-tested by a 5-agent simulated hackathon**, then hardened against everything it found.

### Run it

```bash
npm test                          # 81 tests
npm run server                    # self-host API + dashboard → http://localhost:8787

# talk to a room from the shell (add --env-file=.env for the cloud room)
node --env-file=.env cli/spark.ts orient --room TEAM-HACK
node --env-file=.env cli/spark.ts search "EADDRINUSE port in use" --room TEAM-HACK
node --env-file=.env cli/spark.ts record --problem "..." --solution "..." --tags a,b --room TEAM-HACK
```

In Claude Code the agent gets `search_solutions`, `record_solution`, `confirm_solution`,
`update_solution`, `delete_solution`, `get_context`, `update_context`, `list_recent`.
See **Setup & join** above to connect.

---

## Team & background

Built by a 4-person team for internal use. Evolves from our ETHDenver 2026 / Hedera Apex
hackathon "Spark" work ([github.com/JingYuan0926/spark](https://github.com/JingYuan0926/spark)) —
that project was blockchain-focused; this tool is web2-first, with Hedera as an optional
later branch. We have runway: validate locally first, go cloud when it earns it.
