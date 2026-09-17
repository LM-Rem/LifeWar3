import { Game } from '../src/engine.js';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
const stats=a=>{a.sort((a,b)=>a-b);return {meanMs:+(a.reduce((s,x)=>s+x,0)/a.length).toFixed(3),p95Ms:+a[Math.floor(a.length*.95)].toFixed(3),maxMs:+a.at(-1).toFixed(3)};};
console.log(os.cpus()[0].model);
for(const enabled of [false,true]){
  const regular=[],warning=[],cleanup=[];let removed=0,memory=0,warningBytes=0;
  for(let run=0;run<3;run++){
    const g=new Game([1,2,3,4].map(i=>({name:'P'+i})));
    if(!enabled)g.dormancy.update=()=>0;
    outer:for(let y=24;y<975;y+=9)for(let x=24;x<975;x+=9){
      if(g.alive.length>=24000)break outer;
      if(g.players.some(p=>Math.hypot(x-p.x,y-p.y)<32))continue;
      const owner=(g.alive.length/4%4)+1;
      for(const[dx,dy]of [[0,0],[1,0],[0,1],[1,1]]){const k=(y+dy)*1000+x+dx;g.board[k]=owner;g.alive.push(k);g.players[owner-1].cells++;}
    }
    memory=g.dormancy.bytes;
    for(let i=0;i<610;i++){
      const before=g.alive.length,t=performance.now();g.step();g.packet();
      // Match server JSON cadence; include serialization in timings.
      if(i%2===0)JSON.stringify(g.state());
      const elapsed=performance.now()-t;
      if(before&&!g.alive.length){cleanup.push(elapsed);removed+=before;}
      else if(i>=501&&i<600)warning.push(elapsed);
      else if(i>=30&&i<500)regular.push(elapsed);
      warningBytes=Math.max(warningBytes,JSON.stringify(g.state().dormancy).length);
      g.changes.clear();
    }
  }
  console.log(JSON.stringify({enabled,regular:stats(regular),warning:stats(warning),cleanupMs:cleanup,removed,memoryMiB:+(memory/1048576).toFixed(2),warningBytes}));
}
