import { fileURLToPath } from 'node:url';
import { measure } from './performance/statistics.mjs';
process.env.LIFEWAR_CONFIG_PATH = fileURLToPath(new URL('./fixtures/performance/production-20hz.json', import.meta.url));
const { Game, RULES } = await import('../src/engine.js');
for(const population of [100000,300000,800000]){
 const g=new Game([{name:'A'},{name:'B'}],{now:()=>0,cardDrawTimes:[]});
 g.players.forEach(p=>p.hp=1e12);g.birthRule=new Set([1,2,3,4,5,6,7,8]);g.survivalRule=new Set([0,1,2,3,4,5,6,7,8]);
 for(let k=0;k<population;k++){g.board[k]=1;g.alive.push(k);}g.players[0].cells=population;
 const { samples, ...report } = measure(g, { generations: 10, hz: RULES.hz });
 console.log(JSON.stringify({initial:population,final:g.alive.length,hz:RULES.hz,synthetic:'fixed flood rule, frozen time, high base HP',...report}));
}

