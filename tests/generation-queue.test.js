import test from 'node:test';
import assert from 'node:assert/strict';
import { GenerationQueue } from '../public/generation-queue.js';
const packet=(g,snapshot=false)=>{const b=new ArrayBuffer(8),v=new DataView(b);v.setUint32(0,+snapshot,true);v.setUint32(4,g,true);return b;};
test('20Hz input / 60Hz draws submits every generation without fixed buffering',()=>{
  let now=0;const q=new GenerationQueue({now:()=>now}),drawn=[];q.packet(packet(0,true));
  for(let frame=0;frame<601;frame++){now=frame*1000/60;if(frame&&frame%3===0)q.packet(packet(frame/3));const p=q.take().packet;if(p)drawn.push(p.generation);assert.ok(q.packets.length<=1);}
  assert.deepEqual(drawn,Array.from({length:201},(_,i)=>i));
});
test('burst, empty delta, future/late state and duplicates remain ordered',()=>{
  const q=new GenerationQueue();q.reset('a');q.state({generation:0,hp:100});q.packet(packet(0,true));q.take();
  for(let i=1;i<=5;i++)q.packet(packet(i));q.state({generation:4,hp:10});q.state({generation:2,hp:90});
  assert.equal(q.packet(packet(3)),false);assert.equal(q.packet(packet(6),'old'),false);assert.equal(q.state({generation:0},'old'),false);
  for(let i=1;i<=5;i++){const r=q.take();assert.equal(r.packet.generation,i);if(r.state)assert.ok(r.state.generation<=i);}
  q.state({generation:5,hp:5});assert.equal(q.take().state.hp,5);assert.equal(q.take().packet,undefined);
});
test('overflow, gap, latency and visibility cause explicit bounded recovery',()=>{
  let now=0;const events=[],requests=[],q=new GenerationQueue({capacity:2,maxAgeMs:100,now:()=>now,onEvent:(...args)=>events.push(args),onRecovery:r=>requests.push(r)});
  q.packet(packet(0,true));q.take();q.packet(packet(1));q.packet(packet(2));q.packet(packet(3));assert.equal(q.waiting,true);assert.equal(q.bytes,0);assert.equal(q.take().packet,undefined);
  q.packet(packet(10,true));assert.equal(q.take().packet.generation,10);q.packet(packet(12));assert.equal(requests.at(-1),'generation-gap');
  q.packet(packet(20,true));now=101;q.take();assert.equal(requests.at(-1),'latency-limit');
  q.visibility(true);assert.equal(q.packet(packet(30,true)),false);q.visibility(false);assert.equal(requests.at(-1),'visible');
  q.packet(packet(40,true));q.take();assert.equal(q.packet(packet(39,true)),false);
  q.reset('new');assert.equal(q.packet(packet(50,true),'initial'),false);assert.equal(q.displayed,-1);
  assert.ok(events.some(([name,v])=>name==='presentation.failure'&&v.reason==='overflow'));
});
test('byte and state limits and malformed packets never grow without bounds',()=>{
  const q=new GenerationQueue({maxBytes:16});q.packet(packet(0,true));q.packet(packet(1));q.packet(packet(2));assert.equal(q.bytes,0);
  for(let i=0;i<65;i++)q.state({generation:i});assert.equal(q.states.length,0);
  assert.equal(q.packet(new ArrayBuffer(9)),false);assert.equal(q.waiting,true);
});
test('same-generation final board revision is drawn, exact retransmission is not',()=>{
  const q=new GenerationQueue();q.packet(packet(5,true));
  const revision=new ArrayBuffer(12),v=new DataView(revision);v.setUint32(4,5,true);v.setUint32(8,180180,true);
  assert.equal(q.packet(revision),true);assert.equal(q.packet(revision.slice(0)),false);q.state({generation:5,status:'finished'});
  assert.equal(q.take().state,undefined);const last=q.take();assert.equal(last.packet.buffer,revision);assert.equal(last.state.status,'finished');
});
