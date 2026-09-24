import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createServer } from '../src/server.js';

async function client(url){
  const ws=new WebSocket(url),messages=[],listeners=[];
  ws.on('message',(data,binary)=>{const msg=binary?{type:'binary',data}:JSON.parse(data);messages.push(msg);for(const fn of [...listeners])fn(msg);});
  await new Promise((resolve,reject)=>{ws.on('open',resolve);ws.on('error',reject);});
  return {ws,send:msg=>ws.send(JSON.stringify(msg)),wait:(type,predicate=()=>true)=>new Promise((resolve,reject)=>{
    const index=messages.findIndex(m=>m.type===type&&predicate(m));if(index>=0)return resolve(messages.splice(index,1)[0]);
    const timer=setTimeout(()=>{const i=listeners.indexOf(listener);if(i>=0)listeners.splice(i,1);reject(new Error('Timed out waiting for '+type));},4000);
    const listener=msg=>{if(msg.type===type&&predicate(msg)){clearTimeout(timer);listeners.splice(listeners.indexOf(listener),1);messages.splice(messages.indexOf(msg),1);resolve(msg);}};listeners.push(listener);
  })};
}
test('real 4-client lobby, authority, synchronization, resume and host migration',async t=>{
  const app=createServer({port:0,host:'127.0.0.1'}),addr=await app.listen(),url=`ws://127.0.0.1:${addr.port}/ws`,clients=[];
  t.after(async()=>{for(const c of clients)c.ws.terminate();await app.close();});
  const connect=async()=>{const c=await client(url);clients.push(c);return c;};
  const a=await connect(),b=await connect(),c=await connect(),d=await connect();
  a.send({type:'create',name:'Alpha'});const welcome=await a.wait('welcome');const code=welcome.code;
  for(const [peer,name]of [[b,'Beta'],[c,'Gamma'],[d,'Delta']]){peer.send({type:'join',code,name});await peer.wait('welcome');}
  const lobby=await a.wait('room',r=>r.players.length===4);assert.equal(lobby.players.length,4);
  b.send({type:'start'});assert.match((await b.wait('error')).message,/房主/);
  a.send({type:'start'});assert.match((await a.wait('error')).message,/准备/);
  for(const peer of [b,c,d])peer.send({type:'ready'});
  await a.wait('room',r=>r.players.every(p=>p.ready));a.send({type:'start'});
  for(const peer of [a,b,c,d])await peer.wait('started');
  const initial=await a.wait('state');
  const layout=initial.nodes.map(({id,x,y})=>({id,x,y}));
  assert.ok(layout.length>=12&&layout.length<=16);
  a.send({type:'deploy',x:200,y:200,cells:[[0,0],[1,0],[0,1],[1,1]]});await a.wait('deployed');
  for(const peer of [b,c,d]){const state=await peer.wait('state',s=>s.players[0].cells===4);assert.equal(state.players[0].cells,4);assert.deepEqual(state.nodes.map(({id,x,y})=>({id,x,y})),layout);}
  a.send({type:'deploy',x:820,y:820,cells:[[0,0]]});await a.wait('error');
  a.ws.terminate();await new Promise(r=>setTimeout(r,80));const a2=await connect();a2.send({type:'resume',code,token:welcome.token});await a2.wait('welcome');await a2.wait('started');
  const packet=await a2.wait('binary');assert.equal(packet.data.readUInt32LE(0),1);assert.ok(packet.data.byteLength>8);
  assert.deepEqual((await a2.wait('state')).nodes.map(({id,x,y})=>({id,x,y})),layout);
  a2.send({type:'leave'});await a2.wait('left');const updated=await b.wait('room',r=>r.host===2);assert.equal(updated.host,2);
  const response=await fetch(`http://127.0.0.1:${addr.port}/`);assert.equal(response.status,200);assert.match(await response.text(),/LIFEWAR/);
});
test('join capacity, bot removal, malformed messages, and practice match',async t=>{
  const app=createServer({port:0,host:'127.0.0.1'}),addr=await app.listen(),url=`ws://127.0.0.1:${addr.port}/ws`;
  const a=await client(url),b=await client(url);t.after(async()=>{a.ws.terminate();b.ws.terminate();await app.close();});
  a.ws.send('not json');a.ws.send('null');a.send({type:'create',name:'Solo',practice:true});await a.wait('welcome');await a.wait('started');const s=await a.wait('state');assert.equal(s.players.length,2);assert.equal(s.players[1].bot,true);
  b.send({type:'join',code:'FFFFFF'});await b.wait('error');a.send({type:'leave'});await a.wait('left');a.send({type:'create',name:'New'});const w=await a.wait('welcome');
  for(let i=0;i<3;i++)a.send({type:'bot'});await a.wait('room',r=>r.players.length===4);b.send({type:'join',code:w.code});assert.match((await b.wait('error')).message,/满/);
  a.send({type:'remove_bot',id:2});await a.wait('room',r=>r.players.length===3);b.send({type:'join',code:w.code});const wb=await b.wait('welcome');assert.equal(wb.id,2);
});

test('resync responds with an authoritative snapshot and private state without restarting the match',async t=>{
  const app=createServer({port:0,host:'127.0.0.1'}),addr=await app.listen(),a=await client(`ws://127.0.0.1:${addr.port}/ws`);
  t.after(async()=>{a.ws.terminate();await app.close();});
  a.send({type:'create',name:'Recovery',practice:true});await a.wait('started');const initial=await a.wait('binary');await a.wait('state');
  a.send({type:'deploy',x:200,y:200,cells:[[0,0],[1,0],[0,1],[1,1]]});await a.wait('deployed');
  await a.wait('binary',m=>m.data.readUInt32LE(4)>initial.data.readUInt32LE(4));
  a.send({type:'resync'});const snapshot=await a.wait('binary',m=>m.data.readUInt32LE(0)===1);
  const generation=snapshot.data.readUInt32LE(4),state=await a.wait('state',s=>s.generation===generation);
  assert.ok(generation>0);assert.equal(state.players[0].cells,4);assert.equal(state.cards.hand.length,2);
  const cells=new Map();for(let i=8;i<snapshot.data.length;i+=4){const v=snapshot.data.readUInt32LE(i);cells.set(v%1000000,Math.floor(v/1000000));}
  assert.equal(cells.get(200200),1);assert.equal(cells.get(201201),1);
});
