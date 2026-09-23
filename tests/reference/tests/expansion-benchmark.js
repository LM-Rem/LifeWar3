import {Game} from '../src/engine.js';
import {performance} from 'node:perf_hooks';
for(const population of [100000,300000,800000]){
 const g=new Game([{name:'A'},{name:'B'}],{now:()=>0,cardDrawTimes:[]});
 g.players.forEach(p=>p.hp=1e12);g.birthRule=new Set([1,2,3,4,5,6,7,8]);g.survivalRule=new Set([0,1,2,3,4,5,6,7,8]);
 for(let k=0;k<population;k++){g.board[k]=1;g.alive.push(k);}g.players[0].cells=population;
 const durations=[];
 for(let i=0;i<10;i++){const start=performance.now();g.step();g.packet();g.changes.clear();durations.push(performance.now()-start);}
 durations.sort((a,b)=>a-b);console.log(JSON.stringify({initial:population,final:g.alive.length,avgMs:Math.round(durations.reduce((a,b)=>a+b)/10),maxMs:Math.round(durations.at(-1)),heapMB:Math.round(process.memoryUsage().heapUsed/1048576)}));
}

