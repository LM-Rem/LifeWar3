# 密集小地图、T13 CPU 与初始版／当前版全链路对照

日期：2026-09-25。结论以本页最终实测表为准；原始运行数据保存在 `artifacts/performance/2026-09-25/`。

## 小地图：保序路径批绘没有通过零像素差异门槛

测试直接比较逐个 `fillRect`、连续同色合为一个路径、以及遇到像素足迹冲突即提交的连续同色路径。采用原调色板的 0.65 透明度、不透明底色，覆盖 180、197、360 像素画布、局部密集、全图分散与四阵营交替。

- 180 像素、10,000 格同色局部密集：同色合并路径产生 1,620 个不同 RGBA 通道，最大通道误差 134。路径填充对重叠区域只合成一次，不等于多个半透明矩形依次合成。
- 180 像素、10,000 格分散：即使批内像素足迹互不重叠，仍有 58,233 个通道不同，最大误差 57。分数矩形的多子路径栅格化与独立矩形提交并不等价；保持逻辑顺序不足以保证 Canvas 像素一致。
- 每次都退回单矩形的四阵营交替用例零差异，但没有减少提交数。该实验的时间只用于探索，不作为正式收益统计。

因此这两种路径批绘均未进入生产代码。本轮没有新增小地图缓存，也没有降低绘制频率、DPR、透明度或细胞数。密集全量重绘瓶颈仍未解决；不能把失败实验表述为完成了小地图加速。

## T13 实现

`public/board-protocol.js` 保持 v2 wire format 不变：密集瓦片按有效行复制，利用新包零初始化保留边缘填充；解码按行计算坐标，逐字节检查 owner 和边缘填充，仍完整校验后才应用。仅当存在 sparse 瓦片或新生时执行相应写出扫描，既有密集 owner 不再被重复读取。顺序恢复改用索引遍历，保留新生表的完整基准检查。

`public/renderer.js` 跳过 owner 不变的 board/Map/texture 写入；删除再出生仍按消息顺序执行。没有改用无序细胞容器，没有跳过世代，也没有放宽畸形包校验。

冻结 `be727c10343f2d957d2dbc0f8f0a09af59dfb807` 的 T13 codec 到 `tests/baselines/t13-codec/`，分别验证 exact wire bytes、恢复后的完整条目和随机代回放。五轮交错旧／新 codec 测量每轮预热 3 次、测量 10 次，Map 拷贝及夹具准备在计时外。CPU 包括编码、校验解码／顺序恢复和 board/Map 应用，不等同于服务端 tick。

## 全链路测量范围

`tests/performance/end-to-end.mjs` 分进程、串行、交错运行冻结初始版、当前默认 v1 和当前显式 v2。使用真实生产服务器循环、背压策略、WebSocket 和 Battlefield RAF；仅通过测试夹具注入相同棋盘。每轮相同种子、100 代预热、100 代测量，四个同机 headless Chromium 客户端；P01/P03/P04、DPR 1/2 各三轮。原始报告保存每轮与每客户端分位数、源码哈希、队列、代序列、发送字节和内存。

初始版／当前版的改善包含此前所有已交付优化，不能全部归因于本轮代码。只有冻结 T13 codec／当前 codec 的交错对照用于隔离本轮编解码变化。

服务端 tick 从 `step` 入口至 `changes.clear` 结束，包含演化、休眠、打包、状态序列化、发送提交及 v2 广播基准更新；不含此前的无操作 AI 和连接清理。客户端分别记录 RAF 内工作、消息事件解码／应用、小地图及 RAF 间隔。初始版在消息事件中应用，当前版在 RAF 队列中应用，因此不能只比较 RAF 耗时而省略消息事件成本。初始版没有呈现队列，队列字段为 null，另逐代统计漏画。

带宽是服务器实际提交的二进制、JSON 和 WebSocket 帧头，不含 TCP/TLS；同时报告每代字节和实际吞吐。初始快照排除在稳态计时外，稳态恢复快照计入并判严格验收失败。尾部允许一秒排空，排空期间不纳入帧耗时样本。高负载下各版本实际发送序列因背压／恢复而不同，**这些吞吐数不能用于计算协议压缩率**；压缩收益仅使用相同输入的 codec 对照。队列深度在帧后采样，可能低于收包瞬间峰值，恢复与漏画另作硬性失败证据。

本次不是发布认证：使用合成固定时间／固定规则，未包含完整 HUD 和输入事件处理、四台物理前台设备、实测千兆 LAN、物理扫描输出、30 分钟／2 小时 soak 或 GPU 显存。内存报告含服务端 RSS/heap/external/arrayBuffers 和客户端 JS/embedder/backing storage；短期趋势不证明长期无泄漏。实际 RAF 间隔由浏览器决定，没有强行模拟 60Hz。

## 复现

复用已安装 Playwright 和 Chrome，不下载依赖；将以下占位路径替换为本机路径。

```powershell
npm test
npm run benchmark:minimap:batching -- --playwright <Playwright目录> --executable <Chrome路径>
npm run benchmark:codec:compare
npm run test:browser:equivalence -- --playwright <Playwright目录> --executable <Chrome路径> --output artifacts/performance/2026-09-25/equivalence
npm run test:browser:protocol -- --playwright <Playwright目录> --executable <Chrome路径>
npm run benchmark:e2e -- --rounds 3 --warmup 100 --generations 100 --clients 4 --dpr 1 --playwright <Playwright目录> --executable <Chrome路径> --output artifacts/performance/2026-09-25/ab-dpr1
npm run benchmark:e2e -- --rounds 3 --warmup 100 --generations 100 --clients 4 --dpr 2 --playwright <Playwright目录> --executable <Chrome路径> --output artifacts/performance/2026-09-25/ab-dpr2
node tests/performance/summarize-render-codec-ab.mjs
```

所有性能命令应串行运行；`--help` 给出参数。功能失败非零退出；性能不达标保留报告并令 `realtimePass=false`，用于明确区分测量成功与认证通过。v2 继续通过 `LIFEWAR_BOARD_PROTOCOL=2` 显式试用，默认仍为 v1。
