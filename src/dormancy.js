export class RegionalCycleDetector {
  constructor(size=1000,maxPeriod=8,halo=10) {
    this.size=size;this.side=Math.ceil(size/32);this.length=this.side**2;this.maxPeriod=maxPeriod;
    this.hash1=new Uint32Array(this.length);this.hash2=new Uint32Array(this.length);this.count=new Uint16Array(this.length);
    this.history1=new Uint32Array(this.length*maxPeriod);this.history2=new Uint32Array(this.length*maxPeriod);this.historyCount=new Uint16Array(this.length*maxPeriod);
    this.period=new Uint8Array(this.length);this.age=new Uint16Array(this.length);
    this.snapshots=Array.from({length:maxPeriod+1},()=>new Uint8Array(size*size));this.tick=0;
    // 精确验证的观察扩展格数：足够覆盖可部署图案（≤32×32）中静态局部与
    // 活跃振荡核心的最大间距，避免误删大型振荡器（如高斯帕滑翔机枪）的静态尾巴，
    // 同时不影响真正独立静物（周围 halo 格内确实静止）的清理。
    this.halo=halo;
  }
  invalidate(keys) {
    // Include neighbouring observation tiles, even if deployment dies next step.
    for (const key of keys) {
      const tx=(key%this.size)>>5,ty=Math.floor(key/this.size)>>5;
      for(let y=Math.max(0,ty-1);y<=Math.min(this.side-1,ty+1);y++)
        for(let x=Math.max(0,tx-1);x<=Math.min(this.side-1,tx+1);x++) {
          const t=y*this.side+x;this.age[t]=0;this.period[t]=0;
        }
    }
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
      this.age[tile]=found?(found===this.period[tile]?Math.min(65535,this.age[tile]+1):1):0;
      this.period[tile]=found;
      if(this.age[tile]>=50)candidates++;
    }
    this.history1.set(this.hash1,offset);this.history2.set(this.hash2,offset);this.historyCount.set(this.count,offset);
    this.snapshots[this.tick%this.snapshots.length].set(game.board);this.tick++;
    return candidates;
  }
  exactCandidates(game,minimumAge=50,halo=2) {
    const verified=new Uint8Array(this.length);
    for(let tile=0;tile<this.length;tile++){
      if(this.age[tile]<minimumAge||!this.period[tile])continue;
      const p=this.period[tile];
      const past=this.snapshots[(this.tick-1-p)%this.snapshots.length];
      const tx=tile%this.side,ty=Math.floor(tile/this.side);
      let same=true;
      for(let y=Math.max(0,ty*32-halo);y<Math.min(this.size,ty*32+32+halo)&&same;y++)for(let x=Math.max(0,tx*32-halo);x<Math.min(this.size,tx*32+32+halo);x++)if(game.board[y*this.size+x]!==past[y*this.size+x]){same=false;break;}
      if(same)verified[tile]=1;
    }
    return verified;
  }
  exactCandidateCount(game,minimumAge=50) { return this.exactCandidates(game,minimumAge).reduce((sum,n)=>sum+n,0); }
  update(game, lifetime=600, warning=100) {
    this.scan(game);
    const remove=new Uint8Array(this.length);
    const warnings=[];
    let verified=null;
    // 仅最近 maxPeriod 代内任一相位有细胞的瓦片参与判定，
    // 避免空瓦片在 lifetime==warning 等边界配置下产生虚假警告。
    const occupied=new Uint8Array(this.length);
    for(let t=0;t<this.length;t++)for(let p=0;p<Math.min(this.tick,this.maxPeriod);p++)
      if(this.historyCount[p*this.length+t]){occupied[t]=1;break;}
    // 每个观察瓦片独立判定，不把相邻瓦片合并成区域：
    // 即使一小块区域仍在演化，也不会拖住整片连在一起的其他静物/振荡器。
    for(let t=0;t<this.length;t++) {
      if(!occupied[t])continue;
      const age=this.age[t];
      if(age<lifetime-warning)continue;
      if(age>=lifetime) {
        verified??=this.exactCandidates(game,lifetime,this.halo);
        if(verified[t]){remove[t]=1;continue;}
        // 精确验证不通过（哈希碰撞或移动模式恰好经过该瓦片），仅重置本瓦片
        this.age[t]=0;this.period[t]=0;
        continue;
      }
      warnings.push({tiles:[t],remaining:lifetime-age});
    }
    let removed=0;
    for(const key of game.alive) {
      const tile=(Math.floor(key/this.size)>>5)*this.side+((key%this.size)>>5);
      if(!remove[tile])continue;
      const owner=game.board[key];if(!owner)continue;
      game.players[owner-1].cells--;game.board[key]=0;game.changes.set(key,0);removed++;
    }
    if(removed) {
      game.alive=game.alive.filter(key=>game.board[key]);
      for(let t=0;t<this.length;t++)if(remove[t]){this.age[t]=0;this.period[t]=0;}
      game.event('decay',0,`休眠结构消散 · ${removed} 个细胞`);
    }
    this.warnings=warnings;
    return removed;
  }
  get bytes(){return Object.values(this).reduce((sum,x)=>sum+(ArrayBuffer.isView(x)?x.byteLength:0),0)+this.snapshots.reduce((sum,x)=>sum+x.byteLength,0);}
}

