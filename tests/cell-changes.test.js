import test from 'node:test';
import assert from 'node:assert/strict';
import { CellChanges } from '../src/cell-changes.js';
import { OrderedCells } from '../src/ordered-cells.js';
import { Game } from '../src/engine.js';
import { randomSource } from './helpers/load-fixture.js';
test('typed changes match Map order, repeated writes, clears and stamp wrap', () => {
  const random=randomSource(13), changes=new CellChanges(1000), map=new Map();
  for(let round=0;round<40;round++) {
    for(let i=0;i<4000;i++){const key=Math.floor(random()*1000),owner=Math.floor(random()*5);changes.set(key,owner);map.set(key,owner);}
    assert.deepEqual([...changes],[...map]);assert.deepEqual([...changes.keys()],[...map.keys()]);
    changes.clear();map.clear();
  }
  changes.epoch=0xffffffff;changes.set(9,2);changes.clear();assert.equal(changes.get(9),undefined);changes.set(9,0);assert.deepEqual([...changes],[[9,0]]);
});
test('stable cell storage compacts without reallocating or reordering', () => {
  const cells=new OrderedCells(10),board=new Uint8Array(10),storage=cells.keys;
  for(const key of [8,2,5,1])cells.push(key);board[2]=board[1]=1;cells.compact(board);
  assert.equal(cells.keys,storage);assert.deepEqual([...cells],[2,1]);
});
test('transitions retain intermediate owners; packets remain independent for slow clients', () => {
  const g=new Game([{name:'A'},{name:'B'}]),events=[];g.onCellTransition=e=>events.push(e);
  g.writeCell(45,1,'seed');const first=g.packet(),saved=Buffer.from(first).toString('hex');
  g.writeCell(45,2,'evolution');g.writeCell(45,0,'dormancy');const second=g.packet();
  assert.deepEqual(events.map(e=>[e.oldOwner,e.newOwner,e.phase]),[[0,1,'seed'],[1,2,'evolution'],[2,0,'dormancy']]);
  assert.deepEqual([...g.changes],[[45,0]]);g.changes.clear();g.writeCell(99,2,'seed');g.packet();
  assert.equal(Buffer.from(first).toString('hex'),saved);assert.equal(new DataView(second).getUint32(8,true),45);
  structuredClone(second,{transfer:[second]});assert.equal(second.byteLength,0);assert.equal(g.packet().byteLength,12);
});
