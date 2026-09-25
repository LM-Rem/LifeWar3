import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {percentile} from './statistics.mjs';
const root='artifacts/performance/2026-09-25';
const runs=[1,2].flatMap(dpr=>JSON.parse(readFileSync(`${root}/ab-dpr${dpr}/summary.json`)));
const median=xs=>percentile(xs,.5),summary=[];
const manifests={};
for(const run of runs){
 const report=JSON.parse(readFileSync(`${root}/ab-dpr${run.dpr}/${run.scenario}-${run.variant}-${run.round}/report.json`));
 manifests[run.variant]??=report.sourceHashes;assert.deepEqual(report.sourceHashes,manifests[run.variant],'mixed source manifests');
}
for(const dpr of [1,2])for(const scenario of ['P01','P03','P04'])for(const variant of ['initial','current-v1','current-v2']){
 const rows=runs.filter(r=>r.dpr===dpr&&r.scenario===scenario&&r.variant===variant);
 assert.equal(rows.length,3,'expected three complete rounds per matrix entry');
 const clients=rows.flatMap(r=>r.clientMetrics);
 summary.push({dpr,scenario,variant,rounds:rows.length,tickP95Median:median(rows.map(r=>r.tickMs.p95)),tickP99PerRound:rows.map(r=>r.tickMs.p99),tickMax:Math.max(...rows.map(r=>r.tickMs.max)),deadlineMisses:rows.reduce((s,r)=>s+r.deadlineMisses,0),hzMedian:median(rows.map(r=>r.observedHz)),frameP95Median:median(clients.map(r=>r.frameMs.p95)),frameP99Worst:Math.max(...clients.map(r=>r.frameMs.p99)),rafP99Worst:Math.max(...clients.map(r=>r.rafMs.p99)),queueMax:variant==='initial'?null:Math.max(...clients.map(r=>r.queueDepth.max)),undrawn:clients.reduce((s,c)=>s+c.undrawnGenerations,0),missing:clients.reduce((s,c)=>s+c.missingGenerations,0),recoveries:rows.reduce((s,r)=>s+r.snapshotCount,0),wireMBPerSecondMedian:median(rows.map(r=>r.wireBytesPerSecond))/1e6,wireBytesPerGenerationMedian:median(rows.map(r=>r.wireBytesPerGeneration)),rssMiBMedian:median(rows.map(r=>r.serverMemory.rss))/1048576,clientHeapMiBMedian:median(clients.map(c=>c.heap.usedSize))/1048576,pass:rows.every(r=>r.realtimePass)});
}
const codec=JSON.parse(readFileSync(`${root}/codec/report.json`));
const codecSummary=codec.summary.map(r=>({name:r.name,bytes:r.after.bytes,...Object.fromEntries(['before','after'].map(v=>[v,Object.fromEntries(['encodeMs','decodeOrderMs','applyMs','totalMs'].map(k=>[k,{medianMean:median(r[v].rounds.map(s=>s[k].mean)),medianP95:median(r[v].rounds.map(s=>s[k].p95)),p99PerRound:r[v].rounds.map(s=>s[k].p99)}]))]))}));
const result={scope:'Local synthetic full-chain A/B; NOT release certification. Median of per-run/client quantiles, never a pooled p99. Queue maximum is sampled after frames, not an arrival peak. Different recovery streams prohibit interpreting wire rate ratios as compression ratios.',sourceManifests:manifests,codecHashes:codec.hashes,summary,codecSummary};
writeFileSync('docs/performance/2026-09-25-render-codec-ab-summary.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
