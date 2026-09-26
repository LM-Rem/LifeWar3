import { GenerationQueue } from './generation-queue.js';
import { decodeBoardPacket, orderedBoardEntries } from './board-protocol.js';
import { WorldTexture } from './world-texture.js';
import { MinimapCache } from './minimap-cache.js';
import { CellStore } from './cell-store.js';
import { BASE_HIT_RADIUS, createTerritories, territoryOwner, canDeployInTerritory, territoryAt, adjacentNeutralTerritories } from './territory.js';
import { browserMetrics } from './performance-metrics.js';
export const COLORS = ['#67f5d1', '#ff796c', '#ac98ff', '#f4cc75'];
const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const hexAlpha = (color, opacity) => color + Math.round(opacity * 255).toString(16).padStart(2, '0');

export function drawPattern(canvas, cells, color = COLORS[0]) {
  const ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!cells.length) return;
  const pw = Math.max(...cells.map(c => c[0])) + 1, ph = Math.max(...cells.map(c => c[1])) + 1;
  const s = Math.min((w - 16) / pw, (h - 16) / ph, 9), ox = (w - pw * s) / 2, oy = (h - ph * s) / 2;
  ctx.fillStyle = color;
  for (const [x, y] of cells) ctx.fillRect(ox + x * s, oy + y * s, Math.max(1, s - 1.3), Math.max(1, s - 1.3));
}

export class Battlefield {
  constructor(canvas, minimap, settings) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d', { alpha: false });
    this.minimap = minimap; this.mctx = minimap.getContext('2d');
    this.settings = settings; this.camera = { x: 180, y: 180, zoom: 3.5 }; this.cameraTarget = null;
    this.world = document.createElement('canvas'); this.world.width = 1000; this.world.height = 1000;
    this.wctx = this.world.getContext('2d'); this.board = new Uint8Array(1000000);
    this.texture = new WorldTexture(this.wctx, COLORS); this.minimapCache = new MinimapCache();
    this.presentationEpoch=0;
    this.presentation=new GenerationQueue({onEvent:(name,value)=>{browserMetrics?.record(name,value,this.generation);this.onPresentationEvent?.(name,value);},onRecovery:reason=>this.onRecovery?.(reason)});
    this.boardRevision=0;this.boundsCache=new WeakMap();
    this.cells = new CellStore(this.board); this.effects = []; this.pointer = null; this.pattern = []; this.keys = new Set(); this.active = false;
    this.state = null; this.territories = []; this.me = 1; this.generation = 0; this.baseHP = 240; this.playerCells = 6000; this.baseHitRadius = BASE_HIT_RADIUS; this.captureTime = 30;
    this.cardTarget = null; // 道具卡选点模式：{ cardId, radius }
    if (browserMetrics) {
      for (const [method, name] of [['draw', 'draw.ms'], ['drawMinimap', 'minimap.ms'], ['placement', 'preview.ms']]) {
        const original = this[method];
        this[method] = (...args) => { const start = browserMetrics.now(); try { return original.apply(this, args); }
          finally { browserMetrics.duration(name, start, this.generation); } };
      }
    }
    this.resize(); new ResizeObserver(() => this.resize()).observe(canvas);
    this.lastTime = performance.now(); this.frame = this.frame.bind(this); requestAnimationFrame(this.frame);
  }
  resize() {
    this.width = this.canvas.clientWidth || innerWidth; this.height = this.canvas.clientHeight || innerHeight;
    this.dpr = Math.min(devicePixelRatio || 1, 2); this.canvas.width = Math.round(this.width * this.dpr); this.canvas.height = Math.round(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }
  reset() { this.presentation.reset(++this.presentationEpoch); this.presentation.visibility(document.hidden); this.boardRevision++; this.previewCache=null; this.cells.clear(); this.board.fill(0); this.texture.reset(); this.texture.flush(); this.minimapCache.invalidate(); this.effects = []; this.state = null; this.territories = []; this.generation = 0; this.keys.clear(); this.cameraTarget = null; }
  receivePacket(buffer,epoch=this.presentation.epoch) {
    const start=browserMetrics?browserMetrics.now():0,accepted=this.presentation.packet(buffer,epoch);
    if(browserMetrics){browserMetrics.duration('packet.validateDecode.ms',start,this.presentation.received);if(accepted)browserMetrics.record('receivedGeneration',buffer.byteLength,this.presentation.received);}
    return accepted;
  }
  receiveState(state,epoch=this.presentation.epoch) {return this.presentation.state(state,epoch);}
  presentNext() {
    const {packet,state,waitMs}=this.presentation.take();
    if(packet){
      try{this.updatePacket(packet.buffer,packet.decoded);}catch{this.presentation.displayed=this.generation;this.presentation.fail('board-baseline');return;}
      browserMetrics?.record('presentation.wait.ms',waitMs,this.generation);
    }
    if(state){this.setState(state);this.onPresentedState?.(state);}
    browserMetrics?.record('presentation.queueDepth',this.presentation.packets.length,this.generation);
    return packet;
  }
  setState(state) {
    if (!this.state) this.territories = createTerritories(state.players, state.nodes);
    this.state = state;
    this.extraLand = state.players.find(p => p.id === this.me)?.neutralDeploy ? adjacentNeutralTerritories(this.territories, state.players, state.nodes, this.me) : [];
  }
  updatePacket(buffer,decoded) {
    const traceStart = browserMetrics ? browserMetrics.now() : 0;
    decoded??=decodeBoardPacket(buffer);
    const entries=orderedBoardEntries(decoded,this.board);
    this.boardRevision++;
    if (browserMetrics) {
      if (decoded.snapshot) browserMetrics.record('snapshot', 1, decoded.generation);
    }
    if (decoded.snapshot) { this.cells.clear(); this.board.fill(0); this.texture.reset(); this.minimapCache.invalidate(); }
    this.generation = decoded.generation;
    for (const value of entries) {
      const owner = Math.floor(value / 1000000), key = value % 1000000;
      // No-op entries (including dense tile padding on the board) must not
      // write cell storage or texture.
      if (this.board[key] === owner) continue;
      this.board[key] = owner;
      if (owner) { this.cells.set(key,owner); this.texture.set(key,owner); }
      else { this.cells.delete(key); this.texture.set(key,0); }
    }
    this.texture.flush();
    if (browserMetrics) {
      browserMetrics.duration('packet.decodeApplyTexture.ms', traceStart, this.generation);
      browserMetrics.record('appliedGeneration', 0, this.generation);
    }
  }
  screen(x, y) { return [(x-this.camera.x)*this.camera.zoom+this.width/2, (y-this.camera.y)*this.camera.zoom+this.height/2]; }
  worldPoint(x, y) { return [(x-this.width/2)/this.camera.zoom+this.camera.x,(y-this.height/2)/this.camera.zoom+this.camera.y]; }
  zoom(factor, x=this.width/2, y=this.height/2) {
    this.cameraTarget=null;
    const before=this.worldPoint(x,y); this.camera.zoom=clamp(this.camera.zoom*factor,.45,22); const after=this.worldPoint(x,y);
    this.camera.x=clamp(this.camera.x+before[0]-after[0],0,1000); this.camera.y=clamp(this.camera.y+before[1]-after[1],0,1000);
  }
  focusBase() { this.cameraTarget=null; const p=this.state?.players.find(p=>p.id===this.me); if(p){this.camera.x=p.x+Math.sign(500-p.x)*35;this.camera.y=p.y+Math.sign(500-p.y)*35;this.camera.zoom=3.5;} }
  patternBounds(pattern) {
    let bounds=this.boundsCache.get(pattern);
    if(!bounds){let w=0,h=0;for(const [x,y] of pattern){w=Math.max(w,x+1);h=Math.max(h,y+1);}bounds={w,h};this.boundsCache.set(pattern,bounds);}
    return bounds;
  }
  placement() {
    const point=this.pointer?this.worldPoint(this.pointer.x,this.pointer.y):null;
    const bounds=this.patternBounds(this.pattern);
    const x=point?Math.floor(point[0]-(this.cardTarget?0:bounds.w/2)):null,y=point?Math.floor(point[1]-(this.cardTarget?0:bounds.h/2)):null;
    const signature=[x,y,this.boardRevision,this.me,this.baseHitRadius,this.playerCells,this.state?.status,
        ...(this.state?.players??[]).flatMap(p=>[p.id,p.x,p.y,p.eliminated,p.energy,p.cells,p.capacity,p.freeDeployBudget,p.deployMultiplier]),
        ...(this.state?.nodes??[]).map(n=>n.owner),...(this.extraLand??[])];
    const cached=this.previewCache;
    if(cached&&cached.signature.length===signature.length&&cached.signature.every((v,i)=>v===signature[i])&&cached.pattern===this.pattern&&cached.target===this.cardTarget&&cached.state===this.state)return cached.value;
    const value=this.placementUncached();this.previewCache={signature,pattern:this.pattern,target:this.cardTarget,state:this.state,value};return value;
  }
  placementUncached() {
    // 道具卡选点模式：以指针位置为中心返回目标点（不校验领地，服务器权威执行）
    if (this.cardTarget && this.pointer && this.state) {
      const [wx, wy] = this.worldPoint(this.pointer.x, this.pointer.y);
      const p = this.state.players.find(p => p.id === this.me);
      let reason = '';
      if (!p || p.eliminated || this.state.status !== 'playing') reason = '当前无法使用卡牌';
      const x = Math.floor(wx), y = Math.floor(wy), target = this.cardTarget;
      if (x < 0 || y < 0 || x >= 1000 || y >= 1000) reason = '请选择地图内的目标';
      let cells = [];
      const protectedCore = (cx, cy, margin = 0) => this.state.players.some(e => !e.eliminated && e.id !== this.me && Math.hypot(cx - e.x, cy - e.y) <= Math.max(28, this.baseHitRadius) + margin);
      if (target.kind === 'seed') {
        const ox = x - Math.floor((this.patternBounds(target.pattern).w-1) / 2), oy = y - Math.floor((this.patternBounds(target.pattern).h-1) / 2);
        cells = target.pattern.map(([dx, dy]) => [ox + dx, oy + dy]);
        if (cells.some(([cx, cy]) => cx < 0 || cy < 0 || cx >= 1000 || cy >= 1000)) reason = '播种图案超出地图';
        else if (cells.some(([cx, cy]) => this.board[cy * 1000 + cx])) reason = '播种位置已被占用';
        else if (cells.some(([cx, cy]) => protectedCore(cx, cy))) reason = '不能向敌核心保护区播种';
        else if (p && (p.cells + cells.length > (p.capacity ?? this.playerCells))) reason = '活细胞容量已满';
      }
      if (target.kind === 'nebula') {
        if (x - target.radius < 0 || y - target.radius < 0 || x + target.radius >= 1000 || y + target.radius >= 1000) reason = '星云圆域超出地图';
        else if (protectedCore(x, y, target.radius)) reason = '星云不能接触敌核心保护区';
      }
      return { x, y, pw: 1, ph: 1, valid: !reason, reason, isCard: true, radius: target.radius, cells };
    }
    if (!this.pointer || !this.pattern.length || !this.state) return null;
    const [wx,wy]=this.worldPoint(this.pointer.x,this.pointer.y), p=this.state.players.find(p=>p.id===this.me);
    const {w:pw,h:ph}=this.patternBounds(this.pattern);
    const x=Math.floor(wx-pw/2),y=Math.floor(wy-ph/2);
    let reason='';
    if(!p || p.eliminated || this.state.status!=='playing') reason='当前无法部署';
    else if(p.energy<(p.freeDeployBudget != null ? Math.max(0,this.pattern.length-p.freeDeployBudget) : Math.ceil(this.pattern.length*(p.deployMultiplier??1)))) reason='能量不足';
    else if(p.cells+this.pattern.length>(p.capacity??this.playerCells)) reason='活细胞容量已满';
    else for(const [dx,dy] of this.pattern){
      const cx=x+dx,cy=y+dy;
      if(cx<0||cy<0||cx>=1000||cy>=1000){reason='超出边界';break;}
      if(this.board[cy*1000+cx]){reason='位置已被占用';break;}
      if(!canDeployInTerritory(this.territories,this.state.players,this.state.nodes,p.id,cx,cy)&&!this.extraLand?.includes(territoryAt(this.territories,cx,cy))){reason='不在己方或获准的相邻中立分区内';break;}
      if(this.state.players.some(e=>!e.eliminated&&e.id!==p.id&&Math.hypot(cx-e.x,cy-e.y)<28)){reason='敌方核心保护区';break;}
    }
    return {x,y,pw,ph,valid:!reason,reason,cost:p?.freeDeployBudget != null ? Math.max(0,this.pattern.length-p.freeDeployBudget) : Math.ceil(this.pattern.length*(p?.deployMultiplier??1))};
  }
  effect(x,y,type='deploy',color=COLORS[this.me-1]) { this.effects.push({x,y,type,color,start:performance.now()}); }
  frame(now) {
    const traceStart = browserMetrics ? browserMetrics.now() : 0;
    if (browserMetrics && this.active) browserMetrics.record('rafInterval.ms', now - this.lastTime, this.generation);
    const dt=Math.min(.05,(now-this.lastTime)/1000);this.lastTime=now;
    if(this.active){
      this.presentNext();
      const speed=550*dt/this.camera.zoom;
      if(this.keys.has('w')||this.keys.has('arrowup')){this.cameraTarget=null;this.camera.y-=speed;}
      if(this.keys.has('s')||this.keys.has('arrowdown')){this.cameraTarget=null;this.camera.y+=speed;}
      if(this.keys.has('a')||this.keys.has('arrowleft')){this.cameraTarget=null;this.camera.x-=speed;}
      if(this.keys.has('d')||this.keys.has('arrowright')){this.cameraTarget=null;this.camera.x+=speed;}
      // 目标相机平滑跟随（帧率无关指数插值）：小地图跳转/拖动时消除生硬跳变。
      if(this.cameraTarget){
        const t=1-Math.exp(-dt*20);
        this.camera.x+=(this.cameraTarget.x-this.camera.x)*t;
        this.camera.y+=(this.cameraTarget.y-this.camera.y)*t;
        if(Math.hypot(this.cameraTarget.x-this.camera.x,this.cameraTarget.y-this.camera.y)<.1){
          this.camera.x=this.cameraTarget.x;this.camera.y=this.cameraTarget.y;this.cameraTarget=null;
        }
      }
      this.camera.x=clamp(this.camera.x,0,1000);this.camera.y=clamp(this.camera.y,0,1000);
      this.draw(now);
      this.onPresented?.(this.generation);
      if (browserMetrics) browserMetrics.record('drawnGeneration', 0, this.generation);
      if(now-(this.lastMini||0)>=100){this.drawMinimap();this.lastMini=now;}
      this.onCamera?.(this.camera);
    }
    if (browserMetrics && this.active) browserMetrics.duration('frame.ms', traceStart, this.generation);
    requestAnimationFrame(this.frame);
  }
  draw(now) {
    const c=this.ctx,w=this.width,h=this.height,z=this.camera.zoom;
    c.fillStyle='#080f16';c.fillRect(0,0,w,h);
    const [ox,oy]=this.screen(0,0),[ex,ey]=this.screen(1000,1000);
    c.fillStyle='#0b151d';c.fillRect(ox,oy,1000*z,1000*z);
    const left=Math.max(0,Math.floor(this.camera.x-w/z/2)),right=Math.min(1000,Math.ceil(this.camera.x+w/z/2));
    const top=Math.max(0,Math.floor(this.camera.y-h/z/2)),bottom=Math.min(1000,Math.ceil(this.camera.y+h/z/2));
    c.save();c.beginPath();c.rect(ox,oy,1000*z,1000*z);c.clip();
    if(this.settings.ranges&&this.state)this.drawTerritories(c,(x,y)=>this.screen(x,y),false,now);
    if(this.settings.grid){
      const step=z>=7?1:z>=2?10:50;
      c.beginPath();
      for(let x=Math.ceil(left/step)*step;x<=right;x+=step){const sx=this.screen(x,0)[0];c.moveTo(sx,Math.max(0,oy));c.lineTo(sx,Math.min(h,ey));}
      for(let y=Math.ceil(top/step)*step;y<=bottom;y+=step){const sy=this.screen(0,y)[1];c.moveTo(Math.max(0,ox),sy);c.lineTo(Math.min(w,ex),sy);}
      c.strokeStyle=z>=7?'#9bbfbd0d':'#779caa0c';c.lineWidth=.5;c.stroke();
      c.fillStyle='#476777';
      for(let x=Math.ceil(left/50)*50;x<=right;x+=50)for(let y=Math.ceil(top/50)*50;y<=bottom;y+=50){const [sx,sy]=this.screen(x,y);c.fillRect(sx-2,sy,5,.7);c.fillRect(sx,sy-2,.7,5);}
    }
    c.imageSmoothingEnabled=false;c.drawImage(this.world,ox,oy,1000*z,1000*z);
    this.drawDormancy(now);
    for (const area of this.state?.localRules || []) {
      const [x,y] = this.screen(area.x,area.y), r=area.radius*z;
      c.save();c.beginPath();c.arc(x,y,r,0,TAU);c.fillStyle='#b07cff16';c.fill();c.strokeStyle='#bc96ff';c.lineWidth=1.5;c.setLineDash([5,4]);c.stroke();
      c.font='10px Consolas, Microsoft YaHei, monospace';c.textAlign='center';c.fillStyle='#d8c1ff';c.fillText(`${area.name} · ${Math.max(0,Math.ceil((area.endsAt-this.state.serverTime)/1000))}s`,x,y-r-7);c.restore();
    }
    if(z>=7){c.strokeStyle='#08151a66';c.lineWidth=.7;c.beginPath();for(let x=left;x<=right;x++){const sx=this.screen(x,0)[0];c.moveTo(sx,0);c.lineTo(sx,h);}for(let y=top;y<=bottom;y++){const sy=this.screen(0,y)[1];c.moveTo(0,sy);c.lineTo(w,sy);}c.stroke();}
    if(this.state){for(const n of this.state.nodes)this.drawNode(n,now);for(const p of this.state.players)this.drawBase(p,now);}
    c.restore();c.strokeStyle='#3f687255';c.lineWidth=1;c.strokeRect(ox,oy,1000*z,1000*z);
    const placement=this.placement();
    if(placement){
      if(placement.isCard){
        // 道具卡选点：绘制目标半径圆环与中心标记
        const [x,y]=this.screen(placement.x,placement.y),r=placement.radius*this.camera.zoom;
        const color=placement.valid?'#b07cff':'#40545e';
        c.save();
        c.beginPath();c.arc(x,y,r,0,TAU);
        c.fillStyle=hexAlpha(color,.06);c.fill();
        c.strokeStyle=hexAlpha(color,.9);c.lineWidth=1.4;c.setLineDash([6,4]);c.stroke();c.setLineDash([]);
        c.beginPath();c.arc(x,y,3,0,TAU);c.fillStyle=color;c.fill();
        for (const [cx,cy] of placement.cells || []) { const [sx,sy]=this.screen(cx,cy);c.fillRect(sx,sy,Math.max(1,z-.8),Math.max(1,z-.8)); }
        c.font='10px Consolas, Microsoft YaHei, monospace';c.textAlign='center';c.fillStyle=color;
        c.fillText(`点击施放 · 半径 ${placement.radius} 格`,x,y-r-8);
        c.restore();
      }else{
        const color=placement.valid?COLORS[this.me-1]:COLORS[1];c.fillStyle=hexAlpha(color,.7);
        for(const [dx,dy]of this.pattern){const [x,y]=this.screen(placement.x+dx,placement.y+dy);c.fillRect(x,y,Math.max(1,z-.8),Math.max(1,z-.8));}
        const [x,y]=this.screen(placement.x,placement.y);c.strokeStyle=color;c.lineWidth=1;c.setLineDash([3,3]);c.strokeRect(x-3,y-3,placement.pw*z+5,placement.ph*z+5);c.setLineDash([]);
      }
      this.onPreview?.(placement,this.pointer);
    }else this.onPreview?.(null);
    if(this.settings.motion){
      this.effects=this.effects.filter(e=>now-e.start<850);
      for(const e of this.effects){const t=(now-e.start)/850,[x,y]=this.screen(e.x,e.y);c.beginPath();c.arc(x,y,10+t*50,0,TAU);c.strokeStyle=hexAlpha(e.color,(1-t)*.65);c.lineWidth=1.5;c.stroke();c.fillStyle=hexAlpha(e.color,(1-t)*.06);c.fill();}
    }
    c.fillStyle='#48616f';c.font='9px Consolas, monospace';c.textAlign='center';
    for(let x=Math.ceil(left/100)*100;x<=right;x+=100)c.fillText(String(x).padStart(4,'0'),this.screen(x,0)[0],h-8);
  }
  drawDormancy(now){
    const c=this.ctx,z=this.camera.zoom;
    c.save();c.lineWidth=1;c.setLineDash([4,5]);
    const pulse=this.settings.motion?.5+.5*Math.sin(now/260):.6;
    c.strokeStyle=hexAlpha('#f4cc75',.35+pulse*.3);
    c.fillStyle=hexAlpha('#f4cc75',.025+pulse*.025);
    for(const group of this.state?.dormancy||[]){
      let label=null;
      for(const tile of group.tiles){
        const wx=(tile%20)*50,wy=Math.floor(tile/20)*50;
        const[x,y]=this.screen(wx,wy),w=Math.min(50,1000-wx)*z,h=Math.min(50,1000-wy)*z;
        if(x+w<0||y+h<0||x>this.width||y>this.height)continue;
        c.fillRect(x,y,w,h);c.strokeRect(x,y,w,h);
        if(!label&&x>=0&&y>=0)label=[x+5,y+13];
      }
      if(label&&z>=1.4){
        c.save();c.setLineDash([]);c.font='10px Consolas, Microsoft YaHei, monospace';c.textAlign='left';
        const remaining=Math.max(0,group.remaining-Math.max(0,this.generation-this.state.generation));
        const text=`休眠消散 · ${remaining} 代`;
        c.fillStyle='#101b23e6';c.fillRect(label[0]-3,label[1]-11,c.measureText(text).width+6,16);
        c.fillStyle='#f4cc75';c.fillText(text,...label);c.restore();
      }
    }
    c.restore();
  }
  drawTerritories(c,project,mini=false,now=0){
    for(const region of this.territories){
      if(!region.polygon.length)continue;
      const owner=territoryOwner(region,this.state.players,this.state.nodes),color=owner?COLORS[owner-1]:'#6a8d9e';
      c.beginPath();region.polygon.forEach(([wx,wy],i)=>{const[x,y]=project(wx,wy);if(i)c.lineTo(x,y);else c.moveTo(x,y);});c.closePath();
      c.fillStyle=hexAlpha(color,owner ? (mini ? .14 : .045) : .012);c.fill();
      c.strokeStyle=hexAlpha(color,owner ? (owner===this.me ? .6 : .3) : .2);c.lineWidth=mini ? .65 : 1;
      if(!mini&&owner===this.me){c.setLineDash([7,5]);c.lineDashOffset=this.settings.motion?-now/140:0;}
      c.stroke();c.setLineDash([]);c.lineDashOffset=0;
    }
  }
  drawNode(n,now){
    const c=this.ctx,[x,y]=this.screen(n.x,n.y),z=this.camera.zoom;
    if(x< -30||y< -30||x>this.width+30||y>this.height+30)return;
    const color=n.owner?COLORS[n.owner-1]:'#68828c',r=clamp(z*5,5,14);
    c.save();c.translate(x,y);c.rotate(Math.PI/4);c.fillStyle=n.owner?hexAlpha(color,.12):'#12212a';c.strokeStyle=hexAlpha(color,.8);c.lineWidth=1;c.fillRect(-r/2,-r/2,r,r);c.strokeRect(-r/2,-r/2,r,r);c.fillStyle=color;c.fillRect(-1.5,-1.5,3,3);c.restore();
    if(n.claimant){c.beginPath();c.arc(x,y,r+7,-Math.PI/2,-Math.PI/2+TAU*Math.min(1,n.progress/this.captureTime));c.strokeStyle=COLORS[n.claimant-1];c.lineWidth=2;c.stroke();}
    if(z>1.3){c.font='8px Consolas, monospace';c.textAlign='center';c.fillStyle=hexAlpha(color,.8);c.fillText(`N-${String(n.id+1).padStart(2,'0')}`,x,y+r+18);}
    if(n.owner&&this.settings.motion){const t=((now/3000+n.id*.13)%1);c.beginPath();c.arc(x,y,r+3+t*12,0,TAU);c.strokeStyle=hexAlpha(color,(1-t)*.12);c.lineWidth=1;c.stroke();}
  }
  drawBase(p,now){
    const c=this.ctx,[x,y]=this.screen(p.x,p.y),z=this.camera.zoom,r=clamp(12*z,10,65),color=p.eliminated?'#40545e':COLORS[p.id-1];
    const extent=Math.max(r*2,this.baseHitRadius*z+100);
    if(x< -extent||y< -extent||x>this.width+extent||y>this.height+extent)return;
    c.save();c.translate(x,y);
    if(!p.eliminated){
      if (this.state.cards?.effects.some(e=>e.playerId===p.id&&e.stat==='shield')) { c.beginPath();c.arc(0,0,this.baseHitRadius*z+6,0,TAU);c.strokeStyle='#b4eaff';c.lineWidth=3;c.stroke(); }
      // This radius is deliberately not clamped: it is the actual 12-cell hit
      // boundary, independent of the decorative core icon and UI zoom level.
      const hitRadius=this.baseHitRadius*z;
      c.beginPath();c.arc(0,0,hitRadius,0,TAU);c.strokeStyle=hexAlpha(color,.88);c.lineWidth=1.3;c.stroke();
      for(let i=0;i<4;i++){const a=i*Math.PI/2;c.beginPath();c.moveTo(Math.cos(a)*(hitRadius-4),Math.sin(a)*(hitRadius-4));c.lineTo(Math.cos(a)*(hitRadius+4),Math.sin(a)*(hitRadius+4));c.stroke();}
      if(z>=1.4){c.beginPath();c.moveTo(hitRadius,0);c.lineTo(hitRadius+14,-14);c.lineTo(hitRadius+84,-14);c.strokeStyle=hexAlpha(color,.5);c.lineWidth=.7;c.stroke();c.fillStyle=color;c.font='9px Consolas, Microsoft YaHei, monospace';c.textAlign='left';c.fillText('受击范围 · '+this.baseHitRadius+' 格',hitRadius+18,-20);}
    }
    c.strokeStyle=hexAlpha(color,.2);c.lineWidth=1;c.beginPath();c.arc(0,0,r+9,0,TAU);c.stroke();
    c.save();c.rotate(this.settings.motion?now/17000:0);c.strokeStyle=hexAlpha(color,.55);c.setLineDash([r*.5,r*.22]);c.beginPath();c.arc(0,0,r+4,0,TAU);c.stroke();c.setLineDash([]);c.restore();
    c.beginPath();for(let i=0;i<6;i++){const a=i*TAU/6-Math.PI/2,xx=Math.cos(a)*r*.76,yy=Math.sin(a)*r*.76;i?c.lineTo(xx,yy):c.moveTo(xx,yy);}c.closePath();c.fillStyle=hexAlpha(color,.08);c.fill();c.strokeStyle=color;c.stroke();
    const s=r*.17;c.fillStyle=color;c.fillRect(-s,-s,2*s,2*s);c.fillStyle=hexAlpha(color,.3);c.fillRect(-s*.6,-s*2.6,s*1.2,s);c.fillRect(-s*.6,s*1.6,s*1.2,s);c.fillRect(-s*2.6,-s*.6,s,s*1.2);c.fillRect(s*1.6,-s*.6,s,s*1.2);
    if(z>1){c.font='9px Consolas, Microsoft YaHei, monospace';c.textAlign='center';c.fillStyle=color;c.fillText(p.id===this.me?'YOUR CORE':`CORE / ${p.name}`,0,-r-19);c.fillStyle='#24353e';c.fillRect(-25,r+18,50,3);c.fillStyle=color;c.fillRect(-25,r+18,50*p.hp/this.baseHP,3);c.font='8px Consolas, monospace';c.fillStyle=hexAlpha(color,.6);c.fillText(p.eliminated?'DESTROYED':`${+p.hp.toFixed(1)} / ${this.baseHP}`,0,r+34);}
    c.restore();
  }
  drawMinimap(){
    const c=this.mctx,w=this.minimap.width,s=w/1000;
    this.minimapCache.draw(this, c => {
      c.fillStyle='#08141a';c.fillRect(0,0,w,w);c.strokeStyle='#213942';c.lineWidth=.5;
      for(let i=1;i<5;i++){c.beginPath();c.moveTo(i*w/5,0);c.lineTo(i*w/5,w);c.moveTo(0,i*w/5);c.lineTo(w,i*w/5);c.stroke();}
      if(this.state){
        this.drawTerritories(c,(x,y)=>[x*s,y*s],true);
        for(const n of this.state.nodes){c.fillStyle=n.owner?COLORS[n.owner-1]:'#567787';c.fillRect(n.x*s-1,n.y*s-1,2,2);}
      }
    }, c => {
      for(const p of this.state.players){c.fillStyle=p.eliminated?'#33434a':COLORS[p.id-1];c.fillRect(p.x*s-2.5,p.y*s-2.5,5,5);}
    });
    c.strokeStyle='#b2e7d799';c.lineWidth=1;const vw=this.width/this.camera.zoom*s,vh=this.height/this.camera.zoom*s;c.strokeRect(this.camera.x*s-vw/2,this.camera.y*s-vh/2,vw,vh);
  }
}

export class Ambient {
  constructor(canvas,settings){
    this.canvas=canvas;this.ctx=canvas.getContext('2d');this.settings=settings;this.mode='home';this.points=[];
    let seed=42;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
    for(let i=0;i<3400;i++){const theta=random()*TAU,phi=Math.acos(2*random()-1),r=1+(random()-.5)*.11;this.points.push({x:r*Math.sin(phi)*Math.cos(theta),y:r*Math.cos(phi),z:r*Math.sin(phi)*Math.sin(theta),size:1+random()*2.4,brightness:random(),warm:random()>.975});}
    this.resize();window.addEventListener('resize',()=>this.resize());this.render=this.render.bind(this);requestAnimationFrame(this.render);
  }
  resize(){this.w=innerWidth;this.h=innerHeight;const dpr=Math.min(devicePixelRatio,1.5);this.canvas.width=this.w*dpr;this.canvas.height=this.h*dpr;this.ctx.setTransform(dpr,0,0,dpr,0,0);}
  render(now){
    requestAnimationFrame(this.render);
    if(this.mode==='game'||now-(this.last||0)<33)return;
    if(!this.settings.motion&&this.staticRendered===this.mode)return;
    this.last=now;this.staticRendered=this.mode;
    const c=this.ctx,w=this.w,h=this.h;c.clearRect(0,0,w,h);
    const cx=w*(w<760?.82:.752),cy=h*.45,r=Math.min(h*.29,w*.255),time=this.settings.motion?now*.000055:.4;
    const glow=c.createRadialGradient(cx,cy,r*.1,cx,cy,r*1.7);glow.addColorStop(0,'#0a302f88');glow.addColorStop(.6,'#0c242766');glow.addColorStop(1,'#080e1300');c.fillStyle=glow;c.fillRect(0,0,w,h);
    c.save();c.globalAlpha=this.mode==='home'?(w<760?.32:1):.12;
    c.strokeStyle='#457d7110';c.lineWidth=1;
    for(let x=w*.48;x<w;x+=45){c.beginPath();c.moveTo(x,120);c.lineTo(x,h*.83);c.stroke();}for(let y=130;y<h*.83;y+=45){c.beginPath();c.moveTo(w*.48,y);c.lineTo(w,y);c.stroke();}
    c.strokeStyle='#3d867b28';c.beginPath();c.arc(cx,cy,r*1.17,0,TAU);c.stroke();c.setLineDash([1,10]);c.strokeStyle='#70c8b75a';c.beginPath();c.arc(cx,cy,r*1.24,0,TAU);c.stroke();c.setLineDash([]);
    c.save();c.translate(cx,cy);c.rotate(-.45);c.strokeStyle='#7bccb233';c.beginPath();c.ellipse(0,0,r*1.52,r*.45,0,0,TAU);c.stroke();c.strokeStyle='#8bc9ae0d';c.beginPath();c.ellipse(0,0,r*1.57,r*.47,0,0,TAU);c.stroke();c.restore();
    const sin=Math.sin(time),cos=Math.cos(time),points=[];
    for(const p of this.points){const rx=p.x*cos+p.z*sin,rz=p.z*cos-p.x*sin;const tiltY=p.y*.91-rz*.35,z=p.y*.35+rz*.91;points.push({...p,sx:cx+rx*r,sy:cy+tiltY*r,z});}
    points.sort((a,b)=>a.z-b.z);
    for(const p of points){const visibility=(p.z+1.15)/2.3,alpha=.05+visibility*visibility*(.16+p.brightness*.67),s=p.size*(.6+visibility*.65);c.fillStyle=p.warm?`rgba(226,169,107,${alpha})`:`rgba(${p.brightness>.9?157:76},${p.brightness>.9?250:188},${p.brightness>.9?214:167},${alpha})`;c.fillRect(p.sx,p.sy,s,s);if(p.brightness>.997&&p.z>0){c.fillStyle='#a2ffe233';c.fillRect(p.sx-3,p.sy-3,s+6,s+6);}}
    for(let i=0;i<4;i++){const a=i*TAU/4+.2,x=cx+Math.cos(a)*r*1.24,y=cy+Math.sin(a)*r*1.24;c.strokeStyle='#7ed6b666';c.beginPath();c.moveTo(x-4,y);c.lineTo(x+4,y);c.moveTo(x,y-4);c.lineTo(x,y+4);c.stroke();}
    const orbit=time*1.5,px=cx+Math.cos(orbit)*r*1.45,py=cy+Math.sin(orbit)*r*.45;c.fillStyle='#a0e7d3';c.fillRect(px-2,py-2,4,4);c.strokeStyle='#7baf9c4d';c.strokeRect(px-6,py-6,12,12);
    c.font='8px Consolas, monospace';c.fillStyle='#669c9180';c.fillText('B3 / S23',cx-r*1.27,cy-r*.84);c.fillText('GEN '+String(Math.floor(now/110)).padStart(6,'0'),cx+r*.55,cy+r*.98);
    c.restore();
    const fade=c.createLinearGradient(w*.28,0,w*.65,0);fade.addColorStop(0,'#080e13');fade.addColorStop(1,'#080e1300');c.fillStyle=fade;c.fillRect(0,0,w*.68,h);
  }
}
