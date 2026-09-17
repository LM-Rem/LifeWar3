# LifeWar / NEXUS · 项目技术文档

> 基于康威生命游戏（Conway's Game of Life）的 **2–4 人局域网实时 PVP 网页游戏**。
> 1000×1000 战场、阵营细胞、能量、基地、随机节点与 Voronoi 多边形领地、预设与自定义图案、休眠清理，以及可折叠的全屏战术界面。

---

## 1. 项目概述

- **游戏名**：LIFEWAR / NEXUS（生命战争）
- **版本**：1.0.0（`package.json`）
- **玩法**：玩家在己方领地内部署生命图案，细胞按 B3/S23 规则演化；占领中继节点扩张领地，最终摧毁所有敌方基地核心获胜。
- **运行环境**：Node.js 22+，唯一运行依赖 `ws`。
- **部署形态**：单机权威服务器 + 局域网浏览器客户端，无构建步骤、无 CDN、无账号系统，适配可信局域网。

---

## 2. 技术栈与架构

### 2.1 技术栈

| 层 | 技术 |
| --- | --- |
| 服务端 | Node.js（原生 `http`、`fs`、`crypto`、ES Modules） |
| 实时通信 | `ws` WebSocket（二进制增量 + JSON 状态） |
| 浏览器 | 原生 ES Modules、Canvas 2D、CSS（无框架、无构建） |
| 数据表示 | `Uint8Array` / `Uint16Array` / `Uint32Array` 类型数组 |

### 2.2 架构

```
浏览器 / Canvas 2D ← WebSocket ← Node.js 权威房间服务器
                                  └─ 1000² 类型数组 + 稀疏邻域演化
```

- **权威服务器**：以固定 10 Hz 演化所有房间，所有客户端消费同一份权威状态，浏览器不自行模拟。
- **稀疏演化**：只遍历活细胞及其 8 邻域（`candidates` 列表），不做百万格全扫描。
- **前后端共享几何**：`public/territory.js` 同时被服务器（部署校验）与浏览器（预览/渲染）引用，保证归属判定一致。
- **同步策略**：加入/重连发送完整活细胞快照；正常每代发送二进制增量（单变化格 4 字节）；玩家与节点状态 5 Hz JSON 更新。

---

## 3. 目录结构

```
LifeWar3/
├── public/                  # 浏览器前端（无构建）
│   ├── index.html           # 三页结构：首页 / 战区 / 战场 + 5 个对话框
│   ├── style.css            # 深色科幻风格、响应式、可折叠面板
│   ├── app.js               # 页面逻辑、联机客户端、输入、图案实验室
│   ├── renderer.js          # Canvas 战场、小地图、首页动态球体
│   ├── patterns.js          # 预设图案、旋转/翻转、RLE 编解码
│   ├── territory.js         # 随机节点、Voronoi 分区、归属判定（前后端共享）
│   └── favicon.svg          # 站点图标
├── src/                     # 服务端
│   ├── engine.js            # 权威模拟与全部玩法规则（Game 类 + RULES）
│   ├── server.js            # HTTP 静态服务、WebSocket、房间、重连、限流
│   ├── bots.js              # 基于领地的 AI：滑翔机/飞船发射与推进
│   └── dormancy.js          # 区域周期检测器：600 代休眠清理
├── tests/                   # 自动化测试与基准
│   ├── engine.test.js       # 演化、部署、能量、节点、基地、胜负
│   ├── territory.test.js    # 随机地图、Voronoi、归属、AI 越界占领
│   ├── dormancy.test.js     # 休眠检测、预警、清理、增量一致性
│   ├── network.test.js      # 真实多客户端联机、重连、房主迁移
│   └── benchmark.js         # 引擎性能基准（稳定场景 + 随机混战）
├── experiments/             # 独立分析/基准脚本（不参与游戏运行）
│   ├── decay-benchmark.mjs              # 休眠机制原型可行性分析
│   └── dormancy-production-benchmark.mjs# 生产实现开启/关闭对比
├── docs/
│   ├── project.md           # 本文档
│   ├── decay-analysis.md    # 战场残骸衰减：可行性与性能分析
│   ├── verification.md      # 手动/自动验收记录
│   └── plans/               # 设计与实施记录
│       ├── 2026-09-16-lifewar-design.md
│       ├── 2026-09-16-territory-update.md
│       └── 2026-09-16-dormancy.md
├── package.json             # scripts: start / dev / test / benchmark
├── package-lock.json
├── README.md                # 用户手册（启动、操作、规则、验证）
└── start.cmd                # Windows 一键启动（自动安装 ws）
```

---

## 4. 核心模块详解

### 4.1 `src/engine.js` — 权威模拟与规则

**导出**：

- `RULES`（冻结常量）：
  - `size: 1000` 地图边长；`hz: 10` 演化频率
  - `dormancyGenerations: 600` 休眠清理阈值；`dormancyWarning: 100` 预警窗口
  - `nodeCountMin: 12` / `nodeCountMax: 16`
  - `baseHitRadius: 12` 基地受击半径；`captureRadius: 10` 节点占领半径；`captureTime: 3` 秒
  - `maxEnergy: 180`；`regen: 5`（基础能量回复 /s）；`baseHP: 240`
  - `maxCells: 24000` 全场上限；`playerCells: 6000` 单人上限
- `COLORS`：四个阵营颜色 `['#67f5d1', '#ff796c', '#ac98ff', '#f4cc75']`
- `Game` 类。

**Game 类要点**：

| 成员 | 说明 |
| --- | --- |
| `board` / `next` | `Uint8Array(1e6)` 当前/下一代棋盘（0=空，1-4=阵营） |
| `counts` | 邻居计数 |
| `votes` | 打包的阵营邻居票数（每阵营 4 bit） |
| `marks` / `candidates` | 稀疏候选标记与列表（只访问活细胞及其邻域） |
| `alive` | 活细胞坐标列表 |
| `changes` | 本代变化 `Map<key, owner>`，供二进制增量打包 |
| `players` | 玩家状态（id/name/bot/出生点/hp/energy/cells/nodes/eliminated） |
| `nodes` | 随机节点列表（含 owner/claimant/progress） |
| `territories` | Voronoi 分区多边形 |
| `dormancy` | `RegionalCycleDetector` 实例 |

**核心方法**：

- `deploy(id, x, y, cells)`：原子部署。逐细胞校验图案尺寸（≤32×32）、地图边界、己方领地、敌基地 28 格禁区、位置占用、能量与容量；任一失败整次拒绝且不扣能量。
- `step(dt)`：演化一代。
  1. 遍历 `alive` 及其邻居，统计 `counts` 与 `votes`；
  2. 应用 B3/S23：存活细胞保持阵营，新生细胞按邻居多数继承阵营；三方平票以 `(位置+代数) % 4` 决定；
  3. 容量限制：达到 `playerCells` / `maxCells` 时拒绝新生细胞；
  4. 调用 `resolveObjectives` 结算节点与基地；
  5. 调用 `dormancy.update` 检测休眠结构；
  6. 回复能量：`min(180, energy + (5 + 节点数) * dt)`；
  7. `checkVictory`。
- `resolveObjectives(dt)`：
  - 节点：半径 10 内仅单一阵营时累计进度，3 秒占领；多阵营争夺时进度冻结；空置时进度半速衰减。
  - 基地：半径 12 内的敌细胞每代最多消耗 5 个（每 tick 上限 15 伤害），每个造成 3 点伤害；所有基地伤害先结算再执行淘汰，保证同时摧毁判平局。
- `packet(snapshot)`：二进制包。`Uint32[0]` 快照标志（1=快照），`Uint32[1]` 代数，随后每 4 字节编码 `key + owner * 1_000_000`。
- `state()`：JSON 状态（generation/status/winner/players/nodes/events/dormancy 预警）。
- `event(type, player, text)`：事件流，保留最近 20 条。

### 4.2 `src/server.js` — HTTP / WebSocket / 房间

- **静态服务**：从 `public/` 提供 HTML/CSS/JS/SVG，带 CSP、`nosniff`、`no-cache` 头；`/api/info` 返回局域网地址、规则与房间数。
- **连接限制**：WebSocket 上限 64；房间上限 6；消息上限 16 KB；每连接消息预算 40，每 100 ms 恢复 1（限流）。
- **协议消息**（JSON）：
  - 客户端 → 服务器：`ping` `list` `create` `join` `resume` `leave` `ready` `bot` `remove_bot` `start` `rematch` `deploy`
  - 服务器 → 客户端：`hello` `rooms` `welcome` `room` `started` `state` `deployed` `error` `pong` `resume_failed` `left` `lobby`，以及二进制 `packet`
- **房间生命周期**：
  - `create` 生成 6 位房间码（`randomBytes(3).toString('hex').toUpperCase()`）；`practice: true` 立即加入 AI（ECHO）并开战。
  - `join` 按房间码加入，最多 4 人；房主可 `start`（需全员就绪）。
  - `start` 重排玩家 id（1-4），创建 `Game`，发送快照。
  - `rematch` 对局结束后由房主重置回备战。
- **断线与重连**：
  - 对局中断开：`ws` 置空并记录 `offlineAt`，90 秒内可凭 token `resume`；逾时判负。
  - 主动 `leave`：立即投降，清除该玩家细胞与节点；房主权限迁移给在线成员。
  - 慢连接保护：`ws.bufferedAmount > 256 KB` 时下一包改发完整快照。
- **主循环**：`setInterval(1000 / hz)` 内逐房间 `step()`，向每个客户端发送二进制增量与 5 Hz 状态；AI 每 30 代运行一次。

### 4.3 `src/bots.js` — 战术 AI

- 武器库：4 方向滑翔机 + 4 方向轻型飞船（用 `transform` 预生成 8 种朝向）。
- 行为：每 30 代执行；从「己方基地 + 已占节点」计算到目标（中立节点/敌人）的距离，优先最近目标；拥有 ≥2 节点时每 90 代转向优先攻击敌人。
- 发射：从距离目标 24 格起，以 6 格步长向外搜索合法发射点，调用与人类相同的 `game.deploy` 校验（领地、能量、容量），失败自动换目标。

### 4.4 `src/dormancy.js` — 休眠清理

- **目标**：清除长期原地重复的局部生命结构（静物/振荡器），回收棋盘空间，防止无限驻守。
- **算法**：
  - 32×32 分块 + 2 格观察余量；每代对活细胞所在块累加两个哈希指纹与人口计数；
  - 回溯最近 1-8 代，指纹与人口完全一致则判定周期重复并累计 `age`；
  - 保存 9 份整图快照，候选清理前逐格精确复核；
  - 相邻非空块组成清理组，整组达到 600 代阈值后一次性删除（避免清出残片）；最后 100 代通过 `state().dormancy` 推送预警，前端绘制琥珀色边框。
- **边界行为**：移动图案（滑翔机/飞船）不计休眠；部署会使周边块 `age` 重置；附近活跃会推迟清理；清理不重置已占领节点。
- 详见 `docs/plans/2026-09-16-dormancy.md` 与 `docs/decay-analysis.md`。

### 4.5 `public/territory.js` — 共享几何（随机节点 + Voronoi）

- `generateNodes(players, random, size)`：best-candidate 采样生成 12-16 个节点；节点间及节点到基地距离 ≥140 格，距边界 ≥60 格；退化时网格兜底，仍不满足则抛错。
- `createTerritories(players, nodes, size)`：以所有基地+节点为站点，用半平面裁剪生成完整覆盖 1000×1000 的 Voronoi 多边形；分区数 = 节点数 + 基地数。
- `territoryAt`：最近站点判定归属；平分线上的格归属更早的站点（固定顺序消除歧义）。
- `territoryOwner`：基地归属未淘汰玩家；节点归属 `owner`。
- `canDeployInTerritory`：判断指定玩家是否拥有某格。

### 4.6 `public/patterns.js` — 图案与 RLE

- `normalize`：平移使最小坐标为 0。
- `transform(cells, rotation, flip)`：90° 旋转与水平镜像。
- 预设 7 种：`glider`（滑翔机）、`lwss`（轻型飞船）、`block`（锚点）、`blinker`（脉冲）、`r`（裂变种子）、`pulsar`（脉冲星）、`squadron`（滑翔编队）。
- `parseRLE` / `toRLE`：仅支持标准 B3/S23；限制 32×32、256 细胞；非法规则/超限抛错。

### 4.7 `public/renderer.js` — 渲染

- `Battlefield`：
  - 1000×1000 离屏 `world` canvas 缓存细胞像素，增量更新，避免每帧重建；
  - `updatePacket` 解析二进制包（快照清空重绘、增量逐格更新）；
  - 相机（缩放 0.45-22×、平移、WASD/方向键）、部署预览 `placement()`（本地预校验，服务器仍权威复检）、小地图、节点/基地绘制（基地 12 格受击圆按真实世界坐标缩放）、休眠预警、事件特效。
- `Ambient`：首页动态生命球体背景（3400 个伪随机粒子，尊重 `prefers-reduced-motion`）。

### 4.8 `public/app.js` — 页面与联机客户端

- WebSocket 连接管理：自动连接、指数退避重连、`sessionStorage` 保存会话 token 断线续传。
- 页面流转：`home` → `lobby`（房间列表/创建/加入/准备）→ `game`（战场 HUD）。
- 输入：点击部署、右键/中键/触控平移、滚轮缩放、小地图跳转、`1-7` 选图案、`R`/`E` 变换、`空格` 回基地、`Tab` 隐藏 HUD、`H` 手册。
- 图案实验室：32×32 编辑器、左键加/右键擦、RLE 导入导出、最多 30 个自定义图案存 `localStorage`。
- HUD：能量条、节点数、玩家血条、事件流、结算对话框、音效（WebAudio 可选）。

---

## 5. 游戏规则速览

| 项目 | 规则 |
| --- | --- |
| 演化 | 10 代/秒，标准 B3/S23，有界地图不环绕 |
| 阵营继承 | 存活保留阵营；新生按邻居多数继承；三方平票以位置+代数决定 |
| 部署 | 预设/自定义图案；每细胞 1 能量；不可覆盖活细胞；必须完整位于己方多边形领地；可跨相邻己方分区 |
| 能量 | 初始 120，上限 180，回复 5/s，每控制节点 +1/s |
| 基地 | 核心耐久 240；敌细胞进入 12 格消耗并造成 3 点伤害（每代最多 15 点）；敌核心 28 格内禁止部署 |
| 节点 | 每局 12-16 个；半径 10 格单一阵营接触 3 秒占领；争夺冻结、空置半速衰减 |
| 地图分区 | Voronoi 多边形；分区数 = 节点数 + 基地数；占领改变整块归属；基地被毁后分区中立 |
| 扩张 | 不能直接投放到中立分区；需从己方领地发射滑翔机/飞船越界占领 |
| 淘汰 | 基地归零则清除细胞、节点中立；最后存活者胜，同时摧毁判平局 |
| 容量 | 每人 6,000、全场 24,000 活细胞 |
| 休眠清理 | 原地周期 1-8 结构连续休眠 600 代整组清除，最后 100 代预警 |
| 不停服 | 无暂停；断线 90 秒重连窗口，逾时判负；主动退出即投降 |

---

## 6. 网络与同步格式

### 6.1 二进制细胞包

```
Offset  Size  字段
0       4     snapshot 标志（1 = 完整快照）
4       4     generation（代数）
8+      4×N   N 个条目：key + owner * 1_000_000
              key = y * 1000 + x；owner 0-4（0 表示该格清除）
```

- 快照：`alive` 全量；增量：仅 `changes` 中变化的格。
- 状态 JSON 每 2 代（即 5 Hz）发送一次，包含玩家、节点、事件与休眠预警。

### 6.2 心跳与限流

- 客户端每 2.5 s 发 `ping`，服务器回 `pong`（带时间戳），UI 显示延迟。
- 服务器每 15 s 探测客户端；无响应则断开。
- 消息预算 40/连接，超出返回「操作过快」错误。

---

## 7. 测试体系

运行：`npm test`（`node --test tests/*.test.js`）；基准：`npm run benchmark`。

### 7.1 自动化测试覆盖

| 文件 | 覆盖内容 |
| --- | --- |
| `tests/engine.test.js` | B3/S23 标准图案（方块/脉冲/脉冲星/滑翔机/飞船）、边界不环绕、阵营继承、部署原子性、能量回复与上限、节点 3 秒占领/争夺/夺取、基地禁区与接触伤害、淘汰与胜利、同时摧毁平局、二进制包重建、图案变换与 RLE 往返、容量上限、终局不可变 |
| `tests/territory.test.js` | 120 张随机地图（2-4 人）的节点数 12-16、≥140 间距、全图覆盖、面积总和 1e6、分区数正确；随机流可复现；共享边界确定性归属；占领/夺取整块转移；跨区部署原子拒绝且前后端一致；12/13 格伤害边界；AI 越界占领节点 |
| `tests/dormancy.test.js` | 600 代清理阈值与 100 代预警；二/三周期振荡器与角落跨块整体删除；移动图案不老化；部署重置年龄；邻近活跃推迟清理；代数计龄与终局后不计龄；删除增量原子一致且保留节点 |
| `tests/network.test.js` | 真实 4 客户端：建房间、加入、权限校验、启动、四端同步、非法部署拒绝、断线重连恢复快照、房主迁移；房间容量、AI 添加/移除、畸形消息容错、模拟训练 |

### 7.2 性能基准（README 2026-09-16 记录，Node.js 24）

| 场景 | 活细胞 | 平均每代 | P95 每代 |
| --- | ---: | ---: | ---: |
| 分离稳定方块 | 2,000 | 0.18 ms | 0.23 ms |
| 分离稳定方块 | 9,952 | 0.57 ms | 0.77 ms |
| 分离稳定方块 | 23,952 | 1.40 ms | 1.88 ms |
| 四方随机混战 | 初始 23,306 | 1.30 ms | 2.89 ms |

> 仅含模拟与二进制打包，不含 GPU/网络/多房间压力。混战二进制流约 251 KB/s/客户端。

### 7.3 实验脚本

- `node experiments/decay-benchmark.mjs`：休眠机制原型基准（分块指纹、周期检测、精确复核、清理峰值）。结论：每代额外开销约 0.14-0.33 ms（相对 +10%~24%），内存约 8.7 MiB/房间；详见 `docs/decay-analysis.md`。
- `node experiments/dormancy-production-benchmark.mjs`：生产实现开启/关闭对比（普通演化、预警期、清理峰值、内存与状态字节）。

---

## 8. 开发与运维

```powershell
npm install --cache .npm-cache   # 安装依赖（仅 ws）
npm start                        # 启动（默认 0.0.0.0:3000）
npm run dev                      # 开发模式（node --watch 自动重启）
npm test                         # 运行全部测试
npm run benchmark                # 运行性能基准
```

- **改端口**：`$env:PORT=3001; npm start`。
- **公网穿透（Ngrok）**：项目保持服务器权威架构即可实现公网联机，**无需 WebRTC P2P 改造**。本机运行 `ngrok http 3000` 获得 `https://xxxx.ngrok-free.app`，再以 `$env:PUBLIC_URL="https://xxxx.ngrok-free.app"; npm start` 启动；`/api/info` 会把该公网地址加入 `addresses` 并返回 `publicUrl`，联机页的 `lanAddress` 与邀请链接自动使用它。外部浏览器通过 `wss://xxxx.ngrok-free.app/ws` 连接本机（同源 Origin 校验在 Ngrok 场景下 Host 一致，可正常通过）。免费版域名随机、带宽有限；固定域名使用 `ngrok http --domain=你的域名 3000`。代码改动见 `src/server.js`（`/api/info`）与 `public/app.js`（`loadInfo`）。
- **局域网接入**：其他设备访问启动日志中的 LAN 地址；需同一网络，并允许 Node.js 在专用网络入站。
- **状态说明**：房间仅存内存，服务器重启会清空所有对局；刷新页面自动重连，重连令牌存于 `sessionStorage`。
- **约束**：适用于可信局域网，不含公网账号/排名/匹配/持久化战绩。

---

## 9. 历史迭代（docs/plans）

1. **2026-09-16-lifewar-design.md**：总体实现计划。早期规则为「基地部署半径 170、节点半径 125」，后已被多边形领地方案替代。
2. **2026-09-16-territory-update.md**：引入随机节点 + Voronoi 多边形领地；best-candidate 采样保证节点均匀；基地受击范围真实标注；AI 改为越界发射移动图案。
3. **2026-09-16-dormancy.md**：加入 600 代休眠清理；生产实现沿用实验的 32 格分块指纹方案，并补齐整组复核、部署失效、预警同步与清理增量。

---

*本文档基于对当前代码库的完整阅读整理，规则细节以源码与 README 为准。*