import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createServer} from '../../src/server.js';
import {createServer as referenceServer} from '../reference/src/server.js';
import {Game} from '../reference/src/engine.js';
import {randomSource} from '../helpers/load-fixture.js';
const {values}=parseArgs({options:{playwright:{type:'string'},executable:{type:'string'},output:{type:'string',default:'artifacts/performance/render-equivalence'}}});
const {chromium}=createRequire(import.meta.url)(values.playwright||'playwright');
const app=createServer({port:0,host:'127.0.0.1'}),oracle=referenceServer({port:0,host:'127.0.0.1'});
let browser;
try {
 const a=await app.listen(),b=await oracle.listen();browser=await chromium.launch({headless:true,executablePath:values.executable});
 const state=new Game([1,2,3,4].map(i=>({name:'P'+i})),{random:randomSource(91),now:()=>0}).state();
 const results={};const errors=[];
 for(const [label,port] of [['reference',b.port],['current',a.port]]) {
  results[label]=[];
  for(const dpr of [1,2]) {
   const page=await browser.newPage({viewport:{width:1000,height:800},deviceScaleFactor:dpr});page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${port}/`);
   const result=await page.evaluate(async state=>{
    const {Battlefield}=await import('/renderer.js');
    const canvas=document.createElement('canvas'),mini=document.createElement('canvas');canvas.style.cssText='width:800px;height:600px';mini.width=mini.height=180;document.body.append(canvas,mini);
    const f=new Battlefield(canvas,mini,{grid:true,ranges:true,motion:true});f.setState(state);
    const hashes=[],timings=[];
    async function hash(c){const bytes=new TextEncoder().encode(c.toDataURL());return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');}
    function packet(entries,snapshot=false){const b=new ArrayBuffer(8+entries.length*4),v=new DataView(b);v.setUint32(0,snapshot?1:0,true);v.setUint32(4,1,true);entries.forEach(([k,o],i)=>v.setUint32(8+i*4,k+o*1000000,true));return b;}
    async function capture(name){f.draw(1000);f.drawMinimap();hashes.push({name,main:await hash(canvas),mini:await hash(mini)});}
    for(const D of [0,1,1000,100000,500000]) {
     // Multiplication permutes the whole board: edge cells and four owners overlap on the minimap.
     const entries=Array.from({length:D},(_,i)=>[(i*7919)%1000000,i%4+1]);
     const snap=packet(entries,true);let t=performance.now();f.updatePacket(snap);const packetMs=performance.now()-t;
     t=performance.now();f.drawMinimap();const firstMiniMs=performance.now()-t;
     t=performance.now();for(let i=0;i<20;i++)f.drawMinimap();const stableMiniMs=(performance.now()-t)/20;
     timings.push({D,packetMs,firstMiniMs,stableMiniMs});
     for(const zoom of [.45,1,3.5,7,22]){f.camera={x:475.25,y:475.75,zoom};await capture(`D${D}-z${zoom}`);}
     const changes=[[0,0],[7919,0],[999999,4],[450450,2],[450451,3],[450452,4]];
     let updateStart=performance.now();f.updatePacket(packet(changes));f.drawMinimap();timings.at(-1).firstLocalUpdateMs=performance.now()-updateStart;await capture(`D${D}-delete`);
     updateStart=performance.now();f.updatePacket(packet([[0,3],[7919,4],[450450,1],[450451,0],[450451,2]]));f.drawMinimap();timings.at(-1).indexedLocalUpdateMs=performance.now()-updateStart;await capture(`D${D}-rebirth`);
     f.camera.x+=.375;f.camera.y-=.625;await capture(`D${D}-camera`);
    }
    // Dense deltas exercise the fallback, including ownership changes without reordering.
    for(const D of [1000,100000,500000]) {
      const entries=Array.from({length:D},(_,i)=>[(i*7919)%1000000,(i+1)%4+1]);const deltas=[packet(entries),packet(entries.map(([k,o])=>[k,o%4+1]))];
      const samples=[];for(let i=0;i<8;i++){const t=performance.now();f.updatePacket(deltas[i%2]);f.drawMinimap();samples.push(performance.now()-t);}
      timings.push({deltaD:D,packetAndMiniSamplesMs:samples});await capture(`delta${D}`);
    }
    state.nodes[0].owner=3;state.players[0].eliminated=true;f.setState(state);await capture('ownership');
    mini.width=mini.height=197;await capture('resize');f.reset();await capture('reset');f.setState(state);f.updatePacket(packet([[999999,4],[0,1]],true));await capture('reconnect');
    // Dense cache reuse, consecutive same colors, and both sides of the index threshold.
    const mono=Array.from({length:100000},(_,i)=>[(i*7919)%1000000,2]);
    f.updatePacket(packet(mono,true));await capture('monochrome');
    f.updatePacket(packet([[0,2],[999999,2],[500500,2]]));await capture('same-owner-multiple-tiles');
    f.updatePacket(packet(mono.slice(0,4096).map(([k])=>[k,3])));await capture('threshold4096');
    f.updatePacket(packet(mono.slice(0,4097).map(([k])=>[k,1])));await capture('threshold4097');
    f.updatePacket(packet(mono));f.updatePacket(packet([[0,0],[999999,4],[0,2]]));await capture('dense-then-small');
    f.updatePacket(packet(mono,true));f.updatePacket(packet([[0,0],[999999,2]]));await capture('snapshot-then-small');
    // Background style changes with a live contributor index: every territory,
    // base elimination/restoration and all viewer stroke styles, at both DPRs.
    for(let i=0;i<state.nodes.length;i++){
      f.updatePacket(packet([[500500,2]]));state.nodes[i].owner=(i%4)+1;f.setState(state);await capture(`indexed-node-${i}`);
    }
    for(let i=0;i<state.players.length;i++)for(const eliminated of [true,false]){
      f.updatePacket(packet([[500500,2]]));state.players[i].eliminated=eliminated;f.setState(state);await capture(`indexed-base-${i}-${eliminated}`);
    }
    for(const me of [1,2,3,4]){f.updatePacket(packet([[500500,2]]));f.me=me;await capture(`indexed-me-${me}`);}
    return {hashes,timings};
   },structuredClone(state));results[label].push({dpr,...result});await page.close();
  }
 }
 mkdirSync(values.output,{recursive:true});writeFileSync(`${values.output}/raw.json`,JSON.stringify(results));assert.deepEqual(errors,[]);for(let i=0;i<2;i++)assert.deepEqual(results.current[i].hashes,results.reference[i].hashes,`DPR ${i+1}`);
 mkdirSync(values.output,{recursive:true});const sourceHashes=Object.fromEntries(['renderer.js','world-texture.js','minimap-cache.js','territory.js'].map(file=>[file,createHash('sha256').update(readFileSync(new URL('../../public/'+file,import.meta.url))).digest('hex')]));const report={sourceHashes,status:'PASS',browser:browser.version(),comparisons:results.current.reduce((n,r)=>n+r.hashes.length*2,0),scope:'headless lossless PNG equality; timings exploratory single session, not frame-presentation certification',results};writeFileSync(`${values.output}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,comparisons:report.comparisons,timings:results.current.map(r=>({dpr:r.dpr,timings:r.timings}))}));
}finally{await browser?.close();await app.close();await oracle.close();}
