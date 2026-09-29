import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {WebSocket,WebSocketServer} from 'ws';
import {fileURLToPath} from 'node:url';
process.env.LIFEWAR_CONFIG_PATH=fileURLToPath(new URL('../fixtures/performance/production-20hz.json',import.meta.url));
const {Game}=await import('../../src/engine.js');
import {scenario} from './scenarios.mjs';
import {decodeBoardPacket} from '../../public/board-protocol.js';
import {visitBitmap} from '../../public/bitmap-codec.js';
const warmup=25,samples=20,results=[];
const stats=a=>{const s=[...a].sort((a,b)=>a-b);return {median:s[Math.floor(s.length/2)],p95:s[Math.ceil(s.length*.95)-1]};};
function distribution(game){
  const touched=new Uint16Array(1024),masks=new Uint8Array(1024),live=new Uint16Array(1024);
  for(let i=0;i<game.changes.size;i++){const k=game.changes.order[i];touched[(Math.floor(k/1000)>>>5)*32+((k%1000)>>>5)]++;}
  for(let k=0;k<1000000;k++)if(game.board[k]){const t=(Math.floor(k/1000)>>>5)*32+((k%1000)>>>5);live[t]++;masks[t]|=1<<(game.board[k]-1);}
  const tiles=[];for(let tile=0;tile<1024;tile++){const colors=masks[tile].toString(2).replaceAll('0','').length;tiles.push({tile,changes:touched[tile],live:live[tile],colors,area:Math.min(32,1000-(tile%32)*32)*Math.min(32,1000-(tile>>>5)*32)});}
  return tiles;
}
const server=new WebSocketServer({port:0,host:'127.0.0.1',perMessageDeflate:false});await once(server,'listening');
const connection=once(server,'connection'),client=new WebSocket(`ws://127.0.0.1:${server.address().port}`),opened=once(client,'open');const [peer]=await connection;await opened;
try{
 for(const id of ['P04','P03','P05']){
  const game=scenario(Game,id);for(let i=0;i<warmup;i++){game.step();game.changes.clear();}
  const rows=[],distributions=[];
  for(let i=0;i<samples;i++){
   const previous=game.board.slice();game.step();distributions.push({generation:game.generation,tiles:distribution(game)});
   for(const snapshot of [false,true])for(const allowPalette of (i%2?[true,false]:[false,true])){
    const start=performance.now(),packet=game.packetV2({roomEpoch:7,baseGeneration:game.generation-1,previous,snapshot,allowVarint:true,allowBitmap:true,allowPalette}),encoded=performance.now();
    const decoded=decodeBoardPacket(packet,{compactBitmap:true}),end=performance.now(),target=snapshot?new Uint8Array(1000000):previous.slice();
    if(decoded.bitmap)visitBitmap(decoded.bitmap,(k,o)=>target[k]=o);else for(const v of decoded.entries)target[v%1000000]=Math.floor(v/1000000);
    assert.deepEqual(target,game.board);
    const before=peer._socket.bytesWritten,received=once(client,'message');peer.send(packet);await received;
    rows.push({generation:game.generation,snapshot,allowPalette,bytes:packet.byteLength,socketBytes:peer._socket.bytesWritten-before,encodeMs:encoded-start,decodeMs:end-encoded,encoding:decoded.encoding});
   }
   game.changes.clear();
  }
  const summary=[];
  for(const snapshot of [false,true]){
   const old=rows.filter(r=>r.snapshot===snapshot&&!r.allowPalette),next=rows.filter(r=>r.snapshot===snapshot&&r.allowPalette);
   assert.ok(next.every((r,i)=>r.bytes<=old[i].bytes));
   const row={snapshot,saving:1-next.reduce((a,r)=>a+r.bytes,0)/old.reduce((a,r)=>a+r.bytes,0)};
   for(const [name,list]of [['bitmap',old],['palette',next]])row[name]=Object.fromEntries(['bytes','socketBytes','encodeMs','decodeMs'].map(k=>[k,stats(list.map(r=>r[k]))]));summary.push(row);
  }
  const all=distributions.flatMap(r=>r.tiles),touched=all.filter(t=>t.changes),hist=list=>({colors:[0,1,2,3,4].map(c=>list.filter(t=>t.colors===c).length),changeDensity:[0,.01,.1,.25,.5,1].map((upper,i,a)=>list.filter(t=>i?t.changes/t.area>a[i-1]&&t.changes/t.area<=upper:t.changes===0).length)});
  const result={scenario:id,live:game.alive.length,boardHash:createHash('sha256').update(game.board).digest('hex'),summary,distribution:{all:hist(all),touched:hist(touched)},rows,distributions};results.push(result);console.log(JSON.stringify({...result,rows:undefined,distributions:undefined}));
 }
 const gate={threshold:.1,passed:results.some(r=>r.summary[0].saving>=.1)&&results.every(r=>r.summary.every(s=>s.saving>=0))};
 mkdirSync('artifacts/performance/palette',{recursive:true});writeFileSync('artifacts/performance/palette/report.json',JSON.stringify({scope:'Deterministic synthetic CPU evolution, seed91; loopback TCP including WS framing; no compression/TLS/tunnel. Timings alternate A/B; full board verification each sample.',sourceHashes:Object.fromEntries(['public/bitmap-codec.js','public/board-protocol.js','src/engine.js','tests/performance/scenarios.mjs','tests/fixtures/performance/production-20hz.json'].map(f=>[f,createHash('sha256').update(readFileSync(f)).digest('hex')])),node:process.version,warmup,samples,gate,results},null,2));console.log(JSON.stringify({gate}));
}finally{client.terminate();peer.terminate();await new Promise(r=>server.close(r));}
