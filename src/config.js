// 游戏规则配置加载器。
// 从项目根目录的 config.json 读取可选覆盖值，与内置默认值合并后导出不可变的 RULES。
// 未创建 config.json 或读取失败时全部使用内置默认值。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BASE_HIT_RADIUS } from '../public/territory.js';

const CONFIG_PATH = process.env.LIFEWAR_CONFIG_PATH || fileURLToPath(new URL('../config.json', import.meta.url));

const DEFAULTS = Object.freeze({
  size: 1000,
  hz: 10,
  dormancyGenerations: 600,
  dormancyWarning: 100,
  minDormancyGenerations: 100,   // 休眠清理阈值下限（随游戏进行衰减后不得低于此值）
  dormancyDecayPerMinute: 0,     // 游戏开始后，现实时间每分钟减少的休眠清理阈值（代；0 = 不衰减）
  nodeCountMin: 12,
  nodeCountMax: 16,
  baseHitRadius: BASE_HIT_RADIUS,
  captureRadius: 10,
  captureTime: 30,        // 占领所需演化代数（默认 30 代 = 10Hz 下 3 秒）
  captureDecay: 0.05,     // 空置节点每代进度衰减
  maxEnergy: 180,
  regen: 0.5,             // 每代基础能量回复（10Hz 下相当于每秒 5）
  nodeRegen: 0.1,         // 每占领一个节点，每代额外能量回复
  baseHP: 240,
  maxCells: 24000,
  playerCells: 6000,
  deployCooldown: 1,      // 部署冷却（演化代数）
  disconnectGenerations: 900, // 断线判负所需演化代数（默认 900 代 = 90 秒）
  roomIdleGenerations: 900,   // 房间无人在线超过多少代后清理
});

// 这些键必须为整数（地图尺寸/容量/格数半径/代数等）；hz、regen、nodeRegen、captureDecay 允许小数。
const INTEGER_KEYS = new Set([
  'size', 'dormancyGenerations', 'dormancyWarning', 'nodeCountMin', 'nodeCountMax',
  'baseHitRadius', 'captureRadius', 'captureTime', 'maxEnergy', 'baseHP', 'maxCells', 'playerCells',
  'deployCooldown', 'disconnectGenerations', 'roomIdleGenerations',
  'minDormancyGenerations', 'dormancyDecayPerMinute',
]);

// 允许配置为 0 的键（0 有明确语义：衰减速率 0 = 不衰减；最小休眠代数 0 = 无下限）。
const ALLOW_ZERO_KEYS = new Set(['dormancyDecayPerMinute', 'minDormancyGenerations']);

function sanitize(raw) {
  const result = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return Object.freeze(result);
  for (const key of Object.keys(DEFAULTS)) {
    const value = raw[key];
    if (value === undefined || value === null || value === '') continue;
    const num = Number(value);
    const allowZero = ALLOW_ZERO_KEYS.has(key);
    if (!Number.isFinite(num) || num < 0 || (num === 0 && !allowZero)) {
      console.warn(`[config] 忽略无效配置 ${key}=${JSON.stringify(value)}，使用默认值 ${DEFAULTS[key]}`);
      continue;
    }
    result[key] = INTEGER_KEYS.has(key) ? Math.max(allowZero ? 0 : 1, Math.round(num)) : num;
  }
  // 交叉校验：节点数量范围与细胞容量必须自洽，否则整组回退默认。
  if (result.nodeCountMin > result.nodeCountMax) {
    console.warn(`[config] nodeCountMin(${result.nodeCountMin}) > nodeCountMax(${result.nodeCountMax})，恢复默认节点范围`);
    result.nodeCountMin = DEFAULTS.nodeCountMin;
    result.nodeCountMax = DEFAULTS.nodeCountMax;
  }
  if (result.playerCells > result.maxCells) {
    console.warn(`[config] playerCells(${result.playerCells}) > maxCells(${result.maxCells})，恢复默认容量`);
    result.playerCells = DEFAULTS.playerCells;
    result.maxCells = DEFAULTS.maxCells;
  }
  return Object.freeze(result);
}

let config = sanitize(null);
try {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  config = sanitize(raw);
} catch (err) {
  if (err.code !== 'ENOENT') console.warn(`[config] 读取 ${CONFIG_PATH} 失败：${err.message}，使用默认规则`);
}

export const RULES = config;
