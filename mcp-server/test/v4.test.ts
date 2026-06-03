// v4: semantic fallback finds paraphrased problems keyword misses; dashboard serves.
// Run: node mcp-server/test/v4.test.ts
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Store } from '../src/store.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..');
const SERVER = join(ROOT, 'server', 'src', 'server.ts');
const DB = '/tmp/spark-v4.db';
const SRVDB = '/tmp/spark-v4-server.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`, SRVDB, `${SRVDB}-wal`, `${SRVDB}-shm`]) {
  try { rmSync(f); } catch {}
}

let passed = 0, failed = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { passed++; console.log(`  ok  - ${name}`); }
  else { failed++; console.log(`FAIL  - ${name} ${extra}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Part A: semantic fallback ----
const ROOM = 'V4';
const s = new Store(DB);
const vite = s.recordSolution(ROOM, {
  problem: 'vite env vars undefined in build',
  solution: 'prefix client vars with VITE_ and read import.meta.env',
  tags: ['vite', 'env'],
});
s.recordSolution(ROOM, { problem: 'tailwind classes not applying', solution: 'add the content globs to tailwind.config', tags: ['css'] });
s.recordSolution(ROOM, { problem: 'jest cannot parse esm import', solution: 'set transform with babel-jest', tags: ['jest'] });

// A paraphrase sharing almost no exact words with the vite card:
const para = 'environment variables come out empty when compiling the app';
const kw = s.searchSolutions(ROOM, para, undefined, 5);
const smart = s.searchSmart(ROOM, para, undefined, 5);
check('keyword alone misses the paraphrase', !kw.some((c) => c.id === vite.id), `kw got ${kw.map((c) => c.id)}`);
check('semantic fallback finds the paraphrase', smart.some((c) => c.id === vite.id), `smart got ${smart.map((c) => c.id)}`);

// Exact keyword still works and stays first (superset behavior).
const exact = s.searchSmart(ROOM, 'vite env vars undefined build', undefined, 5);
check('exact keyword still ranks first', exact[0]?.id === vite.id, `got ${exact[0]?.id}`);
s.close();

// ---- Part B: dashboard serves ----
const PORT = 8800;
const API = `http://localhost:${PORT}`;
const srv = spawn('node', [SERVER], {
  env: { ...process.env, SPARK_PORT: String(PORT), SPARK_DB: SRVDB },
  stdio: ['ignore', 'ignore', 'ignore'],
});
try {
  let up = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${API}/health`); if (r.ok) { up = true; break; } } catch {}
    await sleep(100);
  }
  check('server up', up);
  const page = await fetch(`${API}/`);
  const html = await page.text();
  check('GET / serves the dashboard', page.status === 200 && /Spark/.test(html) && /id="cards"/.test(html));
  check('dashboard is html', (page.headers.get('content-type') || '').includes('text/html'));
} catch (e: any) {
  check(`no exceptions (${e?.message})`, false);
} finally {
  srv.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1; // let Node drain stdout, then exit naturally

}
