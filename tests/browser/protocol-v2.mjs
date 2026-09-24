import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from '../../src/server.js';
import {createServer as referenceServer} from '../reference/src/server.js';
import {Game} from '../../src/engine.js';
import {randomSource} from '../helpers/load-fixture.js';
const {values}=parseArgs({options:{playwright:{type:'string'},executable:{type:'string'}}});
const {chromium}=createRequire(import.meta.url)(values.playwright||'playwright');
const app=createServer({port:0,host:'127.0.0.1',boardProtocol:2}),oracle=referenceServer({port:0,host:'127.0.0.1'});
const game=new Game([1,2,3,4].map(i=>({name:'P'+i})),{random:randomSource(91),now:()=>0});
const steps=[];let previous=game.board.slice(),baseGeneration=0;
const record=(name,snapshot=false)=>{steps.push({name,v1:Buffer.from(game.packet(snapshot)).toString('base64'),v2:Buffer.from(game.packetV2({roomEpoch:7,baseGeneration,previous,snapshot})).toString('base64')});previous=game.board.slice();baseGeneration=game.generation;game.changes.clear();};
const keys=Array.from({length:262144},(_,i)=>{const j=i*7919%262144;return Math.floor(j/512)*1000+j%512;});
const write=(k,o)=>{game.board[k]=o;game.changes.set(k,o);};
for(const k of keys){game.board[k]=k%4+1;game.alive.push(k);}record('snapshot',true);
game.generation++;for(const k of keys)write(k,game.board[k]%4+1);record('dense-owner');
game.generation++;for(let i=0;i<keys.length;i+=2)write(keys[i],0);record('deaths');
game.generation++;for(let i=keys.length-2;i>=0;i-=2)write(keys[i],i%4+1);record('reverse-births');
game.generation++;record('empty');
game.generation++;for(let i=0;i<2000;i++)write(keys[i],i%5);record('sparse');
write(keys[10],0);write(keys[10],4);write(keys[11],0);record('same-generation-revision');
game.alive.length=0;for(const k of keys)if(game.board[k])game.alive.push(k);record('recovery',true);
let browser;const results={},errors=[];
try{
 const a=await app.listen(),b=await oracle.listen();browser=await chromium.launch({headless:true,executablePath:values.executable});
 for(const [variant,port] of [['reference',b.port],['v1',a.port],['v2',a.port]]){
  results[variant]=[];
  for(const dpr of [1,2]){
   const page=await browser.newPage({viewport:{width:1000,height:800},deviceScaleFactor:dpr});page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${port}/`);
   const result=await page.evaluate(async ({steps,state,variant})=>{
    const {Battlefield}=await import('/renderer.js'),canvas=document.createElement('canvas'),mini=document.createElement('canvas');
    canvas.style.cssText='width:800px;height:600px';mini.width=mini.height=180;document.body.append(canvas,mini);
    const field=new Battlefield(canvas,mini,{grid:true,ranges:true,motion:true});field.setState(state);field.camera={x:475.25,y:475.75,zoom:3.5};
    if(variant==='v2')field.presentation.configure(2,7);
    const digest=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
    const out=[];
    for(const step of steps){
     const buffer=Uint8Array.from(atob(step[variant==='v2'?'v2':'v1']),c=>c.charCodeAt(0)).buffer;
     if(variant==='v2'){if(!field.receivePacket(buffer))throw new Error('queue rejected '+step.name);field.presentNext();if(field.presentation.waiting)throw new Error('baseline failed '+step.name);}
     else field.updatePacket(buffer);
     field.draw(1000);field.drawMinimap();const values=new Uint32Array(field.cells.size);let i=0;for(const [k,o] of field.cells)values[i++]=k+o*1000000;
     out.push({name:step.name,generation:field.generation,main:await digest(new TextEncoder().encode(canvas.toDataURL())),mini:await digest(new TextEncoder().encode(mini.toDataURL())),order:await digest(values.buffer)});
    }return out;
   },{steps,state:game.state(),variant});results[variant].push({dpr,result});await page.close();
  }
 }
 assert.deepEqual(results.v1,results.reference);assert.deepEqual(results.v2,results.reference);
 // New client assets must also work against a server that advertises only v1.
 for(const [port,expected] of [[a.port,2],[b.port,1]]){
  const page=await browser.newPage(),started=[],epochs=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('websocket',socket=>socket.on('framereceived',({payload})=>{if(typeof payload==='string'){try{const msg=JSON.parse(payload);if(msg.type==='started'){started.push(msg.boardProtocol??1);epochs.push(msg.roomEpoch??msg.startedAt);}}catch{}}}));
  if(expected===1)await page.route('**/*.js',async route=>{const name=new URL(route.request().url()).pathname.slice(1);if(!/^[a-z0-9-]+\.js$/i.test(name))return route.continue();await route.fulfill({contentType:'text/javascript',body:readFileSync(new URL('../../public/'+name,import.meta.url),'utf8')});});
  await page.goto(`http://127.0.0.1:${port}/`);await page.locator('#practice').click();await page.waitForFunction(()=>Number(document.querySelector('#generation')?.textContent.replace(/\D/g,''))>=4);
  assert.deepEqual(started,[expected]);await page.reload();await page.waitForFunction(()=>Number(document.querySelector('#generation')?.textContent.replace(/\D/g,''))>=6);
  assert.deepEqual(started,[expected,expected]);assert.equal(epochs[0],epochs[1],'resume keeps room epoch');await page.close();
 }
 assert.deepEqual(errors,[]);
 const sourceHashes=Object.fromEntries(['renderer.js','board-protocol.js','generation-queue.js','app.js','minimap-cache.js'].map(f=>[f,createHash('sha256').update(readFileSync(new URL('../../public/'+f,import.meta.url))).digest('hex')]));
 const report={status:'PASS',browser:browser.version(),sourceHashes,pixelComparisons:steps.length*2*2*2,orderedMapComparisons:steps.length*2*2,negotiatedVersions:[2,1],resumeVersions:[2,1],scope:'controlled Canvas submission and PNG equality, plus real new/old-server handshakes and reload/resume; not physical presentation',results};
 mkdirSync('artifacts/performance/t13',{recursive:true});writeFileSync('artifacts/performance/t13/browser.json',JSON.stringify(report,null,2));console.log(JSON.stringify({...report,results:undefined}));
}finally{await browser?.close();await app.close();await oracle.close();}
