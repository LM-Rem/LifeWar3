// End-to-end visual and state regression for both presentation themes.
// Use the already installed Playwright and browser; no downloads are needed.
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../../src/server.js';
import { CARD_CONFIG } from '../../public/cards.js';
const { values } = parseArgs({ options: { playwright: { type:'string' }, executable: { type:'string' } } });
const { chromium } = createRequire(import.meta.url)(values.playwright || 'playwright');
const app = createServer({ port:0, host:'127.0.0.1', roomWorkers:false });
let browser;
const output = 'artifacts/theme'; mkdirSync(output,{recursive:true});
  const errors = [], checks = [];
try {
  const { port } = await app.listen(), url = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({headless:true,executablePath:values.executable});
  const context = await browser.newContext({ viewport:{width:1440,height:1000} });
  const page = await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url); await page.locator('.pattern-card').first().waitFor({state:'attached'});
  assert.equal(await page.locator('html').getAttribute('data-theme'),'nexus');
  await page.screenshot({animations:'disabled',path:`${output}/home-nexus.png`});
  await page.locator('#home [data-action="settings"]').click();
  await page.locator('[data-theme-option="cartoon"]').click();
  assert.equal(await page.locator('[data-theme-option="cartoon"]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('lifewar.settings')).theme),'cartoon');
  assert.equal(await page.locator('.theme-option').first().evaluate(el=>getComputedStyle(el).getPropertyValue('--text').trim()),'#304c43');
  await page.screenshot({animations:'disabled',path:`${output}/settings.png`});
  await page.locator('#settings-dialog .close-dialog').click();
  await page.screenshot({animations:'disabled',path:`${output}/home-cartoon.png`});
  await page.reload(); await page.locator('.pattern-card').first().waitFor({state:'attached'});
  assert.equal(await page.locator('html').getAttribute('data-theme'),'cartoon');
  checks.push('setting selection, persisted reload, startup theme');

  const library = await context.newPage(); library.on('pageerror',e=>errors.push(e.message));
  await library.goto(`${url}/library.html`);
  await library.locator('.library-file').first().waitFor();
  assert.equal(await library.locator('html').getAttribute('data-theme'),'cartoon');
  await library.locator('[data-tab="game"]').click();
  await library.locator('.library-file').first().click();
  await library.screenshot({animations:'disabled',path:`${output}/library-cartoon.png`});
  // Selecting a library entry starts its evolution preview automatically.
  await library.locator('#sim-play').click();
  const beforeGeneration = Number((await library.locator('#sim-generation').textContent()).replace('GEN ',''));
  await library.locator('#sim-step').click();
  assert.equal(await library.locator('#sim-generation').textContent(),`GEN ${beforeGeneration+1}`);
  await library.locator('#library-settings').click();
  await library.locator('[data-theme-option="nexus"]').click();
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='nexus');
  await library.locator('[data-theme-option="cartoon"]').click();
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='cartoon');
  await library.locator('.close-dialog').click();
  checks.push('pattern library preview, evolution, cross-page and cross-tab theme synchronization');

  await page.bringToFront();
  await page.locator('#enter-lobby').click();
  await page.locator('#create-room').waitFor();
  await page.screenshot({animations:'disabled',path:`${output}/lobby-cartoon.png`});
  await page.locator('#create-room').click();
  await page.locator('#room-detail').waitFor();
  await page.locator('#add-bot').click();
  await page.locator('.player-slot').nth(1).waitFor();
  await page.screenshot({animations:'disabled',path:`${output}/room-cartoon.png`});
  await page.locator('#start-game').click();
  await page.locator('#game.active').waitFor();
  await page.waitForFunction(()=>document.querySelector('#generation').textContent!=='GEN 000000');
  await page.screenshot({animations:'disabled',path:`${output}/game-cartoon.png`});
  await page.locator('#game [data-action="help"]').click();
  await page.screenshot({animations:'disabled',path:`${output}/help-cartoon.png`});
  await page.locator('#help-dialog .close-dialog').click();
  await page.locator('#open-editor').click();
  await page.locator('#rle-input').fill('x = 3, y = 3, rule = B3/S23\nbo$2bo$3o!');
  await page.locator('#import-rle').click();
  await page.screenshot({animations:'disabled',path:`${output}/editor-cartoon.png`});
  await page.locator('#editor-dialog .close-dialog').click();
  checks.push('live room, AI match, battlefield, help and custom editor');

  // A separate fixed presentation board proves recoloring cannot mutate game state.
  const result = await page.evaluate(async () => {
    const { Battlefield, COLORS } = await import('/renderer.js');
    const { createTerritories } = await import('/territory.js');
    const main=document.createElement('canvas'),mini=document.createElement('canvas');
    main.style.cssText='width:600px;height:450px';mini.width=mini.height=180;
    document.body.append(main,mini);
    const field=new Battlefield(main,mini,{grid:true,ranges:true,motion:false});
    field.state={status:'playing',generation:0,serverTime:0,players:[{id:1,name:'A',x:400,y:400,hp:100,energy:100,cells:1},{id:2,name:'B',x:600,y:600,hp:100,energy:100,cells:1}],nodes:[{id:0,x:500,y:500,owner:0}],cards:{effects:[]}};
    field.territories=createTerritories(field.state.players,field.state.nodes);
    field.camera={x:500,y:500,zoom:4};
    const b=new ArrayBuffer(16),v=new DataView(b);v.setUint32(0,1,true);v.setUint32(4,17,true);v.setUint32(8,1500490,true);v.setUint32(12,2500491,true);
    field.updatePacket(b);field.draw(0);field.drawMinimap();
    const light=mini.toDataURL(),round=main.toDataURL(),board=Array.from(field.board),size=field.cells.size;
    window.lifeWarTheme.set('nexus');field.draw(0);field.drawMinimap();const dark=mini.toDataURL();
    const darkPalette=COLORS.slice(), darkMain=main.toDataURL();
    window.lifeWarTheme.set('cartoon');field.draw(0);field.drawMinimap();
    const assertions={changed:light!==dark,restored:light===mini.toDataURL(),mainChanged:round!==darkMain,mainRestored:round===main.toDataURL(),boardUnchanged:board.every((owner,k)=>owner===field.board[k]),generation:field.generation,sizeUnchanged:size===field.cells.size,darkPalette,lightPalette:COLORS.slice(),atlasSize:field.sprites.tiles.size};
    const delta=(generation,key,owner)=>{const buffer=new ArrayBuffer(12),view=new DataView(buffer);view.setUint32(4,generation,true);view.setUint32(8,key+owner*1000000,true);return buffer;};
    field.updatePacket(delta(18,500492,3));field.draw(0);const born=main.toDataURL();
    field.updatePacket(delta(19,500492,0));field.draw(0);
    assertions.birthUpdatedAtlas=born!==round;assertions.deathRestoredAtlas=main.toDataURL()===round;
    field.updatePacket(delta(20,500490,4));field.draw(0);assertions.ownerUpdatedAtlas=main.toDataURL()!==round;
    // A close-up export provides a reviewable example of four rounded factions.
    for(let owner=1;owner<=4;owner++)for(const [dx,dy] of [[1,0],[2,1],[0,2],[1,2],[2,2]]) {
      const key=(492+dy)*1000+485+owner*6+dx;field.board[key]=owner;field.texture.set(key,owner);field.sprites.set(key);
    }
    field.camera.zoom=16;field.draw(0);assertions.detail=main.toDataURL();
    field.reset();field.draw(0);field.drawMinimap();assertions.cleared=field.sprites.tiles.size>0&&field.cells.size===0;
    main.remove();mini.remove();return assertions;
  });
  writeFileSync(`${output}/cell-detail.png`,Buffer.from(result.detail.split(',')[1],'base64'));delete result.detail;
  for(const key of ['changed','restored','mainChanged','mainRestored','boardUnchanged','sizeUnchanged','cleared','birthUpdatedAtlas','deathRestoredAtlas','ownerUpdatedAtlas'])assert.equal(result[key],true,key);
  assert.equal(result.generation,17);assert.ok(result.atlasSize<=128);
  assert.deepEqual(result.darkPalette,['#67f5d1','#ff796c','#ac98ff','#f4cc75']);
  checks.push('board and generation preserved, atlas reset, minimap recolored and restored');

  // Trigger a real server draft without waiting for the one-minute schedule.
  const game=[...app.rooms.values()][0].game;
  game.cardDrawTimes=[0];
  await page.locator('#card-draft-dialog[open]').waitFor();
  assert.equal(await page.locator('#card-draft-options .card').count(),3);
  await page.screenshot({animations:'disabled',path:`${output}/draft-cartoon.png`});
  await page.locator('#card-draft-options .card.buff').click();
  await page.locator('#card-draft-dialog').waitFor({state:'hidden'});
  // Populate all three hand categories using the actual private-state channel.
  game.cards.hand[0]=['law','buff','item'].map(type=>game.acquireCard(CARD_CONFIG.cards.find(c=>c.type===type)));
  await page.locator('.card-grid .card').nth(2).waitFor({state:'attached'});
  await page.locator('.battle-brand').click();
  await page.locator('.card-grid .card.buff').waitFor();
  await page.screenshot({animations:'disabled',path:`${output}/hand-cartoon.png`});
  const cardBox=await page.locator('.card-grid .card.buff').boundingBox();
  await page.mouse.move(cardBox.x+cardBox.width/2,cardBox.y+cardBox.height/2);
  await page.mouse.down();await page.mouse.move(800,500,{steps:10});await page.mouse.up();
  await page.waitForFunction(()=>[...document.querySelectorAll('body > canvas')].some(el=>el!==document.querySelector('#ambient')));
  await page.screenshot({animations:'disabled',path:`${output}/card-particles.png`});
  // The DOM card leaves its slot when animation begins; authority changes later.
  for(let attempt=0;attempt<100&&game.cards.hand[0].length!==2;attempt++)await delay(100);
  assert.equal(game.cards.hand[0].length,2);
  await page.locator('.battle-brand').click();
  checks.push('real draft selection, all hand categories, animated buff use through server');
  await page.locator('#exit-game').click();
  await page.locator('#confirm-dialog[open]').waitFor();
  await page.screenshot({animations:'disabled',path:`${output}/confirm-cartoon.png`});
  await page.evaluate(()=>document.querySelector('#confirm-dialog').close());
  await page.evaluate(()=>document.querySelector('#result-dialog').showModal());
  await page.screenshot({animations:'disabled',path:`${output}/result-cartoon.png`});
  await page.evaluate(()=>document.querySelector('#result-dialog').close());
  checks.push('draft, confirm, result overlays');

  await page.setViewportSize({width:390,height:844});
  await page.screenshot({animations:'disabled',path:`${output}/game-mobile.png`});
  await page.locator('#game [data-action="settings"]').click();
  await page.locator('#settings-dialog[open]').waitFor();
  await page.screenshot({animations:'disabled',path:`${output}/settings-mobile.png`});
  const overflow=await page.evaluate(()=>document.querySelector('#settings-dialog').scrollWidth>document.querySelector('#settings-dialog').clientWidth);
  assert.equal(overflow,false);
  const modalBox=await page.locator('#settings-dialog').boundingBox();
  assert.ok(modalBox.x>=0&&modalBox.y>=0&&modalBox.x+modalBox.width<=390&&modalBox.y+modalBox.height<=844);
  await library.setViewportSize({width:390,height:844});await library.screenshot({animations:'disabled',path:`${output}/library-mobile.png`});
  assert.equal(await library.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  checks.push('390px mobile battlefield, settings and library');
  assert.deepEqual(errors,[]);
  writeFileSync(`${output}/results.json`,JSON.stringify({status:'PASS',checks,errors,result},null,2));
  console.log(JSON.stringify({status:'PASS',checks,errors,result}));
} finally { await browser?.close(); await app.close(); }
