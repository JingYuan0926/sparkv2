// Resolves room, agent identity, and the shared DB path.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

export function sanitizeRoom(room: string): string {
  return room.replace(/[^A-Za-z0-9_-]/g, '_');
}

// Who is recording this card, detected once per process:
//   GitHub handle (gh CLI) → git user.name → OS user → 'claude-code'.
// SPARK_AGENT (or --agent) overrides it. So each teammate's cards are attributed to their
// own GitHub/git identity automatically — no need to set a name by hand.
let _identity: string | undefined;
export function detectIdentity(): string {
  if (_identity !== undefined) return _identity;
  const run = (cmd: string): string => {
    try {
      return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2500 }).toString().trim();
    } catch {
      return '';
    }
  };
  _identity = run('gh api user --jq .login') || run('git config user.name') || process.env.USER || 'claude-code';
  return _identity;
}

export interface SparkConfig {
  room: string;
  agent: string;
  dbPath: string;
  api: string; // self-hosted HTTP API base URL; empty = not used
  token: string; // room join token; defaults to the room code (join-by-code)
  supabaseUrl: string; // Supabase project URL; set → talk directly to Supabase
  supabaseKey: string; // Supabase anon (public) key
}

export function resolveConfig(overrides: Partial<SparkConfig> = {}): SparkConfig {
  const room = overrides.room || process.env.SPARK_ROOM || 'SPARK-DEMO';
  const agent = overrides.agent || process.env.SPARK_AGENT || detectIdentity();
  const api = overrides.api ?? process.env.SPARK_API ?? '';
  const token = overrides.token || process.env.SPARK_TOKEN || room;
  const supabaseUrl = overrides.supabaseUrl ?? process.env.SPARK_SUPABASE_URL ?? '';
  const supabaseKey = overrides.supabaseKey ?? process.env.SPARK_SUPABASE_KEY ?? '';
  let dbPath = overrides.dbPath || process.env.SPARK_DB;
  if (!dbPath) {
    const dir = join(homedir(), '.spark');
    mkdirSync(dir, { recursive: true });
    dbPath = join(dir, `${sanitizeRoom(room)}.db`);
  }
  return { room, agent, dbPath, api, token, supabaseUrl, supabaseKey };
}
