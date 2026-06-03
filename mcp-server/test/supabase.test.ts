// Verifies the SupabaseStore adapter end-to-end against a MOCK PostgREST server that mirrors
// the RPC functions in supabase/schema.sql (token check + table ops). This proves the adapter's
// request/response/parsing contract; the real Postgres SQL is validated when you run schema.sql
// in your Supabase project. Run: node mcp-server/test/supabase.test.ts
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { Store } from '../src/store.ts';
import { SupabaseStore } from '../src/supabase.ts';

const DB = '/tmp/spark-supabase-mock.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
  try { rmSync(f); } catch {}
}

let passed = 0, failed = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { passed++; console.log(`  ok  - ${name}`); }
  else { failed++; console.log(`FAIL  - ${name} ${extra}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- mock PostgREST backed by a real Store (mirrors schema.sql RPC semantics) ----
const store = new Store(DB);
const solToRow = (s: any) => ({ id: s.id, problem: s.problem, solution: s.solution, context: s.context, tags: s.tags.join(','), status: s.status, helped: s.helped, author: s.author, created_at: s.created_at, updated_at: s.updated_at });

const PORT = 8866;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const fn = ((req.url || '').match(/\/rest\/v1\/rpc\/(\w+)/) || [])[1];
    let a: any = {};
    try { a = JSON.parse(body || '{}'); } catch {}
    const send = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      if (fn === 'spark_join') return send(200, store.ensureRoomToken(a.p_room, a.p_token) === a.p_token);
      if (!store.checkRoomToken(a.p_room, a.p_token)) return send(400, { message: 'invalid room token' });
      switch (fn) {
        case 'spark_cards':
          return send(200, store.searchSolutions(a.p_room, '', undefined, 10000).map(solToRow));
        case 'spark_record':
          return send(200, solToRow(store.recordSolution(a.p_room, { problem: a.p_problem, solution: a.p_solution, context: a.p_context || undefined, tags: (a.p_tags || '').split(',').filter(Boolean), author: a.p_author })));
        case 'spark_confirm': {
          const c = store.confirmSolution(a.p_room, a.p_id);
          return send(200, c ? solToRow(c) : null);
        }
        case 'spark_update': {
          const c = store.updateSolution(a.p_room, a.p_id, { problem: a.p_problem || undefined, solution: a.p_solution || undefined, context: a.p_context === null ? undefined : a.p_context, tags: a.p_tags != null ? a.p_tags.split(',').filter(Boolean) : undefined });
          return send(200, c ? solToRow(c) : null);
        }
        case 'spark_delete':
          return send(200, store.deleteSolution(a.p_room, a.p_id));
        case 'spark_get_context': {
          const ctx = store.getContext(a.p_room);
          return send(200, Object.entries(ctx).filter(([, v]) => v.updated_at).map(([section, v]) => ({ room_id: a.p_room, section, content: v.content, updated_at: v.updated_at, updated_by: null })));
        }
        case 'spark_set_context': {
          const r = store.updateContext(a.p_room, a.p_section, a.p_content, a.p_by);
          return send(200, { room_id: a.p_room, section: r.section, content: a.p_content, updated_at: r.updated_at, updated_by: a.p_by });
        }
        default:
          return send(404, { message: `unknown fn ${fn}` });
      }
    } catch (e: any) {
      return send(400, { message: e?.message || String(e) });
    }
  });
});

const API = `http://localhost:${PORT}`;
await new Promise<void>((r) => server.listen(PORT, () => r()));

try {
  const alice = new SupabaseStore(API, 'anon-key', 'CLOUD');
  const bob = new SupabaseStore(API, 'anon-key', 'CLOUD');
  await alice.join('CLOUD');
  await bob.join('CLOUD');
  check('join works', true);

  const rec = await alice.recordSolution('CLOUD', { problem: 'supabase RLS blocks inserts from edge function', solution: 'use the service-role key in the edge function not anon', tags: ['supabase', 'rls'], author: 'alice' });
  check('record over supabase RPC', rec.id > 0 && rec.status === 'unverified');

  const found = await bob.searchSolutions('CLOUD', 'supabase insert blocked rls edge function', undefined, 5);
  check('search ranks + finds card (relevance)', found[0]?.id === rec.id && found[0]?.relevance != null, JSON.stringify(found.map((c) => [c.id, c.relevance])));

  const irrelevant = await bob.searchSolutions('CLOUD', 'docker compose postgres connection refused', undefined, 5);
  check('irrelevant query → empty (threshold holds over RPC)', irrelevant.length === 0, `got ${irrelevant.length}`);

  const conf = await bob.confirmSolution('CLOUD', rec.id);
  check('confirm over RPC', conf?.status === 'verified' && conf?.helped === 1);

  const upd = await alice.updateSolution('CLOUD', rec.id, { solution: 'CORRECTED: service-role key only, never expose it client-side' });
  check('update over RPC', !!upd?.solution.includes('CORRECTED'));

  await alice.updateContext('CLOUD', 'goal', 'ETHGlobal cross-chain payments', 'alice');
  const ctx = await bob.getContext('CLOUD');
  check('context shared over RPC', /cross-chain payments/.test(ctx.goal.content));

  const recent = await bob.listRecent('CLOUD', 10);
  check('recent feed over RPC', recent.length > 0);

  const delId = (await alice.recordSolution('CLOUD', { problem: 'junk dup', solution: 'junk', tags: ['x'] })).id;
  check('delete over RPC', (await alice.deleteSolution('CLOUD', delId)) === true);
  check('deleted card gone', (await bob.getSolution('CLOUD', delId)) === null);

  // wrong token rejected
  let rejected = false;
  try { await new SupabaseStore(API, 'anon-key', 'WRONG').join('CLOUD'); } catch { rejected = true; }
  check('wrong room token rejected', rejected);

  // room isolation
  const other = new SupabaseStore(API, 'anon-key', 'CLOUD2');
  await other.join('CLOUD2');
  await other.recordSolution('CLOUD2', { problem: 'other room only', solution: 'x', tags: ['x'] });
  const leak = await bob.searchSolutions('CLOUD', 'other room only', undefined, 5);
  check('room isolation over RPC', !leak.some((c) => c.problem === 'other room only'));
} catch (e: any) {
  check(`no exceptions (${e?.message})`, false);
} finally {
  server.close();
  store.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}
