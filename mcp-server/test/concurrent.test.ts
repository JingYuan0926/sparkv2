// Proves the "two teammates, one shared brain" claim: many CLI processes write
// to the same DB concurrently (WAL), and a reader sees all of them.
// Run: node mcp-server/test/concurrent.test.ts
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Store } from '../src/store.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..');
const CLI = join(ROOT, 'cli', 'spark.ts');
const DB = '/tmp/spark-concurrent.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
  try { rmSync(f); } catch {}
}

let passed = 0, failed = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { passed++; console.log(`  ok  - ${name}`); }
  else { failed++; console.log(`FAIL  - ${name} ${extra}`); }
}

const AGENTS = ['alice', 'bob', 'carol'];
const N = 15;

function recordProc(i: number): Promise<number> {
  const agent = AGENTS[i % AGENTS.length];
  return new Promise((resolve) => {
    const c = spawn(
      'node',
      [
        CLI, 'record', '--db', DB, '--room', 'CONC', '--agent', agent,
        '--problem', `concurrent widget bug number ${i} from ${agent}`,
        '--solution', `apply fix variant ${i}`,
        '--tags', `widget,t${i % 4}`,
      ],
      { stdio: 'ignore' },
    );
    c.on('exit', (code) => resolve(code ?? 1));
  });
}

// Fire all writers at once — real concurrent multi-process writes.
const codes = await Promise.all(Array.from({ length: N }, (_, i) => recordProc(i)));
check('all concurrent writers exited 0', codes.every((c) => c === 0), `codes=${codes.join(',')}`);

// A separate reader process/connection sees every write.
const reader = new Store(DB);
const found = reader.searchSolutions('CONC', 'concurrent widget bug', undefined, 100);
check(`reader sees all ${N} concurrent writes`, found.length === N, `got ${found.length}`);

// Authorship preserved across processes.
const authors = new Set(found.map((c) => c.author));
check('all 3 agents represented', AGENTS.every((a) => authors.has(a)), [...authors].join(','));

// Tag filter still works on the merged data.
const t0 = reader.searchSolutions('CONC', 'widget', ['t0'], 100);
check('tag filter on concurrent data', t0.length > 0 && t0.every((c) => c.tags.includes('t0')));

reader.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
