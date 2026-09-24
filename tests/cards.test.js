import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, CARDS } from '../src/engine.js';

const game = (n = 2) => new Game(Array.from({ length: n }, (_, i) => ({ name: 'P' + (i + 1) })));
function seed(g, cells, owner = 1) {
  for (const [x, y] of cells) {
    const key = y * 1000 + x;
    g.board[key] = owner;
    g.alive.push(key);g.rebuildDerivedState();
    g.players[owner - 1].cells++;
  }
}
const card = id => CARDS.find(c => c.id === id);

test('法则卡：临时覆盖全局规则，到期后恢复默认 B3/S23', () => {
  let now = 0;
  const g = new Game([{name:'A'},{name:'B'}], { now: () => now });
  seed(g, [[400, 400]]);
  g.cards.hand[0] = [card('great_flood')];
  assert.ok(g.playCard(1, 'great_flood').ok);
  assert.ok(g.pendingRule);
  assert.equal(g.ruleOverride, null);
  now = g.pendingRule.startsAt;
  g.step();
  // B3/S-all retains even an isolated cell, without inventing B0/B1 births.
  assert.equal(g.board[400 * 1000 + 400], 1);
  assert.equal(g.alive.length, 1);
  // 法则到期后恢复默认规则
  now = g.ruleOverride.endsAt;
  g.step();
  assert.equal(g.ruleOverride, null);
  assert.equal(g.alive.length, 0);
});

test('发卡时间点：按真实时间到达后为所有存活玩家生成三选一', () => {
  let s = 7, t = 0; // 假时钟：从 0 开始，每 step 一次推进 1000ms
  const rng = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const g = new Game([{ name: 'A' }, { name: 'B' }], { cardDrawTimes: [3000, 6000], random: rng, now: () => t });
  // 先推进时间再演化，模拟真实时钟：时间流逝后 step 检查到达到发卡点
  for (let i = 0; i < 2; i++) { t += 1000; g.step(); }
  assert.equal(g.cardDraft, null); // 2000ms 未到发卡点
  t += 1000; g.step(); // 3000ms 到达
  assert.ok(g.cardDraft);
  assert.equal(g.cardDraft.players.length, 2);
  for (const entry of g.cardDraft.players) {
    assert.equal(entry.options.length, 3);
    assert.equal(new Set(entry.options.map(c => c.id)).size, 3); // 三张不重复
  }
  // 同一时间点不重复触发（draft 未清空时不会再次发卡）
  t += 1000; g.step();
  assert.equal(g.cardDraft.players.length, 2);
});

test('三选一：选卡加入手牌、重复选被拒、全员选完清除候选', () => {
  let s = 11, t = 0;
  const rng = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const g = new Game([{ name: 'A' }, { name: 'B' }], { cardDrawTimes: [3000], random: rng, now: () => t });
  for (let i = 0; i < 3; i++) { t += 1000; g.step(); } // 3000ms 触发发卡
  const [p1, p2] = g.cardDraft.players;
  const c1 = p1.options[0].id;
  assert.ok(g.pickCard(p1.playerId, c1).ok);
  assert.equal(g.cards.hand[0][0].id, c1);
  assert.ok(g.pickCard(p1.playerId, c1).error); // 已选择过
  assert.ok(g.cardDraft); // 还有玩家未选
  assert.ok(g.pickCard(p2.playerId, p2.options[1].id).ok);
  assert.equal(g.cardDraft, null); // 全员选完
});

test('多张手牌：主动选择新卡会追加而不替换旧卡', () => {
  let s = 21, t = 0;
  const rng = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const g = new Game([{ name: 'A' }, { name: 'B' }], { cardDrawTimes: [3000, 6000], random: rng, now: () => t });
  for (let i = 0; i < 3; i++) { t += 1000; g.step(); } // 3000ms 第一次发卡
  const [p1, p2] = g.cardDraft.players;
  assert.ok(g.pickCard(p1.playerId, p1.options[0].id).ok);
  assert.ok(g.pickCard(p2.playerId, p2.options[0].id).ok);
  assert.equal(g.cardDraft, null);
  // 第二次发卡：从 3000ms 推进到 6000ms
  for (let i = 0; i < 3; i++) { t += 1000; g.step(); }
  assert.ok(g.cardDraft);
  const np1 = g.cardDraft.players.find(d => d.playerId === 1);
  assert.ok(g.pickCard(1, np1.options[0].id).ok);
  assert.equal(g.cards.hand[0].length, 2);
  assert.equal(g.cards.hand[0][1].id, np1.options[0].id);
});

test('增益卡：能量爆发增加能量且不超过上限，使用后消耗手牌', () => {
  const g = game();
  const p = g.players[0];
  g.cards.hand[0] = [card('energy_burst')];
  assert.ok(g.playCard(1, 'energy_burst').ok);
  assert.equal(p.energy, 180); // 120 + 60 = 180 达到上限
  assert.deepEqual(g.cards.hand[0], []); // 使用后消耗
  g.cards.hand[0] = [card('energy_burst')];
  p.energy = 0;
  assert.ok(g.playCard(1, 'energy_burst').ok);
  assert.equal(p.energy, 63);
});

test('道具卡：净化清除指定半径内细胞、保留半径外细胞并同步休眠', () => {
  const g = game();
  seed(g, [[400, 400], [401, 400], [400, 401], [401, 401]], 1); // 目标 block
  seed(g, [[500, 500]], 2); // 半径外细胞
  g.cards.hand[0] = [card('purge')];
  assert.ok(g.playCard(1, 'purge', 401, 401).ok);
  assert.equal(g.board[400 * 1000 + 400], 0);
  assert.equal(g.players[0].cells, 0);
  assert.equal(g.board[500 * 1000 + 500], 2); // 远处保留
  assert.equal(g.players[1].cells, 1);
  assert.deepEqual(g.cards.hand[0], []);
});


test('unlimited repeated cards accumulate across drafts and consume exactly one successful copy',()=>{
  let now=0;
  const g=new Game([{name:'A'},{name:'B'}],{now:()=>now,cardDrawTimes:Array.from({length:12},(_,i)=>(i+1)*1000),random:()=>0});
  for(let round=1;round<=12;round++){
    now=round*1000;g.checkCardDraw();
    const entry=g.cardDraft.players[0];
    assert.ok(g.pickCard(1,entry.options[2].id).ok);
    g.finishDraft();
  }
  assert.equal(g.cards.hand[0].length,12);
  const id=g.cards.hand[0][2].id;
  const copies=g.cards.hand[0].filter(c=>c.id===id).length;
  assert.ok(copies>1);
  assert.ok(g.playCard(1,id,-1,0).error);
  assert.equal(g.cards.hand[0].length,12);
  assert.ok(g.playCard(1,id,400,400).ok);
  assert.equal(g.cards.hand[0].length,11);
  assert.equal(g.cards.hand[0].filter(c=>c.id===id).length,copies-1);
  g.eliminate(1);assert.deepEqual(g.cards.hand[0],[]);
});
