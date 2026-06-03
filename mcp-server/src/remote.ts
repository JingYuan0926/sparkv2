// RemoteStore — same surface as Store, but talks to the Spark cloud API over HTTP.
// Used when SPARK_API is set; the room token defaults to the room code (join-by-code).
import type { Solution, Activity, Section } from './store.ts';

export class RemoteStore {
  private api: string;
  private token: string;
  constructor(api: string, token: string) {
    this.api = api.replace(/\/$/, '');
    this.token = token;
  }

  private async post(path: string, body: any): Promise<any> {
    const r = await fetch(this.api + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({ error: r.statusText }));
    if (!r.ok) throw new Error(data?.error || `http ${r.status}`);
    return data;
  }

  async join(room: string): Promise<void> {
    await this.post('/join', { room });
  }
  async searchSolutions(room: string, query: string, tags?: string[], limit = 5): Promise<Solution[]> {
    return (await this.post('/search', { room, query, tags, limit })).results;
  }
  // Server-side /search already runs searchSmart; alias for a uniform client surface.
  async searchSmart(room: string, query: string, tags?: string[], limit = 5): Promise<Solution[]> {
    return this.searchSolutions(room, query, tags, limit);
  }
  async recordSolution(
    room: string,
    input: { problem: string; solution: string; context?: string; tags?: string[]; author?: string },
  ): Promise<Solution> {
    return (await this.post('/record', { room, ...input })).card;
  }
  async confirmSolution(room: string, id: number): Promise<Solution | null> {
    return (await this.post('/confirm', { room, id })).card;
  }
  async updateSolution(
    room: string,
    id: number,
    fields: { problem?: string; solution?: string; context?: string; tags?: string[] },
  ): Promise<Solution | null> {
    return (await this.post('/update', { room, id, ...fields })).card;
  }
  async deleteSolution(room: string, id: number): Promise<boolean> {
    return (await this.post('/delete', { room, id })).ok;
  }
  async getContext(room: string): Promise<Record<Section, { content: string; updated_at: string | null }>> {
    return (await this.post('/context/get', { room })).context;
  }
  async updateContext(room: string, section: string, content: string, author?: string): Promise<any> {
    return (await this.post('/context/set', { room, section, content, author })).result;
  }
  async listRecent(room: string, limit = 10): Promise<Activity[]> {
    return (await this.post('/recent', { room, limit })).activity;
  }
  close(): void {}
}
