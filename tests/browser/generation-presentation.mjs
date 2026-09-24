import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createServer} from '../../src/server.js';
import {Game} from '../../src/engine.js';
import {randomSource} from '../helpers/load-fixture.js';
const {values}=parseArgs({options:{playwright:{type:'string'},executable:{type:'string'}}});
const {chromium}=createRequire(import.meta.url)(values.playwright||'playwright');
const app=createServer({port:0,host:'127.0.0.1'});let browser;
try{
 const {port}=await app.listen();browser=await chromium.launch({headless:true,executablePath:values.executable});
 const page=await browser.newPage({viewport:{width:1000,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${port}/`);
 const state=new Game([{name:'A'},{name:'B'}],{random:randomSource(91),now:()=>0}).state();
 const report=await page.evaluate(async state=>{
  const {Battlefield}=await import('/renderer.js');requestAnimationFrame=()=>0;
  const canvas=document.createElement('canvas'),mini=document.createElement('canvas');canvas.style.cssText='width:800px;height:600px';mini.width=mini.height=180;document.body.append(canvas,mini);
  const f=new Battlefield(canvas,mini,{grid:true,ranges:true,motion:true});f.active=true;let time=0;f.presentation.now=()=>time;const draws=[],events=[],states=[];f.onPresentedState=s=>states.push(s.generation);f.onPresentationEvent=(n,v)=>events.push([n,v]);
  const original=f.draw.bind(f);f.draw=now=>{original(now);draws.push({generation:f.generation,state:f.state?.generation,owner:f.board[180180]});};
  function packet(g,snapshot=false){const b=new ArrayBuffer(12),v=new DataView(b);v.setUint32(0,+snapshot,true);v.setUint32(4,g,true);v.setUint32(8,180180+(g%2+1)*1000000,true);return b;}
  f.receiveState({...state,generation:0});f.receivePacket(packet(0,true));f.frame(time);
  for(let i=1;i<=5;i++)f.receivePacket(packet(i));const barrierBefore=f.board[180180];f.receiveState({...state,generation:4});f.receiveState({...state,generation:2});
  for(let i=1;i<=5;i++){time+=16;f.frame(time);}
  const burst=draws.slice();const before=canvas.toDataURL();f.camera.x+=12;time+=16;f.frame(time);const cameraWithoutPacket=before!==canvas.toDataURL();
  const acceptedDuplicate=f.receivePacket(packet(5));const oldEpoch=f.presentation.epoch;f.reset();const acceptedOldEpoch=f.receivePacket(packet(6),oldEpoch);
  f.receiveState({...state,generation:10});f.receivePacket(packet(10,true));time+=16;f.frame(time);
  f.presentation.capacity=2;f.receivePacket(packet(11));f.receivePacket(packet(12));f.receivePacket(packet(13));const overflow={waiting:f.presentation.waiting,bytes:f.presentation.bytes,displayed:f.generation};
  f.receivePacket(packet(20,true));f.receiveState({...state,generation:20});time+=16;f.frame(time);
  f.presentation.visibility(true);const hiddenAccepted=f.receivePacket(packet(21));f.presentation.visibility(false);f.receivePacket(packet(30,true));f.receiveState({...state,generation:30});time+=16;f.frame(time);
  // 4096-cell preview: cached values must equal the original computation after each dependency changes.
  f.reset();f.setState(state);state.players[0].energy=1e6;state.players[0].capacity=1e6;f.pattern=Array.from({length:4096},(_,i)=>[i%64,Math.floor(i/64)]);f.pointer={x:400,y:300};f.camera={x:180,y:180,zoom:3.5};
  const previews=[];function check(name){const actual=f.placement(),expected=f.placementUncached();previews.push({name,equal:JSON.stringify(actual)===JSON.stringify(expected),reason:actual?.reason});}
  check('initial');const a=f.placement(),b=f.placement();const reused=a===b;
  let t=performance.now();for(let i=0;i<100;i++)f.placement();const cachedMs=performance.now()-t;t=performance.now();for(let i=0;i<100;i++)f.placementUncached();const uncachedMs=performance.now()-t;
  state.players[0].energy=0;check('energy');state.players[0].energy=1e6;state.players[0].eliminated=true;check('eliminated');state.players[0].eliminated=false;
  state.nodes[0].owner=2;check('node');f.camera.x+=1;check('camera');f.updatePacket(packet(1,true));check('board');f.pattern=f.pattern.map(([x,y])=>[y,x]);check('pattern');
  return {burst,barrierBefore,cameraWithoutPacket,acceptedDuplicate,acceptedOldEpoch,overflow,hiddenAccepted,draws,events,states,previews,reused,cachedMs,uncachedMs};
 },state);
 assert.deepEqual(report.burst.map(r=>r.generation),[0,1,2,3,4,5]);assert.equal(report.barrierBefore,1);assert.ok(report.burst.every(r=>r.state<=r.generation));
 for(const key of ['acceptedDuplicate','acceptedOldEpoch','hiddenAccepted'])assert.equal(report[key],false,key);
 assert.equal(report.overflow.waiting,true);assert.equal(report.overflow.bytes,0);assert.equal(report.overflow.displayed,10);
 assert.ok(report.cameraWithoutPacket);assert.ok(report.reused);assert.ok(report.previews.every(r=>r.equal));assert.deepEqual(errors,[]);
 mkdirSync('artifacts/performance/t12',{recursive:true});writeFileSync('artifacts/performance/t12/browser.json',JSON.stringify({status:'PASS',browser:browser.version(),scope:'controlled RAF and actual Canvas submission, not physical display certification',...report},null,2));console.log(JSON.stringify({status:'PASS',draws:report.draws.length,previews:report.previews,cachedMs:report.cachedMs,uncachedMs:report.uncachedMs}));
}finally{await browser?.close();await app.close();}
