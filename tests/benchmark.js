import { Game } from '../src/engine.js';
import { performance } from 'node:perf_hooks';

for(const population of [2000,10000,24000]){
  const g=new Game([1,2,3,4].map(i=>({name:'P'+i})));let count=0;
  for(let y=30;y<950&&count<population;y+=8)for(let x=30;x<950&&count<population;x+=8){
    const owner=(Math.floor(count/4)%4)+1;for(const[dx,dy]of [[0,0],[1,0],[0,1],[1,1]]){const k=(y+dy)*1000+x+dx;g.board[k]=owner;g.alive.push(k);count++;}
  }
  for(let i=0;i<20;i++){g.step();g.changes.clear();}
  const timings=[];let bytes=0;
  for(let i=0;i<100;i++){const t=performance.now();g.step();const packet=g.packet();bytes+=packet.byteLength;timings.push(performance.now()-t);g.changes.clear();}
  timings.sort((a,b)=>a-b);console.log(JSON.stringify({scenario:'separated stable blocks',requested:population,live:g.alive.length,avgMs:+(timings.reduce((a,b)=>a+b)/timings.length).toFixed(3),p95Ms:+timings[95].toFixed(3),maxMs:+timings.at(-1).toFixed(3),binaryBytesPerSecond:bytes/10,heapMB:+(process.memoryUsage().heapUsed/1048576).toFixed(1)}));
}
// Transient dense random fronts exercise births, deaths and larger network deltas.
const g=new Game([1,2,3,4].map(i=>({name:'P'+i})));let seed=91;
for(let team=1;team<=4;team++)for(let y=0;y<110;y++)for(let x=0;x<110;x++){seed=(seed*1664525+1013904223)>>>0;if(seed/4294967296<.48){const key=(350+y+(team>2?130:0))*1000+350+x+(team%2?0:130);g.board[key]=team;g.alive.push(key);}}
const times=[];let bytes=0,maxLive=g.alive.length;
for(let i=0;i<100;i++){const t=performance.now();g.step();bytes+=g.packet().byteLength;times.push(performance.now()-t);maxLive=Math.max(maxLive,g.alive.length);g.changes.clear();}times.sort((a,b)=>a-b);
console.log(JSON.stringify({scenario:'four chaotic fronts',maxLive,finalLive:g.alive.length,avgMs:+(times.reduce((a,b)=>a+b)/100).toFixed(3),p95Ms:+times[95].toFixed(3),maxMs:+times.at(-1).toFixed(3),binaryBytesPerSecond:bytes/10}));
