import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root='artifacts/performance/scheduler-minimap/';
const read=path=>JSON.parse(readFileSync(root+path,'utf8'));
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
const example=read('e2e-final/deadline-4-1/report.json'),profile=read('profile-after/report.json');
for(const [file,hash] of Object.entries(example.sourceHashes))assert.equal(sha(file),hash,`source changed: ${file}`);
for(const [file,hash] of Object.entries(profile.sources))assert.equal(sha(file),hash);
const baseline='tests/baselines/minimap-index/minimap-cache.js';
assert.equal(sha(baseline),sha(root+'pre/minimap-cache.js'));
assert.equal(sha(baseline),JSON.parse(readFileSync('tests/baselines/minimap-index/manifest.json')).sha256);
const stages=[];
for(const name of ['dense-mono','dense-four'])for(const step of ['full','first-local','indexed-local','spread2000'])for(const variant of ['baseline','current']){
 const rows=profile.results.filter(r=>r.variant===variant).flatMap(r=>r.rows).filter(r=>r.name===name&&r.step===step);
 stages.push({name,step,variant,rounds:rows.length,...Object.fromEntries(['indexMs','applyMs','traversalOnlyMs','miniSubmitMs','readbackPlusPngMs','totalMs'].map(k=>[k,median(rows.map(r=>r[k]))]))});
}
const timers=read('timers.json');assert.equal(timers.sourceHash,sha('src/tick-scheduler.js'));
const unitLog=readFileSync(root+'unit-final.log','utf8');
const unitCount=key=>{const match=unitLog.match(new RegExp('\\b'+key+' (\\d+)'));assert.ok(match);return Number(match[1]);};
assert.equal(unitCount('fail'),0);
const report={environment:example.environment,sourceHashes:example.sourceHashes,
 scope:example.scope,baselineHash:sha(baseline),
 timers:timers.results.map(({samples,...rest})=>rest),
 ordinaryRuns:read('e2e-final/summary.json'),denseSingle:read('dense-single/report.json').summary,
 minimap:{scope:profile.scope,pixelMatch:profile.pixelMatch,pixelPairs:24,stages,
 rejectedContexts:{cpu:{pixelMatch:read('cpu-context/report.json').pixelMatch},opaque:{pixelMatch:read('opaque-context/report.json').pixelMatch,reason:'No material speed gain in exploratory run'}}},
 denseDiagnostic:{scope:'Additional instrumented run; not included in acceptance timing tables.',
 fullRedraws:read('dense-trace/report.json').clients[0].raw.minimapTrace.filter(r=>r.reason!=='tiles')},
 verification:{unitTests:unitCount('tests'),unitFailures:unitCount('fail'),originalCanvas:read('equivalence/report.json').comparisons,
 protocolCanvas:read('protocol.json').pixelComparisons,orderedMap:read('protocol.json').orderedMapComparisons},
 limitations:['Headless loopback, DPR 1 performance; no physical display/LAN/soak certification.',
 'Three ordinary rounds, one dense boundary run; P04 and full initial/current v1/v2 matrix were not repeated this stage.',
 'Scheduler timing hook excludes the last measured tick; steadyHz uses all 100 tick starts.',
 'Memory snapshots exclude GPU allocations; server CPU excludes Chromium. Preliminary e2e/ runs are not acceptance data.']};
writeFileSync('docs/performance/2026-09-25-scheduler-minimap-summary.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report.verification));
