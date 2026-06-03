// Direct unit tests for the Store. Run: node mcp-server/test/store.test.ts
import { Store } from '../src/store.ts';
import { rmSync } from 'node:fs';

const DB = '/tmp/spark-test-store.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
  try { rmSync(f); } catch {}
}

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { passed++; console.log(`  ok  - ${name}`); }
  else { failed++; console.log(`FAIL  - ${name} ${extra}`); }
}

const ROOM = 'SPARK-TEST';
const s = new Store(DB);

// record
const c1 = s.recordSolution(ROOM, {
  problem: "Next.js build fails: Module not found 'fs'",
  solution: "Don't import 'fs' in client components; move to a server action or API route.",
  tags: ['nextjs', 'webpack', 'build'],
  author: 'agent-A',
});
check('record returns id', c1.id > 0);
check('record defaults unverified', c1.status === 'unverified');
check('record helped 0', c1.helped === 0);
check('tags parsed', c1.tags.join(',') === 'nextjs,webpack,build');

s.recordSolution(ROOM, {
  problem: 'TypeScript: Cannot find module when importing .ts with node',
  solution: 'Use Node 22+ which strips types, or add proper tsconfig paths.',
  tags: ['typescript', 'node'],
  author: 'agent-A',
});

// search finds the relevant card
const r1 = s.searchSolutions(ROOM, "module not found fs in next build", undefined, 5);
check('search returns results', r1.length > 0);
check('search top is the fs card', r1[0]?.id === c1.id, `got #${r1[0]?.id}`);

// tag filter
const r2 = s.searchSolutions(ROOM, 'module', ['typescript'], 5);
check('tag filter narrows', r2.every((c) => c.tags.includes('typescript')));

// room isolation
s.recordSolution('OTHER-ROOM', { problem: 'secret thing', solution: 'secret fix', tags: ['x'] });
const r3 = s.searchSolutions(ROOM, 'secret thing', undefined, 5);
check('room isolation: no cross-room leak', r3.every((c) => c.problem !== 'secret thing'));

// confirm boosts ranking
const before = s.searchSolutions(ROOM, 'typescript module node', undefined, 5);
const tsCard = before.find((c) => c.tags.includes('typescript'))!;
s.confirmSolution(ROOM, tsCard.id);
const after = s.getSolution(ROOM, tsCard.id)!;
check('confirm -> verified', after.status === 'verified');
check('confirm -> helped++', after.helped === 1);

// context round-trip
s.updateContext(ROOM, 'goal', 'Build a URL shortener for the hackathon.', 'agent-A');
s.updateContext(ROOM, 'status', 'Auth done; working on the redirect handler.', 'agent-B');
const ctx = s.getContext(ROOM);
check('context goal saved', ctx.goal.content.includes('URL shortener'));
check('context status saved', ctx.status.content.includes('redirect handler'));
check('context empty section ok', ctx.map.content === '');

// bad section rejected
let threw = false;
try { s.updateContext(ROOM, 'nonsense', 'x'); } catch { threw = true; }
check('bad section rejected', threw);

// recent
const recent = s.listRecent(ROOM, 10);
check('recent has entries', recent.length > 0);
check('recent newest first', recent.length < 2 || recent[0].at >= recent[1].at);

// empty record rejected
let threw2 = false;
try { s.recordSolution(ROOM, { problem: '', solution: 'x' }); } catch { threw2 = true; }
check('empty problem rejected', threw2);

s.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
