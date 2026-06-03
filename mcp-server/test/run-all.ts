// Paced test runner — runs each suite to completion (with a small gap so spawned
// child processes from the prior suite fully release CPU/handles), aggregates results.
// Run: node mcp-server/test/run-all.ts
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const SUITES = ['store', 'mcp-smoke', 'hooks', 'concurrent', 'remote', 'v4', 'fixes', 'supabase'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(suite: string): Promise<{ code: number; summary: string }> {
  return new Promise((resolve) => {
    const c = spawn('node', [join(__dir, `${suite}.test.ts`)], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('exit', (code) => {
      const summary = (out.match(/\d+ passed, \d+ failed/g) || ['(no summary)']).pop()!;
      resolve({ code: code ?? 1, summary });
    });
  });
}

let pass = 0, fail = 0, suitesFailed = 0;
for (const s of SUITES) {
  const { code, summary } = await run(s);
  const p = Number((summary.match(/(\d+) passed/) || [])[1] || 0);
  const f = Number((summary.match(/(\d+) failed/) || [])[1] || 0);
  pass += p; fail += f;
  const ok = code === 0 && f === 0;
  if (!ok) suitesFailed++;
  console.log(`  ${ok ? '✓' : '✗'} ${s.padEnd(12)} ${summary}`);
  await sleep(400); // let the prior suite's child processes fully exit
}
console.log('  ' + '-'.repeat(36));
console.log(`  ${suitesFailed === 0 ? '✓ ALL GREEN' : `✗ ${suitesFailed} suite(s) failed`} — ${pass} passed, ${fail} failed`);
process.exitCode = suitesFailed === 0 ? 0 : 1;
