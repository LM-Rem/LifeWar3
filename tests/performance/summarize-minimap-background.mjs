import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root='artifacts/performance/minimap-background/',read=p=>JSON.parse(readFileSync(root+p,'utf8'));
const raw=read('final/report.json'),med=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
for(const [f,h] of Object.entries(raw.sourceHashes))assert.equal(createHash('sha256').update(readFileSync(f)).digest('hex'),h);
const rows=[];
for(const name of ['mono','four','fractional'])for(const step of raw.results[0].rows.filter(r=>r.name===name).map(r=>r.step)){
 const row={name,step};for(const variant of ['baseline','current']){
  const samples=raw.results.filter(r=>r.variant===variant).flatMap(r=>r.rows).filter(r=>r.name===name&&r.step===step);
  row[variant]=Object.fromEntries(['packetMs','submitMs','completionMs','totalMs'].map(k=>[k,med(samples.map(s=>s[k]))]));
  row[variant].indexRetained=samples.every(s=>s.indexRetained);
 }rows.push(row);
}
const unit=readFileSync(root+'unit.log','utf8'),count=k=>Number(unit.match(new RegExp('\\b'+k+' (\\d+)'))[1]);
assert.equal(count('fail'),0);
const result={environment:read('dense/report.json').environment,sourceHashes:raw.sourceHashes,baselineHash:raw.baselineHash,scope:raw.scope,pixelMatch:raw.pixelMatch,backgroundPixelPairs:raw.results.length/2*36,rows,
 layers:JSON.parse(readFileSync('artifacts/performance/minimap-layers/report.json')),
 dense:read('dense/report.json').summary,ordinary:read('ordinary/report.json').summary,
 verification:{unitTests:count('tests'),failures:count('fail'),originalCanvas:read('equivalence/report.json').comparisons,protocolCanvas:read('protocol.json').pixelComparisons,orderedMap:read('protocol.json').orderedMapComparisons},
 limitations:['Three controlled A/B rounds; live ordinary and dense checks have one run each.','Headless loopback, no physical presentation/LAN/soak certification.','Background benchmark totalMs excludes preceding packet/index work and includes PNG encoding.','Large background changes still require full ordered cell replay.']};
writeFileSync('docs/performance/2026-09-25-minimap-background-summary.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result.verification));
