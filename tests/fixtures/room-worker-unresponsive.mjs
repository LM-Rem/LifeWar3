import {parentPort,workerData} from 'node:worker_threads';
if(workerData.ready)parentPort.postMessage({type:'frame',events:[]});
parentPort.on('message',message=>{if(message.type==='close')parentPort.close();});
