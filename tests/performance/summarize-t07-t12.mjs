import {readFileSync,writeFileSync} from 'node:fs';
import {summarize} from './statistics.mjs';
import assert from 'node:assert/strict';
const read=path=>JSON.parse(readFileSync(path));
const report={scope:'T06 workspace baseline vs auto(sparse) and dense; 5 independent rounds x 100 generations after 30 warmup; step+packet only',scenarios:{}};
for(const id of ['P01','P03','P04']){
 const entry={};
 for(const mode of ['baseline','auto','dense']){
  const reports=Array.from({length:5},(_,i)=>read(`artifacts/performance/t07-t08-final/${id}/${i+1}/${mode}/report.json`));
  reports.forEach(r=>assert.deepEqual(r.sourceHashes,reports[0].sourceHashes,'source drift'));
  const rounds=reports.map(r=>r.rounds[0]);entry[mode]={sourceHashes:reports[0].sourceHashes,environment:reports[0].environment,tickMs:summarize(rounds.flatMap(r=>r.samples.map(s=>s.tickMs))),roundMeans:rounds.map(r=>r.tickMs.mean),deadlineMisses:rounds.reduce((n,r)=>n+r.deadlineMisses,0),L:rounds[0].L,C:rounds[0].C,D:rounds[0].D,memory:rounds.map(r=>r.memory)};
 }
 entry.improvementPercent=100*(1-entry.auto.tickMs.mean/entry.baseline.tickMs.mean);report.scenarios[id]=entry;
}
const visual=read('artifacts/performance/t07-render-equivalence/report.json'),controlled=read('artifacts/performance/t12/browser.json'),live=read('artifacts/performance/t12/live.json');
report.visual={status:visual.status,browser:visual.browser,comparisons:visual.comparisons,sourceHashes:visual.sourceHashes};
report.presentation={controlled:{status:controlled.status,burst:controlled.burst,events:controlled.events,previews:controlled.previews,cached100CallsMs:controlled.cachedMs,uncached100CallsMs:controlled.uncachedMs},live:{scope:live.scope,status:live.status,normalGenerationsThrough:live.normalGenerationsThrough,observedInputHz:live.observedInputHz,queueDepthMax:live.queueDepthMax,waitMs:summarize(live.waitMs),rafIntervalMs:summarize(live.rafIntervalsMs)}};
report.crossover=[];
for(const population of [100000,300000,500000,800000])for(const locals of [0,1,8]){
 const entry={initialPopulation:population,locals};for(const mode of ['sparse','dense']){const r=read(`artifacts/performance/t08-crossover/${population}/${locals}/${mode}/report.json`).rounds[0];entry[mode]={tickMs:r.tickMs,L:r.L,C:r.C,D:r.D};}report.crossover.push(entry);
}
const alt=read('artifacts/performance/t08-crossover/alternate/report.json').rounds[0];report.alternating={scope:'P04 forced switch every generation, all samples including switches',tickMs:alt.tickMs,deadlineMisses:alt.deadlineMisses};
writeFileSync('docs/performance/t07-t12-summary.json',JSON.stringify(report,null,2));console.log(JSON.stringify(Object.fromEntries(Object.entries(report.scenarios).map(([k,v])=>[k,{baseline:v.baseline.tickMs,auto:v.auto.tickMs,dense:v.dense.tickMs,improvementPercent:v.improvementPercent,deadlineMisses:v.auto.deadlineMisses}]))));
