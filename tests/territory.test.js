import test from 'node:test';
import assert from 'node:assert/strict';
import { generateNodes, createTerritories, territoryAt, territoryOwner, canDeployInTerritory, NODE_MIN_SPACING, BASE_HIT_RADIUS } from '../public/territory.js';
import { Game, RULES } from '../src/engine.js';
import { runBots } from '../src/bots.js';

const rng = initial => { let seed=initial;return ()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;}; };
const players = n => [[180,180],[820,820],[820,180],[180,820]].slice(0,n).map(([x,y],i)=>({id:i+1,x,y,eliminated:false}));
const area = polygon => Math.abs(polygon.reduce((sum,[x,y],i)=>{const[nx,ny]=polygon[(i+1)%polygon.length];return sum+x*ny-y*nx;},0))/2;
function contains(polygon,x,y){return polygon.every(([ax,ay],i)=>{const[bx,by]=polygon[(i+1)%polygon.length];return (bx-ax)*(y-ay)-(by-ay)*(x-ax)>=-1e-6;});}

test('random maps have 12–16 spaced nodes, whole-map coverage and exactly nodes + bases regions',()=>{
  const counts=new Set();
  for(let count=2;count<=4;count++)for(let seed=1;seed<=40;seed++){
    const bases=players(count),nodes=generateNodes(bases,rng(seed*81231)),all=[...bases,...nodes];counts.add(nodes.length);
    assert.ok(nodes.length>=12&&nodes.length<=16);
    nodes.forEach(n=>{assert.ok(n.x>=60&&n.x<=940&&n.y>=60&&n.y<=940);for(const other of all)if(other!==n)assert.ok(Math.hypot(n.x-other.x,n.y-other.y)>=NODE_MIN_SPACING);});
    const regions=createTerritories(bases,nodes);assert.equal(regions.length,nodes.length+count);
    assert.ok(regions.every(r=>r.polygon.length>=3&&area(r.polygon)>0));assert.ok(Math.abs(regions.reduce((sum,r)=>sum+area(r.polygon),0)-1000000)<.001);
    for(let y=0;y<1000;y+=100)for(let x=0;x<1000;x+=100){
      const region=territoryAt(regions,x,y);assert.ok(contains(region.polygon,x,y));
      assert.ok(Math.hypot(x-region.x,y-region.y)<330,'unreasonably large empty area');
    }
  }
  assert.deepEqual([...counts].sort(),[12,13,14,15,16]);
});
test('layout is reproducible from a random stream and changes between seeds',()=>{
  assert.deepEqual(generateNodes(players(4),rng(19)),generateNodes(players(4),rng(19)));
  assert.notDeepEqual(generateNodes(players(4),rng(19)),generateNodes(players(4),rng(20)));
});
test('shared edges have a deterministic owner, captures transfer a whole fixed polygon',()=>{
  const bases=[{id:1,x:100,y:500},{id:2,x:900,y:500}],nodes=[{id:0,x:500,y:500,owner:0}];
  const regions=createTerritories(bases,nodes);assert.equal(regions.length,3);
  assert.equal(territoryAt(regions,300,500).kind,'base');assert.equal(territoryAt(regions,301,500).kind,'node');
  assert.equal(canDeployInTerritory(regions,bases,nodes,1,499,50),false);
  const before=JSON.stringify(regions);nodes[0].owner=1;assert.equal(canDeployInTerritory(regions,bases,nodes,1,499,50),true);assert.equal(canDeployInTerritory(regions,bases,nodes,2,499,50),false);
  nodes[0].owner=2;assert.equal(canDeployInTerritory(regions,bases,nodes,1,499,50),false);assert.equal(canDeployInTerritory(regions,bases,nodes,2,499,50),true);assert.equal(JSON.stringify(regions),before);
  bases[0].eliminated=true;assert.equal(territoryOwner(regions[0],bases,nodes),0);assert.equal(territoryAt(regions,-1,0),null);
});
test('server rejects patterns straddling an unowned polygon atomically; client agrees',()=>{
  const game=new Game([{name:'A'},{name:'B'}],{random:rng(6)}),p=game.players[0];
  let boundary;
  for(let y=10;y<990&&!boundary;y++)for(let x=10;x<989;x++)if(game.inRange(p,x,y)&&!game.inRange(p,x+1,y)){boundary={x,y};break;}
  assert.ok(boundary);const energy=p.energy;
  assert.ok(game.deploy(p.id,boundary.x,boundary.y,[[0,0],[1,0]]).error);assert.equal(p.energy,energy);assert.equal(game.alive.length,0);
  const client=createTerritories(game.players,game.nodes);
  for(let y=0;y<1000;y+=19)for(let x=0;x<1000;x+=23)assert.equal(game.inRange(p,x,y),canDeployInTerritory(client,game.players,game.nodes,p.id,x,y));
  const node=game.nodes[0];game.nodes[0].owner=1;assert.ok(game.deploy(1,node.x,node.y,[[0,0],[1,0],[0,1],[1,1]]).ok);
});
test('base hit marking constant equals actual inclusive damage boundary',()=>{
  assert.equal(RULES.baseHitRadius,BASE_HIT_RADIUS);
  const g=new Game([{name:'A'},{name:'B'}],{random:rng(7)}),p=g.players[0];
  for(const dx of [12,13]){const k=p.y*1000+p.x+dx;g.board[k]=2;g.alive.push(k);g.players[1].cells++;}
  g.resolveObjectives(.1);assert.equal(p.hp,RULES.baseHP-3);assert.equal(g.board[p.y*1000+p.x+12],0);assert.equal(g.board[p.y*1000+p.x+13],2);
});
test('AI expands across neutral polygon territory using moving life patterns',()=>{
  const g=new Game([{name:'A'},{name:'Bot',bot:true}],{random:rng(62)});
  for(let i=0;i<1800&&g.players[1].nodes===0;i++){if(i%30===0)runBots(g);g.step();g.changes.clear();}
  assert.ok(g.players[1].nodes>0,'bot must actually contact and capture a neutral node');
});
