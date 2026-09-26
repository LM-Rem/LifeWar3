// Uses an existing Playwright installation; never installs or downloads a browser.
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const { values } = parseArgs({ options: { playwright: { type: 'string' }, executable: { type: 'string' }, output: { type: 'string', default: 'artifacts/performance/browser-smoke' } } });
const { chromium } = createRequire(import.meta.url)(values.playwright || 'playwright');
process.env.LIFEWAR_CONFIG_PATH = fileURLToPath(new URL('../fixtures/performance/production-20hz.json', import.meta.url));
const { createServer } = await import('../../src/server.js');
const { createServer: referenceServer } = await import('../reference/src/server.js');
const { Game } = await import('../reference/src/engine.js');
const { loadFixtureState, randomSource } = await import('../helpers/load-fixture.js');
const app = createServer({ port: 0, host: '127.0.0.1', trace: true });
const oracle = referenceServer({ port: 0, host: '127.0.0.1' });
let browser;
try {
  const a = await app.listen(), b = await oracle.listen();
  browser = await chromium.launch({ headless: true, ...(values.executable ? { executablePath: values.executable } : { channel: 'chrome' }) });
  mkdirSync(values.output, { recursive: true });
  const errors = [], page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${a.port}/`); await page.locator('#practice').waitFor();
  assert.equal(await page.evaluate(() => typeof window.lifeWarPerformance), 'undefined');
  await page.goto(`http://127.0.0.1:${a.port}/?trace=1`); await page.locator('#practice').click();
  await page.waitForFunction(() => window.lifeWarPerformance?.export().records.some(r => r.name === 'drawnGeneration' && r.generation >= 12));
  const trace = await page.evaluate(() => window.lifeWarPerformance.export());
  for (const name of ['computedGeneration','sentGeneration','receivedGeneration','appliedGeneration','drawnGeneration']) assert.ok(trace.records.some(r => r.name === name), name);
  writeFileSync(`${values.output}/client-trace.json`, JSON.stringify(trace, null, 2));
  writeFileSync(`${values.output}/server-trace.json`, JSON.stringify(app.performanceReport(), null, 2));
  await page.close();
  const game = new Game([{ name: 'A' }, { name: 'B' }], { now: () => 0, random: randomSource(91) });
  const cells = []; for (let y = 430; y < 510; y++) for (let x = 430; x < 510; x++) if ((x + y) % 3) cells.push([y * 1000 + x, x % 2 + 1]);
  loadFixtureState(game, cells); const fixture = { state: game.state(), packet: [...new Uint8Array(game.packet(true))] };
  const images = [];
  for (const [label, port] of [['reference', b.port], ['current', a.port]]) {
    const view = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 }); view.on('pageerror', e => errors.push(e.message));
    await view.goto(`http://127.0.0.1:${port}/`);
    const result = await view.evaluate(async fixture => {
      const { Battlefield } = await import('/renderer.js');
      const canvas = document.createElement('canvas'), mini = document.createElement('canvas');
      canvas.style.cssText = 'width:800px;height:600px'; mini.width = mini.height = 180;
      document.body.append(canvas, mini);
      const field = new Battlefield(canvas, mini, { grid: true, ranges: true, motion: true });
      field.setState(fixture.state); field.updatePacket(new Uint8Array(fixture.packet).buffer);
      field.camera = { x: 475.25, y: 475.75, zoom: 3.5 }; field.draw(1000); field.drawMinimap();
      return { main: canvas.toDataURL(), mini: mini.toDataURL() };
    }, fixture);
    images.push(result);
    for (const [kind, data] of Object.entries(result)) writeFileSync(`${values.output}/${label}-${kind}.png`, Buffer.from(data.split(',')[1], 'base64'));
    await view.close();
  }
  assert.equal(images[1].main, images[0].main, 'fixed-time main pixels must match frozen renderer');
  // Minimap intentionally uses approximate texture downsampling. Its spatial
  // color assertions and dense-load benchmark live in overview-performance.mjs.
  assert.deepEqual(errors, [], 'browser exceptions');
  const result = { status: 'PASS', browser: browser.version(), traceSequences: 5, fixedTimePixelComparison: 'main byte-identical PNG; minimap approximation tested separately',
    scope: 'headless desktop smoke, not frame-rate certification or physical presentation', pageErrors: errors };
  writeFileSync(`${values.output}/summary.json`, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await browser?.close(); await app.close(); await oracle.close(); }
