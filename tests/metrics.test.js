import test from 'node:test';
import assert from 'node:assert/strict';
import { PerformanceMetrics, summarizeGenerations } from '../public/performance-metrics.js';
import { performanceConfig } from '../src/performance-config.js';
import { instrumentGame } from '../src/metrics.js';
import { Game } from '../src/engine.js';
import { Game as ReferenceGame } from './reference/src/engine.js';
import { replay } from './helpers/replay.js';
import { createServer } from '../src/server.js';
import { WebSocket } from 'ws';
test('trace uses bounded storage and marks incomplete exports instead of hiding lost records', () => {
  let now = 0; const metrics = new PerformanceMetrics({ capacity: 3, now: () => now++ });
  for (let i = 1; i <= 5; i++) metrics.record('computedGeneration', 0, i);
  const result = metrics.export(); assert.equal(result.droppedRecords, 2); assert.equal(result.complete, false);
  assert.deepEqual(result.records.map(r => r.generation), [3, 4, 5]);
  assert.equal(performanceConfig({}).enabled, false); assert.throws(() => performanceConfig({ LIFEWAR_TRACE: 'yes' }));
});
test('generation report exposes received but overwritten states and sequence gaps', () => {
  const records = [1,2,3].map(generation => ({ name: 'receivedGeneration', generation, stream: '', epoch: 'A' }));
  records.push({ name: 'drawnGeneration', generation: 3, stream: '', epoch: 'A' });
  assert.deepEqual(summarizeGenerations(records)['A/'].receivedButNotDrawn, [1,2]);
});
test('timed wrappers preserve full state and packet semantics', () => {
  const trace = new PerformanceMetrics();
  replay({ ReferenceGame, Game, generations: 10, setup: g => { if (g instanceof Game) instrumentGame(g, trace); } });
  for (const name of ['step.ms','expire.ms','evolution.ms','objectives.ms','dormancy.ms','dormancy.scan.ms','dormancy.remove.ms','energy.ms','packet.ms'])
    assert.ok(trace.export().records.some(r => r.name === name), name);
  assert.ok(trace.export().records.every(r => r.value >= 0));
  assert.ok(trace.export().records.every(r => r.epoch === '0'), 'inline markers must use the game epoch too');
});
test('high-change packet timing stays one bounded record, not one record per cell', () => {
  const g = new Game([{ name: 'A' }, { name: 'B' }]), trace = new PerformanceMetrics({ capacity: 8 });
  instrumentGame(g, trace);
  for (let key = 0; key < 500000; key++) g.changes.set(key, key % 3);
  assert.equal(g.packet().byteLength, 2000008);
  assert.equal(trace.export().records.filter(r => r.name === 'packet.ms').length, 1);
});
test('real WebSocket opt-in trace records compute/send; disabled server emits no debug messages', async t => {
  for (const trace of [false, true]) {
    const app = createServer({ port: 0, host: '127.0.0.1', trace }); const address = await app.listen();
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws?trace=1`); const messages = [];
    t.after(async () => { ws.terminate(); await app.close(); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No generation 3 packet')), 4000);
      ws.on('error', reject); ws.on('open', () => ws.send(JSON.stringify({ type: 'create', name: 'trace test', practice: true })));
      ws.on('message', (data, binary) => {
        if (!binary) messages.push(JSON.parse(data));
        else if (data.readUInt32LE(4) >= 3) { clearTimeout(timer); resolve(); }
      });
    });
    if (trace) {
      const report = app.performanceReport(); assert.ok(report.records.some(r => r.name === 'computedGeneration'));
      assert.ok(report.records.some(r => r.name === 'sentGeneration')); assert.ok(messages.some(m => m.type === 'performance'));
      assert.ok(!JSON.stringify(report).includes('token'));
    } else { assert.equal(app.performanceReport(), null); assert.ok(!messages.some(m => m.type === 'performance')); }
  }
});
