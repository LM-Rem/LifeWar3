import test from 'node:test';
import assert from 'node:assert/strict';
import { PacketHistory } from '../src/packet-history.js';
test('history replays every original generation and refuses gaps/version mismatch',()=>{
  const h=new PacketHistory(),packets=[];
  for(let g=1;g<=8;g++){const p=new ArrayBuffer(12);new DataView(p).setUint32(4,g,true);packets.push(p);h.add(g,new Map([[1,p]]));}
  assert.deepEqual(h.after(2,8,1),packets.slice(2));
  assert.equal(h.after(0,8,2),null);h.remove(4);assert.equal(h.after(2,8,1),null);
});
test('history limits both retained bytes and generations, including oversized packets',()=>{
  const h=new PacketHistory({maxGenerations:3,maxBytes:25});
  for(let g=1;g<=5;g++)h.add(g,new Map([[1,new ArrayBuffer(10)]]));
  assert.deepEqual([...h.frames.keys()],[4,5]);assert.equal(h.bytes,20);
  h.add(6,new Map([[1,new ArrayBuffer(30)]]));assert.equal(h.bytes,0);assert.equal(h.frames.size,0);
  for(let g=7;g<=11;g++)h.add(g,new Map([[1,new ArrayBuffer(1)]]));
  assert.deepEqual([...h.frames.keys()],[9,10,11]);
});
