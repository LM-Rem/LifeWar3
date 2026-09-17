// Analysis-only prototype. Not imported by the game or server.
// Detects stationary regional cycles of periods 1..8 using absolute coordinates,
// 32x32 tiles, a two-cell halo, two fingerprints + population count.
// Nine full board snapshots permit an exact local comparison before candidate
// cleanup. Cross-tile whole-object cleanup and a player-facing TTL are NOT wired.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { Game } from '../src/engine.js';
import { PATTERNS } from '../public/patterns.js';

class RegionalCycleDetector {
  constructor(size=1000,maxPeriod=8) {
    this.size=size;this.side=Math.ceil(size/32);this.length=this.side**2;this.maxPeriod=maxPeriod;
    this.hash1=new Uint32Array(this.length);this.hash2=new Uint32Array(this.length);this.count=new Uint16Array(this.length);
    this.history1=new Uint32Array(this.length*maxPeriod);this.history2=new Uint32Array(this.length*maxPeriod);this.historyCount=new Uint16Array(this.length*maxPeriod);
    this.period=new Uint8Array(this.length);this.age=new Uint16Array(this.length);
    this.snapshots=Array.from({length:maxPeriod+1},()=>new Uint8Array(size*size));this.tick=0;
  }
  scan(game) {
    this.hash1.fill(0);this.hash2.fill(0);this.count.fill(0);
    for(const key of game.alive){
      const x=key%this.size,y=Math.floor(key/this.size),tx=x>>5,ty=y>>5;
      const x0=tx-(x%32<2&&tx>0?1:0),x1=tx+(x%32>=30&&tx+1<this.side?1:0);
      const y0=ty-(y%32<2&&ty>0?1:0),y1=ty+(y%32>=30&&ty+1<this.side?1:0);
      let h=key+game.board[key]*1000000;
      h=Math.imul(h^(h>>>16),0x45d9f3b);h=Math.imul(h^(h>>>16),0x45d9f3b);h=(h^(h>>>16))>>>0;
      const h2=Math.imul(h^0x9e3779b9,0x85ebca6b)>>>0;
      for(let yy=y0;yy<=y1;yy++)for(let xx=x0;xx<=x1;xx++){const t=yy*this.side+xx;this.hash1[t]^=h;this.hash2[t]+=h2;this.count[t]++;}
    }
    const offset=(this.tick%this.maxPeriod)*this.length;
    let candidates=0;
    for(let tile=0;tile<this.length;tile++){
      let found=0;
      if(this.count[tile])for(let p=1;p<=Math.min(this.tick,this.maxPeriod);p++){
        const i=((this.tick-p)%this.maxPeriod)*this.length+tile;
        if(this.hash1[tile]===this.history1[i]&&this.hash2[tile]===this.history2[i]&&this.count[tile]===this.historyCount[i]){found=p;break;}
      }
      this.age[tile]=found&&found===this.period[tile]?Math.min(65535,this.age[tile]+1):0;
      this.period[tile]=found;
      if(this.age[tile]>=50)candidates++;
    }
    this.history1.set(this.hash1,offset);this.history2.set(this.hash2,offset);this.historyCount.set(this.count,offset);
    this.snapshots[this.tick%this.snapshots.length].set(game.board);this.tick++;
    return candidates;
  }
  exactCandidates(game,minimumAge=50) {
    const verified=new Uint8Array(this.length);
    for(let tile=0;tile<this.length;tile++){
      if(this.age[tile]<minimumAge||!this.period[tile])continue;
      const p=this.period[tile];
      const past=this.snapshots[(this.tick-1-p)%this.snapshots.length];
      const tx=tile%this.side,ty=Math.floor(tile/this.side);
      let same=true;
      for(let y=Math.max(0,ty*32-2);y<Math.min(this.size,ty*32+34)&&same;y++)for(let x=Math.max(0,tx*32-2);x<Math.min(this.size,tx*32+34);x++)if(game.board[y*this.size+x]!==past[y*this.size+x]){same=false;break;}
      if(same)verified[tile]=1;
    }
    return verified;
  }
  exactCandidateCount(game,minimumAge=50) { return this.exactCandidates(game,minimumAge).reduce((sum,n)=>sum+n,0); }
  get bytes(){return Object.values(this).reduce((sum,x)=>sum+(ArrayBuffer.isView(x)?x.byteLength:0),0)+this.snapshots.reduce((sum,x)=>sum+x.byteLength,0);}
}
const random=initial=>{let seed=initial;return()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};};
const fresh=()=>new Game([1,2,3,4].map(i=>({name:'P'+i})),{random:random(42)});
function seedPattern(game,cells,x,y,owner=1){for(const[dx,dy]of cells){const key=(y+dy)*1000+x+dx;if(game.board[key])throw new Error('overlap');game.board[key]=owner;game.alive.push(key);game.players[owner-1].cells++;}}
const find=id=>PATTERNS.find(p=>p.id===id).cells;
function fixtureChecks(){
  for(const[id,expected]of [['block',1],['blinker',2],['pulsar',3],['glider',0],['lwss',0]]){
    const g=fresh(),d=new RegionalCycleDetector();seedPattern(g,find(id),450,450);
    for(let i=0;i<90;i++){g.step();d.scan(g);g.changes.clear();}
    const old=[...d.period].filter((p,i)=>d.age[i]>=50&&d.count[i]);
    if(expected){assert.ok(old.includes(expected),id+' must be recognized');assert.ok(d.exactCandidateCount(g)>0);}
    else assert.equal(old.length,0,id+' must not age as stationary debris');
  }
  const g=fresh(),d=new RegionalCycleDetector();seedPattern(g,find('block'),450,450);
  for(let i=0;i<90;i++){g.step();d.scan(g);g.changes.clear();}
  const tile=(450>>5)*d.side+(450>>5);assert.ok(d.age[tile]>=50);
  seedPattern(g,find('glider'),460,460);d.scan(g);assert.equal(d.age[tile],0);
  console.log('Fixture checks passed: block, blinker, pulsar; moving glider/LWSS excluded; interaction resets age.');
}
function scene(kind){
  const g=fresh();let ownerIndex=0;
  if(kind==='chaos'){
    const rng=random(71);
    for(let team=1;team<=4;team++)for(let y=0;y<110;y++)for(let x=0;x<110;x++)if(rng()<.48)seedPattern(g,[[0,0]],350+x+(team%2?0:130),350+y+(team>2?130:0),team);
  }else{
    const pattern=kind==='blocks'?find('block'):kind==='blinkers'?find('blinker'):find('pulsar');
    const spacing=kind==='pulsars'?20:9,limit=kind==='blocks'?24000:kind==='blinkers'?18000:14400;
    outer:for(let y=24;y<975;y+=spacing)for(let x=24;x<975;x+=spacing){
      if(g.alive.length+pattern.length>limit)break outer;
      if(g.players.some(p=>Math.hypot(x-p.x,y-p.y)<32))continue;
      seedPattern(g,pattern,x,y,(ownerIndex++%4)+1);
    }
  }
  return g;
}
const stats=values=>{const a=[...values].sort((a,b)=>a-b);return {avg:+(a.reduce((s,x)=>s+x,0)/a.length).toFixed(4),p95:+a[Math.floor(a.length*.95)].toFixed(4)};};
fixtureChecks();
console.log(JSON.stringify({node:process.version,cpu:os.cpus()[0].model,platform:process.platform}));
for(const kind of ['blocks','blinkers','pulsars','chaos']){
  const base=[],detection=[],exact=[],total=[],ranges=[],cleanup=[];
  for(let run=0;run<5;run++){
    const g=scene(kind),d=new RegionalCycleDetector();
    // Warm up against a separate scene so chaos still starts at ~23k cells.
    const warm=scene('blocks');for(let i=0;i<30;i++){warm.step();d.scan(warm);}d.tick=0;d.age.fill(0);d.period.fill(0);
    let low=Infinity,high=0;
    for(let i=0;i<200;i++){
      const start=performance.now();g.step();g.packet();const engineDone=performance.now();
      d.scan(g);const scanDone=performance.now();
      if(i%10===0){const begin=performance.now();d.exactCandidateCount(g);exact.push(performance.now()-begin);}
      if(i>=10||kind==='chaos'){base.push(engineDone-start);detection.push(scanDone-engineDone);total.push(scanDone-start);}
      low=Math.min(low,g.alive.length);high=Math.max(high,g.alive.length);g.changes.clear();
    }
    ranges.push([low,high]);
    const cleanupStart=performance.now(),candidates=d.exactCandidates(g);let removed=0;
    for(const key of g.alive){const tile=(Math.floor(key/1000)>>5)*d.side+((key%1000)>>5);if(candidates[tile]){g.players[g.board[key]-1].cells--;g.board[key]=0;g.changes.set(key,0);removed++;}}
    g.alive=g.alive.filter(key=>g.board[key]);const bytes=g.packet().byteLength;
    cleanup.push({ms:+(performance.now()-cleanupStart).toFixed(3),removed,bytes});
    if(run===0)console.log(JSON.stringify({scene:kind,detectorMemoryMiB:+(d.bytes/1048576).toFixed(3)}));
  }
  const b=stats(base),d=stats(detection);
  console.log(JSON.stringify({scene:kind,liveRange:[Math.min(...ranges.map(r=>r[0])),Math.max(...ranges.map(r=>r[1]))],samples:base.length,engineMs:b,extraDetectionMs:d,combinedMs:stats(total),extraRelativePercent:+(d.avg/b.avg*100).toFixed(1),exactVerificationOncePerSecondMs:stats(exact),rawTileCleanupIncludingPacket:cleanup}));
}
