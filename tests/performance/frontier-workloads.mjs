import {fileURLToPath} from 'node:url';
import {writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {scenario} from './scenarios.mjs';
import {measure} from './statistics.mjs';
process.env.LIFEWAR_CONFIG_PATH=fileURLToPath(new URL('../fixtures/performance/production-20hz.json',import.meta.url));
const {Game,RULES}=await import('../../src/engine.js');
const results=[];
for(const workload of ['glider','local1','local8','frequent-rules'])for(let round=0;round<3;round++){
 const pair=[];
 for(const mode of round%2?['frontier','sparse']:['sparse','frontier']){
  const game=scenario(Game,'P01');game.backendSelector.mode=mode;
  for(const [x,y]of [[701,700],[702,701],[700,702],[701,702],[702,702]]){const k=y*1000+x;game.board[k]=1;game.alive.push(k);game.players[0].cells++;}
  game.rebuildDerivedState();
  const count=workload==='local1'?1:workload==='local8'?8:0;
  game.localRules=Array.from({length:count},(_,i)=>({x:400+i*25,y:300,radius:80,birth:new Set([3]),survival:new Set([2,3]),endsAt:1e12}));
  if(workload==='frequent-rules'){
   const step=game.step.bind(game);game.step=()=>{
    game.survivalRule=new Set(game.generation%2?[0,2,3]:[2,3]);
    game.localRules=game.generation%3?[{x:400,y:300,radius:80,birth:new Set([3]),survival:new Set([2,3]),endsAt:1e12}]:[];
    game.cards.effects=game.generation%5?[{stat:'birthPriority',playerId:1,endsAt:1e12}]:[];
    return step();
   };
  }
  const data=measure(game,{generations:100,warmup:30,hz:RULES.hz});
  assert.ok(data.D.min>0,'moving glider must remain active throughout sampling');
  const hash=createHash('sha256').update(new Uint8Array(game.packet(true))).digest('hex');pair.push(hash);
  results.push({workload,round,mode,data,hash,evaluated:game.frontier?.evaluated,candidates:game.lastCandidateCount});
 }
 assert.equal(pair[0],pair[1],workload+' final ordered snapshot');
}
mkdirSync('artifacts/performance/t09',{recursive:true});
writeFileSync('artifacts/performance/t09/workloads.json',JSON.stringify(results,null,2));
console.log(JSON.stringify(results.map(({workload,round,mode,data,evaluated,candidates})=>({workload,round,mode,mean:data.tickMs.mean,evaluated,candidates}))));
