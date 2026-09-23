import assert from 'node:assert/strict';
export function captureGame(game, { history = false } = {}) {
  const result = { board: game.board.slice(), alive: [...game.alive], changes: [...game.changes],
    state: structuredClone(game.state()), random: game.random.state?.(),
    internal: structuredClone({ generation: game.generation, startedAt: game.startedAt, birthRule: game.birthRule,
      survivalRule: game.survivalRule, cardDrawTimes: game.cardDrawTimes, cardSerial: game.cardSerial,
      drawCount: game.drawCount, nodeDamageTick: game.nodeDamageTick, nodeShieldPeriods: game.nodeShieldPeriods }) };
  if (history) result.dormancy = Object.fromEntries(Object.entries(game.dormancy).filter(([key, value]) => key !== 'metrics' && typeof value !== 'function').map(([key, value]) => [key, structuredClone(value)]));
  return result;
}
function compareValue(expected, actual, field) {
  if (ArrayBuffer.isView(expected)) {
    assert.equal(actual?.constructor, expected.constructor, `${field} type`);
    const a = Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength);
    const b = Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength);
    if (!a.equals(b)) {
      let key = 0; while (key < Math.min(expected.length, actual.length) && expected[key] === actual[key]) key++;
      throw new Error(`${field}[${key}]: expected ${expected[key]}, actual ${actual[key]}`);
    }
  } else if (Array.isArray(expected) && expected.some(ArrayBuffer.isView)) {
    assert.equal(actual.length, expected.length, field); expected.forEach((v, i) => compareValue(v, actual[i], `${field}[${i}]`));
  } else assert.deepEqual(actual, expected, field);
}
export function compareGame(expected, actual, phase = 'final') {
  for (const key of ['board', 'alive', 'changes', 'state', 'random', 'internal']) compareValue(expected[key], actual[key], `${phase}.${key}`);
  if (expected.dormancy) for (const [key, value] of Object.entries(expected.dormancy)) compareValue(value, actual.dormancy[key], `${phase}.dormancy.${key}`);
}
