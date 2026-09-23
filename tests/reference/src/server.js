import http from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { Game, RULES } from './engine.js';
import { runBots } from './bots.js';

const ROOT = fileURLToPath(new URL('../public/', import.meta.url));
const LIBRARY_DIR = fileURLToPath(new URL('../图案集_128/', import.meta.url));
const PATTERNS_FILE = fileURLToPath(new URL('../public/patterns.json', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const safeName = name => String(name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || '匿名指挥官';
const send = (ws, value) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
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

export function createServer({ port = Number(process.env.PORT) || 3000, host = '0.0.0.0' } = {}) {
  const rooms = new Map();
  let serverGen = 0; // 服务器全局演化代数，用于按代判断的房间清理
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
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
      res.end(data);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    let allowed = req.url === '/ws' && wss.clients.size < 64;
    try { if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) allowed = false; } catch { allowed = false; }
    if (!allowed) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  function roomView(room) {
    return { type: 'room', code: room.code, host: room.host, status: room.game?.status || 'lobby', players: room.members.map(m => ({ id: m.id, name: m.name, ready: m.ready, bot: m.bot, connected: !!m.ws || m.bot })), capacity: 4 };
  }
  function broadcastRoom(room) { for (const m of room.members) send(m.ws, roomView(room)); }
  function lobbyList(ws) { send(ws, { type: 'rooms', rooms: [...rooms.values()].map(r => ({ code: r.code, name: `${r.members[0]?.name || '未知'} 的战区`, count: r.members.length, status: r.game?.status || 'lobby' })) }); }
  function updateLists() { for (const ws of wss.clients) if (!ws.member) lobbyList(ws); }
  function unlink(ws, explicit = false) {
    const room = ws.room, member = ws.member;
    if (!room || !member) return;
    if (room.game && room.game.status === 'playing') {
      member.ws = null; member.offlineGen = room.game.generation;
      if (explicit) {
        member.token = ''; room.game.eliminate(member.id); room.game.checkVictory();
        if (room.host === member.id) room.host = room.members.find(m => m !== member && m.ws)?.id ?? room.host;
      }
    } else {
      room.members = room.members.filter(m => m !== member);
      if (room.host === member.id) room.host = room.members.find(m => !m.bot)?.id;
    }
    ws.room = null; ws.member = null;
    if (!room.members.some(m => !m.bot)) rooms.delete(room.code);
    else broadcastRoom(room);
    updateLists();
  }
  function attach(ws, room, member) {
    ws.room = room; ws.member = member; member.ws = ws; member.offlineGen = null;
    send(ws, { type: 'welcome', id: member.id, token: member.token, code: room.code });
    broadcastRoom(room);
    if (room.game) { send(ws, { type: 'started', id: member.id, rules: RULES, startedAt: room.startedAt }); send(ws, room.game.state(member.id)); ws.send(room.game.packet(true)); }
    updateLists();
  }
  function start(room) {
    const hostMember = room.members.find(m => m.id === room.host);
    room.members.forEach((m, i) => { m.id = i + 1; });
    room.host = hostMember.id;
    room.game = new Game(room.members); room.startedGen = serverGen; room.startedAt = room.game.startedAt; room.lastActiveGen = serverGen; room.finishedBroadcast = false;
    for (const m of room.members) { send(m.ws, { type: 'started', id: m.id, rules: RULES, startedAt: room.startedAt }); send(m.ws, room.game.state(m.id)); if (m.ws?.readyState === WebSocket.OPEN) m.ws.send(room.game.packet(true)); }
    broadcastRoom(room); updateLists();
  }
  wss.on('connection', ws => {
    ws.alive = true; ws.budget = 40; ws.refillAt = Date.now();
    ws.on('pong', () => { ws.alive = true; });
    send(ws, { type: 'hello', version: '1.0.0' }); lobbyList(ws);
    ws.on('error', () => {});
    ws.on('message', (raw, isBinary) => {
      ws.budget = Math.min(40, ws.budget + (Date.now() - ws.refillAt) / 100); ws.refillAt = Date.now();
      if (--ws.budget < 0) return send(ws, { type: 'error', message: '操作过快，请稍后重试' });
      let msg;
      try { if (isBinary) return; msg = JSON.parse(raw.toString()); if (!msg || typeof msg !== 'object') return; } catch { return; }
      const room = ws.room, member = ws.member;
      const fail = message => send(ws, { type: 'error', message });
      switch (msg.type) {
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
          if (m.ws && m.ws !== ws) { const old = m.ws; old.member = null; old.room = null; old.close(4001, 'Session resumed elsewhere'); }
          attach(ws, r, m); return;
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
          const result = room.game.pickCard(member.id, String(msg.cardId || ''));
          if (result.error) return fail(result.error);
          send(ws, { type: 'card_picked', playerId: member.id, cardId: result.card.id });
          send(ws, room.game.state(member.id));
          return;
        }
        case 'play_card': {
          if (!room?.game || !member) return fail('尚未进入对局');
          const result = room.game.playCard(member.id, String(msg.cardId || ''), Number.isInteger(msg.x) ? msg.x : undefined, Number.isInteger(msg.y) ? msg.y : undefined, msg.instanceId);
          if (result.error) return fail(result.error);
          for (const m of room.members) {
            send(m.ws, { type: 'card_played', playerId: member.id, cardId: String(msg.cardId || ''), x: msg.x, y: msg.y });
            send(m.ws, room.game.state(m.id));
          }
          return;
        }
      }
    });
    ws.on('close', () => unlink(ws));
  });

  const timer = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (room.members.some(m => m.ws)) room.lastActive = now;
      else if (now - room.lastActive > 90000) { rooms.delete(room.code); updateLists(); continue; }
      const game = room.game;
      if (!game) continue;
      for (const m of room.members) if (game.status === 'playing' && !m.bot && !m.ws && m.offlineAt && now - m.offlineAt > 90000 && !game.players[m.id-1].eliminated) {
        game.eliminate(m.id); game.checkVictory();
        if(room.host === m.id) { room.host = room.members.find(other => other.ws)?.id ?? room.host; broadcastRoom(room); }
      }
      if (game.status === 'playing') {
        if (game.generation % Math.max(1, Math.round(RULES.hz * 3)) === 0) runBots(game); // 保持约每秒 0.33 次 AI 决策，与 hz 解耦
        const t = performance.now(); game.step(); room.tickMs = performance.now() - t;
      }
      if (game.status === 'finished') {
        if (!room.members.find(m => m.id === room.host)?.ws) {
          const nextHost = room.members.find(m => m.ws);
          if (nextHost && nextHost.id !== room.host) { room.host = nextHost.id; broadcastRoom(room); }
        }
        if (room.finishedBroadcast) continue;
        broadcastRoom(room); updateLists();
      }
      const packet = game.packet();
      for (const m of room.members) {
        const ws=m.ws;
        if (ws?.readyState !== WebSocket.OPEN) continue;
        if (ws.bufferedAmount > 262144) { ws.needsSnapshot = true; continue; }
        ws.send(ws.needsSnapshot ? game.packet(true) : packet); ws.needsSnapshot = false;
        if (game.generation % Math.max(1, Math.round(RULES.hz / 5)) === 0 || game.status === 'finished') send(ws, { ...game.state(m.id), tickMs: Math.round((room.tickMs || 0) * 100) / 100 }); // 状态推送保持约 5Hz，与 hz 解耦
      }
      game.changes.clear();
      if (game.status === 'finished') room.finishedBroadcast = true;
    }
  }, 1000 / RULES.hz);
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
  }, 15000);
  const closed = () => { clearInterval(timer); clearInterval(heartbeat); for (const ws of wss.clients) ws.terminate(); wss.close(); };
  server.on('close', closed);
  return { server, rooms, wss, listen: () => new Promise(resolve => server.listen(port, host, () => resolve(server.address()))), close: () => new Promise(resolve => { closed(); server.close(resolve); }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createServer();
  app.listen().then(({port}) => {
    console.log(`\n  LIFEWAR / NEXUS\n  Local: http://localhost:${port}`);
    for (const i of Object.values(os.networkInterfaces()).flat()) if (i.family === 'IPv4' && !i.internal) console.log(`  LAN:   http://${i.address}:${port}`);
    console.log('\n  Keep this terminal running. Ctrl+C to stop.\n');
  });
}
