// Spark cloud API (v3) — zero-dep node:http over the same Store.
// Locally this stands in for the hosted backend; multiple clients on localhost
// simulate remote teammates. For real deploy, swap Store(SQLite) for Postgres.
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from '../../mcp-server/src/store.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'index.html');

const PORT = Number(process.env.SPARK_PORT) || 8787;
let dbPath = process.env.SPARK_DB;
if (!dbPath) {
  const dir = join(homedir(), '.spark');
  mkdirSync(dir, { recursive: true });
  dbPath = join(dir, 'server.db');
}
const store = new Store(dbPath);

function send(res: any, code: number, obj: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function bearer(req: any): string {
  const h = String(req.headers['authorization'] || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : '';
}

const server = createServer((req, res) => {
  let chunks = '';
  req.on('data', (d: any) => (chunks += d));
  req.on('end', () => {
    const url = req.url || '';
    if (req.method === 'GET' && url === '/health') return send(res, 200, { ok: true, service: 'spark', port: PORT });
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      if (existsSync(WEB)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(readFileSync(WEB));
      }
      return send(res, 404, { error: 'dashboard not found' });
    }
    if (req.method !== 'POST') return send(res, 404, { error: 'not found' });

    let body: any = {};
    if (chunks) {
      try { body = JSON.parse(chunks); } catch { return send(res, 400, { error: 'invalid json' }); }
    }
    const token = bearer(req);
    const room = body.room;
    if (!room) return send(res, 400, { error: 'room required' });

    try {
      if (url === '/join') {
        if (!token) return send(res, 401, { error: 'token required' });
        const stored = store.ensureRoomToken(room, token);
        if (stored !== token) return send(res, 403, { error: 'wrong room token' });
        return send(res, 200, { ok: true, room });
      }
      // Everything else requires a valid room token.
      if (!store.checkRoomToken(room, token)) return send(res, 403, { error: 'join first or invalid token' });

      switch (url) {
        case '/search':
          return send(res, 200, { results: store.searchSmart(room, body.query || '', body.tags, body.limit || 5) });
        case '/record':
          return send(res, 200, { card: store.recordSolution(room, body) });
        case '/confirm':
          return send(res, 200, { card: store.confirmSolution(room, Number(body.id)) });
        case '/update':
          return send(res, 200, { card: store.updateSolution(room, Number(body.id), body) });
        case '/delete':
          return send(res, 200, { ok: store.deleteSolution(room, Number(body.id)) });
        case '/context/get':
          return send(res, 200, { context: store.getContext(room) });
        case '/context/set':
          return send(res, 200, { result: store.updateContext(room, body.section, body.content, body.author) });
        case '/recent':
          return send(res, 200, { activity: store.listRecent(room, body.limit || 10) });
        default:
          return send(res, 404, { error: `unknown endpoint ${url}` });
      }
    } catch (e: any) {
      return send(res, 500, { error: e?.message || String(e) });
    }
  });
});

server.listen(PORT, () => {
  process.stderr.write(`spark api: http://localhost:${PORT} db=${dbPath}\n`);
});
