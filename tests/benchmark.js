import { fileURLToPath } from 'node:url';
import { measure } from './performance/statistics.mjs';
process.env.LIFEWAR_CONFIG_PATH = fileURLToPath(new URL('./fixtures/performance/production-20hz.json', import.meta.url));
const { Game, RULES } = await import('../src/engine.js');

for(const population of [2000,10000,24000]){
  const g=new Game([1,2,3,4].map(i=>({name:'P'+i})));let count=0;
  for(let y=30;y<950&&count<population;y+=8)for(let x=30;x<950&&count<population;x+=8){
    const owner=(Math.floor(count/4)%4)+1;for(const[dx,dy]of [[0,0],[1,0],[0,1],[1,1]]){const k=(y+dy)*1000+x+dx;g.board[k]=owner;g.alive.push(k);count++;}
  }
  const { samples, ...report } = measure(g, { warmup: 20, generations: 100, hz: RULES.hz });
  console.log(JSON.stringify({scenario:'separated stable blocks',requested:population,live:g.alive.length,hz:RULES.hz,...report}));
}
// Transient dense random fronts exercise births, deaths and larger network deltas.
const g=new Game([1,2,3,4].map(i=>({name:'P'+i})));let seed=91;
for(let team=1;team<=4;team++)for(let y=0;y<110;y++)for(let x=0;x<110;x++){seed=(seed*1664525+1013904223)>>>0;if(seed/4294967296<.48){const key=(350+y+(team>2?130:0))*1000+350+x+(team%2?0:130);g.board[key]=team;g.alive.push(key);}}
const { samples, ...report } = measure(g, { generations: 100, hz: RULES.hz });
console.log(JSON.stringify({scenario:'four chaotic fronts',finalLive:g.alive.length,hz:RULES.hz,...report}));
