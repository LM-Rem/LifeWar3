# 2026-09-25 调度修复与密集小地图分项验证

普通负载的约 16Hz 已定位到计时调度：采用单调时钟的绝对截止时间后，本机单／四客户端三轮均恢复约 20Hz，并通过本轮实时门槛。小地图首次局部更新的索引构建有所改善，但密集全图重绘仍不达标。

机器：Windows 10.0.26200、Node v24.11.1、i9-13900HX、32GB、RTX 5070 Ti Laptop、Chrome 153.0.8010.53。浏览器性能测试为同机 headless、loopback、DPR 1。结果不是物理显示、LAN 或长稳认证。完整数值、源码 SHA256 与环境见 [汇总 JSON](2026-09-25-scheduler-minimap-summary.json)。

## 调度的证据和实现

独立 Node 进程、不运行游戏和浏览器，交替三轮、每轮 100 次回调：

| 调度 | 平均间隔范围 | 实际频率范围 | 100 次累计落后 |
| --- | ---: | ---: | ---: |
| setInterval(50) | 62.30–62.46ms | 16.01–16.05Hz | 1230–1246ms |
| 绝对截止时间 | 50.09–50.11ms | 19.96Hz | 9.3–10.7ms |

这证明本环境的低频现象无需游戏计算即可复现；没有据此断言某一 Windows 内部机制。不能把约 12ms 的间隔差归入服务端 step 耗时。

新增 `src/tick-scheduler.js`，服务端改用单调截止时间。正常迟到不会累积到下一次目标时间；未来截止时间使用 timer，已到期工作使用 setImmediate 让出事件循环，不忙等、不修改系统计时精度。每次回调只推进一代，长阻塞时显式重置过量时间债，记录 `rebaseMs`，不跳过 generation。跟踪开启时记录 interval/lateness/work/rebase；关闭同时取消 timer 或 immediate。

假时钟测试覆盖提前唤醒、抖动、回调耗时、长阻塞、过载、停止与残留回调。调度恢复平均频率，不保证每次间隔恰好 50ms；实测仍有约 63ms 的间隔尾部。

## 普通负载端到端对照

生产服务端循环与真实 WebSocket、Battlefield RAF，P01 固定种子，24,000 个稳定细胞；每轮预热 100 代，测量 100 代。相同当前版代码注入旧／新调度，三轮交替顺序，棋盘首尾哈希一致。另测无浏览器服务端以排除客户端影响。

| 客户端／调度 | 三轮 steady Hz | tick p95 范围 | 浏览器帧工作 p95 最大值 | 队列峰值 | 本地门槛 |
| --- | --- | ---: | ---: | ---: | --- |
| 0／旧 | 16.031 / 16.067 / 16.030 | 2.61–2.78ms | — | — | 仅隔离诊断 |
| 0／新 | 20.021 / 19.990 / 20.024 | 2.58–2.77ms | — | — | 仅隔离诊断 |
| 1／新 | 19.946 / 20.022 / 19.956 | 1.78–1.87ms | 0.40ms | 2 | 3/3 通过 |
| 4／旧 | 16.098 / 16.093 / 16.081 | 1.98–2.15ms | 0.40ms | 1 | 0/3 通过，频率不足 |
| 4／新 | 20.018 / 19.943 / 20.025 | 1.88–2.10ms | 0.40ms | 1 | 3/3 通过 |

新调度六次浏览器运行均无漏画、丢包代、恢复快照或超过 50ms 的 tick。本次队列取真实入队峰值，不只取 RAF 出队后的样本。

四客户端新旧每代线缆字节约 2231B，调度变快会提高每秒传输量，不应宣称带宽下降。单客户端约 558B/代。四客户端服务端末尾 RSS 约 161.4–162.5MiB，单客户端约 157.5–157.8MiB。JSON 保留各浏览器 JS／embedder／backing storage 内存；这些数据不包含 GPU 内存，不能判断长期泄漏。四客户端服务器 CPU 总时间旧调度 234–641ms、新调度 203–282ms，波动较大，不能作为稳定 CPU 降幅结论，也不包含 Chrome CPU。

steady Hz 用全部 100 个 tick 起点计算；验收同时保留 observed Hz 的启动相位影响。最后一代会关闭测量，因此 scheduler hook 有 99 条，报告中的间隔漂移据此计算。P01 的 D=0，本轮通过只证明普通低变化负载的调度与连续呈现。

## 小地图分项与改动

冻结优化前 `minimap-cache.js` 于 `tests/baselines/minimap-index/`，manifest 记录提交与 SHA256。两个密集夹具、四类更新、三轮交替 A/B，共 24 对 PNG 完全一致。

移除首次索引构建时每个细胞生成临时 tile 数组的分配，内联相同保守 footprint；遍历与 Set 插入顺序不变。失效时释放旧贡献者索引，避免密集更新期间继续持有无用 Sets。没有增加缓存层，也未修改 Canvas 上下文或逐格绘制方式。

| 场景 | 首次索引中位数，旧→新 | 首次局部更新至完成中位数，旧→新 |
| --- | ---: | ---: |
| 90 万同色 | 65.3→60.0ms（约 -8.1%） | 74.2→68.4ms |
| 50 万四阵营 | 59.0→43.0ms（约 -27.1%） | 64.8→47.8ms |

全量更新分项中位数（当前版）：

| 场景 | packet apply | 纯遍历诊断 | Canvas 提交 | 完成读取及 PNG 编码 | apply 至完成 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 90 万同色 | 66.7ms | 12.3ms | 259.8ms | 74.3ms | 400.7ms |
| 50 万四阵营 | 50.8ms | 17.1ms | 121.1ms | 65.6ms | 236.9ms |

纯遍历是绘制前单独运行的诊断，会预热缓存；不包含在 total 中，也不能直接从 Canvas 时间中相减。Canvas 提交包括 JavaScript 调用及浏览器可能的同步工作；toDataURL 同时包括完成等待、读回和 PNG 编码，不是纯 GPU 计时。各列独立取中位数，可能不精确相加。全量路径没有实质改动，其小幅波动不认定为收益。

探索的上下文提示：`willReadFrequently: true` 产生 PNG 差异，拒绝；`alpha: false` 在单轮 8 对画面中一致，但没有明确速度收益，未采用。前一阶段保序路径批绘的像素失败结论仍然有效。

## 密集单客户端失败边界

P03 单轮，预热 100 代、测量 100 代，细胞从 891,373 增至 990,373，D=1756：

- 服务端 steady 20.020Hz，observed 19.915Hz；tick p95 28.98ms、p99 33.51ms，没有超过 50ms 的 tick，但 p95 仍超过 25ms 门槛。
- 帧工作 p95 12.0ms、p99 23.4ms、最大 402.9ms；小地图最大 401.8ms。队列峰值 8，仍超门槛 2。
- 测量与末尾排空窗口内无漏画、缺失代或恢复快照。这不消除排队延迟，也不能外推长稳。
- 约 8099.6B/代、157.5KiB/s；服务端末尾 RSS 202.9MiB；浏览器 JS used 69.4MiB、embedder 17.0MiB、backing storage 5.5MiB。

结论是未通过。暂不扩大到密集四客户端或 LAN 认证。下一项仍是全量 Canvas 重绘及导致它的失效范围，任何替代方案都必须先过严格像素比较。T13 Map 应用成本仍可后续单独拆分，不把这次索引收益记为编解码收益。

额外一次带 `--minimap-trace` 的诊断捕获了长帧触发原因：第 160 代、950,373 个细胞时，11 个节点从中立变为阵营 1，背景签名发生变化。该次重画耗时 389.4ms；细胞变化仅标记 12 个瓦片、97,088 个贡献者，但背景变更强制全图重画，并使索引失效。这是有效的领地变化，不能仅根据细胞增量跳过重绘。诊断钩子记录原因、签名和贡献者数，不在逐细胞循环中计时；其时间不混入前述验收数据。后续应专门评估背景归属变更时的重放成本，而不是继续微调 Map 扫描。

## 验证与复现

145 项单元／集成测试通过；原始版画面对照 212 项、协议画面对照 64 项、有序 Map 对照 32 项通过。画面对照覆盖 DPR 1/2。T13 默认仍为 v1。

本阶段没有重复上一阶段 54 次初始／当前 v1／当前 v2 全矩阵，也没有复测 P04。上一阶段数据是历史基线，不能视为本次源码的完整重新认证。T14–T17 状态不变。

在项目根目录执行；浏览器脚本可用 `--playwright PATH --executable PATH` 指定本地安装：

```powershell
npm test
npm run benchmark:scheduler
npm run benchmark:scheduler:e2e -- --output artifacts/performance/scheduler-minimap/e2e-final
npm run benchmark:minimap:profile -- --baseline tests/baselines/minimap-index/minimap-cache.js --output artifacts/performance/scheduler-minimap/profile-after
npm run benchmark:e2e -- --variant current-v1 --scenario P03 --clients 1 --output artifacts/performance/scheduler-minimap/dense-single
npm run benchmark:e2e -- --variant current-v1 --scenario P03 --clients 1 --minimap-trace --output artifacts/performance/scheduler-minimap/dense-trace
npm run test:browser:equivalence -- --output artifacts/performance/scheduler-minimap/equivalence
npm run test:browser:protocol
```

原始结果在 `artifacts/performance/scheduler-minimap/`：`e2e-final/` 是最终 15 轮普通负载矩阵，`e2e/` 是中途修正前的试验，不参与上述结论；`profile-after/` 为三轮索引对照。所有性能测试串行运行。`timers.json` 为最终调度源码复测。协议结果另复制到 `protocol.json`。运行 `node tests/performance/summarize-scheduler-minimap.mjs` 可校验源码哈希并重新生成汇总。
