import { normalize } from './patterns.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function toast(message, error = false) {
  const el = document.createElement('div'); el.className = 'toast' + (error ? ' error' : ''); el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('exiting'); setTimeout(() => el.remove(), 250); }, 3400);
}

// ---------- .cells 解析 ----------
function parseCells(text) {
  const cells = [];
  const lines = text.split(/\r?\n/);
  let y = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('!')) continue;
    for (let x = 0; x < line.length; x++) {
      const ch = line[x];
      if (ch === 'O' || ch === 'o') cells.push([x, y]);
    }
    y++;
  }
  return normalize(cells);
}

// ---------- 生命演化模拟器 ----------
class LifeSim {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cells = new Map();
    this.generation = 0;
    this.running = false;
    this.speed = 10;
    this.timer = null;
    this.camera = { x: 0, y: 0, scale: 10 };
    this.drag = null;
  }
  setCells(cells) {
    this.cells = new Map();
    for (const [x, y] of cells) this.cells.set(`${x},${y}`, [x, y]);
    this.generation = 0;
    this.fitView();
    this.render();
  }
  fitView() {
    const points = [...this.cells.values()];
    if (!points.length) return;
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = Math.max(1, maxX - minX + 3), h = Math.max(1, maxY - minY + 3);
    const W = this.canvas.width, H = this.canvas.height;
    this.camera.scale = Math.max(2, Math.min(24, Math.floor(Math.min(W / w, H / h))));
    this.camera.x = (minX + maxX) / 2;
    this.camera.y = (minY + maxY) / 2;
  }
  step() {
    const next = new Map();
    const counts = new Map();
    for (const [x, y] of this.cells.values()) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nk = `${x + dx},${y + dy}`;
          counts.set(nk, (counts.get(nk) || 0) + 1);
        }
      }
    }
    for (const [key, count] of counts) {
      if (count === 3 || (count === 2 && this.cells.has(key))) {
        const [nx, ny] = key.split(',').map(Number);
        next.set(key, [nx, ny]);
      }
    }
    this.cells = next;
    this.generation++;
    // 视图保持静止，让图案在网格上自然移动，便于观察运动方向。
    this.render();
  }
  play() { this.running = true; this.schedule(); this.updatePlayButton(); }
  pause() { this.running = false; clearInterval(this.timer); this.updatePlayButton(); }
  toggle() { this.running ? this.pause() : this.play(); }
  schedule() { clearInterval(this.timer); if (this.running) this.timer = setInterval(() => this.step(), 1000 / this.speed); }
  updatePlayButton() { $('#sim-play').textContent = this.running ? '❚❚ 暂停' : '▶ 演化'; }
  render() {
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height;
    c.fillStyle = '#08131a'; c.fillRect(0, 0, W, H);
    const { x: cx, y: cy, scale } = this.camera;
    const ox = W / 2 - cx * scale, oy = H / 2 - cy * scale;
    c.strokeStyle = '#14262f'; c.lineWidth = 1; c.beginPath();
    const x0 = Math.floor((0 - ox) / scale), x1 = Math.ceil((W - ox) / scale);
    const y0 = Math.floor((0 - oy) / scale), y1 = Math.ceil((H - oy) / scale);
    for (let x = x0; x <= x1; x++) { const px = ox + x * scale; c.moveTo(px, 0); c.lineTo(px, H); }
    for (let y = y0; y <= y1; y++) { const py = oy + y * scale; c.moveTo(0, py); c.lineTo(W, py); }
    c.stroke();
    c.fillStyle = '#67f5d1';
    for (const [x, y] of this.cells.values()) {
      const px = ox + x * scale, py = oy + y * scale;
      if (px + scale < 0 || py + scale < 0 || px > W || py > H) continue;
      c.fillRect(px + 0.5, py + 0.5, scale - 1, scale - 1);
    }
    $('#sim-generation').textContent = `GEN ${this.generation}`;
    $('#sim-population').textContent = this.cells.size;
  }
}

const sim = new LifeSim($('#sim-canvas'));

// ---------- 图案列表 ----------
let files = [];
let selectedFile = null;
let currentCells = [];
let currentComments = [];

async function loadLibrary() {
  try {
    const data = await fetch('/api/library').then(r => r.json());
    files = data.files || [];
    $('#library-count').textContent = `${files.length} FILES`;
    renderList();
  } catch { $('#library-list').innerHTML = '<div class="empty-rooms">无法读取图案集<br>请确认服务器已启动</div>'; }
}

function renderList() {
  const q = $('#library-search').value.trim().toLowerCase();
  const matches = q ? files.filter(f => f.toLowerCase().includes(q)) : files;
  const shown = matches.slice(0, 300);
  $('#library-count').textContent = `${matches.length} / ${files.length} FILES`;
  $('#library-list').innerHTML = shown.length
    ? shown.map(f => `<button class="library-file ${f === selectedFile ? 'selected' : ''}" data-file="${escapeHTML(f)}"><span class="library-file-dot"></span>${escapeHTML(f)}</button>`).join('')
    : '<div class="empty-rooms">没有匹配的图案</div>';
  $$('.library-file').forEach(b => b.onclick = () => loadFile(b.dataset.file));
}

async function loadFile(name) {
  selectedFile = name;
  renderList();
  try {
    const data = await fetch('/api/library?file=' + encodeURIComponent(name)).then(r => r.json());
    const text = data.content || '';
    currentComments = text.split(/\r?\n/).filter(l => l.trim().startsWith('!')).map(l => l.replace(/^!\s?/, '').trim());
    currentCells = parseCells(text);
    sim.pause(); sim.setCells(currentCells); sim.render();
    const xs = currentCells.map(c => c[0]), ys = currentCells.map(c => c[1]);
    const w = Math.max(...xs) - Math.min(...xs) + 1, h = Math.max(...ys) - Math.min(...ys) + 1;
    $('#library-detail').innerHTML = `
      <h3>${escapeHTML(name.replace(/\.cells$/i, ''))}</h3>
      <p class="library-comments">${currentComments.length ? currentComments.map(escapeHTML).join('<br>') : '<span class="muted">（无说明）</span>'}</p>
      <div class="library-meta"><span>${currentCells.length} CELLS</span><span>${w} × ${h}</span><span>${currentCells.length} EN</span></div>`;
    sim.play();
  } catch { toast('读取图案失败：' + name, true); }
}

$('#library-search').addEventListener('input', renderList);

// ---------- 分类选择 ----------
let categories = [];
let selectedCategory = 'other';

async function loadCategories() {
  try {
    const data = await fetch('/patterns.json').then(r => r.json());
    categories = data.categories || [];
    if (categories.length) selectedCategory = categories[0].id;
    renderCategories();
  } catch { /* 加载失败时使用 other 分类 */ }
}
function renderCategories() {
  $('#library-categories').innerHTML = categories.map(c => `<button class="category-tag ${c.id === selectedCategory ? 'active' : ''}" data-category="${escapeHTML(c.id)}">${escapeHTML(c.name)}</button>`).join('');
  $$('#library-categories .category-tag').forEach(b => b.onclick = () => { selectedCategory = b.dataset.category; renderCategories(); });
}

// ---------- 添加到 patterns.json ----------
$('#library-add').onclick = async () => {
  if (!currentCells.length) return toast('请先选择一个图案', true);
  const baseName = (selectedFile || '').replace(/\.cells$/i, '');
  const customName = $('#library-name').value.trim();
  const category = selectedCategory || 'other';
  try {
    const res = await fetch('/api/patterns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: customName.slice(0, 32) || baseName.slice(0, 32) || '未命名图案',
        en: 'LIBRARY DNA',
        role: '图案库 / 导入',
        desc: `来自图案集 ${selectedFile || '未命名'}，共 ${currentCells.length} 个细胞。`,
        category,
        cells: currentCells,
      }),
    });
    const data = await res.json();
    if (data.ok) toast(`已添加「${data.pattern.name}」到生命图谱`);
    else toast(typeof data === 'string' ? data : '添加失败，请检查数据', true);
  } catch { toast('添加失败：无法连接服务器', true); }
};

// ---------- 模拟控制 ----------
$('#sim-play').onclick = () => sim.toggle();
$('#sim-step').onclick = () => { sim.pause(); sim.step(); };
$('#sim-reset').onclick = () => { sim.pause(); if (currentCells.length) { sim.setCells(currentCells); sim.render(); } };
$('#sim-focus').onclick = () => { if (currentCells.length) sim.fitView(); };
$('#sim-speed').oninput = e => { sim.speed = Number(e.target.value); $('#sim-speed-label').textContent = sim.speed; sim.schedule(); };

// 画布：滚轮缩放，右键/中键拖动平移
const canvas = $('#sim-canvas');
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointerdown', e => {
  if (e.button === 2 || e.button === 1) {
    const r = canvas.getBoundingClientRect();
    sim.drag = { x: e.clientX, y: e.clientY, camX: sim.camera.x, camY: sim.camera.y };
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
});
canvas.addEventListener('pointermove', e => {
  if (sim.drag) {
    const r = canvas.getBoundingClientRect();
    const dx = (e.clientX - sim.drag.x) / r.width * canvas.width / sim.camera.scale;
    const dy = (e.clientY - sim.drag.y) / r.height * canvas.height / sim.camera.scale;
    sim.camera.x = sim.drag.camX - dx;
    sim.camera.y = sim.drag.camY - dy;
    sim.render();
  }
});
canvas.addEventListener('pointerup', e => { sim.drag = null; if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId); });
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width * canvas.width;
  const py = (e.clientY - r.top) / r.height * canvas.height;
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const next = Math.max(1, Math.min(64, sim.camera.scale * factor));
  const gx = sim.camera.x + (px - canvas.width / 2) / sim.camera.scale;
  const gy = sim.camera.y + (py - canvas.height / 2) / sim.camera.scale;
  sim.camera.scale = next;
  sim.camera.x = gx - (px - canvas.width / 2) / next;
  sim.camera.y = gy - (py - canvas.height / 2) / next;
  sim.render();
}, { passive: false });

loadLibrary();
loadCategories();