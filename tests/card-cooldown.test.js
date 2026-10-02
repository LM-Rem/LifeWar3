import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/engine.js';
import { CARDS } from '../public/cards.js';
import { runBots } from '../src/bots.js';

const card = id => CARDS.find(c => c.id === id);
function setup(bot = false) {
  let now = 0;
  const g = new Game([{name:'A',bot},{name:'B'}], {now:()=>now,cardDrawTimes:[]});
  return {g, clock:t=>{now=t;}};
}

test('successful cards share a ten-second wall-time cooldown per player, including duplicate instances', () => {
  const {g,clock} = setup();
  g.cards.hand[0] = ['energy_burst','purge','great_flood','energy_burst'].map(id=>g.acquireCard(card(id)));
  g.cards.hand[1] = [card('repair')];
  const first = g.cards.hand[0][0];
  const result = g.playCard(1,first.id,undefined,undefined,first.instanceId);
  assert.equal(result.cooldownEndsAt,10000);
  assert.equal(g.state(1).cards.cooldownEndsAt,10000);
  assert.equal(g.state(2).cards.cooldownEndsAt,0);
  const before = structuredClone(g.cards.hand[0]);
  for (const c of before) assert.match(g.playCard(1,c.id,400,400,c.instanceId).error,/冷却/);
  assert.deepEqual(g.cards.hand[0],before);
  assert.equal(g.pendingRule,null);
  assert.equal(g.alive.length,0);
  assert.ok(g.playCard(2,'repair').ok,'opponents can use their own cards');
  g.generation += 100000;
  clock(9999);
  assert.match(g.playCard(1,'purge',400,400).error,/冷却/);
  assert.equal(g.state(1).cards.cooldownEndsAt,10000,'rejected uses do not extend cooldown');
  clock(10000);
  assert.ok(g.playCard(1,'purge',400,400).ok);
  assert.equal(g.state(1).cards.cooldownEndsAt,20000);
  clock(20000);
  assert.ok(g.playCard(1,'great_flood').ok);
  assert.equal(g.pendingRule.startsAt,21000);
  assert.equal(g.state(1).cards.cooldownEndsAt,30000,'laws start cooldown at acceptance, before warning ends');
});

test('failed card validation preserves cards, effects and cooldown readiness', () => {
  const {g} = setup();
  g.cards.hand[0] = [card('seed'),card('purge')];
  assert.match(g.playCard(1,'purge',-1,400).error,/目标/);
  assert.ok(g.playCard(1,'seed',820,820).error);
  assert.equal(g.state(1).cards.cooldownEndsAt,0);
  assert.equal(g.cards.hand[0].length,2);
  assert.equal(g.alive.length,0);
  assert.ok(g.playCard(1,'purge',400,400).ok,'valid retry can succeed immediately');
});

test('AI obeys the same cooldown and retains its remaining hand until expiry', () => {
  const {g,clock} = setup(true);
  g.cards.hand[0] = [card('energy_burst'),card('repair')];
  runBots(g);
  assert.equal(g.cards.hand[0].length,1);
  runBots(g);
  assert.equal(g.cards.hand[0].length,1);
  clock(9999);runBots(g);assert.equal(g.cards.hand[0].length,1);
  clock(10000);runBots(g);assert.equal(g.cards.hand[0].length,0);
});
