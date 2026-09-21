// 卡牌模板：服务器（引擎）与浏览器共享的定义。
// effect 是引擎执行的参数化效果描述（服务器权威执行），浏览器仅用于显示名称/描述/费用。
// 后续扩展新卡牌只需在此追加模板，并在引擎 playCard 的 switch 中实现对应 effect.kind。

export const CARDS = [
  {
    id: 'great_flood',
    type: 'law',
    name: '大爆发',
    desc: '全局规则改为 B3/S012345678：活细胞永生、死细胞疯狂重生，持续 6 秒。',
    pool: 'early',
    effect: { kind: 'rule', birth: [0, 1, 2, 3, 4, 5, 6, 7, 8], survival: [0, 1, 2, 3, 4, 5, 6, 7, 8], duration: 60 }
  },
  {
    id: 'great_death',
    type: 'law',
    name: '大灭绝',
    desc: '全局规则改为 B3/S0：所有活细胞每代必死，只剩新出生的，持续 6 秒。',
    pool: 'early',
    effect: { kind: 'rule', birth: [3], survival: [0], duration: 60 }
  },
  {
    id: 'chaos_epoch',
    type: 'law',
    name: '混沌纪元',
    desc: '全局规则改为 B36/S23：高密度结构变得不稳定，持续 6 秒。',
    pool: 'early',
    effect: { kind: 'rule', birth: [3, 6], survival: [2, 3], duration: 60 }
  },
  {
    id: 'energy_burst',
    type: 'buff',
    name: '能量爆发',
    desc: '立即获得 +60 能量（不超过能量上限）。',
    pool: 'early',
    effect: { kind: 'energy', amount: 60 }
  },
  {
    id: 'purge',
    type: 'item',
    name: '净化',
    desc: '清除指定位置半径 20 格内的所有活细胞（不分敌我）。',
    pool: 'early',
    effect: { kind: 'purge', radius: 20 }
  },
  {
    id: 'silent_law',
    type: 'law',
    name: '寂静法则',
    desc: '全局规则改为 B3/S：所有活细胞每代消亡，只有新生的细胞闪烁，持续 6 秒。',
    pool: 'mid',
    effect: { kind: 'rule', birth: [3], survival: [], duration: 60 }
  },
  {
    id: 'collapse',
    type: 'law',
    name: '倒退',
    desc: '全局规则改为 B/S23：没有新生细胞，世界不可逆地收缩，持续 6 秒。',
    pool: 'mid',
    effect: { kind: 'rule', birth: [], survival: [2, 3], duration: 60 }
  },
  {
    id: 'energy_overload',
    type: 'buff',
    name: '过载协议',
    desc: '立即获得 +120 能量（不超过能量上限）。',
    pool: 'mid',
    effect: { kind: 'energy', amount: 120 }
  },
  {
    id: 'purge_large',
    type: 'item',
    name: '大净化',
    desc: '清除指定位置半径 30 格内的所有活细胞（不分敌我）。',
    pool: 'mid',
    effect: { kind: 'purge', radius: 30 }
  },
  {
    id: 'void',
    type: 'law',
    name: '虚空',
    desc: '全局规则改为 B/S：一切生命瞬间消亡且不再诞生，持续 9 秒。',
    pool: 'late',
    effect: { kind: 'rule', birth: [], survival: [], duration: 90 }
  },
  {
    id: 'eternal_flood',
    type: 'law',
    name: '永恒洪水',
    desc: '全局规则改为 B3/S012345678：细胞永生且疯狂增殖，持续 9 秒。',
    pool: 'late',
    effect: { kind: 'rule', birth: [0, 1, 2, 3, 4, 5, 6, 7, 8], survival: [0, 1, 2, 3, 4, 5, 6, 7, 8], duration: 90 }
  },
  {
    id: 'energy_full',
    type: 'buff',
    name: '能量涌动',
    desc: '立即回满能量（+180）。',
    pool: 'late',
    effect: { kind: 'energy', amount: 180 }
  },
  {
    id: 'purge_huge',
    type: 'item',
    name: '湮灭',
    desc: '清除指定位置半径 40 格内的所有活细胞（不分敌我）。',
    pool: 'late',
    effect: { kind: 'purge', radius: 40 }
  }
];