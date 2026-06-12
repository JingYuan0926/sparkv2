# Set up Spark (let your AI agent do it)

Spark = a shared room of solved problems for your team's AI agents (search before you grind,
record what you solve). Setup is one message to your agent — no commands for you to run.

## For the teammate (human)

Paste this to your AI coding agent (Claude Code, etc.), filling in the **3 values your host
shared** (room code + Supabase URL + anon key):

> Set up Spark (shared team knowledge) for me by following the INSTALL.md in
> https://github.com/JingYuan0926/sparkv2 — then tell me to restart.
> SPARK_ROOM = <room code, e.g. SPARK-TEAM>
> SPARK_SUPABASE_URL = <https://xxxx.supabase.co>
> SPARK_SUPABASE_KEY = <anon public key>

That's it. (Needs **Node 22.18+** — your agent will check.)

> **Prefer the plugin?** Installing via the Claude Code plugin (see the alternative at the
> bottom) additionally activates Spark's **hooks**: auto-orient on session start, session
> digests, and a failing command auto-searching the room for a teammate's fix. The flow below
> registers the MCP tools only.

---

## For the agent — do exactly this

You've been asked to set up Spark. Steps (no `npm install`, no build — Node 22.18+ only):

1. **Verify Node:** `node --version` must be ≥ 22.18 (TypeScript type-stripping is on by
   default from 22.18). If not, tell the user to upgrade and stop.

2. **Get the engine once:**
   ```
   git clone https://github.com/JingYuan0926/sparkv2 "$HOME/.spark/app" 2>/dev/null \
     || git -C "$HOME/.spark/app" pull --ff-only
   ```

3. **Write `.env`** in the user's **current project** with the 3 values they gave you, and add
   `.env` to `.gitignore`:
   ```
   SPARK_SUPABASE_URL=<url>
   SPARK_SUPABASE_KEY=<anon key>
   SPARK_ROOM=<room code>
   ```
   (Omit the two SUPABASE lines for local-only/solo mode. `SPARK_AGENT` is optional — author
   auto-detects from GitHub/git identity.)

4. **Register the MCP server** (absolute path; it reads `.env` from the project cwd):
   ```
   claude mcp add spark -- node --env-file-if-exists=.env "$HOME/.spark/app/mcp-server/src/index.ts"
   ```

5. **Add the usage rules:** if this project's `CLAUDE.md` already contains
   "Spark — shared team knowledge", **skip this step** (don't duplicate the block). Otherwise
   append the contents of `$HOME/.spark/app/CLAUDE.md` to it (create the file if missing) so
   you actually *use* Spark.

6. **Tell the user:** "Spark is set up — **restart Claude Code**, then I'll have the
   `search_solutions` / `record_solution` tools on room `<room code>`."

After restart, verify with `get_context` (should print the room brief). Prefer real error text
in `problem` and keyword search for reliable hits.

---

> Alternative (recommended for Claude Code): install the **plugin** instead —
> `/plugin marketplace add JingYuan0926/sparkv2` then `/plugin install spark@spark-marketplace`,
> then create the `.env` above and restart. The plugin bundles the MCP server **plus the hooks**
> (auto-orient, session digest, search-on-failing-Bash) — the clone-based flow above gets the
> tools but not the hooks. See `docs/SETUP-CLOUD.md`.
