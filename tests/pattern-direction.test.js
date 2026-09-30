import test from 'node:test';
import assert from 'node:assert/strict';
import { DIRECTIONS, normalizeDirection, transformDirection, transform } from '../public/patterns.js';
import { createServer } from '../src/server.js';

test('directions accept eight values and empty metadata, rejecting other input', () => {
  for (const value of [null, undefined, '']) assert.equal(normalizeDirection(value), null);
  for (const value of Object.keys(DIRECTIONS)) assert.equal(normalizeDirection(value), value);
  for (const value of ['东北', '右上 ', 'toString', [], {}, 1, false]) assert.throws(() => normalizeDirection(value));
});

test('all eight directions follow cell transforms for every rotation and mirror combination', () => {
  for (const [direction, [dx, dy]] of Object.entries(DIRECTIONS)) {
    for (const flip of [false, true]) for (let rotation = 0; rotation < 4; rotation++) {
      const [origin, tip] = transform([[2, 2], [2 + dx, 2 + dy]], rotation, flip);
      const actual = DIRECTIONS[transformDirection(direction, rotation, flip)];
      assert.deepEqual(actual, [tip[0] - origin[0], tip[1] - origin[1]]);
      assert.equal(transformDirection(null, rotation, flip), null);
    }
  }
  assert.equal(transformDirection('右上', 1, true), '右上');
  assert.equal(transformDirection('上', 4), '上');
});

test('pattern API rejects invalid directions without writing pattern data', async t => {
  const app = createServer({ port: 0, host: '127.0.0.1' });
  const { port } = await app.listen(); t.after(() => app.close());
  for (const action of ['create', 'update']) {
    const response = await fetch(`http://127.0.0.1:${port}/api/patterns`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, name: 'invalid', cells: [[0, 0]], direction: '东北' }),
    });
    assert.equal(response.status, 400);
    assert.match(await response.json(), /方向/);
  }
});
