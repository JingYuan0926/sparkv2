// LIVE verification against a REAL Supabase project (not a mock).
// Run after filling .env and running supabase/schema.sql:
//   node --env-file=.env mcp-server/test/live-supabase.ts
// Does a full roundtrip in a throwaway room and cleans up its cards.
import { SupabaseStore } from '../src/supabase.ts';

const url = process.env.SPARK_SUPABASE_URL;
const key = process.env.SPARK_SUPABASE_KEY;
if (!url || !key || url.includes('<') ) {
  console.error('✗ Set SPARK_SUPABASE_URL and SPARK_SUPABASE_KEY first.');
  console.error('  Fill them in .env, then run:  node --env-file=.env mcp-server/test/live-supabase.ts');
  process.exit(2);
}

let passed = 0, failed = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { passed++; console.log(`  ok  - ${name}`); }
  else { failed++; console.log(`FAIL  - ${name} ${extra}`); }
}

const ROOM = 'SPARK-LIVECHECK';
const store = new SupabaseStore(url, key, ROOM); // token = room code (join-by-code)
let recId = 0;

try {
  console.log(`Connecting to ${url} (room ${ROOM})…`);
  await store.join(ROOM);
  check('join (creates/validates room over real Supabase)', true);

  const rec = await store.recordSolution(ROOM, {
    problem: 'live-check: dev server fails with EADDRINUSE, port 3000 already in use',
    solution: 'find and kill the stale process: lsof -ti:3000 | xargs kill -9, or use PORT=3001',
    tags: ['livecheck', 'ports'],
    author: 'verify',
  });
  recId = rec.id;
  check('record_solution writes to Postgres', rec.id > 0 && rec.status === 'unverified', JSON.stringify(rec).slice(0, 80));

  const found = await store.searchSolutions(ROOM, 'EADDRINUSE port already in use', undefined, 5);
  check('search finds it with relevance', found.some((c) => c.id === recId && c.relevance != null), JSON.stringify(found.map((c) => [c.id, c.relevance])));

  const irrelevant = await store.searchSolutions(ROOM, 'kubernetes helm chart rollback', undefined, 5);
  check('irrelevant query → no false positives', !irrelevant.some((c) => c.id === recId));

  const conf = await store.confirmSolution(ROOM, recId);
  check('confirm → verified + helped', conf?.status === 'verified' && (conf?.helped ?? 0) >= 1);

  const upd = await store.updateSolution(ROOM, recId, { solution: 'CORRECTED live: kill -9 the PID bound to the port' });
  check('update edits in place', !!upd?.solution.includes('CORRECTED live'));

  await store.updateContext(ROOM, 'goal', 'live check at ' + new Date().toISOString(), 'verify');
  const ctx = await store.getContext(ROOM);
  check('context set/get over Supabase', /live check at/.test(ctx.goal.content));

  const recent = await store.listRecent(ROOM, 10);
  check('recent feed works', recent.length > 0);

  let rejected = false;
  try { await new SupabaseStore(url, key, 'DEFINITELY-WRONG-TOKEN').join(ROOM); } catch { rejected = true; }
  check('wrong room token rejected by RLS/functions', rejected);
} catch (e: any) {
  check(`no exceptions (${e?.message})`, false);
} finally {
  // cleanup: remove the test card so the live room stays clean
  try { if (recId) await store.deleteSolution(ROOM, recId); } catch {}
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed === 0) console.log('✅ Spark ↔ Supabase is live and working. Teammates can join now.');
  process.exitCode = failed === 0 ? 0 : 1;
}
