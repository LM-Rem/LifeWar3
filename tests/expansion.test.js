import test from 'node:test';
import assert from 'node:assert/strict';
import {Game,RULES} from '../src/engine.js';
import {CARDS,CARD_CONFIG,materializeCard,validateCardConfig} from '../public/cards.js';
const make=(n=2)=>{let now=0;const g=new Game(Array.from({length:n},(_,i)=>({name:'P'+i})),{now:()=>now,cardDrawTimes:[],random:()=>.5});return {g,time:t=>now=t};};
const put=(g,x,y,owner=1)=>{const k=y*g.size+x;if(!g.board[k]){g.board[k]=owner;g.alive.push(k);g.rebuildDerivedState();g.players[owner-1].cells++;}};
const play=(g,id,owner=1)=>{g.cards.hand[owner-1].push(CARDS.find(c=>c.id===id));assert.ok(g.playCard(owner,id).ok);};

test('node pressure starts after ten minutes, scales per enemy node and uses real seconds once',()=>{
 const {g,time}=make(4);g.nodes[0].owner=1;g.nodes[1].owner=1;g.nodes[2].owner=2;
 time(600000);g.resolveObjectives();assert.ok(g.players.every(p=>p.hp===RULES.baseHP));
 time(600999);g.resolveObjectives();assert.equal(g.players[0].hp,RULES.baseHP);
 time(601000);g.resolveObjectives();assert.deepEqual(g.players.map(p=>p.hp),[239.9,239.8,239.7,239.7]);
 g.resolveObjectives();assert.equal(g.players[0].hp,239.9);
 g.nodes[0].owner=2;time(602000);g.resolveObjectives();assert.equal(g.players[0].hp,239.7);
 play(g,'shield',1);time(603000);g.resolveObjectives();assert.equal(g.players[0].hp,239.7);
 time(610000);g.resolveObjectives();assert.equal(g.players[0].hp,239.5);
});

test('node pressure resolves lethal damage simultaneously and finished games stay immutable',()=>{
 const {g,time}=make();g.nodes[0].owner=1;g.nodes[1].owner=2;g.players.forEach(p=>p.hp=.1);
 time(601000);g.resolveObjectives();g.checkVictory();assert.equal(g.status,'finished');assert.equal(g.winner,0);
 assert.ok(g.players.every(p=>p.eliminated));time(700000);g.resolveObjectives();assert.ok(g.players.every(p=>p.hp===0));
});

test('inheritance overrides minority births, requires own neighbors, cancels across opponents and expires',()=>{
 for(const mode of ['single','opposed','expired','absent','thirdParty']){
  const {g,time}=make(3);put(g,499,500,mode==='absent'?2:1);put(g,500,499,2);put(g,501,500,2);
  play(g,'inheritance',1);if(mode==='opposed')play(g,'inheritance',2);if(mode==='thirdParty')play(g,'inheritance',3);
  if(mode==='expired')time(20000);g.step();assert.equal(g.board[500500],mode==='single'?1:2,mode);
 }
 const {g,time}=make();play(g,'inheritance');time(10000);play(g,'inheritance');assert.equal(g.cards.effects.filter(e=>e.stat==='birthPriority').length,1);
 assert.equal(g.buff(1,'birthPriority').endsAt,30000);g.eliminate(1);assert.equal(g.buff(1,'birthPriority'),undefined);
});

test('weighted laws resolve exact probability intervals and preserve the drawn rule on play',()=>{
 const template=CARDS.find(c=>c.id==='random_law'),total=template.effect.variants.reduce((s,v)=>s+v.weight,0);let sum=0;
 for(const v of template.effect.variants){
  const c=materializeCard(template,()=> (sum+v.weight/2)/total);sum+=v.weight;
  assert.deepEqual(c.effect.birth,v.birth);assert.deepEqual(c.effect.survival,v.survival);
  const {g,time}=make();g.cards.hand[0]=[c];g.random=()=>.9999;assert.ok(g.playCard(1,c.id).ok);time(1000);g.step();
  assert.deepEqual([...g.ruleOverride.birth],v.birth);assert.deepEqual([...g.ruleOverride.survival],v.survival);
 }
 for(const mutate of [d=>d.cards.find(c=>c.id==='random_law').effect.variants[0].birth.push(0),d=>d.cards.find(c=>c.id==='random_law').effect.variants[0].weight=0]){const d=structuredClone(CARD_CONFIG);mutate(d);assert.throws(()=>validateCardConfig(d));}
});

test('evolution exceeds personal and former global caps; other players can still deploy and deltas match',()=>{
 const {g}=make();g.birthRule=new Set([1,2,3,4,5,6,7,8]);g.survivalRule=new Set([0,1,2,3,4,5,6,7,8]);
 for(let y=300;y<500;y++)for(let x=300;x<500;x++)put(g,x,y);
 const board=g.board.slice();g.changes.clear();g.step();assert.equal(g.alive.length,40804);assert.equal(g.players[0].cells,40804);
 assert.ok(g.deploy(1,200,200,[[0,0]]).error);assert.ok(g.deploy(2,800,800,[[0,0]]).ok);
 const view=new DataView(g.packet());for(let i=8;i<view.byteLength;i+=4){const v=view.getUint32(i,true);board[v%1000000]=Math.floor(v/1000000);}assert.deepEqual(board,g.board);
});

test('discount has a bounded budget; energy and repair scale with configured limits',()=>{
 const {g}=make();play(g,'flash_deploy');g.players[0].energy=100;
 const cells=Array.from({length:100},(_,i)=>[i%10,Math.floor(i/10)]);
 assert.equal(g.deploy(1,200,200,cells).cost,10);
 g.players[0].energy=0;play(g,'energy_burst');assert.equal(g.players[0].energy,63);
 g.players[0].hp=1;play(g,'repair');assert.equal(g.players[0].hp,61);
});


test('different random variants of the same card are played by instance identity',()=>{
 const {g,time}=make(),template=CARDS.find(c=>c.id==='random_law');
 const first=g.acquireCard(materializeCard(template,()=>0));const second=g.acquireCard(materializeCard(template,()=>.99));
 g.cards.hand[0]=[first,second];assert.notEqual(first.instanceId,second.instanceId);
 assert.ok(g.playCard(1,second.id,undefined,undefined,'missing').error);
 assert.ok(g.playCard(1,second.id,undefined,undefined,second.instanceId).ok);
 time(1000);g.step();assert.deepEqual([...g.ruleOverride.birth],second.effect.birth);
 assert.deepEqual(g.cards.hand[0],[first]);
});


test('every weighted rule obeys the complete B/S truth table including isolated cells',()=>{
 const template=CARDS.find(c=>c.id==='random_law');
 for(const variant of template.effect.variants)for(let n=0;n<=8;n++){
  const {g}=make();g.birthRule=new Set(variant.birth);g.survivalRule=new Set(variant.survival);
  const neighbors=[[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
  put(g,300,300);for(const [dx,dy] of neighbors.slice(0,n)){put(g,300+dx,300+dy);put(g,600+dx,600+dy);}
  g.step();assert.equal(!!g.board[300300],variant.survival.includes(n));assert.equal(!!g.board[600600],variant.birth.includes(n));
 }
});
