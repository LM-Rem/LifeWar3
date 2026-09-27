// Test-only entry point. Production never accepts these messages or hooks.
import {parentPort,workerData} from 'node:worker_threads';
import {RoomRuntime} from '../../src/room-runtime.js';
import {seedRoomLoad,repeatDraft} from '../helpers/room-load.js';
let failNext=false,runtime;
const tick=RoomRuntime.prototype.tick;
RoomRuntime.prototype.tick=function(){
  runtime=this;
  if(failNext)throw new Error('Injected room failure');
  if(workerData.testLoad&&!this.testLoaded){seedRoomLoad(this.game);this.baseline.set(this.game.board);for(const p of this.peers.values())p.needsSnapshot=true;this.testLoaded=true;}
  if(workerData.testDrafts){for(const p of this.game.players)p.bot=false;repeatDraft(this.game);}
  return tick.call(this);
};
parentPort.on('message',message=>{
  if(message.type==='test_block'){
    parentPort.postMessage({type:'test_blocking'});
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,message.ms);
    parentPort.postMessage({type:'test_unblocked'});
  }
  if(message.type==='test_fault')failNext=true;
  if(message.type==='test_advance_clock'&&runtime){const now=runtime.game.now()+message.ms;runtime.game.now=()=>now;}
});
await import('../../src/room-worker.js');
