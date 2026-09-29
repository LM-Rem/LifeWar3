import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeBoardV2,decodeBoardPacket,boardVariant} from '../public/board-protocol.js';
import {visitBitmap} from '../public/bitmap-codec.js';
import {GenerationQueue} from '../public/generation-queue.js';
import {randomSource} from './helpers/load-fixture.js';
const N=1000000;
const tileKeys=t=>Array.from({length:1024},(_,i)=>[(t%32)*32+i%32,(t>>>5)*32+(i>>>5)]).filter(([x,y])=>x<1000&&y<1000).map(([x,y])=>y*1000+x);
const encode=(board,keys,options={})=>encodeBoardV2({board,keys,ownerAt:k=>board[k],allowBitmap:true,allowPalette:true,allowVarint:true,roomEpoch:7,generation:1,baseGeneration:0,...options});
function apply(buffer,target,compact){const p=decodeBoardPacket(buffer,{compactBitmap:compact});if(p.snapshot)target.fill(0);if(p.bitmap)visitBitmap(p.bitmap,(k,o)=>target[k]=o);else for(const v of p.entries)target[v%N]=Math.floor(v/N);return p;}
for(const owners of [[1],[4],[1,4],[2,3],[1,2,4],[1,2,3,4]])test(`palette roundtrip and exact size: ${owners}`,()=>{
 const board=new Uint8Array(N),keys=tileKeys(0);for(let i=0;i<keys.length;i++)board[keys[i]]=owners[i%owners.length];
 const b=encode(board,keys),old=encode(board,keys,{allowPalette:false});
 assert.equal(b.byteLength,owners.length===1?169:owners.length===2?297:424);
 assert.equal(new DataView(b).getUint8(5),owners.length<=2?4:3);
 for(const compact of [true,false]){const target=new Uint8Array(N);apply(b,target,compact);assert.deepEqual(target,board);}
 assert.ok(b.byteLength<=old.byteLength);assert.equal(new DataView(old).getUint8(5),3);
});
test('palette continuous generations cover edges, sparse changes, recolors, deletion, recovery and same-generation revision',()=>{
 const random=randomSource(619),board=new Uint8Array(N),a=new Uint8Array(N),b=new Uint8Array(N),keys=[...tileKeys(0),...tileKeys(31),...tileKeys(992),...tileKeys(1023)];
 let palettes=0;
 for(let generation=1;generation<=100;generation++){
  const changed=new Set();for(let i=0;i<(generation%3?8000:10);i++){const k=keys[Math.floor(random()*keys.length)];board[k]=generation%5===0?0:random()<.2?0:random()<.5?2:4;changed.add(k);}
  const snapshot=generation%17===0,selected=snapshot?keys.filter(k=>board[k]):[...changed];
  const packet=encode(board,selected,{generation,baseGeneration:generation-1,snapshot});
  palettes+=apply(packet,a,false).encoding===4;apply(packet,b,true);assert.deepEqual(a,board);assert.deepEqual(b,board);
  assert.ok(packet.byteLength<=encode(board,selected,{generation,baseGeneration:generation-1,snapshot,allowPalette:false}).byteLength);
 }
 assert.ok(palettes>0);
 const packet=encode(board,keys,{generation:100,baseGeneration:100});apply(packet,a,true);assert.deepEqual(a,board);
});
test('palette malformed packets rejected before exposing compact indexes',()=>{
 const board=new Uint8Array(N),keys=tileKeys(0);for(let i=0;i<129;i++)board[keys[i]]=i%2?4:1;
 const packet=encode(board,keys);assert.equal(new DataView(packet).getUint8(5),4);
 const bad=edit=>{const b=packet.slice(0);edit(new DataView(b));for(const compactBitmap of [true,false])assert.throws(()=>decodeBoardPacket(b,{compactBitmap}));};
 for(const mask of [0,7,16,255])bad(v=>v.setUint8(168,mask));
 bad(v=>v.setUint8(5,3));bad(v=>v.setUint8(packet.byteLength-1,128));bad(v=>v.setUint32(24,1023,true));bad(v=>v.setUint16(38,0x8003,true));bad(v=>v.setUint32(28,1,true));
 for(let length=32;length<packet.byteLength;length++){const b=packet.slice(0,length);new DataView(b).setUint32(20,length-32,true);assert.throws(()=>decodeBoardPacket(b,{compactBitmap:true}));}
 // Narrow right edge: x>=1000 must remain clear even for palette tiles.
 const narrow=tileKeys(31),edge=new Uint8Array(N);for(const k of narrow)edge[k]=4;
 const data=encode(edge,narrow),v=new DataView(data);assert.equal(v.getUint8(5),4);v.setUint8(41,1);assert.throws(()=>decodeBoardPacket(data));
});
test('palette requires explicit capability and has isolated variants; no capability leaks after reset',()=>{
 const board=new Uint8Array(N),keys=tileKeys(0);for(const k of keys)board[k]=4;
 const data=encode(board,keys,{snapshot:true}),q=new GenerationQueue();
 for(const options of [{},{bitmapTiles:true},{paletteTiles:true}]){q.reset(1);q.configure(2,7,options);assert.equal(q.packet(data),false);assert.equal(q.lastFailure.reason,'protocol-encoding');}
 q.reset(2);q.configure(2,7,{bitmapTiles:true,paletteTiles:true});assert.ok(q.packet(data));assert.equal(q.take().packet.decoded.encoding,4);
 q.reset(3);assert.equal(q.paletteTiles,false);
 const variants=new Set();for(const bitmapTiles of [false,true])for(const deltaVarint of [false,true])for(const paletteTiles of bitmapTiles?[false,true]:[false])variants.add(boardVariant({boardVersion:2,bitmapTiles,deltaVarint,paletteTiles}));assert.equal(variants.size,6);
});
