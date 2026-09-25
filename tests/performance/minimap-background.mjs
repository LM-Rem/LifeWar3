import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createServer} from '../../src/server.js';
import {Game} from '../reference/src/engine.js';
import {randomSource} from '../helpers/load-fixture.js';
const {values:v}=parseArgs({options:{playwright:{type:'string'},executable:{type:'string'},rounds:{type:'string',default:'3'},output:{type:'string',default:'artifacts/performance/minimap-background'}}});
assert.ok(Number.isInteger(+v.rounds)&&+v.rounds>0);
const baseline='tests/baselines/minimap-background/minimap-cache.js',sha=f=>createHash('sha256').update(readFileSync(f)).digest('hex');
assert.equal(sha(baseline),JSON.parse(readFileSync('tests/baselines/minimap-background/manifest.json')).sha256,'frozen baseline changed');
const {chromium}=createRequire(import.meta.url)(v.playwright||'playwright');
const app=createServer({port:0,host:'127.0.0.1'}),results=[],errors=[];
const state=new Game([1,2,3,4].map(i=>({name:'P'+i})),{random:randomSource(91),now:()=>0}).state();
let browser;
try{
 const {port}=await app.listen();
 for(let round=1;round<=+v.rounds;round++)for(const variant of round%2?['baseline','current']:['current','baseline']){
  browser=await chromium.launch({headless:true,executablePath:v.executable});const page=await browser.newPage();
  await page.route('**/app.js',r=>r.fulfill({contentType:'text/javascript',body:''}));
  if(variant==='baseline')await page.route('**/minimap-cache.js',r=>r.fulfill({contentType:'text/javascript',body:readFileSync(baseline,'utf8')}));
  page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${port}/`);
  const rows=await page.evaluate(async initial=>{
   const {Battlefield}=await import('/renderer.js');const rows=[];
   const packet=(entries,snapshot=false)=>{const b=new ArrayBuffer(8+entries.length*4),v=new DataView(b);v.setUint32(0,+snapshot,true);v.setUint32(4,1,true);entries.forEach(([k,o],i)=>v.setUint32(8+i*4,k+o*1000000,true));return b;};
   for(const [name,L,width,owners] of [['mono',900000,180,1],['four',500000,180,4],['fractional',100000,197,4]]){
    const main=document.createElement('canvas'),mini=document.createElement('canvas');main.style.cssText='width:800px;height:600px';mini.width=mini.height=width;document.body.append(main,mini);
    const f=new Battlefield(main,mini,{grid:true,ranges:true,motion:true});let s=structuredClone(initial);
    f.setState(s);const entries=Array.from({length:L},(_,i)=>[owners===1?i:i*7919%1000000,i%owners+1]);
    f.updatePacket(packet(entries,true));f.drawMinimap();mini.toDataURL();
    for(const step of ['unindexed-node','index','node','eliminate','restore','me','move-node','move-back','many-nodes','dense-background','reindex','edge-base']){
     let packetMs=0;const apply=entries=>{const t=performance.now();f.updatePacket(packet(entries));packetMs+=performance.now()-t;};
     if(['index','reindex','node','eliminate','restore','me','many-nodes'].includes(step))apply([entries[0]]);
     if(step==='dense-background')apply(entries.map(([k,o])=>[k,o%4+1]));
     if(['unindexed-node','node','dense-background'].includes(step))s.nodes[0].owner=s.nodes[0].owner%4+1;
     if(step==='eliminate')s.players[0].eliminated=true;
     if(step==='restore')s.players[0].eliminated=false;
     if(step==='me')f.me=2;
     if(step==='move-node')s.nodes[0].x+=.375;
     if(step==='move-back')s.nodes[0].x-=.375;
     if(step==='many-nodes')s.nodes.forEach(n=>n.owner=3);
     if(step==='edge-base'){s.players[0].x=0;s.players[0].y=999.75;}
     f.setState(s);const previousMembers=f.minimapCache.members;
     const start=performance.now();f.drawMinimap();const submitted=performance.now(),png=mini.toDataURL(),end=performance.now();
     const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(png));
     rows.push({name,L,width,step,packetMs,submitMs:submitted-start,completionMs:end-submitted,totalMs:end-start,indexRetained:!!previousMembers&&previousMembers===f.minimapCache.members,pngHash:[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('')});
    }
    main.remove();mini.remove();
   }return rows;
  },state);
  results.push({round,variant,rows});await browser.close();browser=null;console.log(JSON.stringify({round,variant}));
 }
 assert.deepEqual(errors,[]);
 const pixelMatch=Array.from({length:+v.rounds},(_,i)=>results.filter(r=>r.round===i+1)).every(pair=>JSON.stringify(pair[0].rows.map(r=>r.pngHash))===JSON.stringify(pair[1].rows.map(r=>r.pngHash)));
 mkdirSync(v.output,{recursive:true});writeFileSync(v.output+'/report.json',JSON.stringify({baselineHash:sha(baseline),sourceHashes:Object.fromEntries(['public/minimap-cache.js','public/renderer.js'].map(f=>[f,sha(f)])),pixelMatch,scope:'Controlled state transitions; completion includes PNG encoding, not pure GPU time. No ambient RAF. Whole-state geometry changes intentionally fall back.',results},null,2));
 assert.ok(pixelMatch,'pixel mismatch; raw hashes retained');console.log(JSON.stringify({pixelMatch,pairs:results.length/2*36}));
}finally{await browser?.close();await app.close();}
