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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  // Isolated catalog: exercise UI saves without modifying the user's real patterns.
  const catalog = { categories: [], patterns: [
    { id: 'directed', name: '方向测试', en: 'DIRECTION', role: '测试', desc: '', cells: [[0,0],[1,0],[1,1]], direction: '右上' },
    { id: 'empty', name: '无方向测试', en: 'EMPTY', role: '测试', desc: '', cells: [[0,0]] },
  ] };
  await page.route('**/patterns.json', route => route.fulfill({ json: catalog }));
  const saved = [];
  await page.route('**/api/patterns', route => {
    const input = route.request().postDataJSON(); saved.push(input);
    const pattern = catalog.patterns.find(p => p.id === input.id);
    Object.assign(pattern, input);
    return route.fulfill({ json: { ok: true, pattern } });
  });
  await page.goto(`http://127.0.0.1:${port}/library.html`);
  assert.equal(await page.locator('#library-direction option').count(), 9);
  await page.locator('[data-tab="game"]').click();
  await page.locator('[data-pattern="directed"]').click();
  assert.equal(await page.locator('#library-direction').inputValue(), '右上');
  await page.selectOption('#library-direction', '左下');
  await page.locator('#library-add').click();
  await page.waitForFunction(() => document.querySelector('#toasts').textContent.includes('已保存'));
  assert.equal(saved.at(-1).direction, '左下');
  await page.selectOption('#library-direction', '');
  await Promise.all([page.waitForResponse('**/api/patterns'),page.locator('#library-add').click()]);
  assert.equal(saved.at(-1).direction, null);
  catalog.patterns[0].direction = '右上';
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => document.querySelector('#selected-preview').title === '方向：右上');
  const preview = page.locator('#selected-preview');
  // Buttons are initialized on the landing page, before entering a match.
  await page.locator('#rotate-pattern').evaluate(button => button.click());
  assert.equal(await preview.getAttribute('title'), '方向：右下');
  await page.locator('#flip-pattern').evaluate(button => button.click());
  assert.equal(await preview.getAttribute('title'), '方向：右上');
  assert.equal(await page.locator('[data-pattern="directed"] canvas').getAttribute('title'), '方向：右上');
  await page.locator('[data-pattern="empty"]').evaluate(button => button.click());
  assert.equal(await preview.getAttribute('title'), '');
  await page.locator('[data-pattern="directed"]').evaluate(button => button.click());
  assert.equal(await preview.getAttribute('title'), '方向：右上');
  assert.equal(await page.locator('#selected-direction').getAttribute('title'), '方向：右上');
  mkdirSync('artifacts/pattern-direction', { recursive: true });
  await page.locator('#practice').click();
  await page.locator('#game.active').waitFor();
  for (const theme of ['nexus','cartoon']) for (const [width,height] of [[1440,1000],[780,900],[390,844]]) {
    await page.setViewportSize({width,height});
    await page.evaluate(theme=>window.lifeWarTheme.set(theme),theme);
    const geometry=await page.evaluate(()=>{
      const rect = el => { const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}; };
      const card=document.querySelector('[data-pattern="directed"]');
      return {card:rect(card),arrow:rect(card.querySelector('.pattern-direction')),canvas:rect(card.querySelector('canvas')),cost:rect(card.querySelector('.pattern-cost')),
        preview:rect(document.querySelector('#selected-preview')),previewArrow:rect(document.querySelector('#selected-direction'))};
    });
    assert.ok(geometry.arrow.left>=geometry.cost.right,`${theme} ${width}: opposite header corners`);
    assert.ok(geometry.arrow.right<=geometry.card.right,`${theme} ${width}: arrow inside card`);
    assert.ok(geometry.arrow.bottom<=geometry.canvas.top,`${theme} ${width}: arrow does not overlap pattern`);
    assert.ok(geometry.previewArrow.bottom<=geometry.preview.top,`${theme} ${width}: preview arrow outside canvas`);
    assert.ok(geometry.previewArrow.right<=geometry.preview.right,`${theme} ${width}: preview right aligned`);
    await page.screenshot({path:`artifacts/pattern-direction/${theme}-${width}.png`});
  }
  // Direction metadata must not change the pattern's scale, centering or pixels.
  assert.equal(await page.evaluate(async()=>{
    const {drawPattern}=await import('/renderer.js');
    for(const [w,h] of [[118,94],[88,72]]){
      const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
      const cells=Array.from({length:128},(_,x)=>[x,x%7]);
      drawPattern(canvas,cells,undefined,null);const plain=canvas.toDataURL();
      for(const direction of ['上','下','左','右','左上','右上','左下','右下']){
        drawPattern(canvas,cells,undefined,direction);
        if(canvas.toDataURL()!==plain)return false;
      }
    }
    return true;
  }),true);
  // Show all eight glyphs at the production preview sizes for visual review.
  await page.evaluate(async () => {
    const { drawPattern } = await import('/renderer.js');
    const { DIRECTIONS } = await import('/patterns.js');
    const gallery=document.createElement('main');
    gallery.style.cssText='position:fixed;inset:0;z-index:5000;display:flex;gap:20px;padding:40px;background:#08131a;color:white;overflow:auto';
    document.body.append(gallery);
    for (const direction of [...Object.keys(DIRECTIONS), null]) {
      const item = document.createElement('div'); item.textContent = direction || '无方向';
      for (const [width, height] of [[118,94],[88,72]]) {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const box=document.createElement('div');box.className='selected-preview';box.style.width=`${width}px`;
        const arrow=document.createElement('span');arrow.className='pattern-direction';
        canvas.style.display = 'block'; box.append(arrow,canvas);item.append(box);
        drawPattern(canvas, [[1,0],[2,1],[0,2],[1,2],[2,2]], undefined, direction,arrow);
      }
      gallery.append(item);
    }
  });
  mkdirSync('artifacts/pattern-direction', { recursive: true });
  await page.screenshot({ path: 'artifacts/pattern-direction/previews.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: editor set/clear, rotation/mirror, selection restore, eight independent arrows; both themes at 1440/780/390px have no overlap; direction does not alter canvas pixels');
} finally { await browser?.close(); await app.close(); }
