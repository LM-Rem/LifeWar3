import { PATTERNS, PATTERN_CATEGORIES, setPatternData, transform, normalize, parseRLE, toRLE } from './patterns.js';
import { Battlefield, Ambient, COLORS, drawPattern } from './renderer.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const readStorage = (key, fallback, storage = localStorage) => { try { return JSON.parse(storage.getItem(key)) ?? fallback; } catch { return fallback; } };
const saveStorage = (key, value, storage = localStorage) => { try { storage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };
const icons = {
  settings: '<path d="m9 3 1-2h4l1 2 2 1 2-.1 2 3-1 2v2l1 2-2 3-2-.1-2 1-1 2h-4l-1-2-2-1-2 .1-2-3 1-2V9L3 7l2-3 2 .1Z"/><circle cx="12" cy="10.5" r="3"/>',
  grid: '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/>',
  network: '<rect x="9" y="2" width="6" height="6"/><rect x="2" y="16" width="6" height="6"/><rect x="16" y="16" width="6" height="6"/><path d="M12 8v4H5v4m7-4h7v4"/>',
  cells: '<rect x="9" y="2" width="5" height="5"/><rect x="16" y="9" width="5" height="5"/><rect x="2" y="16" width="5" height="5"/><rect x="9" y="16" width="5" height="5"/><rect x="16" y="16" width="5" height="5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3v.1"/>',
  volume: '<path d="M4 9h4l5-4v14l-5-4H4Z"/><path d="M16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  muted: '<path d="M4 9h4l5-4v14l-5-4H4Z"/><path d="m17 9 5 6m0-6-5 6"/>',
  exit: '<path d="M10 4H4v16h6m4-13 5 5-5 5m-6-5h11"/>',
  panels: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M8 4v16m0-5h13"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.cells}</svg>`;
$$('[data-icon]').forEach(el => el.innerHTML = icon(el.dataset.icon));
const settings = { grid: true, ranges: true, motion: !matchMedia('(prefers-reduced-motion: reduce)').matches, sound: false, ...readStorage('lifewar.settings', {}) };
const ambient = new Ambient($('#ambient'), settings);
const battlefield = new Battlefield($('#battlefield'), $('#minimap'), settings);
let page = 'home', room = null, playerId = 1, state = null, socket = null, connectionPromise = null;
let reconnectTimer, retries = 0, latency = 0, pendingAutoJoin = new URLSearchParams(location.search).get('room');
let session = readStorage('lifewar.session', null, sessionStorage);
let customPatterns = readStorage('lifewar.patterns', []).filter(p => Array.isArray(p.cells) && p.cells.length > 0 && p.cells.length <= 4096 && p.cells.every(c=>Array.isArray(c)&&c.length===2&&c.every(n=>Number.isInteger(n)&&n>=0&&n<128))).slice(0,30);
let allPatterns = [...PATTERNS, ...customPatterns], selected = allPatterns[0] || null, rotation = 0, flipped = false, lanAddress = location.origin, resultShown = false, currentCategory = 'all';
let maxHP = 240; // 基地耐久上限，开局时从服务端 rules.baseHP 读取（config.json 可配置）
let maxEnergy = 180; // 能量上限，开局时从服务端 rules.maxEnergy 读取（config.json 可配置）
let energyRegen = 0.5; // 每代基础能量回复，开局时从 rules.regen 读取（config.json 可配置）
let energyNodeRegen = 0.1; // 每占领一个节点每代额外回复，开局时从 rules.nodeRegen 读取（config.json 可配置）
let eventIds = new Set(), editorCells = new Set(), editingId = null;
const transformState = new Map();
let gameHz = 10; // 服务器实际演化频率（代/秒），开局时从 rules 获取
let startedAt = 0; // 对局开始时间（服务器时间戳），用于真实时间计时
let lastDormancyThreshold = null; // 最近一次状态中的休眠清理阈值，用于检测衰减
let dormancyNoticeTimer = null;   // 休眠阈值衰减提示横幅的显示时长定时器
let dormancyFadeTimer = null;     // 休眠阈值衰减提示横幅的退场动画定时器
$('#commander-name').value = readStorage('lifewar.name', '指挥官');

function toast(message, error = false) {
  const el = document.createElement('div'); el.className = 'toast' + (error ? ' error' : ''); el.textContent = message;
  const dialog = $$('dialog[open]').at(-1); (dialog || $('#toasts')).append(el);
  setTimeout(() => { el.classList.add('exiting'); setTimeout(() => el.remove(), 250); }, 3400);
}
function showDormancyNotice(from, to) {
  const el = $('#notice-banner');
  el.textContent = `休眠清理阈值：${from} → ${to} 代`;
  el.classList.remove('hidden', 'fade-out');
  void el.offsetWidth; // 强制重排，确保每次触发都重新播放入场动画
  clearTimeout(dormancyNoticeTimer);
  clearTimeout(dormancyFadeTimer);
  dormancyNoticeTimer = setTimeout(() => {
    el.classList.add('fade-out'); // 先播放退场动画
    dormancyFadeTimer = setTimeout(() => el.classList.add('hidden'), 300); // 动画结束后再隐藏
  }, 3000);
}
function showPage(next) {
  page = next; $$('.screen').forEach(el => el.classList.toggle('active', el.id === next));
  ambient.mode = next; ambient.staticRendered = null; battlefield.active = next === 'game';
  if(next === 'game') { battlefield.resize(); document.body.style.overflow = 'hidden'; }
  else document.body.style.overflow = '';
}
function openDialog(id) { battlefield.keys.clear(); battlefield.pointer = null; const dialog=$(id); if(!dialog.open)dialog.showModal(); }
function closeDialogs(){ $$('dialog[open]').forEach(d=>d.close()); }
$$('.close-dialog').forEach(el => el.addEventListener('click', () => el.closest('dialog').close()));
$('#result-dialog').addEventListener('cancel', e => e.preventDefault());
$$('dialog').forEach(dialog => dialog.addEventListener('click', e => { if(e.target === dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)if(!['result-dialog','confirm-dialog'].includes(dialog.id))dialog.close();} }));
$$('[data-action="help"]').forEach(el=>el.onclick=()=>openDialog('#help-dialog'));
$$('[data-action="settings"]').forEach(el=>el.onclick=()=>openDialog('#settings-dialog'));
$$('[data-action="home"]').forEach(el=>el.onclick=()=>{if(room){toast('请先离开当前战区');return;}showPage('home');});
$$('[data-action="library"]').forEach(el=>el.onclick=()=>{location.href='/library.html';});
$('.brand[href="#"]').onclick=e=>{e.preventDefault();showPage('home');};

// 生命图谱面板：可拖拽调整宽度（记忆上次宽度）
const arsenalPanel = document.querySelector('.arsenal-panel');
const arsenalResize = $('#arsenal-resize');
if (arsenalPanel && arsenalResize) {
  const saved = localStorage.getItem('arsenal-width');
  if (saved) arsenalPanel.style.width = `${Math.min(Math.max(+saved, 600), window.innerWidth - 40)}px`;
  let resizing = false;
  arsenalResize.addEventListener('pointerdown', e => {
    resizing = true;
    arsenalResize.classList.add('active');
    arsenalResize.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  window.addEventListener('pointermove', e => {
    if (!resizing) return;
    const w = Math.max(600, Math.min(window.innerWidth - 40, e.clientX - arsenalPanel.getBoundingClientRect().left));
    arsenalPanel.style.width = `${w}px`;
  });
  const stopResize = () => {
    if (!resizing) return;
    resizing = false;
    arsenalResize.classList.remove('active');
    localStorage.setItem('arsenal-width', parseInt(arsenalPanel.style.width, 10));
  };
  window.addEventListener('pointerup', stopResize);
  window.addEventListener('pointercancel', stopResize);
}

// 图案列表：光标悬停时，鼠标滚轮横向滚动列表
const patternListEl = $('#pattern-list');
if (patternListEl) {
  patternListEl.addEventListener('wheel', e => {
    if (!e.deltaY && !e.deltaX) return;
    e.preventDefault();
    patternListEl.scrollLeft += e.deltaY + e.deltaX;
  }, { passive: false });
}

let audioContext;
function sound(type='click') {
  if(!settings.sound)return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if(audioContext.state==='suspended')audioContext.resume();
    const o=audioContext.createOscillator(),g=audioContext.createGain(),t=audioContext.currentTime;
    o.type='sine';o.frequency.setValueAtTime(type==='deploy'?420:type==='capture'?660:300,t);o.frequency.exponentialRampToValueAtTime(type==='capture'?1100:170,t+.12);g.gain.setValueAtTime(.035,t);g.gain.exponentialRampToValueAtTime(.001,t+.2);o.connect(g).connect(audioContext.destination);o.start(t);o.stop(t+.22);
  } catch { /* Audio is optional. */ }
}
function syncSettings() {
  for(const name of ['grid','ranges','motion','sound'])$('#setting-'+name).checked=!!settings[name];
  document.body.classList.toggle('no-motion',!settings.motion); $('#toggle-sound').innerHTML=icon(settings.sound?'volume':'muted');$('#toggle-sound').setAttribute('aria-pressed',String(settings.sound));
  ambient.staticRendered=null;saveStorage('lifewar.settings',settings);
}
for(const name of ['grid','ranges','motion','sound'])$('#setting-'+name).onchange=e=>{settings[name]=e.target.checked;syncSettings();sound();};
$('#toggle-sound').onclick=()=>{settings.sound=!settings.sound;syncSettings();sound();};syncSettings();

async function connect() {
  if(socket?.readyState===WebSocket.OPEN)return;
  if(connectionPromise)return connectionPromise;
  clearTimeout(reconnectTimer);
  connectionPromise=new Promise((resolve,reject)=>{
    const ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws`);socket=ws;ws.binaryType='arraybuffer';
    ws.onopen=()=>{connectionPromise=null;retries=0;$('#connection-status').textContent='已连接 · 局域网服务器';$('#connection-banner').classList.add('hidden');if(session)ws.send(JSON.stringify({type:'resume',...session}));resolve();};
    ws.onmessage=e=>{if(e.data instanceof ArrayBuffer)battlefield.updatePacket(e.data);else{try{onMessage(JSON.parse(e.data));}catch(err){console.error('Message error',err);}}};
    ws.onerror=()=>{if(ws.readyState!==WebSocket.OPEN)reject(new Error('无法连接服务器，请确认服务器仍在运行'));};
    ws.onclose=e=>{
      connectionPromise=null;$('#connection-status').textContent='服务器连接中断';
      if(e.code===4001){session=null;saveStorage('lifewar.session',null,sessionStorage);toast('此会话已在其他页面恢复',true);showPage('lobby');return;}
      if(page==='game')$('#connection-banner').classList.remove('hidden');
      reconnectTimer=setTimeout(()=>connect().catch(()=>{}),Math.min(8000,700*2**retries++));
      reject(new Error('服务器连接中断'));
    };
  });
  return connectionPromise;
}
async function send(message) { try { await connect();socket.send(JSON.stringify(message)); }catch(e){toast(e.message,true);} }
const getName=()=>{const name=$('#commander-name').value.trim()||'指挥官';saveStorage('lifewar.name',name);return name;};
function onMessage(msg) {
  switch(msg.type){
    case 'hello':break;
    case 'rooms': renderRooms(msg.rooms); break;
    case 'welcome': playerId=msg.id;session={code:msg.code,token:msg.token};saveStorage('lifewar.session',session,sessionStorage);break;
    case 'room':room=msg;renderRoom();if(msg.status==='lobby')showPage('lobby');break;
    case 'started':
      playerId=msg.id;if(msg.rules?.hz)gameHz=msg.rules.hz;if(msg.rules?.baseHP){maxHP=msg.rules.baseHP;battlefield.baseHP=maxHP;}if(msg.rules?.maxEnergy)maxEnergy=msg.rules.maxEnergy;if(msg.rules?.regen)energyRegen=msg.rules.regen;if(msg.rules?.nodeRegen)energyNodeRegen=msg.rules.nodeRegen;if(msg.rules?.playerCells)battlefield.playerCells=msg.rules.playerCells;if(msg.rules?.maxCells)battlefield.maxCells=msg.rules.maxCells;if(msg.rules?.baseHitRadius)battlefield.baseHitRadius=msg.rules.baseHitRadius;if(msg.rules?.captureTime)battlefield.captureTime=msg.rules.captureTime;startedAt=msg.startedAt||Date.now();battlefield.me=playerId;battlefield.reset();eventIds.clear();resultShown=false;state=null;closeDialogs();showPage('game');renderPatterns();if(selected)selectPattern(selected);sound('capture');break;
    case 'state':{
      const first=!state;
      if(!first&&typeof msg.dormancyThreshold==='number'&&lastDormancyThreshold!==null&&msg.dormancyThreshold<lastDormancyThreshold){
        showDormancyNotice(lastDormancyThreshold,msg.dormancyThreshold);
      }
      if(typeof msg.dormancyThreshold==='number')lastDormancyThreshold=msg.dormancyThreshold;
      state=msg;battlefield.setState(state);
      if(first)battlefield.focusBase();updateGameHUD();break;
    }
    case 'deployed':battlefield.effect(msg.x,msg.y);sound('deploy');if(state){const me=state.players.find(p=>p.id===playerId);if(me)me.energy=Math.max(0,me.energy-msg.cost);}break;
    case 'error':toast(msg.message,true);break;
    case 'pong':latency=Math.max(0,Date.now()-msg.time);$('#ping').textContent=latency+' ms';break;
    case 'resume_failed':session=null;room=null;saveStorage('lifewar.session',null,sessionStorage);if(page==='game'){showPage('lobby');toast('原对局已结束或服务器已重启',true);}renderRoom();break;
    case 'left':session=null;room=null;state=null;saveStorage('lifewar.session',null,sessionStorage);closeDialogs();showPage('lobby');renderRoom();send({type:'list'});break;
    case 'lobby':state=null;closeDialogs();showPage('lobby');break;
  }
}
async function loadInfo(){try{const info=await fetch('/api/info').then(r=>r.json());lanAddress=info.publicUrl||location.origin;if(!info.publicUrl&&['localhost','127.0.0.1'].includes(location.hostname))lanAddress=info.addresses.find(a=>/\/\/192\.168\./.test(a))||info.addresses.find(a=>/\/\/10\./.test(a))||info.addresses[0]||location.origin;$('#lan-address').textContent=lanAddress;}catch{$('#lan-address').textContent=location.origin;}}
loadInfo();connect().catch(()=>{});
setInterval(()=>{if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'ping',time:Date.now()}));},2500);
setInterval(()=>{if(page==='game'&&startedAt&&state?.status==='playing')$('#match-time').textContent=formatClock(Date.now()-startedAt);},1000);
$('#enter-lobby').onclick=()=>{showPage('lobby');send({type:'list'});};
$('#practice').onclick=()=>{if(room){toast('请先离开现有战区');return;}send({type:'create',name:getName(),practice:true});};
$('#create-room').onclick=()=>send({type:'create',name:getName()});
$('#join-room').onclick=()=>{const code=$('#join-code').value.trim().toUpperCase();if(!/^[A-F0-9]{6}$/.test(code)){toast('请输入 6 位有效房间码',true);return;}send({type:'join',name:getName(),code});};
$('#join-code').addEventListener('keydown',e=>{if(e.key==='Enter')$('#join-room').click();});
$('#refresh-rooms').onclick=()=>send({type:'list'});
$('#leave-room').onclick=()=>send({type:'leave'});
$('#add-bot').onclick=()=>send({type:'bot'});
$('#start-game').onclick=()=>send({type:'start'});
$('#ready-game').onclick=()=>send({type:'ready'});
$('#rematch').onclick=()=>send({type:'rematch'});
$('#result-leave').onclick=()=>send({type:'leave'});
$('#exit-game').onclick=()=>{if(state?.status==='finished')send({type:'leave'});else openDialog('#confirm-dialog');};
$('#confirm-exit').onclick=()=>send({type:'leave'});
async function copy(text){try{if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(text);else{const input=document.createElement('textarea');input.value=text;input.style.position='fixed';input.style.opacity='0';document.body.append(input);input.select();const ok=document.execCommand('copy');input.remove();if(!ok)throw new Error();}toast('已复制到剪贴板');}catch{toast('自动复制不可用，请手动复制：'+text,true);}}
$('#copy-address').onclick=()=>copy(lanAddress);
$('#copy-room').onclick=()=>copy(`${lanAddress}/?room=${room.code}`);
if(pendingAutoJoin){$('#join-code').value=pendingAutoJoin.toUpperCase();showPage('lobby');toast('邀请已载入，填写呼号后点击加入战区');}

function renderRooms(rooms){
  $('#room-list').innerHTML=rooms.length?rooms.map(r=>`<button class="room-entry" data-code="${escapeHTML(r.code)}" ${r.status!=='lobby'||r.count>=4?'disabled':''}><div><strong>${escapeHTML(r.name)}</strong><small>SECTOR ${escapeHTML(r.code)}</small></div><span>${r.status==='lobby'?'等待接入':r.status==='finished'?'战斗结束':'作战中'}</span><span>${r.count} / 4　↗</span></button>`).join(''):`<div class="empty-rooms">${icon('network')}<strong>静谧的星域，等待第一位指挥官。</strong><p>创建一个战区，或输入朋友分享的房间码。</p></div>`;
  $$('.room-entry').forEach(b=>b.onclick=()=>send({type:'join',code:b.dataset.code,name:getName()}));
}
function renderRoom(){
  $('#room-browser').classList.toggle('hidden',!!room);$('#room-detail').classList.toggle('hidden',!room);$('#commander-name').disabled=!!room;
  if(!room)return;
  $('#room-code').textContent=room.code;
  const host=room.host===playerId;
  $('#player-slots').innerHTML=Array.from({length:4},(_,i)=>{
    const p=room.players[i];if(!p)return `<div class="player-slot slot-empty"><span class="slot-icon" style="--player:#46606b">+</span><span>等待指挥官接入 <span class="micro">/ OPEN SLOT</span></span></div>`;
    return `<div class="player-slot" style="--player:${COLORS[p.id-1]}"><span class="slot-icon">0${i+1}</span><span class="slot-info"><strong>${escapeHTML(p.name)} ${p.id===playerId?'<span class="micro"> / 你</span>':''}</strong><small>${p.id===room.host?'HOST / 房主':p.bot?'TACTICAL AI':'COMMANDER'}</small></span><span class="slot-ready">${!p.connected?'连接中断':p.ready?'● 已就绪':'○ 准备中'}</span>${host&&p.bot?`<button class="icon-button remove-bot" data-id="${p.id}" aria-label="移除 AI">×</button>`:''}</div>`;
  }).join('');
  $$('.remove-bot').forEach(b=>b.onclick=()=>send({type:'remove_bot',id:Number(b.dataset.id)}));
  $('#start-game').classList.toggle('hidden',!host);$('#ready-game').classList.toggle('hidden',host);$('#add-bot').classList.toggle('hidden',!host);
  $('#start-game').disabled=room.players.length<2||room.players.some(p=>!p.ready||!p.connected);$('#add-bot').disabled=room.players.length>=4;
  $('#ready-game').textContent=room.players.find(p=>p.id===playerId)?.ready?'取消准备':'准备就绪 ✓';
  $('#room-guidance').textContent=host?'等待所有玩家准备就绪。你也可以添加 AI 进行模拟对抗。':'完成准备后，等待房主启动对局。';
}

function visiblePatterns(){
  if(currentCategory==='all')return[...PATTERNS,...customPatterns];
  if(currentCategory==='custom')return customPatterns;
  return PATTERNS.filter(p=>(p.category||'other')===currentCategory);
}
function renderCategoryTags(){
  const tags=[{id:'all',name:'全部'},...PATTERN_CATEGORIES,{id:'custom',name:'自定义'}];
  $('#pattern-categories').innerHTML=tags.map(t=>`<button class="category-tag ${t.id===currentCategory?'active':''}" data-category="${escapeHTML(t.id)}">${escapeHTML(t.name)}</button>`).join('');
  $$('.category-tag').forEach(b=>b.onclick=()=>{currentCategory=b.dataset.category;renderCategoryTags();renderPatterns();sound();});
}
function cycleCategory(delta){
  const tags=[{id:'all',name:'全部'},...PATTERN_CATEGORIES,{id:'custom',name:'自定义'}];
  const idx=tags.findIndex(t=>t.id===currentCategory);
  currentCategory=tags[(idx+delta+tags.length)%tags.length].id;
  renderCategoryTags();renderPatterns();sound();
}
function renderPatterns(){
  allPatterns=visiblePatterns();
  $('#pattern-list').innerHTML=allPatterns.map((p,i)=>`<button class="pattern-card ${selected&&p.id===selected.id?'selected':''}" data-pattern="${escapeHTML(p.id)}" title="${escapeHTML(p.desc)}"><span class="shortcut">${i<7?i+1:'C'}</span><canvas width="118" height="94"></canvas><strong>${escapeHTML(p.name)}</strong><span class="pattern-cost">${p.cells.length} EN</span></button>`).join('');
  $$('.pattern-card').forEach((b,i)=>{drawPattern(b.querySelector('canvas'),allPatterns[i].cells,COLORS[playerId-1]);b.onclick=()=>{selectPattern(allPatterns[i]);sound();};});
}
function selectPattern(pattern,keepTransform=false){
  if(selected)transformState.set(selected.id,{rotation,flipped});
  selected=pattern;
  const st=transformState.get(pattern.id);
  rotation=st?st.rotation:0;
  flipped=st?st.flipped:false;
  battlefield.pattern=transform(selected.cells,rotation,flipped);
  $('#selected-name').textContent=selected.name;$('#selected-en').textContent=selected.en;$('#selected-role').textContent=selected.role;$('#selected-description').textContent=selected.desc;$('#selected-cost').textContent=selected.cells.length;
  $('#transform-label').textContent=`${rotation*90}° / ${flipped?'镜像':'正向'}`;
  drawPattern($('#selected-preview'),battlefield.pattern,COLORS[playerId-1]);
  $('.range-legend').style.color=COLORS[playerId-1];
  $('.range-legend i').style.borderColor=COLORS[playerId-1];
  $('.range-legend i').style.background=COLORS[playerId-1]+'1a';
  $$('.pattern-card').forEach(b=>{b.classList.toggle('selected',b.dataset.pattern===selected.id);b.setAttribute('aria-pressed',String(b.dataset.pattern===selected.id));});
  if(page==='game')$('.pattern-card.selected')?.scrollIntoView({block:'nearest',inline:'nearest',behavior:settings.motion?'smooth':'instant'});
}
$('#rotate-pattern').onclick=()=>{rotation=(rotation+1)%4;selectPattern(selected,true);sound();};
$('#flip-pattern').onclick=()=>{flipped=!flipped;selectPattern(selected,true);sound();};
async function initPatterns(){
  try{
    const data=await fetch('/patterns.json').then(r=>r.json());
    setPatternData(data);
  }catch(err){console.error('加载 patterns.json 失败',err);}
  allPatterns=[...PATTERNS,...customPatterns];
  selected=allPatterns[0]||null;
  renderCategoryTags();renderPatterns();
  if(selected)selectPattern(selected);
}
initPatterns();

function formatTime(generation){const seconds=Math.floor(generation/(gameHz||10));return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;}
function formatClock(ms){const total=Math.max(0,Math.floor(ms/1000));return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`;}
function updateGameHUD(){
  const me=state.players.find(p=>p.id===playerId);if(!me)return;
  $('#territory-summary').textContent=`${state.nodes.length} 个中继节点 · ${state.nodes.length+state.players.length} 块领地`;
  $('#match-time').textContent=startedAt?formatClock(Date.now()-startedAt):formatTime(state.generation);$('#generation').textContent='GEN '+String(state.generation).padStart(6,'0');
  $('#energy-number').textContent=Math.floor(me.energy);$('#energy-max').textContent=maxEnergy;$('#energy-regen').textContent=`+${me.eliminated?0:parseFloat((energyRegen+me.nodes*energyNodeRegen).toFixed(2))} / GEN`;$('#energy-meter').style.width=(me.energy/maxEnergy*100)+'%';
  $('#battle-players').innerHTML=state.players.map(p=>`<div class="battle-player ${p.eliminated?'eliminated':''}" style="--player:${COLORS[p.id-1]}"><div class="battle-player-top"><i class="player-dot"></i><span>${escapeHTML(p.name)}</span>${p.id===playerId?'<span class="you-tag">YOU</span>':''}<span>${p.eliminated?'OUT':p.hp+' HP'}</span></div><div class="hp-meter"><i style="width:${p.hp/maxHP*100}%"></i></div><div class="player-metrics"><span>◈ ${p.nodes} NODES</span><span>${p.cells.toLocaleString()} CELLS</span></div></div>`).join('');
  for(const event of state.events){const id=`${event.generation}/${event.type}/${event.player}/${event.text}`;if(eventIds.has(id))continue;eventIds.add(id);
    if(event.type==='damage'){const p=state.players.find(p=>p.id===event.player);if(p)battlefield.effect(p.x,p.y,'damage',COLORS[1]);if(event.player===playerId&&!(state.generation%Math.max(1,Math.round(gameHz))))toast('警报：你的基地正在受到攻击',true);continue;}
    const div=document.createElement('div');div.className='event-item';div.innerHTML=`<time>${startedAt&&event.time?formatClock(event.time-startedAt):formatTime(event.generation)}</time><span style="color:${COLORS[event.player-1]||'#9ab0ba'}">${escapeHTML(event.text)}</span>`;$('#event-feed').prepend(div);while($('#event-feed').children.length>4)$('#event-feed').lastChild.remove();
    if(event.type==='capture'&&event.player===playerId)sound('capture');
    if(event.type==='eliminated'&&event.player===playerId)toast('你的核心已被摧毁。可继续观察战场。',true);
  }
  if(state.status==='finished'&&!resultShown){
    resultShown=true;const winner=state.players.find(p=>p.id===state.winner),won=state.winner===playerId;
    $('#result-title').textContent=won?'你定义了生命的终局。':state.winner?'核心已沉寂，演化仍继续。':'最后的生命归于寂静。';
    $('#result-description').textContent=won?'所有敌方核心已被摧毁。这个星域，属于你。':winner?`${winner.name} 成为最后存活的指挥官。`:'所有核心均已被摧毁，本局平局。';
    $('#result-stats').innerHTML=`<div><strong>${startedAt?formatClock(Date.now()-startedAt):formatTime(state.generation)}</strong><small>对局时长</small></div><div><strong>${state.generation.toLocaleString()}</strong><small>演化代数</small></div><div><strong>${me.nodes}</strong><small>控制节点</small></div>`;
    $('#rematch').classList.toggle('hidden',room?.host!==playerId);closeDialogs();openDialog('#result-dialog');sound('capture');
  }
}

// Map interactions use exact integer cells; the authoritative server revalidates every deployment.
// 支持鼠标（滚轮缩放、右键拖动）与触屏（单指拖动、双指捏合缩放/平移）。
const canvas=$('#battlefield');
const pointers=new Map(); // 当前按下指针 pointerId -> {x,y}
let drag=null,pinch=null,multiTouch=false;
canvas.addEventListener('contextmenu',e=>e.preventDefault());
canvas.addEventListener('pointerdown',e=>{
  if(e.button!==0&&e.button!==2&&e.button!==1)return;
  canvas.focus();
  battlefield.cameraTarget=null; // 主画布直接拖动/部署时立即响应，取消平滑目标
  pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  try{canvas.setPointerCapture(e.pointerId);}catch{}
  if(pointers.size===2){
    const [a,b]=[...pointers.values()];
    pinch={dist:Math.hypot(a.x-b.x,a.y-b.y),midX:(a.x+b.x)/2,midY:(a.y+b.y)/2};
    drag=null;battlefield.pointer=null;multiTouch=true;
  }else if(pointers.size===1){
    drag={x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,button:e.button,moved:false,touch:e.pointerType==='touch'};
    battlefield.pointer={x:e.clientX,y:e.clientY};if(e.button!==0)canvas.style.cursor='grabbing';
  }
});
canvas.addEventListener('pointermove',e=>{
  if(!pointers.has(e.pointerId)){
    // 鼠标悬停（未按下）时也更新预览位置，让图案预览与提示跟随光标。
    if(!pointers.size&&!drag&&e.pointerType==='mouse')battlefield.pointer={x:e.clientX,y:e.clientY};
    return;
  }
  pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(pointers.size===2){
    const [a,b]=[...pointers.values()];
    const dist=Math.hypot(a.x-b.x,a.y-b.y),midX=(a.x+b.x)/2,midY=(a.y+b.y)/2;
    if(pinch&&pinch.dist>0){
      battlefield.zoom(dist/pinch.dist,midX,midY);
      battlefield.camera.x-= (midX-pinch.midX)/battlefield.camera.zoom;
      battlefield.camera.y-= (midY-pinch.midY)/battlefield.camera.zoom;
      battlefield.camera.x=Math.max(0,Math.min(1000,battlefield.camera.x));
      battlefield.camera.y=Math.max(0,Math.min(1000,battlefield.camera.y));
    }
    pinch={dist,midX,midY};drag=null;battlefield.pointer=null;multiTouch=true;
    return;
  }
  if(drag){
    const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
    if(Math.hypot(e.clientX-drag.startX,e.clientY-drag.startY)>4)drag.moved=true;
    if(drag.moved){battlefield.camera.x-=dx/battlefield.camera.zoom;battlefield.camera.y-=dy/battlefield.camera.zoom;battlefield.pointer=null;}
    else battlefield.pointer={x:e.clientX,y:e.clientY};
    drag.x=e.clientX;drag.y=e.clientY;
  }else battlefield.pointer={x:e.clientX,y:e.clientY};
});
canvas.addEventListener('pointerup',e=>{
  pointers.delete(e.pointerId);
  if(pointers.size===1){
    // 双指抬起一指：用剩余指针恢复单指拖动，但标记为已移动，避免误触发部署。
    const [p]=[...pointers.values()];
    drag={x:p.x,y:p.y,startX:p.x,startY:p.y,button:0,moved:multiTouch,touch:true};
    pinch=null;battlefield.pointer=null;
  }else if(pointers.size===0){
    if(!multiTouch&&drag&&!drag.moved){
      if(drag.button===0){
        const place=battlefield.placement();
        if(place?.valid)send({type:'deploy',x:place.x,y:place.y,cells:battlefield.pattern});
        else if(place)toast(place.reason,true);
      }else if(drag.button===2){
        // 右键点击（未移动即松开）：旋转当前图案。
        $('#rotate-pattern').click();
      }
    }
    drag=null;pinch=null;multiTouch=false;canvas.style.cursor='crosshair';
  }
  if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);
});
canvas.addEventListener('pointercancel',e=>{
  pointers.delete(e.pointerId);
  if(pointers.size===0){drag=null;pinch=null;multiTouch=false;canvas.style.cursor='crosshair';}
  if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);
});
canvas.addEventListener('pointerleave',()=>{if(!drag&&pointers.size===0)battlefield.pointer=null;});
canvas.addEventListener('wheel',e=>{e.preventDefault();battlefield.zoom(Math.exp(-e.deltaY*.0014),e.clientX,e.clientY);},{passive:false});
// 战术总览小地图：点击跳转 + 拖动连续移动视角（Pointer Events，支持鼠标与触屏）。
const minimap=$('#minimap');
let minimapDrag=null,minimapRect=null;
minimap.addEventListener('pointerdown',e=>{
  // 缓存小地图尺寸，拖动过程中复用，避免每次 getBoundingClientRect 强制布局导致卡顿。
  minimapRect=minimap.getBoundingClientRect();
  minimapDrag={id:e.pointerId};
  // 设置平滑目标相机，由渲染循环插值跟随，避免视图生硬跳变。
  battlefield.cameraTarget={x:Math.max(0,Math.min(1000,(e.clientX-minimapRect.left)/minimapRect.width*1000)),y:Math.max(0,Math.min(1000,(e.clientY-minimapRect.top)/minimapRect.height*1000))};
  try{minimap.setPointerCapture(e.pointerId);}catch{}
});
minimap.addEventListener('pointermove',e=>{
  if(!minimapDrag||minimapDrag.id!==e.pointerId||!minimapRect)return;
  battlefield.cameraTarget={x:Math.max(0,Math.min(1000,(e.clientX-minimapRect.left)/minimapRect.width*1000)),y:Math.max(0,Math.min(1000,(e.clientY-minimapRect.top)/minimapRect.height*1000))};
});
const endMinimapDrag=e=>{
  if(!minimapDrag||minimapDrag.id!==e.pointerId)return;
  minimapDrag=null;
  try{minimap.releasePointerCapture(e.pointerId);}catch{}
};
minimap.addEventListener('pointerup',endMinimapDrag);
minimap.addEventListener('pointercancel',endMinimapDrag);
$('#home-camera').onclick=()=>battlefield.focusBase();$('#zoom-in').onclick=()=>battlefield.zoom(1.3);$('#zoom-out').onclick=()=>battlefield.zoom(1/1.3);

// 浮动面板自由拖动：战术总览（小地图）、地图控制条。按住面板头部任意位置拖动，用 transform 平移，不破坏原有定位。
function makePanelDraggable(handle, panel, ignore) {
  let state = null;
  let moved = false;
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.pointerType !== 'touch') return;
    if (ignore && ignore(e)) return;
    e.stopPropagation();
    let ox = 0, oy = 0;
    const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(panel.style.transform || '');
    if (m) { ox = parseFloat(m[1]); oy = parseFloat(m[2]); }
    state = { id: e.pointerId, startX: e.clientX, startY: e.clientY, ox, oy, moved: false };
    moved = false;
    try { handle.setPointerCapture(e.pointerId); } catch {}
  });
  handle.addEventListener('pointermove', e => {
    if (!state || state.id !== e.pointerId) return;
    const dx = e.clientX - state.startX, dy = e.clientY - state.startY;
    if (Math.hypot(dx, dy) > 3) state.moved = true;
    if (state.moved) panel.style.transform = `translate(${state.ox + dx}px, ${state.oy + dy}px)`;
  });
  const end = e => {
    if (!state || state.id !== e.pointerId) return;
    moved = state.moved;
    state = null;
    try { handle.releasePointerCapture(e.pointerId); } catch {}
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  // 仅在实际拖动后拦截点击，保证头部按钮（折叠/缩放/隐藏界面）仍可正常点击。
  handle.addEventListener('click', e => {
    if (moved) {
      e.stopImmediatePropagation();
      e.preventDefault();
      moved = false;
    }
  });
}
makePanelDraggable($('.minimap-panel .panel-heading'), $('.minimap-panel'));
makePanelDraggable($('.map-controls'), $('.map-controls'), e => e.target.closest('button, a'));
battlefield.onCamera=camera=>{$('#zoom-label').textContent=Math.round(camera.zoom*100)+'%';$('#camera-coordinates').textContent=`X ${String(Math.round(camera.x)).padStart(4,'0')} / Y ${String(Math.round(camera.y)).padStart(4,'0')}`;};
battlefield.onPreview=(p,pointer)=>{const tip=$('#placement-tooltip');tip.classList.toggle('hidden',!p);if(!p)return;tip.classList.toggle('invalid',!p.valid);tip.textContent=p.valid?`${p.x}, ${p.y}  /  ${selected.cells.length} EN`:p.reason;tip.style.left=Math.min(pointer.x+20,innerWidth-180)+'px';tip.style.top=Math.min(pointer.y+24,innerHeight-32)+'px';};
function toggleHUD(){const hidden=$('#game-hud').classList.toggle('hidden');$('#restore-hud').classList.toggle('hidden',!hidden);}
$('#toggle-hud').onclick=toggleHUD;$('#restore-hud').onclick=toggleHUD;
$$('.collapse-button').forEach(b=>{b.setAttribute('aria-expanded','true');b.onclick=()=>{
    const panel=b.closest('.collapsible');
    const before=panel.offsetHeight;
    const collapsed=panel.classList.toggle('collapsed');
    const after=panel.offsetHeight;
    b.querySelector('.collapse-mark').textContent=collapsed?'+':'−';
    b.setAttribute('aria-expanded',String(!collapsed));
    // 战术总览使用 bottom 定位，折叠后高度变化会导致标题栏上下跳动；补偿 bottom 使标题栏保持原位。
    if(panel.classList.contains('minimap-panel')){
      const bottom=parseFloat(getComputedStyle(panel).bottom)||0;
      panel.style.bottom=`${bottom+before-after}px`;
    }
  };});
window.addEventListener('keydown',e=>{
  if(page!=='game'||$('dialog[open]')||['INPUT','TEXTAREA'].includes(e.target.tagName)||e.ctrlKey||e.metaKey||e.altKey)return;
  const key=e.key.toLowerCase();
  if(['tab',' ','arrowup','arrowdown','arrowleft','arrowright'].includes(key))e.preventDefault();
  if(['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright'].includes(key))battlefield.keys.add(key);
  if(e.repeat)return;
  if(key==='q')cycleCategory(-1);if(key==='e')cycleCategory(1);
  if(key==='f')$('#flip-pattern').click();if(key==='r')$('#rotate-pattern').click();if(key===' ')battlefield.focusBase();if(key==='tab')toggleHUD();if(key==='h')openDialog('#help-dialog');
  if(/^[1-7]$/.test(key))selectPattern(allPatterns[Number(key)-1]);
});
window.addEventListener('keyup',e=>battlefield.keys.delete(e.key.toLowerCase()));
window.addEventListener('blur',()=>{battlefield.keys.clear();drag=null;battlefield.pointer=null;});

// Pattern Lab: 128×128 模板编辑器。初始视口显示左上 32×32，
// 滚轮以指针为中心缩放，右键拖动平移，左键在空白处绘制、在已有细胞上擦除。
const editor = $('#pattern-editor');
const EDITOR_SIZE = 128, EDITOR_MAX_CELLS = 4096;
const editorView = { x: 0, y: 0, scale: 14 }; // scale = 每格像素，14 → 448px 显示 32 格
const EDITOR_MIN_SCALE = editor.width / EDITOR_SIZE; // 最小缩放恰好显示完整 128×128
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function drawEditor() {
  const c = editor.getContext('2d'), W = editor.width, H = editor.height, { x, y, scale } = editorView;
  c.fillStyle = '#08131a'; c.fillRect(0, 0, W, H);
  const startX = Math.max(0, Math.floor(x)), endX = Math.min(EDITOR_SIZE, Math.ceil(x + W / scale));
  const startY = Math.max(0, Math.floor(y)), endY = Math.min(EDITOR_SIZE, Math.ceil(y + H / scale));
  // 细网格（每格）
  c.strokeStyle = '#253f4b'; c.lineWidth = 1; c.beginPath();
  for (let i = startX; i <= endX; i++) { const px = (i - x) * scale; c.moveTo(px, 0); c.lineTo(px, H); }
  for (let j = startY; j <= endY; j++) { const py = (j - y) * scale; c.moveTo(0, py); c.lineTo(W, py); }
  c.stroke();
  // 粗网格（每 8 格）
  c.strokeStyle = '#2f5566'; c.lineWidth = 1; c.beginPath();
  for (let i = Math.ceil(startX / 8) * 8; i <= endX; i += 8) { const px = (i - x) * scale; c.moveTo(px, 0); c.lineTo(px, H); }
  for (let j = Math.ceil(startY / 8) * 8; j <= endY; j += 8) { const py = (j - y) * scale; c.moveTo(0, py); c.lineTo(W, py); }
  c.stroke();
  // 图案边界 128×128
  c.strokeStyle = '#67f5d1'; c.lineWidth = 2;
  c.strokeRect((0 - x) * scale, (0 - y) * scale, EDITOR_SIZE * scale, EDITOR_SIZE * scale);
  // 细胞
  c.fillStyle = COLORS[playerId - 1];
  for (const cell of editorCells) {
    const [gx, gy] = cell.split(',').map(Number);
    const px = (gx - x) * scale, py = (gy - y) * scale;
    if (px + scale < 0 || py + scale < 0 || px > W || py > H) continue;
    c.fillRect(px + 1, py + 1, scale - 1, scale - 1);
  }
  $('#editor-count').textContent = `${editorCells.size} / ${EDITOR_MAX_CELLS} CELLS`;
}
function fitEditorView(cells) {
  const minX = Math.min(...cells.map(c => c[0])), maxX = Math.max(...cells.map(c => c[0]));
  const minY = Math.min(...cells.map(c => c[1])), maxY = Math.max(...cells.map(c => c[1]));
  const w = Math.max(1, maxX - minX + 1), h = Math.max(1, maxY - minY + 1);
  editorView.scale = clamp(Math.min(editor.width / (w + 4), editor.height / (h + 4)), EDITOR_MIN_SCALE, 64);
  const cxp = (minX + maxX) / 2, cyp = (minY + maxY) / 2;
  editorView.x = clamp(cxp - editor.width / editorView.scale / 2, 0, Math.max(0, EDITOR_SIZE - editor.width / editorView.scale));
  editorView.y = clamp(cyp - editor.height / editorView.scale / 2, 0, Math.max(0, EDITOR_SIZE - editor.height / editorView.scale));
  drawEditor();
}
$('#open-editor').onclick = () => {
  editingId = selected.custom ? selected.id : null;
  editorCells = new Set(editingId ? selected.cells.map(c => c.join(',')) : []);
  $('#pattern-name').value = editingId ? selected.name : '';
  $('#rle-input').value = '';
  $('#delete-pattern').classList.toggle('hidden', !editingId);
  editorView.x = 0; editorView.y = 0; editorView.scale = editor.width / 32; // 初始显示 32×32
  drawEditor(); openDialog('#editor-dialog');
};
let painting = null, panning = null;
function editorPos(e) {
  const r = editor.getBoundingClientRect(), { x, y, scale } = editorView;
  return {
    gx: Math.floor((e.clientX - r.left) / r.width * editor.width / scale + x),
    gy: Math.floor((e.clientY - r.top) / r.height * editor.height / scale + y),
  };
}
function applyPaint(pos, mode) {
  if (pos.gx < 0 || pos.gx >= EDITOR_SIZE || pos.gy < 0 || pos.gy >= EDITOR_SIZE) return;
  const key = `${pos.gx},${pos.gy}`;
  if (mode === 'erase') editorCells.delete(key);
  else if (!editorCells.has(key) && editorCells.size < EDITOR_MAX_CELLS) editorCells.add(key);
  drawEditor();
}
editor.oncontextmenu = e => e.preventDefault();
editor.onpointerdown = e => {
  if (e.button === 2) { // 右键：平移视图
    panning = { startX: e.clientX, startY: e.clientY, viewX: editorView.x, viewY: editorView.y };
    editor.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;
  const pos = editorPos(e);
  painting = editorCells.has(`${pos.gx},${pos.gy}`) ? 'erase' : 'draw'; // 左键：空白绘制，已有细胞擦除
  applyPaint(pos, painting);
  editor.setPointerCapture(e.pointerId);
};
editor.onpointermove = e => {
  if (panning) {
    const r = editor.getBoundingClientRect();
    const dx = (e.clientX - panning.startX) / r.width * editor.width / editorView.scale;
    const dy = (e.clientY - panning.startY) / r.height * editor.height / editorView.scale;
    editorView.x = clamp(panning.viewX - dx, 0, Math.max(0, EDITOR_SIZE - editor.width / editorView.scale));
    editorView.y = clamp(panning.viewY - dy, 0, Math.max(0, EDITOR_SIZE - editor.height / editorView.scale));
    drawEditor();
    return;
  }
  if (painting) applyPaint(editorPos(e), painting);
};
editor.onpointerup = e => {
  panning = null; painting = null;
  if (editor.hasPointerCapture(e.pointerId)) editor.releasePointerCapture(e.pointerId);
};
editor.onpointercancel = () => { painting = null; panning = null; };
editor.onwheel = e => {
  e.preventDefault();
  const r = editor.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width * editor.width;
  const py = (e.clientY - r.top) / r.height * editor.height;
  const { x, y, scale } = editorView;
  const gx = x + px / scale, gy = y + py / scale;
  const next = clamp(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), EDITOR_MIN_SCALE, 64);
  editorView.x = clamp(gx - px / next, 0, Math.max(0, EDITOR_SIZE - editor.width / next));
  editorView.y = clamp(gy - py / next, 0, Math.max(0, EDITOR_SIZE - editor.height / next));
  editorView.scale = next;
  drawEditor();
};
$('#clear-editor').onclick=()=>{editorCells.clear();drawEditor();};
$('#import-rle').onclick=()=>{try{const cells=parseRLE($('#rle-input').value);editorCells=new Set(cells.map(c=>c.join(',')));fitEditorView(cells);toast('图案已导入');}catch(e){toast(e.message,true);}};
$('#export-rle').onclick=()=>{if(!editorCells.size)return toast('先添加一些细胞',true);$('#rle-input').value=toRLE([...editorCells].map(c=>c.split(',').map(Number)));toast('RLE 编码已生成，可选中复制');};
$('#save-pattern').onclick=()=>{
  if(!editorCells.size)return toast('图案不能为空',true);
  if(!editingId&&customPatterns.length>=30)return toast('最多保存 30 个自定义图案，请先删除一个',true);
  const pattern={id:editingId||'custom-'+Date.now(),name:$('#pattern-name').value.trim()||'未命名生命',en:'CUSTOM DNA',role:'自定义 / 战术',desc:'你设计的生命图案。请留意其演化稳定性与运动方向。',custom:true,cells:normalize([...editorCells].map(c=>c.split(',').map(Number)))};
  const updated=editingId?customPatterns.map(p=>p.id===editingId?pattern:p):[...customPatterns,pattern];
  if(!saveStorage('lifewar.patterns',updated))return toast('浏览器存储空间不足，请先导出 RLE 保存',true);
  customPatterns=updated;renderPatterns();selectPattern(pattern);$('#editor-dialog').close();toast('图案已保存并装备');
};
$('#delete-pattern').onclick=()=>{customPatterns=customPatterns.filter(p=>p.id!==editingId);saveStorage('lifewar.patterns',customPatterns);renderPatterns();selectPattern(PATTERNS[0]);$('#editor-dialog').close();toast('自定义图案已删除');};
