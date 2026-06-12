#!/usr/bin/env node
// Spark CLI — same store as the MCP server. Used by hooks (v2), non-MCP agents,
// the install skill, and tests/simulations. JSON output with --json.
import { Store, SECTIONS } from '../mcp-server/src/store.ts';
import { RemoteStore } from '../mcp-server/src/remote.ts';
import { SupabaseStore } from '../mcp-server/src/supabase.ts';
import { resolveConfig } from '../mcp-server/src/config.ts';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// Best-effort: pull the last user-message text from a Claude Code transcript JSONL.
function lastUserText(transcriptPath: string): string {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return '';
    const lines = readFileSync(transcriptPath, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let m: any;
      try { m = JSON.parse(lines[i]); } catch { continue; }
      const role = m.role || m.message?.role || m.type;
      if (role !== 'user') continue;
      const c = m.content ?? m.message?.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        const t = c.find((p: any) => p?.type === 'text' || typeof p?.text === 'string');
        if (t?.text) return t.text;
      }
    }
  } catch {}
  return '';
}

function readStdin(): string {
  try {
    if (process.stdin.isTTY) return '';
    return readFileSync(0, 'utf8');
  } catch { return ''; }
}

// Hooks run outside the MCP server, so they don't inherit the Supabase env bundled in
// plugin.json. --from-hook loads those bundled values as fallbacks for unset env vars.
function pluginEnv(): Record<string, string> {
  try {
    const manifest = join(dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json');
    return JSON.parse(readFileSync(manifest, 'utf8'))?.mcpServers?.spark?.env || {};
  } catch { return {}; }
}

function trunc(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

// Digest lines written by summarize-hook carry a timestamp stamp. Match exactly that —
// a generic '- [' prefix would also swallow hand-written markdown checkboxes (`- [ ] todo`).
const DIGEST_RE = /^- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] /;

// Real Claude Code payloads (captured from live sessions, v2.1.173):
//   PostToolUseFailure → { tool_name, tool_input, error: "Exit code 1\n<output>", is_interrupt }
//   PostToolUse (success) → { tool_response: { stdout, stderr, interrupted, ... } } — no exit code.
// There is NO exit_code field anywhere; failures are a separate event with a string `error`.
function failingBashError(payload: any): string {
  if (payload.tool_name && payload.tool_name !== 'Bash') return '';
  if (payload.is_interrupt || payload.tool_response?.interrupted) return '';
  if (typeof payload.error === 'string' && payload.error) return payload.error;
  // Defensive: some transcript shapes record failures as a string tool_response.
  if (typeof payload.tool_response === 'string' && /^(Error: )?Exit code \d+/.test(payload.tool_response))
    return payload.tool_response;
  return ''; // object-shaped tool_response = the success event — never a failure
}

// Distill a failing command's output into a searchable query: prefer error-looking lines,
// fall back to the output tail; strip ANSI codes and the "Exit code N" header.
function errorQuery(errorText: string, command: string): string {
  const clean = errorText.replace(/\x1b\[[0-9;]*m/g, '').replace(/^(Error: )?Exit code \d+\n?/, '');
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
  const errLines = lines.filter((l) =>
    /\b(error|err!|exception|fatal|failed|cannot|unable|not found|no such|denied|refused|traceback|panic)\b/i.test(l),
  );
  const picked = (errLines.length ? errLines : lines).slice(-6);
  const cmdHead = command.trim().split(/\s+/).slice(0, 2).join(' ');
  return [cmdHead, ...picked].join(' ').replace(/\s+/g, ' ').trim().slice(0, 400);
}

// Per-session memory of injected card ids so a retry loop on the same failure doesn't
// re-inject identical cards every attempt (context spam / dead-end steering).
function seenFile(sessionId: string): string {
  return join(homedir(), '.spark', `hook-seen-${sessionId.replace(/[^A-Za-z0-9-]/g, '_')}.json`);
}
function readSeen(sessionId: string): number[] {
  try { return JSON.parse(readFileSync(seenFile(sessionId), 'utf8')); } catch { return []; }
}
function writeSeen(sessionId: string, ids: number[]): void {
  try {
    mkdirSync(join(homedir(), '.spark'), { recursive: true });
    writeFileSync(seenFile(sessionId), JSON.stringify(ids));
  } catch {}
}

// Read a value from --X, or preferably (for code/multiline) from --X-file <path> ('-' = stdin).
// File input bypasses shell quoting/expansion that can SILENTLY corrupt a --X argument.
function readArg(direct: string | boolean | undefined, file: string | boolean | undefined): string | undefined {
  if (typeof file === 'string') return file === '-' ? readStdin() : readFileSync(file, 'utf8');
  return typeof direct === 'string' ? direct : undefined;
}

function parseFlags(argv: string[]): { _: string[]; flags: Record<string, string | boolean> } {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else _.push(a);
  }
  return { _, flags };
}

const { _, flags } = parseFlags(process.argv.slice(2));
const cmd = _[0];
const asJson = !!flags.json;
// --from-hook (set on every hook command in hooks/hooks.json): if this project has no room
// configured, the plugin is installed but not joined — stay silent so hooks add zero noise.
const fromHook = !!flags['from-hook'];
if (fromHook && !process.env.SPARK_ROOM && typeof flags.room !== 'string') process.exit(0);

// posttooluse-hook runs on every failing Bash call — decide relevance from stdin alone
// BEFORE paying any identity/config/network setup, and exit free when there's nothing to do.
let hookPayload: any;
if (cmd === 'posttooluse-hook') {
  try { hookPayload = JSON.parse(readStdin().trim() || '{}'); } catch { hookPayload = {}; }
  if (!failingBashError(hookPayload)) process.exit(0);
}

// Fall back to the plugin-bundled cloud creds ONLY when no backend is configured at all:
// any explicit SPARK_API / SPARK_SUPABASE_* / SPARK_DB (even set-but-empty Supabase vars,
// which mean "local mode") must win over the bundle — never mix backends silently.
const noBackendConfigured =
  !process.env.SPARK_API &&
  process.env.SPARK_SUPABASE_URL === undefined &&
  process.env.SPARK_SUPABASE_KEY === undefined &&
  !process.env.SPARK_DB &&
  typeof flags.api !== 'string' &&
  typeof flags.db !== 'string';
const bundled = fromHook && noBackendConfigured ? pluginEnv() : {};
// The bundle is a URL+KEY pair — applying half of it would point at a project with the wrong key.
const bundleOk = !!(bundled.SPARK_SUPABASE_URL && bundled.SPARK_SUPABASE_KEY);
const cfg = resolveConfig({
  room: typeof flags.room === 'string' ? flags.room : undefined,
  agent:
    typeof flags.agent === 'string'
      ? flags.agent
      // Identity detection shells out to `gh api user` (up to 2.5s); the failure-search
      // hook never records anything, so skip it on that hot path.
      : cmd === 'posttooluse-hook'
        ? process.env.SPARK_AGENT || 'spark-hook'
        : undefined,
  dbPath: typeof flags.db === 'string' ? flags.db : undefined,
  api: typeof flags.api === 'string' ? flags.api : undefined,
  token: typeof flags.token === 'string' ? flags.token : undefined,
  supabaseUrl: bundleOk ? bundled.SPARK_SUPABASE_URL : undefined,
  supabaseKey: bundleOk ? bundled.SPARK_SUPABASE_KEY : undefined,
});
// Pick the backend like the MCP server: Supabase → self-hosted API → local SQLite.
// An explicit --db always means local (tests, inspecting a local room file).
// Hook invocations skip the eager join roundtrip: every RPC is already token-gated, and
// a hook should never be what creates a room.
let store: any;
if (typeof flags.db === 'string') {
  store = new Store(cfg.dbPath);
} else if (cfg.supabaseUrl && cfg.supabaseKey) {
  store = new SupabaseStore(cfg.supabaseUrl, cfg.supabaseKey, cfg.token, fromHook ? 4000 : 8000);
  if (!fromHook) await store.join(cfg.room).catch(() => {});
} else if (cfg.api) {
  store = new RemoteStore(cfg.api, cfg.token);
  if (!fromHook) await store.join(cfg.room).catch(() => {});
} else {
  store = new Store(cfg.dbPath);
}

function out(human: string, data: unknown) {
  if (asJson) console.log(JSON.stringify(data));
  else console.log(human);
}

function toTags(v: string | boolean | undefined): string[] | undefined {
  if (typeof v !== 'string') return undefined;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

try {
  switch (cmd) {
    case 'record': {
      const c = await store.recordSolution(cfg.room, {
        problem: readArg(flags.problem, flags['problem-file']) || '',
        solution: readArg(flags.solution, flags['solution-file']) || '',
        context: readArg(flags.context, flags['context-file']),
        tags: toTags(flags.tags),
        author: cfg.agent,
      });
      out(`recorded #${c.id} (${c.status}) — once it's proven to work, run: spark confirm ${c.id}`, c);
      break;
    }
    case 'search': {
      const query = _.slice(1).join(' ') || (typeof flags.query === 'string' ? flags.query : '');
      const cards = await store.searchSmart(cfg.room, query, toTags(flags.tags), Number(flags.limit) || 5);
      out(
        cards.length
          ? cards
              .map(
                (c) =>
                  `#${c.id} [${c.relevance != null ? Math.round(c.relevance * 100) + '% ' : ''}${c.status}${c.helped ? `, ${c.helped}x` : ''}] ${c.problem}\n   -> ${c.solution}`,
              )
              .join('\n')
          : '(no strong match — nothing relevant in this room; you may be the first. solve it, then `spark record`.)',
        cards,
      );
      break;
    }
    case 'get':
    case 'show': {
      const id = Number(_[1] || flags.id);
      const c = await store.getSolution(cfg.room, id);
      out(
        c
          ? `#${c.id} [${c.status}${c.helped ? `, helped ${c.helped}x` : ''}] (${c.tags.join(', ')}) by ${c.author || '?'}\nPROBLEM: ${c.problem}\nSOLUTION: ${c.solution}${c.context ? `\nCONTEXT: ${c.context}` : ''}`
          : `no card #${id} in room ${cfg.room}`,
        c,
      );
      break;
    }
    case 'update': {
      const id = Number(_[1] || flags.id);
      const c = await store.updateSolution(cfg.room, id, {
        problem: readArg(flags.problem, flags['problem-file']),
        solution: readArg(flags.solution, flags['solution-file']),
        context: readArg(flags.context, flags['context-file']),
        tags: toTags(flags.tags),
      });
      out(c ? `updated #${c.id}` : `no card #${id} in room ${cfg.room}`, c);
      break;
    }
    case 'delete':
    case 'rm': {
      const id = Number(_[1] || flags.id);
      const ok = await store.deleteSolution(cfg.room, id);
      out(ok ? `deleted #${id}` : `no card #${id} in room ${cfg.room}`, { ok, id });
      break;
    }
    case 'confirm': {
      const c = await store.confirmSolution(cfg.room, Number(_[1] || flags.id));
      out(c ? `confirmed #${c.id} (verified, helped ${c.helped}x)` : 'not found', c);
      break;
    }
    case 'context': {
      const sub = _[1];
      if (sub === 'set') {
        const section = _[2];
        const content = _.slice(3).join(' ') || (typeof flags.content === 'string' ? flags.content : '');
        const r = await store.updateContext(cfg.room, section, content, cfg.agent);
        out(`updated "${r.section}"`, r);
      } else {
        const ctx = await store.getContext(cfg.room);
        out(
          SECTIONS.map((s) => `## ${s}\n${ctx[s].content || '(empty)'}`).join('\n\n'),
          ctx,
        );
      }
      break;
    }
    case 'recent': {
      const acts = await store.listRecent(cfg.room, Number(_[1]) || Number(flags.limit) || 10);
      out(acts.map((a) => `${a.at} ${a.ref} ${a.summary}`).join('\n') || '(empty)', acts);
      break;
    }
    case 'orient': {
      // Used by the SessionStart hook (v2): compact context + recent solutions.
      const ctx = await store.getContext(cfg.room);
      const recent = await store.listRecent(cfg.room, 5);
      const missing = (['goal', 'decisions', 'map'] as const).filter((s) => !ctx[s].content);
      const emptyRoom = !recent.length && SECTIONS.every((s) => !ctx[s].content);
      const lines = [
        `# Spark room ${cfg.room} — you are "${cfg.agent}"`,
        ...SECTIONS.filter((s) => ctx[s].content).map((s) => `## ${s}\n${ctx[s].content}`),
        recent.length ? `## recent\n${recent.map((a) => `- ${a.ref} ${a.summary}`).join('\n')}` : '',
        emptyRoom
          ? `## heads-up\nThis room is EMPTY (no cards, no context). If your team expected an existing room here, the room code (SPARK_ROOM) is probably a typo — verify it before recording anything. If it's genuinely new, set the goal first.`
          : missing.length
            ? `## heads-up\nEmpty context: ${missing.join(', ')} — fill them (spark context set <section> "...") so joiners see the real plan, not just generic cards.`
            : '',
        `\n(Search before you grind: spark search "<problem>". Record only what you've SOLVED. Confirm a card that helped: spark confirm <id>.)`,
      ].filter(Boolean);
      out(lines.join('\n\n'), { room: cfg.room, agent: cfg.agent, context: ctx, recent, missingSections: missing, emptyRoom });
      break;
    }
    case 'join': {
      // Loud join feedback: join is create-on-first-use, so a typo'd room code silently
      // makes a fresh empty room and splits the team. Report what the room actually holds.
      const ctx = await store.getContext(cfg.room);
      const cards = await store.searchSmart(cfg.room, '', undefined, 1000);
      const filled = SECTIONS.filter((s) => ctx[s].content);
      const human =
        cards.length || filled.length
          ? `joined room ${cfg.room} — ${cards.length} solution card(s), context filled: ${filled.join(', ') || '(none)'}`
          : `joined room ${cfg.room} — but it is EMPTY (0 cards, no context).\n` +
            `If your team already uses this room, the code is probably a TYPO — check SPARK_ROOM in .env.\n` +
            `If this is a brand-new room, you're set — record the goal: spark context set goal "..."`;
      out(human, { room: cfg.room, cards: cards.length, sections: filled, empty: !cards.length && !filled.length });
      break;
    }
    case 'summarize-hook': {
      // SessionEnd/PreCompact hook backend: prepend a compact session digest to Status.
      // Caps the digest block (state, not transcript) and keeps manual status notes below —
      // an agent's hand-written "blocked on webhook" must survive teammates' session ends.
      let payload: any = {};
      const raw = (typeof flags.note === 'string' ? '' : readStdin()).trim();
      if (raw) { try { payload = JSON.parse(raw); } catch {} }
      const note =
        typeof flags.note === 'string'
          ? flags.note
          : lastUserText(payload.transcript_path || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      // Nothing to summarize (no-op session, /clear on an empty session) → don't burn one
      // of the capped digest slots or churn the shared status with "session ended" noise.
      if (!note) break;
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const line = `- [${stamp}] ${cfg.agent}: ${note}`;
      const prevStatus: string = (await store.getContext(cfg.room)).status.content || '';
      const prevLines = prevStatus ? prevStatus.split('\n') : [];
      const keptDigests = prevLines.filter((l) => DIGEST_RE.test(l)).slice(0, 11);
      const manual = prevLines.filter((l) => !DIGEST_RE.test(l)).join('\n').trim();
      const next = [line, ...keptDigests].join('\n') + (manual ? `\n\n${manual}` : '');
      await store.updateContext(cfg.room, 'status', next, cfg.agent);
      out(`status digest added: ${line}`, { line });
      break;
    }
    case 'posttooluse-hook': {
      // PostToolUseFailure(Bash) hook: a command failed — search the room for the error and
      // inject any hits back into the agent's context. Silent on no match — a hit costs
      // nothing to show, a miss must add zero noise. (Success never reaches here: the
      // payload check before config/store setup already exited.)
      const errText = failingBashError(hookPayload);
      const query = errorQuery(errText, String(hookPayload.tool_input?.command ?? ''));
      if (!query) break;
      let cards = await store.searchSmart(cfg.room, query, undefined, 2);
      // Don't re-inject cards already shown this session: a retry loop on the same failure
      // would otherwise spam context (and keep recommending a fix the agent already tried).
      const sessionId = String(hookPayload.session_id || '');
      if (sessionId && cards.length) {
        const seen = readSeen(sessionId);
        cards = cards.filter((c: any) => !seen.includes(c.id));
        if (cards.length) writeSeen(sessionId, [...seen, ...cards.map((c: any) => c.id)]);
      }
      if (!cards.length) break;
      const text = cards
        .map((c) => `#${c.id} [${c.status}${c.helped ? `, helped ${c.helped}x` : ''}] ${c.problem}\nFIX: ${trunc(c.solution, 500)}`)
        .join('\n\n');
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: hookPayload.hook_event_name || 'PostToolUseFailure',
            additionalContext:
              `Spark: a teammate already solved an error like this. Before re-deriving a fix, try:\n\n${text}\n\n` +
              `If one of these solves it, call confirm_solution(<id>) to rank it up.`,
          },
        }),
      );
      break;
    }
    default:
      console.log(
        `spark <command>\n\n` +
          `  search <query> [--tags a,b] [--limit n]     relevance-ranked; only relevant cards shown\n` +
          `  record --problem "..." --solution "..." [--context "..."] [--tags a,b]\n` +
          `         code/multiline? use shell-safe files: --problem-file P --solution-file S  ('-' = stdin)\n` +
          `  get <id> | show <id>                        print one card in full\n` +
          `  update <id> [--solution-file S | --solution "..."] [--problem ...] [--tags a,b]\n` +
          `  delete <id>                                 remove a wrong/duplicate card\n` +
          `  confirm <id>                                mark verified + bump 'helped' when a card helped you\n` +
          `  context [get | set <section> "<content>"]   sections: goal, stack, decisions, status, map\n` +
          `  recent [n]                                  activity feed\n` +
          `  orient                                      catch up on the room\n` +
          `  join                                        verify the room (loud warning if it's empty — likely a typo'd code)\n\n` +
          `Global: --room <CODE> --agent <name> --db <path> --api <url> --token <t> --json\n` +
          `Env (avoid repeating flags): SPARK_ROOM, SPARK_AGENT, SPARK_DB, SPARK_API, SPARK_TOKEN`,
      );
  }
} catch (e: any) {
  // Hooks are best-effort: a dead network must not paint a red hook error after every
  // Bash call / session event. Fail silently with exit 0 when invoked from a hook.
  if (fromHook) {
    process.exitCode = 0;
  } else {
    if (asJson) console.log(JSON.stringify({ error: e?.message || String(e) }));
    else console.error(`error: ${e?.message || e}`);
    process.exitCode = 1;
  }
} finally {
  store.close();
}
