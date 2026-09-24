import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ruleMask,LocalRuleIndex} from '../src/evolution/rule-table.js';
import {CircleIndex} from '../src/spatial-index.js';
import {territoryAt,prepareTerritoryIndex,invalidateTerritoryIndex} from '../public/territory.js';
import {territoryAt as oracle} from './reference/public/territory.js';
import {Game} from '../src/engine.js';
import {Game as ReferenceGame} from './reference/src/engine.js';
import {replay} from './helpers/replay.js';
test('T06 working-tree baseline remains byte-identical to its manifest',()=>{
  const base=new URL('./baselines/t06/',import.meta.url),manifest=JSON.parse(readFileSync(new URL('manifest.json',base)));
  for(const [file,hash] of Object.entries(manifest.files))assert.equal(createHash('sha256').update(readFileSync(new URL(file,base))).digest('hex'),hash,file);
});
test('all 512 B/S masks and in-place rule changes match Set',()=>{
  for(let bits=0;bits<512;bits++){const set=new Set(Array.from({length:9},(_,i)=>i).filter(i=>bits&(1<<i)));assert.equal(ruleMask(set),bits);for(let n=0;n<=8;n++)assert.equal(!!(ruleMask(set)&(1<<n)),set.has(n));}
});
test('local 0/1/8 rules preserve circular boundary and last-rule priority after expiry',()=>{
  const index=new LocalRuleIndex(100),rules=Array.from({length:8},(_,i)=>({x:48+i,y:50,radius:14,birth:new Set([i]),survival:new Set([0,i])}));
  for(const active of [[],rules.slice(0,1),rules,rules.slice(0,4)]){
    index.prepare(active);for(let k=0;k<10000;k++){const expected=active.findLast(r=>(r.x-k%100)**2+(r.y-Math.floor(k/100))**2<=r.radius**2);assert.equal(index.active?index.at(k)?.birth:undefined,expected?ruleMask(expected.birth):undefined);}
  }
  rules[0].birth.add(8);index.prepare(rules.slice(0,1));assert.ok(index.at(5048).birth&(1<<8));
});
test('cached circles preserve yy/xx order, boundaries and geometry changes',()=>{
  const cache=new CircleIndex(100);for(const [x,y,r] of [[0,0,12],[50,50,10],[99,99,12],[50,51,10]]){
    const expected=[];for(let yy=Math.max(0,y-r);yy<=Math.min(99,y+r);yy++)for(let xx=Math.max(0,x-r);xx<=Math.min(99,x+r);xx++)if((x-xx)**2+(y-yy)**2<=r*r)expected.push(yy*100+xx);
    assert.deepEqual([...cache.keys(x,y,r)],expected);assert.equal(cache.keys(x,y,r),cache.keys(x,y,r));
  }
});
test('all million territory cells match original ties; fractional/invalid lookups retain behavior',()=>{
  const sites=[{x:100,y:100},{x:900,y:900},{x:900,y:100},{x:100,y:900},{x:500,y:500}];prepareTerritoryIndex(sites);
  for(let k=0;k<1000000;k++)assert.equal(territoryAt(sites,k%1000,Math.floor(k/1000)),oracle(sites,k%1000,Math.floor(k/1000)));
  for(const [x,y] of [[-1,0],[1000,2],[.5,500.5],[NaN,3],[Infinity,3]])assert.equal(territoryAt(sites,x,y),oracle(sites,x,y));
  sites[0].x=400;invalidateTerritoryIndex(sites);assert.equal(territoryAt(sites,399,100),oracle(sites,399,100));
});
test('4096-cell deployment retains exact success, cost and ordered evolution',()=>{
  replay({ReferenceGame,Game,generations:3,setup:g=>{g.players[0].energy=5000;},operations:[{seq:1,generation:1,action:'deploy',playerId:1,x:148,y:148,cells:Array.from({length:4096},(_,i)=>[i%64,Math.floor(i/64)])}]});
});
