import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeExperimental,decodeExperimental,applyExperimental,SOLID,RLE,MASK} from '../experiments/tile-modes-codec.js';
import {encodeBoardV2,decodeBoardPacket} from '../public/board-protocol.js';
import {randomSource} from './helpers/load-fixture.js';
const N=1000000;
const keysOf=t=>Array.from({length:1024},(_,i)=>[(t%32)*32+i%32,(t>>>5)*32+(i>>>5)]).filter(([x,y])=>x<1000&&y<1000).map(([x,y])=>y*1000+x);
const options=(board,keys,extra={})=>({board,keys,ownerAt:k=>board[k],roomEpoch:7,generation:1,baseGeneration:0,...extra});
const mode=p=>new DataView(p).getUint16(38,true);
function verify(board,keys,previous=new Uint8Array(N),extra={},modes){const o=options(board,keys,extra),packet=encodeExperimental(o,modes),decoded=decodeExperimental(packet),target=previous.slice();applyExperimental(decoded,target);assert.deepEqual(target,board);assert.ok(packet.byteLength<=encodeBoardV2({...o,allowBitmap:true,allowPalette:true,allowVarint:true}).byteLength);return packet;}

test('solid replaces interior and partial edge tiles including all-dead, snapshot and revision',()=>{
 for(const t of [0,31,992,1023])for(const owner of [0,1,4]){
  const keys=keysOf(t),previous=new Uint8Array(N),board=new Uint8Array(N);for(const k of keys){previous[k]=2;board[k]=owner;}
  const packet=verify(board,keys,previous,{generation:4,baseGeneration:4});assert.equal(mode(packet),SOLID);assert.equal(packet.byteLength,41);
  if(owner)assert.equal(mode(verify(board,keys,undefined,{snapshot:true})),SOLID);
 }
});
test('row RLE covers full valid area and can cross row boundaries',()=>{
 const board=new Uint8Array(N),keys=keysOf(0);keys.forEach((k,i)=>board[k]=i<333?1:i<777?4:0);
 const packet=verify(board,keys);assert.equal(mode(packet),RLE);assert.equal(packet.byteLength,48);
 for(const t of [31,992,1023]){const b=new Uint8Array(N),kk=keysOf(t);kk.forEach((k,i)=>b[k]=i<kk.length/2?2:3);assert.equal(mode(verify(b,kk)),RLE);}
});
function maskFixture(){const board=new Uint8Array(N),previous=new Uint8Array(N),all=keysOf(0);all.forEach((k,i)=>board[k]=previous[k]=i%5);const keys=all.filter((_,i)=>i%8===0);keys.forEach(k=>board[k]=(board[k]+2)%5);return {board,previous,keys};}
test('mask updates only changed coordinates, uses 3bit owners across bytes and supports snapshots',()=>{
 const {board,previous,keys}=maskFixture();const packet=verify(board,keys,previous,{}, {mask:true});assert.equal(mode(packet),MASK);assert.equal(packet.byteLength,216);
 const sparse=new Uint8Array(N);keys.forEach((k,i)=>sparse[k]=i%4+1);const snap=verify(sparse,keys,undefined,{snapshot:true},{mask:true});assert.notEqual(mode(snap),MASK); // Snapshot occupancy is cheaper than a change mask.
});
test('corruption never reaches apply: counts, owner, padding, lengths, edges and run bounds',()=>{
 const b=new Uint8Array(N),keys=keysOf(0);keys.forEach((k,i)=>b[k]=i<500?1:4);const rle=encodeExperimental(options(b,keys));
 const bad=(source,edit)=>{const copy=source.slice(0);edit(new DataView(copy));assert.throws(()=>decodeExperimental(copy));};
 bad(rle,v=>v.setUint16(40,0,true));bad(rle,v=>v.setUint16(42,7<<10,true));bad(rle,v=>v.setUint16(42,1023|1024,true));bad(rle,v=>v.setUint16(44,1|1024,true));
 b.fill(0);keys.forEach(k=>b[k]=4);const solid=encodeExperimental(options(b,keys));bad(solid,v=>v.setUint8(40,5));bad(solid,v=>v.setUint32(24,1,true));bad(solid,v=>v.setUint16(38,0x8006,true));
 const f=maskFixture();f.keys.pop();const mask=encodeExperimental(options(f.board,f.keys),{mask:true});assert.equal(mode(mask),MASK);
 bad(mask,v=>v.setUint8(168,255));bad(mask,v=>v.setUint8(mask.byteLength-1,255));bad(mask,v=>v.setUint32(24,1,true));bad(mask,v=>v.setUint16(36,31,true));bad(mask,v=>v.setUint16(6,1,true));
 for(const packet of [solid,rle,mask]){
  assert.throws(()=>decodeBoardPacket(packet));
  for(let n=32;n<packet.byteLength;n++){const cut=packet.slice(0,n);new DataView(cut).setUint32(20,n-32,true);assert.throws(()=>decodeExperimental(cut));}
  const tail=new Uint8Array(packet.byteLength+1);tail.set(new Uint8Array(packet));new DataView(tail.buffer).setUint32(20,tail.length-32,true);assert.throws(()=>decodeExperimental(tail.buffer));
 }
});
test('100 randomized consecutive generations reconstruct exactly with fallback, snapshots and edge tiles',()=>{
 const random=randomSource(541),board=new Uint8Array(N),target=new Uint8Array(N),all=[...keysOf(0),...keysOf(31),...keysOf(992),...keysOf(1023)];
 for(let generation=1;generation<=100;generation++){
  const changes=new Set();for(let i=0;i<(generation%4?120:2000);i++){const key=all[Math.floor(random()*all.length)];board[key]=Math.floor(random()*5);changes.add(key);}
  const snapshot=generation%13===0,keys=snapshot?all.filter(k=>board[k]):[...changes],o=options(board,keys,{generation,baseGeneration:generation-1,snapshot});
  const packet=encodeExperimental(o);applyExperimental(decodeExperimental(packet),target);assert.deepEqual(target,board);
  assert.ok(packet.byteLength<=encodeBoardV2({...o,allowBitmap:true,allowPalette:true,allowVarint:true}).byteLength);
 }
});
test('empty updates and tiny sparse updates preserve production bytes',()=>{
 const board=new Uint8Array(N);board[123]=4;for(const keys of [[],[123]]){const o=options(board,keys);assert.deepEqual(encodeExperimental(o),encodeBoardV2({...o,allowBitmap:true,allowPalette:true,allowVarint:true}));}
});
