# Spark — Roadmap

Execution plan, version by version. We build **v1 first, use it for real, then iterate** —
only moving to the next version once the current one earns it.

Legend: `[ ]` not started · `[~]` in progress · `[x]` done

---

## v1 — Local Core  🟢 *built + tested*

**Goal:** the simplest thing that actually works — a Stack-Overflow-for-agents loop running
locally across our own terminals, plus the Living Context doc. Useful immediately; validates
the whole concept with zero infrastructure.

> **Built zero-dependency** (better than planned): Node 22.18+ built-in `node:sqlite` (FTS5),
> TypeScript run directly via type-stripping (no build), hand-rolled MCP stdio JSON-RPC.
> No `npm install`, no native builds. Verified live inside real Claude Code.

**Deliverables**
- [x] TypeScript MCP server (stdio) — hand-rolled JSON-RPC (no SDK dep needed)
- [x] SQLite storage via built-in `node:sqlite`, WAL mode, FTS5 keyword search
- [x] Data model: `solutions` + `solutions_fts` + `context_sections`
- [x] Tools: `search_solutions`, `record_solution`, `confirm_solution`, `get_context`,
      `update_context`, `list_recent`
- [x] Room scoping via `room_id` (from env/config)
- [x] `verified` / `helped` ranking in search
- [x] `.mcp.json` registration for Claude Code
- [x] `spark` install skill (register + enter room code)
- [x] `README` quickstart + `spark.db` gitignored

**Acceptance criteria**
- Two Claude Code terminals in the same room share one `spark.db`.
- Terminal A `record_solution(...)` → Terminal B `search_solutions(...)` returns it.
- `confirm_solution` flips status to `verified` and bumps `helped`; verified cards rank higher.
- `get_context` / `update_context` round-trip the Living Context doc.
- Recording a duplicate-ish problem still works (no crash); search is case-insensitive.

**Out:** hooks, cloud, embeddings, auth, web UI, non-Claude agents.

---

## v2 — Automation & Continuity  🟢 *built + tested*

**Goal:** make it effortless — no manual tool calls to stay oriented.

**Deliverables**
- [x] `SessionStart` hook → auto-inject current context doc + recent solutions (`spark orient`)
- [x] `SessionEnd` / `PreCompact` hook → session digest into `Status` (`spark summarize-hook`)
- [x] `PostToolUseFailure` hook → failing Bash auto-searches the room, injects a teammate's fix
- [x] Agent-maintained **code map** section (key files + one-line purpose)
- [x] Size-cap / roll-up logic so `Status` stays small (keeps recent digest lines; manual notes
      and markdown checklists survive below the digest block)
- [x] Hooks ship **bundled in the plugin** (`hooks/hooks.json` — auto-active on install)

**Acceptance criteria**
- Open Claude Code in a joined room → context is present without any tool call.
- Quit mid-task, reopen → the Status reflects what changed last session.
- Context doc stays under the size cap over many sessions.

---

## v3 — Cloud + Team Join  🟢 *code complete · needs your Supabase project to go live*

**Goal:** the real team tool — all 4 of us on separate laptops, sharing one central DB.

> Two cloud paths, both built & tested: (1) self-hosted HTTP API + `RemoteStore`, and
> (2) **Supabase-direct** (recommended — nothing else to host): each agent talks straight to a
> Supabase Postgres DB via token-gated SQL functions. The `SupabaseStore` adapter is tested
> end-to-end against a mock PostgREST (12 tests) mirroring `supabase/schema.sql`. **Remaining:**
> you create the Supabase project + run `schema.sql` (5 min), then we verify against the real
> project. See `docs/SETUP-CLOUD.md`.

**Deliverables**
- [x] Self-hosted HTTP API + `RemoteStore` (LAN / single-host option)
- [x] **Supabase-direct adapter** (`SupabaseStore`) — zero-dep, talks to Supabase PostgREST
- [x] `supabase/schema.sql` — tables + RLS + token-gated access functions
- [x] Join by **room code** + per-room token; room isolation enforced (tested both paths)
- [x] One-command **skill cloud-join** + `docs/SETUP-CLOUD.md`
- [x] Run `schema.sql` in a real Supabase project + verify E2E (live)
- [ ] (optional) move search ranking into Postgres for very large rooms

**Acceptance criteria**
- A teammate on a different machine/network joins with a code and sees shared cards/context.
- Writes from one machine appear in others' searches within seconds.
- Rooms are isolated; no cross-room leakage.

---

## v4 — Smarter & Broader  🟢 *built locally*

**Goal:** better matching + reach beyond Claude Code.

> Built: a zero-dep **semantic fallback** (normalized tokens + dev-term synonyms + Jaccard)
> that catches paraphrased problems keyword misses, behind the same `searchSmart` surface a
> real embedding provider can slot into. Plus a **web dashboard** (served by the API server)
> so any browser/LLM/human can view + submit via a link. The CLI is the non-MCP fallback.

**Deliverables**
- [x] **Semantic fallback** for paraphrases (`semantic.ts`, `searchSmart`)
- [x] Hybrid ranking: keyword first, semantic top-up, verified/helped boost
- [x] **Web dashboard** at `GET /` (view context + cards, search, record, confirm)
- [x] CLI works for any agent that can run a shell (non-MCP fallback)
- [ ] Real embedding provider wired via `SPARK_EMBED_API` (interface ready; needs a key)

**Acceptance criteria**
- A paraphrased problem finds the relevant card even with different wording.
- A non-Claude agent (or a human via the link) can read and submit cards.

---

## v5 — Productize / Sell

**Goal:** turn it into something we can offer to others (private → enterprise → public).

**Deliverables**
- [ ] Accounts + multi-team tenancy
- [ ] Web dashboard (browse/edit cards + context, manage rooms/members)
- [ ] **"Tokens & time saved" analytics** — the core value metric
- [ ] Billing
- [ ] Access controls / roles

**Acceptance criteria**
- A new team signs up, creates a room, invites members, and uses it without our help.
- Dashboard shows credible "saved" metrics.

---

## Optional branch — Hedera HCS (v3+)

Hedera Consensus Service as a cheap, fast, ordered, tamper-evident **append-only log** of
solution/context events across the team. Ties into our Hedera ecosystem work. It's a *log,
not a search DB*, so it sits **alongside** Postgres/index, not in place of it. Evaluate when
we hit v3 — not a blocker, not on the critical path.

---

## Dependencies / order

```
v1 ──► v2 ──► v3 ──► v4 ──► v5
                └─(optional)─► Hedera HCS branch
```

Each version is independently useful. We don't start the next until the current one is
validated in real use.
