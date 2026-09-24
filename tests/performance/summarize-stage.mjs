import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {summarize} from './statistics.mjs';
import assert from 'node:assert/strict';
const base=process.argv[2]||'artifacts/performance/t05-t06-final';
const output=process.argv[3]||'docs/performance/t05-t11-summary.json';
const result={scope:'step+packet, frozen 20 Hz synthetic load; 5 isolated rounds x 100 generations after 30 warmup; baseline=T04',scenarios:{}};
for(const scenario of ['P01','P03','P04']) {
 const entry={};
 for(const backend of ['baseline','current']) {
  const reports=Array.from({length:5},(_,i)=>JSON.parse(readFileSync(`${base}/${scenario}/${i+1}/${backend}/report.json`)));
  for(const r of reports)assert.deepEqual(r.sourceHashes,reports[0].sourceHashes,'source changed during benchmark');
  const rounds=reports.map(r=>r.rounds[0]);entry[backend]={sourceHashes:reports[0].sourceHashes,environment:reports[0].environment,
    tickMs:summarize(rounds.flatMap(r=>r.samples.map(s=>s.tickMs))),roundMeans:rounds.map(r=>r.tickMs.mean),deadlineMisses:rounds.reduce((n,r)=>n+r.deadlineMisses,0),memory:rounds.map(r=>r.memory),L:rounds[0].L,D:rounds[0].D};
 }
 entry.improvementPercent=(1-entry.current.tickMs.mean/entry.baseline.tickMs.mean)*100;result.scenarios[scenario]=entry;
}
const browser=JSON.parse(readFileSync('artifacts/performance/render-equivalence/report.json'));result.browser={sourceHashes:browser.sourceHashes,status:browser.status,browser:browser.browser,comparisons:browser.comparisons,scope:browser.scope};
result.browser.timings=Object.fromEntries(Object.entries(browser.results).map(([k,v])=>[k,v.map(({dpr,timings})=>({dpr,timings}))]));
if (['P01','P03','P04'].every(id=>existsSync(`artifacts/performance/t06-legacy-mode/${id}/report.json`))) {
 result.dormancyAblation={scope:'one exploratory process per scenario, warmup 30, measured 100, LIFEWAR_DORMANCY=legacy; typed storage retained',results:{}};
 for(const id of ['P01','P03','P04']){const report=JSON.parse(readFileSync(`artifacts/performance/t06-legacy-mode/${id}/report.json`));const r=report.rounds[0];result.dormancyAblation.results[id]={tickMs:r.tickMs,deadlineMisses:r.deadlineMisses,sourceHashes:report.sourceHashes};}
}
writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify(Object.fromEntries(Object.entries(result.scenarios).map(([k,v])=>[k,{before:v.baseline.tickMs,after:v.current.tickMs,improvementPercent:v.improvementPercent}]))));
