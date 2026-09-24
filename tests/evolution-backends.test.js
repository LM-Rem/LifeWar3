import test from 'node:test';
import assert from 'node:assert/strict';
import {Game} from '../src/engine.js';
import {Game as ReferenceGame} from './reference/src/engine.js';
import {OrderedCells} from '../src/ordered-cells.js';
import {LocalRuleIndex} from '../src/evolution/rule-table.js';
import {randomSource} from './helpers/load-fixture.js';
import {replay} from './helpers/replay.js';
function resize(game,size=20){
  game.size=size;for(const [name,Type]of Object.entries({board:Uint8Array,next:Uint8Array,counts:Uint8Array,votes:Uint16Array,marks:Uint32Array,candidates:Uint32Array}))game[name]=new Type(size*size);
  game.alive=game instanceof Game?new OrderedCells(size*size):[];
  game.spareAlive=new OrderedCells(size*size);game.localIndex=new LocalRuleIndex(size);
  game.resolveObjectives=()=>{};game.dormancy.update=()=>{};game.checkVictory=()=>{};game.checkCardDraw=()=>{};
}
function equal(a,b){assert.deepEqual(a.board,b.board);assert.deepEqual([...a.alive],[...b.alive]);assert.deepEqual([...a.changes],[...b.changes]);assert.ok(Buffer.from(a.packet()).equals(Buffer.from(b.packet())));}
test('both backends match frozen engine for all B/S masks, S0, B0 candidates, four-way votes and priority',()=>{
  const games=[ReferenceGame,Game,Game].map(Type=>new Type([1,2,3,4].map(i=>({name:String(i)})),{random:randomSource(1),now:()=>0}));
  games.forEach(g=>resize(g));games[1].backendSelector.mode='sparse';games[2].backendSelector.mode='dense';const random=randomSource(19);
  for(let mask=0;mask<512;mask++){
    const cells=[];for(let key=0;key<400;key++)if(random()<.45)cells.push([key,Math.floor(random()*4)+1]);cells.reverse();
    for(const g of games){g.board.fill(0);g.alive.length=0;g.changes.clear();g.marks.fill(0);g.generation=mask%7;
      g.birthRule=new Set(Array.from({length:9},(_,i)=>i).filter(i=>mask&(1<<i)));g.survivalRule=new Set(Array.from({length:9},(_,i)=>i).filter(i=>(mask^511)&(1<<i)));
      g.cards.effects=mask%3?[{stat:'birthPriority',playerId:mask%4+1,endsAt:100}]:[];if(mask%3===2)g.cards.effects.push({stat:'birthPriority',playerId:(mask+1)%4+1,endsAt:100});
      for(const [k,o]of cells){g.board[k]=o;g.alive.push(k);}g.step();
    }
    equal(games[0],games[1]);equal(games[0],games[2]);
  }
});
test('dense and alternating backends preserve full production replay including overlapping local expiry',()=>{
  for(const mode of ['dense','alternate']) {
    class SelectedGame extends Game {step(...args){this.backendSelector.mode=mode==='alternate'?(this.generation%2?'dense':'sparse'):mode;return super.step(...args);}}
    const cells=[];for(let y=445;y<465;y++)for(let x=445;x<465;x++)if((x+y)%3)cells.push([y*1000+x,(x%2)+1]);
    replay({ReferenceGame,Game:SelectedGame,generations:24,cells,setup:g=>{g.localRules=Array.from({length:8},(_,i)=>({x:450+i,y:450,radius:5+i,birth:new Set([2,3]),survival:new Set([0,2,3]),endsAt:150+i*100}));}});
  }
});
