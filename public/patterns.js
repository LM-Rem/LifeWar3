export const normalize = cells => {
  if (!cells.length) return [];
  const minX = Math.min(...cells.map(c => c[0])), minY = Math.min(...cells.map(c => c[1]));
  return cells.map(([x, y]) => [x - minX, y - minY]);
};
export function transform(cells, rotation = 0, flip = false) {
  return normalize(cells.map(([x, y]) => {
    if (flip) x = -x;
    for (let i = 0; i < rotation; i++) [x, y] = [-y, x];
    return [x, y];
  }));
}

// 图案数据统一保存在 patterns.json（分类 + 图案列表）。
// - Node 端（服务器 / 测试 / 实验脚本）：模块加载时同步读取 JSON，保证 PATTERNS 立即可用。
// - 浏览器端：由 app.js 通过 fetch 加载 patterns.json 后调用 setPatternData 注入。
export let PATTERNS = [];
export let PATTERN_CATEGORIES = [];

export function setPatternData(data) {
  PATTERN_CATEGORIES = Array.isArray(data?.categories) ? data.categories : [];
  PATTERNS = Array.isArray(data?.patterns) ? data.patterns : [];
  return PATTERNS;
}

if (typeof window === 'undefined') {
  const { readFileSync } = await import('node:fs');
  const data = JSON.parse(readFileSync(new URL('./patterns.json', import.meta.url), 'utf8'));
  setPatternData(data);
}

export function parseRLE(source) {
  const rule = source.match(/rule\s*=\s*([^\s,]+)/i)?.[1];
  if (rule && !/^(B3\/S23|23\/3)$/i.test(rule)) throw new Error('仅支持康威生命规则 B3/S23');
  const body = source.split(/\r?\n/).filter(l => !l.trim().startsWith('#') && !/^\s*x\s*=/i.test(l)).join('').replace(/\s/g, '');
  let x = 0, y = 0, number = '', cells = [];
  for (const ch of body) {
    if (/\d/.test(ch)) { number += ch; if (number.length > 4) throw new Error('RLE 数值过大'); continue; }
    const n = Number(number || 1); number = '';
    if (ch === '!') break;
    if (ch === '$') { y += n; x = 0; }
    else if (ch === 'b' || ch === 'o') { if (ch === 'o') for (let i = 0; i < n; i++) cells.push([x + i, y]); x += n; }
    else throw new Error('仅支持标准 B3/S23 的 b / o / $ / ! RLE 图案');
    if (x > 127 || y > 127 || cells.length > 4096) throw new Error('图案最大 128×128，最多 4096 个细胞');
  }
  if (!cells.length) throw new Error('图案中没有活细胞');
  return normalize(cells);
}
export function toRLE(cells) {
  cells = normalize(cells);
  const w = Math.max(...cells.map(c => c[0])) + 1, h = Math.max(...cells.map(c => c[1])) + 1, set = new Set(cells.map(c => c.join(',')));
  const lines = Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => set.has(`${x},${y}`) ? 'o' : 'b').join('').replace(/b+$/, ''));
  return `x = ${w}, y = ${h}, rule = B3/S23\n${lines.join('$')}!`;
}