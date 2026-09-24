import { sparseCandidates } from './sparse.js';
import { denseCandidates } from './dense.js';
import { ruleMask } from './rule-table.js';
export function evolve(game) {
  const mode=game.backendSelector.select(game);
  game.lastBackend=mode;
  const length=(mode==='dense'?denseCandidates:sparseCandidates).call(game);
  settle.call(game,length);
}
function settle(length) {
  const {board,next,candidates,size,votes,counts}=this,stamp=this.generation;
    let birthSet = this.birthRule, survivalSet = this.survivalRule;
    if (this.ruleOverride) { birthSet = this.ruleOverride.birth; survivalSet = this.ruleOverride.survival; }
    const birthMask=ruleMask(birthSet),survivalMask=ruleMask(survivalSet);
    this.localIndex.prepare(this.localRules);
    this.lastCandidateCount = length; // O(1) diagnostic; never changes candidate order.
    next.fill(0);
    const nextAlive = this.spareAlive; nextAlive.length = 0;
    const totals = [0, 0, 0, 0, 0];
    const inheritance = this.cards.effects.filter(e => e.stat === 'birthPriority' && e.endsAt > this.now());
    const priorityOwner = inheritance.length === 1 ? inheritance[0].playerId : 0;
    for (let i = 0; i < length; i++) {
      const key = candidates[i], count = counts[key];
      let owner = board[key];
      const local = this.localIndex.active ? this.localIndex.at(key) : null;
      if (!owner && !((local?.birth ?? birthMask) & (1 << count))) continue;
      if (owner && !((local?.survival ?? survivalMask) & (1 << count))) continue;
      if (!owner) {
        let max = 0;
        for (let t = 0; t < 4; t++) {
          const team = ((t + key + stamp) % 4) + 1, n = (votes[key] >> ((team - 1) * 4)) & 15;
          if (n > max) { max = n; owner = team; }
        }
        if (priorityOwner && ((votes[key] >> ((priorityOwner - 1) * 4)) & 15)) owner = priorityOwner;
      }
      if (!owner) continue;
      next[key] = owner; nextAlive.push(key); totals[owner]++;
    }
    let changedCount = 0;
    for (let i = 0; i < length; i++) if (next[candidates[i]] !== board[candidates[i]]) changedCount++;
    if (this.dormancy.mode === 'auto' && changedCount > Math.max(256, nextAlive.length / 4)) this.dormancy.dirty = true;
    for (let i = 0; i < length; i++) {
      const key = candidates[i];
      if (next[key] !== board[key]) this.recordChange(key, board[key], next[key], 'evolution');
    }
    this.board = next; this.next = board; this.spareAlive = this.alive; this.alive = nextAlive;
    for (const p of this.players) p.cells = totals[p.id];
}
