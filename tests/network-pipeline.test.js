import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeBoardV2,decodeBoardPacket} from '../public/board-protocol.js';
import {Battlefield} from '../public/renderer.js';
import {CellStore} from '../public/cell-store.js';
import {RoomRuntime} from '../src/room-runtime.js';
import {acceptClientProgress} from '../src/client-progress.js';
import {WebSocket} from 'ws';
import {createServer} from '../src/server.js';
const N=1000000;
function packet(owner=2){const board=new Uint8Array(N),keys=[];for(let y=0;y<64;y++)for(let x=0;x<64;x++){const k=y*1000+x;keys.push(k);board[k]=(x+y)%3?owner:0;}return encodeBoardV2({board,keys,ownerAt:k=>board[k],allowBitmap:true,generation:1,baseGeneration:0,roomEpoch:7});}
function field(){const board=new Uint8Array(N);return {board,cells:new CellStore(board),boardRevision:0,generation:0,texture:{set(){},flush(){},reset(){}},minimapCache:{invalidate(){}}};}
test('compact bitmap retains bounded indexes and applies the same state without an expanded entry array',()=>{
  const data=packet(),compact=decodeBoardPacket(data,{compactBitmap:true}),expanded=decodeBoardPacket(data);
  assert.equal(compact.entries,undefined);assert.ok(compact.memoryBytes<100);assert.equal(compact.entryCount,4096);
  const a=field(),b=field();Battlefield.prototype.updatePacket.call(a,data,compact);Battlefield.prototype.updatePacket.call(b,data,expanded);
  assert.deepEqual(a.board,b.board);assert.equal(a.cells.size,b.cells.size);assert.deepEqual([...a.cells].sort((x,y)=>x[0]-y[0]),[...b.cells].sort((x,y)=>x[0]-y[0]));
  Battlefield.prototype.updatePacket.call(a,packet(0));assert.equal(a.cells.size,0);assert.equal(a.board.some(Boolean),false);
});
test('invalid bitmap tail cannot mutate board, cells, texture or generation',()=>{
  const data=packet(),bad=data.slice(0),v=new DataView(bad);v.setUint32(24,v.getUint32(24,true)+1,true);
  const a=field();let writes=0;a.texture.set=()=>writes++;a.board[999999]=4;a.cells.set(999999,4);
  assert.throws(()=>Battlefield.prototype.updatePacket.call(a,bad));assert.equal(a.generation,0);assert.equal(a.cells.size,1);assert.equal(writes,0);assert.equal(a.board[999999],4);
});
test('worker drains large historical packets without extra simulation ticks and stops when caught up or blocked',()=>{
  const frames=[],members=[{id:1,name:'A',session:1},{id:2,name:'B',bot:true}];
  const runtime=new RoomRuntime({members,epoch:7,bots:false,evolutionMode:'sparse',emit:data=>frames.push(data)});
  const peer=runtime.peers.get(1);peer.awaitingStart=false;peer.needsSnapshot=false;peer.sentGeneration=0;runtime.stateDue=false;
  runtime.game.generation=4;
  for(let g=1;g<=4;g++){const b=new ArrayBuffer(300000);new DataView(b).setUint32(4,g,true);runtime.history.add(g,new Map([[1,b]]));}
  runtime.flush();assert.equal(peer.sentGeneration,1);
  runtime.acknowledge([{id:1,session:1,bufferedAmount:300000}]);runtime.drain();assert.equal(frames.length,1);
  runtime.updateBuffers([{id:1,session:99,bufferedAmount:0}]);runtime.drain();assert.equal(frames.length,1);
  runtime.updateBuffers([{id:1,session:1,bufferedAmount:0}]);runtime.drain();assert.equal(peer.sentGeneration,2);
  runtime.updateBuffers([{id:1,session:1,bufferedAmount:0}]);runtime.drain();assert.equal(frames.length,2,'buffer notification cannot release output lock');
  for(let i=0;i<4;i++){runtime.acknowledge([{id:1,session:1,bufferedAmount:0}]);runtime.drain();}
  assert.equal(frames.length,4);assert.equal(peer.sentGeneration,4);assert.equal(runtime.game.generation,4);
  assert.deepEqual(frames.flatMap(f=>f.events.filter(e=>e.packet).map(e=>new DataView(e.packet).getUint32(4,true))),[1,2,3,4]);
  runtime.close();
});

test('client progress validates session, epoch, bounds, monotonicity and rate without changing authority',()=>{
  const ws={sentGeneration:20},game={generation:21},room={epoch:7,game};ws.member={ws};
  const good={roomEpoch:7,received:15,displayed:12,queueDepth:3,oldestMs:80,decodeMs:2,applyMs:5};
  for(const bad of [{roomEpoch:8},{received:21},{displayed:16},{queueDepth:33},{oldestMs:Infinity},{applyMs:-1},{decodeMs:'1'}])assert.equal(acceptClientProgress(ws,room,{...good,...bad},1000),null);
  assert.ok(acceptClientProgress(ws,room,good,1000));assert.equal(acceptClientProgress(ws,room,good,1100),null);
  assert.equal(acceptClientProgress(ws,room,{...good,displayed:11},1500),null);
  ws.member.ws={};assert.equal(acceptClientProgress(ws,room,good,2000),null);assert.deepEqual(game,{generation:21});
});

async function until(fn){const deadline=Date.now()+5000;while(!fn()){assert.ok(Date.now()<deadline,'condition timeout');await new Promise(r=>setTimeout(r,10));}}
for(const roomWorkers of [false,true])test(`real progress feedback roomWorkers=${roomWorkers} is session-bound and available over control connection`,async t=>{
  const app=createServer({port:0,host:'127.0.0.1',boardProtocol:2,roomWorkers}),{port}=await app.listen(),url=`ws://127.0.0.1:${port}/ws`;
  const ws=new WebSocket(url),messages=[];let generation=-1;
  ws.on('message',(d,binary)=>{if(binary)generation=d.readUInt32LE(12);else messages.push(JSON.parse(d));});
  t.after(async()=>{ws.terminate();await app.close();});
  await until(()=>ws.readyState===WebSocket.OPEN);ws.send(JSON.stringify({type:'protocol',version:2,bitmapTiles:true,paletteTiles:true}));
  ws.send(JSON.stringify({type:'create',name:'Feedback',practice:true}));await until(()=>generation>=0);
  assert.equal(messages.find(m=>m.type==='hello').clientProgress,true);assert.equal(messages.find(m=>m.type==='protocol').paletteTiles,true);assert.equal(messages.find(m=>m.type==='started').paletteTiles,true);
  const welcome=messages.find(m=>m.type==='welcome'),started=messages.find(m=>m.type==='started');
  const control=new WebSocket(url),controlMessages=[];control.on('message',d=>controlMessages.push(JSON.parse(d)));t.after(()=>control.terminate());
  await until(()=>control.readyState===WebSocket.OPEN);control.send(JSON.stringify({type:'bind_control',code:welcome.code,token:welcome.token}));await until(()=>controlMessages.some(m=>m.type==='control_ready'));
  const report={type:'client_progress',roomEpoch:started.roomEpoch,received:generation,displayed:generation,queueDepth:0,oldestMs:0,decodeMs:1,applyMs:2};
  control.send(JSON.stringify(report));await until(()=>controlMessages.some(m=>m.type==='network_status'));
  assert.equal(controlMessages.find(m=>m.type==='network_status').received,report.received);assert.ok(controlMessages.find(m=>m.type==='network_status').bufferedBytes>=0);
  assert.equal(app.rooms.get(welcome.code).members[0].ws.clientProgress.received,report.received);
});

test('inline server send-completion drains a large-packet backlog with no further ticks',async t=>{
  let tick;const app=createServer({port:0,host:'127.0.0.1',scheduler:fn=>{tick=fn;return {stop(){}};}}),{port}=await app.listen();
  const client=new WebSocket(`ws://127.0.0.1:${port}/ws`),received=[];
  client.on('message',(data,binary)=>{if(binary)received.push(data.readUInt32LE(4));});
  t.after(async()=>{client.terminate();await app.close();});await until(()=>client.readyState===WebSocket.OPEN);
  client.send(JSON.stringify({type:'create',name:'Catchup',practice:true}));await until(()=>received.length===1);
  const room=[...app.rooms.values()][0],peer=room.members[0].ws,send=peer.send.bind(peer),callbacks=[];
  let hold=true,blocked=false;Object.defineProperty(peer,'bufferedAmount',{get:()=>blocked?300000:0});
  peer.send=(data,...args)=>{
    const callback=args.at(-1);
    if(hold&&data instanceof ArrayBuffer&&typeof callback==='function')args[args.length-1]=error=>callbacks.push(()=>callback(error));
    return send(data,...args);
  };
  room.game.step=()=>{room.game.generation++;for(let key=0;key<80000;key++){const owner=1+room.game.generation%2;room.game.board[key]=owner;room.game.changes.set(key,owner);}};
  tick();blocked=true;tick();tick();tick();await until(()=>callbacks.length>0);
  assert.equal(peer.sentGeneration,1);blocked=false;hold=false;for(const callback of callbacks)callback();
  await until(()=>received.at(-1)===4);assert.deepEqual(received,[0,1,2,3,4]);assert.equal(room.game.generation,4);
});
