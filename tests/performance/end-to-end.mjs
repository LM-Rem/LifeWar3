// Real production server loops, WebSockets and Battlefield RAF; fixture injection only.
import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {mkdirSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {scenario} from './scenarios.mjs';
import {summarize} from './statistics.mjs';
import {environment} from './environment.mjs';
const {values:v}=parseArgs({options:{playwright:{type:'string'},executable:{type:'string'},variant:{type:'string'},scenario:{type:'string'},rounds:{type:'string',default:'3'},generations:{type:'string',default:'100'},warmup:{type:'string',default:'100'},clients:{type:'string',default:'4'},dpr:{type:'string',default:'1'},output:{type:'string',default:'artifacts/performance/2026-09-25/e2e'},help:{type:'boolean'}}});
if(v.help){console.log('end-to-end.mjs [--variant initial|current-v1|current-v2] [--scenario P01|P03|P04] [--rounds 3] [--generations 100] [--warmup 100] [--clients 4] [--dpr 1|2] [--playwright PATH] [--executable PATH] [--output DIR]');process.exit(0);}
for(const k of ['rounds','generations','warmup','clients','dpr'])assert.ok(Number.isSafeInteger(+v[k])&&+v[k]>0,k);
assert.ok(+v.clients<=4&&[1,2].includes(+v.dpr));
const variants=['initial','current-v1','current-v2'],scenarios=['P01','P03','P04'];
if(v.variant)assert.ok(variants.includes(v.variant));if(v.scenario)assert.ok(scenarios.includes(v.scenario));
mkdirSync(v.output,{recursive:true});
if(!v.variant){
 const reports=[];
 for(const id of v.scenario?[v.scenario]:scenarios)for(let round=0;round<+v.rounds;round++)for(const variant of round%2?[...variants].reverse():variants){
  const output=`${v.output}/${id}-${variant}-${round+1}`;
  const args=[fileURLToPath(import.meta.url),'--variant',variant,'--scenario',id,'--output',output];
  for(const k of ['playwright','executable','generations','warmup','clients','dpr'])if(v[k])args.push('--'+k,v[k]);
  const r=spawnSync(process.execPath,args,{stdio:'inherit',windowsHide:true});
  if(r.status!==0)throw new Error(`Run failed: ${id}/${variant}/${round+1}`);
  const report=JSON.parse(readFileSync(`${output}/report.json`));reports.push({round:round+1,...report.summary});
  const peers=reports.filter(r=>r.scenario===id);assert.ok(peers.every(r=>r.warmBoardHash===report.summary.warmBoardHash&&r.finalBoardHash===report.summary.finalBoardHash),'A/B fixture diverged');
  writeFileSync(`${v.output}/summary.json`,JSON.stringify(reports,null,2));
 }
 process.exit(0);
}
process.env.LIFEWAR_CONFIG_PATH=fileURLToPath(new URL('../fixtures/performance/production-20hz.json',import.meta.url));
const initial=v.variant==='initial',version=v.variant==='current-v2'?2:1;
const base=new URL(initial?'../reference/':'../../',import.meta.url);
const {Game}=await import(new URL('src/engine.js',base));
const {createServer}=await import(new URL('src/server.js',base));
const {chromium}=createRequire(import.meta.url)(v.playwright||'playwright');
const hash=b=>createHash('sha256').update(b).digest('hex');
const files=['src','public'].flatMap(dir=>readdirSync(new URL(dir+'/',base),{recursive:true}).filter(f=>/\.(js|json)$/.test(f)).map(f=>dir+'/'+f.replaceAll('\\','/')));
const hashes=()=>Object.fromEntries(files.map(f=>[f,hash(readFileSync(new URL(f,base)))]));
const sourceHashes=hashes(),env=environment(),app=createServer({port:0,host:'127.0.0.1',trace:false,boardProtocol:version});
const game=scenario(Game,v.scenario||'P01');game.rebuildDerivedState?.();
for(let i=0;i<+v.warmup;i++){game.step();game.changes.clear();}
assert.equal(game.status,'playing');assert.ok(game.alive.length);
const startGeneration=game.generation,target=startGeneration+(+v.generations),warmBoardHash=hash(game.board),samples=[],memory=[{phase:'warm',...process.memoryUsage()}];
let browser,tickStart,current,finish,measuring=false,wireBytes=0,snapshotCount=0;
const done=new Promise(resolve=>finish=resolve),errors=[],pages=[],sessions=[];
try{
 const {port}=await app.listen();browser=await chromium.launch({headless:true,executablePath:v.executable});env.browser=browser.version();
 for(let i=0;i<+v.clients;i++){
  const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:+v.dpr});pages.push(page);
  page.on('pageerror',e=>{errors.push(e.message);console.error('browser error:',e.message);});
  page.on('console',m=>{if(m.type()==='error')console.error(m.text());});
  await page.route('**/app.js',r=>r.fulfill({contentType:'text/javascript',body:''}));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.evaluate(async({initial,version})=>{
   const {Battlefield}=await import('/renderer.js');
   document.body.innerHTML='<canvas id="main" style="width:1600px;height:900px"></canvas><canvas id="mini" width="180" height="180"></canvas>';
   const b=window.bench={received:[],drawn:[],frames:[],raf:[],decode:[],apply:[],mini:[],queue:[],failures:[],memory:[],measuring:false,ready:false};
   const f=window.field=new Battlefield(document.querySelector('#main'),document.querySelector('#mini'),{grid:true,ranges:true,motion:true});
   f.me=1;f.camera={x:500,y:500,zoom:.8};if(!initial)f.presentation.configure(version,7);
   // Wrap the bound RAF callback before the first callback runs.
   const frame=f.frame;let last;
   f.frame=now=>{const t=performance.now();if(b.measuring&&last)b.raf.push(now-last);last=now;frame(now);if(b.measuring){b.frames.push(performance.now()-t);b.queue.push(f.presentation?.packets.length??null);if(!b.lastMemory||now-b.lastMemory>1000){b.lastMemory=now;b.memory.push({atMs:now,used:performance.memory?.usedJSHeapSize??null,total:performance.memory?.totalJSHeapSize??null});}}};
   for(const [method,name] of [['updatePacket','apply'],['drawMinimap','mini']]){const fn=f[method];f[method]=function(...args){const t=performance.now();const result=fn.apply(this,args);if(b.measuring)b[name].push(performance.now()-t);return result;};}
   const draw=f.draw;f.draw=function(...args){const result=draw.apply(this,args);b.lastDraw=this.generation;if(b.tracking&&b.drawn.at(-1)!==this.generation)b.drawn.push(this.generation);return result;};
   const ws=window.socket=new WebSocket(`ws://${location.host}/ws`);ws.binaryType='arraybuffer';
   f.onRecovery=reason=>{if(b.tracking)b.failures.push(reason);ws.send(JSON.stringify({type:'resync'}));};
   ws.onmessage=e=>{
    if(typeof e.data==='string'){const s=JSON.parse(e.data);if(s.type==='state'){if(initial)f.setState(s);else f.receiveState(s);}return;}
    const view=new DataView(e.data),generation=view.getUint32(version===2?12:4,true),t=performance.now();
    if(b.tracking)b.received.push(generation);
    if(initial)f.updatePacket(e.data);else f.receivePacket(e.data);
    if(b.measuring)b.decode.push(performance.now()-t);
   };
   ws.onopen=()=>{b.ready=true;};ws.onerror=()=>{b.socketError=true;};f.active=true;
  },{initial,version});
  await page.waitForFunction(()=>window.bench.ready||window.bench.socketError);assert.ok(await page.evaluate(()=>window.bench.ready),'WebSocket failed');
  sessions.push(await page.context().newCDPSession(page));
 }
 const sockets=[...app.wss.clients];assert.equal(sockets.length,+v.clients);
 const room={code:'BENCH1',host:1,epoch:7,startedAt:game.startedAt,lastActive:Date.now(),lastActiveGen:0,boardGeneration:startGeneration,broadcastBoard:version===2?game.board.slice():null,members:[]};
 for(let i=0;i<sockets.length;i++){
  const ws=sockets[i],member={id:i+1,name:'P'+(i+1),ws,bot:false,ready:true};room.members.push(member);ws.room=room;ws.member=member;ws.boardVersion=version;
  const send=ws.send;ws.send=function(data,...args){if(measuring){const bytes=typeof data==='string'?Buffer.byteLength(data):data.byteLength;wireBytes+=bytes+(bytes<126?2:bytes<65536?4:10);if(typeof data!=='string'){const a=data instanceof ArrayBuffer?new DataView(data):new DataView(data.buffer,data.byteOffset,data.byteLength);if(version===2?a.getUint16(6,true)===1:a.getUint32(0,true)===1)snapshotCount++;}}return send.call(this,data,...args);};
  ws.send(JSON.stringify(game.state(i+1)));ws.send(version===2?game.packetV2({roomEpoch:7,snapshot:true}):game.packet(true));
 }
 await Promise.all(pages.map(p=>p.waitForFunction(g=>window.bench.lastDraw===g,startGeneration,{timeout:60000})));
 const step=game.step.bind(game),clear=game.changes.clear.bind(game.changes);
 game.step=()=>{tickStart=performance.now();current={generation:game.generation+1,atMs:tickStart};step();current.stepMs=performance.now()-tickStart;current.L=game.alive.length;current.D=game.changes.size;};
 game.changes.clear=()=>{clear();if(!measuring)return;current.tickMs=performance.now()-tickStart;current.wireBytes=wireBytes;current.bufferedBytes=sockets.map(s=>s.bufferedAmount);samples.push(current);memory.push({generation:game.generation,...process.memoryUsage()});if(game.generation>=target){app.rooms.delete(room.code);measuring=false;finish();}};
 await Promise.all(pages.map(p=>p.evaluate(()=>{window.bench.measuring=true;window.bench.tracking=true;window.bench.started=performance.now();})));
 const begin=performance.now();measuring=true;room.game=game;app.rooms.set(room.code,room);
 let timeout;await Promise.race([done,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('run timeout')),Math.max(120000,+v.generations*2000));})]);clearTimeout(timeout);
 const elapsedMs=performance.now()-begin;
 // Let the finite tail drain without measuring idle RAF frames.
 await Promise.all(pages.map(p=>p.evaluate(()=>{window.bench.measuring=false;})));
 await delay(1000);
 const clients=[];
 for(let i=0;i<pages.length;i++){
  const raw=await pages[i].evaluate(()=>({...window.bench,lastDraw:window.field.generation,queueRemaining:window.field.presentation?.packets.length??null,visibility:document.visibilityState,heap:performance.memory?{used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize}:null}));
  raw.cdpHeap=await sessions[i].send('Runtime.getHeapUsage');
  const drawn=new Set(raw.drawn),received=new Set(raw.received);const undrawn=raw.received.filter(g=>!drawn.has(g));
  const missing=Array.from({length:+v.generations},(_,i)=>startGeneration+i+1).filter(g=>!received.has(g));
  clients.push({summary:{frameMs:summarize(raw.frames),rafMs:summarize(raw.raf),decodeMs:summarize(raw.decode),applyMs:summarize(raw.apply),minimapMs:summarize(raw.mini),queueDepth:initial?null:summarize(raw.queue),undrawnGenerations:undrawn.length,missingGenerations:missing.length,failures:raw.failures.length,heap:raw.cdpHeap,visibility:raw.visibility},raw,undrawn,missing});
 }
 assert.deepEqual(errors,[]);assert.deepEqual(hashes(),sourceHashes,'sources changed');
 const summary={variant:v.variant,scenario:v.scenario||'P01',clients:+v.clients,dpr:+v.dpr,generations:+v.generations,warmup:+v.warmup,warmBoardHash,finalBoardHash:hash(game.board),tickMs:summarize(samples.map(s=>s.tickMs)),stepMs:summarize(samples.map(s=>s.stepMs)),L:summarize(samples.map(s=>s.L)),D:summarize(samples.map(s=>s.D)),deadlineMisses:samples.filter(s=>s.tickMs>50).length,elapsedMs,observedHz:+v.generations*1000/elapsedMs,wireBytes,wireBytesPerSecond:wireBytes*1000/elapsedMs,wireBytesPerGeneration:wireBytes/(+v.generations),snapshotCount,serverMemory:memory.at(-1),clientMetrics:clients.map(c=>c.summary)};
 summary.realtimePass=summary.tickMs.p95<=25&&summary.tickMs.p99<=40&&summary.deadlineMisses===0&&summary.observedHz>=19.5&&snapshotCount===0&&clients.every(c=>c.summary.frameMs.p95<=8&&c.summary.frameMs.p99<=12&&c.summary.rafMs.p99<=25&&!c.summary.undrawnGenerations&&!c.summary.missingGenerations&&!c.summary.failures&&(initial||c.summary.queueDepth.max<=2));
 const report={summary,environment:env,sourceHashes,harnessHash:hash(readFileSync(fileURLToPath(import.meta.url))),scope:'Production server loop and renderer, headless same-machine loopback clients. Tick from step entry through changes.clear includes encode/state/send/baseline maintenance; excludes preceding no-op AI/connection bookkeeping. Synthetic fixed rules/time, no HUD/app input handler, no physical scanout or LAN certification. Tail gets one second to drain with idle frame timings excluded. Heap excludes GPU memory; short-run memory is not a soak certificate.',samples,memory,clients};
 writeFileSync(`${v.output}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(summary));
}finally{await browser?.close();await app.close();}
