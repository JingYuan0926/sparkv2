#!/usr/bin/env node
// Spark CLI — same store as the MCP server. Used by hooks (v2), non-MCP agents,
// the install skill, and tests/simulations. JSON output with --json.
import { Store, SECTIONS } from '../mcp-server/src/store.ts';
import { RemoteStore } from '../mcp-server/src/remote.ts';
import { SupabaseStore } from '../mcp-server/src/supabase.ts';
import { resolveConfig } from '../mcp-server/src/config.ts';
import { readFileSync, existsSync } from 'node:fs';

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
const cfg = resolveConfig({
  room: typeof flags.room === 'string' ? flags.room : undefined,
  agent: typeof flags.agent === 'string' ? flags.agent : undefined,
  dbPath: typeof flags.db === 'string' ? flags.db : undefined,
  api: typeof flags.api === 'string' ? flags.api : undefined,
  token: typeof flags.token === 'string' ? flags.token : undefined,
});
// Pick the backend like the MCP server: Supabase → self-hosted API → local SQLite.
let store: any;
if (cfg.supabaseUrl && cfg.supabaseKey) {
  store = new SupabaseStore(cfg.supabaseUrl, cfg.supabaseKey, cfg.token);
  await store.join(cfg.room).catch(() => {});
} else if (cfg.api) {
  store = new RemoteStore(cfg.api, cfg.token);
  await store.join(cfg.room).catch(() => {});
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
      const lines = [
        `# Spark room ${cfg.room} — you are "${cfg.agent}"`,
        ...SECTIONS.filter((s) => ctx[s].content).map((s) => `## ${s}\n${ctx[s].content}`),
        recent.length ? `## recent\n${recent.map((a) => `- ${a.ref} ${a.summary}`).join('\n')}` : '',
        missing.length
          ? `## heads-up\nEmpty context: ${missing.join(', ')} — fill them (spark context set <section> "...") so joiners see the real plan, not just generic cards.`
          : '',
        `\n(Search before you grind: spark search "<problem>". Record only what you've SOLVED. Confirm a card that helped: spark confirm <id>.)`,
      ].filter(Boolean);
      out(lines.join('\n\n'), { room: cfg.room, agent: cfg.agent, context: ctx, recent, missingSections: missing });
      break;
    }
    case 'summarize-hook': {
      // Stop/PreCompact hook backend: prepend a compact session digest to Status.
      // Keeps only the most recent digest lines (state, not transcript) + any manual notes.
      let payload: any = {};
      const raw = (typeof flags.note === 'string' ? '' : readStdin()).trim();
      if (raw) { try { payload = JSON.parse(raw); } catch {} }
      const note =
        typeof flags.note === 'string'
          ? flags.note
          : lastUserText(payload.transcript_path || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const line = `- [${stamp}] ${cfg.agent}: ${note || 'session ended'}`;
      const prevStatus = await store.getContext(cfg.room).status.content;
      const keptDigests = prevStatus.split('\n').filter((l) => l.startsWith('- [')).slice(0, 11);
      await store.updateContext(cfg.room, 'status', [line, ...keptDigests].join('\n'), cfg.agent);
      out(`status digest added: ${line}`, { line });
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
          `  orient                                      catch up on the room\n\n` +
          `Global: --room <CODE> --agent <name> --db <path> --api <url> --token <t> --json\n` +
          `Env (avoid repeating flags): SPARK_ROOM, SPARK_AGENT, SPARK_DB, SPARK_API, SPARK_TOKEN`,
      );
  }
} catch (e: any) {
  if (asJson) console.log(JSON.stringify({ error: e?.message || String(e) }));
  else console.error(`error: ${e?.message || e}`);
  process.exitCode = 1;
} finally {
  store.close();
}
