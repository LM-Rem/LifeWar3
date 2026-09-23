import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, RULES } from '../src/engine.js';
import { CARDS, CARD_CONFIG, validateCardConfig } from '../public/cards.js';
import { adjacentNeutralTerritories } from '../public/territory.js';
import { runBots } from '../src/bots.js';

function setup(members = [{name:'A'},{name:'B'}]) {
  let time = 0, seed = 71;
  // Lifecycle tests use a fixed fixture, independent of the editable production schedule.
  const g = new Game(members, { cardDrawTimes:[180000,300000,420000], now:()=>time, random:()=>((seed=seed*16807%2147483647)/2147483647) });
  return {g, clock: t=>{time=t;}, play:(id,player=1,x,y)=>{
    g.cards.hand[player-1] = [CARDS.find(c=>c.id===id)];
    return g.playCard(player,id,x,y);
  }};
}
function seed(g, x, y, owner=1) {
  const key=y*g.size+x;
  if (!g.board[key]) { g.board[key]=owner;g.alive.push(key);g.players[owner-1].cells++; }
}
const block=(g,x,y,owner=1)=>{for(const [dx,dy] of [[0,0],[1,0],[0,1],[1,1]])seed(g,x+dx,y+dy,owner);};

test('catalog rejects duplicate IDs, B0, missing category, invalid buffs and target sizes',()=>{
  assert.equal(CARDS.length,26);
  for(const mutate of [d=>d.cards.push(d.cards[0]),d=>d.cards[0].effect.birth.push(0),d=>{d.cards=d.cards.filter(c=>c.type!=='item');},d=>{d.cards.find(c=>c.id==='growth').effect.amount=-1;},d=>{d.cards.find(c=>c.id==='purge').effect.radius=NaN;}]){
    const d=structuredClone(CARD_CONFIG);mutate(d);assert.throws(()=>validateCardConfig(d));
  }
});

test('editable schedule supports any round count and drives default games without changing the catalog',()=>{
  const original = CARD_CONFIG.drawSeconds;
  try {
    for (const schedule of [[], [1], [1, 61], [1, 61, 121, 181, 4001]]) {
      const config = structuredClone(CARD_CONFIG);
      config.drawSeconds = schedule;
      validateCardConfig(config);
      CARD_CONFIG.drawSeconds = schedule;
      let now = 5000;
      const g = new Game([{name:'A'},{name:'B'}], {now:()=>now, random:()=>0.5});
      assert.deepEqual(g.cardDrawTimes, schedule.map(s=>s*1000));
      for (let i=0;i<schedule.length;i++) {
        now = g.startedAt + schedule[i]*1000 - 1;
        g.checkCardDraw();
        assert.equal(g.drawCount,i);
        assert.equal(g.state(1).nextCardAt,now+1);
        now++;
        g.checkCardDraw();
        assert.equal(g.cardDraft.round,i+1);
        assert.ok(g.cardDraft.players.every(p=>p.options.every(c=>c.pool===['early','mid','late'][Math.min(i,2)])));
        g.finishDraft();
      }
      assert.equal(g.state(1).nextCardAt,null);
      now+=100000;g.checkCardDraw();assert.equal(g.drawCount,schedule.length);
      assert.deepEqual(CARD_CONFIG.drawSeconds,schedule);
    }
  } finally { CARD_CONFIG.drawSeconds=original; }
  for(const schedule of [[0],[-1],[NaN],[Infinity],['60'],[60,60],[120,60],null]) {
    const config=structuredClone(CARD_CONFIG);config.drawSeconds=schedule;
    assert.throws(()=>validateCardConfig(config));
  }
});

test('three real-time rounds offer one card of each type, even with a constant random source',()=>{
  const {g,clock}=setup();g.random=()=>0;
  clock(179999);g.checkCardDraw();assert.equal(g.cardDraft,null);
  for(const time of [180000,300000,420000]){
    clock(time);g.checkCardDraw();
    assert.deepEqual(g.cardDraft.players[0].options.map(c=>c.type),['law','buff','item']);
    assert.equal(g.cardDraft.players[0].options.length,3);
  }
  assert.equal(g.drawCount,3);
});

test('draft expiry auto-picks a buff for an empty hand, adds to an existing hand, and elimination cannot block rounds',()=>{
  const {g,clock}=setup([{name:'A'},{name:'B'},{name:'C'}]);
  g.cards.hand[0]=[CARDS.find(c=>c.id==='purge')];
  clock(180000);g.checkCardDraw();g.eliminate(3);
  assert.equal(g.cardDraft.players.length,2);
  assert.ok(g.pickCard(3,'energy_burst').error);
  clock(210000);g.checkCardDraw();
  assert.equal(g.cardDraft,null);assert.equal(g.cards.hand[0][0].id,'purge');assert.equal(g.cards.hand[0].length,2);assert.equal(g.cards.hand[1][0].type,'buff');
  assert.ok(g.pickCard(2,'energy_burst').error);
  clock(300000);g.checkCardDraw();assert.equal(g.cardDraft.round,2);
});

test('all-bot drafts resolve without dereferencing a cleared draft',()=>{
  const {g,clock}=setup([{name:'A',bot:true},{name:'B',bot:true}]);
  clock(180000);g.checkCardDraw();assert.equal(g.cardDraft,null);assert.ok(g.cards.hand.every(Boolean));
});

test('law warning, replacement and expiry use wall time rather than tick count',()=>{
  const {g,clock,play}=setup();
  play('great_flood');assert.equal(g.ruleOverride,null);assert.ok(g.pendingRule);
  for(let i=0;i<20;i++)g.step();assert.equal(g.ruleOverride,null);
  clock(1000);g.step();assert.equal(g.ruleOverride.cardId,'great_flood');
  play('collapse',2);assert.equal(g.ruleOverride.cardId,'great_flood');
  clock(2000);g.step();assert.equal(g.ruleOverride.cardId,'collapse');
  clock(8000);g.step();assert.equal(g.ruleOverride,null);assert.equal(g.pendingRule,null);
});

test('every law obeys its B/S truth table for all nonzero neighbor counts',()=>{
  for(const card of CARDS.filter(c=>c.type==='law')) for(let n=0;n<=8;n++){
    const {g,clock,play}=setup();
    const around=[[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
    seed(g,300,300);for(const [dx,dy] of around.slice(0,n)){seed(g,300+dx,300+dy);seed(g,600+dx,600+dy);}
    play(card.id);clock(1000);g.step();
    assert.equal(!!g.board[300*1000+300],card.effect.survival.includes(n),`${card.id} S${n}`);
    assert.equal(!!g.board[600*1000+600],card.effect.birth.includes(n),`${card.id} B${n}`);
    assert.ok(g.alive.every(k=>g.board[k]>=1&&g.board[k]<=2));
  }
});

test('local rule overrides global survival only inside its circle and expires',()=>{
  const {g,clock,play}=setup();block(g,400,400);block(g,600,600);
  play('great_flood');clock(1000);g.step();play('corrosion',1,400,400);g.step();
  assert.equal(g.board[400400],0);assert.equal(g.board[600600],1);
  assert.equal(g.state().localRules[0].birth.length,0);
  clock(6000);g.step();assert.equal(g.localRules.length,0);
});

test('energy refill uses the current cap; overload expires; same stat refreshes without stacking',()=>{
  const {g,clock,play}=setup();play('energy_overload');assert.equal(g.players[0].energy,RULES.maxEnergy+60);
  play('energy_overload');assert.equal(g.energyCap(1),RULES.maxEnergy+60);
  g.players[0].energy=1;play('energy_full');assert.equal(g.players[0].energy,g.energyCap(1));
  clock(20000);g.step();assert.equal(g.players[0].energy,RULES.maxEnergy);assert.equal(g.cards.effects.length,0);
});

test('overclock doubles base and node regen only for the owner',()=>{
  const {g,play}=setup();g.players[0].energy=0;g.players[1].energy=0;g.nodes[0].owner=1;
  play('overclock');g.step();assert.equal(g.players[0].energy,(RULES.regen+RULES.nodeRegen)*2);assert.equal(g.players[1].energy,RULES.regen);
});

test('free deploy bypasses cooldown once, invalid attempts retain it; discount rounds up',()=>{
  const {g,play}=setup();assert.ok(g.deploy(1,200,200,[[0,0]]).ok);
  play('flash_deploy');g.players[0].energy=0;
  assert.ok(g.deploy(1,-1,200,[[0,0]]).error);assert.ok(g.buff(1,'freeDeploy'));
  assert.equal(g.deploy(1,210,210,[[0,0]]).cost,0);assert.equal(g.buff(1,'freeDeploy'),undefined);
  assert.ok(g.deploy(1,220,220,[[0,0]]).error);
  g.step();g.players[0].energy=100;play('engineering');assert.equal(g.deploy(1,220,220,[[0,0],[1,0],[2,0]]).cost,2);
});

test('border drop only unlocks adjacent neutral node territories and is consumed on successful crossing',()=>{
  const {g,play}=setup();const regions=adjacentNeutralTerritories(g.territories,g.players,g.nodes,1);
  assert.ok(regions.length);const target=regions[0];
  assert.ok(g.deploy(1,target.x,target.y,[[0,0]]).error);
  play('border_drop');assert.ok(g.deploy(1,820,820,[[0,0]]).error);assert.ok(g.buff(1,'neutralDeploy'));
  assert.ok(g.deploy(1,target.x,target.y,[[0,0]]).ok);assert.equal(g.buff(1,'neutralDeploy'),undefined);
  assert.equal(g.nodes[target.id].owner,0,'deployment does not directly capture the territory');
});

test('capture boost doubles progress; fortify requires established claim and continued presence',()=>{
  const {g,play}=setup();const n=g.nodes[0];seed(g,n.x,n.y);play('rapid_capture');g.resolveObjectives();assert.equal(n.progress,2);
  seed(g,n.x+3,n.y,2);g.resolveObjectives();assert.equal(n.progress,2);
  play('fortify');g.resolveObjectives();assert.equal(n.progress,4);
  g.board[n.y*g.size+n.x]=0;g.resolveObjectives();assert.equal(n.claimant,2);assert.equal(n.progress,1);
});

test('shield consumes hostile contact without damage and repair caps HP without resurrection',()=>{
  const {g,clock,play}=setup();const p=g.players[0];p.hp=1;play('shield');seed(g,p.x,p.y,2);g.resolveObjectives();assert.equal(p.hp,1);assert.equal(g.players[1].cells,0);
  play('repair');assert.equal(p.hp,Math.min(RULES.baseHP,61));play('repair');assert.ok(p.hp<=RULES.baseHP);
  clock(8000);seed(g,p.x,p.y,2);const before=p.hp;g.resolveObjectives();assert.equal(p.hp,before-1);
  g.eliminate(1);assert.ok(play('repair').error);
});

test('capacity expiry preserves surviving cells and rejects new deployments',()=>{
  const {g,clock,play}=setup();play('growth');
  for(let y=350;y<600;y+=4)for(let x=350;x<450;x+=4)block(g,x,y);
  assert.ok(g.alive.length>RULES.playerCells);g.step();const count=g.alive.length;
  clock(45000);g.step();assert.equal(g.alive.length,count);assert.equal(g.playerCapacity(1),RULES.playerCells);
  assert.ok(g.deploy(1,200,200,[[0,0]]).error);
});

test('entropy protects only own dormant structures; explicit purge still removes them',()=>{
  const {g,play}=setup();g.baseDormancyGenerations=3;g.minDormancyGenerations=3;block(g,400,400);block(g,600,600,2);play('entropy');
  for(let i=0;i<8;i++)g.step();assert.equal(g.players[0].cells,4);assert.equal(g.players[1].cells,0);
  play('purge',2,400,400);assert.equal(g.players[0].cells,0);
});

test('target validation is atomic for every item; generation respects collision, capacity and protected cores',()=>{
  for(const card of CARDS.filter(c=>c.type==='item')) {
    const {g,play}=setup();for(const [x,y] of [[-1,100],[1000,100],[NaN,100],[1.5,100],[100,undefined]]) {
      assert.ok(play(card.id,1,x,y).error,card.id);assert.equal(g.cards.hand[0][0].id,card.id);assert.equal(g.alive.length,0);
    }
  }
  const {g,play}=setup();assert.ok(play('seed',1,820,820).error);assert.ok(play('nebula',1,820,820).error);
  assert.ok(play('seed',1,500,500).ok);const count=g.alive.length;
  assert.ok(play('seed',1,500,500).error);assert.equal(g.alive.length,count);
  g.players[0].cells=g.playerCapacity(1);assert.ok(play('nebula',1,600,600).error);assert.equal(g.alive.length,count);
});

test('seed, nebula and purge changes reconstruct the authoritative board exactly',()=>{
  const {g,play}=setup();const board=new Uint8Array(g.board.length);
  for(const [id,x,y] of [['seed',500,500],['nebula',600,600],['purge_huge',500,500]]) {
    g.changes.clear();assert.ok(play(id,1,x,y).ok);
    const data=new DataView(g.packet());for(let i=8;i<data.byteLength;i+=4){const v=data.getUint32(i,true);board[v%1000000]=Math.floor(v/1000000);}
    assert.deepEqual(board,g.board);assert.equal(g.players[0].cells,g.alive.length);
  }
});

test('player snapshots hide opponents hands and draft options but retain public active effects',()=>{
  const {g,clock,play}=setup();clock(180000);g.checkCardDraw();play('shield',2);g.cards.hand[1]=[CARDS[0]];
  const s=g.state(1);assert.equal(s.cards.hand[1],null);assert.deepEqual(s.cardDraft.players.map(e=>e.playerId),[1]);assert.equal(s.cards.effects[0].playerId,2);
});

test('AI can activate every catalog card without bypassing authoritative validation',()=>{
  for(const card of CARDS) {
    const {g}=setup([{name:'A'},{name:'BOT',bot:true}]);g.cards.hand[1]=[card];
    runBots(g);assert.deepEqual(g.cards.hand[1], [],card.id);
  }
});
