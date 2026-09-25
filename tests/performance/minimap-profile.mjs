import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createServer} from '../../src/server.js';
import {Game} from '../reference/src/engine.js';
import {randomSource} from '../helpers/load-fixture.js';
const {values:v}=parseArgs({options:{playwright:{type:'string'},executable:{type:'string'},baseline:{type:'string'},context:{type:'string',default:'default'},rounds:{type:'string',default:'3'},output:{type:'string',default:'artifacts/performance/scheduler-minimap/minimap-profile'}}});
assert.ok(Number.isInteger(+v.rounds)&&+v.rounds>0);
assert.ok(['default','opaque','cpu'].includes(v.context));
const source=readFileSync('public/minimap-cache.js','utf8');
const baselineSource=v.baseline?readFileSync(v.baseline,'utf8'):null;
const baselineHash=baselineSource===null?null:createHash('sha256').update(baselineSource).digest('hex');
if(v.baseline?.replaceAll('\\','/').endsWith('tests/baselines/minimap-index/minimap-cache.js')){
 const manifest=JSON.parse(readFileSync('tests/baselines/minimap-index/manifest.json','utf8'));
 assert.equal(baselineHash,manifest.sha256,'frozen minimap baseline changed');
}
const candidate=v.context==='default'?source:source.replaceAll("getContext('2d')",`getContext('2d', {${v.context==='cpu'?'willReadFrequently: true':'alpha: false'}})`);
const {chromium}=createRequire(import.meta.url)(v.playwright||'playwright');
const app=createServer({port:0,host:'127.0.0.1'}),results=[],errors=[];
const state=new Game([1,2,3,4].map(i=>({name:'P'+i})),{random:randomSource(91),now:()=>0}).state();
let browser;
try{
 const {port}=await app.listen();
 for(let round=0;round<+v.rounds;round++)for(const variant of v.baseline?(round%2?['current','baseline']:['baseline','current']):['current']){
  browser=await chromium.launch({headless:true,executablePath:v.executable});const page=await browser.newPage();
  await page.route('**/app.js',r=>r.fulfill({contentType:'text/javascript',body:''}));
  if(variant==='baseline')await page.route('**/minimap-cache.js',r=>r.fulfill({contentType:'text/javascript',body:baselineSource}));
  else if(v.context!=='default')await page.route('**/minimap-cache.js',r=>r.fulfill({contentType:'text/javascript',body:candidate}));
  page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${port}/`);
  const rows=await page.evaluate(async state=>{
   const {Battlefield}=await import('/renderer.js'),main=document.createElement('canvas'),mini=document.createElement('canvas');
   main.style.cssText='width:800px;height:600px';mini.width=mini.height=180;document.body.append(main,mini);
   const f=new Battlefield(main,mini,{grid:true,ranges:true,motion:true}),rows=[];
   const packet=(entries,snapshot=false)=>{const b=new ArrayBuffer(8+entries.length*4),v=new DataView(b);v.setUint32(0,+snapshot,true);v.setUint32(4,1,true);entries.forEach(([k,o],i)=>v.setUint32(8+i*4,k+o*1000000,true));return b;};
   let indexMs=0,flushMs=0;
   const begin=f.minimapCache.beginPacket.bind(f.minimapCache);f.minimapCache.beginPacket=(...args)=>{const t=performance.now();begin(...args);indexMs+=performance.now()-t;};
   const flush=f.texture.flush.bind(f.texture);f.texture.flush=()=>{const t=performance.now();flush();flushMs+=performance.now()-t;};
   for(const [name,L,permuted,owners] of [['dense-mono',900000,false,1],['dense-four',500000,true,4]]){
    const keys=Array.from({length:L},(_,i)=>permuted?i*7919%1000000:i);
    f.reset();f.setState(state);f.updatePacket(packet(keys.map((k,i)=>[k,i%owners+1]),true));f.drawMinimap();mini.toDataURL();
    const steps=[['full',keys.map((k,i)=>[k,(i%owners+1)%4+1])],['first-local',[[keys[0],4]]],['indexed-local',[[keys[0],3]]],['spread2000',keys.filter((_,i)=>i%Math.floor(L/2000)===0).map(k=>[k,4])]];
    for(const [step,entries] of steps){
     const buffer=packet(entries);indexMs=flushMs=0;
     const t=performance.now();f.updatePacket(buffer);const applyMs=performance.now()-t,c=f.minimapCache;
     let work=0;for(const tile of c.dirty)work+=c.members?.[tile]?.size??0;
     const mode=c.full||c.dirty.size>c.side**2/2||work>f.cells.size?'full':'tiles',dirty=c.dirty.size;
     const js=performance.now();let checksum=0,contributors=0;
     if(mode==='full'){for(const [k,o] of f.cells){checksum=(checksum+k+o)|0;contributors++;}}
     else for(const tile of c.dirty)for(const k of c.members[tile]){checksum=(checksum+k+f.cells.get(k))|0;contributors++;}
     const traversalOnlyMs=performance.now()-js;
     const start=performance.now();f.drawMinimap();const submitted=performance.now();const png=mini.toDataURL();const completed=performance.now();
     const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(png));
     rows.push({name,L,step,D:entries.length,mode,dirty,contributors,indexMs,applyMs,flushMs,traversalOnlyMs,miniSubmitMs:submitted-start,readbackPlusPngMs:completed-submitted,totalMs:applyMs+completed-start,checksum,indexEntries:c.members?.reduce((n,s)=>n+s.size,0)??0,pngHash:[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('')});
    }
   }return rows;
  },structuredClone(state));
  results.push({round:round+1,variant,browser:browser.version(),rows});await browser.close();browser=null;
  console.log(JSON.stringify({round:round+1,variant,rows}));
 }
 assert.deepEqual(errors,[]);
 const pixelMatch=!v.baseline||Array.from({length:+v.rounds},(_,i)=>results.filter(r=>r.round===i+1)).every(pair=>JSON.stringify(pair[0].rows.map(r=>r.pngHash))===JSON.stringify(pair[1].rows.map(r=>r.pngHash)));
 const sources=Object.fromEntries(['public/minimap-cache.js','public/renderer.js'].map(f=>[f,createHash('sha256').update(readFileSync(f)).digest('hex')]));
 mkdirSync(v.output,{recursive:true});writeFileSync(v.output+'/report.json',JSON.stringify({sources,baselineHash,context:v.context,candidateHash:createHash('sha256').update(candidate).digest('hex'),pixelMatch,scope:'Diagnostic JS traversal pass immediately before draw warms caches; Canvas completion includes PNG encoding. Per-stage measurements are not pure GPU times. No per-cell clocks.',results},null,2));
 assert.ok(pixelMatch,'pixel mismatch (results retained)');
}finally{await browser?.close();await app.close();}
