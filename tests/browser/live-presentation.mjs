import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const {values}=parseArgs({options:{playwright:{type:'string'},executable:{type:'string'}}});
process.env.LIFEWAR_CONFIG_PATH=fileURLToPath(new URL('../fixtures/performance/production-20hz.json',import.meta.url));
const {createServer}=await import('../../src/server.js');
const {chromium}=createRequire(import.meta.url)(values.playwright||'playwright');const app=createServer({port:0,host:'127.0.0.1',trace:true});let browser;
try{
 const {port}=await app.listen();browser=await chromium.launch({headless:true,executablePath:values.executable});const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${port}/?trace=1`);
 await page.evaluate(async()=>{const {Battlefield}=await import('/renderer.js');window.stateAlignment=[];const original=Battlefield.prototype.setState;Battlefield.prototype.setState=function(s){window.stateAlignment.push({state:s.generation,displayed:this.generation});return original.call(this,s);};});
 await page.locator('#practice').click();await page.waitForFunction(()=>window.lifeWarPerformance.export().records.some(r=>r.name==='drawnGeneration'&&r.generation>=100));
 // Delay delivery while simulation continues, then release all board and state messages in original order.
 const ws=[...app.wss.clients][0],send=ws.send,pending=[];ws.send=function(...args){pending.push(args);};await delay(200);ws.send=send;for(const args of pending)send.apply(ws,args);await delay(1000);
 const normal=await page.evaluate(()=>({trace:window.lifeWarPerformance.export(),alignment:window.stateAlignment}));
 const records=normal.trace.records,received=[...new Set(records.filter(r=>r.name==='receivedGeneration').map(r=>r.generation))],drawn=new Set(records.filter(r=>r.name==='drawnGeneration').map(r=>r.generation));
 const cutoff=Math.max(...received)-2;assert.ok(received.filter(g=>g<=cutoff).every(g=>drawn.has(g)),'every received generation before the tail must be submitted');
 assert.ok(normal.alignment.every(r=>r.state<=r.displayed));assert.ok(!records.some(r=>r.name==='presentation.failure'));assert.ok(Math.max(...records.filter(r=>r.name==='presentation.queueDepth').map(r=>r.value))<=5);
 // Exercise the browser's visibility handler deterministically; not an OS tab-throttling certification.
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});await delay(250);
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});await delay(1000);
 const after=await page.evaluate(()=>window.lifeWarPerformance.export());assert.ok(after.records.filter(r=>r.name==='presentation.recovery').length>=2);assert.ok(after.records.some(r=>r.name==='drawnGeneration'&&r.generation>cutoff+5));assert.deepEqual(errors,[]);
 const rec=records.filter(r=>r.name==='receivedGeneration');const observedInputHz=(rec.length-1)*1000/(rec.at(-1).atMs-rec[0].atMs);
 const result={observedInputHz,rafIntervalsMs:records.filter(r=>r.name==='rafInterval.ms').map(r=>r.value),status:'PASS',browser:browser.version(),scope:'20Hz configured WebSocket + actual RAF; observed cadence may differ; 200ms delivery burst; synthetic visibility event; draw submission not physical presentation',normalGenerationsThrough:cutoff,burstMessages:pending.length,
   queueDepthMax:Math.max(...records.filter(r=>r.name==='presentation.queueDepth').map(r=>r.value)),waitMs:records.filter(r=>r.name==='presentation.wait.ms').map(r=>r.value),normalStateAlignment:normal.alignment,normalTrace:normal.trace,recoveryTrace:after};
 mkdirSync('artifacts/performance/t12',{recursive:true});writeFileSync('artifacts/performance/t12/live.json',JSON.stringify(result,null,2));console.log(JSON.stringify({status:result.status,normalGenerationsThrough:cutoff,queueDepthMax:result.queueDepthMax,waitMax:Math.max(...result.waitMs)}));
}finally{await browser?.close();await app.close();}
