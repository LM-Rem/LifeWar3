import test from 'node:test';
import assert from 'node:assert/strict';
import {CellStore} from '../public/cell-store.js';
import {randomSource} from './helpers/load-fixture.js';
test('compact client cells preserve Map insertion order through overwrite, death, rebirth and reset',()=>{
  const board=new Uint8Array(1000),cells=new CellStore(board),map=new Map(),random=randomSource(90);
  for(let i=0;i<10000;i++){
    const key=Math.floor(random()*1000),owner=Math.floor(random()*5);
    if(i%511===0){cells.clear();map.clear();board.fill(0);}
    else if(owner){cells.set(key,owner);map.set(key,owner);}
    else {board[key]=0;assert.equal(cells.delete(key),map.delete(key));}
    if(i%37===0){assert.deepEqual([...cells],[...map]);assert.equal(cells.size,map.size);assert.equal(cells.get(key),map.get(key));}
  }
  cells.clear();cells.set(0,1);cells.delete(0);cells.set(999,4);cells.set(0,2);
  assert.deepEqual([...cells],[[999,4],[0,2]]);
});
