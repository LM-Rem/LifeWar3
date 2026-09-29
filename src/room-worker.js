import { parentPort, workerData } from 'node:worker_threads';
import { RoomRuntime } from './room-runtime.js';
import { createGpuEvolution } from './evolution/gpu.js';
import { scheduleTicks } from './tick-scheduler.js';
import { RULES } from './engine.js';

let runtime, gpu, timer, closing=false, faulted=false;
const emit=(message,transfer=[])=>parentPort.postMessage(message,transfer);
async function close() {
  if(closing)return;closing=true;timer?.stop();runtime?.close();
  await gpu?.close();parentPort.close();
}
function fault(error) {
  if(faulted||closing)return;faulted=true;timer?.stop();runtime?.close();
  emit({type:'fault',message:String(error?.stack??error)});
}
try {
  if(workerData.evolutionMode==='gpu') {
    try {gpu=await createGpuEvolution({size:RULES.size});emit({type:'adapter',adapter:gpu.adapter});}
    catch(error){emit({type:'adapter',warning:String(error?.message??error)});}
  }
  runtime=new RoomRuntime({...workerData,gpuEvolution:gpu,emit});
  parentPort.on('message',message=>{
    if(message.type==='close'){void close();return;}
    if(faulted||closing)return;
    try {
      switch(message.type) {
        case 'ack':runtime.acknowledge(message.buffers);runtime.drain();break;
        case 'drain':runtime.updateBuffers(message.buffers);runtime.drain();break;
        case 'attach':runtime.attach(message.member);break;
        case 'disconnect':runtime.disconnect(message.id,message.session,message.explicit);break;
        case 'command': {
          const events=runtime.command(message.id,message.session,message.message);
          emit({type:'result',request:message.request,events,meta:runtime.meta()});break;
        }
      }
    }catch(error){fault(error);}
  });
  runtime.flush();
  timer=scheduleTicks(()=>{try{runtime.tick();}catch(error){fault(error);}},{
    periodMs:1000/RULES.hz,
    // Under overload an immediately overdue next tick can start before a
    // command responding to the just-published state crosses the two ports.
    // Only while an online human is choosing, give that round trip a short I/O
    // window; ordinary ticks retain the immediate path. Never skip generations.
    setSoon:callback=>runtime.needsCommandWindow()?{timeout:setTimeout(callback,2)}:{immediate:setImmediate(callback)},
    clearSoon:handle=>handle.timeout?clearTimeout(handle.timeout):clearImmediate(handle.immediate)
  });
}catch(error){fault(error);void close();}
