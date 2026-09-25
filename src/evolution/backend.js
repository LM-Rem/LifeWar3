import { sparseCandidates } from './sparse.js';
import { denseCandidates } from './dense.js';
import { evolutionRules } from './rule-table.js';
import { Frontier } from './frontier.js';
export function evolve(game) {
  const mode=game.backendSelector.select(game);
  game.lastBackend=mode;
  if(mode==='frontier'){
    const frontier=game.frontier??=new Frontier(game),{length,rebuild}=frontier.begin(game);
    if(rebuild){game.lastBackend='frontier-rebuild';settle.call(game,length,frontier);frontier.result.set(game.board);}
    else frontier.settle(game,length);
    return;
  }
  game.frontier?.invalidate();
  const length=(mode==='dense'?denseCandidates:sparseCandidates).call(game);
  settle.call(game,length);
}
function settle(length,frontier) {
  const {board,next,candidates,size,votes,counts}=this,stamp=this.generation;
    const context=evolutionRules(this),{birthMask,survivalMask,priorityOwner}=context;
    frontier?.rememberRules(this,context);
    this.lastCandidateCount = length; // O(1) diagnostic; never changes candidate order.
    next.fill(0);
    const nextAlive = this.spareAlive; nextAlive.length = 0;
    const totals = [0, 0, 0, 0, 0];
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
    commitEvolution(this,length,nextAlive,totals);
}

export function commitEvolution(game,length,nextAlive,totals) {
    const {board,next,candidates}=game;
    let changedCount = 0;
    for (let i = 0; i < length; i++) if (next[candidates[i]] !== board[candidates[i]]) changedCount++;
    if (game.dormancy.mode === 'auto' && changedCount > Math.max(256, nextAlive.length / 4)) game.dormancy.dirty = true;
    game.frontier?.prepareChanges(changedCount,nextAlive.length);
    for (let i = 0; i < length; i++) {
      const key = candidates[i];
      if (next[key] !== board[key]) game.recordChange(key, board[key], next[key], 'evolution');
    }
    game.board = next; game.next = board; game.spareAlive = game.alive; game.alive = nextAlive;
    for (const p of game.players) p.cells = totals[p.id];
}
