import test from 'node:test';
import assert from 'node:assert/strict';
import { rates, percentile } from './performance/statistics.mjs';
test('100 generations at 20 Hz are five simulated seconds, distinct from wall throughput', () => {
  assert.deepEqual(rates(1000, 100, 20, 2000), { simulatedBytesPerSecond: 200, wallBytesPerSecond: 500 });
  assert.equal(percentile([4, 1, 3, 2], .95), 4);
});
