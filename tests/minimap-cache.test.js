import test from 'node:test';
import assert from 'node:assert/strict';
import {MinimapCache} from '../public/minimap-cache.js';

test('dense invalidation retains background storage and safely transitions to local updates', () => {
  const originalDocument = globalThis.document;
  let resizes=0, backgrounds=0, bases=0;
  const context={drawImage(){},save(){},beginPath(){},rect(){},clip(){},restore(){}};
  const canvas=()=>({get width(){return this.w??300;},set width(v){this.w=v;resizes++;},
    get height(){return this.h??150;},set height(v){this.h=v;resizes++;},getContext(){return context;}});
  globalThis.document={createElement:canvas};
  try {
    const cache=new MinimapCache(), field={minimap:{width:180},mctx:context,me:1,
      state:{nodes:[],players:[]},territories:[],cells:new Map([[0,1],[1001,2]])};
    let drawn=[];
    const draw=()=>{drawn=[];cache.draw(field,()=>backgrounds++,()=>bases++,(c,k,o)=>drawn.push([k,o]));};
    draw();assert.equal(backgrounds,1);assert.equal(resizes,4);
    const cachedCanvas=cache.canvas,cachedBackground=cache.background;
    cache.beginPacket(field,500000,false);
    cache.change(0,1,3);field.cells.set(0,3);
    // A subsequent small packet may arrive before the full redraw.
    cache.beginPacket(field,1,false);cache.change(1001,2,0);field.cells.delete(1001);
    assert.equal(cache.indexed,false);draw();assert.deepEqual(drawn,[[0,3]]);
    assert.equal(backgrounds,1);assert.equal(resizes,4);
    assert.equal(cache.canvas,cachedCanvas);assert.equal(cache.background,cachedBackground);
    cache.beginPacket(field,1,false);assert.equal(cache.indexed,true);
    cache.change(0,3,4);field.cells.set(0,4);draw();assert.deepEqual(drawn,[[0,4]]);
    cache.beginPacket(field,2,true);field.cells.clear();field.cells.set(999999,2);
    assert.equal(cache.members,null,'invalid index must not retain dense contributor Sets');
    draw();assert.deepEqual(drawn,[[999999,2]]);assert.equal(backgrounds,1);
    field.state.players.push({x:1,y:2,eliminated:false});draw();assert.equal(backgrounds,2);
    assert.equal(resizes,6,'ownership/state invalidation retains backing storage, including tile scratch');
    field.minimap.width=197;draw();assert.equal(resizes,10);assert.equal(backgrounds,3);
    assert.ok(bases>=6);
  } finally {globalThis.document=originalDocument;}
});
