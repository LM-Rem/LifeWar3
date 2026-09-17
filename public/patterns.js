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
export const PATTERNS = [
  { id: 'glider', name: '滑翔机', en: 'GLIDER', role: '侦察 / 推进', desc: '每 4 代沿对角线移动 1 格。旋转以改变航向。', cells: [[1,0],[2,1],[0,2],[1,2],[2,2]] },
  { id: 'lwss', name: '轻型飞船', en: 'LIGHTWEIGHT', role: '快速 / 突击', desc: '每 4 代水平移动 2 格。默认向左，适合快速突击。', cells: [[1,0],[4,0],[0,1],[0,2],[4,2],[0,3],[1,3],[2,3],[3,3]] },
  { id: 'block', name: '锚点', en: 'ANCHOR', role: '稳定 / 驻守', desc: '稳定的 2×2 静物。用于已控制领地的节点驻守，不能直接投放到中立分区。', cells: [[0,0],[1,0],[0,1],[1,1]] },
  { id: 'blinker', name: '脉冲', en: 'PULSE', role: '震荡 / 防守', desc: '周期为 2 的振荡器。低能耗的节点驻守图案。', cells: [[0,1],[1,1],[2,1]] },
  { id: 'r', name: '裂变种子', en: 'R-PENTOMINO', role: '扩散 / 干扰', desc: '小规模投入触发长时间复杂演化。部署时远离己方阵列。', cells: [[1,0],[2,0],[0,1],[1,1],[1,2]] },
  { id: 'pulsar', name: '脉冲星', en: 'PULSAR', role: '震荡 / 阵列', desc: '周期为 3 的对称振荡器，构成大范围防御阵列。', cells: (() => { const a=[]; for(const y of [0,5,7,12]) for(const x of [2,3,4,8,9,10]) a.push([x,y]); for(const x of [0,5,7,12]) for(const y of [2,3,4,8,9,10]) a.push([x,y]); return a; })() },
  { id: 'squadron', name: '滑翔编队', en: 'SQUADRON', role: '编队 / 压制', desc: '三架平行滑翔机同时推进。通过旋转选择进攻方向。', cells: [[1,0],[2,1],[0,2],[1,2],[2,2],[9,0],[10,1],[8,2],[9,2],[10,2],[17,0],[18,1],[16,2],[17,2],[18,2]] },
];

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
    if (x > 32 || y > 31 || cells.length > 256) throw new Error('图案最大 32×32，最多 256 个细胞');
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
