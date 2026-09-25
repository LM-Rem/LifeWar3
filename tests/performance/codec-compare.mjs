// Same fixtures, interleaved old/current codec in one process. No Canvas/GC forcing.
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as before from '../baselines/t13-codec/board-protocol.js';
import * as after from '../../public/board-protocol.js';
import {summarize} from './statistics.mjs';
import {environment} from './environment.mjs';
import assert from 'node:assert/strict';
const manifest=JSON.parse(readFileSync(new URL('../baselines/t13-codec/manifest.json',import.meta.url)));
assert.equal(createHash('sha256').update(readFileSync(new URL('../baselines/t13-codec/board-protocol.js',import.meta.url))).digest('hex'),manifest.sha256);
const results=[],N=1000000;
for(const [name,count,birthFraction] of [['sparse',1000,0],['dense-owner',800000,0],['mixed-churn',500000,.5],['all-births',500000,1]]){
 const board=new Uint8Array(N),previous=new Uint8Array(N),keys=new Uint32Array(count),map=new Map();
 for(let i=0;i<count;i++){const k=keys[i]=i*7919%N;board[k]=i%4+1;if(i>=count*birthFraction){previous[k]=board[k]%4+1;map.set(k,previous[k]);}}
 const options={keys,board,previous,ownerAt:k=>board[k],generation:1,baseGeneration:0,roomEpoch:7};
 for(let round=0;round<5;round++)for(const variant of round%2?['after','before']:['before','after']){
  const codec=variant==='before'?before:after,samples=[];let bytes;
  for(let i=0;i<13;i++){
   const target=previous.slice(),cells=new Map(map),start=performance.now();
   const buffer=codec.encodeBoardV2(options),encoded=performance.now();bytes=buffer.byteLength;
   const entries=codec.orderedBoardEntries(codec.decodeBoardPacket(buffer),target),decoded=performance.now();
   for(const value of entries){const k=value%N,o=Math.floor(value/N);if(variant==='after'&&target[k]===o)continue;target[k]=o;if(o)cells.set(k,o);else cells.delete(k);}
   const end=performance.now();if(i>=3)samples.push({encodeMs:encoded-start,decodeOrderMs:decoded-encoded,applyMs:end-decoded,totalMs:end-start});
  }
  results.push({name,count,birthFraction,round:round+1,variant,bytes,samples});
 }
 console.log(name+' completed');
}
const summary=[];
for(const name of [...new Set(results.map(r=>r.name))]){
 const row={name};for(const variant of ['before','after']){const rounds=results.filter(r=>r.name===name&&r.variant===variant);row[variant]={bytes:rounds[0].bytes,rounds:rounds.map(r=>Object.fromEntries(['encodeMs','decodeOrderMs','applyMs','totalMs'].map(k=>[k,summarize(r.samples.map(s=>s[k]))])))};}summary.push(row);
}
const hashes=Object.fromEntries(['tests/baselines/t13-codec/board-protocol.js','public/board-protocol.js','tests/performance/codec-compare.mjs'].map(f=>[f,createHash('sha256').update(readFileSync(f)).digest('hex')]));
const output='artifacts/performance/2026-09-25/codec';mkdirSync(output,{recursive:true});writeFileSync(output+'/report.json',JSON.stringify({environment:environment(),hashes,summary,results},null,2));console.log(JSON.stringify(summary));
