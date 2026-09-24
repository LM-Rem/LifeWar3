import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeBoardV2,decodeBoardPacket,orderedBoardEntries,MAGIC,MAX_PACKET_BYTES} from '../public/board-protocol.js';
import {GenerationQueue} from '../public/generation-queue.js';
import {Game} from '../src/engine.js';
import {randomSource} from './helpers/load-fixture.js';
const N=1000000;
const apply=(buffer,board,map)=>{const p=decodeBoardPacket(buffer),entries=orderedBoardEntries(p,board);if(p.snapshot){board.fill(0);map.clear();}for(const v of entries){const k=v%N,o=Math.floor(v/N);board[k]=o;if(o)map.set(k,o);else map.delete(k);}return p;};
const tileKeys=tile=>Array.from({length:1024},(_,i)=>(Math.floor(tile/32)*32+Math.floor(i/32))*1000+tile%32*32+i%32).filter(k=>k<N&&k%1000>=tile%32*32);
function fixture(keys,previousOwner=1,owner=2){const previous=new Uint8Array(N),board=new Uint8Array(N);for(const k of keys){previous[k]=previousOwner;board[k]=owner;}return {keys,previous,board,ownerAt:k=>board[k],generation:1,baseGeneration:0,roomEpoch:7};}

test('adaptive ordered24, tiled sparse/dense, mixed tiles and birth fallback include all metadata',()=>{
  for(const count of [1,63,64,511,512,513,1024]){
    const f=fixture(tileKeys(0).slice(0,count)),b=encodeBoardV2(f),p=decodeBoardPacket(b);
    assert.ok(b.byteLength<=32+count*3);assert.deepEqual([...orderedBoardEntries(p,f.previous)].filter(v=>v>=N).sort((a,b)=>a-b),f.keys.map(k=>k+2*N).sort((a,b)=>a-b));
  }
  const f=fixture([...tileKeys(0),...tileKeys(1).slice(0,100)]);
  const p=decodeBoardPacket(encodeBoardV2(f));assert.equal(p.encoding,1);assert.equal(p.entries.length,1124);
  assert.equal(decodeBoardPacket(encodeBoardV2(fixture(tileKeys(0),0))).encoding,0,'birth order metadata defeats dense');
  assert.equal(decodeBoardPacket(encodeBoardV2({...f,snapshot:true})).encoding,0);
  const empty=decodeBoardPacket(encodeBoardV2(fixture([])));assert.equal(empty.entries.length,0);assert.equal(empty.generation,1);
});

test('1000 randomized generations exactly preserve v1 board and Map insertion order, including snapshots',()=>{
  const random=randomSource(913),g=new Game([{name:'A'},{name:'B'}],{random:randomSource(4),now:()=>0});
  const a=new Uint8Array(N),b=new Uint8Array(N),ma=new Map(),mb=new Map();
  const keys=[...tileKeys(0),...tileKeys(1),...tileKeys(32),...tileKeys(1023)];let tiled=0,ordered=0;
  for(let generation=1;generation<=1000;generation++){
    g.changes.clear();g.generation=generation;
    for(let i=0;i<(generation%7?128:3000);i++){
      const k=keys[Math.floor(random()*keys.length)],owner=Math.floor(random()*5);
      // Final-write values and first-touch order, including death/rebirth in one broadcast.
      g.board[k]=owner;g.changes.set(k,owner);
    }
    if(generation%101===0){g.alive.length=0;for(const k of keys)if(g.board[k])g.alive.push(k);const v1=g.packet(true),v2=g.packetV2({roomEpoch:7,snapshot:true});apply(v1,a,ma);apply(v2,b,mb);}
    else {const v2=g.packetV2({roomEpoch:7,baseGeneration:generation-1,previous:a});const p=apply(v2,b,mb);p.encoding?tiled++:ordered++;apply(g.packet(),a,ma);}
    assert.deepEqual(b,a,`board generation ${generation}`);assert.deepEqual([...mb],[...ma],`order generation ${generation}`);
  }
  assert.ok(tiled>0&&ordered>0);
});

test('decoder rejects malformed lengths, owners, duplicate tiles/keys and insertion tables before mutation',()=>{
  const f=fixture(tileKeys(0)),dense=encodeBoardV2(f);
  const mutate=(buffer,edit)=>{const copy=buffer.slice(0);edit(new DataView(copy));assert.throws(()=>decodeBoardPacket(copy));};
  for(const length of [0,7,8,31,32,35,100,dense.byteLength-1])assert.throws(()=>decodeBoardPacket(dense.slice(0,length)));
  assert.throws(()=>decodeBoardPacket(new ArrayBuffer(MAX_PACKET_BYTES+1)));
  for(const [offset,value,width] of [[0,0x1234,4],[4,3,1],[5,2,1],[6,2,2],[8,0,4],[20,0xffffffff,4],[24,N+1,4],[28,1025,4],[32,1025,2],[34,1,2],[36,1024,2],[40,5,1]])mutate(dense,v=>v['setUint'+width*8](offset,value,true));
  const two=encodeBoardV2(fixture([...tileKeys(0),...tileKeys(1)]));mutate(two,v=>v.setUint16(1064,0,true));
  const edge=dense.slice(0),ev=new DataView(edge);ev.setUint16(36,1023,true);ev.setUint32(24,64,true);
  for(let local=0;local<1024;local++)ev.setUint8(40+local,(local%32<8&&Math.floor(local/32)<8)?2:0);
  assert.equal(decodeBoardPacket(edge).entries.length,64);mutate(edge,v=>v.setUint8(48,2));
  const sparse=encodeBoardV2(fixture(tileKeys(0).slice(0,100)));mutate(sparse,v=>v.setUint16(42,v.getUint16(40,true),true));
  const ordered=encodeBoardV2({...f,forceOrdered:true});mutate(ordered,v=>{v.setUint8(34,0x70);});mutate(ordered,v=>{for(let i=0;i<3;i++)v.setUint8(35+i,v.getUint8(32+i));});
  const wrong=new Uint8Array(N);assert.throws(()=>orderedBoardEntries(decodeBoardPacket(dense),wrong),/insertion/);assert.equal(wrong.some(Boolean),false);
  f.previous[f.keys[5]]=0;const born=encodeBoardV2(f),parsed=decodeBoardPacket(born);assert.equal(parsed.insertions.length,1);
  assert.throws(()=>orderedBoardEntries(parsed,new Uint8Array(N).fill(1)),/insertion/);
  mutate(born,v=>{v.setUint8(born.byteLength-3,255);v.setUint8(born.byteLength-2,255);v.setUint8(born.byteLength-1,255);});
});

test('v2 queue enforces negotiation, wire epoch, base generation, duplicates and bounded decoded memory',()=>{
  const q=new GenerationQueue(),snap=encodeBoardV2({...fixture([]),snapshot:true,generation:0});
  assert.equal(q.packet(snap),false);q.reset('connection');q.configure(2,7);assert.ok(q.packet(snap));q.take();
  const packet=encodeBoardV2(fixture([0]));assert.ok(q.packet(packet));assert.equal(q.packet(packet.slice(0)),false);assert.equal(q.take().packet.generation,1);
  assert.equal(q.packet(encodeBoardV2({...fixture([]),generation:2,baseGeneration:1,roomEpoch:8})),false);
  assert.equal(q.packet(encodeBoardV2({...fixture([]),generation:2,baseGeneration:2})),false);assert.equal(q.lastFailure.reason,'base-generation');
  q.reset('again');q.configure(2,7);q.packet(snap);q.take();q.maxBytes=40;assert.equal(q.packet(packet),true);q.take();
  const dense=encodeBoardV2({...fixture(tileKeys(0)),generation:2,baseGeneration:1});assert.equal(q.packet(dense),false);assert.equal(q.lastFailure.reason,'overflow');
  assert.equal(q.bytes,0);assert.equal(new DataView(packet).getUint32(0,true),MAGIC);
});

test('v2 20Hz input / 60Hz RAF consumes each generation exactly once without recovery',()=>{
  let now=0;const q=new GenerationQueue({now:()=>now}),f=fixture([]),drawn=[];
  q.configure(2,7);q.packet(encodeBoardV2({...f,generation:0,snapshot:true}));
  for(let frame=0;frame<=600;frame++){
    now=frame*1000/60;if(frame&&frame%3===0){const generation=frame/3;q.packet(encodeBoardV2({...f,generation,baseGeneration:generation-1}));}
    const p=q.take().packet;if(p)drawn.push(p.generation);assert.ok(q.packets.length<=1);
  }
  assert.deepEqual(drawn,Array.from({length:201},(_,i)=>i));assert.equal(q.failures,0);
});
