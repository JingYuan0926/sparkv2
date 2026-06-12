// Hackathon must-fix tier: summarize-hook on async backends + manual-status preservation,
// loud join feedback (typo'd room codes), posttooluse-hook (search-on-failure), tags guard,
// SupabaseStore.listRecent ordering, --from-hook gating. Run: node mcp-server/test/must-fix.test.ts
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { rmSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { Store, SECTIONS } from '../src/store.ts';
import { TOOLS } from '../src/tools.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..');
const CLI = join(ROOT, 'cli', 'spark.ts');
const DB = '/tmp/spark-mustfix.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
  try { rmSync(f); } catch {}
}

let passed = 0, failed = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { passed++; console.log(`  ok  - ${name}`); }
  else { failed++; console.log(`FAIL  - ${name} ${extra}`); }
}

function runCli(args: string[], opts: { stdin?: string; env?: Record<string, string | undefined> } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const env: any = { ...process.env, ...opts.env };
    delete env.SPARK_ROOM; delete env.SPARK_DB; delete env.SPARK_API;
    delete env.SPARK_SUPABASE_URL; delete env.SPARK_SUPABASE_KEY; delete env.SPARK_TOKEN;
    for (const [k, v] of Object.entries(opts.env || {})) if (v !== undefined) env[k] = v;
    const c = spawn('node', [CLI, ...args], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('exit', (code) => resolve({ code: code ?? 1, out }));
    if (opts.stdin) c.stdin.write(opts.stdin);
    c.stdin.end();
  });
}

// ---- mini mock PostgREST: async backend with CONTROLLABLE card order ----
// spark_cards deliberately returns rows in insertion order (NOT newest-first) so the
// client-side ordering in SupabaseStore.listRecent is actually exercised.
const rows: any[] = [];
const ctx: Record<string, any> = {};
let nextId = 1;
const PORT = 8877;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const fn = ((req.url || '').match(/\/rest\/v1\/rpc\/(\w+)/) || [])[1];
    let a: any = {};
    try { a = JSON.parse(body || '{}'); } catch {}
    const send = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    switch (fn) {
      case 'spark_join': return send(200, true);
      case 'spark_cards': return send(200, rows);
      case 'spark_record': {
        const r = { id: nextId++, room_id: a.p_room, problem: a.p_problem, solution: a.p_solution, context: a.p_context || null, tags: a.p_tags || '', status: 'unverified', helped: 0, author: a.p_author, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        rows.push(r);
        return send(200, r);
      }
      case 'spark_get_context': return send(200, Object.values(ctx));
      case 'spark_set_context': {
        ctx[a.p_section] = { room_id: a.p_room, section: a.p_section, content: a.p_content, updated_at: new Date().toISOString(), updated_by: a.p_by };
        return send(200, ctx[a.p_section]);
      }
      default: return send(404, { message: `no mock for ${fn}` });
    }
  });
});
await new Promise<void>((r) => server.listen(PORT, r));
const SB_ENV = { SPARK_SUPABASE_URL: `http://localhost:${PORT}`, SPARK_SUPABASE_KEY: 'mock-key', SPARK_ROOM: 'MF' };

try {
  // --- 1. summarize-hook against an ASYNC backend (the await-after-property-access bug) ---
  ctx.status = { room_id: 'MF', section: 'status', content: '- [2026-01-01 00:00] bob: old digest\n\nmanual: blocked on stripe webhook', updated_at: new Date().toISOString(), updated_by: 'bob' };
  const r1 = await runCli(['summarize-hook', '--agent', 'alice', '--note', 'wired payments'], { env: SB_ENV });
  check('summarize-hook exits 0 on async backend', r1.code === 0, r1.out);
  const status = String(ctx.status.content);
  check('new digest first', status.split('\n')[0].includes('wired payments'), status);
  check('old digest retained', status.includes('old digest'));
  check('manual status note survives the digest', status.includes('blocked on stripe webhook'), status);

  // --- 2. SupabaseStore.listRecent: newest first even when the server returns unsorted ---
  // The newest card is pushed LAST: without the client-side sort, the pre-slice
  // (slice(0, 2) in insertion order) drops #91 entirely — that's the regression.
  rows.push(
    { id: 90, room_id: 'MF', problem: 'OLD problem', solution: 'x', context: null, tags: '', status: 'unverified', helped: 0, author: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
    { id: 92, room_id: 'MF', problem: 'MIDDLE problem', solution: 'x', context: null, tags: '', status: 'unverified', helped: 0, author: null, created_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z' },
    { id: 91, room_id: 'MF', problem: 'NEWEST problem', solution: 'x', context: null, tags: '', status: 'unverified', helped: 0, author: null, created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z' },
  );
  const r2 = await runCli(['recent', '2', '--json'], { env: SB_ENV });
  const acts = JSON.parse(r2.out || '[]').filter((a: any) => a.kind === 'solution');
  check('listRecent keeps the newest card despite unsorted server rows', acts[0]?.ref === '#91', r2.out);

  // --- 3. join feedback: empty room warns loudly; populated room reports counts ---
  const r3 = await runCli(['join', '--db', DB, '--room', 'EMPTYROOM']);
  check('join on empty room warns about typo', /EMPTY/.test(r3.out) && /TYPO/i.test(r3.out), r3.out);
  const seed = new Store(DB);
  seed.recordSolution('FULLROOM', { problem: 'vite env vars undefined in client', solution: 'prefix with VITE_', tags: ['vite'] });
  seed.updateContext('FULLROOM', 'goal', 'ship the demo', 'alice');
  seed.close();
  const r4 = await runCli(['join', '--db', DB, '--room', 'FULLROOM']);
  check('join on populated room reports cards + context', /1 solution card/.test(r4.out) && /goal/.test(r4.out), r4.out);
  check('join on populated room has no typo warning', !/TYPO/i.test(r4.out), r4.out);

  // --- 4. posttooluse-hook: REAL payload shapes (captured from live Claude Code sessions).
  // Failures arrive as PostToolUseFailure with a string `error` ("Exit code N\n<output>");
  // successes arrive as PostToolUse with an object tool_response and NO exit-code field.
  const SESS = `mf-${process.pid}`;
  const seenA = join(homedir(), '.spark', `hook-seen-${SESS}.json`);
  const seenB = join(homedir(), '.spark', `hook-seen-${SESS}-b.json`);
  for (const f of [seenA, seenB]) { try { rmSync(f); } catch {} }
  const failPayload = (over: any = {}) => JSON.stringify({
    hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', session_id: SESS,
    tool_input: { command: 'npm run build' },
    error: 'Exit code 1\nerror: vite env vars undefined in client bundle',
    is_interrupt: false,
    ...over,
  });
  const h1 = await runCli(['posttooluse-hook', '--db', DB, '--room', 'FULLROOM'], { stdin: failPayload() });
  const hookOut = (() => { try { return JSON.parse(h1.out); } catch { return null; } })();
  check('failing Bash + known error → injects additionalContext', !!hookOut?.hookSpecificOutput?.additionalContext, h1.out.slice(0, 120));
  check('injected context carries the fix + confirm nudge', /VITE_/.test(hookOut?.hookSpecificOutput?.additionalContext || '') && /confirm_solution/.test(hookOut?.hookSpecificOutput?.additionalContext || ''));
  check('injected hookEventName echoes PostToolUseFailure', hookOut?.hookSpecificOutput?.hookEventName === 'PostToolUseFailure');

  // Same failure again in the same session → already-injected card is suppressed.
  const h1b = await runCli(['posttooluse-hook', '--db', DB, '--room', 'FULLROOM'], { stdin: failPayload() });
  check('same error retried in same session → no re-injection', h1b.out.trim() === '', h1b.out);
  // ...but a different session sees it fresh.
  const h1c = await runCli(['posttooluse-hook', '--db', DB, '--room', 'FULLROOM'], { stdin: failPayload({ session_id: `${SESS}-b` }) });
  check('different session → injects again', /VITE_/.test(h1c.out));

  const h2 = await runCli(['posttooluse-hook', '--db', DB, '--room', 'FULLROOM'], { stdin: failPayload({ error: 'Exit code 1\nerror: kubernetes crashloopbackoff zzqq', session_id: `${SESS}-b` }) });
  check('failing Bash + unknown error → silent (no noise)', h2.out.trim() === '', h2.out);
  // Real SUCCESS shape: object tool_response, no error field — even with an error-looking
  // warning in stderr it must stay silent (the old stderr regex false-positived here).
  const h3 = await runCli(['posttooluse-hook', '--db', DB, '--room', 'FULLROOM'], { stdin: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: SESS, tool_input: { command: 'npm install' }, tool_response: { stdout: 'added 12 packages', stderr: 'npm warn deprecated: error in optional dependency', interrupted: false, isImage: false } }) });
  check('successful Bash (real shape, deceptive stderr) → silent', h3.out.trim() === '', h3.out);
  const h4 = await runCli(['posttooluse-hook', '--db', DB, '--room', 'FULLROOM'], { stdin: failPayload({ tool_name: 'Read' }) });
  check('non-Bash tool → silent', h4.out.trim() === '', h4.out);
  const h5 = await runCli(['posttooluse-hook', '--db', DB, '--room', 'FULLROOM'], { stdin: failPayload({ is_interrupt: true }) });
  check('user-interrupted command → silent', h5.out.trim() === '', h5.out);
  check('hook exits 0 in all cases', [h1, h1b, h1c, h2, h3, h4, h5].every((h) => h.code === 0));
  for (const f of [seenA, seenB]) { try { rmSync(f); } catch {} }

  // --- 5. --from-hook gating: no room configured → totally silent, exit 0 ---
  const g1 = await runCli(['orient', '--from-hook']);
  check('--from-hook with no room: silent exit 0', g1.code === 0 && g1.out === '', g1.out);
  // Explicitly-empty Supabase URL still means local mode (not the bundled cloud creds).
  const g2 = await runCli(['orient', '--from-hook'], { env: { SPARK_ROOM: 'FULLROOM', SPARK_SUPABASE_URL: '', SPARK_SUPABASE_KEY: '', SPARK_DB: DB } });
  check('--from-hook + empty URL: runs locally', g2.code === 0 && /ship the demo/.test(g2.out), g2.out.slice(0, 80));

  // --- 6. orient on an empty room warns about a possible typo ---
  const g3 = await runCli(['orient', '--db', DB, '--room', 'EMPTYROOM2']);
  check('orient flags an empty room as possible typo', /EMPTY/.test(g3.out) && /typo/i.test(g3.out), g3.out.slice(0, 100));

  // --- 6b. hook resilience: unreachable cloud must be SILENT (exit 0, no output) ---
  const g4 = await runCli(['orient', '--from-hook'], { env: { SPARK_ROOM: 'X', SPARK_SUPABASE_URL: 'http://127.0.0.1:9', SPARK_SUPABASE_KEY: 'k' } });
  check('--from-hook + dead backend: silent exit 0', g4.code === 0 && g4.out.trim() === '', `code=${g4.code} out=${g4.out.slice(0, 60)}`);

  // --- 6c. --from-hook must NOT override an explicitly configured SPARK_API backend ---
  const apiCtx = Object.fromEntries(SECTIONS.map((s) => [s, { content: s === 'goal' ? 'API GOAL marker' : '', updated_at: null }]));
  const apiSrv = createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/join') return res.end(JSON.stringify({ ok: true }));
      if (req.url === '/context/get') return res.end(JSON.stringify({ context: apiCtx }));
      if (req.url === '/recent') return res.end(JSON.stringify({ activity: [] }));
      res.end(JSON.stringify({}));
    });
  });
  await new Promise<void>((r) => apiSrv.listen(8893, r));
  const g5 = await runCli(['orient', '--from-hook'], { env: { SPARK_ROOM: 'TEAM', SPARK_API: 'http://localhost:8893' } });
  apiSrv.close();
  check('--from-hook honors SPARK_API (no bundled-cloud hijack)', /API GOAL marker/.test(g5.out), g5.out.slice(0, 100));

  // --- 6d. summarize-hook must not eat markdown checkboxes (they are manual notes) ---
  const seedCb = new Store(DB);
  seedCb.updateContext('CBROOM', 'status', 'TODO before demo:\n- [ ] fix stripe webhook\n- [x] deploy preview', 'alice');
  seedCb.close();
  await runCli(['summarize-hook', '--db', DB, '--room', 'CBROOM', '--agent', 'bob', '--note', 'session one']);
  await runCli(['summarize-hook', '--db', DB, '--room', 'CBROOM', '--agent', 'bob', '--note', 'session two']);
  const cbStore = new Store(DB);
  const cbStatus = cbStore.getContext('CBROOM').status.content;
  cbStore.close();
  check('markdown checkboxes survive digests (not classified as digest lines)', cbStatus.includes('- [ ] fix stripe webhook') && cbStatus.includes('- [x] deploy preview'), cbStatus);
  check('checkbox heading stays attached to its list', cbStatus.indexOf('TODO before demo:') < cbStatus.indexOf('- [ ] fix stripe webhook'), cbStatus);
  check('digests still prepended above manual notes', cbStatus.split('\n')[0].includes('session two'), cbStatus.split('\n')[0]);

  // --- 6e. summarize-hook with nothing to say writes nothing (no digest-slot churn) ---
  const noop = await runCli(['summarize-hook', '--db', DB, '--room', 'CBROOM', '--agent', 'bob'], { stdin: JSON.stringify({ hook_event_name: 'SessionEnd' }) });
  const cbStore2 = new Store(DB);
  const cbStatus2 = cbStore2.getContext('CBROOM').status.content;
  cbStore2.close();
  check('empty-note session → no digest written', noop.code === 0 && cbStatus2 === cbStatus, cbStatus2.split('\n')[0]);

  // --- 6f. hooks.json + plugin.json structural contract ---
  const hooksPath = join(ROOT, 'hooks', 'hooks.json');
  const hooksJson = JSON.parse(readFileSync(hooksPath, 'utf8'));
  const events = Object.keys(hooksJson.hooks || {});
  check('hooks.json declares the 4 lifecycle events', ['SessionStart', 'SessionEnd', 'PreCompact', 'PostToolUseFailure'].every((e) => events.includes(e)), events.join(','));
  const cmds: string[] = Object.values(hooksJson.hooks).flat().flatMap((m: any) => (m.hooks || []).map((h: any) => h.command));
  check('every hook command: plugin-root + --from-hook + error-silenced', cmds.length === 4 && cmds.every((c) => c.includes('${CLAUDE_PLUGIN_ROOT}') && c.includes('--from-hook') && c.includes('|| true')), cmds.join(' | '));
  check('hook commands reference real CLI subcommands', cmds.every((c) => /cli\/spark\.ts" (orient|summarize-hook|posttooluse-hook) /.test(c)));
  check('failure event wired to posttooluse-hook with Bash matcher', hooksJson.hooks.PostToolUseFailure?.[0]?.matcher === 'Bash' && /posttooluse-hook/.test(hooksJson.hooks.PostToolUseFailure?.[0]?.hooks?.[0]?.command || ''));
  const plugin = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  check('plugin.json hooks ref resolves to hooks/hooks.json', plugin.hooks === './hooks/hooks.json' && existsSync(hooksPath));
  check('plugin.json bundles the env pair pluginEnv() reads', !!plugin.mcpServers?.spark?.env?.SPARK_SUPABASE_URL && !!plugin.mcpServers?.spark?.env?.SPARK_SUPABASE_KEY);

  // --- 7. search_solutions tolerates non-array tags (string + junk) ---
  const local = new Store(DB);
  const searchTool = TOOLS.find((t) => t.name === 'search_solutions')!;
  const t1 = await searchTool.handler(local, 'FULLROOM', { query: 'vite env vars undefined', tags: 'vite' }, 'tester');
  check('tags as string → treated as filter, no throw', /VITE_/.test(String(t1)), String(t1).slice(0, 80));
  const t2 = await searchTool.handler(local, 'FULLROOM', { query: 'vite env vars undefined', tags: 42 }, 'tester');
  check('tags as number → ignored, no throw', /VITE_|No strong match/.test(String(t2)));

  // --- 8. get_context flags a fully empty room ---
  const getCtxTool = TOOLS.find((t) => t.name === 'get_context')!;
  const c1 = await getCtxTool.handler(local, 'EMPTYROOM3', {}, 'tester');
  check('get_context warns when room has no context and no cards', /EMPTY/.test(String(c1)) && /mistyped|typo/i.test(String(c1)), String(c1).slice(-120));
  const c2 = await getCtxTool.handler(local, 'FULLROOM', {}, 'tester');
  check('get_context does not warn on a populated room', !/mistyped/.test(String(c2)));
  local.close();
} catch (e: any) {
  check(`no exceptions (${e?.message})`, false);
} finally {
  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}
