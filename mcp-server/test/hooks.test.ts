// v2 continuity hooks: summarize-hook (Stop) writes a digest to Status;
// orient (SessionStart) prints the room context. Run: node mcp-server/test/hooks.test.ts
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Store } from '../src/store.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..');
const CLI = join(ROOT, 'cli', 'spark.ts');
const DB = '/tmp/spark-hooks.db';
const TRANSCRIPT = '/tmp/spark-hooks-transcript.jsonl';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
  try { rmSync(f); } catch {}
}

let passed = 0, failed = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { passed++; console.log(`  ok  - ${name}`); }
  else { failed++; console.log(`FAIL  - ${name} ${extra}`); }
}

function runCli(args: string[], stdin = ''): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const c = spawn('node', [CLI, ...args], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('exit', (code) => resolve({ code: code ?? 1, out }));
    if (stdin) c.stdin.write(stdin);
    c.stdin.end();
  });
}

// Seed the room.
const ROOM = 'HOOKS';
const seed = new Store(DB);
seed.updateContext(ROOM, 'goal', 'Build a URL shortener with analytics', 'alice');
seed.recordSolution(ROOM, { problem: 'redirect 404 on dynamic route', solution: 'add catch-all [...slug] route', tags: ['next'] });
seed.close();

// Fake a Claude Code transcript whose last user message is the "what was happening".
writeFileSync(
  TRANSCRIPT,
  [
    JSON.stringify({ role: 'user', content: 'set up the database schema' }),
    JSON.stringify({ role: 'assistant', content: 'done' }),
    JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'now wire up the redirect handler and test it' }] }),
  ].join('\n'),
);

// 1. Stop hook → digest into Status (payload piped on stdin, like a real hook).
const stopPayload = JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', transcript_path: TRANSCRIPT });
const r1 = await runCli(['summarize-hook', '--db', DB, '--room', ROOM, '--agent', 'alice'], stopPayload);
check('summarize-hook exits 0', r1.code === 0, r1.out);

const afterCtx = new Store(DB);
const status1 = afterCtx.getContext(ROOM).status.content;
check('digest captured last user message', status1.includes('redirect handler'), status1);
check('digest attributed to agent', status1.includes('alice'), status1);

// 2. Second close prepends + keeps order (newest first).
await runCli(['summarize-hook', '--db', DB, '--room', ROOM, '--agent', 'bob', '--note', 'finished analytics dashboard'], '');
const status2 = afterCtx.getContext(ROOM).status.content;
const lines = status2.split('\n');
check('newest digest first', lines[0].includes('analytics dashboard'), lines[0]);
check('older digest retained', status2.includes('redirect handler'));
afterCtx.close();

// 3. orient (SessionStart) prints goal + recent + the status digests.
const r3 = await runCli(['orient', '--db', DB, '--room', ROOM, '--agent', 'carol']);
check('orient exits 0', r3.code === 0);
check('orient shows goal', r3.out.includes('URL shortener'), r3.out.slice(0, 80));
check('orient shows status digest', r3.out.includes('analytics dashboard'));
check('orient identifies the agent', r3.out.includes('carol'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
