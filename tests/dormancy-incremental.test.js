import test from 'node:test';
import assert from 'node:assert/strict';
import { RegionalCycleDetector } from '../src/dormancy.js';
import { RegionalCycleDetector as Legacy } from './reference/src/dormancy.js';
import { randomSource } from './helpers/load-fixture.js';
function equal(a,b) {
  for(const key of ['hash1','hash2','count','history1','history2','historyCount','period','age']) assert.ok(Buffer.from(a[key].buffer).equals(Buffer.from(b[key].buffer)),key);
  for(let i=0;i<a.snapshots.length;i++)assert.ok(Buffer.from(a.snapshots[i].buffer).equals(Buffer.from(b.snapshots[i].buffer)),`snapshot ${i}`);
  assert.equal(a.tick,b.tick);
}
test('10000 generations incremental fingerprints and all history equal frozen full scan', () => {
  const size=1000, a=new RegionalCycleDetector(size),b=new Legacy(size),random=randomSource(17);
  const g={board:new Uint8Array(size*size),alive:new Set()};
  for(let gen=0;gen<10000;gen++) {
    a.mode=gen%197===0?'legacy':'incremental';a.dirty ||= gen%197<2;
    for(let j=0;j<12;j++) { const key=(Math.floor(random()*2000)*499)%g.board.length,owner=Math.floor(random()*5);a.change(key,g.board[key],owner);g.board[key]=owner;if(owner)g.alive.add(key);else g.alive.delete(key); }
    if(gen%97===0)a.dirty=true; // high-D/full-rebuild route
    a.scan(g);b.scan(g);equal(a,b);
    // A post-snapshot removal must only affect the next scan.
    const key=gen%g.board.length;a.change(key,g.board[key],0);g.board[key]=0;g.alive.delete(key);equal(a,b);
  }
});
test('a forced matching fingerprint cannot bypass exact halo validation', () => {
  const a=new RegionalCycleDetector(100),g={board:new Uint8Array(10000),alive:[4949]};g.board[4949]=1;
  a.scan(g);a.scan(g);a.age[0]=600;a.period[0]=1;g.board[5050]=2;
  assert.equal(a.exactCandidates(g,600,10)[0],0);
});
