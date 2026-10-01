import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createServer } from '../../src/server.js';
const { values } = parseArgs({ options: { playwright: { type: 'string' }, executable: { type: 'string' } } });
const { chromium } = createRequire(import.meta.url)(values.playwright || 'playwright');
const app = createServer({ port: 0, host: '127.0.0.1' });
let browser;
try {
  const { port } = await app.listen();
  browser = await chromium.launch({ headless: true, executablePath: values.executable });
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('lifewar.settings', JSON.stringify({ motion: false })));
  await page.goto(`http://127.0.0.1:${port}/`);
  const control = page.locator('#planet-rotate');
  await control.waitFor({ state: 'visible' });
  // Capture the actual renderer from a user interaction, without adding a
  // production debug API. Freeze only simulation for isolated rotation checks.
  await page.evaluate(async () => {
    const { Ambient } = await import('/renderer.js'), original = Ambient.prototype.rotateBy;
    Ambient.prototype.rotateBy = function(...args) { window.testGlobe = this; return original.apply(this,args); };
  });
  await control.focus(); await page.keyboard.press('ArrowRight');
  await page.evaluate(() => {
    const globe = window.testGlobe;
    globe.realAdvance = globe.life.advance; globe.life.advance = () => 0;
    globe.rotation.reset(); globe.staticRendered = null;
  });
  const pixels = () => page.evaluate(() => {
    const canvas = document.querySelector('#ambient'), ratio = canvas.width / innerWidth;
    const data = canvas.getContext('2d').getImageData(Math.floor(innerWidth * .752 * ratio - 70), Math.floor(innerHeight * .45 * ratio - 70), 140, 140).data;
    return data.reduce((hash, value) => (Math.imul(hash, 31) + value) | 0, 0);
  });
  await page.waitForTimeout(100);
  const initial = await pixels();
  const box = await control.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
  assert.equal(await page.evaluate(([x,y]) => document.elementFromPoint(x,y)?.id, [x,y]), 'planet-rotate');
  await page.mouse.move(x,y); await page.mouse.down();
  await page.mouse.move(x+100,y,{steps:8}); await page.waitForTimeout(80);
  assert.notEqual(await pixels(), initial, 'horizontal drag must change the sphere');
  const horizontal = await pixels();
  await page.mouse.move(x+100,y+90,{steps:8}); await page.waitForTimeout(80);
  assert.notEqual(await pixels(), horizontal, 'vertical drag must change the sphere');
  await page.mouse.move(1435,950,{steps:4}); await page.mouse.up();
  assert.equal(await control.evaluate(el => el.classList.contains('dragging')), false);
  await page.waitForTimeout(80);
  const released = await pixels(); await page.waitForTimeout(100);
  assert.equal(await pixels(), released, 'reduced motion must remain static after drag');
  await control.focus(); await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(80);
  assert.notEqual(await pixels(), released, 'keyboard rotation must redraw with motion disabled');
  await control.click(); await page.waitForTimeout(80);
  const reset = await pixels();
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(80);
  assert.notEqual(await pixels(), reset);
  await control.click(); await page.waitForTimeout(80);
  assert.equal(await pixels(), reset, 'reset must return to the same orientation');
  mkdirSync('artifacts/planet-rotation', { recursive: true });
  await page.screenshot({ path: 'artifacts/planet-rotation/home.png' });
  const checkSprites=async()=>{
    const result=await page.evaluate(async()=>{
      const {COLORS,drawCell,isCartoon}=await import('/theme-palette.js');
      const globe=window.testGlobe;
      return {count:globe.life.board.length,owners:[...new Set(globe.life.board)].filter(Boolean).sort(),same:COLORS.map((color,i)=>{
        const tile=document.createElement('canvas');tile.width=tile.height=32;const ctx=tile.getContext('2d');ctx.scale(4,4);ctx.fillStyle=color;drawCell(ctx,.65,.65,6.7,6.7,isCartoon());
        return tile.toDataURL()===globe.globeSprites[i].toDataURL();
      })};
    });
    assert.equal(result.count,24576);assert.deepEqual(result.owners,[1,2,3,4]);assert.deepEqual(result.same,[true,true,true,true]);
  };
  await checkSprites();
  // Enable motion via existing settings UI and verify pause/resume without exposing app internals.
  await page.locator('[data-action="settings"]').first().click();
  await page.locator('#setting-motion').check();
  await page.keyboard.press('Escape');
  await page.mouse.move(x,y); await page.mouse.down(); await page.waitForTimeout(100);
  const held = await pixels(); await page.waitForTimeout(120);
  assert.equal(await pixels(), held, 'automatic rotation pauses while held');
  await page.mouse.up(); await page.waitForTimeout(120);
  assert.notEqual(await pixels(), held, 'automatic rotation resumes after release');
  await page.mouse.move(x,y);await page.mouse.down();
  await page.mouse.move(x+140,y+70,{steps:6});await page.waitForTimeout(100);
  const pushed=await page.evaluate(()=>({q:[...window.testGlobe.rotation.q],velocity:[...window.testGlobe.momentum.velocity]}));
  assert.ok(Math.hypot(...pushed.velocity)>.1,'drag must build angular momentum');
  await page.mouse.up();await page.waitForTimeout(180);
  const coast=await page.evaluate(()=>({q:[...window.testGlobe.rotation.q],velocity:[...window.testGlobe.momentum.velocity]}));
  assert.notDeepEqual(coast.q,pushed.q);assert.ok(Math.hypot(...coast.velocity)<Math.hypot(...pushed.velocity));
  await control.click();assert.deepEqual(await page.evaluate(()=>window.testGlobe.momentum.velocity),[0,0]);
  const timing = await page.evaluate(async () => {
    const globe = window.testGlobe;globe.life.advance=globe.realAdvance;
    globe.life.lastTime=null;globe.life.accumulator=0;
    const before=globe.life.generation,started=performance.now();
    await new Promise(resolve=>setTimeout(resolve,2000));
    return { generations:globe.life.generation-before, elapsed:performance.now()-started };
  });
  assert.ok(Math.abs(timing.generations-timing.elapsed/200)<1.1, JSON.stringify(timing));
  assert.equal(app.rooms.size, 0, 'homepage life must not create server game rooms');
  await page.evaluate(() => window.lifeWarTheme.set('cartoon'));await page.waitForTimeout(100);
  await checkSprites();
  await page.screenshot({ path: 'artifacts/planet-rotation/cartoon.png' });
  await page.evaluate(() => window.lifeWarTheme.set('nexus'));
  await page.locator('#enter-lobby').click(); assert.equal(await control.isVisible(), false);
  await page.waitForTimeout(80);
  const lobbyGeneration=await page.evaluate(()=>window.testGlobe.life.generation);
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(()=>window.testGlobe.life.generation),lobbyGeneration);

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  mobile.on('pageerror', error => errors.push(error.message));
  await mobile.goto(`http://127.0.0.1:${port}/`);
  const touchControl = mobile.locator('#planet-rotate'); await touchControl.waitFor();
  const touchBox = await touchControl.boundingBox();
  const tx = Math.min(380,touchBox.x+touchBox.width*.8), ty = touchBox.y+touchBox.height*.3;
  assert.equal(await mobile.evaluate(([x,y]) => document.elementFromPoint(x,y)?.id, [tx,ty]), 'planet-rotate');
  const cdp = await mobile.context().newCDPSession(mobile);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{x:tx,y:ty}] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{x:tx-30,y:ty+30}] });
  assert.equal(await touchControl.evaluate(el => el.classList.contains('dragging')), true);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  assert.equal(await touchControl.evaluate(el => el.classList.contains('dragging')), false);
  assert.deepEqual(errors, []);
  console.log('PASS: mouse/touch, absolute rotation, heavy drag/inertia/reset, pointer capture/cancel, reduced motion, auto pause/resume, client 5Hz, themes, lobby idle', timing);
} finally { await browser?.close(); await app.close(); }
