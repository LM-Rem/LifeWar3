// A draw consumes at most one packet. Snapshots explicitly start recovery intervals.
import { decodeBoardPacket } from './board-protocol.js';
export class GenerationQueue {
  constructor({capacity=32,maxBytes=64*1024*1024,maxAgeMs=500,now=()=>performance.now(),onEvent=()=>{},onRecovery=()=>{}}={}) {
    this.capacity=capacity;this.maxBytes=maxBytes;this.maxAgeMs=maxAgeMs;this.now=now;this.onEvent=onEvent;this.onRecovery=onRecovery;this.reset('initial');
  }
  reset(epoch) {if(this.packets?.length)this.onEvent('presentation.cancelled',{epoch:this.epoch,reason:'epoch-reset',queued:this.packets.length});this.failures=0;this.lastFailure=null;this.maxDepth=0;this.epoch=epoch;this.packets=[];this.states=[];this.bytes=0;this.received=-1;this.displayed=-1;this.stateGeneration=-1;this.waiting=true;this.interval=0;this.paused=false;this.lastPacket=null;this.version=1;this.roomEpoch=null;}
  configure(version=1,roomEpoch=null) {this.version=version;this.roomEpoch=roomEpoch;}
  fail(reason) {
    this.failures++;this.lastFailure={reason,received:this.received,displayed:this.displayed,queued:this.packets.length};
    this.onEvent('presentation.failure', this.lastFailure);
    this.packets=[];this.states=[];this.bytes=0;this.waiting=true;
    if(!this.paused)this.onRecovery(reason);
  }
  visibility(hidden) {
    if(hidden===this.paused)return;this.paused=hidden;
    if(hidden)this.fail('hidden');else this.onRecovery('visible');
  }
  packet(buffer,epoch=this.epoch) {
    if(epoch!==this.epoch||this.paused)return false;
    let decoded;try{decoded=decodeBoardPacket(buffer);}catch{this.fail('invalid-packet');return false;}
    if(decoded.version!==this.version){this.fail('protocol-version');return false;}
    if(decoded.version===2&&decoded.roomEpoch!==this.roomEpoch)return false;
    const {snapshot,generation}=decoded,bytes=buffer.byteLength+decoded.memoryBytes;
    if(snapshot){
      if(generation<this.displayed||(!this.waiting&&generation<this.received))return false;
      if(!this.waiting&&generation===this.received&&this.samePacket(buffer))return false;
      this.onEvent('presentation.recovery',{from:this.displayed,to:generation,interval:++this.interval});
      this.packets=[];this.bytes=0;this.waiting=false;
    }else {
      if(this.waiting)return false;
      if(generation<this.received)return false;
      if(generation===this.received){
        if(!decoded.entries.length||this.samePacket(buffer))return false;
        this.onEvent('presentation.revision',{generation});
      }
      if(generation>this.received+1){this.fail('generation-gap');return false;}
      if(decoded.version===2&&decoded.baseGeneration!==this.received){this.fail('base-generation');return false;}
    }
    if(this.packets.length>=this.capacity||this.bytes+bytes>this.maxBytes){this.fail('overflow');return false;}
    this.received=generation;this.lastPacket=buffer;this.packets.push({buffer,decoded,bytes,generation,at:this.now(),snapshot});this.bytes+=bytes;this.maxDepth=Math.max(this.maxDepth,this.packets.length);return true;
  }
  samePacket(buffer) {
    if(!this.lastPacket||this.lastPacket.byteLength!==buffer.byteLength)return false;
    const a=new Uint8Array(this.lastPacket),b=new Uint8Array(buffer);
    for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true;
  }
  state(value,epoch=this.epoch) {
    if(epoch!==this.epoch||this.paused||!Number.isSafeInteger(value.generation)||value.generation<this.stateGeneration)return false;
    const index=this.states.findIndex(s=>s.generation===value.generation);
    if(index>=0)this.states[index]=value;else this.states.push(value);
    this.states.sort((a,b)=>a.generation-b.generation);
    if(this.states.length>64){this.fail('state-overflow');return false;}return true;
  }
  take() {
    if(this.paused)return {};
    if(this.packets.length&&this.now()-this.packets[0].at>this.maxAgeMs){this.fail('latency-limit');return {};}
    const packet=this.waiting?undefined:this.packets.shift();
    if(packet){this.bytes-=packet.bytes;this.displayed=packet.generation;}
    let state;
    while(this.states.length&&this.states[0].generation<=this.displayed&&this.packets[0]?.generation!==this.displayed){state=this.states.shift();this.stateGeneration=state.generation;}
    return {packet,state,waitMs:packet?this.now()-packet.at:0};
  }
}
