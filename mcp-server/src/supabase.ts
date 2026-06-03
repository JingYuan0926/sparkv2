// SupabaseStore — same surface as Store, but talks DIRECTLY to a Supabase project via its
// auto-generated PostgREST RPC endpoints (the token-gated functions in supabase/schema.sql).
// Zero-dependency (uses fetch). No separate server to host: each teammate's MCP server is a
// client of the shared Supabase Postgres DB. Search ranking runs client-side (rankByRelevance)
// over the room's cards — fine for hackathon-scale rooms.
import { SECTIONS, type Solution, type Activity, type Section } from './store.ts';
import { rankByRelevance } from './semantic.ts';

export class SupabaseStore {
  private url: string;
  private key: string;
  private token: string;

  constructor(url: string, anonKey: string, token: string) {
    this.url = url.replace(/\/$/, '');
    this.key = anonKey;
    this.token = token;
  }

  private async rpc(fn: string, args: any): Promise<any> {
    const r = await fetch(`${this.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: this.key, authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.message || data?.error || `supabase ${r.status}`);
    return data;
  }

  // PostgREST returns a single-composite RPC result either as an object or a 1-element array,
  // depending on version — normalize to the first row.
  private one(data: any): any {
    return Array.isArray(data) ? data[0] ?? null : data ?? null;
  }

  private toSol(r: any): Solution {
    return {
      id: Number(r.id),
      problem: r.problem,
      solution: r.solution,
      context: r.context ?? null,
      tags: r.tags ? String(r.tags).split(',').filter(Boolean) : [],
      status: r.status,
      helped: Number(r.helped),
      author: r.author ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }

  async join(room: string): Promise<void> {
    const ok = await this.rpc('spark_join', { p_room: room, p_token: this.token });
    if (ok !== true) throw new Error('invalid room token / join failed');
  }

  private async allCards(room: string): Promise<Solution[]> {
    const rows = (await this.rpc('spark_cards', { p_room: room, p_token: this.token })) || [];
    return rows.map((r: any) => this.toSol(r));
  }

  async searchSolutions(room: string, query: string, tags?: string[], limit = 5): Promise<Solution[]> {
    return rankByRelevance(await this.allCards(room), query, tags, limit);
  }
  // Same as searchSolutions here — ranking is already keyword+semantic, client-side.
  async searchSmart(room: string, query: string, tags?: string[], limit = 5): Promise<Solution[]> {
    return rankByRelevance(await this.allCards(room), query, tags, limit);
  }

  async getSolution(room: string, id: number): Promise<Solution | null> {
    return (await this.allCards(room)).find((c) => c.id === id) ?? null;
  }

  async recordSolution(
    room: string,
    input: { problem: string; solution: string; context?: string; tags?: string[]; author?: string },
  ): Promise<Solution> {
    const r = this.one(
      await this.rpc('spark_record', {
        p_room: room,
        p_token: this.token,
        p_problem: input.problem,
        p_solution: input.solution,
        p_context: input.context || '',
        p_tags: (input.tags || []).map((t) => t.trim().toLowerCase()).filter(Boolean).join(','),
        p_author: input.author || null,
      }),
    );
    return this.toSol(r);
  }

  async confirmSolution(room: string, id: number): Promise<Solution | null> {
    const r = this.one(await this.rpc('spark_confirm', { p_room: room, p_token: this.token, p_id: id }));
    return r ? this.toSol(r) : null;
  }

  async updateSolution(
    room: string,
    id: number,
    fields: { problem?: string; solution?: string; context?: string; tags?: string[] },
  ): Promise<Solution | null> {
    const r = this.one(
      await this.rpc('spark_update', {
        p_room: room,
        p_token: this.token,
        p_id: id,
        p_problem: fields.problem || '',
        p_solution: fields.solution || '',
        p_context: fields.context ?? null,
        p_tags: fields.tags ? fields.tags.map((t) => t.trim().toLowerCase()).filter(Boolean).join(',') : null,
      }),
    );
    return r ? this.toSol(r) : null;
  }

  async deleteSolution(room: string, id: number): Promise<boolean> {
    return (await this.rpc('spark_delete', { p_room: room, p_token: this.token, p_id: id })) === true;
  }

  async getContext(room: string): Promise<Record<Section, { content: string; updated_at: string | null }>> {
    const rows = (await this.rpc('spark_get_context', { p_room: room, p_token: this.token })) || [];
    const map = new Map(rows.map((r: any) => [r.section, r]));
    const out = {} as Record<Section, { content: string; updated_at: string | null }>;
    for (const s of SECTIONS) {
      const r: any = map.get(s);
      out[s] = { content: r?.content ?? '', updated_at: r?.updated_at ?? null };
    }
    return out;
  }

  async updateContext(room: string, section: string, content: string, author?: string): Promise<any> {
    const r = this.one(
      await this.rpc('spark_set_context', { p_room: room, p_token: this.token, p_section: section, p_content: content, p_by: author || null }),
    );
    return { section, updated_at: r?.updated_at };
  }

  async listRecent(room: string, limit = 10): Promise<Activity[]> {
    const sols = await this.allCards(room);
    const ctxRows = (await this.rpc('spark_get_context', { p_room: room, p_token: this.token })) || [];
    const acts: Activity[] = [
      ...sols.slice(0, limit).map((s) => ({ kind: 'solution' as const, ref: `#${s.id}`, summary: `[${s.status}] ${s.problem}`, at: s.updated_at })),
      ...ctxRows.map((c: any) => ({ kind: 'context' as const, ref: c.section, summary: `context "${c.section}" updated`, at: c.updated_at })),
    ];
    acts.sort((a, b) => (a.at < b.at ? 1 : -1));
    return acts.slice(0, limit);
  }

  close(): void {}
}
