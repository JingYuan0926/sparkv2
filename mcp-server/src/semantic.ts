// v4 semantic fallback — catches paraphrased problems that exact keyword (FTS5) misses.
// Zero-dependency: normalized tokens + light stemming + a dev-term synonym map + Jaccard.
// This is the LOCAL fallback. A real embedding provider can be slotted in behind the same
// `semanticSearch` shape (see SPARK_EMBED_API note in docs) — not required for it to work.
import type { Solution } from './store.ts';

const STOP = new Set([
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'and', 'or', 'is', 'are', 'was', 'were', 'be',
  'it', 'this', 'that', 'with', 'for', 'as', 'at', 'by', 'from', 'when', 'how', 'i', 'my',
  'we', 'you', 'do', 'does', 'did', 'not', 'no', 'but', 'if', 'then', 'so', 'out', 'up',
]);

// Cluster common dev terms to a canonical token so paraphrases collapse together.
const SYN: Record<string, string> = {
  error: 'error', errors: 'error', fail: 'error', fails: 'error', failed: 'error', failing: 'error',
  failure: 'error', broken: 'error', breaks: 'error', crash: 'error', crashes: 'error', crashing: 'error',
  exception: 'error', throw: 'error', throws: 'error', bug: 'error',
  undefined: 'null', null: 'null', nil: 'null', empty: 'null', missing: 'null', blank: 'null',
  env: 'env', environment: 'env', envvar: 'env', envvars: 'env', dotenv: 'env',
  var: 'variable', vars: 'variable', variable: 'variable', variables: 'variable',
  build: 'build', builds: 'build', building: 'build', compile: 'build', compiles: 'build',
  compiling: 'build', compiled: 'build', bundler: 'build', bundle: 'build', webpack: 'build',
  deploy: 'deploy', deploys: 'deploy', deployed: 'deploy', deployment: 'deploy', ship: 'deploy',
  shipping: 'deploy', release: 'deploy', publish: 'deploy',
  install: 'install', installs: 'install', installed: 'install', installing: 'install',
  setup: 'install', config: 'config', configure: 'config', configuration: 'config',
  module: 'module', modules: 'module', package: 'module', packages: 'module', dependency: 'module',
  dependencies: 'module', import: 'module', imports: 'module', require: 'module',
  auth: 'auth', authentication: 'auth', authorize: 'auth', authorization: 'auth', login: 'auth',
  token: 'auth', credential: 'auth', credentials: 'auth', key: 'auth', keys: 'auth',
  route: 'route', routes: 'route', routing: 'route', redirect: 'route', redirects: 'route',
  type: 'type', types: 'type', typescript: 'type', typing: 'type', typed: 'type',
  db: 'database', database: 'database', sql: 'database', query: 'database', queries: 'database',
  slow: 'perf', performance: 'perf', latency: 'perf', timeout: 'perf', timeouts: 'perf',
};

function stem(t: string): string {
  if (t.length <= 4) return t;
  return t.replace(/(ing|ed|es|s)$/, '');
}

export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of (text.toLowerCase().match(/[a-z0-9]+/g) || [])) {
    if (STOP.has(raw)) continue;
    const canon = SYN[raw] || SYN[stem(raw)] || stem(raw);
    if (canon.length >= 2) out.add(canon);
  }
  return out;
}

// Fraction of the query's concepts present in the doc (0..1). Interpretable relevance that
// does NOT penalize long cards (unlike Jaccard), so it works as an absolute threshold.
export function queryCoverage(query: string, doc: string): number {
  const q = tokens(query);
  if (!q.size) return 0;
  const d = tokens(doc);
  let inter = 0;
  for (const t of q) if (d.has(t)) inter++;
  return inter / q.size;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// Rank an in-memory array of cards by relevance (used when there's no SQLite FTS, e.g. the
// Supabase path). Same coverage + threshold model as Store.searchSmart, minus the FTS bonus.
export function rankByRelevance(
  cards: Solution[],
  query: string,
  tagsFilter?: string[],
  limit = 5,
  threshold = 0.34,
): Solution[] {
  if (!query || !query.trim()) {
    return [...cards].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)).slice(0, limit);
  }
  const wantTags = (tagsFilter || []).map((t) => t.trim().toLowerCase()).filter(Boolean);
  return cards
    .filter((c) => !wantTags.length || wantTags.every((t) => (c.tags || []).includes(t)))
    .map((c) => ({ c, cov: queryCoverage(query, `${c.problem} ${c.solution} ${(c.tags || []).join(' ')}`) }))
    .filter((x) => x.cov >= threshold)
    .map((x) => {
      const tie = (x.c.status === 'verified' ? 0.02 : 0) + Math.min(x.c.helped || 0, 6) * 0.003;
      return { c: x.c, rel: Math.min(1, x.cov + tie) };
    })
    .sort((a, b) => b.rel - a.rel)
    .slice(0, limit)
    .map((x) => ({ ...x.c, relevance: Math.round(x.rel * 100) / 100, score: -x.rel }));
}

// Returns cards scored by semantic similarity to the query, above a small threshold.
export function semanticSearch(cards: Solution[], query: string, limit = 5, threshold = 0.12): Solution[] {
  const q = tokens(query);
  if (!q.size) return [];
  const scored = cards
    .map((c) => {
      const doc = tokens(`${c.problem} ${c.solution} ${c.tags.join(' ')}`);
      let sim = jaccard(q, doc);
      // small boost for verified / reused, mirroring keyword ranking
      sim += (c.status === 'verified' ? 0.05 : 0) + Math.min(c.helped, 6) * 0.01;
      return { c, sim };
    })
    .filter((x) => x.sim >= threshold)
    .sort((a, b) => b.sim - a.sim);
  return scored.slice(0, limit).map((x) => ({ ...x.c, score: -x.sim }));
}
