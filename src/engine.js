import { evolve } from './evolution/backend.js';
import { encodeBoardV2 } from '../public/board-protocol.js';
import { BackendSelector } from './evolution/select.js';
import { LocalRuleIndex } from './evolution/rule-table.js';
import { CircleIndex } from './spatial-index.js';
import { OrderedCells } from './ordered-cells.js';
import { CellChanges } from './cell-changes.js';
import { generateNodes, createTerritories, canDeployInTerritory, territoryAt, adjacentNeutralTerritories } from '../public/territory.js';
import { CARDS, CARD_CONFIG, isTargetedCard, materializeCard } from '../public/cards.js';
import { RegionalCycleDetector } from './dormancy.js';
import { RULES } from './config.js';
export { RULES };
export { CARDS };
export const COLORS = ['#67f5d1', '#ff796c', '#ac98ff', '#f4cc75'];
const SPAWNS = [[180, 180], [820, 820], [820, 180], [180, 820]];
const dist2 = (a, b, x, y) => (a - x) ** 2 + (b - y) ** 2;

export class Game {
  // 默认发牌时间唯一来源为 cards.json 的 drawSeconds；cardDrawTimes 为测试用毫秒覆盖值。
  // now：时间源，默认 Date.now；测试可注入假时钟模拟真实时间推进。
  constructor(members, { random = Math.random, cardDrawTimes = CARD_CONFIG.drawSeconds.map(s => s * 1000), now = Date.now, dormancyMode = process.env.LIFEWAR_DORMANCY ?? 'auto', evolutionMode = process.env.LIFEWAR_EVOLUTION ?? 'auto' } = {}) {
    this.size = RULES.size;
    this.board = new Uint8Array(this.size * this.size);
    this.next = new Uint8Array(this.board.length);
    this.counts = new Uint8Array(this.board.length);
    this.votes = new Uint16Array(this.board.length);
    this.marks = new Uint32Array(this.board.length);
    this.candidates = new Uint32Array(this.board.length);
    this.alive = new OrderedCells(this.board.length);
    this.spareAlive = new OrderedCells(this.board.length);
    this.generation = 0;
    this.backendSelector = new BackendSelector(evolutionMode);
    this.localIndex = new LocalRuleIndex(this.size);
    this.circleIndex = new CircleIndex(this.size);
    this.dormancy = new RegionalCycleDetector(this.size);
    if (!['auto', 'incremental', 'legacy'].includes(dormancyMode)) throw new Error('Invalid dormancy mode');
    this.dormancy.mode = dormancyMode;
    this.status = 'playing';
    this.winner = null;
    // 阶段1：生命规则参数化（默认 B3/S23，可被法则卡临时覆盖）
    this.random = random;
    this.now = now;
    this.birthRule = new Set([3]);
    this.survivalRule = new Set([2, 3]);
    this.ruleOverride = null; // { birth:Set, survival:Set, endsAt } 法则卡激活时设置
    this.pendingRule = null;
    this.localRules = [];
    // 阶段1：卡牌系统核心状态（发卡时间点 / 三选一候选 / 手牌 / 激活效果）
    this.cardDrawTimes = [...cardDrawTimes];
    this.cardDraft = null; // { gen, players:[{playerId, options, picked}] }
    this.cardSerial = 0;
    this.drawCount = 0;    // 第 1/2 轮使用 early/mid，后续各轮使用 late
    this.cards = { hand: members.map(() => []), effects: [] };
    // 休眠阈值随现实时间衰减：游戏开始后每分钟 dormancyDecayPerMinute 代，下限 minDormancyGenerations。
    this.startedAt = now();
    this.nodeDamageTick = 0;
    this.nodeShieldPeriods = [];
    this.baseDormancyGenerations = RULES.dormancyGenerations;
    this.minDormancyGenerations = RULES.minDormancyGenerations;
    this.dormancyDecayPerMinute = RULES.dormancyDecayPerMinute;
    this.changes = new CellChanges(this.board.length);
    this.events = [];
    this.players = members.map((m, i) => ({ id: i + 1, name: m.name, bot: !!m.bot, x: SPAWNS[i][0], y: SPAWNS[i][1], hp: RULES.baseHP, energy: 120, cells: 0, nodes: 0, eliminated: false }));
    this.nodes = generateNodes(this.players, random, this.size);
    this.territories = createTerritories(this.players, this.nodes, this.size);
  }

  // One ordered transition stream; network changes separately retain final values.
  recordChange(key, oldOwner, newOwner, phase) {
    this.frontier?.change(this,key,oldOwner,newOwner);
    this.dormancy.change(key, oldOwner, newOwner);
    this.onCellTransition?.({ key, oldOwner, newOwner, phase });
    this.changes.set(key, newOwner);
  }
  writeCell(key, owner, phase) {
    const old = this.board[key]; this.board[key] = owner;
    this.recordChange(key, old, owner, phase);
  }
  // Explicit hook for bulk fixture/import writes that bypass gameplay commands.
  rebuildDerivedState() {
    this.frontier?.invalidate();
    if (!(this.alive instanceof OrderedCells)) {
      const values = this.alive; this.alive = new OrderedCells(this.board.length);
      for (const key of values) this.alive.push(key);
    }
    this.dormancy.dirty = true;
  }

  inRange(player, x, y) {
    return !player.eliminated && canDeployInTerritory(this.territories, this.players, this.nodes, player.id, x, y, this.size);
  }

  deploy(id, x, y, cells) {
    const p = this.players.find(p => p.id === id);
    if (this.status !== 'playing' || !p || p.eliminated) return { error: '当前无法部署' };
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Array.isArray(cells) || !cells.length || cells.length > 4096) return { error: '无效图案：需要 1–4096 个细胞' };
    const free = this.buff(id, 'freeDeploy'), neutral = this.buff(id, 'neutralDeploy');
    if (!free && p.lastDeployGen !== undefined && this.generation - p.lastDeployGen < RULES.deployCooldown) return { error: '部署冷却中' };
    const extraLand = neutral ? adjacentNeutralTerritories(this.territories, this.players, this.nodes, id) : [];
    let usedNeutral = false;
    const positions = new Set();
    for (const cell of cells) {
      if (!Array.isArray(cell) || cell.length !== 2 || !cell.every(v => Number.isInteger(v) && v >= 0 && v < 128)) return { error: '图案尺寸不得超过 128×128' };
      const cx = x + cell[0], cy = y + cell[1];
      if (cx < 0 || cy < 0 || cx >= this.size || cy >= this.size) return { error: '图案超出地图边界' };
      if (!this.inRange(p, cx, cy)) {
        if (!extraLand.includes(territoryAt(this.territories, cx, cy, this.size))) return { error: '图案必须位于己方领地或获准的相邻中立分区' };
        usedNeutral = true;
      }
      if (this.players.some(e => !e.eliminated && e.id !== id && dist2(e.x, e.y, cx, cy) < 28 ** 2)) return { error: '敌方基地周围 28 格内禁止直接部署' };
      const key = cy * this.size + cx;
      if (this.board[key]) return { error: '部署位置存在活细胞' };
      positions.add(key);
    }
    const cost = free ? Math.max(0, positions.size - Math.floor(RULES.maxEnergy * free.discountFraction)) : Math.ceil(positions.size * (this.buff(id, 'deployCost')?.multiplier ?? 1));
    if (p.energy < cost) return { error: '能量不足，等待回复后重试' };
    if (p.cells + positions.size > this.playerCapacity(id)) return { error: '已达到活细胞容量上限' };
    p.energy -= cost;
    this.dormancy.invalidate(positions);
    for (const key of positions) { this.writeCell(key, id, 'deploy'); this.alive.push(key); }
    p.cells += positions.size;
    p.lastDeployGen = this.generation;
    if (free) this.cards.effects = this.cards.effects.filter(e => e !== free);
    if (usedNeutral) this.cards.effects = this.cards.effects.filter(e => e !== neutral);
    return { ok: true, cost };
  }

  currentDormancyGenerations() {
    const elapsedMinutes = Math.floor((this.now() - this.startedAt) / 60000);
    return Math.max(this.minDormancyGenerations, this.baseDormancyGenerations - elapsedMinutes * this.dormancyDecayPerMinute);
  }

  step(dt = 1 / RULES.hz) {
    if (this.status !== 'playing') return;
    this.expireCardEffects();
    const evolutionStart = this.metrics ? this.metrics.now() : 0;
    this.generation++;
    evolve(this);

    if (this.metrics) this.metrics.duration('evolution.ms', evolutionStart, this.generation);
    this.resolveObjectives();
    this.dormancy.update(this, this.currentDormancyGenerations(), RULES.dormancyWarning);
    const energyStart = this.metrics ? this.metrics.now() : 0;
    for (const p of this.players) {
      p.nodes = this.nodes.filter(n => n.owner === p.id).length;
      if (!p.eliminated) p.energy = Math.min(this.energyCap(p.id), p.energy + (RULES.regen + p.nodes * RULES.nodeRegen) * (this.buff(p.id, 'regen')?.multiplier ?? 1));
    }
    if (this.metrics) this.metrics.duration('energy.ms', energyStart, this.generation);
    this.checkVictory();
    this.checkCardDraw();
  }

  nearby(x, y, radius, callback) {
    if (Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(radius) && radius >= 0) {
      for (const key of this.circleIndex.keys(x,y,radius)) if (this.board[key]) callback(this.board[key],key);
      return;
    }
    for (let yy = Math.max(0, y - radius); yy <= Math.min(this.size - 1, y + radius); yy++) {
      for (let xx = Math.max(0, x - radius); xx <= Math.min(this.size - 1, x + radius); xx++) {
        if (dist2(x, y, xx, yy) > radius * radius) continue;
        const key = yy * this.size + xx;
        if (this.board[key]) callback(this.board[key], key);
      }
    }
  }

  resolveObjectives() {
    if (this.status !== 'playing') return;
    let deleted = false;
    // Damage uses ownership at the beginning of the settlement; all bases settle together.
    const tick = Math.max(0, Math.floor((this.now() - this.startedAt) / 1000 - RULES.nodeDamageStartSeconds));
    const previousTick = this.nodeDamageTick;
    const elapsed = Math.max(0, tick - previousTick);
    this.nodeDamageTick = Math.max(tick, this.nodeDamageTick);
    if (elapsed) {
      const controlled = this.players.map(p => p.eliminated ? 0 : this.nodes.filter(n => n.owner === p.id).length);
      const total = controlled.reduce((a,b)=>a+b,0);
      for (const p of this.players) if (!p.eliminated) {
        const origin = this.startedAt + RULES.nodeDamageStartSeconds*1000;
        let covered=0, last=previousTick;
        for (const period of this.nodeShieldPeriods.filter(e=>e.playerId===p.id)) {
          const first=Math.max(previousTick+1,Math.ceil((period.startsAt-origin)/1000));
          const end=Math.min(tick,Math.ceil((period.endsAt-origin)/1000)-1);
          if(end>=first){covered+=Math.max(0,end-Math.max(last,first-1));last=Math.max(last,end);}
        }
        const damage = (total - controlled[p.id - 1]) * RULES.nodeDamagePerSecond * (elapsed-covered);
        if (damage) { p.hp = Math.max(0, Math.round((p.hp-damage)*1000000)/1000000); this.event('node_damage',p.id,`节点压制造成 ${+damage.toFixed(2)} 伤害`); }
      }
    }
    this.nodeShieldPeriods = this.nodeShieldPeriods.filter(e=>e.endsAt>this.now());
    for (const n of this.nodes) {
      let mask = 0;
      this.nearby(n.x, n.y, RULES.captureRadius, owner => { mask |= 1 << owner; });
      const contestedClaim = n.claimant && (mask & (1 << n.claimant)) && this.buff(n.claimant, 'contest');
      if (mask && ((mask & (mask - 1)) === 0 || contestedClaim)) {
        const owner = (mask & (mask - 1)) === 0 ? Math.log2(mask) : n.claimant;
        if (owner === n.owner) { n.progress = Math.max(0, n.progress - 1); if (!n.progress) n.claimant = 0; continue; }
        if (n.claimant !== owner) { n.claimant = owner; n.progress = 0; }
        n.progress += this.buff(owner, 'capture')?.multiplier ?? 1;
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
        if (owner !== p.id) { this.writeCell(key, 0, 'core'); this.players[owner - 1].cells--; hits++; deleted = true; }
      });
      if (hits && !this.buff(p.id, 'shield')) { p.hp = Math.max(0, p.hp - hits); this.event('damage', p.id, `基地受到 ${hits} 点伤害`); }
    }
    // Resolve all impact damage before clearing eliminated factions so simultaneous
    // core destruction is fair and may end in a draw.
    for (const p of this.players) if (!p.hp && !p.eliminated) { this.eliminate(p.id, true); deleted = true; }
    if (this.metrics) this.metrics.record('objectives.cleanupVisited', deleted ? this.alive.length : 0, this.generation);
    if (deleted) this.compactAlive();
  }

  compactAlive() {
    // Stable in-place compaction: AI and packet/small-map order are observable.
    if (this.metrics) this.metrics.record('alive.compactionVisited', this.alive.length, this.generation);
    this.alive.compact(this.board);
  }

  event(type, player, text) { this.events.push({ type, player, text, generation: this.generation, time: Date.now() }); if (this.events.length > 20) this.events.shift(); }

  eliminate(id, deferCompaction = false) {
    if (this.status !== 'playing') return;
    const p = this.players.find(p => p.id === id);
    if (!p || p.eliminated) return;
    p.eliminated = true; p.hp = 0; p.cells = 0;
    this.cards.hand[id - 1] = [];
    this.cards.effects = this.cards.effects.filter(e => e.playerId !== id);
    if (this.cardDraft) {
      this.cardDraft.players = this.cardDraft.players.filter(e => e.playerId !== id);
      if (this.cardDraft.players.every(e => e.picked)) this.cardDraft = null;
    }
    for (const key of this.alive) if (this.board[key] === id) { this.writeCell(key, 0, 'eliminate'); }
    if (!deferCompaction) this.compactAlive();
    for (const n of this.nodes) { if (n.owner === id) n.owner = 0; if (n.claimant === id) { n.claimant = 0; n.progress = 0; } }
    this.event('eliminated', id, `${p.name} 的核心已被摧毁`);
  }

  checkVictory() {
    if (this.status !== 'playing') return;
    const survivors = this.players.filter(p => !p.eliminated);
    if (survivors.length <= 1) { this.status = 'finished'; this.winner = survivors[0]?.id ?? 0; this.event('victory', this.winner, '对局结束'); }
  }

  buff(id, stat) {
    return this.cards.effects.find(e => e.playerId === id && e.stat === stat && e.endsAt > this.now());
  }
  energyCap(id) { return RULES.maxEnergy + (this.buff(id, 'maxEnergy')?.amount ?? 0); }
  playerCapacity(id) { return RULES.playerCells + (this.buff(id, 'capacity')?.amount ?? 0); }

  expireCardEffects() {
    const now = this.now();
    this.cards.effects = this.cards.effects.filter(e => e.endsAt > now);
    this.localRules = this.localRules.filter(e => e.endsAt > now);
    if (this.ruleOverride?.endsAt <= now) this.ruleOverride = null;
    if (this.pendingRule && this.pendingRule.startsAt <= now) {
      const rule = this.pendingRule;
      this.ruleOverride = { ...rule, endsAt: now + rule.seconds * 1000 };
      this.pendingRule = null;
      this.event('card', rule.playerId, `法则生效：${rule.name}`);
    }
    for (const p of this.players) p.energy = Math.min(p.energy, this.energyCap(p.id));
  }

  drawThreeCards(playerId, pool = 'early') {
    // One choice per dimension, without rejection sampling or RNG-dependent short hands.
    return ['law', 'buff', 'item'].map(type => {
      const choices = CARDS.filter(c => c.pool === pool && c.type === type);
      return materializeCard(choices[Math.min(choices.length - 1, Math.floor(this.random() * choices.length))], this.random);
    });
  }

  acquireCard(card) { return {...card, instanceId:String(++this.cardSerial)}; }

  finishDraft() {
    if (!this.cardDraft) return;
    for (const entry of this.cardDraft.players) {
      if (!entry.picked && !this.players[entry.playerId - 1].eliminated) {
        this.cards.hand[entry.playerId - 1].push(this.acquireCard(entry.options.find(c => c.type === 'buff') || entry.options[0]));
      }
    }
    this.cardDraft = null;
  }

  checkCardDraw() {
    if (this.status !== 'playing') return;
    const now = this.now();
    if (this.cardDraft && now >= this.cardDraft.deadlineAt) this.finishDraft();
    if (this.cardDrawTimes.length && now - this.startedAt >= this.cardDrawTimes[0]) {
      this.finishDraft(); // A disconnected player can never block the next round.
      this.cardDrawTimes.shift();
      const pool = ['early', 'mid', 'late'][Math.min(this.drawCount++, 2)];
      const draft = this.cardDraft = {
        gen: this.generation, round: this.drawCount, deadlineAt: now + CARD_CONFIG.draftSeconds * 1000,
        players: this.players.filter(p => !p.eliminated).map(p => ({ playerId: p.id, options: this.drawThreeCards(p.id, pool), picked: false }))
      };
      this.event('card', 0, `第 ${this.drawCount} 轮卡牌征召：法则 / 增益 / 道具三选一`);
      for (const entry of draft.players) if (this.players[entry.playerId - 1].bot) {
        this.pickCard(entry.playerId, entry.options[Math.floor(this.random() * entry.options.length)].id);
      }
    }
  }

  pickCard(playerId, cardId) {
    const p = this.players[playerId - 1];
    if (this.status !== 'playing' || !p || p.eliminated) return { error: '当前无法选卡' };
    if (this.cardDraft && this.now() >= this.cardDraft.deadlineAt) this.finishDraft();
    const entry = this.cardDraft?.players.find(d => d.playerId === playerId);
    if (!entry || entry.picked) return { error: '当前没有待选择的卡牌' };
    const card = entry.options.find(c => c.id === cardId);
    if (!card) return { error: '无效卡牌' };
    // Each draft adds one card; identical cards remain separate copies.
    entry.picked = true;
    this.cards.hand[playerId - 1].push(this.acquireCard(card));
    if (this.cardDraft.players.every(d => d.picked)) this.cardDraft = null;
    return { ok: true, card };
  }

  addCardCells(playerId, positions) {
    const p = this.players[playerId - 1], keys = new Set();
    for (const [x, y] of positions) {
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= this.size || y >= this.size) return { error: '播种区域超出地图' };
      if (this.players.some(e => e.id !== playerId && !e.eliminated && dist2(e.x, e.y, x, y) <= Math.max(28, RULES.baseHitRadius) ** 2)) return { error: '不能向敌方核心保护区播种' };
      const key = y * this.size + x;
      if (this.board[key]) return { error: '播种位置存在活细胞' };
      keys.add(key);
    }
    if (!keys.size) return { error: '目标区域没有可播种的空格' };
    if (p.cells + keys.size > this.playerCapacity(playerId)) return { error: '播种超过活细胞容量' };
    this.dormancy.invalidate(keys);
    for (const key of keys) { this.writeCell(key, playerId, 'seed'); this.alive.push(key); }
    p.cells += keys.size;
    return { ok: true };
  }

  playCard(playerId, cardId, x, y, instanceId) {
    if (this.status !== 'playing') return { error: '对局已结束' };
    const p = this.players.find(p => p.id === playerId);
    if (!p || p.eliminated) return { error: '无法使用卡牌' };
    const hand = this.cards.hand[playerId - 1];
    const handIndex = hand.findIndex(c => c.id === cardId && (instanceId === undefined || c.instanceId === instanceId));
    if (handIndex < 0) return { error: '手牌中没有这张卡' };
    const card = materializeCard(hand[handIndex], this.random);
    if (!card) return { error: '无效卡牌' };
    const eff = card.effect, now = this.now();
    if (isTargetedCard(card) && (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= this.size || y >= this.size)) return { error: '请选择地图内的目标位置' };
    this.expireCardEffects();
    switch (eff.kind) {
      case 'rule': {
        this.pendingRule = { cardId, name: card.name, playerId, seconds: eff.seconds, birth: new Set(eff.birth), survival: new Set(eff.survival), startsAt: now + CARD_CONFIG.lawWarningSeconds * 1000 };
        break;
      }
      case 'inheritance': {
        this.cards.effects = this.cards.effects.filter(e => e.playerId !== playerId || e.stat !== 'birthPriority');
        this.cards.effects.push({cardId,name:card.name,playerId,stat:'birthPriority',endsAt:now+eff.seconds*1000});
        break;
      }
      case 'buff': {
        if (eff.stat === 'shield') this.nodeShieldPeriods.push({playerId,startsAt:now,endsAt:now+eff.seconds*1000});
        this.cards.effects = this.cards.effects.filter(e => e.playerId !== playerId || e.stat !== eff.stat);
        this.cards.effects.push({ ...eff, ...(eff.capacityFraction ? {amount:Math.round(RULES.maxEnergy*eff.capacityFraction)} : {}), cardId, name: card.name, playerId, endsAt: now + eff.seconds * 1000 });
        if (eff.refill) p.energy = this.energyCap(playerId);
        if (eff.energyFraction) p.energy = Math.min(this.energyCap(playerId),p.energy+Math.round(RULES.maxEnergy*eff.energyFraction));
        break;
      }
      case 'energy': p.energy = eff.full ? this.energyCap(playerId) : Math.min(this.energyCap(playerId), p.energy + (eff.fraction ? Math.round(RULES.maxEnergy*eff.fraction) : eff.amount)); break;
      case 'repair': p.hp = Math.min(RULES.baseHP, p.hp + (eff.fraction ? Math.round(RULES.baseHP*eff.fraction) : eff.amount)); break;
      case 'localRule': {
        if (this.localRules.length >= 8) return { error: '局部法则数量已达上限' };
        this.localRules.push({ cardId, name: card.name, playerId, x, y, radius: eff.radius, birth: new Set(eff.birth), survival: new Set(eff.survival), endsAt: now + eff.seconds * 1000 });
        break;
      }
      case 'purge': {
        const removed = new Set();
        this.nearby(x, y, eff.radius, (owner, key) => {
          this.writeCell(key, 0, 'purge'); this.players[owner - 1].cells--; removed.add(key);
        });
        this.compactAlive();
        this.dormancy.invalidate(removed);
        break;
      }
      case 'seed': {
        const ox = x - Math.floor(Math.max(...eff.pattern.map(c => c[0])) / 2);
        const oy = y - Math.floor(Math.max(...eff.pattern.map(c => c[1])) / 2);
        const result = this.addCardCells(playerId, eff.pattern.map(([dx, dy]) => [ox + dx, oy + dy]));
        if (result.error) return result;
        break;
      }
      case 'nebula': {
        // Validate the full footprint before sampling, so RNG cannot bypass core protection.
        if (x - eff.radius < 0 || y - eff.radius < 0 || x + eff.radius >= this.size || y + eff.radius >= this.size) return { error: '星云圆域必须完整位于地图内' };
        if (this.players.some(e => e.id !== playerId && !e.eliminated && Math.hypot(e.x - x, e.y - y) <= Math.max(28, RULES.baseHitRadius) + eff.radius)) return { error: '星云不能接触敌方核心保护区' };
        const empty = [], cells = [];
        for (let yy = y - eff.radius; yy <= y + eff.radius; yy++) for (let xx = x - eff.radius; xx <= x + eff.radius; xx++) {
          if (dist2(x, y, xx, yy) > eff.radius ** 2 || this.board[yy * this.size + xx]) continue;
          empty.push([xx, yy]);
          if (this.random() < eff.density) cells.push([xx, yy]);
        }
        if (!cells.length && empty.length) cells.push(empty[0]);
        const result = this.addCardCells(playerId, cells);
        if (result.error) return result;
        break;
      }
      default: return { error: '该卡牌效果尚未实现' };
    }
    hand.splice(handIndex, 1);
    this.event('card', playerId, `${eff.kind === 'rule' ? '法则预告' : '使用卡牌'}：${card.name}`);
    return { ok: true };
  }


  packetV2({roomEpoch,baseGeneration,previous,snapshot=false,forceOrdered=false}) {
    return encodeBoardV2({keys:snapshot?this.alive.keys.subarray(0,this.alive.length):this.changes.order.subarray(0,this.changes.size),
      ownerAt:snapshot?key=>this.board[key]:key=>this.changes.owners[key],board:this.board,previous,
      generation:this.generation,roomEpoch,baseGeneration,snapshot,forceOrdered});
  }

  packet(snapshot = false) {
    const length = snapshot ? this.alive.length : this.changes.size;
    const result = new ArrayBuffer(8 + length * 4), view = new DataView(result);
    view.setUint32(0, snapshot ? 1 : 0, true); view.setUint32(4, this.generation, true);
    let offset = 8;
    if (snapshot) {
      for (const key of this.alive) { view.setUint32(offset, key + this.board[key] * 1000000, true); offset += 4; }
    } else {
      for (let i = 0; i < this.changes.size; i++) { const key = this.changes.order[i]; view.setUint32(offset, key + this.changes.owners[key] * 1000000, true); offset += 4; }
    }
    return result;
  }

  state(viewerId = null) {
    const now = this.now();
    const serializeRule = rule => rule ? { ...rule, birth: [...rule.birth], survival: [...rule.survival] } : null;
    const draft = this.cardDraft ? { ...this.cardDraft, players: this.cardDraft.players.filter(e => viewerId === null || e.playerId === viewerId) } : null;
    return {
      type: 'state',
      serverTime: now,
      generation: this.generation,
      status: this.status,
      winner: this.winner,
      players: this.players.map(p => ({ ...p, energyCap: this.energyCap(p.id), capacity: this.playerCapacity(p.id), regenMultiplier: this.buff(p.id, 'regen')?.multiplier ?? 1, deployMultiplier: this.buff(p.id, 'deployCost')?.multiplier ?? 1, freeDeployBudget: this.buff(p.id, 'freeDeploy') ? Math.floor(RULES.maxEnergy*this.buff(p.id, 'freeDeploy').discountFraction) : null, neutralDeploy: !!this.buff(p.id, 'neutralDeploy') })),
      nodes: this.nodes,
      events: this.events,
      dormancy: this.dormancy.warnings || [],
      dormancyThreshold: this.currentDormancyGenerations(),
      cardDraft: draft,
      nodePressure: { startsAt:this.startedAt+RULES.nodeDamageStartSeconds*1000, perNode:RULES.nodeDamagePerSecond },
      nextCardAt: this.cardDrawTimes.length ? this.startedAt + this.cardDrawTimes[0] : null,
      ruleOverride: serializeRule(this.ruleOverride),
      pendingRule: serializeRule(this.pendingRule),
      localRules: this.localRules.map(serializeRule),
      cards: { hand: this.cards.hand.map((c, i) => viewerId === null || i + 1 === viewerId ? c : null), effects: this.cards.effects.filter(e => e.endsAt > now) }
    };
  }
}
