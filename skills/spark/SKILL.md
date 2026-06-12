---
name: spark
description: Join a Spark team room — the shared knowledge tool for AI coding agents. Use for "/spark join <ROOM>", connecting your agent to the team's shared context, or onboarding a teammate. The MCP server is already registered by the plugin; this skill sets your room + cloud credentials and writes the usage rules into the project's CLAUDE.md.
---

# Spark — join a room

The `spark` plugin already registered the MCP server, so the agent has the tools
(`search_solutions`, `record_solution`, `confirm_solution`, `update_solution`,
`delete_solution`, `get_context`, `update_context`, `list_recent`). This skill connects the
**current project** to a room. Requirements: **Node 22.18+** (built-in `node:sqlite` + default
type-stripping, no install).

When invoked (e.g. `/spark join TEAM-HACK`), do this:

## 1. Get the room code
Take the **room code** from the command (`/spark join <CODE>`) or ask for it. The Supabase URL +
anon key are **already bundled in the plugin** — you don't need to ask for them.

## 2. Write `.env` in the current project (gitignored)
Write `.env` in the project root with just the room:
```
SPARK_ROOM=<ROOM_CODE>
# SPARK_AGENT optional — author auto-detects (GitHub handle → git user.name → OS user).
```
Add `.env` to `.gitignore`. (The plugin's MCP server runs `--env-file-if-exists=.env` from the
project cwd, so it picks up the room; the bundled URL+key handle the cloud connection. For
local-only mode instead, set `SPARK_SUPABASE_URL=` empty — data then lives in `~/.spark/<ROOM>.db`.)

## 3. Write the usage rules into CLAUDE.md
First check the project's `CLAUDE.md`: if it already contains the text
`Spark — shared team knowledge` (at any heading level — INSTALL.md's flow writes it as an h1),
**skip this step** (re-joining must not duplicate the block). Otherwise append
(create the file if missing) so the agent actually *uses* Spark:
```markdown
## Spark — shared team knowledge (use it)
- BEFORE grinding on any error/build/setup problem, call `search_solutions` with the error text.
- If a returned card solves it, apply it and call `confirm_solution(id)`.
- After solving something non-trivial, call `record_solution` (real error text in `problem`).
- On a fresh/confusing task call `get_context`; keep `update_context` (status) current.
- Fix a wrong card with `update_solution`; remove a dud with `delete_solution` (don't duplicate).
```

## 4. Connect + verify
Tell the user to run **`/mcp`** (or restart) so the `spark` server picks up the new `.env`
(the server only re-reads `.env` on reconnect — verifying before that can hit the old room).
Then confirm by calling `get_context` and **read the output carefully**:
- It prints the room brief → they're in. Relay the goal/status so the user sees it worked.
- It warns the room is **EMPTY** but the team already has content there → the room code is
  almost certainly a **typo**. Fix `SPARK_ROOM` in `.env` and run `/mcp` again. Joining never
  errors on an unknown code (join is create-on-first-use), so this warning is the only signal.

The plugin also ships hooks (auto-active, no setup): session start auto-orients from the room,
session end / pre-compact writes a status digest, and a failing Bash command auto-searches the
room and surfaces a teammate's fix if one exists.

## Tips to relay
- **Search before you grind**; **record only what's solved** (real error text in `problem`).
- **Confirm** a card that helped (ranks it up). Contributions auto-attribute to GitHub/git identity.
- Reliable search = real error strings / library names, not vague rewording.
