import { Worker } from 'node:worker_threads';

// Main-thread bridge. No Game, GPU wait, encoding, or mutable board lives here.
export class RoomWorkerClient {
  constructor(options,{onMessage,onFault,workerURL=new URL('./room-worker.js',import.meta.url),startupMs=20000,stallMs=10000}={}) {
    this.pending=new Set();this.serial=0;this.stopping=false;this.faulted=false;this.exited=false;
    this.worker=new Worker(workerURL,{execArgv:[],workerData:options});
    this.startup=setTimeout(()=>this.fail(new Error('Room worker startup timed out')),startupMs);
    this.lastActivity=null;
    this.watchdog=setInterval(()=>{if(this.lastActivity!==null&&performance.now()-this.lastActivity>stallMs)this.fail(new Error('Room worker stopped responding'));},Math.min(1000,stallMs));
    this.watchdog.unref();
    this.worker.on('message',message=>{
      if(this.stopping||this.faulted)return;
      if(message.type==='frame'){clearTimeout(this.startup);this.lastActivity=performance.now();}
      if(message.type==='result')this.lastActivity=performance.now();
      if(message.type==='fault'){this.fail(new Error(message.message));return;}
      if(message.type==='result')this.pending.delete(message.request);
      try{onMessage(message);}catch(error){this.fail(error);}
    });
    this.onFault=onFault;
    this.worker.on('error',error=>this.fail(error));
    this.worker.on('exit',code=>{this.exited=true;if(!this.stopping)this.fail(new Error(`Room worker exited (${code})`));});
  }
  fail(error) {
    if(this.faulted||this.stopping)return;
    this.faulted=true;clearTimeout(this.startup);this.pending.clear();this.onFault?.(error);void this.close();
  }
  post(message) {if(!this.stopping&&!this.faulted)this.worker.postMessage(message);}
  command(id,session,message) {
    if(this.stopping||this.faulted||this.pending.size>=128)return false;
    const request=++this.serial;this.pending.add(request);
    this.post({type:'command',request,id,session,message});return true;
  }
  close() {
    if(this.closePromise)return this.closePromise;
    this.stopping=true;clearTimeout(this.startup);clearInterval(this.watchdog);this.pending.clear();
    if(this.exited)return Promise.resolve();
    this.closePromise=new Promise(resolve=>{
      // Never terminate a thread tree while Dawn may be in native teardown.
      const timeout=setTimeout(()=>{this.worker.unref();resolve();},2500);
      this.worker.once('exit',()=>{clearTimeout(timeout);resolve();});
      this.worker.postMessage({type:'close'});
    });
    return this.closePromise;
  }
}
