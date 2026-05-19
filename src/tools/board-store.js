import fs from 'node:fs';
import { dirname } from 'node:path';
import { getLegacyAgentPortalPath, getProjectStatePath } from '../runtime/paths.js';

/**
 * BoardStore - persists delegation board state (tasks/relationships) in local portal project state.
 * Nodes (Tasks): { id, parentId?, agentSlug, description, status, createdAt, startedAt?, completedAt?, cost?, tokens? }
 * Edges (Delegation): { id, from, to }
 */
export class BoardStore {
  constructor(workdir) {
    if (!workdir) throw new Error('BoardStore requires workdir');
    this.workdir = workdir;
    this.file = getProjectStatePath(workdir, 'board-state.json');
    this.legacyFile = getLegacyAgentPortalPath(workdir, 'board-state.json');
    this.state = { nodes: [], edges: [] };
    this.initialized = false;
  }

  load() {
    try {
      const source = fs.existsSync(this.file) ? this.file : this.legacyFile;
      const buf = fs.readFileSync(source, 'utf8');
      const j = JSON.parse(buf);
      if (j && typeof j === 'object') {
        this.state = {
          nodes: Array.isArray(j.nodes) ? j.nodes : [],
          edges: Array.isArray(j.edges) ? j.edges : [],
        };
      }
    } catch (e) {
      this.state = { nodes: [], edges: [] };
      this._saveSafe();
    }
    this.initialized = true;
  }

  _saveSafe() {
    try {
      fs.mkdirSync(dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (e) {
      console.error('[BoardStore] Failed to save state:', e.message);
    }
  }

  getSnapshot() {
    return { nodes: [...this.state.nodes], edges: [...this.state.edges] };
  }

  addNode(node) {
    if (!this.initialized) this.load();
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
      icon: node.icon || 'smart_toy',
      color: node.color || '#666',
      description: node.description || '',
      status: node.status || 'queued',
      createdAt: node.createdAt || new Date().toISOString(),
      startedAt: node.startedAt,
      completedAt: node.completedAt,
      cost: node.cost || 0,
      tokens: node.tokens || 0,
    };
    
    this.state.nodes.push(newNode);

    // If a parent is provided, automatically add an edge
    if (node.parentId) {
      this.addEdge({ from: node.parentId, to: id });
    } else {
      this._saveSafe();
    }
  }

  updateNodeStatus(id, updates) {
    if (!this.initialized) this.load();
    const nodeId = String(id);
    const node = this.state.nodes.find(n => String(n.id) === nodeId);
    if (!node) return;

    if (updates.status) node.status = updates.status;
    if (updates.startedAt) node.startedAt = updates.startedAt;
    if (updates.completedAt) node.completedAt = updates.completedAt;
    if (typeof updates.cost === 'number') node.cost = updates.cost;
    if (typeof updates.tokens === 'number') node.tokens = updates.tokens;

    this._saveSafe();
  }

  addEdge(edge) {
    if (!this.initialized) this.load();
    if (!edge || !edge.from || !edge.to) return;
    const id = String(edge.id || `${edge.from}-${edge.to}`);
    if (this.state.edges.find(e => String(e.id) === id)) return;
    
    this.state.edges.push({ id, from: String(edge.from), to: String(edge.to) });
    this._saveSafe();
  }

  clear() {
    this.state = { nodes: [], edges: [] };
    this._saveSafe();
  }
}

// Per-workspace store cache
/** @type {Map<string, BoardStore>} */
const storeCache = new Map();

export function getBoardStore(cwd) {
  if (!storeCache.has(cwd)) {
    let store = new BoardStore(cwd);
    storeCache.set(cwd, store);
    store.load();
  }
  return storeCache.get(cwd);
}
