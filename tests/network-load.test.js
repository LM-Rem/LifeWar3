import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {WebSocket} from 'ws';
import {createServer} from '../src/server.js';
import {decodeBoardPacket,orderedBoardEntries} from '../public/board-protocol.js';

const ab=data=>data instanceof ArrayBuffer?data:data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength);
function consumer(){const board=new Uint8Array(1000000),cells=new Map();return buffer=>{
  const p=decodeBoardPacket(ab(buffer)),entries=orderedBoardEntries(p,board);if(p.snapshot){board.fill(0);cells.clear();}
  for(const v of entries){const key=v%1000000,owner=Math.floor(v/1000000);board[key]=owner;if(owner)cells.set(key,owner);else cells.delete(key);}
  const words=new Uint32Array(cells.size);let i=0;for(const [k,o] of cells)words[i++]=k+o*1000000;
  return {...p,entries:undefined,insertions:undefined,insertionFlags:undefined,hash:createHash('sha256').update(board).update(new Uint8Array(words.buffer)).digest('hex')};
};}
async function until(predicate){const end=Date.now()+6000;while(!predicate()){assert.ok(Date.now()<end,'network condition timed out');await new Promise(r=>setTimeout(r,10));}}
async function client(url,version){const ws=new WebSocket(url),messages=[],records=[],errors=[],apply=consumer();
  ws.on('message',(data,binary)=>{try{if(binary)records.push(apply(data));else messages.push(JSON.parse(data));}catch(e){errors.push(e);}});
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  const send=msg=>ws.send(JSON.stringify(msg));if(version===2){send({type:'protocol',version:2});await until(()=>messages.some(m=>m.type==='protocol'));}
  return {ws,messages,records,errors,send,version};
}

test('four mixed v1/v2 clients preserve per-connection v1 order through dense updates and slow recovery',async t=>{
  const app=createServer({port:0,host:'127.0.0.1',boardProtocol:2}),addr=await app.listen(),url=`ws://127.0.0.1:${addr.port}/ws`,clients=[];
  t.after(async()=>{for(const c of clients)c.ws.terminate();await app.close();});
  for(const version of [1,2,1,2])clients.push(await client(url,version));
  const [a,b,c,d]=clients;a.send({type:'create',name:'A'});await until(()=>a.messages.some(m=>m.type==='welcome'));
  const code=a.messages.find(m=>m.type==='welcome').code;
  for(const peer of [b,c,d]){peer.send({type:'join',code,name:'Peer'});await until(()=>peer.messages.some(m=>m.type==='welcome'));peer.send({type:'ready'});}
  await until(()=>a.messages.some(m=>m.type==='room'&&m.players.length===4&&m.players.every(p=>p.ready)));
  const room=app.rooms.get(code),expected=clients.map(()=>[]),traffic=clients.map(()=>({binaryBytes:0,v1EquivalentBytes:0,jsonBytes:0,messages:0}));
  const framed=n=>n+(n<126?2:n<65536?4:10);
  for(let i=0;i<4;i++){
    const ws=room.members[i].ws,send=ws.send.bind(ws),apply=consumer();
    ws.send=(data,...args)=>{if(data instanceof ArrayBuffer){const meta=decodeBoardPacket(data),v1=room.game.packet(meta.snapshot);expected[i].push(apply(v1));traffic[i].binaryBytes+=framed(data.byteLength);traffic[i].v1EquivalentBytes+=framed(v1.byteLength);traffic[i].messages++;}else if(typeof data==='string')traffic[i].jsonBytes+=framed(Buffer.byteLength(data));return send(data,...args);};
  }
  a.send({type:'start'});await until(()=>clients.every(p=>p.records.length));
  const game=room.game;
  // Deterministic dense network workload, independent of evolutionary cost.
  game.step=()=>{
    game.generation++;game.alive.length=0;
    for(let i=0;i<16384;i++){const j=i*7919%16384,key=Math.floor(j/128)*1000+j%128,owner=(i+game.generation)%7===0?0:(i+game.generation)%4+1;
      game.board[key]=owner;game.changes.set(key,owner);if(owner)game.alive.push(key);
    }
  };
  await until(()=>clients.every(p=>p.records.filter(r=>r.encoding===1||r.version===1).length>=5));
  const slow=room.members[3].ws;Object.defineProperty(slow,'bufferedAmount',{configurable:true,get:()=>300000});
  const before=d.records.length,gen=game.generation;
  await until(()=>game.generation>=gen+4);assert.equal(d.records.length,before);assert.ok(slow.needsSnapshot);
  delete slow.bufferedAmount;
  await until(()=>d.records.slice(before).some(r=>r.snapshot)&&d.records.length>=before+3);
  const resumed=d.records.slice(before);assert.equal(resumed[0].snapshot,true);assert.equal(resumed[1].encoding,0,'first delta after snapshot is ordered');assert.equal(resumed[2].encoding,1);
  // Snapshot taken after an unbroadcast deletion; next delta may resurrect it.
  const key=game.alive.keys[0];game.board[key]=0;game.changes.set(key,0);game.alive.compact(game.board);
  const resyncAt=b.records.length;b.send({type:'resync'});await until(()=>b.records.slice(resyncAt).some(r=>r.snapshot)&&b.records.length>=resyncAt+3);
  b.send({type:'protocol',version:1});await until(()=>b.messages.some(m=>m.type==='error'&&/协商/.test(m.message)));
  for(let i=0;i<clients.length;i++){
    const peer=clients[i];assert.deepEqual(peer.errors,[]);assert.ok(peer.records.length>8);
    assert.deepEqual(peer.records.map(p=>[p.generation,p.snapshot,p.hash]),expected[i].slice(0,peer.records.length).map(p=>[p.generation,p.snapshot,p.hash]));
    assert.ok(peer.records.every(r=>r.version===peer.version));
    if(peer.version===2){assert.ok(peer.records.every(r=>r.roomEpoch===room.epoch));for(let j=1;j<peer.records.length;j++)if(!peer.records[j].snapshot)assert.equal(peer.records[j].baseGeneration,peer.records[j-1].generation);}
  }
  mkdirSync('artifacts/performance/t13',{recursive:true});writeFileSync('artifacts/performance/t13/network.json',JSON.stringify({status:'PASS',scope:'real four-client loopback sends, includes WebSocket frame headers and JSON; synthetic 16,384-change workload, deterministic server bufferedAmount injection for recovery, not a network throughput capacity certification',clients:clients.map((p,i)=>({version:p.version,verifiedMessages:p.records.length,...traffic[i],totalBytes:traffic[i].binaryBytes+traffic[i].jsonBytes,v1EquivalentTotalBytes:traffic[i].v1EquivalentBytes+traffic[i].jsonBytes}))},null,2));
});

test('v1-only rollout rejects v2 negotiation and avoids per-room broadcast baseline storage',async t=>{
  const app=createServer({port:0,host:'127.0.0.1',boardProtocol:1}),addr=await app.listen(),peer=await client(`ws://127.0.0.1:${addr.port}/ws`,1);
  t.after(async()=>{peer.ws.terminate();await app.close();});
  await until(()=>peer.messages.some(m=>m.type==='hello'));assert.deepEqual(peer.messages.find(m=>m.type==='hello').boardProtocols,[1]);
  peer.send({type:'protocol',version:2});await until(()=>peer.messages.some(m=>m.type==='error'));
  peer.send({type:'create',name:'V1',practice:true});await until(()=>peer.records.length);assert.equal(peer.records[0].version,1);
  assert.equal([...app.rooms.values()][0].broadcastBoard,null);
});
