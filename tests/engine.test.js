import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, RULES } from '../src/engine.js';
import { PATTERNS, transform, parseRLE, toRLE } from '../public/patterns.js';

const game = (n=2) => new Game(Array.from({length:n},(_,i)=>({name:'P'+(i+1)})));
function seed(g,cells,owner=1){for(const[x,y]of cells){const key=y*1000+x;g.board[key]=owner;g.alive.push(key);g.players[owner-1].cells++;}}
const positions = g => g.alive.map(k=>[k%1000,Math.floor(k/1000)]).sort((a,b)=>a[1]-b[1]||a[0]-b[0]);
const sorted = cells => [...cells].sort((a,b)=>a[1]-b[1]||a[0]-b[0]);

test('B3/S23: stable block, period-2 blinker and period-4 glider',()=>{
  for(const[id,ticks,offset]of [['block',10,0],['blinker',2,0],['pulsar',3,0],['glider',4,1]]){
    const g=game(),cells=PATTERNS.find(p=>p.id===id).cells.map(([x,y])=>[x+400,y+400]);seed(g,cells);
    for(let i=0;i<ticks;i++)g.step();assert.deepEqual(positions(g),sorted(cells.map(([x,y])=>[x+offset,y+offset])));
  }
  const g=game(),ship=PATTERNS.find(p=>p.id==='lwss').cells.map(([x,y])=>[x+400,y+400]);seed(g,ship);for(let i=0;i<4;i++)g.step();assert.deepEqual(positions(g),sorted(ship.map(([x,y])=>[x-2,y])));
});
test('world boundaries do not wrap between rows or across map',()=>{
  const g=game();seed(g,[[999,10],[0,11],[1,11]]);g.step();assert.equal(g.board[10*1000],0);assert.equal(g.board[11*1000+999],0);
  const edge=game();seed(edge,[[0,0],[1,0],[0,1],[1,1]]);edge.step();assert.equal(edge.alive.length,4);
});
test('birth inherits neighbor majority; survivors retain ownership',()=>{
  const g=game();seed(g,[[400,400],[400,401]],1);seed(g,[[401,400]],2);g.step();assert.equal(g.board[401*1000+401],1);assert.equal(g.board[400*1000+401],2);
});
test('deployment is atomic, bounded, non-overlapping and charges unique cells',()=>{
  const g=game(),p=g.players[0];assert.ok(g.deploy(1,200,200,[[0,0],[0,0],[1,1]]).ok);assert.equal(p.energy,118);assert.equal(g.alive.length,2);
  const before=p.energy;assert.ok(g.deploy(1,201,201,[[0,0],[1,0]]).error);assert.equal(p.energy,before);assert.equal(g.board[201*1000+202],0);
  assert.ok(g.deploy(1,800,100,[[0,0]]).error);assert.ok(g.deploy(1,200,200,[[128,0]]).error);assert.ok(g.deploy(1,1.1,0,[[0,0]]).error);assert.ok(g.deploy(1,200,200,[[NaN,0]]).error);
  p.energy=0;assert.ok(g.deploy(1,220,220,[[0,0]]).error);
});
test('energy regenerates and is capped; nodes increase regen',()=>{
  const g=game();g.nodes[0].owner=1;g.players[0].energy=100;g.step();assert.equal(g.players[0].energy,100.6);
  g.players[0].energy=179.9;g.step();assert.equal(g.players[0].energy,180);
});
test('nodes require 3s contact, unlock deployment and can be contested or stolen',()=>{
  const g=game(),n=g.nodes[0];seed(g,[[n.x,n.y],[n.x+1,n.y],[n.x,n.y+1],[n.x+1,n.y+1]]);
  assert.equal(g.inRange(g.players[0],n.x,n.y),false);
  for(let i=0;i<29;i++)g.step();assert.equal(n.owner,0);g.step();assert.equal(n.owner,1);assert.equal(g.inRange(g.players[0],n.x,n.y),true);
  for(const key of g.alive)g.board[key]=0;g.alive=[];seed(g,[[n.x,n.y],[n.x+1,n.y],[n.x,n.y+1],[n.x+1,n.y+1]],2);
  for(let i=0;i<10;i++)g.step();const progress=n.progress;seed(g,[[n.x-6,n.y],[n.x-5,n.y],[n.x-6,n.y+1],[n.x-5,n.y+1]],1);g.step();assert.equal(n.progress,progress);
  for(const k of g.alive)if(g.board[k]===1)g.board[k]=0;g.alive=g.alive.filter(k=>g.board[k]);
  for(let i=0;i<20;i++)g.step();assert.equal(n.owner,2);
});
test('enemy core exclusion and cell contact damage, elimination and victory',()=>{
  const g=game(),p=g.players[1];g.nodes[0]={id:0,x:p.x,y:p.y,owner:1,claimant:0,progress:0};assert.ok(g.deploy(1,p.x,p.y,[[0,0]]).error);
  p.hp=12;seed(g,[[p.x,p.y],[p.x+1,p.y],[p.x,p.y+1],[p.x+1,p.y+1]],1);seed(g,[[700,700],[701,700],[700,701],[701,701]],2);g.step();
  assert.equal(p.hp,0);assert.equal(p.eliminated,true);assert.equal(g.board[700*1000+700],0);assert.equal(g.winner,1);assert.equal(g.status,'finished');
});
test('simultaneous base destruction produces a draw',()=>{
  const g=game();for(const p of g.players){p.hp=3;seed(g,[[p.x,p.y],[p.x+1,p.y],[p.x,p.y+1],[p.x+1,p.y+1]],3-p.id);}g.step();
  assert.equal(g.status,'finished');assert.equal(g.winner,0);assert.ok(g.players.every(p=>p.eliminated));
});
test('binary snapshot and delta can reconstruct exact authoritative board',()=>{
  const g=game();g.deploy(1,200,200,PATTERNS[0].cells);const replica=new Uint8Array(1000000);
  function apply(packet){const v=new DataView(packet);if(v.getUint32(0,true))replica.fill(0);for(let i=8;i<v.byteLength;i+=4){const n=v.getUint32(i,true);replica[n%1000000]=Math.floor(n/1000000);}}
  apply(g.packet(true));g.changes.clear();for(let i=0;i<10;i++){g.step();apply(g.packet());g.changes.clear();}assert.deepEqual(replica,g.board);
});
test('pattern transforms round trip, RLE round trips and rejects oversized input',()=>{
  const cells=PATTERNS[0].cells;assert.deepEqual(sorted(transform(cells,4)),sorted(cells));assert.deepEqual(sorted(transform(transform(cells,0,true),0,true)),sorted(cells));assert.deepEqual(sorted(parseRLE(toRLE(cells))),sorted(cells));
  assert.throws(()=>parseRLE('9999o!'));assert.throws(()=>parseRLE('129$3o!'));assert.throws(()=>parseRLE('4097o!'));assert.throws(()=>parseRLE('hello'));assert.throws(()=>parseRLE('b!'));
  assert.throws(()=>parseRLE('x = 3, y = 3, rule = B36/S23\n3o!'));
});
test('population capacity is enforced',()=>{const g=game();g.players[0].cells=RULES.playerCells;assert.ok(g.deploy(1,200,200,[[0,0]]).error);});
test('finished results are immutable after later disconnect or repeated checks',()=>{
  const g=game();g.eliminate(2);g.checkVictory();const events=g.events.length;g.eliminate(1);g.checkVictory();g.step();assert.equal(g.winner,1);assert.equal(g.players[0].eliminated,false);assert.equal(g.events.length,events);
});
