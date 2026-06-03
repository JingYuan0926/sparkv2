// Fixes from the hackathon simulation: relevance threshold (no false positives),
// shell-safe file input (no silent corruption), update/delete/get. Run: node .../fixes.test.ts
import { Store } from '../src/store.ts';
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..');
const CLI = join(ROOT, 'cli', 'spark.ts');
const DB = '/tmp/spark-fixes.db';
const SOLFILE = '/tmp/spark-fix-sol.txt';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
  try { rmSync(f); } catch {}
}

let passed = 0, failed = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { passed++; console.log(`  ok  - ${name}`); }
  else { failed++; console.log(`FAIL  - ${name} ${extra}`); }
}
function runCli(args: string[]): Promise<{ code: number; o: string }> {
  return new Promise((res) => {
    const c = spawn('node', [CLI, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    let o = '';
    c.stdout.on('data', (d) => (o += d));
    c.on('exit', (code) => res({ code: code ?? 1, o }));
  });
}

const ROOM = 'FIX';
const s = new Store(DB);
const cors = s.recordSolution(ROOM, { problem: 'browser blocks API calls with CORS, no access-control-allow-origin header', solution: 'add cors middleware with an origin allowlist, or proxy via next rewrites', tags: ['cors', 'api'] });
s.recordSolution(ROOM, { problem: 'wagmi connector not found in app router', solution: 'wrap app in a client WagmiProvider providers component', tags: ['wagmi'] });
s.recordSolution(ROOM, { problem: 'wallet disconnects on refresh', solution: 'cookieStorage + reconnect on mount', tags: ['wagmi', 'ssr'] });

// --- relevance threshold: irrelevant query returns NOTHING (the sim's #1 complaint) ---
const irrelevant = s.searchSmart(ROOM, 'kubernetes pod crashloopbackoff helm chart rollout', undefined, 5);
check('irrelevant query → no false positives', irrelevant.length === 0, `got ${irrelevant.length}`);

// Regression: one incidental shared word ("wallet") must NOT cross the threshold
// (this is the FTS-bonus inflation bug the simulation surfaced).
const incidental = s.searchSmart(ROOM, 'leather wallet purchase refund policy', undefined, 5);
check('one incidental shared word → still no match', incidental.length === 0, `got ${incidental.map((c) => c.id)}`);

const rel = s.searchSmart(ROOM, 'fetch blocked by cors missing allow-origin header', undefined, 5);
check('relevant query → correct card first', rel[0]?.id === cors.id, `got ${rel.map((c) => c.id)}`);
check('result carries 0..1 relevance', rel[0]?.relevance != null && rel[0].relevance > 0 && rel[0].relevance <= 1, `${rel[0]?.relevance}`);
check('only relevant cards returned (not the whole room)', rel.length < 3, `got ${rel.length}`);

// --- update fixes a card in place (vs duplicating) ---
const upd = s.updateSolution(ROOM, cors.id, { solution: 'CORRECTED: app.use(cors({ origin: "http://localhost:3000" }))' });
check('update changes the solution', !!upd?.solution.includes('CORRECTED'));
check('update keeps the same id', upd?.id === cors.id);
check('updated card still searchable', s.searchSmart(ROOM, 'cors allow origin header', undefined, 5).some((c) => c.id === cors.id));

// --- delete retires a duplicate/wrong card ---
const dupId = s.recordSolution(ROOM, { problem: 'duplicate junk card about cors', solution: 'junk', tags: ['cors'] }).id;
check('delete returns true', s.deleteSolution(ROOM, dupId) === true);
check('deleted card gone from store', s.getSolution(ROOM, dupId) === null);
check('deleted card gone from search', !s.searchSmart(ROOM, 'duplicate junk cors', undefined, 5).some((c) => c.id === dupId));
s.close();

// --- shell-safe file input: tricky content survives intact (Dave's silent-corruption bug) ---
const TRICKY = [
  'Gate render until mounted:',
  'const [mounted,setMounted]=useState(false);',
  'useEffect(()=>setMounted(true),[]);',
  'if (!mounted) return null; // `backticks` and $(cmd) and !bang stay intact',
].join('\n');
writeFileSync(SOLFILE, TRICKY);
const recRes = await runCli(['record', '--db', DB, '--room', ROOM, '--agent', 'dave', '--problem', 'hydration mismatch on wallet address', '--solution-file', SOLFILE, '--tags', 'hydration', '--json']);
const recCard = JSON.parse(recRes.o || '{}');
check('file record preserves the !mounted fix line', String(recCard.solution).includes('if (!mounted) return null'), String(recCard.solution).slice(0, 40));
check('file record preserves backticks + $()', String(recCard.solution).includes('`backticks`') && String(recCard.solution).includes('$(cmd)'));

const getRes = await runCli(['get', String(recCard.id), '--db', DB, '--room', ROOM]);
check('get <id> prints the full card', getRes.o.includes('if (!mounted) return null'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
