import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/engine.js';
import { CARDS } from '../public/cards.js';
import { runBots } from '../src/bots.js';

// 固定随机种子 + 假时钟：每 step 推进 1000ms（先推进时间再演化）
function harness(members, { times = [3000, 6000, 9000], seed = 7 } = {}) {
  let s = seed, t = 0;
  const random = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const g = new Game(members, { cardDrawTimes: times, random, now: () => t });
  const advance = n => { for (let i = 0; i < n; i++) { t += 1000; g.step(); } };
  return { g, advance };
}

test('卡池按时间：第 1/2/3 次发卡分别从 early/mid/late 池抽取', () => {
  const { g, advance } = harness([{ name: 'A' }, { name: 'B' }]);
  const pools = ['early', 'mid', 'late'];
  for (let round = 0; round < 3; round++) {
    advance(3); // 推进到下一个发卡点
    assert.ok(g.cardDraft, `第 ${round + 1} 次发卡应触发`);
    for (const e of g.cardDraft.players) {
      assert.equal(e.options.length, 3);
      assert.ok(e.options.every(c => c.pool === pools[round]), `候选应来自 ${pools[round]} 池`);
    }
    for (const e of g.cardDraft.players) {
      // 先使用上一轮卡牌，再验证本轮选择
      const old = g.cards.hand[e.playerId - 1][0];
      if (old) g.playCard(e.playerId, old.id, 0, 0);
      assert.ok(g.pickCard(e.playerId, e.options[0].id).ok, `第 ${round + 1} 轮选卡应成功`);
    }
    assert.equal(g.cardDraft, null, '全员选完后候选应清除');
  }
});

test('AI 自动参与三选一：bot 获得手牌且 draft 不被卡住', () => {
  const { g, advance } = harness([{ name: 'A' }, { name: 'BOT', bot: true }], { times: [3000, 6000] });
  advance(3); // 第一次发卡
  assert.ok(g.cardDraft);
  const botEntry = g.cardDraft.players.find(e => g.players[e.playerId - 1].bot);
  const humanEntry = g.cardDraft.players.find(e => !g.players[e.playerId - 1].bot);
  assert.ok(botEntry.picked, 'bot 应已自动选卡');
  assert.equal(g.cards.hand[1].length, 1, 'bot 应获得手牌');
  assert.equal(humanEntry.picked, false, '人类候选仍待选择');
  g.pickCard(humanEntry.playerId, humanEntry.options[0].id);
  assert.equal(g.cardDraft, null, '人类选完后 draft 应清空');
  // 第二次发卡：bot 新卡追加到已有手牌，draft 不卡住
  advance(3);
  assert.ok(g.cardDraft, '第二次发卡应正常触发');
  assert.ok(g.cards.hand[1].length >= 1, 'bot 应持有新卡');
});

test('AI 使用增益卡：立即生效并消耗手牌', () => {
  const { g } = harness([{ name: 'A' }, { name: 'BOT', bot: true }], { times: [] });
  g.cards.hand[1] = [CARDS.find(c => c.id === 'energy_burst')];
  const before = g.players[1].energy;
  runBots(g);
  // AI 用卡后还会继续部署（最多消耗一次图案的能量），净增必然为正
  assert.ok(g.players[1].energy > before, '能量卡应提升 AI 能量');
  assert.deepEqual(g.cards.hand[1], [], '使用后手牌应消耗');
});

test('AI 使用净化道具卡：以敌方基地为目标施放并消耗手牌', () => {
  const { g } = harness([{ name: 'A' }, { name: 'BOT', bot: true }], { times: [] });
  g.cards.hand[1] = [CARDS.find(c => c.id === 'purge')];
  // 在敌方基地附近放置细胞供净化命中
  const enemy = g.players[0];
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]]) {
    const key = (enemy.y + dy) * g.size + (enemy.x + dx);
    g.board[key] = 1;
    g.alive.push(key);g.rebuildDerivedState();
    g.players[0].cells++;
  }
  runBots(g);
  assert.deepEqual(g.cards.hand[1], [], '使用后手牌应消耗');
  const removed = g.alive.length === 0;
  assert.ok(removed || g.players[0].cells < 3, '目标区域细胞应被净化');
});

test('并发：两名玩家同时选卡并各自使用手牌互不冲突', () => {
  const { g, advance } = harness([{ name: 'A' }, { name: 'B' }], { times: [3000] });
  advance(3);
  const [e1, e2] = g.cardDraft.players;
  assert.ok(g.pickCard(e1.playerId, e1.options[0].id).ok);
  assert.ok(g.pickCard(e2.playerId, e2.options[1].id).ok);
  assert.equal(g.cardDraft, null);
  const c1 = g.cards.hand[0][0], c2 = g.cards.hand[1][0];
  assert.ok(c1 && c2, '两人都应持有手牌');
  assert.ok(!g.playCard(1, c1.id, 0, 0).error, '玩家1使用卡牌成功');
  assert.ok(!g.playCard(2, c2.id, 0, 0).error, '玩家2使用卡牌成功');
  assert.deepEqual(g.cards.hand[0], []);
  assert.deepEqual(g.cards.hand[1], []);
});

test('AI skips an unusable targeted card and uses at most one later card',()=>{
  const {g}=harness([{name:'A'},{name:'BOT',bot:true}]);
  g.players[1].cells=100000; // No capacity for generated cells.
  g.cards.hand[1]=['seed','repair','energy_burst'].map(id=>CARDS.find(c=>c.id===id));
  g.players[1].hp=100;
  runBots(g);
  assert.deepEqual(g.cards.hand[1].map(c=>c.id),['seed','energy_burst']);
  assert.equal(g.players[1].hp,160);
});
