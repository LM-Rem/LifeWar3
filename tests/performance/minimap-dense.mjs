// Uses an existing browser/runtime; does not download dependencies.
import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createServer} from '../../src/server.js';
import {Game} from '../reference/src/engine.js';
import {randomSource} from '../helpers/load-fixture.js';
import {environment} from './environment.mjs';
const {values}=parseArgs({options:{playwright:{type:'string'},executable:{type:'string'},rounds:{type:'string',default:'5'},output:{type:'string',default:'artifacts/performance/t11-dense/benchmark'}}});
const rounds=Number(values.rounds);assert.ok(Number.isInteger(rounds)&&rounds>0);
const {chromium}=createRequire(import.meta.url)(values.playwright||'playwright');
const root=new URL('../../',import.meta.url),baseline=new URL('../baselines/t12-minimap/',import.meta.url);
const files=['renderer.js','minimap-cache.js'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest=JSON.parse(readFileSync(new URL('manifest.json',baseline)));
for(const file of files)assert.equal(hash(readFileSync(new URL(file,baseline))),manifest.files[file],file);
const sourceHashes=()=>Object.fromEntries([...files,'world-texture.js','territory.js'].map(file=>[file,hash(readFileSync(new URL('public/'+file,root)))]));
const sources=sourceHashes(),env=environment();
const state=new Game([1,2,3,4].map(i=>({name:'P'+i})),{random:randomSource(91),now:()=>0}).state();
const app=createServer({port:0,host:'127.0.0.1'}),results=[],errors=[];
let browser;
try {
 const {port}=await app.listen();
 for(let round=0;round<rounds;round++)for(const variant of round%2?['current','baseline']:['baseline','current']){
  browser=await chromium.launch({headless:true,executablePath:values.executable});env.browser=browser.version();
  const page=await browser.newPage({viewport:{width:1000,height:800},deviceScaleFactor:1});
  page.on('pageerror',e=>errors.push(e.message));
  if(variant==='baseline')for(const file of files)await page.route('**/'+file,route=>route.fulfill({contentType:'text/javascript',body:readFileSync(new URL(file,baseline),'utf8')}));
  await page.goto(`http://127.0.0.1:${port}/`);
  const measurements=await page.evaluate(async state=>{
   const {Battlefield}=await import('/renderer.js');
   const canvas=document.createElement('canvas'),mini=document.createElement('canvas');
   canvas.style.cssText='width:800px;height:600px';mini.width=mini.height=180;document.body.append(canvas,mini);
   const f=new Battlefield(canvas,mini,{grid:true,ranges:true,motion:true});f.setState(state);
   const out=[];
   function packet(L,owners,offset,snapshot=false){const b=new ArrayBuffer(8+4*L),v=new DataView(b);v.setUint32(0,snapshot?1:0,true);v.setUint32(4,offset+1,true);for(let i=0;i<L;i++)v.setUint32(8+4*i,i*7919%1000000+(owners===1?(offset%4+1):((i+offset)%4+1))*1000000,true);return b;}
   for(const [L,D,owners] of [[100000,100000,4],[500000,100000,4],[500000,500000,4],[500000,500000,1]]){
    f.reset();f.setState(state);f.updatePacket(packet(L,owners,0,true));f.drawMinimap();mini.toDataURL();
    const packets=[packet(D,owners,1),packet(D,owners,2)],samples=[];
    for(let i=0;i<12;i++){
     const start=performance.now();f.updatePacket(packets[i%2]);const decoded=performance.now();f.drawMinimap();const submitted=performance.now();
     // Force completion without getImageData's automatic Canvas backend changes.
     mini.toDataURL();const completed=performance.now();
     if(i>=2)samples.push({applyMs:decoded-start,miniSubmitMs:submitted-decoded,submitMs:submitted-start,completedMs:completed-start});
    }
    let start=performance.now();for(let i=0;i<100;i++)f.drawMinimap();const stableMs=(performance.now()-start)/100;
    const png=mini.toDataURL(),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(png));
    out.push({L,D,owners,samples,stableMs,pngHash:[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('')});
   }return out;
  },structuredClone(state));
  results.push({round:round+1,variant,measurements});await browser.close();browser=null;
  console.log(JSON.stringify({round:round+1,variant,done:true}));
 }
 assert.deepEqual(errors,[]);assert.deepEqual(sourceHashes(),sources,'sources changed during benchmark');
 for(let round=1;round<=rounds;round++){
  const pair=results.filter(r=>r.round===round);assert.deepEqual(pair[0].measurements.map(m=>m.pngHash),pair[1].measurements.map(m=>m.pngHash),'completed images differ');
 }
 const stats=xs=>{const sorted=[...xs].sort((a,b)=>a-b);return {mean:xs.reduce((a,b)=>a+b,0)/xs.length,p95:sorted[Math.ceil(xs.length*.95)-1],p99:sorted[Math.ceil(xs.length*.99)-1],max:sorted.at(-1),samples:xs.length};};
 const summary=results[0].measurements.map(({L,D,owners})=>{
  const result={L,D,owners};for(const variant of ['baseline','current']){
   const ms=results.filter(r=>r.variant===variant).flatMap(r=>r.measurements.filter(m=>m.L===L&&m.D===D&&m.owners===owners));
   result[variant]={};for(const key of ['applyMs','miniSubmitMs','submitMs','completedMs'])result[variant][key]=stats(ms.flatMap(m=>m.samples.map(s=>s[key])));
   result[variant].stableMs=stats(ms.map(m=>m.stableMs));
  }result.completedImprovementPercent=(1-result.current.completedMs.mean/result.baseline.completedMs.mean)*100;return result;
 });
 mkdirSync(values.output,{recursive:true});
 const report={status:'PASS',scope:'headless Canvas submission and forced PNG completion; includes encoding cost; not physical frame rate',warmup:2,measuredPerRound:10,rounds,baselineCommit:manifest.commit,sourceHashes:sources,baselineHashes:manifest.files,environment:env,summary,results};
 writeFileSync(`${values.output}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(summary));
}finally{await browser?.close();await app.close();}
