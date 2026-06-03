// Spawns the real MCP server and speaks JSON-RPC over stdio — proves the
// actual MCP tool surface, not just the store. Run: node mcp-server/test/mcp-smoke.ts
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, '..', 'src', 'index.ts');
const DB = '/tmp/spark-mcp-smoke.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
  try { rmSync(f); } catch {}
}

let passed = 0, failed = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { passed++; console.log(`  ok  - ${name}`); }
  else { failed++; console.log(`FAIL  - ${name} ${extra}`); }
}

const child = spawn('node', [SERVER], {
  env: { ...process.env, SPARK_DB: DB, SPARK_ROOM: 'SMOKE', SPARK_AGENT: 'smoke-agent' },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const pending = new Map<number, (msg: any) => void>();
let nextId = 1;
createInterface({ input: child.stdout }).on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg: any;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  }
});

function rpc(method: string, params?: any): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 20000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method: string, params?: any) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}
function textOf(res: any): string {
  return res?.result?.content?.[0]?.text || '';
}

try {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  check('initialize returns serverInfo', init.result?.serverInfo?.name === 'spark', JSON.stringify(init.result));
  notify('notifications/initialized');

  const list = await rpc('tools/list');
  const names = (list.result?.tools || []).map((t: any) => t.name).sort();
  check('tools/list has 8 tools', names.length === 8, names.join(','));
  check('tools/list includes search+record+update+delete', ['search_solutions', 'record_solution', 'update_solution', 'delete_solution'].every((n) => names.includes(n)));

  const rec = await rpc('tools/call', {
    name: 'record_solution',
    arguments: { problem: 'Vercel deploy fails: function exceeds 50mb', solution: 'Externalize big deps / use includeFiles config to trim bundle', tags: ['vercel', 'deploy'] },
  });
  check('record_solution works', /Recorded solution #\d+/.test(textOf(rec)), textOf(rec));

  const search = await rpc('tools/call', { name: 'search_solutions', arguments: { query: 'vercel function too large deploy fail' } });
  check('search finds the recorded card', /exceeds 50mb/i.test(textOf(search)), textOf(search).slice(0, 80));

  const confirm = await rpc('tools/call', { name: 'confirm_solution', arguments: { id: 1 } });
  check('confirm_solution works', /verified/.test(textOf(confirm)), textOf(confirm));

  await rpc('tools/call', { name: 'update_context', arguments: { section: 'goal', content: 'Ship a Farcaster mini-app' } });
  const ctx = await rpc('tools/call', { name: 'get_context', arguments: {} });
  check('context round-trips over MCP', /Farcaster mini-app/.test(textOf(ctx)), textOf(ctx).slice(0, 60));

  const recent = await rpc('tools/call', { name: 'list_recent', arguments: {} });
  check('list_recent works', textOf(recent).length > 0);

  const bad = await rpc('tools/call', { name: 'nope', arguments: {} });
  check('unknown tool -> JSON-RPC error', !!bad.error, JSON.stringify(bad));

  const ping = await rpc('ping');
  check('ping works', ping.result !== undefined);
} catch (e: any) {
  check(`no exceptions (${e?.message})`, false);
} finally {
  child.stdin.end();
  child.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1; // let Node drain stdout, then exit naturally

}
