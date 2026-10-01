import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../public/theme.js', import.meta.url),'utf8');
function boot(saved, unavailable = false) {
  const listeners = new Map(), events = [], dataset = {};
  let value = saved, meta;
  const window = {
    addEventListener(name, listener) { listeners.set(name,listener); },
    dispatchEvent(event) { events.push(event); },
  };
  const context = vm.createContext({ window, document:{ documentElement:{dataset}, querySelector:()=>({setAttribute:(key,value)=>{meta=value;}}) },
    CustomEvent:class {constructor(type, options){this.type=type;this.detail=options.detail;}},
    localStorage:{getItem:()=>{if(unavailable)throw new Error('storage disabled');return value;},setItem:(key,next)=>{if(unavailable)throw new Error('storage disabled');value=next;}} });
  vm.runInContext(source,context);
  return { dataset, events, theme:window.lifeWarTheme, saved:()=>JSON.parse(value), meta:()=>meta,
    storage(next,key='lifewar.settings'){value=next;listeners.get('storage')({key});} };
}
test('theme migration preserves existing preferences and rejects malformed or unknown saved themes',()=>{
  for(const value of [null,'{broken','[]','{"theme":"unknown"}'])assert.equal(boot(value).dataset.theme,'nexus');
  const state=boot('{"grid":false,"sound":true}');
  state.theme.set('cartoon');
  assert.deepEqual(state.saved(),{grid:false,sound:true,theme:'cartoon'});
  assert.equal(state.meta(),'#faf7ef');
  state.theme.set('nexus');assert.equal(state.meta(),'#080e13');
});
test('theme switching still works when storage is unavailable and duplicate selection avoids repaint events',()=>{
  const state=boot(null,true);
  state.theme.set('cartoon');assert.equal(state.dataset.theme,'cartoon');
  const count=state.events.length;state.theme.set('cartoon');assert.equal(state.events.length,count);
});
test('cross-tab settings changes and storage clearing update the active presentation theme',()=>{
  const state=boot('{"theme":"cartoon"}');
  state.storage('{"theme":"nexus"}');assert.equal(state.dataset.theme,'nexus');
  state.storage('{"theme":"cartoon"}','unrelated');assert.equal(state.dataset.theme,'nexus');
  state.storage('{"theme":"cartoon"}');assert.equal(state.dataset.theme,'cartoon');
  state.storage(null,null);assert.equal(state.dataset.theme,'nexus');
});
