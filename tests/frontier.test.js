import test from 'node:test';
import assert from 'node:assert/strict';
import {Game} from '../src/engine.js';
import {Game as ReferenceGame} from './reference/src/engine.js';
import {OrderedCells} from '../src/ordered-cells.js';
import {LocalRuleIndex} from '../src/evolution/rule-table.js';
import {randomSource} from './helpers/load-fixture.js';
import {replay} from './helpers/replay.js';
import {runBots} from '../src/bots.js';
import {runBots as referenceBots} from './reference/src/bots.js';
import {CARDS} from '../public/cards.js';

class FrontierGame extends Game {constructor(...args){super(...args);this.backendSelector.mode='frontier';}}
function small(Type,size=24){
 const g=new Type([1,2,3,4].map(i=>({name:'P'+i})),{random:randomSource(7),now:()=>0});g.size=size;
 for(const [name,T] of Object.entries({board:Uint8Array,next:Uint8Array,counts:Uint8Array,votes:Uint16Array,marks:Uint32Array,candidates:Uint32Array}))g[name]=new T(size*size);
 g.alive=g instanceof Game?new OrderedCells(size*size):[];g.spareAlive=new OrderedCells(size*size);g.localIndex=new LocalRuleIndex(size);
 g.resolveObjectives=()=>{};g.dormancy.update=()=>{};g.checkVictory=()=>{};g.checkCardDraw=()=>{};return g;
}
function equal(a,b,label=''){assert.deepEqual(b.board,a.board,label);assert.deepEqual([...b.alive],[...a.alive],label+' alive');assert.deepEqual([...b.changes],[...a.changes],label+' changes');assert.deepEqual(Buffer.from(b.packet()),Buffer.from(a.packet()));assert.deepEqual(Buffer.from(b.packet(true)),Buffer.from(a.packet(true)));}
function load(g,cells){g.board.fill(0);g.alive.length=0;g.changes.clear();g.marks.fill(0);for(const [k,o]of cells){g.board[k]=o;g.alive.push(k);}g.rebuildDerivedState?.();}
function countCheck(g){if(!g.frontier.valid)return;for(let k=0;k<g.board.length;k++){let n=0,v=0;const x=k%g.size,y=Math.floor(k/g.size);for(let yy=Math.max(0,y-1);yy<=Math.min(g.size-1,y+1);yy++)for(let xx=Math.max(0,x-1);xx<=Math.min(g.size-1,x+1);xx++){if(xx===x&&yy===y)continue;const o=g.board[yy*g.size+xx];if(o){n++;v+=1<<((o-1)*4);}}assert.equal(g.counts[k],n,'count '+k);assert.equal(g.votes[k],v,'vote '+k);}}

test('frontier matches all 512 B/S masks across cached steps, four-owner votes, inheritance and local edits',()=>{
 const a=small(ReferenceGame),b=small(FrontierGame),rand=randomSource(91);
 for(let mask=0;mask<512;mask++){
  const cells=[];for(let k=0;k<576;k++)if(rand()<.2)cells.push([k,Math.floor(rand()*4)+1]);cells.reverse();
  for(const g of [a,b]){load(g,cells);g.birthRule=new Set(Array.from({length:9},(_,n)=>n).filter(n=>mask&(1<<n)));g.survivalRule=new Set(Array.from({length:9},(_,n)=>n).filter(n=>(511^mask)&(1<<n)));g.cards.effects=mask%3?[{stat:'birthPriority',playerId:mask%4+1,endsAt:100}]:[];if(mask%3===2)g.cards.effects.push({stat:'birthPriority',playerId:2,endsAt:100});}
  for(let step=0;step<4;step++){a.step();b.step();equal(a,b,`${mask}/${step}`);countCheck(b);a.changes.clear();b.changes.clear();}
 }
});

test('persistent counts handle external writes, overlapping local invalidation, ties and global changes for 1000 generations',()=>{
 const a=small(ReferenceGame,32),b=small(FrontierGame,32),rand=randomSource(5);
 const cells=Array.from({length:100},(_,i)=>[i*37%1024,i%4+1]);for(const g of [a,b])load(g,cells);
 for(let i=0;i<1000;i++){
  for(let j=0;j<3;j++){
   const k=Math.floor(rand()*1024),o=Math.floor(rand()*5);
   for(const g of [a,b]){const old=g.board[k];if(g===b)g.writeCell(k,o,'test-external');else{g.board[k]=o;g.changes.set(k,o);}if(o&&!old)g.alive.push(k);if(!o){if(g===b)g.alive.compact(g.board);else g.alive=g.alive.filter(k=>g.board[k]);}}
  }
  for(const g of [a,b]){
   if(i%19===0){g.birthRule=new Set([i%9,3]);g.survivalRule=new Set([0,2,3]);}
   if(i%23===0)g.localRules=[{x:8,y:8,radius:5,birth:new Set([2,3]),survival:new Set([0,2,3]),endsAt:1000},{x:10,y:9,radius:4,birth:new Set([1]),survival:new Set([1,2]),endsAt:1000}];
   if(i%23===5){g.localRules[0].birth.add(1);g.localRules[0].x+=1;}
   if(i%23===9)g.localRules=[];
   if(i%31===0)g.cards.effects=[{stat:'birthPriority',playerId:i%4+1,endsAt:1000}];
   if(i%31===7)g.cards.effects=[];
   if(i%41===0)g.ruleOverride={birth:new Set([2,3]),survival:new Set([0,1,2,3]),endsAt:1000};
   if(i%41===6)g.ruleOverride=null;
  }
  a.step();b.step();equal(a,b,'generation '+i);countCheck(b);a.changes.clear();b.changes.clear();
 }
});

test('stable S0, candidate-only B0, moving glider and wrap preserve alive ordering without freezing ties',()=>{
 // The frozen initial engine has a Uint32 stamp overflow bug. Compare wrap
 // against the current sparse implementation, which already fixes that bug.
 const a=small(Game,32),b=small(FrontierGame,32);
 const cells=[[0,1],[100,2],[101,2],[132,2],[133,2],[330,1],[363,2],[393,3],[394,4],[395,1]];
 for(const g of [a,b]){load(g,cells);g.survivalRule.add(0);g.birthRule.add(0);g.generation=0xfffffffa;}
 for(let i=0;i<30;i++){a.step();b.step();equal(a,b);countCheck(b);a.changes.clear();b.changes.clear();}
 assert.ok(b.frontier.evaluated<b.lastCandidateCount);
});

test('backend switches, high-D fallback and bulk fixture invalidation rebuild before reuse',()=>{
 const a=small(ReferenceGame,40),b=small(FrontierGame,40),rand=randomSource(3),cells=[];
 for(let k=0;k<1600;k++)if(rand()<.5)cells.push([k,k%4+1]);for(const g of [a,b]){load(g,cells);g.birthRule=new Set([1,3,5,7]);g.survivalRule=new Set([1,3,5,7]);}
 for(let i=0;i<40;i++){b.backendSelector.mode=['frontier','frontier','sparse','frontier','dense'][i%5];a.step();b.step();equal(a,b);if(b.backendSelector.mode==='frontier')countCheck(b);a.changes.clear();b.changes.clear();}
 assert.ok(b.frontier.fallbacks>0);assert.ok(b.frontier.rebuilds>1);
 for(const g of [a,b])load(g,[[0,1],[1,1],[40,1],[41,1]]);b.backendSelector.mode='frontier';a.step();b.step();equal(a,b);countCheck(b);
});

test('full production replay matches initial engine through dormancy, local expiry, deployments, elimination and AI',()=>{
 const cells=[];for(let y=445;y<465;y++)for(let x=445;x<465;x++)if((x+y)%3)cells.push([y*1000+x,x%2+1]);
 replay({ReferenceGame,Game:FrontierGame,generations:160,cells,referenceBots,bots:runBots,setup:g=>{g.localRules=Array.from({length:8},(_,i)=>({x:450+i,y:450,radius:5+i,birth:new Set([2,3]),survival:new Set([0,2,3]),endsAt:150+i*100}));},operations:[{seq:1,generation:2,action:'deploy',playerId:1,x:200,y:200,cells:[[0,0],[1,0],[0,1],[1,1]]},{seq:2,generation:150,action:'eliminate',playerId:2}]});
});

test('default auto remains sparse and allocates no frontier cache',()=>{const g=new Game([{name:'A'},{name:'B'}],{now:()=>0});g.step();assert.equal(g.lastBackend,'sparse');assert.equal(g.frontier,undefined);});

test('purge circle boundary and seed cards preserve cached evolution through actual command paths',()=>{
 const purge=CARDS.find(c=>c.id==='purge'),seed=CARDS.find(c=>c.id==='seed'),cells=[];
 for(const x of [450,450+purge.effect.radius,452+purge.effect.radius])for(const [dx,dy]of [[0,0],[1,0],[0,1],[1,1]])cells.push([(450+dy)*1000+x+dx,1]);
 replay({ReferenceGame,Game:FrontierGame,generations:20,cells,setup:g=>{g.cards.hand[0]=[purge,seed].map(c=>g.acquireCard(c));},operations:[
 {seq:1,generation:3,action:'playCard',playerId:1,cardId:'purge',x:450,y:450},
 {seq:2,generation:4,action:'playCard',playerId:1,cardId:'seed',x:450,y:450}
 ]});
});

test('repeated same-cell owner writes update votes without changing population or net count',()=>{
 const a=small(Game),b=small(FrontierGame);
 for(const g of [a,b]){load(g,[[100,1],[101,1],[124,1],[125,1]]);g.step();}
 for(const owner of [2,3,4,1,1,2])for(const g of [a,b])g.writeCell(100,owner,'test-repeat');
 countCheck(b);a.step();b.step();equal(a,b);countCheck(b);
});

test('dormancy removal and core contact invalidate frontier through production settlement',()=>{
 const block=(x,y,owner=1)=>[[0,0],[1,0],[0,1],[1,1]].map(([dx,dy])=>[(y+dy)*1000+x+dx,owner]);
 replay({ReferenceGame,Game:FrontierGame,cells:[...block(450,450),...block(550,550,2)],generations:35,
  setup:g=>{g.baseDormancyGenerations=20;g.minDormancyGenerations=20;g.dormancyDecayPerMinute=0;}});
 replay({ReferenceGame,Game:FrontierGame,cells:[...block(180,180,2),...block(820,820,1)],generations:4,
  setup:g=>{g.players.forEach(p=>p.hp=3);g.cards.effects.push({playerId:1,stat:'shield',endsAt:500});}});
});
