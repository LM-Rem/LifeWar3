import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {createServer} from '../src/server.js';
import {RoomWorkerClient} from '../src/room-worker-client.js';
import {decodeBoardPacket,orderedBoardEntries} from '../public/board-protocol.js';

async function client(url){
  const ws=new WebSocket(url),messages=[];let changed;
  ws.on('message',(data,binary)=>{messages.push(binary?{type:'binary',data}:JSON.parse(data));changed?.();});
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  return {ws,send:msg=>ws.send(JSON.stringify(msg)),async wait(type,predicate=()=>true){
    const deadline=Date.now()+6000;
    while(Date.now()<deadline){const i=messages.findIndex(m=>m.type===type&&predicate(m));if(i>=0)return messages.splice(i,1)[0];
      await new Promise(resolve=>{const timer=setTimeout(resolve,25);changed=()=>{clearTimeout(timer);resolve();};});}
    throw new Error(`Timed out: ${type}`);
  }};
}
const factory=(options,callbacks)=>new RoomWorkerClient({...options,gameOptions:{cardDrawTimes:[0]},bots:false},{...callbacks,workerURL:new URL('./fixtures/room-worker-instrumented.mjs',import.meta.url)});

test('real room worker enforces ten-second card cooldown and restores it on resume',async t=>{
  const app=createServer({port:0,host:'127.0.0.1',roomWorkers:true,evolutionMode:'sparse',
    roomWorkerFactory:(options,callbacks)=>new RoomWorkerClient({...options,gameOptions:{cardDrawTimes:[0,1000]},bots:false},
      {...callbacks,workerURL:new URL('./fixtures/room-worker-instrumented.mjs',import.meta.url)})});
  const {port}=await app.listen(),url=`ws://127.0.0.1:${port}/ws`,peers=[];
  t.after(async()=>{for(const p of peers)p.ws.terminate();await app.close();});
  const a=await client(url);peers.push(a);
  a.send({type:'create',name:'Cooldown',practice:true});const session=await a.wait('welcome');await a.wait('started');
  const room=app.rooms.get(session.code);
  for(const round of [1,2]){
    const draft=await a.wait('card_state',s=>s.cardDraft?.round===round);
    const choice=draft.cardDraft.players.find(p=>p.playerId===1).options.find(c=>c.type==='buff');
    a.send({type:'pick_card',cardId:choice.id});await a.wait('card_picked');
    await a.wait('card_state',s=>s.cards.hand[0].length===round);
    if(round===1)room.worker.post({type:'test_advance_clock',ms:1000});
  }
  const hand=(await a.wait('card_state',s=>s.cards.hand[0].length===2)).cards.hand[0];
  a.send({type:'play_card',cardId:hand[0].id,instanceId:hand[0].instanceId});
  const played=await a.wait('card_played');assert.equal(played.cooldownEndsAt-played.serverTime,10000);
  const cooling=await a.wait('card_state',s=>s.cards.hand[0].length===1);
  assert.equal(cooling.cards.cooldownEndsAt,played.cooldownEndsAt);
  a.send({type:'play_card',cardId:hand[1].id,instanceId:hand[1].instanceId});
  assert.match((await a.wait('error')).message,/冷却/);
  a.ws.terminate();const resumed=await client(url);peers.push(resumed);
  resumed.send({type:'resume',code:session.code,token:session.token});await resumed.wait('started');
  const restored=await resumed.wait('card_state',s=>s.cards.hand[0].length===1);
  assert.equal(restored.cards.cooldownEndsAt,played.cooldownEndsAt);
  assert.ok(restored.cards.cooldownEndsAt>restored.serverTime);
  room.worker.post({type:'test_advance_clock',ms:10000});
  await resumed.wait('card_state',s=>s.serverTime>=played.cooldownEndsAt);
  resumed.send({type:'play_card',cardId:hand[1].id,instanceId:hand[1].instanceId});
  await resumed.wait('card_played');await resumed.wait('card_state',s=>s.cards.hand[0].length===0);
});

for(const [paletteTiles,tileModes] of [[false,false],[true,false],[true,true]])test(`real dense worker negotiates bitmap/palette=${paletteTiles}/modes=${tileModes} and legacy peers independently and resumes sessions`,async t=>{
  const app=createServer({port:0,host:'127.0.0.1',roomWorkers:true,boardProtocol:2,evolutionMode:'sparse',
    roomWorkerFactory:(options,callbacks)=>new RoomWorkerClient({...options,testLoad:true,testPalette:paletteTiles,testTileModes:tileModes,bots:false,gameOptions:{cardDrawTimes:[]}},{...callbacks,workerURL:new URL('./fixtures/room-worker-instrumented.mjs',import.meta.url)})});
  const {port}=await app.listen(),url=`ws://127.0.0.1:${port}/ws`,peers=[];
  t.after(async()=>{for(const p of peers)p.ws.terminate();await app.close();});
  const a=await client(url),b=await client(url);peers.push(a,b);
  for(const [peer,bitmapTiles] of [[a,true],[b,false]]){
    assert.ok((await peer.wait('hello')).boardEncodings.includes(3));
    peer.send({type:'protocol',version:2,deltaVarint:true,bitmapTiles,paletteTiles,tileModes});const ack=await peer.wait('protocol');assert.equal(ack.bitmapTiles,bitmapTiles);assert.equal(ack.paletteTiles,bitmapTiles&&paletteTiles);assert.equal(ack.tileModes,bitmapTiles&&paletteTiles&&tileModes);
  }
  a.send({type:'create',name:'Bitmap'});const welcome=await a.wait('welcome');
  b.send({type:'join',code:welcome.code,name:'Legacy'});await b.wait('welcome');b.send({type:'ready'});
  await a.wait('room',m=>m.players.length===2&&m.players.every(p=>p.ready));a.send({type:'start'});
  assert.equal((await a.wait('started')).bitmapTiles,true);assert.equal((await b.wait('started')).bitmapTiles,false);
  const boards=[new Uint8Array(1000000),new Uint8Array(1000000)];
  for(let generation=0;generation<5;generation++){
    for(let i=0;i<2;i++){
      const {data}=await peers[i].wait('binary'),p=decodeBoardPacket(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength));
      assert.equal(p.generation,generation);if(generation>0)assert.equal(p.encoding===(tileModes?5:paletteTiles?4:3),i===0);
      if(p.snapshot)boards[i].fill(0);
      for(const value of orderedBoardEntries(p,boards[i]))boards[i][value%1000000]=Math.floor(value/1000000);
    }
    const mismatch=boards[0].findIndex((owner,key)=>owner!==boards[1][key]);assert.equal(mismatch,-1,`first board mismatch at ${mismatch}`);
  }
  a.ws.terminate();const resumed=await client(url);peers.push(resumed);
  // Bitmap without varint is a distinct, supported capability combination.
  resumed.send({type:'protocol',version:2,bitmapTiles:true,paletteTiles,tileModes});assert.equal((await resumed.wait('protocol')).deltaVarint,false);
  resumed.send({type:'resume',code:welcome.code,token:welcome.token});assert.equal((await resumed.wait('started')).bitmapTiles,true);
  const snapshot=(await resumed.wait('binary')).data;assert.equal(snapshot.readUInt16LE(6),1);assert.equal(snapshot[5],tileModes?5:paletteTiles?4:3);
  const next=(await resumed.wait('binary')).data;assert.equal(next.readUInt32LE(12),snapshot.readUInt32LE(12)+1);assert.equal(next.readUInt16LE(6),0);assert.equal(next[5],tileModes?5:paletteTiles?4:3);
});

test('worker disconnect expiry migrates host before a three-player match finishes',async t=>{
  const app=createServer({port:0,host:'127.0.0.1',roomWorkers:true,roomWorkerFactory:factory});
  const {port}=await app.listen(),url=`ws://127.0.0.1:${port}/ws`,peers=[];
  t.after(async()=>{for(const p of peers)p.ws.terminate();await app.close();});
  for(let i=0;i<3;i++)peers.push(await client(url));
  const [a,b,c]=peers;a.send({type:'create',name:'A'});const session=await a.wait('welcome');
  for(const p of [b,c]){p.send({type:'join',code:session.code,name:'Guest'});await p.wait('welcome');p.send({type:'ready'});}
  await a.wait('room',m=>m.players.length===3&&m.players.every(p=>p.ready));a.send({type:'start'});await a.wait('state',m=>m.generation>=1);
  const room=app.rooms.get(session.code);a.ws.terminate();await b.wait('room',m=>m.players[0].connected===false);
  room.worker.post({type:'test_advance_clock',ms:90001});
  const update=await b.wait('room',m=>m.host===2);assert.equal(update.status,'playing');
});

for(const version of [1,2])test(`real room worker v${version}: socket backpressure replays independent generations`,async t=>{
  const app=createServer({port:0,host:'127.0.0.1',roomWorkers:true,boardProtocol:version});
  const {port}=await app.listen(),c=await client(`ws://127.0.0.1:${port}/ws`);
  t.after(async()=>{c.ws.terminate();await app.close();});
  if(version===2){c.send({type:'protocol',version:2,deltaVarint:true});await c.wait('protocol');}
  c.send({type:'create',name:'Slow',practice:true});await c.wait('started');await c.wait('binary');
  const room=[...app.rooms.values()][0],peer=room.members[0].ws;let blocked=true;
  Object.defineProperty(peer,'bufferedAmount',{get:()=>blocked?300000:0});
  const waitGeneration=async generation=>{
    const deadline=Date.now()+4000;while(room.game.generation<generation&&Date.now()<deadline)await new Promise(r=>setTimeout(r,15));
    assert.ok(room.game.generation>=generation);
  };
  await waitGeneration(3);const before=peer.sentGeneration;await waitGeneration(6);
  assert.equal(peer.sentGeneration,before,'backpressure reaches the room thread');
  blocked=false;const offset=version===2?12:4;
  for(let generation=before+1;generation<=6;generation++){
    const msg=await c.wait('binary',m=>m.data.readUInt32LE(offset)>before);
    assert.equal(msg.data.readUInt32LE(offset),generation);
    assert.equal(version===2?msg.data.readUInt16LE(6):msg.data.readUInt32LE(0),0,'short backlog must not use snapshots');
  }
});

test('hardware GPU in a real room worker: startup, command, successive v2 generations and shutdown', {skip:process.env.LIFEWAR_TEST_GPU!=='1'},async t=>{
  const app=createServer({port:0,host:'127.0.0.1',roomWorkers:true,evolutionMode:'gpu',boardProtocol:2});
  const {port}=await app.listen(),c=await client(`ws://127.0.0.1:${port}/ws`);
  t.after(async()=>{c.ws.terminate();await app.close();});
  c.send({type:'protocol',version:2,deltaVarint:true});await c.wait('protocol');c.send({type:'create',name:'GPU',practice:true});await c.wait('started');
  const first=await c.wait('binary');let gen=first.data.readUInt32LE(12);
  c.send({type:'deploy',x:180,y:180,cells:[[0,0],[1,0],[2,0]]});await c.wait('deployed');
  for(let i=0;i<15;i++){const packet=await c.wait('binary');assert.equal(packet.data.readUInt32LE(12),++gen);}
  const room=[...app.rooms.values()][0];assert.equal(room.game.lastBackend,'gpu');const bridge=room.worker;
  await app.close();assert.equal(bridge.exited,true);assert.equal(bridge.pending.size,0);
});

test('real room workers: selection/play, privacy, blocked-room isolation, resume, surrender, rematch and cleanup',async t=>{
  const faults=[],app=createServer({port:0,host:'127.0.0.1',roomWorkers:true,roomWorkerFactory:factory,onRoomError:e=>faults.push(e.message),trace:true,boardProtocol:2});
  const {port}=await app.listen(),url=`ws://127.0.0.1:${port}/ws`,clients=[];
  t.after(async()=>{for(const c of clients)c.ws.terminate();await app.close();});
  const connect=async()=>{const c=await client(url);clients.push(c);return c;};
  const a=await connect(),b=await connect();
  a.send({type:'protocol',version:2,deltaVarint:true});await a.wait('protocol');
  a.send({type:'create',name:'Busy',practice:true});const welcome=await a.wait('welcome');await a.wait('started');await a.wait('binary');
  b.send({type:'create',name:'Other',practice:true});await b.wait('started');
  const roomA=app.rooms.get(welcome.code),roomB=[...app.rooms.values()].find(r=>r!==roomA);
  assert.equal(roomA.game.board,undefined,'main thread has no authoritative board');
  a.send({type:'deploy',x:180,y:180,cells:[[0,0],[1,0],[2,0]]});await a.wait('deployed');
  const draft=await b.wait('card_state',s=>s.cardDraft);assert.equal(draft.cards.hand[1],null);
  const blocked=new Promise(resolve=>roomA.worker.worker.once('message',function listener(msg){
    if(msg.type==='test_blocking')resolve();else roomA.worker.worker.once('message',listener);
  }));
  roomA.worker.post({type:'test_block',ms:700});await blocked;
  const start=performance.now();b.send({type:'ping',time:81});await b.wait('pong',s=>s.time===81);
  const card=draft.cardDraft.players[0].options.find(c=>c.type==='buff');
  b.send({type:'pick_card',cardId:card.id});await b.wait('card_picked');
  assert.ok(performance.now()-start<500,'other room and primary ping remain responsive during a 700ms worker wait');
  const hand=await b.wait('card_state',s=>s.cards.hand[0].length===1);
  b.send({type:'play_card',cardId:card.id,instanceId:hand.cards.hand[0][0].instanceId});await b.wait('card_played');
  await b.wait('card_state',s=>s.cards.hand[0].length===0&&s.sequence>hand.sequence);
  const previousSession=roomA.members[0].ws.roomSession;
  a.ws.terminate();const resumed=await connect();resumed.send({type:'protocol',version:2});await resumed.wait('protocol');
  resumed.send({type:'resume',code:welcome.code,token:welcome.token});await resumed.wait('started');const snapshot=await resumed.wait('binary');assert.equal(snapshot.data.readUInt16LE(6),1);
  assert.notEqual(roomA.members[0].ws.roomSession,previousSession);
  // Actual worker exception stops only its room.
  roomA.worker.post({type:'test_fault'});await resumed.wait('error',s=>s.message.includes('演化异常'));assert.equal(faults.length,1);
  const gen=roomB.game.generation;await b.wait('state',s=>s.generation>gen);
  b.send({type:'leave'});await b.wait('left');
  // Use a two-human match to retain a host after surrender and exercise rematch.
  const c=await connect(),d=await connect();c.send({type:'create',name:'Host'});const wc=await c.wait('welcome');
  d.send({type:'join',code:wc.code,name:'Guest'});await d.wait('welcome');d.send({type:'ready'});await c.wait('room',s=>s.players.length===2&&s.players.every(p=>p.ready));c.send({type:'start'});await c.wait('started');await d.wait('started');
  const match=app.rooms.get(wc.code),oldWorker=match.worker;
  d.send({type:'leave'});await d.wait('left');await c.wait('room',s=>s.status==='finished');c.send({type:'rematch'});await c.wait('lobby');
  assert.equal(match.worker,null);await oldWorker.close();assert.equal(oldWorker.exited,true);
  c.send({type:'bot'});await c.wait('room',s=>s.status==='lobby'&&s.players.some(p=>p.bot));c.send({type:'start'});await c.wait('started');assert.notEqual(match.worker,oldWorker);
});
