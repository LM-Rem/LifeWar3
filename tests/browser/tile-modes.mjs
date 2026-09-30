import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
const {values:v}=parseArgs({options:{playwright:{type:'string'},executable:{type:'string'},input:{type:'string',default:'artifacts/performance/tile-modes'}}});
const fixtures=JSON.parse(readFileSync(`${v.input}/browser-fixtures.json`));
const files=new Set(['/experiments/tile-modes-codec.js','/public/bitmap-codec.js','/public/board-protocol.js','/public/tile-mode-planner.js']);
const server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;if(path==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Offline codec validation</title>');}else if(files.has(path)){res.setHeader('Content-Type','text/javascript');res.end(readFileSync('.'+path));}else{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
 const {chromium}=createRequire(import.meta.url)(v.playwright||'playwright');browser=await chromium.launch({headless:true,executablePath:v.executable});
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}/`);
 const results=[];
 for(const fixture of fixtures){
  const result=await page.evaluate(async f=>{
   const {decodeExperimental,applyExperimental}=await import('/experiments/tile-modes-codec.js');
   const bytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0)).buffer;
   const digest=async b=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(x=>x.toString(16).padStart(2,'0')).join('');
   const boards={baseline:new Uint8Array(1000000),combined:new Uint8Array(1000000)},rows=[];
   for(const board of Object.values(boards))applyExperimental(decodeExperimental(bytes(f.initial)),board);
   for(let i=0;i<f.steps.length;i++){
    const step=f.steps[i];for(const variant of (i%2?['combined','baseline']:['baseline','combined'])){
     const buffer=bytes(step[variant]),start=performance.now(),decoded=decodeExperimental(buffer),validated=performance.now();applyExperimental(decoded,boards[variant]);const applied=performance.now();
     if(await digest(boards[variant])!==step.hash)throw new Error(`board mismatch ${f.id}/${variant}/${step.generation}`);
     rows.push({generation:step.generation,variant,decodeMs:validated-start,applyMs:applied-validated});
    }
   }
   return {id:f.id,rows};
  },fixture);results.push(result);
 }
 assert.deepEqual(errors,[]);
 const stats=a=>{a.sort((x,y)=>x-y);return {p50:a[Math.floor(a.length/2)],p95:a[Math.ceil(a.length*.95)-1]};};
 const summary=results.map(r=>({id:r.id,variants:Object.fromEntries(['baseline','combined'].map(v=>{const rows=r.rows.filter(x=>x.variant===v);return [v,Object.fromEntries(['decodeMs','applyMs'].map(k=>[k,stats(rows.map(x=>x[k]))]))];}))}));
 const report={status:'PASS',browser:browser.version(),scope:'Offline browser compact decode + Uint8Array board application, SHA256 each consecutive generation against Node authority. Excludes Canvas/texture upload, RAF, transport and server encoding. Base64 decode/hash outside timings. 20 samples per case, not a stable speed certification.',verifiedGenerations:results.reduce((n,r)=>n+r.rows.length,0),summary,results};
 writeFileSync(`${v.input}/browser.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,results:undefined}));
}finally{await browser?.close();await new Promise(r=>server.close(r));}
