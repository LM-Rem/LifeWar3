import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createServer } from '../src/server.js';
import { CARDS } from '../public/cards.js';

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

test('card protocol: draft, pick and play over WebSocket',async t=>{
  const app=createServer({port:0,host:'127.0.0.1'}),addr=await app.listen(),url=`ws://127.0.0.1:${addr.port}/ws`;
  const a=await client(url);
  t.after(async()=>{a.ws.terminate();await app.close();});
  a.send({type:'create',name:'Solo',practice:true});
  await a.wait('welcome');
  await a.wait('started');
  const room=[...app.rooms.values()][0];
  // 将下一个发卡时间点设为立即触发，等待 state 携带三选一候选
  room.game.cardDrawTimes=[0];
  const draftState=await a.wait('state',s=>s.cardDraft);
  assert.ok(draftState.cardDraft.players.length>=1); // 玩家与 bot 都有候选，bot 已自动选择
  const entry=draftState.cardDraft.players.find(p=>p.playerId===1);
  assert.equal(entry.options.length,3);
  assert.equal(entry.picked,false); // 人类候选仍待选择
  // 选卡 → 广播 card_picked → 手牌同步到状态
  const cardId=entry.options[0].id;
  a.send({type:'pick_card',cardId});
  const picked=await a.wait('card_picked');
  assert.equal(picked.playerId,1);
  assert.equal(picked.cardId,cardId);
  await a.wait('state',s=>s.cards?.hand?.[0]?.id===cardId);
  // 使用卡牌：替换为确定性的能量爆发（避免随机到需要坐标的道具卡）
  room.game.cards.hand[0]=CARDS.find(c=>c.id==='energy_burst');
  a.send({type:'play_card',cardId:'energy_burst'});
  const played=await a.wait('card_played');
  assert.equal(played.playerId,1);
  assert.equal(played.cardId,'energy_burst');
  // 状态同步：能量达到上限（120+60=180）且手牌已空
  await a.wait('state',s=>s.players[0].energy===180&&!s.cards?.hand?.[0]);
  // 手牌已空，再次使用被拒
  a.send({type:'play_card',cardId:'energy_burst'});
  assert.match((await a.wait('error')).message,/手牌/);
});