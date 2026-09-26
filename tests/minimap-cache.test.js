import test from 'node:test';
import assert from 'node:assert/strict';
import {MinimapCache} from '../public/minimap-cache.js';

test('minimap reuses world texture and cached composition without enumerating cells',()=>{
  const original=globalThis.document,calls=[];
  const context={drawImage:(...args)=>calls.push(args),save(){},restore(){}};
  globalThis.document={createElement:()=>({width:300,height:150,getContext:()=>context})};
  try {
    const cache=new MinimapCache(),world={},field={world,minimap:{width:180},mctx:context,me:1,boardRevision:0,state:{players:[],nodes:[]},territories:[]};
    Object.defineProperty(field,'cells',{get(){throw new Error('minimap must not enumerate cells');}});
    let backgrounds=0,bases=0;
    const draw=()=>cache.draw(field,()=>backgrounds++,()=>bases++);
    draw();assert.equal(backgrounds,1);assert.equal(bases,1);assert.equal(calls.filter(c=>c[0]===world).length,1);
    draw();assert.equal(bases,1);assert.equal(backgrounds,1);
    field.boardRevision++;draw();assert.equal(bases,2);assert.equal(backgrounds,1);
    field.state={...field.state};draw();assert.equal(backgrounds,2);assert.equal(bases,3);
    const canvas=cache.canvas;field.minimap.width=200;draw();assert.equal(cache.canvas,canvas);assert.equal(canvas.width,200);
    field.me=2;draw();assert.equal(backgrounds,4);
    cache.invalidate();draw();assert.equal(backgrounds,5);
    field.state=null;cache.invalidate();draw();const count=bases;draw();assert.equal(bases,count);
  } finally {globalThis.document=original;}
});
