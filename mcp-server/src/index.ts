// Spark MCP server — hand-rolled JSON-RPC 2.0 over stdio (newline-delimited),
// compatible with the MCP stdio transport. Zero external dependencies.
import { createInterface } from 'node:readline';
import { Store } from './store.ts';
import { RemoteStore } from './remote.ts';
import { SupabaseStore } from './supabase.ts';
import { resolveConfig } from './config.ts';
import { TOOLS } from './tools.ts';

const cfg = resolveConfig();
let store: any;
if (cfg.supabaseUrl && cfg.supabaseKey) {
  store = new SupabaseStore(cfg.supabaseUrl, cfg.supabaseKey, cfg.token);
  try {
    await store.join(cfg.room);
  } catch (e: any) {
    process.stderr.write(`spark: Supabase join failed: ${e?.message || e}\n`);
  }
} else if (cfg.api) {
  store = new RemoteStore(cfg.api, cfg.token);
  try {
    await store.join(cfg.room);
  } catch (e: any) {
    process.stderr.write(`spark: join ${cfg.api} failed: ${e?.message || e}\n`);
  }
} else {
  store = new Store(cfg.dbPath);
}

const SERVER_INFO = { name: 'spark', version: '0.1.0' };

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function reply(id: unknown, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}
function fail(id: unknown, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore non-JSON lines
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
      return;
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // notifications: no response
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
      return;
    case 'tools/call': {
      const t = TOOLS.find((x) => x.name === params?.name);
      if (!t) {
        fail(id, -32602, `Unknown tool: ${params?.name}`);
        return;
      }
      // Handlers may be sync (local) or async (remote) — normalize with Promise.resolve.
      Promise.resolve(t.handler(store, cfg.room, params?.arguments || {}, cfg.agent))
        .then((text) => reply(id, { content: [{ type: 'text', text }] }))
        // Tool-level errors go back as result so the model can read & react.
        .catch((e: any) => reply(id, { content: [{ type: 'text', text: `Error: ${e?.message || e}` }], isError: true }));
      return;
    }
    case 'resources/list':
      reply(id, { resources: [] });
      return;
    case 'resources/templates/list':
      reply(id, { resourceTemplates: [] });
      return;
    case 'prompts/list':
      reply(id, { prompts: [] });
      return;
    default:
      if (!isNotification) fail(id, -32601, `Method not found: ${method}`);
  }
});

// Announce on stderr (stdout is reserved for protocol messages).
const backend = cfg.supabaseUrl ? `supabase=${cfg.supabaseUrl}` : cfg.api ? `api=${cfg.api}` : `db=${cfg.dbPath}`;
process.stderr.write(`spark mcp: room=${cfg.room} agent=${cfg.agent} ${backend}\n`);
