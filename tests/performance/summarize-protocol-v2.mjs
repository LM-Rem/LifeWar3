import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root='artifacts/performance/t13/',read=file=>JSON.parse(readFileSync(root+file));
const benchmark=read('protocol-benchmark.json'),browser=read('browser.json'),visual=read('equivalence/report.json'),network=read('network.json'),live=read('live.json');
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
for(const [file,sha] of Object.entries(benchmark.sourceHashes))assert.equal(hash(file),sha,file);
for(const evidence of [browser,visual])for(const [file,sha] of Object.entries(evidence.sourceHashes))assert.equal(hash('public/'+file),sha,file);
for(const result of [browser,visual,network,live])assert.equal(result.status,'PASS');
const log=readFileSync(root+'tests.txt','utf8'),tests=Number(log.match(/ℹ tests (\d+)/)?.[1]),passed=Number(log.match(/ℹ pass (\d+)/)?.[1]);
assert.ok(tests>0);assert.equal(tests,passed);assert.match(log,/ℹ fail 0/);
const {results,...metadata}=benchmark;
const summary={...metadata,defaultProtocol:1,v2OptIn:'LIFEWAR_BOARD_PROTOCOL=2',functionalValidation:'PASS',denseRealtimeAcceptance:'NOT PASSED',results:results.map(r=>r.summary),
 verification:{tests,passed,pixelComparisons:visual.comparisons+browser.pixelComparisons,orderedMapComparisons:browser.orderedMapComparisons,negotiatedVersions:browser.negotiatedVersions,resumeVersions:browser.resumeVersions,network,
 live:{scope:live.scope,configuredProtocol:2,normalGenerationsThrough:live.normalGenerationsThrough,observedInputHz:live.observedInputHz,queueDepthMax:live.queueDepthMax,waitMaxMs:Math.max(...live.waitMs),normalFailures:live.normalTrace.records.filter(r=>r.name==='presentation.failure').length}},
 rawArtifacts:root};
writeFileSync('docs/performance/t13-summary.json',JSON.stringify(summary,null,2));console.log(JSON.stringify({tests,pixelComparisons:summary.verification.pixelComparisons,sourceHashes:'match',defaultProtocol:1}));
