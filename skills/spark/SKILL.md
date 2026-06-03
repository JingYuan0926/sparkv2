---
name: spark
description: Join a Spark team room — the shared knowledge tool for AI coding agents. Use for "/spark join <ROOM>", connecting your agent to the team's shared context, or onboarding a teammate. The MCP server is already registered by the plugin; this skill sets your room + cloud credentials and writes the usage rules into the project's CLAUDE.md.
---

# Spark — join a room

The `spark` plugin already registered the MCP server, so the agent has the tools
(`search_solutions`, `record_solution`, `confirm_solution`, `update_solution`,
`delete_solution`, `get_context`, `update_context`, `list_recent`). This skill connects the
**current project** to a room. Requirements: **Node 22+** (built-in `node:sqlite`, no install).

When invoked (e.g. `/spark join TEAM-HACK`), do this:

## 1. Get the room + cloud credentials
Take the **room code** from the command (`/spark join <CODE>`) or ask for it. For a **cloud team
room**, also get the host's **Supabase URL** + **anon key** (the host shares these once; the anon
key is public-safe). For **local-only** use (same machine), skip the Supabase values.

## 2. Write `.env` in the current project (gitignored)
Create/merge `.env` in the project root:
```
SPARK_SUPABASE_URL=https://<project>.supabase.co   # cloud only
SPARK_SUPABASE_KEY=<anon-public-key>               # cloud only
SPARK_ROOM=<ROOM_CODE>
# SPARK_AGENT is optional — author auto-detects: GitHub handle (gh) → git user.name → OS user.
```
Then ensure `.env` is in `.gitignore`. (The plugin's MCP server runs `--env-file-if-exists=.env`
from the project cwd, so it reads this file. Local-only: omit the two SUPABASE lines — data lives
in `~/.spark/<ROOM>.db`.)

## 3. Write the usage rules into CLAUDE.md
Append this to the project's `CLAUDE.md` (create it if missing) so the agent actually *uses* Spark:
```markdown
## Spark — shared team knowledge (use it)
- BEFORE grinding on any error/build/setup problem, call `search_solutions` with the error text.
- If a returned card solves it, apply it and call `confirm_solution(id)`.
- After solving something non-trivial, call `record_solution` (real error text in `problem`).
- On a fresh/confusing task call `get_context`; keep `update_context` (status) current.
- Fix a wrong card with `update_solution`; remove a dud with `delete_solution` (don't duplicate).
```

## 4. Connect + verify
Tell the user to run **`/mcp`** (or restart) so the `spark` server picks up the new `.env`.
Confirm by calling `get_context` — it should print the room brief. Then they're in.

## Tips to relay
- **Search before you grind**; **record only what's solved** (real error text in `problem`).
- **Confirm** a card that helped (ranks it up). Contributions auto-attribute to GitHub/git identity.
- Reliable search = real error strings / library names, not vague rewording.
