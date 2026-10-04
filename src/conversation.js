import { validateChatText, CONVERSATION_LIMIT } from '../public/conversation-model.js';

export class RoomConversation {
  constructor(epoch, startedAt, now = Date.now) {
    this.epoch=epoch;this.startedAt=startedAt;this.now=now;this.sequence=0;this.entries=[];this.senders=new Map();
  }
  append(entry) {
    const record={...entry,sequence:++this.sequence};
    this.entries.push(record);
    if(this.entries.length>CONVERSATION_LIMIT)this.entries.shift();
    return record;
  }
  chat(member, requestId, input) {
    if(typeof requestId!=='string'||! /^[a-zA-Z0-9_-]{1,64}$/.test(requestId))throw new Error('消息编号无效');
    const text=validateChatText(input), now=this.now();
    let sender=this.senders.get(member.token);
    if(!sender){sender={times:[],receipts:new Map()};this.senders.set(member.token,sender);}
    const previous=sender.receipts.get(requestId);
    if(previous){if(previous.text!==text)throw new Error('消息编号已被使用');return {entry:previous,duplicate:true};}
    sender.times=sender.times.filter(time=>now-time<10000);
    if(sender.times.length>=5)throw new Error('发言过快，请稍后重试');
    sender.times.push(now);
    const entry=this.append({kind:'chat',playerId:member.id,name:member.name,text,time:now,requestId});
    sender.receipts.set(requestId,entry);
    if(sender.receipts.size>50)sender.receipts.delete(sender.receipts.keys().next().value);
    return {entry,duplicate:false};
  }
  packet(after = -1) {
    const reset=after<0||after<(this.entries[0]?.sequence??1)-1||after>this.sequence;
    return {type:'conversation',roomEpoch:this.epoch,startedAt:this.startedAt,reset,sequence:this.sequence,
      entries:reset?this.entries:this.entries.filter(entry=>entry.sequence>after)};
  }
}
