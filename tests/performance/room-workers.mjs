import {Worker} from 'node:worker_threads';
import {WebSocket} from 'ws';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {mkdirSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {seedRoomLoad,repeatDraft} from '../helpers/room-load.js';
const {values}=parseArgs({options:{evolution:{type:'string',default:'gpu'},samples:{type:'string',default:'30'},target:{type:'string',default:'other'}}});
if(!['other','busy'].includes(values.target)||!Number.isInteger(+values.samples)||+values.samples<1)throw new Error('Invalid benchmark options');
process.env.LIFEWAR_CONFIG_PATH=fileURLToPath(new URL('../fixtures/performance/production-20hz.json',import.meta.url));
const {createServer}=await import('../../src/server.js');
const {RoomWorkerClient}=await import('../../src/room-worker-client.js');
const results=[];
function stats(values){const sorted=[...values].sort((a,b)=>a-b);return {count:sorted.length,medianMs:sorted[Math.floor(sorted.length*.5)],p95Ms:sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.95)-1)],p99Ms:sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.99)-1)],samples:values};}
for(const roomWorkers of [false,true]){
  const app=createServer({port:0,host:'127.0.0.1',roomWorkers,trace:true,evolutionMode:values.evolution,boardProtocol:2,
    roomWorkerFactory:(data,callbacks)=>new RoomWorkerClient({...data,bots:false,testLoad:data.members[0].name==='Load',testDrafts:data.members[0].name==='Probe'||values.target==='busy'},
      {...callbacks,workerURL:new URL('../fixtures/room-worker-instrumented.mjs',import.meta.url)})});
  const {port}=await app.listen();const url=`ws://127.0.0.1:${port}/ws`,load=new WebSocket(url);let interval,probe,loadSession;
  try{
    await new Promise((resolve,reject)=>{
      load.on('error',reject);load.on('message',(raw,binary)=>{if(binary)return;const msg=JSON.parse(raw);
        if(msg.type==='hello'){load.send(JSON.stringify({type:'protocol',version:2,deltaVarint:true}));load.send(JSON.stringify({type:'create',name:'Load',practice:true}));}
        if(msg.type==='welcome')loadSession={code:msg.code,token:msg.token};
        if(msg.type==='started')resolve();
      });
    });
    if(!roomWorkers){const room=[...app.rooms.values()][0];seedRoomLoad(room.game);for(const p of room.game.players)p.bot=false;room.broadcastBoard.set(room.game.board);for(const m of room.members)if(m.ws)m.ws.needsSnapshot=true;
      interval=setInterval(()=>{for(const room of app.rooms.values())if((room.members[0].name==='Probe'||values.target==='busy')&&room.game){for(const p of room.game.players)p.bot=false;repeatDraft(room.game);}},10);
    }
    await delay(1000);
    const measuredRoom=[...app.rooms.values()].find(r=>r.members[0].name==='Load');
    const startGeneration=measuredRoom.game.generation,measurementStart=performance.now();
    probe=new Worker(new URL('./room-latency-client.mjs',import.meta.url),{execArgv:[],workerData:{url,samples:Number(values.samples),session:values.target==='busy'?loadSession:null}});
    const sample=await new Promise((resolve,reject)=>{probe.once('message',resolve);probe.once('error',reject);});
    if(sample.error)throw new Error(sample.error);
    const report=app.performanceReport(),loadRoom=[...app.rooms.values()].find(r=>r.members[0].name==='Load');
    const measurementMs=performance.now()-measurementStart;
    results.push({roomWorkers,evolution:values.evolution,target:values.target,loadGeneration:loadRoom.game.generation,measurementMs,loadHz:(loadRoom.game.generation-startGeneration)*1000/measurementMs,pick:stats(sample.picks),ping:stats(sample.pings),eventLoop:report.eventLoop});
    console.log(JSON.stringify(results.at(-1)));
  }finally{clearInterval(interval);load.terminate();await probe?.terminate();await app.close();}
}
mkdirSync('artifacts/performance/room-workers',{recursive:true});
writeFileSync(`artifacts/performance/room-workers/${values.evolution}-${values.target}.json`,JSON.stringify({scope:'Local sockets, independent client thread, one sustained ~500k synthetic high-change room, target other=separate probe room / busy=loaded room; 20Hz configured, v2 varint, 30 picks by default. AI disabled; synthetic repeated drafts, not gameplay.',results},null,2));
