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
  }
];