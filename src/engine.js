import { generateNodes, createTerritories, canDeployInTerritory } from '../public/territory.js';
import { RegionalCycleDetector } from './dormancy.js';
import { RULES } from './config.js';
export { RULES };
export const COLORS = ['#67f5d1', '#ff796c', '#ac98ff', '#f4cc75'];
const SPAWNS = [[180, 180], [820, 820], [820, 180], [180, 820]];
const dist2 = (a, b, x, y) => (a - x) ** 2 + (b - y) ** 2;

export class Game {
  constructor(members, { random = Math.random } = {}) {
    this.size = RULES.size;
    this.board = new Uint8Array(this.size * this.size);
    this.next = new Uint8Array(this.board.length);
    this.counts = new Uint8Array(this.board.length);
    this.votes = new Uint16Array(this.board.length);
    this.marks = new Uint32Array(this.board.length);
    this.candidates = new Uint32Array(this.board.length);
    this.alive = [];
    this.generation = 0;
    this.dormancy = new RegionalCycleDetector(this.size);
    this.status = 'playing';
    this.winner = null;
    this.changes = new Map();
    this.events = [];
    this.players = members.map((m, i) => ({ id: i + 1, name: m.name, bot: !!m.bot, x: SPAWNS[i][0], y: SPAWNS[i][1], hp: RULES.baseHP, energy: 120, cells: 0, nodes: 0, eliminated: false }));
    this.nodes = generateNodes(this.players, random, this.size);
    this.territories = createTerritories(this.players, this.nodes, this.size);
  }

  inRange(player, x, y) {
    return !player.eliminated && canDeployInTerritory(this.territories, this.players, this.nodes, player.id, x, y, this.size);
  }

  deploy(id, x, y, cells) {
    const p = this.players.find(p => p.id === id);
    if (this.status !== 'playing' || !p || p.eliminated) return { error: '当前无法部署' };
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Array.isArray(cells) || !cells.length || cells.length > 4096) return { error: '无效图案：需要 1–4096 个细胞' };
    const positions = new Set();
    for (const cell of cells) {
      if (!Array.isArray(cell) || cell.length !== 2 || !cell.every(v => Number.isInteger(v) && v >= 0 && v < 128)) return { error: '图案尺寸不得超过 128×128' };
      const cx = x + cell[0], cy = y + cell[1];
      if (cx < 0 || cy < 0 || cx >= this.size || cy >= this.size) return { error: '图案超出地图边界' };
      if (!this.inRange(p, cx, cy)) return { error: '图案必须完整位于己方已控制的多边形领地内' };
      if (this.players.some(e => !e.eliminated && e.id !== id && dist2(e.x, e.y, cx, cy) < 28 ** 2)) return { error: '敌方基地周围 28 格内禁止直接部署' };
      const key = cy * this.size + cx;
      if (this.board[key]) return { error: '部署位置存在活细胞' };
      positions.add(key);
    }
    if (p.energy < positions.size) return { error: '能量不足，等待回复后重试' };
    if (p.cells + positions.size > RULES.playerCells || this.alive.length + positions.size > RULES.maxCells) return { error: '已达到活细胞容量上限' };
    p.energy -= positions.size;
    this.dormancy.invalidate(positions);
    for (const key of positions) { this.board[key] = id; this.alive.push(key); this.changes.set(key, id); }
    p.cells += positions.size;
    return { ok: true, cost: positions.size };
  }

  step(dt = 1 / RULES.hz) {
    if (this.status !== 'playing') return;
    this.generation++;
    const { board, next, counts, votes, marks, candidates, size } = this;
    let length = 0;
    const stamp = this.generation;
    for (const key of this.alive) {
      const owner = board[key];
      if (!owner) continue;
      if (marks[key] !== stamp) { marks[key] = stamp; counts[key] = 0; votes[key] = 0; candidates[length++] = key; }
      const x = key % size, y = Math.floor(key / size), vote = 1 << ((owner - 1) * 4);
      for (let dy = -1; dy <= 1; dy++) {
        if (y + dy < 0 || y + dy >= size) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || x + dx < 0 || x + dx >= size) continue;
          const n = key + dy * size + dx;
          if (marks[n] !== stamp) { marks[n] = stamp; counts[n] = 0; votes[n] = 0; candidates[length++] = n; }
          counts[n]++; votes[n] += vote;
        }
      }
    }
    next.fill(0);
    const nextAlive = [], totals = [0, 0, 0, 0, 0];
    for (let i = 0; i < length; i++) {
      const key = candidates[i], count = counts[key];
      let owner = board[key];
      if (count !== 3 && !(owner && count === 2)) continue;
      if (!owner) {
        let max = 0;
        for (let t = 0; t < 4; t++) {
          const team = ((t + key + stamp) % 4) + 1, n = (votes[key] >> ((team - 1) * 4)) & 15;
          if (n > max) { max = n; owner = team; }
        }
      }
      if (totals[owner] >= RULES.playerCells || nextAlive.length >= RULES.maxCells) continue;
      next[key] = owner; nextAlive.push(key); totals[owner]++;
    }
    for (let i = 0; i < length; i++) {
      const key = candidates[i];
      if (next[key] !== board[key]) this.changes.set(key, next[key]);
    }
    this.board = next; this.next = board; this.alive = nextAlive;
    for (const p of this.players) p.cells = totals[p.id];
    this.resolveObjectives();
    this.dormancy.update(this, RULES.dormancyGenerations, RULES.dormancyWarning);
    for (const p of this.players) {
      p.nodes = this.nodes.filter(n => n.owner === p.id).length;
      if (!p.eliminated) p.energy = Math.min(RULES.maxEnergy, p.energy + RULES.regen + p.nodes * RULES.nodeRegen);
    }
    this.checkVictory();
  }

  nearby(x, y, radius, callback) {
    for (let yy = Math.max(0, y - radius); yy <= Math.min(this.size - 1, y + radius); yy++) {
      for (let xx = Math.max(0, x - radius); xx <= Math.min(this.size - 1, x + radius); xx++) {
        if (dist2(x, y, xx, yy) > radius * radius) continue;
        const key = yy * this.size + xx;
        if (this.board[key]) callback(this.board[key], key);
      }
    }
  }

  resolveObjectives() {
    for (const n of this.nodes) {
      let mask = 0;
      this.nearby(n.x, n.y, RULES.captureRadius, owner => { mask |= 1 << owner; });
      if (mask && (mask & (mask - 1)) === 0) {
        const owner = Math.log2(mask);
        if (owner === n.owner) { n.progress = Math.max(0, n.progress - 1); if (!n.progress) n.claimant = 0; continue; }
        if (n.claimant !== owner) { n.claimant = owner; n.progress = 0; }
        n.progress += 1;
        if (n.progress + 1e-9 >= RULES.captureTime) {
          n.owner = owner; n.claimant = 0; n.progress = 0;
          this.event('capture', owner, `占领中继节点 N-${String(n.id + 1).padStart(2, '0')}`);
        }
      } else if (!mask) { n.progress = Math.max(0, n.progress - RULES.captureDecay); if (!n.progress) n.claimant = 0; }
    }
    for (const p of this.players) {
      if (p.eliminated) continue;
      let hits = 0;
      this.nearby(p.x, p.y, RULES.baseHitRadius, (owner, key) => {
        if (owner !== p.id) { this.board[key] = 0; this.changes.set(key, 0); this.players[owner - 1].cells--; hits++; }
      });
      if (hits) { p.hp = Math.max(0, p.hp - hits); this.event('damage', p.id, `基地受到 ${hits} 点伤害`); }
    }
    // Resolve all impact damage before clearing eliminated factions so simultaneous
    // core destruction is fair and may end in a draw.
    for (const p of this.players) if (!p.hp && !p.eliminated) this.eliminate(p.id);
    this.alive = this.alive.filter(key => this.board[key] !== 0);
  }

  event(type, player, text) { this.events.push({ type, player, text, generation: this.generation, time: Date.now() }); if (this.events.length > 20) this.events.shift(); }

  eliminate(id) {
    if (this.status !== 'playing') return;
    const p = this.players.find(p => p.id === id);
    if (!p || p.eliminated) return;
    p.eliminated = true; p.hp = 0; p.cells = 0;
    for (const key of this.alive) if (this.board[key] === id) { this.board[key] = 0; this.changes.set(key, 0); }
    this.alive = this.alive.filter(key => this.board[key]);
    for (const n of this.nodes) { if (n.owner === id) n.owner = 0; if (n.claimant === id) { n.claimant = 0; n.progress = 0; } }
    this.event('eliminated', id, `${p.name} 的核心已被摧毁`);
  }

  checkVictory() {
    if (this.status !== 'playing') return;
    const survivors = this.players.filter(p => !p.eliminated);
    if (survivors.length <= 1) { this.status = 'finished'; this.winner = survivors[0]?.id ?? 0; this.event('victory', this.winner, '对局结束'); }
  }

  packet(snapshot = false) {
    const entries = snapshot ? this.alive.map(k => [k, this.board[k]]) : [...this.changes];
    const result = new ArrayBuffer(8 + entries.length * 4), view = new DataView(result);
    view.setUint32(0, snapshot ? 1 : 0, true); view.setUint32(4, this.generation, true);
    entries.forEach(([key, owner], i) => view.setUint32(8 + i * 4, key + owner * 1000000, true));
    return result;
  }

  state() { return { type: 'state', generation: this.generation, status: this.status, winner: this.winner, players: this.players, nodes: this.nodes, events: this.events, dormancy: this.dormancy.warnings || [] }; }
}
