# 小地图背景局部失效与分层实验

已采用背景局部失效，减少单节点归属、基地状态变化时的细胞重放；透明分层未通过严格像素一致性，未采用。大范围背景变化仍需全量重画。

## 实现范围

`public/minimap-cache.js` 把背景样式与几何变化分开。节点归属、基地消灭／恢复、查看阵营变化时，标记受影响领地多边形的保守包围盒以及节点／基地标记所覆盖的瓦片；继续复用既有贡献者索引。包围盒含抗锯齿及描边扩展余量。

背景本身仍完整重画到已有背景画布，细胞只在脏瓦片中按原有顺序重放。每块先在原始尺寸、原始坐标的 scratch canvas 上绘制，再复制整数瓦片；不直接裁剪分数坐标 fillRect。没有增加新的图像缓存层。

尺寸、节点／基地坐标或几何对象变化，快照、大增量包、没有有效贡献者索引时仍完整重放。大面积样式变化超过既有阈值也会全量重画，但可以保留有效索引，避免下一包重复构建。新鲜度由已有逐格更新维护。

## 三轮 A/B

冻结基线在 `tests/baselines/minimap-background/`，来自提交 `048bd3e`，SHA256 为 `838d86bc3768696ff46f919e9eb2529b0b0c796bcd82f9e4e24c862cab2f7609`。同一个当前 renderer 仅替换缓存模块，三轮交替顺序、独立浏览器进程。两种密集夹具加 197px 分数坐标夹具，共 108 对 PNG 完全一致。

下表为 drawMinimap 到 PNG 完成的三轮中位数，包含读回和 PNG 编码，**不包含前置包应用／索引构建**；不是纯 GPU 时间，也不是逐代帧率。

| 场景 | 背景变化 | 旧→新 | 降幅 |
| --- | --- | ---: | ---: |
| 90 万同色 | 单节点归属 | 330.2→127.8ms | 61.3% |
| 50 万四阵营 | 单节点归属 | 190.7→67.9ms | 64.4% |
| 90 万同色 | 基地消灭 | 327.8→82.5ms | 74.8% |
| 50 万四阵营 | 基地消灭 | 189.6→43.6ms | 77.0% |
| 90 万同色 | 多节点归属 | 326.4→330.8ms | 无明确收益 |
| 50 万四阵营 | 多节点归属 | 193.0→191.1ms | 无明确收益 |

局部变化后当前版保留索引，旧版会丢弃它。以基地消灭前的无效写入包为例，旧版还需要约 39–57ms 重建索引，当前版接近零；原始 JSON 单列 packetMs，没有把它混入上述绘制降幅。几何变化／无索引时的全量路径没有改善；不把测量波动认定为收益。

## 透明细胞层：拒绝采用

比较逐细胞直接画到不透明背景，与先逐细胞画到透明层、再整体合成到背景。覆盖 180／197／360px、同色／四阵营、两种背景，共 12 组；全部存在差异，每组约 7,761–12,691 个颜色通道不同，最大误差 1–2。

即使几何和顺序相同，改变中间合成过程仍可能改变有限精度结果。按照零像素差异要求，本轮不引入透明分层，不以“肉眼相近”替代验收。实验脚本保留，结果在 `artifacts/performance/minimap-layers/report.json`。

## 后续绘制后端的判断

真实单客户端 P03 复测（预热 100 代、测量 100 代）仍失败：steady 19.994Hz，tick p95 28.93ms，帧工作 p95 12.4ms、p99 21.9ms、最大 353.2ms，队列峰值 7。无缺失代、漏画或恢复快照，带宽约 8,099.7B/代；服务端末尾 RSS 205.8MiB，浏览器 JS used 42.3MiB，不含 GPU 内存。大范围背景变化仍形成长帧。与上一阶段单轮 403ms／峰值 8 相比的差别不作为稳定降幅结论。

这次改动减少必须重画的范围，没有降低真正全图重放的复杂度。继续大幅降低多节点同时变更的成本，需要评估直接像素合成或 GPU 批量提交。

直接像素合成必须复现每个分数矩形的覆盖率、每次透明叠加的顺序与舍入；小地图虽只有 32,400 个像素，计算输入仍可能有近百万细胞，不能把减少 API 调用误称为只需 32,400 次计算。WebGL 可以减少提交次数，但其光栅化和混合规则与 Canvas 是否逐像素一致仍需单独证明。当前没有足够证据将任一种替换进生产路径。

下一阶段应先建立覆盖率／混合的像素级 oracle 和最小原型；一次量化完整重绘收益，再决定是否值得承担后端改造成本。OffscreenCanvas Worker 可以改善主线程响应，但不单独解决 20Hz 连续呈现吞吐量。

## 复现

146 项自动化测试通过。扩展原始画面对照 312 项，加协议对照 64 项，共 376 项画面比较和 32 项有序 Map 比较通过；原始对照覆盖每个节点、基地消灭／恢复、四个阵营视角，DPR 1/2。普通单客户端 P01 短测 19.977Hz，通过本地门槛，tick p95 1.94ms、帧工作 p95 0.4ms、队列峰值 1。未重复完整四客户端初始／当前协议矩阵，也未做 LAN 或长稳认证，T13 默认仍为 v1。

在项目根目录串行运行，浏览器命令可追加 `--playwright PATH --executable PATH`：

```powershell
npm test
npm run benchmark:minimap:background -- --output artifacts/performance/minimap-background/final
npm run benchmark:minimap:layers
npm run test:browser:equivalence -- --output artifacts/performance/minimap-background/equivalence
npm run test:browser:protocol
npm run benchmark:e2e -- --variant current-v1 --scenario P03 --clients 1 --output artifacts/performance/minimap-background/dense
npm run benchmark:e2e -- --variant current-v1 --scenario P01 --clients 1 --output artifacts/performance/minimap-background/ordinary
```

协议测试结果复制到 `artifacts/performance/minimap-background/protocol.json`；`node tests/performance/summarize-minimap-background.mjs` 校验当前源码哈希并生成 [汇总 JSON](2026-09-25-minimap-background-summary.json)。所有性能运行串行，浏览器为同机 Chrome headless；不代表物理显示、LAN、多设备或长稳认证。
