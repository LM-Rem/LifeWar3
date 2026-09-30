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
let advertisePalette=true,advertiseModes=true;
app.wss.prependListener('connection',ws=>{const send=ws.send.bind(ws);ws.send=(data,...args)=>{if((!advertisePalette||!advertiseModes)&&typeof data==='string'){const m=JSON.parse(data);if(m.type==='hello'){m.boardEncodings=m.boardEncodings.filter(e=>(advertisePalette||e!==4)&&(advertiseModes||e!==5));data=JSON.stringify(m);}}return send(data,...args);};});
const game=new Game([1,2,3,4].map(i=>({name:'P'+i})),{random:randomSource(91),now:()=>0});
const steps=[];let previous=game.board.slice(),baseGeneration=0;
const record=(name,snapshot=false)=>{steps.push({name,modes:Buffer.from(game.packetV2({roomEpoch:7,baseGeneration,previous,snapshot,allowVarint:true,allowBitmap:true,allowPalette:true,allowTileModes:true})).toString('base64'),palette:Buffer.from(game.packetV2({roomEpoch:7,baseGeneration,previous,snapshot,allowVarint:true,allowBitmap:true,allowPalette:true})).toString('base64'),v1:Buffer.from(game.packet(snapshot)).toString('base64'),bitmap:Buffer.from(game.packetV2({roomEpoch:7,baseGeneration,previous,snapshot,allowVarint:true,allowBitmap:true})).toString('base64'),v2:Buffer.from(game.packetV2({roomEpoch:7,baseGeneration,previous,snapshot,allowVarint:true})).toString('base64')});previous=game.board.slice();baseGeneration=game.generation;game.changes.clear();};
const keys=Array.from({length:262144},(_,i)=>{const j=i*7919%262144;return Math.floor(j/512)*1000+j%512;});
const write=(k,o)=>{game.board[k]=o;game.changes.set(k,o);};
for(const k of keys){game.board[k]=k%4+1;game.alive.push(k);}record('snapshot',true);
game.generation++;for(const k of keys)write(k,game.board[k]%4+1);record('dense-owner');
game.generation++;for(let i=0;i<keys.length;i+=2)write(keys[i],0);record('deaths');
game.generation++;for(let i=keys.length-2;i>=0;i-=2)write(keys[i],i%4+1);record('reverse-births');
game.generation++;for(const k of keys)write(k,4);record('single-owner');
game.generation++;for(const k of keys)write(k,k%1000<245?1:4);record('two-owner-boundary');
game.generation++;for(const k of keys)write(k,Math.floor(k/1000)%32<16?1:4);record('row-runs');
game.generation++;for(let i=0;i<keys.length;i+=8)write(keys[i],game.board[keys[i]]%4+1);record('change-mask');
game.generation++;record('empty');
game.generation++;for(let i=0;i<2000;i++)write(keys[i],i%5);record('sparse');
write(keys[10],0);write(keys[10],4);write(keys[11],0);record('same-generation-revision');
game.alive.length=0;for(const k of keys)if(game.board[k])game.alive.push(k);record('recovery',true);
let browser;const results={},errors=[];
try{
 const a=await app.listen(),b=await oracle.listen();browser=await chromium.launch({headless:true,executablePath:values.executable});
 for(const [variant,port] of [['reference',b.port],['v1',a.port],['v2',a.port],['bitmap',a.port],['palette',a.port],['modes',a.port]]){
  results[variant]=[];
  for(const dpr of [1,2]){
   const page=await browser.newPage({viewport:{width:1000,height:800},deviceScaleFactor:dpr});page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${port}/`);
   const result=await page.evaluate(async ({steps,state,variant})=>{
    const {Battlefield}=await import('/renderer.js'),canvas=document.createElement('canvas'),mini=document.createElement('canvas');
    canvas.style.cssText='width:800px;height:600px';mini.width=mini.height=180;document.body.append(canvas,mini);
    const field=new Battlefield(canvas,mini,{grid:true,ranges:true,motion:true});field.setState(state);field.camera={x:475.25,y:475.75,zoom:3.5};
    if(['v2','bitmap','palette','modes'].includes(variant))field.presentation.configure(2,7,{bitmapTiles:['bitmap','palette','modes'].includes(variant),paletteTiles:['palette','modes'].includes(variant),tileModes:variant==='modes'});
    const digest=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
    const out=[];
    for(const step of steps){
     const buffer=Uint8Array.from(atob(step[variant==='modes'?'modes':variant==='palette'?'palette':variant==='bitmap'?'bitmap':variant==='v2'?'v2':'v1']),c=>c.charCodeAt(0)).buffer;
     if(['v2','bitmap','palette','modes'].includes(variant)){if(!field.receivePacket(buffer))throw new Error('queue rejected '+step.name);field.presentNext();if(field.presentation.waiting)throw new Error('baseline failed '+step.name);}
     else field.updatePacket(buffer);
     field.draw(1000);field.drawMinimap();const values=new Uint32Array(field.cells.size);let i=0;for(const [k,o] of field.cells)values[i++]=k+o*1000000;
     out.push({name:step.name,generation:field.generation,main:await digest(new TextEncoder().encode(canvas.toDataURL())),mini:await digest(new TextEncoder().encode(mini.toDataURL())),board:await digest(field.board),order:await digest(values.buffer)});
    }return out;
   },{steps,state:game.state(),variant});results[variant].push({dpr,result});await page.close();
  }
 }
 const mainOnly=rows=>rows.map(({dpr,result})=>({dpr,result:result.map(({mini,...rest})=>rest)}));assert.deepEqual(mainOnly(results.v1),mainOnly(results.reference));assert.deepEqual(mainOnly(results.v2),mainOnly(results.reference));assert.deepEqual(results.v1,results.v2);const withoutOrder=rows=>rows.map(({dpr,result})=>({dpr,result:result.map(({order,...rest})=>rest)}));assert.deepEqual(withoutOrder(results.bitmap),withoutOrder(results.v1));assert.deepEqual(withoutOrder(results.palette),withoutOrder(results.v1));assert.deepEqual(withoutOrder(results.modes),withoutOrder(results.v1));
 // New client assets must also work against a server that advertises only v1.
 for(const [port,expected,palette,modes] of [[a.port,2,true,true],[a.port,2,true,false],[a.port,2,false,false],[b.port,1,false,false]]){
  advertisePalette=palette;advertiseModes=modes;console.log(JSON.stringify({handshake:{expected,palette,modes}}));
  const page=await browser.newPage(),started=[],epochs=[],capabilities=[],modeCapabilities=[],received=[];
  page.on('console',m=>{if(m.type()==='error'&&m.text().includes('Message error'))errors.push(m.text());});
  page.on('pageerror',e=>errors.push(e.message));page.on('websocket',socket=>socket.on('framereceived',({payload})=>{if(typeof payload!=='string'){received.push(payload.readUInt32LE(expected===2?12:4));}else{try{const msg=JSON.parse(payload);if(msg.type==='started'){started.push(msg.boardProtocol??1);capabilities.push(msg.paletteTiles===true);modeCapabilities.push(msg.tileModes===true);epochs.push(msg.roomEpoch??msg.startedAt);}}catch{}}}));
  if(expected===1)await page.route('**/*.js',async route=>{const name=new URL(route.request().url()).pathname.slice(1);if(!/^[a-z0-9-]+\.js$/i.test(name))return route.continue();await route.fulfill({contentType:'text/javascript',body:readFileSync(new URL('../../public/'+name,import.meta.url),'utf8')});});
  await page.goto(`http://127.0.0.1:${port}/`);await page.locator('#practice').click();await page.waitForFunction(()=>Number(document.querySelector('#generation')?.textContent.replace(/\D/g,''))>=4).catch(async error=>{console.error(JSON.stringify({started,capabilities,errors,received:received.slice(-10),server:[...(expected===1?oracle:app).rooms.values()].map(r=>({generation:r.game?.generation,status:r.game?.status})),dom:await page.locator('#generation').textContent(),visibility:await page.evaluate(()=>document.visibilityState)}));throw error;});
  if(expected===2)await page.waitForFunction(()=>window.lifeWarNetwork?.displayed>=0);
  assert.deepEqual(started,[expected]);await page.reload();await page.waitForFunction(()=>Number(document.querySelector('#generation')?.textContent.replace(/\D/g,''))>=6);
  assert.deepEqual(started,[expected,expected]);assert.deepEqual(capabilities,[palette,palette]);assert.deepEqual(modeCapabilities,[modes,modes]);assert.equal(epochs[0],epochs[1],'resume keeps room epoch');await page.close();app.rooms.clear();oracle.rooms.clear();
 }
 assert.deepEqual(errors,[]);
 const sourceHashes=Object.fromEntries(['renderer.js','bitmap-codec.js','tile-mode-planner.js','board-protocol.js','generation-queue.js','app.js','minimap-cache.js'].map(f=>[f,createHash('sha256').update(readFileSync(new URL('../../public/'+f,import.meta.url))).digest('hex')]));
 const report={status:'PASS',browser:browser.version(),sourceHashes,mainPixelComparisons:steps.length*2*5,minimapProtocolComparisons:steps.length*2*4,orderedMapComparisons:steps.length*2*2,negotiatedVersions:[2,2,2,1],resumeVersions:[2,2,2,1],paletteCapabilities:[true,true,false,false],tileModesCapabilities:[true,false,false,false],scope:'main Canvas PNG equality against reference; approximate minimap equal across current v1/v2/bitmap/palette/tileModes (unordered board equality without insertion order), plus real new/old-v2-capability/v1-server handshakes and reload/resume; not physical presentation',results};
 mkdirSync('artifacts/performance/tile-modes-production',{recursive:true});writeFileSync('artifacts/performance/tile-modes-production/browser.json',JSON.stringify(report,null,2));console.log(JSON.stringify({...report,results:undefined}));
}finally{await browser?.close();await app.close();await oracle.close();}
