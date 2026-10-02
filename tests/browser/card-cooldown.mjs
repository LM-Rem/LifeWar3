import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createServer } from '../../src/server.js';
import { CARDS } from '../../public/cards.js';

const {values}=parseArgs({options:{playwright:{type:'string'},executable:{type:'string'}}});
const {chromium}=createRequire(import.meta.url)(values.playwright||'playwright');
const app=createServer({port:0,host:'127.0.0.1',roomWorkers:false});
let browser;
try {
  const {port}=await app.listen();
  browser=await chromium.launch({headless:true,executablePath:values.executable});
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.locator('#practice').click();await page.locator('#game.active').waitFor();
  const room=[...app.rooms.values()][0],game=room.game;
  let now=game.startedAt;
  game.now=()=>now;game.cardDrawTimes=[];game.players.forEach(p=>p.bot=false);
  game.cards.hand[0]=['energy_burst','purge','repair'].map(id=>game.acquireCard(CARDS.find(c=>c.id===id)));
  await page.waitForFunction(()=>document.querySelectorAll('.card-grid .card').length===3);
  await page.locator('#card-toggle-arrow').click();
  await page.locator('#battle-top.expanded').waitFor();
  const dragOut=async id=>{
    const card=page.locator(`.card-grid [data-card-id="${id}"]`);
    await card.scrollIntoViewIfNeeded();
    const r=await card.boundingBox();
    await page.mouse.move(r.x+r.width/2,r.y+40);await page.mouse.down();
    await page.mouse.move(r.x+r.width/2,600,{steps:12});await page.mouse.up();
  };
  await dragOut('energy_burst');
  await page.waitForFunction(()=>document.querySelector('#card-cooldown').textContent==='卡牌冷却 10 秒');
  assert.equal(game.cards.hand[0].length,2);
  await dragOut('repair');
  assert.equal(await page.locator('.card-grid [data-card-id="repair"]').count(),1);
  assert.equal(game.cards.hand[0].length,2);
  now+=4000;
  await page.waitForFunction(()=>document.querySelector('#card-cooldown').textContent==='卡牌冷却 6 秒');
  await page.reload();await page.locator('#game.active').waitFor();
  await page.waitForFunction(()=>document.querySelector('#card-cooldown').textContent==='卡牌冷却 6 秒');
  assert.equal(await page.locator('.card-grid .card').count(),2);
  await page.locator('#card-toggle-arrow').click();
  mkdirSync('artifacts/card-cooldown',{recursive:true});
  for(const theme of ['nexus','cartoon']){
    await page.evaluate(theme=>window.lifeWarTheme.set(theme),theme);
    await page.screenshot({path:`artifacts/card-cooldown/${theme}.png`});
  }
  now+=6000;
  await page.waitForFunction(()=>document.querySelector('#card-cooldown').hidden);
  await dragOut('purge');
  await page.waitForFunction(()=>document.querySelector('#card-status').textContent.includes('净化'));
  assert.equal(game.cards.hand[0].length,2,'target selection itself does not consume the card or trigger cooldown');
  assert.equal(await page.locator('#card-cooldown').evaluate(el=>el.hidden),true);
  await page.keyboard.press('Escape');
  assert.equal(game.cards.hand[0].length,2,'cancel retains the card');
  await dragOut('repair');
  await page.waitForFunction(()=>document.querySelector('#card-cooldown').textContent==='卡牌冷却 10 秒');
  assert.equal(game.cards.hand[0].length,1);
  assert.deepEqual(errors,[]);
  console.log('PASS: successful use starts 10s cooldown; early drag blocked; countdown updates; refresh restores 6s; exact expiry unlocks; target selection/cancel does not cool down; no page errors');
} finally {await browser?.close();await app.close();}
