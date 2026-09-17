import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, RULES } from '../src/engine.js';
import { PATTERNS } from '../public/patterns.js';

const fresh=()=>new Game([{name:'A'},{name:'B'}]);
function seed(g,id,x,y,owner=1) {
  for(const[dx,dy]of PATTERNS.find(p=>p.id===id).cells){const k=(y+dy)*1000+x+dx;g.board[k]=owner;g.alive.push(k);g.players[owner-1].cells++;}
}
function step(g,n){for(let i=0;i<n;i++){g.changes.clear();g.step();}}

test('600 confirmed dormant generations, 100-generation warning, atomic delta and node retention',()=>{
  const g=fresh();seed(g,'block',450,450);g.nodes[0].owner=1;
  step(g,500);assert.equal(g.state().dormancy.length,0);assert.equal(g.alive.length,4);
  step(g,1);assert.equal(g.state().dormancy[0].remaining,100);
  step(g,99);assert.equal(g.alive.length,4);assert.equal(g.state().dormancy[0].remaining,1);
  const keys=[...g.alive];step(g,1);assert.equal(g.alive.length,0);assert.equal(g.players[0].cells,0);
  assert.equal(g.nodes[0].owner,1);assert.equal(g.state().dormancy.length,0);
  const packet=new DataView(g.packet());assert.equal(packet.byteLength,24);
  assert.deepEqual([...g.changes.keys()].sort(),keys.sort());assert.ok([...g.changes.values()].every(v=>v===0));
  assert.equal(RULES.dormancyGenerations,600);
});

test('period 2 and 3 oscillators, including tile corners, disappear whole',()=>{
  for(const[id,x,y]of [['blinker',450,450],['blinker',479,479],['pulsar',475,475],['block',479,479],['block',998,998]]){
    const g=fresh();seed(g,id,x,y,2);step(g,590);assert.ok(g.alive.length,id);
    let cleared=false;
    for(let i=0;i<40;i++){g.changes.clear();g.step();if(g.events.some(e=>e.type==='decay')){assert.equal(g.alive.length,0,id+' must not be partially deleted');cleared=true;break;}}
    assert.ok(cleared,id+' should expire');assert.equal(g.players[1].cells,0);
  }
});

test('moving gliders and ships do not expire after 600 generations',()=>{
  for(const id of ['glider','lwss']){const g=fresh();seed(g,id,500,450);step(g,650);assert.ok(g.alive.length,id);assert.ok(!g.events.some(e=>e.type==='decay'));assert.equal(g.state().dormancy.length,0);}
});

test('successful deployment resets local aging even if new cells immediately die',()=>{
  const g=fresh();seed(g,'block',180,180);step(g,590);assert.ok(g.state().dormancy.length);
  assert.ok(g.deploy(1,190,190,[[0,0]]).ok);step(g,20);assert.equal(g.alive.length,4);assert.equal(g.state().dormancy.length,0);
  step(g,590);assert.equal(g.alive.length,0);
});

test('active adjacent regions defer cleanup, distant static debris still expires',()=>{
  const g=fresh();seed(g,'block',450,450);seed(g,'block',100,400);step(g,590);
  seed(g,'glider',460,460);step(g,20);
  assert.equal(g.board[400100],0);assert.equal(g.board[450450],1);assert.ok(g.players[0].cells>0);
});

test('age follows generations regardless of dt, finished games do not age',()=>{
  const g=fresh();seed(g,'block',450,450);
  for(let i=0;i<600;i++)g.step(5);assert.equal(g.alive.length,4);g.step(0);assert.equal(g.alive.length,0);
  const finished=fresh();seed(finished,'block',450,450);step(finished,590);finished.status='finished';step(finished,100);assert.equal(finished.alive.length,4);assert.equal(finished.generation,590);
});
