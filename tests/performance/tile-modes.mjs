import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {scenario} from './scenarios.mjs';
import {mediumCases,synthetic} from './tile-mode-fixtures.mjs';
import {encodeExperimental,decodeExperimental,applyExperimental,SOLID,RLE,MASK} from '../../experiments/tile-modes-codec.js';
import {encodeBoardV2} from '../../public/board-protocol.js';
const {values:v}=parseArgs({options:{samples:{type:'string',default:'20'},output:{type:'string',default:'artifacts/performance/tile-modes'},production:{type:'boolean'}}});
const samples=Number(v.samples);assert.ok(Number.isInteger(samples)&&samples>=1&&samples<=200);
process.env.LIFEWAR_CONFIG_PATH=fileURLToPath(new URL('../fixtures/performance/production-20hz.json',import.meta.url));
const {Game}=await import('../../src/engine.js');
const variants={baseline:null,solid:{solid:true},rle:{rle:true},mask:{mask:true},combined:{solid:true,rle:true,mask:true}};
if(v.production)variants.production={};
const hash=b=>createHash('sha256').update(b).digest('hex');
const stats=a=>{a=[...a].sort((x,y)=>x-y);return {mean:a.reduce((s,x)=>s+x,0)/a.length,p50:a[Math.floor(a.length/2)],p95:a[Math.ceil(a.length*.95)-1]};};
const encode=(o,name)=>name==='baseline'||name==='production'?encodeBoardV2({...o,allowBitmap:true,allowPalette:true,allowVarint:true,allowTileModes:name==='production'}):encodeExperimental(o,variants[name]);
const results=[],browserCases=[];
const specs=[...'P03 P04 P05'.split(' ').map(id=>({id,evolution:true})),...mediumCases,{id:'SOLID',owners:4},{id:'STRIPES',owners:4}];
mkdirSync(v.output,{recursive:true});
for(const spec of specs){
 const game=spec.evolution?scenario(Game,spec.id):synthetic(spec);
 if(spec.evolution)for(let i=0;i<25;i++){game.step();game.changes.clear();}
 const options=(keys,snapshot=false)=>({board:game.board,keys,ownerAt:k=>game.board[k],generation:game.generation,baseGeneration:Math.max(0,game.generation-1),roomEpoch:7,snapshot});
 const liveKeys=()=>spec.evolution?game.alive.keys.subarray(0,game.alive.length):Uint32Array.from(game.board.keys()).filter(k=>game.board[k]);
 const initial=Buffer.from(encode(options(liveKeys(),true),'baseline')).toString('base64');
 const rows=[],browserCase={id:spec.id,initial,steps:[]},distribution=[];
 for(let i=0;i<samples;i++){
  const previous=game.board.slice();let changes=game.step();if(spec.evolution)changes=game.changes.order.subarray(0,game.changes.size);
  distribution.push({generation:game.generation,changes:changes.length,live:game.board.reduce((n,o)=>n+(o!==0),0)});
  const packetSet={};
  for(const snapshot of [false,true]){
   const keys=snapshot?liveKeys():changes,o=options(keys,snapshot),baseline=encode(o,'baseline');
   const names=Object.keys(variants),rotation=i%names.length,order=[...names.slice(rotation),...names.slice(0,rotation)];
   for(const variant of order){
    const target=previous.slice(),start=performance.now(),packet=encode(o,variant),encoded=performance.now(),decoded=decodeExperimental(packet),validated=performance.now();
    applyExperimental(decoded,target);const applied=performance.now();assert.deepEqual(target,game.board);assert.ok(packet.byteLength<=baseline.byteLength);
    const modes={};if(decoded.bitmap)for(let j=1;j<decoded.bitmap.tiles.length;j+=3){const mode=decoded.bitmap.tiles[j],name=mode===SOLID?'solid':mode===RLE?'rle':mode===MASK?'mask':mode<=1024?'sparse':mode===0x8002?'palette':'bitmap';modes[name]=(modes[name]??0)+1;}
    rows.push({generation:game.generation,snapshot,variant,encoding:decoded.encoding,bytes:packet.byteLength,encodeMs:encoded-start,decodeMs:validated-encoded,applyMs:applied-validated,modes});
    if(!snapshot&&(variant==='baseline'||variant==='combined'))packetSet[variant]=Buffer.from(packet).toString('base64');
   }
  }
  browserCase.steps.push({generation:game.generation,hash:hash(game.board),...packetSet});
  game.changes?.clear();
 }
 const summary=[];for(const snapshot of [false,true])for(const variant of Object.keys(variants)){
  const selected=rows.filter(r=>r.snapshot===snapshot&&r.variant===variant),base=rows.filter(r=>r.snapshot===snapshot&&r.variant==='baseline'),modes={};
  for(const r of selected)for(const [k,n]of Object.entries(r.modes))modes[k]=(modes[k]??0)+n;
  summary.push({snapshot,variant,saving:1-selected.reduce((n,r)=>n+r.bytes,0)/base.reduce((n,r)=>n+r.bytes,0),...Object.fromEntries(['bytes','encodeMs','decodeMs','applyMs'].map(k=>[k,stats(selected.map(r=>r[k]))])),modes});
 }
 results.push({spec,distribution,summary,rows,finalHash:hash(game.board)});browserCases.push(browserCase);
 console.log(JSON.stringify({id:spec.id,summary:summary.map(r=>({snapshot:r.snapshot,variant:r.variant,bytes:Math.round(r.bytes.mean),saving:+r.saving.toFixed(3),encodeMs:+r.encodeMs.p50.toFixed(3),modes:r.modes}))}));
}
const report={scope:'Offline baseline and experimental encoding250 comparison; --production adds negotiated production encoding5. Uncompressed packet bytes include 32B header, exclude WS/TLS. Experimental candidates replan after baseline; production reuses one plan. Node compact validation and plain-board apply, not renderer or network. Synthetic medium fixtures are not gameplay frequency estimates.',node:process.version,samples,seed:91,warmupEvolution:25,sourceHashes:Object.fromEntries(['experiments/tile-modes-codec.js','tests/performance/tile-mode-fixtures.mjs','public/bitmap-codec.js','public/board-protocol.js','public/tile-mode-planner.js'].map(p=>[p,hash(readFileSync(p))])),results};
writeFileSync(`${v.output}/report.json`,JSON.stringify(report,null,2));writeFileSync(`${v.output}/browser-fixtures.json`,JSON.stringify(browserCases));
