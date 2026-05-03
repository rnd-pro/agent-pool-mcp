import { promises as fs } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

/**
 * BoardStore - persists delegation board state (tasks/relationships) under .agents/board-state.json
 * Nodes (Tasks): { id, parentId?, agentSlug, description, status, createdAt, startedAt?, completedAt?, cost?, tokens? }
 * Edges (Delegation): { id, from, to }
 */
export class BoardStore {
  constructor(workdir) {
    if (!workdir) throw new Error('BoardStore requires workdir');
    this.workdir = workdir;
    this.file = resolve(join(workdir, '.agents', 'board-state.json'));
    this.state = { nodes: [], edges: [] };
    // Synchronous initialization fallback
    this.initialized = false;
  }

  async load() {
    try {
      const buf = await fs.readFile(this.file, 'utf8');
      const j = JSON.parse(buf);
      if (j && typeof j === 'object') {
        this.state = {
          nodes: Array.isArray(j.nodes) ? j.nodes : [],
          edges: Array.isArray(j.edges) ? j.edges : []
        };
      }
    } catch (e) {
      // If file not found, ensure directory exists
      try {
        await fs.mkdir(dirname(this.file), { recursive: true });
      } catch {}
      this.state = { nodes: [], edges: [] };
      await this._saveSafe();
    }
    this.initialized = true;
  }

  async _saveSafe() {
    try {
      await fs.mkdir(dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (e) {
      console.error('[BoardStore] Failed to save state:', e.message);
    }
  }

  getSnapshot() {
    return { nodes: [...this.state.nodes], edges: [...this.state.edges] };
  }

  async addNode(node) {
    if (!this.initialized) await this.load();
    if (!node || !node.id) return;
    const id = String(node.id);
    
    // Check if exists
    const existing = this.state.nodes.find(n => String(n.id) === id);
    if (existing) return;

    const newNode = {
      id,
      parentId: node.parentId,
      chatId: node.chatId,
      agentSlug: node.agentSlug || 'unknown',
      description: node.description || '',
      status: node.status || 'queued',
      createdAt: node.createdAt || new Date().toISOString(),
      startedAt: node.startedAt,
      completedAt: node.completedAt,
      cost: node.cost || 0,
      tokens: node.tokens || 0
    };
    
    this.state.nodes.push(newNode);

    // If a parent is provided, automatically add an edge
    if (node.parentId) {
      await this.addEdge({ from: node.parentId, to: id });
    } else {
      await this._saveSafe();
    }
  }

  async updateNodeStatus(id, updates) {
    if (!this.initialized) await this.load();
    const nodeId = String(id);
    const node = this.state.nodes.find(n => String(n.id) === nodeId);
    if (!node) return;

    if (updates.status) node.status = updates.status;
    if (updates.startedAt) node.startedAt = updates.startedAt;
    if (updates.completedAt) node.completedAt = updates.completedAt;
    if (typeof updates.cost === 'number') node.cost = updates.cost;
    if (typeof updates.tokens === 'number') node.tokens = updates.tokens;

    await this._saveSafe();
  }

  async addEdge(edge) {
    if (!this.initialized) await this.load();
    if (!edge || !edge.from || !edge.to) return;
    const id = String(edge.id || `${edge.from}-${edge.to}`);
    if (this.state.edges.find(e => String(e.id) === id)) return;
    
    this.state.edges.push({ id, from: String(edge.from), to: String(edge.to) });
    await this._saveSafe();
  }

  async clear() {
    this.state = { nodes: [], edges: [] };
    await this._saveSafe();
  }
}

// Per-workspace store cache
/** @type {Map<string, BoardStore>} */
const storeCache = new Map();

export function getBoardStore(cwd) {
  if (!storeCache.has(cwd)) {
    let store = new BoardStore(cwd);
    storeCache.set(cwd, store);
    store.load().catch(() => {});
  }
  return storeCache.get(cwd);
}
