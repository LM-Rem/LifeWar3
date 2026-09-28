import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeBoardV2,decodeBoardPacket,orderedBoardEntries} from '../public/board-protocol.js';
import {GenerationQueue} from '../public/generation-queue.js';
import {randomSource} from './helpers/load-fixture.js';
const N=1000000;
const tileKeys=t=>Array.from({length:1024},(_,i)=>[(t%32)*32+i%32,(t>>>5)*32+(i>>>5)]).filter(([x,y])=>x<1000&&y<1000).map(([x,y])=>y*1000+x);
const encode=(board,keys,options={})=>encodeBoardV2({board,keys,ownerAt:k=>board[k],roomEpoch:7,generation:1,baseGeneration:0,allowVarint:true,allowBitmap:true,...options});
function apply(buffer,board){const p=decodeBoardPacket(buffer);if(p.snapshot)board.fill(0);for(const v of orderedBoardEntries(p,board))board[v%N]=Math.floor(v/N);return p;}

test('bitmap carries births without an insertion table; sparse and empty packets stay small',()=>{
  const board=new Uint8Array(N),keys=tileKeys(0).reverse();for(const k of keys)board[k]=k%4+1;
  const before=[...keys],b=encode(board,keys),p=apply(b,new Uint8Array(N));
  assert.equal(p.encoding,3);assert.equal(p.insertions,undefined);assert.equal(b.byteLength,32+4+4+128+256);
  assert.deepEqual(keys,before,'never sorts server keys');assert.deepEqual(p.entries.map(v=>v%N),Uint32Array.from(tileKeys(0)));
  for(const keys of [[],[0],[0,999999]])assert.ok(encode(board,keys).byteLength<=encode(board,keys,{allowBitmap:false}).byteLength);
});

test('bitmap full-tile replacement handles edges, existing cells, deletions, snapshots and first delta',()=>{
  const keys=[...tileKeys(0),...tileKeys(31),...tileKeys(992),...tileKeys(1023)].reverse();
  const board=new Uint8Array(N);for(const k of keys)board[k]=k%5;
  const target=new Uint8Array(N).fill(4),snap=encode(board,keys.filter(k=>board[k]),{snapshot:true});
  assert.equal(apply(snap,target).encoding,3);assert.deepEqual(target,board);
  for(const k of keys)board[k]=(board[k]+2)%5;
  const delta=encode(board,keys,{forceOrdered:true,generation:2,baseGeneration:1});
  assert.equal(apply(delta,target).encoding,3);assert.deepEqual(target,board);
  for(const k of keys)board[k]=0;
  apply(encode(board,keys,{generation:2,baseGeneration:2}),target);assert.deepEqual(target,board);
});

test('200 randomized mixed sparse/bitmap generations exactly reconstruct the authoritative board',()=>{
  const random=randomSource(918),board=new Uint8Array(N),target=new Uint8Array(N),keys=[...tileKeys(0),...tileKeys(1),...tileKeys(1023)];
  let bitmap=0;
  for(let generation=1;generation<=200;generation++){
    const changes=new Set();for(let i=0;i<(generation%3?20:5000);i++){const k=keys[Math.floor(random()*keys.length)];board[k]=Math.floor(random()*5);changes.add(k);}
    const snapshot=generation%23===0,selected=snapshot?keys.filter(k=>board[k]):[...changes];
    const b=encode(board,selected,{snapshot,generation,baseGeneration:generation-1}),p=apply(b,target);
    bitmap+=p.encoding===3;assert.deepEqual(target,board,`generation ${generation}`);
    assert.ok(b.byteLength<=encode(board,selected,{snapshot,generation,baseGeneration:generation-1,allowBitmap:false}).byteLength);
  }
  assert.ok(bitmap>0);
});

test('bitmap decoder rejects corrupt counts, padding, modes, duplicate tiles and truncation',()=>{
  const board=new Uint8Array(N),keys=[...tileKeys(0),...tileKeys(1)];for(const k of keys)board[k]=1;
  const packet=encode(board,keys);
  assert.equal(decodeBoardPacket(packet).encoding,3);
  const bad=(source,edit)=>{const copy=source.slice(0);edit(new DataView(copy));assert.throws(()=>decodeBoardPacket(copy));};
  for(const length of [32,36,40,100,packet.byteLength-1])assert.throws(()=>decodeBoardPacket(packet.slice(0,length)));
  bad(packet,v=>v.setUint32(28,1,true));bad(packet,v=>v.setUint32(24,1,true));bad(packet,v=>v.setUint16(34,1,true));
  bad(packet,v=>v.setUint16(38,0x8002,true));bad(packet,v=>v.setUint16(424,0,true));
  const edgeBoard=new Uint8Array(N),edgeKeys=tileKeys(1023);for(const k of edgeKeys)edgeBoard[k]=2;
  // Force a bitmap edge tile to coexist with a dense interior tile.
  for(const k of tileKeys(0))edgeBoard[k]=1;
  const edge=encode(edgeBoard,[...tileKeys(0),...edgeKeys]);
  bad(edge,v=>v.setUint16(424,1024,true));
  // Full edge tile uses sparse when smaller; invalid sparse owner/duplicate are still rejected.
  bad(edge,v=>v.setUint16(428,7*1024,true));
  bad(edge,v=>v.setUint16(430,v.getUint16(428,true),true));
  const narrow=new Uint8Array(N),narrowKeys=tileKeys(31);for(const k of narrowKeys.slice(0,129))narrow[k]=1;
  const padded=encode(narrow,narrowKeys);assert.equal(decodeBoardPacket(padded).encoding,3);
  bad(padded,v=>v.setUint8(41,1)); // x=1000 is outside the map.
  bad(padded,v=>v.setUint8(padded.byteLength-1,0xc0)); // Unused owner bits.
  bad(padded,v=>v.setUint16(32,0,true));
  const extra=new Uint8Array(padded.byteLength+1);extra.set(new Uint8Array(padded));new DataView(extra.buffer).setUint32(20,extra.length-32,true);
  assert.throws(()=>decodeBoardPacket(extra.buffer));
});

test('bitmap packets require explicit capability and decoded memory remains bounded',()=>{
  const board=new Uint8Array(N),keys=tileKeys(0);for(const k of keys)board[k]=1;
  const snapshot=encode(board,keys,{snapshot:true,generation:0}),q=new GenerationQueue();
  q.configure(2,7);assert.equal(q.packet(snapshot),false);assert.equal(q.lastFailure.reason,'protocol-encoding');
  q.configure(2,7,{bitmapTiles:true});assert.ok(q.packet(snapshot));q.take();
  assert.ok(q.packet(encode(board,keys)));assert.equal(q.take().packet.generation,1);
  q.maxBytes=1000;assert.equal(q.packet(encode(board,keys,{generation:2,baseGeneration:1})),false);assert.equal(q.lastFailure.reason,'overflow');
});
