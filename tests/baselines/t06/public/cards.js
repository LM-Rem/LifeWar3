// One validated data source for the server and browser. Edit cards.json to balance cards.
const pools = ['early', 'mid', 'late'];
const kinds = { rule: 'law', randomRule: 'law', inheritance: 'law', energy: 'buff', repair: 'buff', buff: 'buff', purge: 'item', seed: 'item', nebula: 'item', localRule: 'item' };
const stats = ['maxEnergy', 'regen', 'freeDeploy', 'deployCost', 'neutralDeploy', 'capture', 'contest', 'shield', 'capacity', 'dormancy'];
export const isTargetedCard = card => ['purge', 'seed', 'nebula', 'localRule'].includes(card?.effect?.kind);
export const ruleLabel = effect => `B${effect.birth.join('')}/S${effect.survival.join('')}`;

export function validateCardConfig(data) {
  const require = (valid, message) => { if (!valid) throw new Error(`卡牌配置：${message}`); };
  const positive = (n, max = 3600) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= max;
  require(Array.isArray(data.drawSeconds) && data.drawSeconds.every((n, i, a) => positive(n, Infinity) && (!i || n > a[i - 1])), '发卡时间必须为严格递增的正数（秒），空数组表示关闭发牌');
  require(positive(data.draftSeconds, 120) && positive(data.lawWarningSeconds, 10), '选卡与法则预告时间无效');
  require(Array.isArray(data.cards), 'cards 必须为数组');
  const ids = new Set();
  for (const card of data.cards) {
    const e = card.effect;
    require(typeof card.id === 'string' && /^[a-z][a-z0-9_]*$/.test(card.id) && !ids.has(card.id), '卡牌 ID 无效或重复');
    ids.add(card.id);
    require(typeof card.name === 'string' && card.name.length > 0 && typeof card.desc === 'string', `${card.id} 缺少名称/说明`);
    require(pools.includes(card.pool) && e && Object.hasOwn(kinds, e.kind) && card.type === kinds[e.kind], `${card.id} 类型/卡池无效`);
    if (['rule', 'randomRule', 'inheritance', 'localRule', 'buff'].includes(e.kind)) require(positive(e.seconds, 120), `${card.id} 持续时间无效`);
    if (['rule', 'localRule'].includes(e.kind)) {
      for (const key of ['birth', 'survival']) require(Array.isArray(e[key]) && new Set(e[key]).size === e[key].length && e[key].every(n => Number.isInteger(n) && n >= (key === 'birth' ? 1 : 0) && n <= 8), `${card.id} B/S 无效（不支持无邻居出生 B0）`);
    }
    if (isTargetedCard(card)) require(Number.isInteger(e.radius) && positive(e.radius, 80), `${card.id} 半径无效`);
    if (e.kind === 'randomRule') {
      require(Array.isArray(e.variants) && e.variants.length > 0, `${card.id} 缺少随机规则`);
      for (const v of e.variants) {
        require(positive(v.weight,1000), `${card.id} 权重无效`);
        for (const key of ['birth','survival']) require(Array.isArray(v[key]) && new Set(v[key]).size===v[key].length && v[key].every(n=>Number.isInteger(n)&&n>=(key==='birth'?1:0)&&n<=8), `${card.id} 随机 B/S 无效`);
      }
    }
    if (e.stat === 'freeDeploy') require(positive(e.discountFraction,1), `${card.id} 部署减免无效`);
    if (e.energyFraction !== undefined) require(positive(e.energyFraction,1), `${card.id} 能量比例无效`);
    if (e.kind === 'energy') require(e.full === true || positive(e.fraction, 1) || positive(e.amount, 10000), `${card.id} 能量无效`);
    if (e.kind === 'repair') require(positive(e.fraction, 1) || positive(e.amount, 10000), `${card.id} 修复量无效`);
    if (e.kind === 'buff') {
      require(stats.includes(e.stat), `${card.id} 增益类型无效`);
      if (['maxEnergy', 'capacity'].includes(e.stat)) require((Number.isInteger(e.amount) && positive(e.amount, 6000)) || (e.stat === 'maxEnergy' && positive(e.capacityFraction, 1)), `${card.id} 增益量无效`);
      if (['regen', 'capture', 'deployCost'].includes(e.stat)) require(positive(e.multiplier, 4), `${card.id} 倍率无效`);
      if (['freeDeploy', 'neutralDeploy'].includes(e.stat)) require(e.charges === 1, `${card.id} 一次性部署必须为一次`);
    }
    if (e.kind === 'nebula') require(positive(e.density, 1), `${card.id} 密度无效`);
    if (e.kind === 'seed') require(Array.isArray(e.pattern) && e.pattern.length > 0 && e.pattern.length <= 256 && e.pattern.every(c => Array.isArray(c) && c.length === 2 && c.every(n => Number.isInteger(n) && n >= 0 && n < 32)), `${card.id} 播种图案无效`);
  }
  for (const pool of pools) for (const type of ['law', 'buff', 'item']) require(data.cards.some(c => c.pool === pool && c.type === type), `${pool} 缺少 ${type} 卡`);
  return data;
}

// Resolve once when drawn: the hand and reconnect snapshots retain the exact rule.
export function materializeCard(card, random = Math.random) {
  if (card.effect.kind !== 'randomRule') return card;
  const variants=card.effect.variants;
  let roll=random()*variants.reduce((sum,v)=>sum+v.weight,0);
  const chosen=variants.find(v=>(roll-=v.weight)<0) || variants.at(-1);
  const effect={kind:'rule',birth:[...chosen.birth],survival:[...chosen.survival],seconds:card.effect.seconds};
  return {...card,effect,desc:`${ruleLabel(effect)}：全局演化规则，持续 ${effect.seconds} 秒。`};
}

const data = typeof window === 'undefined'
  ? JSON.parse((await import('node:fs')).readFileSync(new URL('./cards.json', import.meta.url), 'utf8'))
  : await fetch(new URL('./cards.json', import.meta.url)).then(r => { if (!r.ok) throw new Error('无法加载卡牌配置'); return r.json(); });
export const CARD_CONFIG = validateCardConfig(data);
export const CARDS = CARD_CONFIG.cards;
