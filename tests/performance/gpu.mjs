import { writeFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { Game } from '../../src/engine.js';
import { createGpuEvolution } from '../../src/evolution/gpu.js';
import { randomSource } from '../helpers/load-fixture.js';
const gpu=await createGpuEvolution({timeoutMs:1000}),results=[];
try {
  const games=['sparse','gpu'].map(evolutionMode=>new Game([1,2,3,4].map(i=>({name:String(i)})),{evolutionMode,now:()=>0,random:randomSource(91)}));
  games[1].gpuEvolution=gpu;
  for(const count of [500000,800000,1000000]) {
    const samples={sparse:[],gpu:[]};
    for(let round=0;round<12;round++) {
      for(const i of round%2?[1,0]:[0,1]) {
        const g=games[i];g.board.fill(0);g.alive.length=0;g.changes.clear();g.generation=round*10;
        g.birthRule=new Set([3,4]);g.survivalRule=new Set([2,3,4,5,6,7,8]);
        for(let j=0;j<count;j++){const k=j*7919%1000000;g.board[k]=j%4+1;g.alive.push(k);}
        for(const p of g.players){p.hp=1e9;p.eliminated=false;}g.status='playing';g.rebuildDerivedState();
        const start=performance.now();g.step();const packet=g.packet();const ms=performance.now()-start;
        if(round>=2)samples[i?'gpu':'sparse'].push(ms);
        assert.equal(g.lastBackend,i?'gpu':'sparse');assert.ok(packet.byteLength>=8);
      }
      assert.deepEqual(games[0].board,games[1].board);assert.deepEqual([...games[0].alive],[...games[1].alive]);assert.deepEqual(games[0].packet(),games[1].packet());
    }
    const summary=Object.fromEntries(Object.entries(samples).map(([mode,ms])=>{ms.sort((a,b)=>a-b);return[mode,{medianMs:ms[Math.floor(ms.length/2)],p95Ms:ms.at(-1),samples:ms}];}));
    results.push({count,...summary});console.log(JSON.stringify(results.at(-1)));
  }
  mkdirSync('artifacts/performance/gpu',{recursive:true});writeFileSync('artifacts/performance/gpu/benchmark.json',JSON.stringify({adapter:gpu.adapter,scope:'step including objectives, dormancy, readback and v1 encode; fixed dense input per sample',results},null,2));
}finally{await gpu.close();}
