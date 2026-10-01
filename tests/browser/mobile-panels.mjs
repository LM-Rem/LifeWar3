// Regression: text-sized notices stay overlaid and never intercept panel taps.
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createServer } from '../../src/server.js';
const { values } = parseArgs({options:{playwright:{type:'string'},executable:{type:'string'}}});
const { chromium } = createRequire(import.meta.url)(values.playwright || 'playwright');
const app = createServer({port:0,host:'127.0.0.1',roomWorkers:false});
let browser;
try {
  const {port}=await app.listen();
  browser=await chromium.launch({headless:true,executablePath:values.executable});
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true});
  const errors=[],reports=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.locator('.pattern-card').first().waitFor({state:'attached'});
  await page.evaluate(()=>{
    document.querySelector('#home').classList.remove('active');
    document.querySelector('#game').classList.add('active');
    document.querySelector('#card-effects').classList.add('hidden');
    document.querySelector('#node-pressure-status').textContent='节点压制 02:28 后开启';
    document.querySelector('#card-schedule').textContent='下轮征召 00:56';
    window.cancelTaps=0;
    document.querySelector('#cancel-card-target').addEventListener('click',()=>window.cancelTaps++);
  });
  for(const width of [360,390,700,760,1200])for(const theme of ['nexus','cartoon']) {
    await page.setViewportSize({width,height:900});
    await page.evaluate(theme=>window.lifeWarTheme.set(theme),theme);
    await page.waitForFunction(()=>{
      const top=document.querySelector('#card-status').getBoundingClientRect().top;
      return Math.abs(top-document.querySelector('#battle-top').getBoundingClientRect().bottom-10)<1;
    });
    const result=await page.evaluate(()=>({
      statusPointerEvents:getComputedStyle(document.querySelector('#card-status')).pointerEvents,
      countdownPointerEvents:getComputedStyle(document.querySelector('#card-schedule')).pointerEvents,
      headings:[...document.querySelectorAll('.roster-panel .panel-heading,.telemetry-panel .panel-heading')].map(el=>{
        const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
      }),
      inlineTops:[...document.querySelectorAll('.roster-panel,.telemetry-panel')].map(el=>el.style.top),
      panelTops:[...document.querySelectorAll('.roster-panel,.telemetry-panel')].map(el=>el.getBoundingClientRect().top),
      countdowns:[...document.querySelectorAll('#card-schedule,#node-pressure-status')].map(el=>{
        const r=el.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(el);
        return {width:r.width,textWidth:range.getBoundingClientRect().width,center:r.x+r.width/2};
      }),
    }));
    assert.equal(result.statusPointerEvents,'none');assert.equal(result.countdownPointerEvents,'none');
    assert.deepEqual(result.headings,[true,true]);
    assert.deepEqual(result.inlineTops,['','']);
    for(const countdown of result.countdowns) {
      assert.ok(Math.abs(countdown.width-countdown.textWidth)<1,JSON.stringify(countdown));
      assert.ok(Math.abs(countdown.center-width/2)<1,JSON.stringify(countdown));
    }
    if(width<=760)assert.ok(result.panelTops.every(top=>top>=60&&top<=67),JSON.stringify(result.panelTops));
    for(const selector of ['.roster-panel','.telemetry-panel']) {
      const heading=page.locator(`${selector} .collapse-button`);
      await heading.tap();assert.equal(await heading.getAttribute('aria-expanded'),'false');
      assert.ok(await page.locator(selector).evaluate(el=>el.classList.contains('collapsed')));
      await heading.tap();assert.equal(await heading.getAttribute('aria-expanded'),'true');
    }
    reports.push({width,theme,collapseAndExpand:'PASS'});
  }
  // More status content must leave panels anchored; actionable controls still work.
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{
    const effects=document.querySelector('#card-effects');effects.classList.remove('hidden');effects.textContent='超频 30s · 核心护盾 8s · 工程展开 15s';
    document.querySelector('#card-target-status').classList.remove('hidden');
    document.querySelector('#card-target-label').textContent='净化 · 点击战场施放';
  });
  await page.waitForFunction(()=>{
    const top=document.querySelector('#card-status').getBoundingClientRect().top;
    return Math.abs(top-document.querySelector('#battle-top').getBoundingClientRect().bottom-10)<1;
  });
  assert.deepEqual(await page.locator('.roster-panel,.telemetry-panel').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().top)),[60,60]);
  assert.equal(await page.locator('#card-effects').evaluate(el=>getComputedStyle(el).pointerEvents),'auto');
  await page.locator('#cancel-card-target').tap();assert.equal(await page.evaluate(()=>window.cancelTaps),1);
  for(const selector of ['.roster-panel','.telemetry-panel']) {
    await page.locator(`${selector} .collapse-button`).tap();
    assert.equal(await page.locator(`${selector} .collapse-button`).getAttribute('aria-expanded'),'false');
    await page.locator(`${selector} .collapse-button`).tap();
  }
  await page.locator('.battle-brand').tap();
  await page.waitForFunction(()=>Math.abs(document.querySelector('#card-status').getBoundingClientRect().top-document.querySelector('#battle-top').getBoundingClientRect().bottom-10)<1);
  await page.locator('.battle-brand').tap();
  await page.waitForFunction(()=>{
    const top=document.querySelector('#card-status').getBoundingClientRect().top;
    return Math.abs(top-document.querySelector('#battle-top').getBoundingClientRect().bottom-10)<1;
  });
  mkdirSync('artifacts/theme',{recursive:true});
  await page.screenshot({path:'artifacts/theme/mobile-panel-folding.png',animations:'disabled'});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({status:'PASS',reports,dynamicStatus:'PASS',cancelTarget:'PASS',headerExpansion:'PASS',errors}));
} finally {await browser?.close();await app.close();}
