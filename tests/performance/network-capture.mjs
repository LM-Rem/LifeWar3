// Capture a normal browser session without recording room/session tokens or private state.
import {parseArgs} from 'node:util';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
const {values:v}=parseArgs({options:{url:{type:'string'},seconds:{type:'string',default:'60'},output:{type:'string',default:'artifacts/performance/network-capture.json'},playwright:{type:'string'},executable:{type:'string'},headed:{type:'boolean'},practice:{type:'boolean'},help:{type:'boolean'}}});
if(v.help){console.log('network-capture.mjs --url http://HOST:3000/ [--headed (join a game manually)] [--practice (start local training)] [--seconds 60] [--playwright PATH] [--executable PATH] [--output FILE]');process.exit(0);}
if(!v.url||!/^https?:$/.test(new URL(v.url).protocol))throw new Error('--url must be http(s)');
const seconds=Number(v.seconds);if(!Number.isInteger(seconds)||seconds<1||seconds>3600)throw new Error('--seconds must be 1..3600');
const {chromium}=createRequire(import.meta.url)(v.playwright||'playwright');
const browser=await chromium.launch({headless:!v.headed,executablePath:v.executable});
const progress=[],rtt=[],traffic=[],epochs=[],errors=[];let connections=0,binaryBytes=0,jsonBytes=0,binaryMessages=0,snapshots=0,receivedGeneration=null;
try{
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
 page.on('websocket',socket=>{connections++;socket.on('framereceived',({payload})=>{
  if(typeof payload==='string'){
   jsonBytes+=Buffer.byteLength(payload);let m;try{m=JSON.parse(payload);}catch{return;}
   if(m.type==='pong'&&Number.isFinite(m.time))rtt.push({at:Date.now(),ms:Math.max(0,Date.now()-m.time)});
   if(m.type==='network_status'){
    const row={at:Date.now()};for(const k of ['roomEpoch','computedGeneration','sentGeneration','received','displayed','bufferedBytes','queueDepth','oldestMs','decodeMs','applyMs'])if(Number.isFinite(m[k]))row[k]=m[k];progress.push(row);
   }
   if(m.type==='started')epochs.push({at:Date.now(),roomEpoch:m.roomEpoch,boardProtocol:m.boardProtocol,bitmapTiles:!!m.bitmapTiles,paletteTiles:!!m.paletteTiles});
  }else{
   binaryBytes+=payload.length;binaryMessages++;
   if(payload.length>=8){const v2=payload.readUInt32LE(0)===0x3252574c;if(v2&&payload.length<32)return;receivedGeneration=payload.readUInt32LE(v2?12:4);if(v2?payload.readUInt16LE(6)===1:payload.readUInt32LE(0)===1)snapshots++;}
  }
 });});
 await page.goto(v.url);if(v.practice)await page.locator('#practice').click();
 const start=Date.now();for(let i=0;i<seconds;i++){await page.waitForTimeout(1000);traffic.push({elapsedMs:Date.now()-start,binaryBytes,jsonBytes,binaryMessages,snapshots,receivedGeneration,visibility:await page.evaluate(()=>document.visibilityState)});}
 const report={scope:'Browser WebSocket payload bytes only: excludes framing/TLS/tunnel overhead. Progress samples are delayed observations; no physical display or capacity certification. Snapshot count includes initial connection and reconnect.',browser:browser.version(),seconds,connections,epochs,traffic,progress,rtt,errors};
 mkdirSync(dirname(v.output),{recursive:true});writeFileSync(v.output,JSON.stringify(report,null,2));
 console.log(JSON.stringify({output:v.output,progressSamples:progress.length,binaryMessages,snapshots,errors}));
 if(!progress.length)process.exitCode=2;
}finally{await browser.close();}
