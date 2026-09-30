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
  await page.locator('#library-add').click();
  await page.waitForResponse('**/api/patterns');
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
  // Show all eight glyphs at the production preview sizes for visual review.
  await page.evaluate(async () => {
    const { drawPattern } = await import('/renderer.js');
    const { DIRECTIONS } = await import('/patterns.js');
    document.body.innerHTML = '<main style="display:flex;gap:20px;padding:40px;background:#08131a;color:white"></main>';
    for (const direction of [...Object.keys(DIRECTIONS), null]) {
      const item = document.createElement('div'); item.textContent = direction || '无方向';
      for (const [width, height] of [[118,94],[88,72]]) {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        canvas.style.display = 'block'; item.append(canvas);
        drawPattern(canvas, [[1,0],[2,1],[0,2],[1,2],[2,2]], undefined, direction);
      }
      document.querySelector('main').append(item);
    }
  });
  mkdirSync('artifacts/pattern-direction', { recursive: true });
  await page.screenshot({ path: 'artifacts/pattern-direction/previews.png' });
  assert.deepEqual(errors, []);
  console.log('PASS: editor set/clear, empty compatibility, rotation/mirror, selection restore, eight preview glyphs');
} finally { await browser?.close(); await app.close(); }
