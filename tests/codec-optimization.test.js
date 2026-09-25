import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {encodeBoardV2,decodeBoardPacket,orderedBoardEntries} from '../public/board-protocol.js';
import * as prior from './baselines/t13-codec/board-protocol.js';
import {Battlefield} from '../public/renderer.js';
import {randomSource} from './helpers/load-fixture.js';

test('optimized codec preserves prior wire bytes and ordered entries across dense edge tiles and births',()=>{
 const manifest=JSON.parse(readFileSync(new URL('./baselines/t13-codec/manifest.json',import.meta.url)));
 assert.equal(createHash('sha256').update(readFileSync(new URL('./baselines/t13-codec/board-protocol.js',import.meta.url))).digest('hex'),manifest.sha256);
 const random=randomSource(725),N=1000000;
 for(const mode of ['dense','sparse-edge','mixed','births','snapshot']){
  const previous=new Uint8Array(N),board=new Uint8Array(N),keys=[];
  for(let i=0;i<800000;i++){
   const k=i*7919%N;if(mode==='sparse-edge'&&k%1000<990)continue;
   const owner=1+(i%4);previous[k]=(mode==='births'&&random()<.05)?0:owner%4+1;board[k]=owner;keys.push(k);
  }
  if(mode==='mixed')for(let i=0;i<keys.length;i+=5)board[keys[i]]=0;
  const options={keys,ownerAt:k=>board[k],board,previous,generation:5,baseGeneration:4,roomEpoch:7,snapshot:mode==='snapshot'};
  const before=prior.encodeBoardV2(options),after=encodeBoardV2(options);
  assert.deepEqual(new Uint8Array(after),new Uint8Array(before),mode+' wire');
  const parsed=decodeBoardPacket(after);
  assert.deepEqual(orderedBoardEntries(parsed,previous),prior.orderedBoardEntries(prior.decodeBoardPacket(before),previous),mode+' order');
 }
});

test('renderer skips unchanged writes but retains v1 death/rebirth insertion semantics',()=>{
 const calls=[],board=new Uint8Array(1000000),cells=new Map([[9,1],[5,2]]);board[9]=1;board[5]=2;
 const field={board,cells,boardRevision:0,texture:{set:(...v)=>calls.push(v),flush:()=>{}},minimapCache:{beginPacket:()=>{},change:()=>{}}};
 const packet=entries=>{const b=new ArrayBuffer(8+4*entries.length),v=new DataView(b);entries.forEach(([k,o],i)=>v.setUint32(8+i*4,k+o*1000000,true));return b;};
 Battlefield.prototype.updatePacket.call(field,packet([[9,1],[5,2],[100,0]]));assert.deepEqual(calls,[]);
 Battlefield.prototype.updatePacket.call(field,packet([[9,0],[9,1],[5,3]]));
 assert.deepEqual([...cells],[[5,3],[9,1]]);assert.deepEqual(calls,[[9,0],[9,1],[5,3]]);
});
