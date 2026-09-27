import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomWorkerClient} from '../src/room-worker-client.js';
const workerURL=new URL('./fixtures/room-worker-unresponsive.mjs',import.meta.url);

test('worker bridge bounds pending commands and retires an unresponsive room',async()=>{
  let fault,ready;const faulted=new Promise(resolve=>fault=resolve),started=new Promise(resolve=>ready=resolve);
  const bridge=new RoomWorkerClient({ready:true},{workerURL,stallMs:100,onMessage:ready,onFault:fault});
  await started;
  for(let i=0;i<128;i++)assert.equal(bridge.command(1,1,{type:'cards'}),true);
  assert.equal(bridge.command(1,1,{type:'cards'}),false);
  assert.match((await faulted).message,/stopped responding/);await bridge.close();
  assert.equal(bridge.exited,true);assert.equal(bridge.pending.size,0);assert.equal(bridge.command(1,1,{type:'cards'}),false);
});
test('worker startup timeout is isolated and closes the worker',async()=>{
  let fail;const error=new Promise(resolve=>fail=resolve);
  const bridge=new RoomWorkerClient({ready:false},{workerURL,startupMs:100,onMessage(){},onFault:fail});
  assert.match((await error).message,/startup timed out/);await bridge.close();assert.equal(bridge.exited,true);
});
