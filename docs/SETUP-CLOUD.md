# Spark — Cloud setup (central Supabase DB, teammates join with a skill)

Goal: **one** person hosts a central database on Supabase; the other teammates join with a
room code and the `/spark` skill. Nothing else to host — Supabase provides the database *and*
the API. Each teammate's Claude Code talks straight to Supabase (token-gated).

```
You (host):  Supabase project ──┐  Postgres + auto REST API, locked by room-token functions
Teammates:   Claude Code ─MCP───┴──►  all read/write the same central DB
```

---

## Part A — Host setup (you, one time, ~5 min)

1. **Create a free Supabase project** at https://supabase.com → New project. Wait for it to
   provision.
2. **Run the schema.** Open the project's **SQL Editor** → New query → paste the entire
   contents of [`supabase/schema.sql`](../supabase/schema.sql) → **Run**. This creates the
   tables and the token-gated access functions (and locks the tables with RLS).
3. **Grab two values** from Project Settings → API:
   - **Project URL** — `https://<project>.supabase.co`
   - **anon public key** — the `anon` / `public` key (safe to share with your team; it can
     only call the gated functions, not read tables directly).
4. **Share them with the team** by committing a `.mcp.json` to the repo (anon key is
   public-safe), or send the two values privately. Template:

   ```json
   {
     "mcpServers": {
       "spark": {
         "command": "node",
         "args": ["mcp-server/src/index.ts"],
         "env": {
           "SPARK_ROOM": "TEAM-HACK",
           "SPARK_SUPABASE_URL": "https://<project>.supabase.co",
           "SPARK_SUPABASE_KEY": "<anon-public-key>"
         }
       }
     }
   }
   ```
5. **Pick a room code** (e.g. `TEAM-HACK`). The code is the join secret — whoever knows it can
   read/write that room. The first agent to join creates the room and locks in its token.

---

## Part B — Teammate setup (each of the other 3, ~30 sec)

1. Have **Node 22+** and the Spark repo (clone it, or it's vendored in your project).
2. In Claude Code, run **`/spark join TEAM-HACK`** (or set `SPARK_ROOM` in `.mcp.json` to the
   team code, plus `SPARK_AGENT` = your name). The Supabase URL + key come from the shared
   `.mcp.json`.
3. Run **`/mcp`** to connect. Done — your agent now shares the team's room.

---

## How to know it worked

- `/mcp` lists **spark ✓ connected**.
- Ask your agent: *"get the Spark context"* → it returns the shared room brief.
- The real test: one teammate records a solution, another searches for it (with close wording)
  and it comes back — across different laptops.
- CLI check: `SPARK_SUPABASE_URL=… SPARK_SUPABASE_KEY=… node cli/spark.ts orient --room TEAM-HACK`

---

## Security notes (honest)

- The **anon key is public-safe**: tables have RLS with no policies, so the key can only call
  the token-checked functions. It cannot read other rooms or bypass the code.
- The **room code = the shared secret.** Anyone with the code can read/write that room. For a
  private team that's fine (like a shared password). Don't reuse a guessable code for anything
  sensitive. Separating code-from-token (real per-user auth) is a v5 item.
- Search ranking runs client-side over a room's cards — great for hackathon-scale rooms
  (hundreds of cards). For very large rooms, move ranking into a Postgres function (v4/v5).

---

## Don't want to set up Supabase yet?

You can run the **local** mode today (no cloud): each person uses `SPARK_ROOM` with no Supabase
vars — data lives in `~/.spark/<room>.db` on their own machine (shared across their terminals,
but not across laptops). Good for solo use; switch to the cloud config above when the team
wants to share.
