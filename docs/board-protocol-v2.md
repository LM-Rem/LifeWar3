# 棋盘协议 v2

状态：2026-09-24 实现并测试，默认保留 v1。设置 `LIFEWAR_BOARD_PROTOCOL=2` 的新服务进程才会提供 v2 协商；设置为 1 或不设置可回退。协议不会在已加入房间的连接中切换。

## 协商、会话与代边界

服务端首先发送 JSON `hello`，可用版本为 `boardProtocols:[1]` 或 `[1,2]`。新客户端等待 hello；若有 v2，先发送 `{type:"protocol",version:2}`，再发送 create/join/resume。服务端确认 `{type:"protocol",version:2}`。不协商的旧客户端一直使用 v1；遇到不含能力字段的旧服务端，新客户端也使用 v1。

`started` 包附加 `boardProtocol` 和 `roomEpoch`。客户端重置旧呈现队列后绑定它们。epoch 是非零 uint32，每次新对局递增，服务进程以随机非零值初始化；重连同一对局保持 epoch。旧 socket 消息仍由连接身份检查排除。JSON state 沿用有序 WebSocket 与 started 边界，不改变原有约 5Hz 私有状态更新。

每次广播只代表一代增量，空代也发送一个合法空包。已结束对局的同代最终修订允许 `generation == baseGeneration`；普通连续代为 `generation == baseGeneration + 1`。必须与接收队列末尾的 generation 精确衔接。缺基准、非法包、队列超限请求 resync，不静默合并世代。快照开始显式恢复区间，不声称恢复间隔内的世代已绘制。generation 为 uint32，不允许发送端溢出；超过该范围需要新对局 epoch。

每个包作为一个 WebSocket 二进制消息发送。最大有效编码约 3,000,032 字节，低于解析器 4MiB 限制，因此本版不需要应用层分片；WebSocket 自身的分片由运行时收齐后才进入解析器。

## v2 包头（32 字节）

所有多字节整数均为无符号小端。

| 偏移 | 长度 | 字段 | 约束 |
|---:|---:|---|---|
| 0 | 4 | magic | `0x3252574c`，字节 ASCII `LWR2`，与 v1 的 0/1 标记不混淆 |
| 4 | 1 | version | 2 |
| 5 | 1 | encoding | 0 = ordered24；1 = tiled |
| 6 | 2 | flags | 0 = 增量；1 = 快照；其他拒绝 |
| 8 | 4 | roomEpoch | 非零，与 started 一致 |
| 12 | 4 | generation | 本消息的棋盘代 |
| 16 | 4 | baseGeneration | 增量依赖代；快照固定 `0xffffffff` |
| 20 | 4 | payloadLength | 必须等于消息长度减 32 |
| 24 | 4 | entryCount | ordered24 的条目数；tiled 的有效棋盘坐标条目数，含 dense 中未变化格；≤1,000,000 |
| 28 | 4 | insertionCount | tiled 的有序新生表长度；ordered24 固定 0 |

v1 格式、字段与封包顺序保持不变。v2 客户端只接受协商版本的包，不按长度或猜测内容降级。

## encoding 0：ordered24

payload 为 `entryCount` 个 3 字节小端整数：`key + owner × 2^20`。key 范围 0–999999，owner 范围 0–4；0 表示删除。快照禁止 owner=0。每个 key 至多出现一次，序列保留 v1 的首次触及顺序/最终写值；快照保留 alive 顺序。payloadLength 必须等于 `3 × entryCount`。

这是所有快照和小增量的基础编码。相比 v1，每格从 4 字节减为 3 字节，但包头增加 24 字节，因此少于 24 个条目时可能比 v1 更大。空 v1 包 8 字节，空 v2 包 32 字节。

## encoding 1：tiled

棋盘分成 32×32 格瓦片，行列均有 32 个瓦片。tileId=`tileY × 32 + tileX`，local=`localY × 32 + localX`。右侧/底部瓦片有填充位置，不能映射到相邻棋盘行。

payload 依次是：

1. uint16 tileCount、uint16 保留字段 0。
2. tileCount 个瓦片记录，每个以 uint16 tileId、uint16 modeCount 开头。tileId 不允许重复。
3. insertionCount 个 3 字节小端 key，按 v1 首次触及顺序排列。

modeCount 的两种合法形式：

- **sparse**：1–1024，后接该数量的 uint16：`local + owner × 1024`。local 不允许重复，owner 0–4，坐标必须在棋盘内。
- **dense-byte**：恰为 `0x8000`，后接 1024 个 row-major owner 字节。每字节 0–4，棋盘外填充必须是 0。其他高位组合拒绝。

每个瓦片在 `2 × 变化数 > 1024` 时可选 dense，否则选 sparse。dense 发送整块最终状态，包括未变化格。发送端比较完整大小：`32 + 4 + 瓦片头 + 所有瓦片数据 + 3 × 新生数`，必须严格小于 ordered24 才采用。新生过多时自动回到 ordered24。没有采用 3bit-packed/RLE；当前 CPU 成本尚未通过默认晋级门槛，继续增加编码复杂度没有验收依据。

## 有序新生与恢复基准

room 维护上一次广播后的棋盘（启用 v2 的服务额外 1,000,000 字节/房间）。相对它从 0 变为非零的 key 才进入新生表。已存在细胞的 owner 修改不重排，删除可按任意顺序执行；所有新生必须按有序表追加。解码器在任何棋盘写入前验证每个新生有非零目标、没有重复、没有缺失，且与客户端已呈现棋盘的存活状态一致。

一次广播间内同格多次生死，以 v1 最终写语义为准：若前次广播和最终值均非零，不删除再追加。服务器内部 alive 顺序不被误当作客户端增量顺序。

新连接或 resync 可能在广播间隙取得快照，与 room 广播基准的存活状态不同。因此快照后的首个增量强制 ordered24；完成这个增量后才恢复共享瓦片编码。每个广播轮次按版本、快照/增量及是否强制有序复用编码结果，同版本客户端不会重复封包。

## 验证与内存边界

完整验证 magic、版本、flags、长度、计数、owner、坐标、重复 key/瓦片、新生表及尾随字节后，才将消息放入呈现队列。新生与当前棋盘的匹配在应用前验证，失败时不修改棋盘。旧 epoch 包忽略；版本错误和缺基准触发恢复。

队列原有 32 包、64MiB、500ms 限制保留。64MiB 计入原始消息与保留的解码数组/新生标记，避免只按压缩后的网络字节限制内存。验证、应用的短期数组及最后一个重复包检测引用另有有界开销；这不是进程总内存硬上限。

默认 v1 不分配 room 广播基准。启用 v2 后可与 v1 客户端混用；背压仍使用原有阈值与显式快照恢复，不为带宽优化取消这一保护。
