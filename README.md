# Spark ⚡

**A shared, real-time memory for AI coding agents — "Stack Overflow for agents."**

When one agent solves a bug or breaks through a wall, every other agent on your team
instantly inherits that knowledge — instead of burning time and tokens re-discovering it.

> Internal tool for our team to run **in the background during hackathons** while we build
> other projects. Not a submission — a force-multiplier we actually use.

📚 **Docs:** [Roadmap](docs/ROADMAP.md) · [Architecture](docs/ARCHITECTURE.md) · [Decision log](docs/DECISIONS.md)

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
Everything is scoped to a **room** (e.g. `SPARK-DEMO`). Your team joins one room via a code
(later: a link). Same room → same shared brain. Rooms keep teams and projects isolated and
map cleanly onto multi-tenancy when we go cloud.

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

## How it works (local MVP)

Integration is via an **MCP server** (Model Context Protocol) — the native way Claude Code
(and increasingly other agents) call external tools.

For the local version, each Claude Code instance spawns its own copy of the Spark MCP
server, but **they all point at one shared SQLite file on disk**. SQLite in WAL mode handles
concurrent read/write across processes — so multiple terminals = multiple agents sharing one
brain, **with no server to host**.

```
Terminal A (Claude Code) ──► spark-mcp ──┐
                                          ├──► spark.db   (shared, room-scoped, FTS5 search)
Terminal B (Claude Code) ──► spark-mcp ──┘
```

This maps **directly** onto the cloud version later: `room_id` becomes a real multi-tenant
key, and SQLite swaps for Postgres behind a hosted API. Nothing built now gets thrown away.

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

## Join a room (connect your Claude Code)

Joining = pointing your Claude Code at the team's room so **your agent gets the Spark tools**
(`search_solutions`, `record_solution`, `get_context`, …). Two ways, depending on setup.

### A) Team / shared room over the cloud  ← what your teammates use

> Prereq (one person, once): the host sets up the central Supabase DB — see
> [`docs/SETUP-CLOUD.md`](docs/SETUP-CLOUD.md) — and shares the **room code**, **Supabase URL**,
> and **anon key** (the anon key is public-safe). Often these last two are already committed in
> the repo's `.mcp.json`, so a teammate only needs the room code.

Each teammate, in their project (needs **Node 22+** and the Spark repo):

1. Create/merge **`.mcp.json`** in the project root:
   ```json
   {
     "mcpServers": {
       "spark": {
         "command": "node",
         "args": ["mcp-server/src/index.ts"],
         "env": {
           "SPARK_ROOM": "TEAM-HACK",
           "SPARK_AGENT": "alice",
           "SPARK_SUPABASE_URL": "https://<project>.supabase.co",
           "SPARK_SUPABASE_KEY": "<anon-public-key>"
         }
       }
     }
   }
   ```
   (Set `SPARK_ROOM` to the team's code and `SPARK_AGENT` to your name. If the URL+key are
   already in a committed `.mcp.json`, just set those two.) Or run **`/spark join TEAM-HACK`** —
   the skill writes this for you.
2. In Claude Code, run **`/mcp`** (or restart). You should see **`spark` connected**.
3. **That's it — your Claude can now see the room.** It will `search_solutions` before grinding
   and `record_solution` when it solves something new.

### B) Local only (same machine, no sharing across laptops)

Drop the two `SPARK_SUPABASE_*` lines; leave just `SPARK_ROOM` (+ `SPARK_AGENT`). Data lives in
`~/.spark/<ROOM>.db`, shared across your own terminals. The repo already ships a local
`.mcp.json` pointing at `SPARK-DEMO`.

### Confirm your Claude actually sees it

- **`/mcp`** lists `spark` as ✓ connected.
- Ask your agent: *"use Spark to get the room context"* → it calls `get_context` and prints the
  team brief. Or *"search Spark for <some past problem>"*.
- The real proof: a teammate `record`s a fix on their laptop, you `search` it (close wording)
  on yours and it comes back.
- Shell check (no Claude): `node cli/spark.ts orient --room TEAM-HACK` (add
  `SPARK_SUPABASE_URL`/`SPARK_SUPABASE_KEY` env for the cloud room).

> Tip for reliable hits: put the **real error text** in `problem` (e.g. `EADDRINUSE`,
> `ConnectorNotFoundError`) and search with **keywords / error strings**, not a vague reword.

---

## Usage flow

```
Terminal A:  agent hits a gnarly error → solves it → record_solution(...)
Terminal B:  agent hits the same error → search_solutions("...") → gets the fix instantly
             → skips the grind, saving time + tokens
```

In v2 this becomes automatic (see roadmap): you just open Claude Code and it's already
caught up.

---

## Roadmap

### v1 — Local Core  *(simplest working thing)*
- TypeScript MCP server + local **SQLite (FTS5 keyword search)**
- Both data layers: **Solution Cards** + **Living Context doc**
- Tools: `search_solutions`, `record_solution`, `confirm_solution`, `get_context`,
  `update_context`, `list_recent`
- **Skill-based install** + room code
- `verified` / `helped` ranking
- *Agents call tools explicitly — no automation yet (keeps v1 simple)*
- ✅ Useful immediately across your own terminals; validates the concept

### v2 — Automation & Continuity  *(make it effortless)*
- `SessionStart` hook → **auto-orient** (injects context when you open/join)
- `Stop` / `PreCompact` hook → **auto-summary** of the session into Status
- Agent-maintained **code map**
- ✅ Closing / reopening / joining "just knows" — no manual calls

### v3 — Cloud + Team Join  🎯 *(the final goal)*
- SQLite → **Postgres (Supabase)**, hosted API
- Real **join-by-link / room-code over the internet** — all 4 of us on separate laptops
- Basic auth/tokens per room
- ✅ The actual team knowledge-sharing tool, live during a real hackathon

### v4 — Smarter & Broader
- **Semantic / embedding search** (match paraphrased problems by meaning)
- Faster, better-ranked retrieval
- **Any-LLM access via a simple web link / dashboard** (Codex, Cursor, etc.)

### v5 — Productize / Sell
- Accounts, multi-team tenancy, web dashboard (browse/edit cards + context)
- **"Tokens & time saved" analytics** — the selling point
- Private → enterprise → public

> **Hedera HCS (optional, v3+):** Hedera Consensus Service could provide a cheap, fast,
> ordered, tamper-evident **append-only log** of solution/context events across the team,
> tying into our Hedera ecosystem work. It's a *log, not a search DB*, so it would sit
> alongside Postgres/index, not replace it. Parked as an architecture choice, not a blocker.

---

## Scope boundaries

**In scope for v1:** Claude Code only · local single-machine · MCP server · SQLite + keyword
search · two-layer model · skill install · room scoping · verified/helped quality model.

**Out of scope (deferred):** cloud hosting · real auth · embeddings/semantic search · web UI
· non-Claude agents · automation hooks (v2). All are clean follow-ons.

We build **v1 first, use it for real, then iterate version by version** based on how it
actually feels.

---

## Tech decisions

- **Language: TypeScript / Node.** The MCP TypeScript SDK is the canonical, best-documented
  path. (Our local Python is 3.9.6; the MCP Python SDK needs 3.10+. Node v26 is installed.)
- **Storage: SQLite + FTS5** for the local MVP — zero infra, built-in full-text search, WAL
  mode for safe multi-process sharing.
- **Integration: MCP** — native to Claude Code, portable to other agents later.

---

## Planned structure

```
spark/
  mcp-server/
    src/
      index.ts      # MCP stdio server; registers tools, reads room + db path
      db.ts         # SQLite (WAL) + FTS5; solutions + context tables, room-scoped
      tools.ts      # tool handlers
    package.json
    tsconfig.json
  .claude/
    skills/spark/   # install skill: build + register MCP + enter room code
    settings.local.json
  .mcp.json         # registers "spark" for Claude Code in this project
  spark.db          # created at runtime (gitignored)
  README.md         # this file
```

---

## Status

🟢 **v1–v4 built and tested** (local). Zero-dependency: Node 22+ only — no `npm install`.
- **69 automated tests passing** (`node mcp-server/test/run-all.ts`): store, MCP protocol,
  hooks, multi-process concurrency, cloud/remote path, semantic + dashboard, and the
  simulation-driven fixes.
- Verified **live inside real Claude Code** — the `spark` MCP server connects and the
  `mcp__spark__*` tools work end-to-end.
- **Stress-tested by a 5-agent simulated hackathon**, then hardened against everything it found.
- ☁️ Going public on the internet (real Postgres/Supabase + hosting) is the only piece that
  needs deploy creds; everything runs and is tested on localhost.

### Run it

```bash
# tests
node mcp-server/test/run-all.ts

# cloud API + web dashboard (open http://localhost:8787)
node server/src/server.ts

# talk to the room from the shell
node cli/spark.ts record --problem "..." --solution "..." --tags a,b --room SPARK-DEMO
node cli/spark.ts search "..." --room SPARK-DEMO
node cli/spark.ts orient --room SPARK-DEMO
```

The MCP server is wired in `.mcp.json`; run `/mcp` in Claude Code (or the `spark` skill) to
connect, then the agent gets `search_solutions`, `record_solution`, `get_context`, etc.

---

## Team & background

Built by a 4-person team for internal use. Evolves from our ETHDenver 2026 / Hedera Apex
hackathon "Spark" work ([github.com/JingYuan0926/spark](https://github.com/JingYuan0926/spark)) —
that project was blockchain-focused; this tool is web2-first, with Hedera as an optional
later branch. We have runway: validate locally first, go cloud when it earns it.
