import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createServer} from '../../src/server.js';
import {Game} from '../../src/engine.js';
import {randomSource} from '../helpers/load-fixture.js';
const {values}=parseArgs({options:{playwright:{type:'string'},executable:{type:'string'}}});
const {chromium}=createRequire(import.meta.url)(values.playwright||'playwright');
const app=createServer({port:0,host:'127.0.0.1'});let browser;
try {
  const {port}=await app.listen();browser=await chromium.launch({headless:true,executablePath:values.executable});
  const page=await browser.newPage({viewport:{width:1100,height:850}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/baseline-minimap.js',route=>route.fulfill({contentType:'text/javascript',body:readFileSync(new URL('../baselines/t12-minimap/minimap-cache.js',import.meta.url),'utf8')}));
  await page.goto(`http://127.0.0.1:${port}/`);
  const state=new Game([1,2,3,4].map(i=>({name:'P'+i})),{random:randomSource(91),now:()=>0}).state();
  const report=await page.evaluate(async state=>{
    requestAnimationFrame=()=>0;
    const {Battlefield}=await import('/renderer.js'),{MinimapCache:Fast}=await import('/minimap-cache.js'),{MinimapCache:Legacy}=await import('/baseline-minimap.js');
    document.body.innerHTML='<canvas id="main" style="width:800px;height:700px"></canvas><canvas id="mini" width="180" height="180"></canvas>';
    const f=new Battlefield(document.querySelector('#main'),document.querySelector('#mini'),{grid:false,ranges:true,motion:false});f.camera={x:500,y:500,zoom:.65};
    const samples=[];
    // The old cache's per-cell drawing belongs only in this historical adapter.
    const colors=['#67f5d1','#ff796c','#ac98ff','#f4cc75'];
    class LegacyAdapter extends Legacy {
      draw(field,background,bases){let last=0;super.draw(field,background,c=>{bases(c);last=0;},(c,key,owner)=>{if(last!==owner)c.fillStyle=colors[owner-1]+'a6';last=owner;const s=field.minimap.width/1000;c.fillRect(key%1000*s,Math.floor(key/1000)*s,1,1);});}
    }
    function packet(n,offset){const b=new ArrayBuffer(8+4*n),v=new DataView(b);v.setUint32(0,1,true);v.setUint32(4,offset,true);for(let i=0;i<n;i++){const k=i*7919%1000000;v.setUint32(8+i*4,k+(1+(i+offset)%4)*1000000,true);}return b;}
    for(const n of [500000,800000])for(const [name,Type]of [['legacy',LegacyAdapter],['texture',Fast]]){
      f.reset();f.minimapCache=new Type();f.setState(state);
      for(let i=0;i<7;i++){
        const b=packet(n,i),start=performance.now();f.updatePacket(b);const applied=performance.now();f.drawMinimap();const drawn=performance.now();f.minimap.toDataURL();const done=performance.now();
        if(i>=2)samples.push({n,name,applyMs:applied-start,drawMs:drawn-applied,completedMs:done-start});
      }
    }
    f.reset();f.minimapCache=new Fast();f.setState(state);
    const b=new ArrayBuffer(8+4*1000000),v=new DataView(b);v.setUint32(0,1,true);
    for(let k=0;k<1000000;k++){const owner=1+(k%1000>=500?1:0)+(k>=500000?2:0);v.setUint32(8+k*4,k+owner*1000000,true);}
    f.updatePacket(b);f.drawMinimap();f.draw(0);
    const pixels=[[45,45],[135,45],[45,135],[135,135]].map(([x,y])=>Array.from(f.mctx.getImageData(x,y,1,1).data));
    const before=f.minimap.toDataURL();
    f.minimap.width=f.minimap.height=240;f.drawMinimap();
    const resized=f.minimapCache.canvas.width===240;
    const stateBefore=f.minimap.toDataURL();f.setState({...state,players:state.players.map(p=>({...p,eliminated:true}))});f.drawMinimap();
    const stateChanged=stateBefore!==f.minimap.toDataURL();
    const populated=f.minimap.toDataURL();f.reset();f.drawMinimap();const cleared=f.minimap.toDataURL();
    f.setState(state);f.updatePacket(b);f.minimap.width=f.minimap.height=180;f.drawMinimap();
    return {samples,pixels,resized,stateChanged,cleared:cleared!==populated,reconnected:f.minimap.toDataURL()===before};
  },state);
  const [green,red,purple,yellow]=report.pixels;
  assert.ok(green[1]>green[0]&&green[1]>green[2]);assert.ok(red[0]>red[1]&&red[0]>red[2]);
  assert.ok(purple[2]>purple[0]&&purple[2]>purple[1]);assert.ok(yellow[0]>yellow[2]&&yellow[1]>yellow[2]);
  assert.deepEqual(errors,[]);
  for(const key of ['resized','stateChanged','cleared','reconnected'])assert.equal(report[key],true,key);
  const summary=[];
  for(const n of [500000,800000])for(const name of ['legacy','texture']){
    const samples=report.samples.filter(s=>s.n===n&&s.name===name),row={n,name};
    for(const key of ['applyMs','drawMs','completedMs']){const sorted=samples.map(s=>s[key]).sort((a,b)=>a-b);row[key]=sorted[Math.floor(sorted.length/2)];}summary.push(row);
  }
  mkdirSync('artifacts/performance/overview',{recursive:true});
  await page.screenshot({path:'artifacts/performance/overview/overview.png'});
  writeFileSync('artifacts/performance/overview/results.json',JSON.stringify({browser:browser.version(),scope:'single local headless Chromium, 5 measured redraws; legacy cache frozen t12',summary,...report},null,2));
  console.log(JSON.stringify({status:'PASS',summary,pixels:report.pixels}));
}finally{await browser?.close();await app.close();}
