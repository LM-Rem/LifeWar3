# T01–T04 实施结果与使用说明

日期：2026-09-23。只执行本轮授权的 T01–T04；未实现 T05 类型数组重构、增量休眠、稀疏/密集后端切换、协议 v2、逐代播放队列、worker 或 CUDA。

## 完成内容

| 任务 | 结果 | 验证证据 |
|---|---|---|
| T01 冻结与基准 | 捕获当前工作区 48 文件及原始哈希、独立 20Hz 配置；修正流量单位，增加 L/C/D、p99、超期与内存分类 | manifest 校验、流量单测、两个现有 benchmark 与隔离 A/B |
| T02 逐阶段回放 | 演化/目标/休眠/最终状态比较；逐字节比较 v1 增量和快照；比较 alive/changes 顺序、休眠完整历史、随机状态、每次 AI/部署/卡牌尝试 | 5种子×200代默认规则；另5种子×200代20Hz夹具；时间边界/故意故障测试 |
| T03 追踪 | 默认关闭的有界记录；服务端分阶段、发送、积压、event-loop delay；浏览器接收/应用/绘制、RAF、预览、小地图、JSON分派及长任务 | 定时器/边界单测、真实 WebSocket、真实 Chromium 五条代序列导出、开关开销对照 |
| T04 低风险优化 | 无删除不扫描；目标结算中多次淘汰后仅稳定压缩一次；无到期瓦片不扫描休眠删除；直接打包；AI 收满64个敌格即停 | 有序删除测试、逐阶段参考对比、103项完整测试、A/B与画面对比 |

直接打包仍使用独立 ArrayBuffer，避免多个客户端消费时缓冲被复用覆盖。Map 迭代器本身仍有开销，本次只去掉显式展开的 entries 外层数组、快照二元数组和 forEach 路径，没有宣称零分配。

## 性能结果

机器：i9-13900HX / 32 逻辑核 / 约32GiB内存，Node v24.11.1，Windows 10.0.26200。GPU 为 RTX 5070 Ti Laptop GPU，本次 CPU 计算未使用 CUDA。电源方案 GUID 为 381b4222-f694-41f0-9685-ff5bb260df2e，测试没有更改系统电源策略。

每个场景/变体使用5个独立进程，每进程预热30代、测100代，各轮交替运行顺序。以下“均值”是5轮每轮均值的中位数，“p95”是5轮p95的中位数；最坏值与超期数覆盖全部500个样本。仅测 step+packet，未包含网络和浏览器。

| 场景 | 优化前均值 | 优化后均值 | 均值下降 | 前/后 p95 | 前/后最坏值 | 前/后超过50ms |
|---|---:|---:|---:|---:|---:|---:|
| P01：24,000静物 | 2.550ms | 2.031ms | 20.34% | 2.967 / 2.460ms | 5.973 / 2.986ms | 0 / 0 |
| P03：80万初始细胞扩张 | 69.334ms | 56.196ms | 18.95% | 77.645 / 61.622ms | 92.883 / 69.010ms | 500 / 429 |
| P04：约50万细胞高变化 | 112.777ms | 88.260ms | 21.74% | 126.365 / 94.759ms | 132.214 / 99.143ms | 500 / 500 |

P03测量期间活细胞约82.3万–92.0万；P04每代约50万格变化。都是固定规则的合成持续压力，使用高基地耐久和延长休眠阈值，不能拿来说明合法时长卡牌的完整实战结果。

**结论：三个代表场景均有收益，但密集扩张和高变化仍不满足20Hz预算。** 当前阶段没有达成完整方案的25ms p95/40ms p99目标，也没有完成多人/手机/2小时的发布认证。

最终追踪实现另做3轮×100代开/关对照：P01约-5.72%、P03约+0.44%、P04约-1.25%的均值差。负数视为噪声/JIT和运行波动，不解释为“开追踪能加速”。这轮未观测到代表场景均值中位数超过3%的额外开销；不证明所有机器或最坏帧的开销均低于3%。主结果使用追踪关闭数据。

小型汇总保存在 [t01-t04-summary.json](t01-t04-summary.json)。完整逐代样本、时序、环境及源码哈希在被Git忽略的 `artifacts/performance/t01-t04-ab/` 和 `artifacts/performance/t01-t04-trace-final/`。

## 正确性与画面验证

- `npm test`：103项通过，0失败；包含冻结参考校验、单位换算、顺序、追踪、真实网络和全部原81项测试。
- `npm run test:replay -- --seeds 5 --generations 200`：5组全部通过，每组800次阶段比较，使用独立20Hz配置。该CLI默认场景没有玩家操作；带操作/AI/卡牌/时间边界的回放由完整测试覆盖。
- 真实 Chrome 153.0.8010.53、headless、1280×900、DPR=1：追踪关闭时无诊断对象；开启时五条代序列均可导出；页面异常为0。
- 固定相机、棋盘和动画时间，主战场及小地图对比冻结 renderer：PNG逐字节一致。原图保存在 `artifacts/performance/browser-smoke/`。

画面测试是固定场景冒烟，不是完整视觉矩阵或物理屏幕的零丢帧认证。当前仍沿用原本的到包即应用和慢连接快照恢复；追踪能够揭示覆盖/跳代问题，但本轮不会提前实施T12改变显示调度。

## 使用追踪

默认 `npm start` 不启用采样、event-loop监视或诊断网络消息。开启服务器追踪：

```powershell
$env:LIFEWAR_TRACE='1'
npm start
```

浏览器进入 `http://localhost:3000/?trace=1`。控制台可获取：

```js
window.lifeWarPerformance.export()
```

通过 `createServer({ trace: true })` 启动的测试/工具程序可调用 `app.performanceReport()`；不新增公开HTTP诊断接口。浏览器五条代序列中的 computed/sent 是服务器随已发送包附带的确认，**不能替代服务器完整计算记录**；慢连接期间真实计算情况应看服务端报告。

默认最多16384条记录，可用 `LIFEWAR_TRACE_CAPACITY` 调整（1–1000000）。环形缓冲满后输出 `droppedRecords` 和 `complete:false`，不可把截断区间当作完整零丢代证据。统计中的 `receivedButNotDrawn` 在观测末尾可能含尚未绘制的最新代，应结合后续帧与epoch判断；不是所有值都代表永久丢帧。

服务端时长以本地单调时钟计量；客户端也是自己的本地单调时钟，二者不能直接相减计算跨机单向延迟。drawn表示Canvas提交，不等于显示器物理呈现。

部分指标存在包含关系：step包含各规则阶段；dormancy包含scan/exact/remove；frame包含draw/minimap等。不能把父项和子项重复相加。当前客户端原循环中解码、状态应用和逐格纹理调用交错，记录为一个 `packet.decodeApplyTexture.ms`，避免加入逐格计时扰动；JSON分派单独记录为 `json.decodeDispatch.ms`。

停用追踪：关闭服务器后清除环境变量，并去掉浏览器URL参数：

```powershell
Remove-Item Env:LIFEWAR_TRACE -ErrorAction SilentlyContinue
npm start
```

## 复现命令

```powershell
npm test
npm run test:replay -- --seeds 5 --generations 200
npm run benchmark
npm run benchmark:expansion
npm run benchmark:compare
node tests/performance/compare.mjs --trace-only --rounds 3 --generations 100 --output artifacts/performance/t01-t04-trace-final
```

浏览器冒烟使用已经安装的Playwright和浏览器，不执行安装或下载：

```powershell
node tests/performance/browser-smoke.mjs --playwright '<Playwright模块目录>' --executable '<Chrome可执行文件路径>'
```

本次使用桌面运行时随附的Playwright和本机Chrome，未新增项目依赖。其他环境若未安装Playwright需自行提供模块路径，不能把缺依赖标为浏览器测试通过。所有性能运行应串行执行，避免与完整回放、其他基准或浏览器负载并行。

## 边界与后续

T01–T04按阶段完成；原始源码、规则配置和既有用户工作以冻结清单为基准保留，没有执行Git提交或更改游戏平衡配置。为兼容执行期间Git已有提交造成的换行规范化，参考目录保留原始字节清单，并增加只接受CRLF/LF变化的辅助内容哈希，不允许其他源码漂移。

下一步优先T05/T06与T10/T11：先完成有序变更数据流与增量休眠，再降低主图和小地图调用量。T08密集演化、T13协议和CUDA仍按完整方案单独实施和验收。
