# Spark — Decision Log

Why we built it this way. Each entry: the decision, options considered, what we chose, and
the reasoning. Append new decisions as the project evolves.

---

### D1 — Spark is an internal tool, not a hackathon submission
**Choice:** build it as a private team utility we run *during* hackathons while building other
projects.
**Why:** we found this problem (agents re-solving things, wasting tokens) in our own workflow.
Optimize for real daily utility and frictionless install — not demo theatrics.

---

### D2 — Integration via MCP server
**Options:** MCP server · shell CLI · auto hooks.
**Choice:** **MCP server.**
**Why:** native to Claude Code (agents call `search`/`record` as real tools, autonomously),
portable to other agents later, cleanest surface. CLI relies on the agent remembering to call
it; hooks alone are Claude-Code-specific and less precise. (Hooks are added in v2 *on top* of
MCP for automation.)

---

### D3 — Local single-machine first
**Options:** single-machine · cloud-hosted · local-network server.
**Choice:** **single-machine first**, cloud at v3.
**Why:** fastest path to a working, useful thing with zero infra; validates the concept. The
design (shared SQLite + `room_id`) upgrades to cloud cleanly. Honest caveat: teammates on
other laptops don't share until v3 — accepted, since we have runway and want to validate
locally first.

---

### D4 — Keyword search first, semantic later
**Options:** keyword/full-text · semantic embeddings · both.
**Choice:** **keyword (SQLite FTS5) for v1**, embeddings in v4.
**Why:** FTS5 is built in, zero extra infra, good enough to prove value. Embeddings add an
API + vector store; defer until the basic loop is validated.

---

### D5 — TypeScript / Node, not Python
**Options:** TS/Node · Python.
**Choice:** **TypeScript / Node.**
**Why:** the MCP TypeScript SDK is the canonical, best-documented path, and Node v26 is
installed. The local Python is **3.9.6**, but the MCP Python SDK needs **3.10+** — avoid the
version wrangling.

---

### D6 — Two-layer model: Living Context + Solution Cards
**Choice:** each room has a structured **Living Context doc** (Goal/Stack/Decisions/Status/Map)
*and* an append-only log of **Solution Cards**.
**Why:** the user's real need isn't just a Q&A log — it's that on close/reopen/join an agent
should "know the full context directly" without re-reading the codebase or a stale CLAUDE.md.
The context doc gives instant orientation; the cards give reusable fixes.

---

### D7 — Record only solved problems
**Choice:** `record_solution` is for **solved** problems only — no failed attempts / progress
spam.
**Why:** signal vs noise. The store stays a clean knowledge base, not a transcript.

---

### D8 — Lightweight quality model (verified / helped)
**Choice:** cards default to `unverified`; `confirm_solution` marks `verified` and bumps a
`helped` counter; search ranks verified/often-reused higher.
**Why:** a wrong "solution" misleading a teammate is worse than no context. This is the cheap
analog of Stack Overflow's votes/accepts — enough to keep signal clean without moderation.

---

### D9 — Context freshness = hybrid (curate + auto-summary)
**Options:** agent-curated only · auto-capture only · hybrid.
**Choice:** **hybrid** — agents update the structured doc deliberately, *and* a close/compact
hook (v2) auto-writes a short session digest into Status.
**Why:** deliberate updates stay clean and structured; the auto-summary guarantees continuity
even if an agent quits mid-task. Store *state*, not a transcript; cap size and roll up old
items.

---

### D10 — Auto-orient on open/join
**Choice:** a `SessionStart` hook (v2) injects the current context + recent solutions when you
open Claude Code or join a room.
**Why:** delivers the "know the full context directly the moment I join" behavior the user
asked for. Small per-session context cost, big orientation payoff.

---

### D11 — Include a lightweight code map
**Choice:** the context doc has a `Map` section — key files + one-line purpose, agent-
maintained.
**Why:** "full code context, but not the full code." Helps a joining agent navigate fast
without loading the whole repo.

---

### D12 — Install as a Claude Code skill
**Choice:** installation is a `spark` skill — run it, it sets up the MCP server and asks for a
room code.
**Why:** 30-second setup for any teammate; no manual config fiddling. Lowest-friction
onboarding.

---

### D13 — web2 first; Hedera HCS optional later
**Options:** web2 · blockchain (Hedera HCS).
**Choice:** **web2 / local first.** Hedera HCS considered as an optional v3+ branch.
**Why:** the prior ETHDenver/Hedera "Spark" repo was blockchain-focused; this tool doesn't
need it to deliver value. HCS could later provide a cheap, fast, ordered, tamper-evident
shared *log* — but it's not a search DB, so it'd sit alongside Postgres, not replace it. No
reason to take on that complexity before the core is proven.

---

### D14 — Claude Code only for now
**Choice:** target Claude Code for v1–v2; broaden to any-LLM / web link in v4.
**Why:** all 4 of us use Claude Code; ship for the actual users first, generalize once the
value is proven.

---

### D15 — Hardened against a simulated hackathon
**What:** ran a 5-agent simulation (1 seed + 3 builders search-before-grind + 1 QA). It
confirmed the core value (3/3 cache hits reused + verified) and surfaced real defects, now fixed:
- **Silent shell-corruption on CLI `record`** — zsh mangled a `!`/backtick solution yet `record`
  reported success, storing a broken fix. → Added shell-safe `--problem-file`/`--solution-file`
  (`-` = stdin). MCP path (structured JSON) was already safe.
- **No way to fix/retire a card** — a botched card could only be duplicated, polluting the room.
  → Added `update`/`delete` (CLI + `update_solution`/`delete_solution` MCP tools).
- **Weak search relevance** — raw negative bm25 scores, no threshold, "dumped" ~5 cards incl.
  irrelevant ones. → Switched to interpretable **query-coverage** (0..1) with a relevance
  threshold; irrelevant cards are now dropped (empty = clear "no match"). Threshold is applied to
  *pure coverage* before any exact-match bonus, so one incidental shared word can't false-positive.
- **UX gaps** — CLI help now lists valid sections + env vars; `record` output points to `confirm`;
  `orient` flags empty `decisions`/`map`; added `get <id>`.
**Why it matters:** a knowledge tool that silently stores corruption or surfaces confident-but-wrong
matches is worse than no tool. The simulation caught these before the team ever relied on it.
