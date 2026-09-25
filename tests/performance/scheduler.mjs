import {scheduleTicks} from '../../src/tick-scheduler.js';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {summarize} from './statistics.mjs';
import {environment} from './environment.mjs';
const results=[];
for(let round=0;round<3;round++)for(const variant of round%2?['deadline','interval']:['interval','deadline']){
 const samples=[],loop=monitorEventLoopDelay({resolution:20});loop.enable();
 const start=performance.now();let previous=start,timer;
 const usage=process.cpuUsage();
 await new Promise(resolve=>{
  const callback=()=>{const now=performance.now();samples.push({intervalMs:now-previous,lagMs:now-(start+50*(samples.length+1))});previous=now;
   if(samples.length===100){variant==='interval'?clearInterval(timer):timer.stop();resolve();}};
  timer=variant==='interval'?setInterval(callback,50):scheduleTicks(callback,{periodMs:50});
 });
 loop.disable();const cpu=process.cpuUsage(usage);
 results.push({round:round+1,variant,intervalMs:summarize(samples.map(s=>s.intervalMs)),finalLagMs:samples.at(-1).lagMs,hz:100000/(previous-start),cpuMs:(cpu.user+cpu.system)/1000,eventLoopP99Ms:loop.percentile(99)/1e6,samples});
 console.log(JSON.stringify({...results.at(-1),samples:undefined}));
}
mkdirSync('artifacts/performance/scheduler-minimap',{recursive:true});
writeFileSync('artifacts/performance/scheduler-minimap/timers.json',JSON.stringify({environment:environment(),sourceHash:createHash('sha256').update(readFileSync('src/tick-scheduler.js')).digest('hex'),results},null,2));
