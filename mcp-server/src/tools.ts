// Tool registry: definitions (MCP-compatible JSON Schema) + handlers.
// Handlers return human-readable text — the agent reads the result.
import { Store, SECTIONS, type Solution } from './store.ts';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: any;
  handler: (store: any, room: string, args: any, agent: string) => string | Promise<string>;
}

function fmtCard(c: Solution): string {
  const rel = c.relevance != null ? `${Math.round(c.relevance * 100)}% match, ` : '';
  const meta = `#${c.id} [${rel}${c.status}${c.helped ? `, helped ${c.helped}×` : ''}]${
    c.tags.length ? ` (${c.tags.join(', ')})` : ''
  }`;
  return `${meta}\nPROBLEM: ${c.problem}\nSOLUTION: ${c.solution}${
    c.context ? `\nCONTEXT: ${c.context}` : ''
  }`;
}

function fmtCards(cards: Solution[]): string {
  if (!cards.length)
    return 'No strong match in this room — you may be the first to hit this. If you solve it, call record_solution so teammates skip the grind. (Only relevant cards are shown; an empty result means nothing relevant exists, not that search is broken.)';
  return `Found ${cards.length} relevant solution(s), best first:\n\n` + cards.map(fmtCard).join('\n\n');
}

export const TOOLS: ToolDef[] = [
  {
    name: 'search_solutions',
    description:
      'Search the team\'s shared knowledge for solutions to a coding problem BEFORE grinding on it yourself. Returns ranked solution cards (verified/often-reused first). Always try this when you hit an error, a build failure, or a tricky setup step.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The problem, error message, or task in your own words.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag filter, e.g. ["nextjs","build"].' },
        limit: { type: 'number', description: 'Max results (default 5).' },
      },
      required: ['query'],
    },
    handler: async (store, room, args) => {
      const limit = Number(args.limit) || 5;
      // Prefer smart (keyword + semantic) when available; RemoteStore routes through the server's smart search.
      const fn = store.searchSmart ? store.searchSmart.bind(store) : store.searchSolutions.bind(store);
      return fmtCards(await fn(room, String(args.query || ''), args.tags, limit));
    },
  },
  {
    name: 'record_solution',
    description:
      'Record a SOLVED problem so teammates\' agents never have to re-solve it. Only call this once something actually works. Be specific in `problem` (include the error text) so search finds it later.',
    inputSchema: {
      type: 'object',
      properties: {
        problem: { type: 'string', description: 'What went wrong / the question. Include the error text.' },
        solution: { type: 'string', description: 'What actually fixed it.' },
        context: { type: 'string', description: 'Language/framework/file/repo context (optional).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for retrieval, e.g. ["vite","env"].' },
      },
      required: ['problem', 'solution'],
    },
    handler: async (store, room, args, agent) => {
      const c = await store.recordSolution(room, {
        problem: String(args.problem || ''),
        solution: String(args.solution || ''),
        context: args.context ? String(args.context) : undefined,
        tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
        author: agent,
      });
      return `Recorded solution #${c.id} (status: unverified). Teammates who hit "${c.problem}" will now find this. When you or someone confirms it works, call confirm_solution(${c.id}).`;
    },
  },
  {
    name: 'confirm_solution',
    description:
      'Mark a solution card as verified and increment its "helped" counter — call this when a card from search_solutions actually solved your problem. Verified/often-helped cards rank higher for everyone.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'The card id (e.g. 7 for #7).' } },
      required: ['id'],
    },
    handler: async (store, room, args) => {
      const c = await store.confirmSolution(room, Number(args.id));
      if (!c) return `No card #${args.id} in this room.`;
      return `Confirmed #${c.id} — now verified, helped ${c.helped}×. Thanks for closing the loop.`;
    },
  },
  {
    name: 'update_solution',
    description:
      'Fix or improve an existing solution card in place (e.g. you recorded it wrong, or have a better fix). Prefer this over recording a near-duplicate. Pass only the fields you want to change.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The card id to update.' },
        problem: { type: 'string' },
        solution: { type: 'string' },
        context: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
    handler: async (store, room, args) => {
      const c = await store.updateSolution(room, Number(args.id), {
        problem: args.problem != null ? String(args.problem) : undefined,
        solution: args.solution != null ? String(args.solution) : undefined,
        context: args.context != null ? String(args.context) : undefined,
        tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
      });
      if (!c) return `No card #${args.id} in this room.`;
      return `Updated card #${c.id}. PROBLEM: ${c.problem}`;
    },
  },
  {
    name: 'delete_solution',
    description:
      'Permanently remove a solution card from the room — use for a wrong, obsolete, or duplicate card so it stops polluting search and orient. Irreversible.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'The card id to delete.' } },
      required: ['id'],
    },
    handler: async (store, room, args) => {
      const ok = await store.deleteSolution(room, Number(args.id));
      return ok ? `Deleted card #${args.id}.` : `No card #${args.id} in this room.`;
    },
  },
  {
    name: 'get_context',
    description:
      'Read the room\'s Living Context — the shared project brief (Goal, Stack, Decisions, Status, code Map). Call this when you join, reopen, or feel unsure what the team is building. It gets you oriented fast without reading the whole codebase.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (store, room) => {
      const ctx = await store.getContext(room);
      const parts = SECTIONS.map(
        (s) => `## ${s.toUpperCase()}${ctx[s].updated_at ? `  (updated ${ctx[s].updated_at})` : ''}\n${ctx[s].content || '(empty)'}`,
      );
      return `Living Context for room ${room}:\n\n` + parts.join('\n\n');
    },
  },
  {
    name: 'update_context',
    description:
      'Update one section of the room\'s Living Context so teammates stay oriented. Sections: goal, stack, decisions, status, map. Use `status` for what\'s done/in-progress/blocked; `map` for key files + one-line purpose. Keep it concise — it\'s state, not a transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: [...SECTIONS], description: 'Which section to update.' },
        content: { type: 'string', description: 'The new content for that section.' },
      },
      required: ['section', 'content'],
    },
    handler: async (store, room, args, agent) => {
      const res = await store.updateContext(room, String(args.section), String(args.content ?? ''), agent);
      return `Updated context section "${res.section}".`;
    },
  },
  {
    name: 'list_recent',
    description: 'Show recent team activity (solutions recorded + context updates) — the room\'s progress feed.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max entries (default 10).' } },
    },
    handler: async (store, room, args) => {
      const acts = await store.listRecent(room, Number(args.limit) || 10);
      if (!acts.length) return 'No activity in this room yet.';
      return acts.map((a) => `${a.at}  ${a.kind === 'solution' ? '🧩' : '📝'} ${a.ref}  ${a.summary}`).join('\n');
    },
  },
];
