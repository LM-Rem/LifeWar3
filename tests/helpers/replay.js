import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { captureGame, compareGame } from './compare-game.js';
import { randomSource, loadFixtureState } from './load-fixture.js';

function observe(game, onStage) {
  const resolve = game.resolveObjectives.bind(game), update = game.dormancy.update.bind(game.dormancy);
  game.resolveObjectives = function() { onStage('evolution'); const result = resolve(); onStage('objectives'); return result; };
  game.dormancy.update = function(...args) { const result = update(...args); onStage('dormancy'); return result; };
}
function observeCommands(game) {
  const log = [];
  for (const name of ['deploy', 'playCard', 'pickCard']) {
    const original = game[name];
    game[name] = function(...args) {
      const entry = { name, generation: this.generation, args: structuredClone(args) }; log.push(entry);
      const result = original.apply(this, args); entry.result = structuredClone(result); return result;
    };
  }
  return log;
}
export function replay({ ReferenceGame, Game, seed = 91, generations = 200, members = [{ name: 'A' }, { name: 'B' }],
  cells = [], setup, operations = [], atMs = i => i * 50, referenceBots, bots, mutate,
  failureDir = 'artifacts/performance/replay-failures' }) {
  let now = 0, currentPhase = 'setup'; const originalNow = Date.now;
  const args = () => ({ random: randomSource(seed), now: () => now });
  Date.now = () => now; // Scoped, synchronous replay; restored even on failure.
  let reference, actual, previousReference, previousActual, referenceCommands, actualCommands;
  const stages = new Map(); let phaseComparisons = 0;
  try {
    reference = new ReferenceGame(members, args()); actual = new Game(members, args());
    for (const game of [reference, actual]) { loadFixtureState(game, cells); setup?.(game); }
    referenceCommands = observeCommands(reference); actualCommands = observeCommands(actual);
    compareGame(captureGame(reference, { history: true }), captureGame(actual, { history: true }), 'initial');
    observe(reference, phase => stages.set(phase, captureGame(reference)));
    observe(actual, phase => { currentPhase = phase; mutate?.(actual, phase); compareGame(stages.get(phase), captureGame(actual), phase); phaseComparisons++; });
    let packets = 0;
    for (let i = 1; i <= generations; i++) {
      now = atMs(i); currentPhase = 'commands'; stages.clear();
      previousReference = reference.board.slice(); previousActual = actual.board.slice();
      for (const op of operations.filter(op => op.generation === i).sort((a, b) => a.seq - b.seq)) {
        if (op.phase && op.phase !== 'beforeStep') throw new Error('Unsupported replay phase');
        if (op.atMs !== undefined) now = op.atMs;
        const invoke = g => {
          if (op.action === 'deploy') return g.deploy(op.playerId, op.x, op.y, op.cells);
          if (op.action === 'playCard') return g.playCard(op.playerId, op.cardId, op.x, op.y, op.instanceId);
          if (op.action === 'eliminate') return g.eliminate(op.playerId);
          if (op.action === 'pickCard') return g.pickCard(op.playerId, op.cardId);
          throw new Error(`Unsupported replay action ${op.action}`);
        };
        assert.deepEqual(invoke(actual), invoke(reference), `command ${op.seq}`);
      }
      if (referenceBots && reference.generation % 60 === 0) { referenceBots(reference); bots(actual); }
      reference.step(); actual.step(); currentPhase = 'final';
      compareGame(captureGame(reference, { history: true }), captureGame(actual, { history: true }), currentPhase);
      phaseComparisons++;
      assert.deepEqual(actualCommands, referenceCommands, 'command attempts, results and AI order');
      currentPhase = 'packet';
      assert.ok(Buffer.from(reference.packet()).equals(Buffer.from(actual.packet())), 'v1 packet byte mismatch');
      assert.ok(Buffer.from(reference.packet(true)).equals(Buffer.from(actual.packet(true))), 'snapshot byte mismatch');
      reference.changes.clear(); actual.changes.clear(); packets++;
    }
    return { seed, generations: actual.generation, comparedSteps: packets, phaseComparisons, comparedCommands: actualCommands.length, status: 'PASS' };
  } catch (error) {
    if (failureDir) {
      const dir = path.join(failureDir, `${Date.now()}-${seed}-${process.pid}-${performance.now().toFixed(3)}`); mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'failure.json'), JSON.stringify({ seed, generations, operations, initialCells: cells,
        phase: currentPhase, message: error.message, atMs: now, reference: reference && captureGame(reference).state,
        actual: actual && captureGame(actual).state, referenceCommands, actualCommands,
        referenceRandom: reference?.random.state?.(), actualRandom: actual?.random.state?.() }, null, 2));
      for (const [name, board] of Object.entries({ 'reference-before': previousReference, 'actual-before': previousActual,
        'reference-after': reference?.board, 'actual-after': actual?.board })) if (board) writeFileSync(path.join(dir, `${name}.bin`), board);
      error.message += ` (replay saved to ${dir})`;
    }
    throw error;
  } finally { Date.now = originalNow; }
}
