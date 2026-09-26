import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {once} from 'node:events';
import {WebSocket,WebSocketServer} from 'ws';
import {Game} from '../../src/engine.js';
import {scenario} from './scenarios.mjs';
import {decodeBoardPacket,orderedBoardEntries} from '../../public/board-protocol.js';
const server=new WebSocketServer({port:0,host:'127.0.0.1',perMessageDeflate:false});
await once(server,'listening');
const connected=once(server,'connection'),client=new WebSocket(`ws://127.0.0.1:${server.address().port}`);
const [peer]=await connected;await once(client,'open');
const results=[];
try {
  for(const id of ['P01','P03','P04']){
    const game=scenario(Game,id);for(let i=0;i<25;i++){game.step();game.changes.clear();}
    const rows=[];
    for(let i=0;i<20;i++){
      const previous=game.board.slice();game.step();
      for(const snapshot of [false,true])for(const allowVarint of [false,true]){
        const start=performance.now(),packet=game.packetV2({roomEpoch:7,baseGeneration:game.generation-1,previous,snapshot,allowVarint}),encoded=performance.now();
        const decoded=decodeBoardPacket(packet),entries=orderedBoardEntries(decoded,previous),end=performance.now();
        const target=snapshot?new Uint8Array(1000000):previous.slice();
        for(const value of entries)target[value%1000000]=Math.floor(value/1000000);
        assert.deepEqual(target,game.board);
        const before=peer._socket.bytesWritten,received=once(client,'message');peer.send(packet);await received;
        rows.push({snapshot,allowVarint,bytes:packet.byteLength,socketBytes:peer._socket.bytesWritten-before,encodeMs:encoded-start,decodeMs:end-encoded,encoding:decoded.encoding});
      }
      game.changes.clear();
    }
    const summary=[];
    for(const snapshot of [false,true])for(const allowVarint of [false,true]){
      const selected=rows.filter(r=>r.snapshot===snapshot&&r.allowVarint===allowVarint),r={snapshot,allowVarint};
      for(const key of ['bytes','socketBytes','encodeMs','decodeMs'])r[key]=selected.map(s=>s[key]).sort((a,b)=>a-b)[10];
      summary.push(r);
    }
    results.push({scenario:id,live:game.alive.length,summary});console.log(JSON.stringify(results.at(-1)));
  }
  mkdirSync('artifacts/performance/bandwidth',{recursive:true});writeFileSync('artifacts/performance/bandwidth/report.json',JSON.stringify({scope:'20 consecutive generations per scenario; loopback TCP bytesWritten including WebSocket framing, no deflate/TLS/tunnel overhead; encode/decode median, single process',results},null,2));
} finally {client.terminate();peer.terminate();await new Promise(r=>server.close(r));}
