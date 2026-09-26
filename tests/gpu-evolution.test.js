import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/engine.js';
import { OrderedCells } from '../src/ordered-cells.js';
import { LocalRuleIndex } from '../src/evolution/rule-table.js';
import { createGpuEvolution } from '../src/evolution/gpu.js';
import { randomSource } from './helpers/load-fixture.js';
import { replay } from './helpers/replay.js';
import { createServer } from '../src/server.js';

function small(mode) {
  const g = new Game([1,2,3,4].map(i => ({name:String(i)})), { evolutionMode: mode, random: randomSource(9), now: () => 0 });
  g.size = 20;
  for (const [key, Type] of Object.entries({board:Uint8Array,next:Uint8Array,counts:Uint8Array,votes:Uint16Array,marks:Uint32Array,candidates:Uint32Array})) g[key] = new Type(400);
  g.alive = new OrderedCells(400); g.spareAlive = new OrderedCells(400); g.localIndex = new LocalRuleIndex(20);
  g.resolveObjectives = g.dormancy.update = g.checkVictory = g.checkCardDraw = () => {};
  return g;
}
function equal(a,b) {
  assert.deepEqual(a.board,b.board); assert.deepEqual([...a.alive],[...b.alive]);
  assert.deepEqual([...a.changes],[...b.changes]); assert.deepEqual(a.packet(),b.packet());
}
test('GPU unavailable and local rules fall back to the same single CPU generation', () => {
  const a = small('sparse'), b = small('gpu');
  for (const g of [a,b]) for (const k of [0,1,2,21,42]) {g.board[k]=1;g.alive.push(k);}
  a.step();b.step();equal(a,b);assert.equal(b.generation,1);assert.equal(b.lastBackend,'gpu-fallback-sparse');
});
test('hardware GPU: all 512 masks, edges, owners, priority and sequential steps equal CPU', {skip:process.env.LIFEWAR_TEST_GPU !== '1'}, async () => {
  const gpu = await createGpuEvolution({size:20,timeoutMs:1000});
  try {
    console.log('GPU adapter',gpu.adapter);
    const a = small('sparse'), b = small('gpu');b.gpuEvolution=gpu;
    const random = randomSource(771);
    for (let mask=0;mask<512;mask++) {
      const cells=[];for(let k=399;k>=0;k--)if(random()<.55)cells.push([k,1+Math.floor(random()*4)]);
      for (const g of [a,b]) {
        g.board.fill(0);g.alive.length=0;g.changes.clear();g.marks.fill(0);g.generation=mask%7;
        g.birthRule=new Set(Array.from({length:9},(_,i)=>i).filter(i=>mask&(1<<i)));
        g.survivalRule=new Set(Array.from({length:9},(_,i)=>i).filter(i=>(mask^511)&(1<<i)));
        g.cards.effects=mask%3?[{stat:'birthPriority',playerId:mask%4+1,endsAt:100}]:[];
        if(mask%3===2)g.cards.effects.push({stat:'birthPriority',playerId:(mask+1)%4+1,endsAt:100});
        for(const [k,o]of cells){g.board[k]=o;g.alive.push(k);}
      }
      for(let n=0;n<3;n++){a.step();b.step();equal(a,b);assert.equal(b.lastBackend,'gpu');a.changes.clear();b.changes.clear();}
    }
    for(const g of [a,b])g.localRules=[{x:10,y:10,radius:7,birth:new Set([2]),survival:new Set([0,1,2]),endsAt:100}];
    a.step();b.step();equal(a,b);assert.equal(b.lastBackend,'gpu-fallback-sparse');
    await gpu.close();
    for(const g of [a,b])g.localRules=[];
    a.step();b.step();equal(a,b);assert.equal(b.lastBackend,'gpu-fallback-sparse');
  } finally {await gpu.close();}
});

test('hardware GPU server startup and full settlement replay include local-rule expiry and dormancy', {skip:process.env.LIFEWAR_TEST_GPU !== '1'}, async () => {
  const gpu=await createGpuEvolution({timeoutMs:1000});
  try {
    class GpuGame extends Game {constructor(...args){super(...args);this.backendSelector.mode='gpu';this.gpuEvolution=gpu;}}
    const cells=[];for(let y=440;y<460;y++)for(let x=440;x<460;x++)if((x+y)%3)cells.push([y*1000+x,1+x%2]);
    const result=replay({ReferenceGame:Game,Game:GpuGame,generations:40,cells,setup:g=>{
      g.localRules=[{x:450,y:450,radius:8,birth:new Set([2,3]),survival:new Set([0,2,3]),endsAt:350}];
      g.cards.effects=[{playerId:1,stat:'birthPriority',endsAt:700}];
    }});
    assert.equal(result.phaseComparisons,160);
  }finally{await gpu.close();}
  const app=createServer({port:0,host:'127.0.0.1',evolutionMode:'gpu'});
  try {await app.listen();assert.ok(app.server.listening);}finally{await app.close();}
});

test('hardware GPU timeout abandons late results and recomputes exactly one CPU generation', {skip:process.env.LIFEWAR_TEST_GPU !== '1'}, async()=>{
  const gpu=await createGpuEvolution({size:20,timeoutMs:0});
  try {
    const a=small('sparse'),b=small('gpu');b.gpuEvolution=gpu;
    for(const g of [a,b])for(const k of [22,23,24,43,64]){g.board[k]=1;g.alive.push(k);}
    a.step();b.step();equal(a,b);assert.equal(b.lastBackend,'gpu-fallback-sparse');assert.equal(gpu.healthy,false);
    await new Promise(resolve=>setTimeout(resolve,50));equal(a,b);
    a.step();b.step();equal(a,b);assert.equal(b.generation,2);
  }finally{await gpu.close();}
});
