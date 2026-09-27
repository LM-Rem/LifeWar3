import {randomSource} from './load-fixture.js';
// Sustained synthetic workload, not normal card/balance behavior.
export function seedRoomLoad(game) {
  const random=randomSource(91);game.board.fill(0);game.alive.length=0;game.changes.clear();
  for(const p of game.players){p.cells=0;p.hp=1e12;}
  game.birthRule=new Set([1,3,5,7]);game.survivalRule=new Set([1,3,5,7]);
  game.baseDormancyGenerations=game.minDormancyGenerations=1e9;
  for(let key=0;key<game.board.length;key++)if(random()<.5){const owner=key%game.players.length+1;game.board[key]=owner;game.alive.push(key);game.players[owner-1].cells++;}
  game.rebuildDerivedState();
}
export function repeatDraft(game) {
  if(!game.cardDraft || game.cardDraft.players.find(p=>p.playerId===1)?.picked){game.cardDraft=null;game.cardDrawTimes=[0];}
}
