import test from 'node:test';
import assert from 'node:assert/strict';
import { GlobeLife, GlobeRotation, GlobeMomentum, cubeSphere } from '../public/life-globe.js';
import { Game } from '../src/engine.js';

const empty = () => new GlobeLife({ size: 12, random: () => 1, seedEvery: Infinity });
const put = (life, cells) => { life.board.fill(0); for (const [x,y] of cells) life.board[y*life.size+x]=1; life.recount(); };
const cells = life => [...life.board].flatMap((value,k) => value ? [[k%life.size,Math.floor(k/life.size)]] : []);
const near = (a,b) => a.forEach((value,i) => assert.ok(Math.abs(value-b[i])<1e-10, `${value} != ${b[i]}`));

test('globe uses actual B3/S23: block, blinker and four-generation glider', () => {
  const life=empty(); put(life,[[4,4],[5,4],[4,5],[5,5]]); const block=life.board.slice();life.step();assert.deepEqual(life.board,block);
  put(life,[[4,5],[5,5],[6,5]]);life.step();assert.deepEqual(cells(life),[[5,4],[5,5],[5,6]]);life.step();assert.deepEqual(cells(life),[[4,5],[5,5],[6,5]]);
  put(life,[[4,3],[5,4],[3,5],[4,5],[5,5]]);for(let i=0;i<4;i++)life.step();
  assert.deepEqual(cells(life),[[5,4],[6,5],[4,6],[5,6],[6,6]]);
});
test('cube faces connect without duplicate, self or nonreciprocal neighbors, including all eight corners', () => {
  const mesh=cubeSphere(12);let exceptional=0;
  for(let key=0;key<mesh.count;key++){
    const neighbors=[...mesh.neighbors.subarray(key*8,key*8+8)].filter(k=>k>=0);
    assert.equal(new Set(neighbors).size,neighbors.length);assert.equal(neighbors.includes(key),false);
    assert.ok(neighbors.length===7||neighbors.length===8);if(neighbors.length===7)exceptional++;
    for(const neighbor of neighbors)assert.ok(mesh.neighbors.subarray(neighbor*8,neighbor*8+8).includes(key));
  }
  assert.equal(exceptional,24);
  // A birth on a face edge uses cells from both sides of that edge.
  const life=empty(),key=5*12,cross=[...life.mesh.neighbors.subarray(key*8,key*8+8)].filter(k=>k>=144);
  assert.equal(cross.length,3);for(const k of cross)life.board[k]=3;
  life.step();assert.equal(life.board[key],3);
});
test('client clock advances five generations per second independent of rendering and pauses without catch-up', () => {
  const life=empty();life.advance(0);for(let now=17;now<1000;now+=17)life.advance(now);life.advance(1000);assert.equal(life.generation,5);
  life.advance(1200,false);life.advance(100000);assert.equal(life.generation,5);life.advance(100200);assert.equal(life.generation,6);
  life.advance(900000);assert.equal(life.generation,11,'suspension must not trigger unbounded work');
});
test('periodic random seeding restores an empty board after one minute (generation 300)', () => {
  const life=new GlobeLife({size:12,random:()=>.1});life.board.fill(0);life.recount();
  for(let i=0;i<299;i++)life.step();assert.equal(life.population,0);
  life.step();assert.ok(life.population>0);assert.equal(life.population,life.board.reduce((a,b)=>a+(b?1:0),0));
});
test('free globe rotation completes 360 degrees on either absolute axis, without poles or drift', () => {
  for(const axis of [[1,0,0],[0,1,0]]){
    const rotation=new GlobeRotation();rotation.rotate(1.2,2.1);const initial=rotation.matrix();
    for(let i=0;i<360;i++)rotation.world(axis,Math.PI/180);
    near(rotation.matrix(),initial);assert.ok(Math.abs(Math.hypot(...rotation.q)-1)<1e-12);
  }
});
test('auto rotation always uses screen vertical axis after arbitrary drags', () => {
  const point=[.3,.5,.7];const project=m=>[m[0]*point[0]+m[1]*point[1]+m[2]*point[2],m[3]*point[0]+m[4]*point[1]+m[5]*point[2],m[6]*point[0]+m[7]*point[1]+m[8]*point[2]];
  for(const [x,y]of [[0,0],[1,2],[8,-9],[-3,Math.PI]]){
    const rotation=new GlobeRotation();rotation.rotate(x,y);const before=project(rotation.matrix());rotation.auto(1000);const after=project(rotation.matrix());
    near(after,[before[0]*Math.cos(.055)+before[2]*Math.sin(.055),before[1],before[2]*Math.cos(.055)-before[0]*Math.sin(.055)]);
  }
});
test('uniform cube sphere has no collapsed poles and shares all face-edge vertices', () => {
  const mesh=cubeSphere(64),{vertices,corners}=mesh;let min=Infinity,max=0;
  assert.equal(mesh.count,24576);assert.equal(vertices.length/3,mesh.count+2);
  assert.equal(mesh.edges.length/2,mesh.count*2);
  for(let k=0;k<vertices.length;k+=3)assert.ok(Math.abs(Math.hypot(vertices[k],vertices[k+1],vertices[k+2])-1)<1e-6);
  for(let key=0;key<mesh.count;key++)for(let i=0;i<4;i++){
    const a=corners[key*4+i]*3,b=corners[key*4+(i+1)%4]*3;
    const length=Math.hypot(...[0,1,2].map(axis=>vertices[a+axis]-vertices[b+axis]));
    min=Math.min(min,length);max=Math.max(max,length);
  }
  assert.ok(min>0);assert.ok(max/min<1.8,`edge length ratio ${max/min}`);
});

test('globe inheritance matches actual game for every three-neighbor faction combination and tie offset', () => {
  const life=empty(),target=5*12+5,neighbors=[...life.mesh.neighbors.subarray(target*8,target*8+8)];
  const game=new Game([1,2,3,4].map(i=>({name:`P${i}`})),{evolutionMode:'sparse'});
  game.resolveObjectives=game.dormancy.update=game.checkVictory=game.checkCardDraw=()=>{};
  const cpuTarget=500*1000+500,cpuNeighbors=[cpuTarget-1001,cpuTarget-1000,cpuTarget-999];
  for(let combination=0;combination<64;combination++)for(let offset=0;offset<4;offset++){
    life.board.fill(0);life.generation=offset;
    game.board.fill(0);game.alive.length=0;game.changes.clear();
    // Match position+generation modulo four, including the game's pre-step increment.
    game.generation=offset+(target-cpuTarget+4)%4;
    for(let i=0;i<3;i++){
      const owner=1+((combination>>(i*2))&3);life.board[neighbors[i]]=owner;
      game.board[cpuNeighbors[i]]=owner;game.alive.push(cpuNeighbors[i]);
    }
    game.rebuildDerivedState();game.step();life.step();assert.equal(life.board[target],game.board[cpuTarget]);
  }
  life.board.fill(0);life.board[target]=4;life.board[neighbors[0]]=1;life.board[neighbors[1]]=2;life.step();assert.equal(life.board[target],4);
});
test('seeding assigns deterministic faction regions while randomness only changes cell placement', () => {
  const a=new GlobeLife({size:12,random:()=>.1}),b=new GlobeLife({size:12,random:()=>.2});
  assert.deepEqual(a.board,b.board);assert.deepEqual(new Set(a.board),new Set([1,2,3,4]));
});

test('mass limits acceleration and smooths a sudden drag instead of snapping to its target', () => {
  const physics=new GlobeMomentum();physics.begin();physics.push(1,0);
  const first=physics.advance(16);assert.ok(first[0]>0&&first[0]<.003);
  assert.ok(physics.error[0]>.99);assert.ok(physics.velocity[0]<.12);
  let angle=first[0];for(let i=0;i<150;i++){const delta=physics.advance(16);if(delta)angle+=delta[0];}
  assert.ok(Math.abs(angle-1)<.005);assert.ok(Math.abs(physics.velocity[0])<.01);
});
test('released globe coasts, loses energy monotonically and eventually settles', () => {
  const physics=new GlobeMomentum();physics.begin();physics.push(1,-.5);
  for(let i=0;i<12;i++)physics.advance(16);
  const speed=Math.hypot(...physics.velocity);physics.release();assert.ok(speed>.1);
  let distance=0,previous=speed;
  for(let i=0;i<500;i++){
    const delta=physics.advance(16);if(delta)distance+=Math.hypot(...delta);
    const current=Math.hypot(...physics.velocity);assert.ok(current<=previous+1e-12);previous=current;
  }
  assert.ok(distance>.1);assert.deepEqual(physics.velocity,[0,0]);
});
test('grabbing brakes existing momentum, cancellation/reset discards all residual force', () => {
  const physics=new GlobeMomentum();physics.begin();physics.push(2,1);physics.advance(100);physics.release();
  const before=[...physics.velocity];physics.begin();near(physics.velocity,before.map(v=>v*.2));
  physics.push(1,1);physics.release(false);assert.deepEqual(physics.velocity,[0,0]);assert.deepEqual(physics.error,[0,0]);assert.equal(physics.advance(100),null);
});
test('heavy response remains consistent at 30, 60 and 120 frames per second', () => {
  const simulate=fps=>{const physics=new GlobeMomentum();physics.begin();physics.push(.8,-.4);const result=[0,0];
    for(let i=0;i<fps;i++){if(i===Math.floor(fps/2))physics.release();const delta=physics.advance(1000/fps);if(delta){result[0]+=delta[0];result[1]+=delta[1];}}return result;
  };
  const reference=simulate(120);for(const fps of [30,60])simulate(fps).forEach((value,i)=>assert.ok(Math.abs(value-reference[i])<.003));
});
