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
    this.leftStart = null;
    this.leftMoved = false;
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

// ---------- 全局状态 ----------
let mode = 'files'; // 'files' | 'game'
let currentDir = '';          // 当前目录（相对图案集_128 根，如 '16x16/静物'）
let currentEntries = { dirs: [], files: [] };
let gamePatterns = [];
let selectedFile = null;
let selectedPattern = null;
let currentCells = [];
let currentComments = [];
let categories = [];
let selectedCategory = 'other';
let searchQuery = '';         // 全局搜索关键词（遍历子目录），空表示浏览模式
let searchTimer = null;       // 搜索防抖计时器

const categoryName = id => categories.find(c => c.id === id)?.name || id || 'other';
const baseName = p => String(p || '').split('/').pop();

// ---------- 图案集 tab（文件管理器式目录浏览） ----------
async function loadLibrary() {
  try {
    const data = await fetch('/api/library?dir=' + encodeURIComponent(currentDir)).then(r => r.json());
    currentEntries = { dirs: data.dirs || [], files: data.files || [] };
    renderPath();
    renderFileList();
  } catch { $('#library-list').innerHTML = '<div class="empty-rooms">无法读取图案集<br>请确认服务器已启动</div>'; }
}

function renderPath() {
  const el = $('#library-path');
  if (!el) return;
  el.style.display = mode === 'files' ? 'flex' : 'none';
  const segments = currentDir ? currentDir.split('/') : [];
  let acc = '';
  const crumbs = ['<button class="path-crumb" data-level="">图案集_128</button>'];
  segments.forEach(seg => {
    acc = acc ? acc + '/' + seg : seg;
    crumbs.push(`<span class="path-sep">/</span><button class="path-crumb" data-level="${escapeHTML(acc)}">${escapeHTML(seg)}</button>`);
  });
  el.innerHTML = crumbs.join('');
  $$('.path-crumb').forEach(b => b.onclick = () => { currentDir = b.dataset.level; loadLibrary(); });
}

function renderFileList() {
  const q = $('#library-search').value.trim().toLowerCase();
  const dirs = currentEntries.dirs || [];
  const files = currentEntries.files || [];
  const shownDirs = q ? dirs.filter(d => d.toLowerCase().includes(q)) : dirs;
  const shownFiles = q ? files.filter(f => f.toLowerCase().includes(q)) : files;
  $('#library-count').textContent = `${shownDirs.length + shownFiles.length} 项`;
  const parts = [];
  if (currentDir && !q) {
    parts.push('<button class="library-file library-up" id="library-up"><span class="library-file-arrow">↰</span><span>返回上级</span></button>');
  }
  shownDirs.forEach(d => {
    const rel = currentDir ? currentDir + '/' + d : d;
    parts.push(`<button class="library-file library-dir" data-dir="${escapeHTML(rel)}"><span class="library-file-arrow">▸</span><span>${escapeHTML(d)}</span></button>`);
  });
  shownFiles.forEach((f, i) => {
    const rel = currentDir ? currentDir + '/' + f : f;
    parts.push(`<button class="library-file ${rel === selectedFile ? 'selected' : ''}" data-file="${escapeHTML(rel)}"><span class="library-file-index">${String(i + 1).padStart(2, '0')}</span><span class="library-file-dot"></span><span class="library-file-name">${escapeHTML(f)}</span></button>`);
  });
  $('#library-list').innerHTML = parts.length ? parts.join('') : '<div class="empty-rooms">没有匹配的图案</div>';
  $$('.library-file[data-dir]').forEach(b => b.onclick = () => { currentDir = b.dataset.dir; loadLibrary(); });
  $$('.library-file[data-file]').forEach(b => b.onclick = () => loadFile(b.dataset.file));
  const up = $('#library-up');
  if (up) up.onclick = () => { currentDir = currentDir.split('/').slice(0, -1).join('/'); loadLibrary(); };
}

// ---------- 遍历子目录搜索 ----------
async function searchLibrary(q) {
  searchQuery = q;
  const pathEl = $('#library-path');
  if (pathEl) pathEl.style.display = 'none';
  try {
    const data = await fetch('/api/library?search=' + encodeURIComponent(q)).then(r => r.json());
    const results = data.files || [];
    $('#library-count').textContent = `${results.length} 个结果`;
    $('#library-list').innerHTML = results.length
      ? results.map((f, i) => {
          const dirPart = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
          return `<button class="library-file ${f === selectedFile ? 'selected' : ''}" data-file="${escapeHTML(f)}"><span class="library-file-index">${String(i + 1).padStart(2, '0')}</span><span class="library-file-dot"></span><span class="library-file-name">${escapeHTML(baseName(f))}</span>${dirPart ? `<span class="library-file-sub">${escapeHTML(dirPart)}</span>` : ''}</button>`;
        }).join('')
      : '<div class="empty-rooms">没有匹配的图案</div>';
    $$('.library-file[data-file]').forEach(b => b.onclick = () => loadFile(b.dataset.file));
  } catch { $('#library-list').innerHTML = '<div class="empty-rooms">搜索失败</div>'; }
}

// 根据当前输入框与模式刷新列表：有搜索词时遍历子目录，否则回到目录浏览
function refreshList() {
  if (mode === 'game') return renderGameList();
  const q = $('#library-search').value.trim().toLowerCase();
  if (q) searchLibrary(q);
  else { searchQuery = ''; loadLibrary(); }
}

async function loadFile(name) {
  selectedFile = name;
  selectedPattern = null;
  $('#library-add').textContent = '添加到生命图谱 ↗';
  $('#library-delete').hidden = true;
  fillEditorForm();
  refreshList();
  try {
    const data = await fetch('/api/library?file=' + encodeURIComponent(name)).then(r => r.json());
    const text = data.content || '';
    currentComments = text.split(/\r?\n/).filter(l => l.trim().startsWith('!')).map(l => l.replace(/^!\s?/, '').trim());
    currentCells = parseCells(text);
    sim.pause(); sim.setCells(currentCells); sim.render();
    renderDetail();
    sim.play();
  } catch { toast('读取图案失败：' + baseName(name), true); }
}

// ---------- 生命图谱 tab ----------
async function loadGamePatterns() {
  try {
    const data = await fetch('/patterns.json').then(r => r.json());
    gamePatterns = data.patterns || [];
    if (!categories.length && Array.isArray(data.categories)) categories = data.categories;
    renderGameList();
  } catch { $('#library-list').innerHTML = '<div class="empty-rooms">无法读取生命图谱<br>请确认服务器已启动</div>'; }
}

function renderGameList() {
  const q = $('#library-search').value.trim().toLowerCase();
  const matches = q ? gamePatterns.filter(p => (p.name || '').toLowerCase().includes(q) || (p.en || '').toLowerCase().includes(q)) : gamePatterns;
  const shown = matches; // 不限制数量，全部条目展示
  $('#library-count').textContent = `${matches.length} / ${gamePatterns.length} PATTERNS`;
  $('#library-list').innerHTML = shown.length
    ? shown.map((p, i) => `<button class="library-file ${p.id === selectedPattern?.id ? 'selected' : ''}" data-pattern="${escapeHTML(p.id)}"><span class="library-file-index">${String(i + 1).padStart(2, '0')}</span><span class="library-file-dot"></span>${escapeHTML(p.name || p.en || p.id)}<span class="library-file-meta">${escapeHTML(categoryName(p.category))} · ${p.cells.length} EN</span></button>`).join('')
    : '<div class="empty-rooms">没有匹配的图案</div>';
  $$('.library-file').forEach(b => b.onclick = () => loadGamePattern(b.dataset.pattern));
}

function loadGamePattern(id) {
  const pattern = gamePatterns.find(p => p.id === id);
  if (!pattern) return;
  selectedPattern = pattern;
  selectedFile = null;
  currentComments = (pattern.desc || '').split('\n').filter(Boolean);
  currentCells = (pattern.cells || []).map(c => [c[0], c[1]]);
  sim.pause(); sim.setCells(currentCells); sim.render();
  $('#library-add').textContent = '保存修改';
  $('#library-delete').hidden = false;
  fillEditorForm();
  renderGameList();
  renderDetail();
  sim.play();
}

// ---------- 详情与表单 ----------
function setDetailCollapsed(collapsed, save = true) {
  const el = $('#library-detail');
  if (!el) return;
  el.classList.toggle('collapsed', collapsed);
  const btn = $('#library-detail-toggle');
  if (btn) btn.textContent = collapsed ? '▸' : '▾';
  if (save) { try { localStorage.setItem('library-detail-collapsed', collapsed ? '1' : '0'); } catch { /* 忽略 */ } }
}

function renderDetail() {
  const body = $('#library-detail-body');
  if (!body) return;
  if (selectedPattern) {
    const p = selectedPattern;
    const xs = currentCells.map(c => c[0]), ys = currentCells.map(c => c[1]);
    const w = currentCells.length ? Math.max(...xs) - Math.min(...xs) + 1 : 0;
    const h = currentCells.length ? Math.max(...ys) - Math.min(...ys) + 1 : 0;
    body.innerHTML = `
      <h3>${escapeHTML(p.name || p.en || p.id)}</h3>
      <p class="library-comments">${escapeHTML(p.desc || '（无描述）')}</p>
      <div class="library-meta"><span>${currentCells.length} CELLS</span><span>${w} × ${h}</span><span>${currentCells.length} EN</span><span>${escapeHTML(categoryName(p.category))}</span></div>`;
  } else if (selectedFile) {
    const xs = currentCells.map(c => c[0]), ys = currentCells.map(c => c[1]);
    const w = currentCells.length ? Math.max(...xs) - Math.min(...xs) + 1 : 0;
    const h = currentCells.length ? Math.max(...ys) - Math.min(...ys) + 1 : 0;
    body.innerHTML = `
      <h3>${escapeHTML(selectedFile.replace(/\.cells$/i, ''))}</h3>
      <p class="library-comments">${currentComments.length ? currentComments.map(escapeHTML).join('<br>') : '<span class="muted">（无说明）</span>'}</p>
      <div class="library-meta"><span>${currentCells.length} CELLS</span><span>${w} × ${h}</span><span>${currentCells.length} EN</span></div>`;
  } else {
    body.innerHTML = '<div class="empty-rooms">选择左侧图案以预览</div>';
  }
}

function fillEditorForm() {
  if (selectedPattern) {
    $('#library-name').value = selectedPattern.name || '';
    $('#library-en').value = selectedPattern.en || '';
    $('#library-role').value = selectedPattern.role || '';
    $('#library-desc').value = selectedPattern.desc || '';
    selectedCategory = categories.some(c => c.id === selectedPattern.category) ? selectedPattern.category : (categories[0]?.id || 'other');
  } else {
    $('#library-name').value = '';
    $('#library-en').value = '';
    $('#library-role').value = '';
    $('#library-desc').value = '';
    if (categories.length) selectedCategory = categories[0].id;
  }
  renderCategories();
}

// ---------- 分类选择 ----------
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

// ---------- 添加到生命图谱 / 保存修改 ----------
async function addGamePattern() {
  if (!currentCells.length) return toast('请先选择一个图案', true);
  const fileBase = baseName(selectedFile).replace(/\.cells$/i, '');
  const customName = $('#library-name').value.trim();
  const en = $('#library-en').value.trim();
  const role = $('#library-role').value.trim();
  const desc = $('#library-desc').value.trim();
  const category = selectedCategory || 'other';
  try {
    const res = await fetch('/api/patterns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: customName.slice(0, 32) || fileBase.slice(0, 32) || '未命名图案',
        en: en.slice(0, 32) || 'LIBRARY DNA',
        role: role.slice(0, 32) || '图案库 / 导入',
        desc: desc.slice(0, 200) || `来自图案集 ${fileBase || '未命名'}，共 ${currentCells.length} 个细胞。`,
        category,
        cells: currentCells,
      }),
    });
    const data = await res.json();
    if (data.ok) toast(`已添加「${data.pattern.name}」到生命图谱`);
    else toast(typeof data === 'string' ? data : '添加失败，请检查数据', true);
  } catch { toast('添加失败：无法连接服务器', true); }
}

async function saveGamePattern() {
  if (!selectedPattern) return;
  const cells = normalize(currentCells);
  if (!cells.length) return toast('图案不能为空', true);
  const name = $('#library-name').value.trim() || selectedPattern.name;
  const en = $('#library-en').value.trim();
  const role = $('#library-role').value.trim();
  const desc = $('#library-desc').value.trim();
  const category = selectedCategory || 'other';
  try {
    const res = await fetch('/api/patterns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update', id: selectedPattern.id, name, en, role, desc, category, cells }),
    });
    const data = await res.json();
    if (data.ok) {
      toast(`已保存「${data.pattern?.name || name}」的修改`);
      await loadGamePatterns();
      if (data.pattern) loadGamePattern(data.pattern.id);
    } else toast(typeof data === 'string' ? data : '保存失败，请检查数据', true);
  } catch { toast('保存失败：无法连接服务器', true); }
}

$('#library-add').onclick = () => {
  if (!currentCells.length) return toast('请先选择一个图案', true);
  if (mode === 'game' && selectedPattern) saveGamePattern();
  else addGamePattern();
};

$('#library-delete').onclick = async () => {
  if (!selectedPattern) return;
  if (!confirm(`确定删除「${selectedPattern.name || selectedPattern.en}」吗？此操作不可恢复。`)) return;
  try {
    const res = await fetch('/api/patterns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', id: selectedPattern.id }),
    });
    const data = await res.json();
    if (data.ok) {
      toast(`已删除「${selectedPattern.name}」`);
      selectedPattern = null; currentCells = []; currentComments = [];
      sim.pause();
      $('#library-add').textContent = '添加到生命图谱 ↗';
      $('#library-delete').hidden = true;
      fillEditorForm();
      renderDetail();
      await loadGamePatterns();
    } else toast(typeof data === 'string' ? data : '删除失败', true);
  } catch { toast('删除失败：无法连接服务器', true); }
};

// ---------- 标签页切换 ----------
$$('.library-tab').forEach(b => b.onclick = () => {
  mode = b.dataset.tab;
  $$('.library-tab').forEach(t => { const active = t === b; t.classList.toggle('active', active); t.setAttribute('aria-selected', String(active)); });
  $('#library-search').placeholder = mode === 'game' ? '搜索生命图谱图案…' : '搜索当前目录…（如 glider）';
  selectedFile = null; selectedPattern = null; currentCells = []; currentComments = [];
  sim.pause();
  $('#library-add').textContent = '添加到生命图谱 ↗';
  $('#library-delete').hidden = true;
  fillEditorForm();
  renderDetail();
  if (mode === 'game') loadGamePatterns();
  else refreshList();
});

$('#library-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { mode === 'game' ? renderGameList() : refreshList(); }, 250);
});

// ---------- 模拟控制 ----------
$('#sim-play').onclick = () => sim.toggle();
$('#sim-step').onclick = () => { sim.pause(); sim.step(); };
$('#sim-reset').onclick = () => { sim.pause(); if (currentCells.length) { sim.setCells(currentCells); sim.render(); } };
$('#sim-focus').onclick = () => { if (currentCells.length) sim.fitView(); };
$('#sim-speed').oninput = e => { sim.speed = Number(e.target.value); $('#sim-speed-label').textContent = sim.speed; sim.schedule(); };

// ---------- 画布：左键编辑（生命图谱），右键/中键拖动平移，滚轮缩放 ----------
const canvas = $('#sim-canvas');
canvas.addEventListener('contextmenu', e => e.preventDefault());

function toggleCell(e) {
  sim.pause();
  const rect = canvas.getBoundingClientRect();
  const px = (e.clientX - rect.left) / rect.width * canvas.width;
  const py = (e.clientY - rect.top) / rect.height * canvas.height;
  const gx = Math.floor(sim.camera.x + (px - canvas.width / 2) / sim.camera.scale);
  const gy = Math.floor(sim.camera.y + (py - canvas.height / 2) / sim.camera.scale);
  const key = `${gx},${gy}`;
  if (sim.cells.has(key)) sim.cells.delete(key);
  else sim.cells.set(key, [gx, gy]);
  currentCells = [...sim.cells.values()].map(([x, y]) => [x, y]);
  sim.render();
}

canvas.addEventListener('pointerdown', e => {
  if (e.button === 0) {
    sim.leftStart = { x: e.clientX, y: e.clientY };
    sim.leftMoved = false;
    return;
  }
  if (e.button === 2 || e.button === 1) {
    const r = canvas.getBoundingClientRect();
    sim.drag = { x: e.clientX, y: e.clientY, camX: sim.camera.x, camY: sim.camera.y };
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
});
canvas.addEventListener('pointermove', e => {
  if (sim.leftStart) {
    const dx = e.clientX - sim.leftStart.x, dy = e.clientY - sim.leftStart.y;
    if (Math.hypot(dx, dy) > 4) sim.leftMoved = true;
  }
  if (sim.drag) {
    const r = canvas.getBoundingClientRect();
    const dx = (e.clientX - sim.drag.x) / r.width * canvas.width / sim.camera.scale;
    const dy = (e.clientY - sim.drag.y) / r.height * canvas.height / sim.camera.scale;
    sim.camera.x = sim.drag.camX - dx;
    sim.camera.y = sim.drag.camY - dy;
    sim.render();
  }
});
canvas.addEventListener('pointerup', e => {
  if (e.button === 0 && sim.leftStart && !sim.leftMoved && mode === 'game' && selectedPattern) toggleCell(e);
  sim.leftStart = null; sim.leftMoved = false;
  sim.drag = null;
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
});
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

// 详情面板折叠：恢复上次状态；点击整个标题栏任意位置即可折叠/展开
try { setDetailCollapsed(localStorage.getItem('library-detail-collapsed') === '1', false); } catch { /* 忽略 */ }
$('.library-detail-head').onclick = () => setDetailCollapsed(!$('#library-detail').classList.contains('collapsed'));

loadLibrary();
loadCategories();