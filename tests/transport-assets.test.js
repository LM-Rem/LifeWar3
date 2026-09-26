import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { createServer } from '../src/server.js';
import { Game } from '../src/engine.js';
import { randomSource } from './helpers/load-fixture.js';
const get=(url,headers={})=>new Promise((resolve,reject)=>{http.get(url,{headers},res=>{const parts=[];res.on('data',p=>parts.push(p));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(parts)}));}).on('error',reject);});
test('static gzip and identity decode identically; ETags revalidate the selected representation',async t=>{
  const app=createServer({port:0,host:'127.0.0.1'}),{port}=await app.listen();t.after(()=>app.close());
  const url=`http://127.0.0.1:${port}/patterns.json`;
  const plain=await get(url),zip=await get(url,{'accept-encoding':'gzip'});
  assert.equal(zip.status,200);assert.equal(zip.headers['content-encoding'],'gzip');assert.deepEqual(gunzipSync(zip.body),plain.body);
  assert.ok(zip.body.length<plain.body.length/2);assert.notEqual(zip.headers.etag,plain.headers.etag);
  const cached=await get(url,{'accept-encoding':'gzip','if-none-match':zip.headers.etag});assert.equal(cached.status,304);assert.equal(cached.body.length,0);
  const disabled=await get(url,{'accept-encoding':'gzip;q=0'});assert.equal(disabled.headers['content-encoding'],undefined);assert.deepEqual(disabled.body,plain.body);
});
test('a failed room is isolated and does not halt other rooms or retry partial settlement',async t=>{
  let tick;const errors=[];
  const app=createServer({port:0,host:'127.0.0.1',scheduler:fn=>{tick=fn;return{stop(){}};},onRoomError:(e,r)=>errors.push(r.code)});
  await app.listen();t.after(()=>app.close());
  const make=()=>new Game([{name:'A'},{name:'B'}],{random:randomSource(5),now:()=>0});
  const bad=make(),good=make();bad.step=()=>{throw new Error('injected failure');};
  for(const [code,game]of [['bad',bad],['good',good]])app.rooms.set(code,{code,game,members:[],lastActive:Date.now()});
  tick();tick();assert.deepEqual(errors,['bad']);assert.equal(good.generation,2);assert.equal(bad.generation,0);assert.match(app.rooms.get('bad').fault,/injected/);
});
