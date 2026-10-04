import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {RoomConversation} from '../src/conversation.js';
import {validateChatText,mergeConversation,CONVERSATION_LIMIT} from '../public/conversation-model.js';
import {createServer} from '../src/server.js';
import {RoomWorkerClient} from '../src/room-worker-client.js';
import {RoomRuntime} from '../src/room-runtime.js';

test('chat validation rejects empty, non-text and excessive content while preserving plain text and newlines',()=>{
  for(const text of ['', '  \n ',null,123,{},'x'.repeat(501)])assert.throws(()=>validateChatText(text));
  assert.equal(validateChatText(' a\r\nb\u0000 '),'a\nb');
  assert.equal(validateChatText('<img src=x onerror=alert(1)>'),'<img src=x onerror=alert(1)>');
});
test('room conversation orders chat messages, limits history, restores gaps and deduplicates retry requests',()=>{
  let now=1000;const log=new RoomConversation(5,0,()=>now),member={id:1,name:'A',token:'token'};
  const first=log.chat(member,'r1','hello').entry;
  assert.equal(first.sequence,1);assert.equal(log.chat(member,'r1','hello').duplicate,true);
  assert.throws(()=>log.chat(member,'r1','different'));
  log.chat({id:2,name:'B',token:'other'},'r1','hello too');
  assert.deepEqual(log.packet(1).entries.map(e=>e.kind),['chat']);
  for(let i=0;i<205;i++)log.chat({id:2,name:'B',token:`history${i}`},'r1',String(i));
  assert.equal(log.entries.length,CONVERSATION_LIMIT);assert.equal(log.packet(1).reset,true);
  assert.equal(log.packet(log.sequence).entries.length,0);
  assert.equal(mergeConversation([first],log.entries).length,CONVERSATION_LIMIT);
  assert.deepEqual(mergeConversation([first],[first]),[first]);
  assert.deepEqual(mergeConversation([first],[],true),[]);
  const event={sequence:500,kind:'event',text:'旧版战场事件'};
  assert.deepEqual(mergeConversation([event,first],[event]),[first],'legacy events never enter chat history');
  for(let i=2;i<=5;i++)log.chat(member,`r${i}`,'hi');
  assert.throws(()=>log.chat(member,'r6','hi'),/过快/);
  now=11000;assert.equal(log.chat(member,'r6','hi').duplicate,false);
});
test('worker keeps battle events in game state without forwarding them to chat',()=>{
  const messages=[],runtime=new RoomRuntime({members:[{id:1,name:'A',session:1},{id:2,name:'B',session:2}],
    epoch:9,evolutionMode:'sparse',bots:false,gameOptions:{cardDrawTimes:[0]},emit:message=>messages.push(message)});
  runtime.flush();assert.equal(runtime.frameBusy,true);
  runtime.tick();
  assert.equal(messages.filter(m=>m.type==='frame').length,1);
  assert.ok(runtime.game.events.some(event=>event.text.includes('征召')));
  assert.ok(!messages.some(m=>m.type==='battle_event'));
});

async function client(url){
  const ws=new WebSocket(url),messages=[],listeners=[];
  ws.on('message',(raw,binary)=>{const msg=binary?{type:'binary'}:JSON.parse(raw);messages.push(msg);for(const listener of [...listeners])listener(msg);});
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  return {ws,messages,send:message=>ws.send(JSON.stringify(message)),wait:(type,predicate=()=>true)=>new Promise((resolve,reject)=>{
    const index=messages.findIndex(m=>m.type===type&&predicate(m));if(index>=0)return resolve(messages.splice(index,1)[0]);
    const timer=setTimeout(()=>{listeners.splice(listeners.indexOf(listener),1);reject(new Error(`Timed out: ${type}`));},5000);
    const listener=msg=>{if(msg.type===type&&predicate(msg)){clearTimeout(timer);listeners.splice(listeners.indexOf(listener),1);messages.splice(messages.indexOf(msg),1);resolve(msg);}};listeners.push(listener);
  })};
}

for(const worker of [false,true])test(`dedicated chat worker=${worker}: isolation, backpressure, chat-only history, retries, privileges and resume`,async t=>{
  const app=createServer({port:0,host:'127.0.0.1',roomWorkers:worker,evolutionMode:'sparse',
    roomWorkerFactory:(options,callbacks)=>new RoomWorkerClient({...options,bots:false,gameOptions:{cardDrawTimes:[0]}},
      {...callbacks,workerURL:new URL('./fixtures/room-worker-instrumented.mjs',import.meta.url)})});
  const {port}=await app.listen(),base=`ws://127.0.0.1:${port}`,peers=[];
  const connect=async path=>{const c=await client(`${base}${path}`);peers.push(c);return c;};
  t.after(async()=>{for(const c of peers)c.ws.terminate();await app.close();});
  const a=await connect('/ws'),b=await connect('/ws'),other=await connect('/ws');
  a.send({type:'create',name:'Alpha'});const sa=await a.wait('welcome');
  b.send({type:'join',code:sa.code,name:'Beta'});const sb=await b.wait('welcome');b.send({type:'ready'});
  await a.wait('room',r=>r.players.length===2&&r.players.every(p=>p.ready));a.send({type:'start'});
  await a.wait('started');await b.wait('started');
  other.send({type:'create',name:'Other',practice:true});const so=await other.wait('welcome');await other.wait('started');
  const bind=async session=>{const c=await connect('/ws/chat');c.send({type:'bind_chat',code:session.code,token:session.token});await c.wait('chat_ready');await c.wait('conversation');return c;};
  const ca=await bind(sa),cb=await bind(sb),co=await bind(so),bad=await connect('/ws/chat');
  bad.send({type:'bind_chat',code:sa.code,token:'incorrect'});await bad.wait('chat_rejected');
  const control=await connect('/ws');control.send({type:'bind_control',code:sa.code,token:sa.token});await control.wait('control_ready');
  const initialDraft=worker?await control.wait('card_state',s=>s.cardDraft):null;
  const room=app.rooms.get(sa.code),member=room.members[0],peer=member.ws;
  Object.defineProperty(peer,'bufferedAmount',{get:()=>300000});
  Object.defineProperty(member.control,'bufferedAmount',{get:()=>300000});
  if(worker){
    const started=new Promise(resolve=>{const listener=m=>{if(m.type==='test_blocking'){room.worker.worker.off('message',listener);resolve();}};room.worker.worker.on('message',listener);});
    room.worker.post({type:'test_block',ms:1200});await started;
  }
  const start=performance.now(),text='<img src=x onerror=alert(1)> hello';
  ca.send({type:'chat_send',requestId:'message1',text,name:'forged',playerId:2});
  const entry=(await cb.wait('conversation',m=>m.entries.some(e=>e.text===text))).entries.find(e=>e.text===text);
  assert.ok(performance.now()-start<900,'chat bypasses map/card buffers and blocked worker');
  assert.equal(entry.name,'Alpha');assert.equal(entry.playerId,1);await ca.wait('chat_sent');
  ca.send({type:'chat_send',requestId:'message1',text});await ca.wait('chat_sent');
  assert.equal(room.conversation.entries.filter(e=>e.kind==='chat').length,1);
  assert.ok(!co.messages.some(m=>m.entries?.some(e=>e.text===text)));
  assert.ok(!ca.messages.some(m=>['binary','state','card_state','rooms','room'].includes(m.type)));
  ca.send({type:'deploy',x:180,y:180,cells:[[0,0]]});await ca.wait('chat_error');
  ca.send({type:'leave'});await ca.wait('chat_error');assert.equal(member.ws,peer);
  if(worker){
    const choice=initialDraft.cardDraft.players[0].options.find(c=>c.type==='law');
    control.send({type:'pick_card',cardId:choice.id});await control.wait('card_picked');
    control.send({type:'play_card',cardId:choice.id});
  } else {
    room.game.event('capture',1,'独立事件');
  }
  let blocked=true;Object.defineProperty(room.members[1].chat,'bufferedAmount',{get:()=>blocked?100000:0});
  ca.send({type:'chat_send',requestId:'message2',text:'backpressure recovery'});await ca.wait('chat_sent');
  assert.ok(!cb.messages.some(m=>m.entries?.some(e=>e.text==='backpressure recovery')));
  blocked=false;await cb.wait('conversation',m=>m.entries.some(e=>e.text==='backpressure recovery'));
  const closed=new Promise(resolve=>ca.ws.once('close',resolve));a.ws.terminate();await closed;
  const resumed=await connect('/ws');resumed.send({type:'resume',code:sa.code,token:sa.token});await resumed.wait('started');
  const recovered=await connect('/ws/chat');recovered.send({type:'bind_chat',code:sa.code,token:sa.token});await recovered.wait('chat_ready');
  const history=await recovered.wait('conversation');assert.equal(history.reset,true);
  assert.ok(history.entries.every(e=>e.kind==='chat'),'battle events are absent from the dedicated channel and restored history');
  assert.equal(history.entries.filter(e=>e.kind==='chat').length,2);
  b.send({type:'leave'});await b.wait('left');await resumed.wait('room',m=>m.status==='finished');
  recovered.send({type:'chat_send',requestId:'after_finish',text:'赛后交流'});await recovered.wait('chat_sent');
  const closing=new Promise(resolve=>recovered.ws.once('close',resolve));
  resumed.send({type:'rematch'});await resumed.wait('lobby');await closing;
  assert.equal(room.conversation,null);
  resumed.send({type:'bot'});await resumed.wait('room',m=>m.status==='lobby'&&m.players.length===2);
  resumed.send({type:'start'});await resumed.wait('started');
  const fresh=await connect('/ws/chat');fresh.send({type:'bind_chat',code:sa.code,token:sa.token});await fresh.wait('chat_ready');
  const reset=await fresh.wait('conversation');assert.notEqual(reset.roomEpoch,history.roomEpoch);
  assert.equal(reset.entries.filter(e=>e.kind==='chat').length,0,'new matches cannot leak old conversation history');
});
