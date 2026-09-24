import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/engine.js';
import { Game as ReferenceGame } from './reference/src/engine.js';
import { loadFixtureState } from './helpers/load-fixture.js';
import { replay } from './helpers/replay.js';
import { PerformanceMetrics, instrumentGame } from '../src/metrics.js';
const members = [{ name: 'A' }, { name: 'B' }];
test('no-deletion objectives and dormancy visit zero cells for cleanup', () => {
  const g = new Game(members, { now: () => 0 }), metrics = new PerformanceMetrics(); instrumentGame(g, metrics);
  loadFixtureState(g, [[450450, 1], [450451, 1], [451450, 1], [451451, 1]]);
  g.step();
  const rows = metrics.export().records;
  assert.equal(rows.find(r => r.name === 'objectives.cleanupVisited')?.value, 0);
  assert.equal(rows.find(r => r.name === 'dormancy.cleanupVisited')?.value, 0);
});
test('objective deletions and deferred eliminations compact in original order once', () => {
  const g = new Game(members, { now: () => 0 }), reference = new ReferenceGame(members, { now: () => 0, random: () => .42 });
  // Fix identical geometry; this operation only observes cells and core circles.
  g.nodes = structuredClone(reference.nodes);
  const cells = [[450450, 1], [180180, 2], [550550, 2], [820820, 1], [450451, 1]];
  for (const game of [g, reference]) { loadFixtureState(game, cells); game.players[0].hp = 1; }
  const metrics = new PerformanceMetrics(); instrumentGame(g, metrics); const originalNow = Date.now; Date.now = () => 0;
  try { reference.resolveObjectives(); g.resolveObjectives(); } finally { Date.now = originalNow; }
  assert.deepEqual([...g.alive], reference.alive); assert.deepEqual([...g.changes], [...reference.changes]);
  assert.deepEqual(g.players, reference.players);
  assert.equal(metrics.export().records.filter(r => r.name === 'alive.compactionVisited').length, 1);
});
test('packet encodes first-write order and final owner without materializing entries', () => {
  for (const snapshot of [false, true]) {
    const g = new Game(members), reference = new ReferenceGame(members);
    for (const game of [g, reference]) {
      loadFixtureState(game, [[999999, 2], [0, 1], [450450, 1]]);
      game.changes.set(99, 1); game.changes.set(2, 2); game.changes.set(99, 0); game.generation = 23;
    }
    assert.ok(Buffer.from(g.packet(snapshot)).equals(Buffer.from(reference.packet(snapshot))));
    const previous = Buffer.from(g.packet(snapshot)); g.changes.set(3, 1); g.packet();
    assert.ok(previous.equals(Buffer.from(reference.packet(snapshot))), 'previous result must not be overwritten');
  }
});
test('cleanup followed by dormancy remains ordered and byte-identical', () => {
  replay({ ReferenceGame, Game, generations: 35,
    cells: [[450450, 1], [450451, 1], [451450, 1], [451451, 1], [180180, 2], [180181, 2], [181180, 2], [181181, 2]],
    setup: g => { g.baseDormancyGenerations = 20; g.minDormancyGenerations = 20; g.dormancyDecayPerMinute = 0;
      g.cards.effects.push({ playerId: 1, stat: 'shield', endsAt: 500 }); } });
});
