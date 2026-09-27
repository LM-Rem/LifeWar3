import http from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { Game, RULES } from './engine.js';
import { runBots } from './bots.js';
import { performanceConfig } from './performance-config.js';
import { PerformanceMetrics, instrumentGame, startEventLoopMetrics } from './metrics.js';
import { scheduleTicks } from './tick-scheduler.js';
import { createGpuEvolution } from './evolution/gpu.js';
import { PacketHistory } from './packet-history.js';
import { staticAssets } from './static-assets.js';
import { RoomWorkerClient } from './room-worker-client.js';

const ROOT = fileURLToPath(new URL('../public/', import.meta.url));
const LIBRARY_DIR = fileURLToPath(new URL('../图案集_128/', import.meta.url));
const PATTERNS_FILE = fileURLToPath(new URL('../public/patterns.json', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const safeName = name => String(name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || '匿名指挥官';
const send = (ws, value) => {
  if (['card_picked','card_played','error'].includes(value.type) && ws?.member?.control?.readyState === WebSocket.OPEN)
    return ws.member.control.send(JSON.stringify(value));
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
};
// 递归遍历图案集目录，收集文件名/路径包含关键词的 .cells 文件（相对路径）
async function walkLibrary(dir, q, base, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkLibrary(full, q, base, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.cells')) {
      const rel = path.relative(base, full).split(path.sep).join('/');
      if (rel.toLowerCase().includes(q)) out.push(rel);
    }
  }
  return out;
}
const readBody = req => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 1e6) { reject(new Error('请求体过大')); req.destroy(); } });
  req.on('end', () => resolve(body));
  req.on('error', reject);
});

export function createServer({ port = Number(process.env.PORT) || 3000, host = '0.0.0.0', trace = performanceConfig().enabled, boardProtocol = Number(process.env.LIFEWAR_BOARD_PROTOCOL ?? 1), scheduler = scheduleTicks, evolutionMode = process.env.LIFEWAR_EVOLUTION ?? 'auto', roomWorkers = process.env.LIFEWAR_ROOM_WORKERS === '1', roomWorkerFactory = (options,callbacks)=>new RoomWorkerClient(options,callbacks), compression = process.env.LIFEWAR_COMPRESSION === '1', onRoomError = (error, room) => console.error(`[room ${room.code}] simulation stopped`, error) } = {}) {
  if(![1,2].includes(boardProtocol))throw new Error('Invalid LIFEWAR_BOARD_PROTOCOL');
  const metrics = trace ? new PerformanceMetrics({ capacity: performanceConfig().capacity }) : null;
  const eventLoop = metrics ? startEventLoopMetrics() : null;
  const rooms = new Map();
  const serveStatic = staticAssets();
  let gpuEvolution;
  let serverGen = 0; // 服务器全局演化代数，用于按代判断的房间清理
  let nextSession = 0;
  const retiringWorkers = new Set();
  function retireWorker(room) {
    if(!room.worker)return;
    const worker=room.worker;room.worker=null;
    const closing=worker.close();retiringWorkers.add(closing);closing.finally(()=>retiringWorkers.delete(closing));
  }
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname === '/api/info') {
        const actualPort = server.address()?.port || port;
        const addresses = Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal).map(i => `http://${i.address}:${actualPort}`);
        // 可选公网地址（如 Ngrok）：PUBLIC_URL 或 NGROK_URL。设置后加入地址列表，
        // 供联机页优先展示，使复制出的邀请链接对外网玩家可直接访问。
        const publicUrl = (process.env.PUBLIC_URL || process.env.NGROK_URL || '').replace(/\/+$/, '');
        const payload = { addresses: publicUrl ? [publicUrl, ...addresses] : addresses, rules: RULES, rooms: rooms.size };
        if (publicUrl) payload.publicUrl = publicUrl;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(payload));
      }
      if (pathname === '/api/library') {
        const params = new URL(req.url, 'http://localhost').searchParams;
        const file = params.get('file');
        const dir = params.get('dir');
        const search = params.get('search');
        const LIBRARY_BASE = path.resolve(LIBRARY_DIR);
        // 遍历子目录搜索: ?search=关键词，返回所有匹配的 .cells 相对路径
        if (search) {
          const q = String(search).trim().toLowerCase().slice(0, 64);
          try {
            const files = q ? await walkLibrary(LIBRARY_DIR, q, LIBRARY_BASE) : [];
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify({ search: q, files: files.slice(0, 500) }));
          } catch { res.writeHead(500); return res.end('Search failed'); }
        }
        // 目录浏览: ?dir=相对路径，返回该目录下的子目录与 .cells 文件
        if (!file) {
          const rel = String(dir || '').replace(/\\/g, '/').replace(/^\/+/, '');
          const target = path.resolve(LIBRARY_DIR, rel);
          if (target !== LIBRARY_BASE && !target.startsWith(LIBRARY_BASE + path.sep)) {
            res.writeHead(400); return res.end('Invalid path');
          }
          try {
            const entries = await readdir(target, { withFileTypes: true });
            const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort((a, b) => a.localeCompare(b, 'zh-CN'));
            const files = entries.filter(e => e.isFile() && e.name.toLowerCase().endsWith('.cells')).map(e => e.name).sort((a, b) => a.localeCompare(b, 'zh-CN'));
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify({ path: rel, dirs, files }));
          } catch { res.writeHead(404); return res.end('Not found'); }
        }
        // 文件内容: ?file=相对路径（支持子目录，防路径穿越）
        const rel = String(file).replace(/\\/g, '/').replace(/^\/+/, '');
        const target = path.resolve(LIBRARY_DIR, rel);
        if (!target.startsWith(LIBRARY_BASE + path.sep) || !rel.toLowerCase().endsWith('.cells')) {
          res.writeHead(400); return res.end('Invalid file name');
        }
        try {
          const content = await readFile(target, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          return res.end(JSON.stringify({ name: rel, content }));
        } catch { res.writeHead(404); return res.end('Not found'); }
      }
      if (pathname === '/api/patterns' && req.method === 'POST') {
        let input;
        try { input = JSON.parse(await readBody(req)); } catch { res.writeHead(400); return res.end('Invalid JSON'); }
        const data = JSON.parse(await readFile(PATTERNS_FILE, 'utf8'));
        data.categories ||= [];
        data.patterns ||= [];
        const action = String(input.action || 'create');
        if (action === 'delete') {
          const id = String(input.id || '');
          const index = data.patterns.findIndex(p => p.id === id);
          if (index === -1) { res.writeHead(404); return res.end('图案不存在'); }
          data.patterns.splice(index, 1);
          await writeFile(PATTERNS_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true }));
        }
        if (action === 'update') {
          const id = String(input.id || '');
          const index = data.patterns.findIndex(p => p.id === id);
          if (index === -1) { res.writeHead(404); return res.end('图案不存在'); }
          const cells = Array.isArray(input.cells) ? input.cells : data.patterns[index].cells;
          if (!cells.length || cells.length > 4096 || !cells.every(c => Array.isArray(c) && c.length === 2 && c.every(n => Number.isInteger(n) && n >= 0 && n < 128))) {
            res.writeHead(400); return res.end('图案细胞数据无效');
          }
          const name = String(input.name || '').trim().slice(0, 32) || data.patterns[index].name;
          const category = String(input.category || 'other').trim().slice(0, 20) || 'other';
          const updated = {
            ...data.patterns[index],
            name,
            en: String(input.en || '').trim().slice(0, 32) || data.patterns[index].en || 'LIFE DNA',
            role: String(input.role || '').trim().slice(0, 32) || data.patterns[index].role || '生命图谱',
            desc: String(input.desc || '').trim().slice(0, 200) || data.patterns[index].desc || '',
            category,
            cells,
          };
          data.patterns[index] = updated;
          if (!data.categories.some(c => c.id === category)) data.categories.push({ id: category, name: category });
          await writeFile(PATTERNS_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, pattern: updated }));
        }
        const name = String(input.name || '').trim().slice(0, 32);
        const cells = Array.isArray(input.cells) ? input.cells : null;
        if (!name || !cells || !cells.length || cells.length > 4096 || !cells.every(c => Array.isArray(c) && c.length === 2 && c.every(n => Number.isInteger(n) && n >= 0 && n < 128))) {
          res.writeHead(400); return res.end('图案名称或细胞数据无效');
        }
        const category = String(input.category || 'other').trim().slice(0, 20) || 'other';
        const pattern = {
          id: 'lib-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
          name,
          en: String(input.en || '').trim().slice(0, 32) || 'LIBRARY DNA',
          role: String(input.role || '').trim().slice(0, 32) || '图案库 / 导入',
          desc: String(input.desc || '').trim().slice(0, 200) || `来自图案库 ${name}。`,
          category,
          cells,
        };
        data.patterns.push(pattern);
        if (!data.categories.some(c => c.id === category)) data.categories.push({ id: category, name: category });
        await writeFile(PATTERNS_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, pattern }));
      }
      const file = path.resolve(ROOT, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(ROOT) || pathname.includes('..')) { res.writeHead(403); return res.end('Forbidden'); }
      await serveStatic(req, res, file, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: compression ? {
    threshold: 4096, serverNoContextTakeover: true, clientNoContextTakeover: true,
    concurrencyLimit: 2, zlibDeflateOptions: { level: 1, memLevel: 7, chunkSize: 4 * 1024 * 1024 }
  } : false });
  server.on('upgrade', (req, socket, head) => {
    let allowed = (req.url === '/ws' || req.url === '/ws?trace=1') && wss.clients.size < 64;
    try { if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) allowed = false; } catch { allowed = false; }
    if (!allowed) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => { ws.trace = !!metrics && req.url === '/ws?trace=1'; wss.emit('connection', ws); });
  });
  function roomView(room) {
    return { type: 'room', code: room.code, host: room.host, status: room.game?.status || 'lobby', players: room.members.map(m => ({ id: m.id, name: m.name, ready: m.ready, bot: m.bot, connected: !!m.ws || m.bot })), capacity: 4 };
  }
  function broadcastRoom(room) { for (const m of room.members) send(m.ws, roomView(room)); }
  function sendCards(room, member) {
    if (!room.game || !member.ws) return;
    if(room.worker){room.worker.command(member.id,member.ws.roomSession,{type:'cards'});return;}
    const target = member.control?.readyState === WebSocket.OPEN ? member.control : member.ws;
    if (target.bufferedAmount > 65536) return; // Latest state replaces missed updates; never queue unbounded JSON.
    const state = room.game.state(member.id);
    send(target, {
      type:'card_state', roomEpoch:room.epoch, sequence:++member.cardSequence,
      cards:state.cards, cardDraft:state.cardDraft, status:state.status, serverTime:state.serverTime
    });
  }
  let nextRoomEpoch=randomBytes(4).readUInt32LE(0)||1;
  const workerMember = member => ({id:member.id,name:member.name,bot:member.bot,
    session:member.ws?.roomSession??null,boardVersion:member.ws?.boardVersion??1,deltaVarint:!!member.ws?.deltaVarint});
  function failRoom(room,error) {
    if(room.fault)return;
    room.fault=String(error?.message??error);
    try{onRoomError(error,room);}catch{}
    for(const m of room.members)send(m.ws,{type:'error',message:'战区演化异常，已停止推进，请退出后重新创建战区。'});
  }
  function startWorker(room) {
    room.game={status:'starting',generation:0,players:[]};room.fault=null;
    room.epoch=nextRoomEpoch;nextRoomEpoch=(nextRoomEpoch+1)>>>0||1;
    for(const m of room.members)m.cardSequence=0;
    const bridge=room.worker=roomWorkerFactory({members:room.members.map(workerMember),epoch:room.epoch,evolutionMode},{
      onFault:error=>{if(room.worker===bridge)failRoom(room,error);},
      onMessage:message=>{
        if(room.worker!==bridge)return;
        if(message.type==='adapter') {
          if(message.adapter)console.log(`[room ${room.code}] WebGPU evolution:`,message.adapter);
          else console.warn(`[room ${room.code}] WebGPU unavailable; CPU fallback:`,message.warning);
          return;
        }
        const oldStatus=room.game.status;
        if(message.meta){room.game=message.meta;room.startedAt=message.meta.startedAt;}
        for(const event of message.events??[]) {
          const member=room.members.find(m=>m.id===event.id),ws=member?.ws;
          if(ws?.readyState!==WebSocket.OPEN||ws.roomSession!==event.session)continue;
          if(event.packet)sendBoard(ws,room,event.packet,event.snapshot);
          else if(event.data.type==='card_state') {
            const target=member.control?.readyState===WebSocket.OPEN?member.control:ws;
            if(target.bufferedAmount<=65536)send(target,{...event.data,sequence:++member.cardSequence});
          }else send(ws,event.data);
        }
        if(message.type==='frame') {
          room.tickMs=message.tickMs;
          if(metrics){metrics.record('tick.ms',message.tickMs,room.game.generation,room.code,String(room.startedAt));metrics.record('computedGeneration',0,room.game.generation,room.code,String(room.startedAt));}
          bridge.post({type:'ack',buffers:room.members.filter(m=>m.ws).map(m=>({id:m.id,session:m.ws.roomSession,bufferedAmount:m.ws.bufferedAmount}))});
        }
        const oldHost=room.host;
        if(!room.members.find(m=>m.id===room.host)?.ws && (room.game.status==='finished'||room.game.players.some(p=>p.id===room.host&&p.eliminated)))room.host=room.members.find(m=>m.ws)?.id??room.host;
        if(oldStatus!==room.game.status||oldHost!==room.host){broadcastRoom(room);updateLists();}
      }
    });
    broadcastRoom(room);updateLists();
  }
  const boardVariant=ws=>ws.boardVersion===2&&ws.deltaVarint?'2-varint':ws.boardVersion;
  function boardPacket(ws,room,snapshot=false,cache=new Map()) {
    const ordered=ws.boardVersion===2 && ws.v2NeedsOrdered;
    const key=`${boardVariant(ws)}:${snapshot}:${!!ordered}`;
    if(!cache.has(key))cache.set(key,ws.boardVersion===2
      ?room.game.packetV2({roomEpoch:room.epoch,baseGeneration:room.boardGeneration,previous:room.broadcastBoard,snapshot,forceOrdered:ordered,allowVarint:!!ws.deltaVarint})
      :room.game.packet(snapshot));
    return cache.get(key);
  }
  function started(ws,room,id) {send(ws,{type:'started',id,rules:RULES,startedAt:room.startedAt,roomEpoch:room.epoch,boardProtocol:ws?.boardVersion??1});}
  function sendBoard(ws, room, packet, snapshot = false) {
    const game = room.game, start = metrics ? metrics.now() : 0;
    ws.send(packet);
    ws.sentGeneration = new DataView(packet).getUint32(ws.boardVersion === 2 ? 12 : 4, true);
    ws.v2NeedsOrdered=snapshot;
    if(snapshot)ws.needsSnapshot=false;
    if (metrics) {
      const stream = `${room.code}/${ws.member?.id ?? 0}`, epoch = String(room.startedAt);
      metrics.record('sentGeneration', packet.byteLength, ws.sentGeneration, stream, epoch);
      metrics.record('sendSubmit.ms', metrics.now() - start, ws.sentGeneration, stream, epoch);
      metrics.record('bufferedBytes', ws.bufferedAmount, ws.sentGeneration, stream, epoch);
      if (snapshot) metrics.record('snapshot', 1, ws.sentGeneration, stream, epoch);
      if (ws.trace) send(ws, { type: 'performance', epoch, generation: ws.sentGeneration });
    }
  }
  function lobbyList(ws) { send(ws, { type: 'rooms', rooms: [...rooms.values()].map(r => ({ code: r.code, name: `${r.members[0]?.name || '未知'} 的战区`, count: r.members.length, status: r.game?.status || 'lobby' })) }); }
  function updateLists() { for (const ws of wss.clients) if (!ws.member && !ws.controlMember) lobbyList(ws); }
  function unlink(ws, explicit = false) {
    if(shuttingDown)return;
    const room = ws.room, member = ws.member;
    if (!room || !member) return;
    member.control?.close(4000, 'Primary disconnected'); member.control = null;
    if (room.game && ['playing','starting'].includes(room.game.status)) {
      room.worker?.post({type:'disconnect',id:member.id,session:ws.roomSession,explicit});
      member.ws = null; member.offlineGen = room.game.generation; member.offlineAt=Date.now();
      if (explicit) {
        member.token = ''; if(!room.worker){room.game.eliminate(member.id); room.game.checkVictory();}
        if (room.host === member.id) room.host = room.members.find(m => m !== member && m.ws)?.id ?? room.host;
      }
    } else {
      room.worker?.post({type:'disconnect',id:member.id,session:ws.roomSession,explicit});
      room.members = room.members.filter(m => m !== member);
      if (room.host === member.id) room.host = room.members.find(m => !m.bot)?.id;
    }
    ws.room = null; ws.member = null;
    if (!room.members.some(m => !m.bot)) {retireWorker(room);rooms.delete(room.code);}
    else broadcastRoom(room);
    updateLists();
  }
  function attach(ws, room, member) {
    ws.room = room; ws.member = member; member.ws = ws; member.offlineGen = null;member.offlineAt=null;ws.roomSession=++nextSession;
    member.cardSequence = 0;
    send(ws, { type: 'welcome', id: member.id, token: member.token, code: room.code });
    broadcastRoom(room);
    if (room.worker)room.worker.post({type:'attach',member:workerMember(member)});
    else if (room.game) { started(ws,room,member.id); sendCards(room, member); send(ws, room.game.state(member.id)); sendBoard(ws, room, boardPacket(ws,room,true), true); }
    updateLists();
  }
  function start(room) {
    const hostMember = room.members.find(m => m.id === room.host);
    room.members.forEach((m, i) => { m.id = i + 1; });
    room.host = hostMember.id;
    if(roomWorkers){startWorker(room);return;}
    room.game = new Game(room.members, { evolutionMode }); room.game.gpuEvolution = gpuEvolution;
    room.history = new PacketHistory(); room.fault = null;
    room.startedGen = serverGen; room.startedAt = room.game.startedAt; room.lastActiveGen = serverGen; room.finishedBroadcast = false;
    room.epoch=nextRoomEpoch;nextRoomEpoch=(nextRoomEpoch+1)>>>0||1;
    room.broadcastBoard=boardProtocol===2?room.game.board.slice():null;room.boardGeneration=room.game.generation;
    if (metrics) instrumentGame(room.game, metrics, room.code);
    const snapshots=new Map();
    for (const m of room.members) { m.cardSequence=0; started(m.ws,room,m.id); sendCards(room,m); send(m.ws, room.game.state(m.id)); if (m.ws?.readyState === WebSocket.OPEN) sendBoard(m.ws, room, boardPacket(m.ws,room,true,snapshots), true); }
    broadcastRoom(room); updateLists();
  }
  wss.on('connection', ws => {
    ws.alive = true; ws.budget = 40; ws.refillAt = Date.now();ws.boardVersion=1;
    ws.on('pong', () => { ws.alive = true; });
    send(ws, { type: 'hello', version: '1.0.0',cardControl:true,boardProtocols:boardProtocol===2?[1,2]:[1],boardEncodings:boardProtocol===2?[0,1,2]:[] }); lobbyList(ws);
    ws.on('error', () => {});
    ws.on('message', (raw, isBinary) => {
      ws.budget = Math.min(40, ws.budget + (Date.now() - ws.refillAt) / 100); ws.refillAt = Date.now();
      if (--ws.budget < 0) return send(ws, { type: 'error', message: '操作过快，请稍后重试' });
      let msg;
      try { if (isBinary) return; msg = JSON.parse(raw.toString()); if (!msg || typeof msg !== 'object') return; } catch { return; }
      if (ws.controlMember) {
        const m = ws.controlMember;
        if (m.control !== ws || m.ws?.readyState !== WebSocket.OPEN) return ws.close(4000, 'Session expired');
        if (!['pick_card','play_card','ping'].includes(msg.type)) return;
        m.ws.emit('message', raw, false); return;
      }
      if (msg.type === 'bind_control') {
        if (ws.member) return;
        const r = rooms.get(String(msg.code || ''));
        const m = r?.members.find(m => m.token && m.token === msg.token && m.ws?.readyState === WebSocket.OPEN);
        if (!m) { send(ws,{type:'control_rejected'}); return; }
        m.control?.close(4000, 'Control replaced'); m.control = ws; ws.controlMember = m;
        send(ws,{type:'control_ready'}); sendCards(r,m); return;
      }
      const room = ws.room, member = ws.member;
      const fail = message => send(ws, { type: 'error', message });
      if(room?.worker && ['deploy','pick_card','play_card','resync'].includes(msg.type)) {
        if(room.fault)return fail('战区已停止，请退出后重新创建');
        if(msg.type==='resync') {
          if(ws.lastResyncAt && Date.now()-ws.lastResyncAt<1000)return;
          ws.lastResyncAt=Date.now();
        }
        if(!room.worker.command(member.id,ws.roomSession,msg))fail('战区操作队列繁忙，请稍后重试');
        return;
      }
      switch (msg.type) {
        case 'protocol': {
          if(room)return fail('请在加入战区前协商协议');
          if(msg.version!==1&&(msg.version!==2||boardProtocol!==2))return fail('不支持的棋盘协议版本');
          ws.boardVersion=msg.version;ws.deltaVarint=msg.version===2&&msg.deltaVarint===true;send(ws,{type:'protocol',version:ws.boardVersion,deltaVarint:ws.deltaVarint});return;
        }
        case 'ping': return send(ws, { type: 'pong', time: msg.time });
        case 'list': return lobbyList(ws);
        case 'create': {
          if (room) return fail('请先离开当前战区');
          if (rooms.size >= 6) return fail('服务器房间已满');
          let code; do { code = randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
          const r = { code, host: 1, members: [], game: null, lastActive: Date.now() };
          const m = { id: 1, name: safeName(msg.name), token: randomBytes(24).toString('hex'), ready: true, bot: false };
          r.members.push(m); rooms.set(code, r); attach(ws, r, m);
          if (msg.practice) { r.members.push({ id: 2, name: 'ECHO / 战术 AI', token: '', ready: true, bot: true }); start(r); }
          return;
        }
        case 'join': {
          if (room) return fail('请先离开当前战区');
          const r = rooms.get(String(msg.code || '').trim().toUpperCase());
          if (!r) return fail('没有找到该战区，请确认房间码与服务器地址');
          if (r.game) return fail('对局已经开始');
          if (r.members.length >= 4) return fail('战区已满（最多 4 人）');
          const id = [1,2,3,4].find(i => !r.members.some(m => m.id === i));
          const m = { id, name: safeName(msg.name), token: randomBytes(24).toString('hex'), ready: false, bot: false };
          r.members.push(m); attach(ws, r, m);
          return;
        }
        case 'resume': {
          if (room) return;
          const r = rooms.get(String(msg.code || '')), m = r?.members.find(m => m.token && m.token === msg.token);
          if (!m) return send(ws, { type: 'resume_failed' });
          if (m.ws && m.ws !== ws) { m.control?.close(4000,'Session resumed'); m.control=null; const old = m.ws; old.member = null; old.room = null; old.close(4001, 'Session resumed elsewhere'); }
          attach(ws, r, m); return;
        }
        case 'resync': {
          if (!room?.game || !member || (ws.lastResyncAt && Date.now()-ws.lastResyncAt<1000)) return;
          if(ws.bufferedAmount>262144){ws.needsSnapshot=true;return;}
          ws.lastResyncAt=Date.now();
          sendBoard(ws,room,boardPacket(ws,room,true),true);send(ws,room.game.state(member.id));return;
        }
        case 'leave': unlink(ws, true); send(ws, { type: 'left' }); return;
        case 'ready': if (room && !room.game) { member.ready = !member.ready; broadcastRoom(room); } return;
        case 'bot': {
          if (!room || room.game || room.host !== member.id) return fail('只有房主可添加 AI');
          if (room.members.length >= 4) return fail('战区已满');
          const id = [1,2,3,4].find(i => !room.members.some(m => m.id === i));
          room.members.push({ id, name: `${['','ECHO','VECTOR','NOVA','ORBIT'][id]} / 战术 AI`, bot: true, ready: true, token: '' }); broadcastRoom(room); updateLists(); return;
        }
        case 'remove_bot': if (room && !room.game && room.host === member.id) { room.members = room.members.filter(m => !(m.bot && m.id === msg.id)); broadcastRoom(room); updateLists(); } return;
        case 'start': {
          if (!room || room.game || room.host !== member.id) return fail('只有房主可启动对局');
          if (room.members.length < 2 || room.members.some(m => !m.ready || (!m.bot && !m.ws))) return fail('需要 2–4 位指挥官，且所有人准备就绪');
          start(room); return;
        }
        case 'rematch': {
          if (!room || room.game?.status !== 'finished' || room.host !== member.id) return fail('对局结束后由房主返回备战');
          retireWorker(room);
          room.game = null; room.members = room.members.filter(m => m.ws || m.bot); room.members.forEach(m => { m.ready = m.bot || m.id === room.host; });
          for (const m of room.members) send(m.ws, { type: 'lobby' }); broadcastRoom(room); updateLists(); return;
        }
        case 'deploy': {
          if (!room?.game || !member) return fail('尚未进入对局');
          const result = room.game.deploy(member.id, msg.x, msg.y, msg.cells);
          if (result.error) return fail(result.error);
          send(ws, { type: 'deployed', x: msg.x, y: msg.y, cost: result.cost }); return;
        }
        case 'pick_card': {
          if (!room?.game || !member) return fail('尚未进入对局');
          const draft = room.game.state(member.id).cardDraft;
          if (msg.draftRound !== undefined && (msg.draftRound !== draft?.round || msg.draftGen !== draft?.gen)) return fail('本轮征召已结束，请重新选择');
          const result = room.game.pickCard(member.id, String(msg.cardId || ''));
          if (result.error) return fail(result.error);
          send(ws, { type: 'card_picked', playerId: member.id, cardId: result.card.id });
          sendCards(room,member);
          send(ws, room.game.state(member.id));
          return;
        }
        case 'play_card': {
          if (!room?.game || !member) return fail('尚未进入对局');
          const result = room.game.playCard(member.id, String(msg.cardId || ''), Number.isInteger(msg.x) ? msg.x : undefined, Number.isInteger(msg.y) ? msg.y : undefined, msg.instanceId);
          if (result.error) return fail(result.error);
          for (const m of room.members) {
            send(m.ws, { type: 'card_played', playerId: member.id, cardId: String(msg.cardId || ''), x: msg.x, y: msg.y });
            sendCards(room,m);
            send(m.ws, room.game.state(m.id));
          }
          return;
        }
      }
    });
    ws.on('close', () => { if(ws.controlMember?.control===ws)ws.controlMember.control=null; unlink(ws); });
  });

  const timer = scheduler(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      try {
      if (room.members.some(m => m.ws)) room.lastActive = now;
      else if (now - room.lastActive > 90000) { retireWorker(room);rooms.delete(room.code); updateLists(); continue; }
      if(room.worker)continue;
      const game = room.game;
      if (!game || room.fault) continue;
      const tickStart = metrics ? metrics.now() : 0;
      for (const m of room.members) if (game.status === 'playing' && !m.bot && !m.ws && m.offlineAt && now - m.offlineAt > 90000 && !game.players[m.id-1].eliminated) {
        game.eliminate(m.id); game.checkVictory();
        if(room.host === m.id) { room.host = room.members.find(other => other.ws)?.id ?? room.host; broadcastRoom(room); }
      }
      if (game.status === 'playing') {
        if (game.generation % Math.max(1, Math.round(RULES.hz * 3)) === 0) {
          const botStart = metrics ? metrics.now() : 0; runBots(game);
          if (metrics) metrics.record('ai.ms', metrics.now() - botStart, game.generation, room.code, String(room.startedAt));
        } // 保持约每秒 0.33 次 AI 决策，与 hz 解耦
        const t = performance.now(); game.step(); room.tickMs = performance.now() - t;
        if (metrics) metrics.record('computedGeneration', 0, game.generation, room.code, String(room.startedAt));
      }
      if (game.status === 'finished') {
        if (!room.members.find(m => m.id === room.host)?.ws) {
          const nextHost = room.members.find(m => m.ws);
          if (nextHost && nextHost.id !== room.host) { room.host = nextHost.id; broadcastRoom(room); }
        }
        if (room.finishedBroadcast) continue;
        broadcastRoom(room); updateLists();
      }
      const packets=new Map();
      // Store canonical independent deltas once per room, never merge generations.
      const historyPackets = new Map();
      for (const {ws} of room.members) {
        if(!ws)continue;
        const variant=boardVariant(ws);
        if(!historyPackets.has(variant))historyPackets.set(variant,boardPacket({boardVersion:ws.boardVersion,deltaVarint:ws.deltaVarint,v2NeedsOrdered:false},room,false,packets));
        if(ws.boardVersion===2&&ws.v2NeedsOrdered)historyPackets.set(`${variant}ordered`,boardPacket(ws,room,false,packets));
      }
      room.history ??= new PacketHistory();
      if (!room.history.frames.has(game.generation)) room.history.add(game.generation, historyPackets);
      else if (game.changes.size) {
        // Out-of-tick elimination may revise an already broadcast final generation.
        // Its former delta is no longer a complete baseline for replay.
        room.history.add(game.generation, historyPackets);
        for (const m of room.members) if (m.ws) m.ws.needsSnapshot = true;
      }
      for (const m of room.members) {
        const ws=m.ws;
        if (ws?.readyState !== WebSocket.OPEN) continue;
        if (game.generation % Math.max(1, Math.round(RULES.hz / 5)) === 0 || game.status === 'finished') sendCards(room,m);
        if (ws.bufferedAmount > 262144) { if (metrics) metrics.record('backpressureSkip', ws.bufferedAmount, game.generation, `${room.code}/${m.id}`, String(room.startedAt)); continue; }
        if (!ws.needsSnapshot && ws.sentGeneration < game.generation) {
          const replay = room.history.after(ws.sentGeneration, game.generation, boardVariant(ws));
          if (replay && ws.boardVersion === 2 && ws.v2NeedsOrdered) {
            const ordered = room.history.frames.get(ws.sentGeneration + 1)?.packets.get(`${boardVariant(ws)}ordered`);
            if (ordered) replay[0] = ordered; else ws.needsSnapshot = true;
          }
          if (replay && !ws.needsSnapshot) {
            for (const packet of replay) {
              if (ws.bufferedAmount > 262144) break;
              sendBoard(ws, room, packet);
            }
            if (ws.sentGeneration !== game.generation) continue;
          } else ws.needsSnapshot = true;
        }
        if (ws.needsSnapshot) sendBoard(ws, room, boardPacket(ws,room,true,packets), true);
        if (game.generation % Math.max(1, Math.round(RULES.hz / 5)) === 0 || game.status === 'finished') send(ws, { ...game.state(m.id), tickMs: Math.round((room.tickMs || 0) * 100) / 100 }); // 状态推送保持约 5Hz，与 hz 解耦
      }
      if(room.broadcastBoard)for(let i=0;i<game.changes.size;i++){const key=game.changes.order[i];room.broadcastBoard[key]=game.changes.owners[key];}
      room.boardGeneration=game.generation;game.changes.clear();
      if (metrics) metrics.record('tick.ms', metrics.now() - tickStart, game.generation, room.code, String(room.startedAt));
      if (game.status === 'finished') room.finishedBroadcast = room.members.every(m => !m.ws || (m.ws.sentGeneration === game.generation && !m.ws.needsSnapshot));
      } catch (error) {
        // Do not continue a potentially half-settled game. Isolate that room.
        room.fault = String(error?.message ?? error);
        try { onRoomError(error, room); } catch {}
        for (const m of room.members) try { send(m.ws, { type: 'error', message: '战区演化异常，已停止推进，请退出后重新创建战区。' }); } catch {}
      }
    }
  }, { periodMs: 1000 / RULES.hz, onTiming: metrics ? timing => {
    for (const [key, value] of Object.entries(timing)) if (key.endsWith('Ms') && value !== null) metrics.record(`scheduler.${key}`, value);
  } : null });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
  }, 15000);
  let shuttingDown=false;
  const closed = () => { if(shuttingDown)return;shuttingDown=true;timer.stop(); clearInterval(heartbeat); eventLoop?.close(); void gpuEvolution?.close();for(const room of rooms.values())retireWorker(room); for (const ws of wss.clients) ws.terminate(); wss.close(); };
  server.on('close', closed);
  return { server, rooms, wss, performanceReport: () => metrics ? { ...metrics.export(), eventLoop: eventLoop.export() } : null,
    listen: async () => {
      if (evolutionMode === 'gpu' && !roomWorkers) {
        try { gpuEvolution = await createGpuEvolution({ size: RULES.size }); console.log('WebGPU evolution:', gpuEvolution.adapter); }
        catch (error) { console.warn('WebGPU unavailable; using CPU:', error.message); }
      }
      return new Promise(resolve => server.listen(port, host, () => resolve(server.address())));
    }, close: async () => {closed();await Promise.all([new Promise(resolve=>server.close(resolve)),...retiringWorkers]);} };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createServer();
  app.listen().then(({port}) => {
    console.log(`\n  LIFEWAR / NEXUS\n  Local: http://localhost:${port}`);
    for (const i of Object.values(os.networkInterfaces()).flat()) if (i.family === 'IPv4' && !i.internal) console.log(`  LAN:   http://${i.address}:${port}`);
    console.log('\n  Keep this terminal running. Ctrl+C to stop.\n');
  });
}
