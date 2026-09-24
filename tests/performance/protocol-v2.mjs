import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {decodeBoardPacket,orderedBoardEntries} from '../../public/board-protocol.js';
import {environment} from './environment.mjs';
import {randomSource} from '../helpers/load-fixture.js';
process.env.LIFEWAR_CONFIG_PATH=fileURLToPath(new URL('../fixtures/performance/production-20hz.json',import.meta.url));
const {Game,RULES}=await import('../../src/engine.js');
const N=1000000,game=new Game([1,2,3,4].map(i=>({name:'P'+i})),{random:randomSource(7),now:()=>0});
const stats=xs=>{const s=[...xs].sort((a,b)=>a-b);return {mean:xs.reduce((a,b)=>a+b,0)/xs.length,p95:s[Math.ceil(s.length*.95)-1],max:s.at(-1),samples:xs.length};};
const frameBytes=n=>n+(n<126?2:n<65536?4:10),results=[];
for(const [name,D,birthFraction,snapshot] of [['empty',0,0,false],['sparse',1000,0,false],['dense-owner',800000,0,false],['mixed-churn',500000,.5,false],['all-births',500000,1,false],['snapshot',500000,1,true]]){
 game.board.fill(0);game.alive.length=0;game.changes.clear();game.generation=1;game.players.forEach(p=>p.cells=0);
 const previous=new Uint8Array(N),map=new Map();
 for(let i=0;i<D;i++){const k=i*7919%N,owner=i%4+1;game.board[k]=owner;game.alive.push(k);game.changes.set(k,owner);game.players[owner-1].cells++;if(i>=D*birthFraction){previous[k]=owner%4+1;map.set(k,previous[k]);}}
 const versions=[];
 for(let round=0;round<5;round++)for(const version of round%2?[2,1]:[1,2]){
  const samples=[];let buffer,encoding;
  for(let i=0;i<13;i++){
   const board=previous.slice(),cells=new Map(map),start=performance.now();
   buffer=version===1?game.packet(snapshot):game.packetV2({roomEpoch:7,baseGeneration:0,previous,snapshot});const encoded=performance.now();
   const p=decodeBoardPacket(buffer),entries=orderedBoardEntries(p,board);const decoded=performance.now();encoding=p.encoding??'v1';
   if(p.snapshot){board.fill(0);cells.clear();}for(const v of entries){const k=v%N,o=Math.floor(v/N);board[k]=o;if(o)cells.set(k,o);else cells.delete(k);}
   const applied=performance.now();if(i>=3)samples.push({encodeMs:encoded-start,decodeOrderMs:decoded-encoded,applyMs:applied-decoded,totalMs:applied-start});
  }
  versions.push({version,round:round+1,bytes:buffer.byteLength,encoding,samples});
 }
 const summary={name,D,birthFraction,snapshot};
 // Actual private state JSON sizes for four viewers, projected at the existing 5Hz cadence.
 const stateBytes=game.players.map(p=>Buffer.byteLength(JSON.stringify({...game.state(p.id),tickMs:1})));
 for(const version of [1,2]){
  const rows=versions.filter(r=>r.version===version),samples=rows.flatMap(r=>r.samples),bytes=rows[0].bytes;
  summary['v'+version]={bytes,encoding:rows[0].encoding};for(const metric of ['encodeMs','decodeOrderMs','applyMs','totalMs'])summary['v'+version][metric]=stats(samples.map(s=>s[metric]));
  summary['v'+version].fourClientBytesPerSecondAt20Hz=snapshot?null:4*20*frameBytes(bytes)+5*stateBytes.reduce((n,b)=>n+frameBytes(b),0);
 }
 summary.packetReductionPercent=(1-summary.v2.bytes/summary.v1.bytes)*100;summary.stateBytes=stateBytes;results.push({summary,rounds:versions});
 console.log(JSON.stringify(summary));
}
const files=['src/engine.js','src/server.js','public/board-protocol.js','public/generation-queue.js','public/renderer.js','public/app.js','public/minimap-cache.js'];
const sourceHashes=Object.fromEntries(files.map(f=>[f,createHash('sha256').update(readFileSync(f)).digest('hex')]));
const report={environment:environment(),rules:RULES,sourceHashes,scope:'5 interleaved rounds in one Node process, 3 warmup + 10 samples each; encode + validated decode/order + board/Map apply, no evolution, Canvas or network latency; synthetic high population, not legal gameplay duration; throughput includes unmasked WebSocket framing and private state JSON at 20/5Hz, excludes TCP/TLS',results};
mkdirSync('artifacts/performance/t13',{recursive:true});writeFileSync('artifacts/performance/t13/protocol-benchmark.json',JSON.stringify(report,null,2));
