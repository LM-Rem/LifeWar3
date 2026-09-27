// Independent client thread: RTT timers must not share the measured server loop.
import {parentPort,workerData} from 'node:worker_threads';
import {WebSocket} from 'ws';
const primary=new WebSocket(workerData.url),control=new WebSocket(workerData.url);
const picks=[],pings=[],sent=new Map();let session,ready=false,hello=false,pending=null,lastRound=0,timer;
const send=(ws,msg)=>ws.send(JSON.stringify(msg));
const bind=()=>{if(session&&hello)send(control,{type:'bind_control',...session});};
const timeout=setTimeout(()=>finish(new Error('latency client timed out')),30000);
function finish(error){clearTimeout(timeout);clearInterval(timer);primary.terminate();control.terminate();parentPort.postMessage(error?{error:error.message}:{picks,pings});parentPort.close();}
primary.on('error',finish);control.on('error',finish);
primary.on('message',(raw,binary)=>{
  if(binary)return;const msg=JSON.parse(raw);
  if(msg.type==='hello'){
    send(primary,{type:'protocol',version:2,deltaVarint:true});
    send(primary,workerData.session?{type:'resume',...workerData.session}:{type:'create',name:'Probe',practice:true});
  }
  if(msg.type==='welcome'){session={code:msg.code,token:msg.token};bind();}
  if(msg.type==='pong'&&sent.has(msg.time)){pings.push(performance.now()-sent.get(msg.time));sent.delete(msg.time);}
});
control.on('message',raw=>{
  const msg=JSON.parse(raw);
  if(msg.type==='hello'){hello=true;bind();}
  if(msg.type==='control_ready'){
    ready=true;let serial=0;
    timer=setInterval(()=>{const id=++serial;sent.set(id,performance.now());send(primary,{type:'ping',time:id});},125);
  }
  if(msg.type==='card_state'&&ready&&!pending&&msg.cardDraft?.round>lastRound){
    const draft=msg.cardDraft,entry=draft.players.find(p=>p.playerId===1);
    if(!entry||entry.picked)return;
    lastRound=draft.round;pending=performance.now();send(control,{type:'pick_card',cardId:entry.options[0].id,draftRound:draft.round,draftGen:draft.gen});
  }
  if(msg.type==='card_picked'&&pending!==null){picks.push(performance.now()-pending);pending=null;if(picks.length>=workerData.samples)finish();}
  if(msg.type==='error')finish(new Error(msg.message));
});
