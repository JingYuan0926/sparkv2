// v3 cloud path: HTTP API server + RemoteStore clients (simulated remote teammates),
// token auth, room isolation, and full agent->MCP->HTTP->server chain.
// Run: node mcp-server/test/remote.test.ts
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RemoteStore } from '../src/remote.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..', '..');
const SERVER = join(ROOT, 'server', 'src', 'server.ts');
const MCP = join(ROOT, 'mcp-server', 'src', 'index.ts');
const PORT = 8799;
const API = `http://localhost:${PORT}`;
const DB = '/tmp/spark-remote-server.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
  try { rmSync(f); } catch {}
}

let passed = 0, failed = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { passed++; console.log(`  ok  - ${name}`); }
  else { failed++; console.log(`FAIL  - ${name} ${extra}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const srv = spawn('node', [SERVER], {
  env: { ...process.env, SPARK_PORT: String(PORT), SPARK_DB: DB },
  stdio: ['ignore', 'ignore', 'ignore'],
});

async function waitHealth(): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${API}/health`); if (r.ok) return true; } catch {}
    await sleep(100);
  }
  return false;
}

try {
  check('server starts + /health', await waitHealth());

  // Two "remote teammates" on the same room, joining by code (token = room code).
  const alice = new RemoteStore(API, 'CLOUD');
  const bob = new RemoteStore(API, 'CLOUD');
  await alice.join('CLOUD');
  await bob.join('CLOUD');

  const rec = await alice.recordSolution('CLOUD', {
    problem: 'supabase RLS blocks inserts from edge function',
    solution: 'use the service-role key in the edge function, not the anon key',
    tags: ['supabase', 'rls'],
    author: 'alice',
  });
  check('alice records over HTTP', rec.id > 0);

  const found = await bob.searchSolutions('CLOUD', 'supabase insert blocked rls edge', undefined, 5);
  check('bob (other machine) sees alice card', found.some((c) => /service-role key/.test(c.solution)), JSON.stringify(found.map((c) => c.id)));
  check('card attributed to alice', found[0]?.author === 'alice');

  const conf = await bob.confirmSolution('CLOUD', rec.id);
  check('bob confirms over HTTP', conf?.status === 'verified' && conf?.helped === 1);

  await alice.updateContext('CLOUD', 'goal', 'ETHGlobal: cross-chain payments app', 'alice');
  const ctx = await bob.getContext('CLOUD');
  check('context shared over HTTP', /cross-chain payments/.test(ctx.goal.content));

  // Wrong token rejected.
  let rejected = false;
  try { await new RemoteStore(API, 'WRONG-TOKEN').join('CLOUD'); } catch { rejected = true; }
  check('wrong room token rejected', rejected);

  // Room isolation: a different room cannot see CLOUD's cards.
  const other = new RemoteStore(API, 'CLOUD2');
  await other.join('CLOUD2');
  await other.recordSolution('CLOUD2', { problem: 'other room secret', solution: 'nope', tags: ['x'] });
  const leak = await bob.searchSolutions('CLOUD', 'other room secret', undefined, 5);
  check('room isolation across HTTP', !leak.some((c) => c.problem === 'other room secret'));

  // Full chain: spawn the MCP server in REMOTE mode and call a tool over stdio.
  const mcp = spawn('node', [MCP], {
    env: { ...process.env, SPARK_API: API, SPARK_ROOM: 'CLOUD', SPARK_TOKEN: 'CLOUD', SPARK_AGENT: 'carol' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map<number, (m: any) => void>();
  let nextId = 1;
  createInterface({ input: mcp.stdout }).on('line', (line) => {
    line = line.trim(); if (!line) return;
    let m: any; try { m = JSON.parse(line); } catch { return; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
  });
  function rpc(method: string, params?: any): Promise<any> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 20000);
      pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  const search = await rpc('tools/call', { name: 'search_solutions', arguments: { query: 'supabase rls edge function insert' } });
  const text = search?.result?.content?.[0]?.text || '';
  check('agent->MCP->HTTP->server chain works', /service-role key/.test(text), text.slice(0, 80));
  mcp.kill();
} catch (e: any) {
  check(`no exceptions (${e?.message})`, false);
} finally {
  srv.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1; // let Node drain stdout, then exit naturally

}
