import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Game } from '../src/engine.js';
import { Game as ReferenceGame } from './reference/src/engine.js';
import { runBots } from '../src/bots.js';
import { runBots as referenceBots } from './reference/src/bots.js';
import { CARDS } from '../public/cards.js';
import { replay } from './helpers/replay.js';
import { randomSource } from './helpers/load-fixture.js';
import { captureGame, compareGame } from './helpers/compare-game.js';
const block = (x, y, owner = 1) => [[x + y * 1000, owner], [x + 1 + y * 1000, owner], [x + (y + 1) * 1000, owner], [x + 1 + (y + 1) * 1000, owner]];

test('frozen working-tree oracle hashes remain unchanged', () => {
  const manifest = JSON.parse(readFileSync(new URL('./reference/manifest.json', import.meta.url)));
  const storage = JSON.parse(readFileSync(new URL('./reference/storage-manifest.json', import.meta.url)));
  for (const [file, expected] of Object.entries(manifest.files)) {
    const bytes = readFileSync(new URL(`./reference/${file}`, import.meta.url));
    const rawHash = createHash('sha256').update(bytes).digest('hex');
    if (rawHash !== expected.sha256) assert.equal(createHash('sha256').update(bytes.toString('utf8').replace(/\r\n/g, '\n')).digest('hex'), storage.files[file], `${file}: only Git newline conversion is permitted`);
  }
});
test('ordered comparator rejects equal boards with different alive or changes order', () => {
  const g = new Game([{ name: 'A' }, { name: 'B' }], { now: () => 0 });
  g.alive = [10, 20]; g.changes.set(10, 1); g.changes.set(20, 2);
  const baseline = captureGame(g), changed = captureGame(g);
  changed.alive.reverse(); assert.throws(() => compareGame(baseline, changed), /alive/);
  changed.alive.reverse(); changed.changes.reverse(); assert.throws(() => compareGame(baseline, changed), /changes/);
});
for (let seed = 1; seed <= 5; seed++) test(`deterministic four-phase replay seed ${seed}, 200 generations`, () => {
  const random = randomSource(seed), cells = [];
  for (let y = 440; y < 475; y++) for (let x = 440; x < 475; x++) if (random() < .45) cells.push([y * 1000 + x, random() < .5 ? 1 : 2]);
  replay({ ReferenceGame, Game, seed, cells, generations: 200,
    operations: [{ seq: 1, generation: 5, action: 'deploy', playerId: 1, x: 200, y: 200, cells: [[0, 0], [1, 0], [0, 1], [1, 1]] }] });
});
test('replay covers warning, exact removal, shield impacts and simultaneous eliminations', () => {
  replay({ ReferenceGame, Game, cells: [...block(450, 450), ...block(550, 550, 2)], generations: 35,
    setup: g => { g.baseDormancyGenerations = 20; g.minDormancyGenerations = 20; g.dormancyDecayPerMinute = 0; } });
  replay({ ReferenceGame, Game, cells: [...block(180, 180, 2), ...block(820, 820, 1)], generations: 3,
    setup: g => { g.players.forEach(p => p.hp = 3); } });
  replay({ ReferenceGame, Game, cells: [...block(180, 180, 2), ...block(820, 820, 1)], generations: 4,
    setup: g => { g.cards.effects.push({ playerId: 1, stat: 'shield', endsAt: 500 }); } });
});
test('replay covers card expiry, draws, 600/601-second pressure and AI commands', () => {
  replay({ ReferenceGame, Game, generations: 8, cells: block(450, 450), atMs: i => [0, 599999, 600000, 600999, 601000, 601999, 602000, 620000, 630000][i],
    setup: g => { g.players.forEach(p => p.hp = 1e9); g.nodes[0].owner = 1; g.nodeShieldPeriods.push({ playerId: 2, startsAt: 600000, endsAt: 601001 });
      g.pendingRule = { birth: new Set([3]), survival: new Set([0, 2, 3]), startsAt: 600000, seconds: 1, playerId: 1, name: 'fixture' }; } });
  replay({ ReferenceGame, Game, generations: 125, members: [{ name: 'A', bot: true }, { name: 'B', bot: true }], referenceBots, bots: runBots });
  const purge = CARDS.find(c => c.effect.kind === 'purge');
  replay({ ReferenceGame, Game, generations: 10, cells: block(450, 450), setup: g => g.cards.hand[0].push(g.acquireCard(purge)),
    operations: [{ seq: 1, generation: 2, action: 'playCard', playerId: 1, cardId: purge.id, x: 450, y: 450 }] });
});
test('replay identifies first phase and preserves real clock after deliberate corruption', () => {
  const clock = Date.now;
  assert.throws(() => replay({ ReferenceGame, Game, generations: 1, failureDir: null,
    mutate: (g, phase) => { if (phase === 'evolution') g.board[0] = 1; } }), /evolution.board\[0\]/);
  assert.equal(Date.now, clock);
  assert.throws(() => replay({ ReferenceGame, Game, generations: 1, failureDir: null,
    mutate: (g, phase) => { if (phase === 'dormancy') g.dormancy.snapshots[0][0] = 1; } }), /snapshots/);
});
test('AI targeted search with more than 64 enemies preserves every attempted command', () => {
  const purge = CARDS.find(c => c.effect.kind === 'purge'), cells = [];
  for (let y = 430; y < 490; y += 8) for (let x = 430; x < 490; x += 8) cells.push(...block(x, y, 2));
  const result = replay({ ReferenceGame, Game, cells, generations: 65, members: [{ name: 'A', bot: true }, { name: 'B', bot: true }],
    referenceBots, bots: runBots, setup: g => g.cards.hand[0].push(g.acquireCard(purge)) });
  assert.ok(result.comparedCommands > 0);
});
test('incorrect generation-dependent tie vote is localized to evolution', () => {
  assert.throws(() => replay({ ReferenceGame, Game, generations: 1, cells: [[450450, 1], [450452, 2]],
    setup: g => { g.birthRule = new Set([2]); }, failureDir: null,
    mutate: (g, phase) => { if (phase === 'evolution') g.board[450451] = g.board[450451] === 1 ? 2 : 1; } }), /evolution.board\[450451\]/);
});
