import {createRequire} from 'node:module';
import {parseArgs} from 'node:util';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from '../../src/server.js';

const {values}=parseArgs({options:{playwright:{type:'string'},executable:{type:'string'}}});
const {chromium}=createRequire(import.meta.url)(values.playwright||'playwright');
const baselineRef='19f2e4a7b7b63895bb97868ef61b15efe445d83f';
const baseline=execFileSync('git',['show',`${baselineRef}:public/app.js`],{encoding:'utf8',maxBuffer:2e6});
const browser=await chromium.launch({headless:true,executablePath:values.executable});
const results=[];
try {
  for(const mode of ['baseline','control']) {
    const app=createServer({port:0,host:'127.0.0.1',boardProtocol:2});
    const {port}=await app.listen();const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    if(mode==='baseline')await page.route('**/app.js',route=>route.fulfill({contentType:'text/javascript',body:baseline}));
    let release;
    try {
      await page.goto(`http://127.0.0.1:${port}/`);await page.locator('#practice').click();
      await page.waitForSelector('#game.active');
      const room=[...app.rooms.values()][0];
      if(mode==='control')for(let i=0;!room.members[0].control&&i<100;i++)await delay(20);
      if(mode==='control')assert.ok(room.members[0].control);
      room.game.cardDrawTimes=[0];await page.waitForSelector('#card-draft-dialog[open]');
      if(mode==='control')await page.evaluate(()=>{
        document.querySelector('#card-draft-options').addEventListener('click',()=>{
          window.pickFeedback={note:document.querySelector('.draft-note').textContent,disabled:[...document.querySelector('#card-draft-options').children].every(el=>el.getAttribute('aria-disabled')==='true')};
        },{once:true});
      });
      const peer=room.members[0].ws,original=peer.send,pending=[];
      peer.send=function(...args){pending.push(args);};
      release=()=>{peer.send=original;for(const args of pending.splice(0))original.apply(peer,args);};
      // Model 1.2 seconds of primary stream delivery backlog. Control remains live.
      const timer=setTimeout(release,1200),start=performance.now();
      await page.locator('#card-draft-options .card').first().click();
      if(mode==='control'){
        const feedback=await page.evaluate(()=>window.pickFeedback);
        assert.match(feedback.note,/正在提交/);assert.equal(feedback.disabled,true);
      }
      await page.waitForFunction(()=>!document.querySelector('#card-draft-dialog').open);
      const confirmMs=performance.now()-start;
      if(mode==='control'){
        await page.waitForFunction(()=>document.querySelectorAll('.card-grid .card').length===1);
        assert.ok(confirmMs<1000,`control confirmation ${confirmMs}ms must bypass backlog`);
      }else assert.ok(confirmMs>=1000);
      clearTimeout(timer);release();await delay(300);
      assert.equal(await page.locator('.card-grid .card').count(),1);
      assert.equal(await page.locator('#card-draft-dialog').evaluate(el=>el.open),false);
      assert.deepEqual(errors,[]);
      if(mode==='control'){
        await page.screenshot({path:'artifacts/card-priority.png'});
        const oldControl=room.members[0].control;oldControl.close();
        for(let i=0;(!room.members[0].control||room.members[0].control===oldControl)&&i<150;i++)await delay(20);
        assert.ok(room.members[0].control&&room.members[0].control!==oldControl,'control reconnects independently');
        assert.equal(room.game.cards.hand[0].length,1);
      }
      results.push({mode,confirmMs,handCount:1,errors});
    }finally{release?.();await page.close();await app.close();}
  }
  mkdirSync('artifacts/performance/card-priority',{recursive:true});
  const report={baselineRef,scope:'Headless browser, primary WebSocket delivery held for 1200ms; not a real WAN bandwidth certification',browser:browser.version(),results};
  writeFileSync('artifacts/performance/card-priority/results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
