# T01 冻结基线与复现

日期：2026-09-23。基线是开始执行 T01–T04 时的**实际工作区**，包含用户已有未提交修改，不是 Git HEAD。

- `tests/reference/manifest.json`：48 个文件的 SHA-256、原始字节数、采集时间、原 HEAD 与工作区状态。
- `tests/reference/src/`、`public/`：独立参考引擎、休眠、AI、服务器、浏览器及其共享依赖。
- `tests/reference/tests/`、`docs/`：采集时原有验证与文档。
- `tests/fixtures/performance/production-20hz.json`：采集时实战配置，独立于之后用户修改的 config.json。
- `tests/reference/.gitattributes`：关闭该目录换行转换，防止跨平台检出破坏字节级哈希。该维护文件不属于原始快照清单。
- `tests/reference/storage-manifest.json`：为已经被 Git 规范化的 CRLF/LF 提供辅助内容哈希；只允许换行格式变化，任何其他源码变化仍失败，原始字节哈希不改写。

冻结脚本 `tests/performance/freeze-reference.mjs` 只能在参考目录不存在时执行，已存在会拒绝覆写。正常开发不要重新冻结来“修复”失败测试。每次 `npm test` 校验清单中所有文件的实际哈希。

## 测量口径

```powershell
node tests/performance/environment.mjs
npm run benchmark
npm run benchmark:expansion
node tests/performance/runner.mjs --help
node tests/performance/runner.mjs --scenario P03 --backend legacy --profile smoke
node tests/performance/runner.mjs --scenario P03 --backend current --profile smoke
```

`legacy` 读取冻结引擎；`current` 读取当前引擎。未实现 sparse/dense/frontier/CUDA，传入这些后端会报错，不能静默回退。runner 在动态导入配置/引擎前选择 20Hz 夹具。

普通基准和 expansion 基准保留原场景用途，但现在输出真实执行代数、提前结束/空种群标记、L（代末活细胞）、C（本代候选）、D（最终网络变更数）、p50/p95/p99/max、50ms 超期次数与内存分类。

每秒字节数分为：

- simulatedBytesPerSecond：按执行代数÷配置 hz 换算。20Hz 的 100 代是 5 秒，不再错误除以 10。
- wallBytesPerSecond：按整个测量循环的真实持续时间换算，包括计时区间外的诊断统计；不是实际网络吞吐。

tickMs 只包含 step+packet；C 的读取/统计在计时区间之外。冻结引擎无 lastCandidateCount 时由 marks 计算，当前引擎保存已有候选长度，不额外扫描百万格。采样/统计、参考回放和截图不得放入 tick 计时区间。

## 正式 A/B/C

```powershell
node tests/performance/compare.mjs --rounds 5 --generations 100 --warmup 30
```

每场景、每变体分别运行 5 个独立 Node 进程；每个进程预热 30 代，再测 100 代。各轮交替 legacy/current/traced 次序；没有同时运行测试或浏览器。报告保存到 `artifacts/performance/t01-t04-ab/`，该目录已被 Git 忽略。

三种场景：P01=24,000 分散静物；P03=初始 800,000 连续细胞的密集扩张；P04=约 50% 密度四阵营高变化。P03/P04 使用固定强力规则、冻结时间、超高基地耐久和延长的休眠阈值保持压力，**不是合法时长的真实卡牌对局**。

汇总取各轮均值的中位数，并保留每轮 p99、所有轮最坏值和超期总数；不把各轮 p99 平均成全局 p99。该轮次小于完整认证方案的 1000代×5轮，仅作为 T01–T04 的阶段 A/B；后续算法、多人实战与发布认证仍须按完整方案执行。

## 环境完整性

environment.mjs 记录 Node、OS、CPU、逻辑核、内存，以及工具可用时的 GPU/驱动/显存/温度/频率和电源方案。浏览器、DPR、刷新率、实测网络带宽在 CPU 合成测试中标记 null，不推断它们已经验证。

浏览器冒烟另有 userAgent、DPR、viewport 和 Chrome 版本。它是 headless 冒烟，不等价于物理屏幕零丢帧认证或手机真机验证。

实施结果见 [T01–T04 结果与使用说明](t01-t04-results.md)。
