# 棋盘协议 v2

状态：运行脚本默认 GPU＋v2；显式 `LIFEWAR_BOARD_PROTOCOL=1` 回退。直接运行 server.js/导入 createServer 不加载运行脚本默认值。2026-09-26 增加显式协商的 encoding 2；不在已加入房间的连接中切换协议。

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
| 5 | 1 | encoding | 0 = ordered24；1 = tiled；2 = delta-varint；3 = bitmap-tiles；4 = palette-tiles（2/3/4分别另行协商） |
| 6 | 2 | flags | 0 = 增量；1 = 快照；其他拒绝 |
| 8 | 4 | roomEpoch | 非零，与 started 一致 |
| 12 | 4 | generation | 本消息的棋盘代 |
| 16 | 4 | baseGeneration | 增量依赖代；快照固定 `0xffffffff` |
| 20 | 4 | payloadLength | 必须等于消息长度减 32 |
| 24 | 4 | entryCount | ordered24/delta-varint 的条目数；tiled/bitmap-tiles 的有效棋盘坐标条目数，含密集块中未变化格；≤1,000,000 |
| 28 | 4 | insertionCount | tiled 的有序新生表长度；其他编码固定 0 |

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

## 有序差值扩展（2026-09-26）

提供扩展的服务器在 hello 中发送 `boardEncodings:[0,1,2]`。客户端仅在看到 2 时请求 `{type:"protocol",version:2,deltaVarint:true}`；服务端确认相同布尔字段。未请求扩展的旧客户端仅收到 encoding 0/1。运行脚本仍默认 GPU＋v2，新客户端自动请求扩展。

encoding 2 的每个条目按原始 keys 顺序编码：初始 `last=0`，`delta=key-last`，`zigzag=(delta<<1)^(delta>>31)`，`value=zigzag*8+owner`，使用 unsigned LEB128 写出 value，再更新 last。每条 1–4 字节，第四字节小于 8。owner 取低三位且只能为 0–4，快照不可为 0；key 只能为 0–999999，不可重复。拒绝截断、溢出、非最短编码、额外尾部字节及条目数不符。该编码既支持增量也支持快照，insertionCount 为 0。

编码器比较三种完整包长度，仅当差值编码更小时采用；不排序、不合并代数。首次快照之后的增量仍强制有序（0 或 2），历史缓存按客户端协商能力区分包，避免把扩展发送给旧客户端。解码必须完整校验后才修改棋盘。性能代价见 README 与本轮报告。


## 无序自适应位图扩展（2026-09-28）

新服务器 hello 发送 `boardEncodings:[0,1,2,3]`。新客户端在加入房间前请求 `{type:"protocol",version:2,deltaVarint:true,bitmapTiles:true}`，仅在 hello 分别提供对应编码时请求。服务器确认 `bitmapTiles`，并在 started 中再次声明；客户端据此配置呈现队列，未协商时拒绝 encoding 3。bitmapTiles 和 deltaVarint 是独立能力；支持只启用位图。旧客户端继续接收 0/1/2，新客户端连接旧服务器自动回退。

能力表示客户端只要求**每一代每个坐标最终状态准确**，不再要求细胞集合具有原始插入顺序。服务器 alive、变化首次触及顺序、AI 与全部结算保持不变；当前主图和小地图都基于世界纹理，写入不同坐标的顺序不改变最终像素。CellStore 保留为兼容集合，新能力不承诺遍历顺序。

### encoding 3：bitmap-tiles

包头复用 v2，insertionCount 必须为0。payload 为 uint16 tileCount、uint16 保留0，然后逐瓦片记录；tileCount 为1–1024，tileId 不可重复。瓦片划分、local 编号与 encoding 1 相同。

每个瓦片头为 uint16 tileId、uint16 mode：

- `1..1024`：sparse，后跟 mode 个 uint16 `local + owner*1024`，owner 为0–4，快照只允许1–4。坐标有效且不重复。
- `0x8001`：完整瓦片位图。先128字节存活位，local 对应第 local>>3 字节的第 local&7 位，低位优先；再按local递增顺序，为每个活格写2bit的 owner-1，低位优先，每字节4个。长度为128+ceil(活格数/4)。地图边缘外存活位必须为0，末字节未用阵营位必须为0。其他mode拒绝。

位图代表该瓦片**全部有效格子的最终状态**，空位会清除既有细胞，未变化格也被表示。快照允许位图中有空格，未出现的瓦片由快照清空语义处理。entryCount 是 sparse 条目数与 bitmap 有效面积之和，不计地图外填充；须与实际解码数量完全一致。解码得到的有界 Uint32Array 计入队列内存，数据完整校验后才应用。没有新生表，也不依赖客户端旧插入基准。

编码器统计触及瓦片，对每块比较 `2*变化数` 和 `128+ceil(活格数/4)`；快照使用活细胞作为稀疏候选。再比较整个瓦片包和 ordered24 / 已协商 delta-varint 包的大小，仅在更小时选择位图包。旧 tiled 被新瓦片方案覆盖：稀疏成本相同、密集成本更低且没有新生表。小包、空代自然保留旧编码，不改变逐代发送。

### 缓存与恢复

主线程与房间worker使用独立变体：1、2、2-varint、2-bitmap、2-bitmap-varint。相同能力客户端共享编码结果。位图连接快照后的首个增量无需 ordered 特例，既有协议继续保留该保护；代号、baseGeneration、epoch、队列容量、时延和历史上限保持不变。重连必须重新协商，不复用旧连接能力。

实测与范围见 `performance/2026-09-28-adaptive-bitmap.md`。50万高变化约260KB/代（含包头，具体取决于边缘与瓦片），不是固定250KB；解码的整块状态会增加客户端应用遍历量。


## 紧凑解码与传输反馈（2026-09-29）

网络编码字节不变。浏览器队列使用 `decodeBoardPacket(buffer,{compactBitmap:true})`：encoding 3完整校验后保留原包及每瓦片3个uint32索引（tileId/mode/offset），不生成百万格条目数组；entryCount继续表示有效坐标数。队列计入原包与索引内存；旧协议和默认解码API继续返回展开entries。呈现时visitBitmap直接遍历已验证数据，比较现有棋盘后只更新实际变化。新路径切换到BoardCells棋盘视图，避免维护历史插入链表；reset恢复旧CellStore，旧能力的顺序语义保留。

每批历史发送累计达到256KiB或4包即停止，允许单个合法大包超过预算；缓冲超过256KiB暂停。主线程发送完成后按房间合并通知，worker在输出ACK或缓冲更新后只在存在可发送积压时排空，不依赖新增演化tick。缓冲更新不能解除输出锁；发送回调不表示客户端已收到。主线程回退同样支持有界发送完成追赶。历史不足继续显式快照恢复，代号/epoch/队列上限不变。

hello增加 `clientProgress:true`。支持的客户端每500ms在前台游戏中发送一次 `client_progress`，优先已绑定控制连接，否则主连接；发送缓冲高时跳过。字段为roomEpoch、received（收到并校验代号）、displayed（主图draw提交后的代号）、queueDepth、oldestMs、decodeMs、applyMs。displayed不是物理显示器扫描确认。服务器按当前绑定连接和房间epoch校验，received不得超出已发送代，displayed不得超过received，代号不能回退，队列0–32，时长有限且0–60000ms，最快接受间隔250ms。

服务器保留每连接最新一份诊断并返回network_status，附加computedGeneration/sentGeneration。它不用于权威结算、删历史、自动丢代或送达确认。新客户端连接未声明能力的旧服务器时不发送。页面延迟数字的悬停提示显示最近诊断，控制台 `window.lifeWarNetwork` 可查看完整字段；诊断是取样值，不是当前瞬时值。


## 局部调色板扩展（2026-09-29）

hello 的 `boardEncodings` 增加4。客户端仅在同时提供3和4时请求 `bitmapTiles:true,paletteTiles:true`；服务端仅在v2且bitmapTiles成立时接受paletteTiles，在protocol确认及started中声明。旧v2无4时继续使用位图；v1保持原样。GenerationQueue未协商paletteTiles时拒绝encoding 4，reset清除能力。编码API的allowPalette默认false，需同时allowBitmap才能生效。

### encoding 4：palette-tiles

复用encoding 3的头、瓦片头、entryCount与完整瓦片替换语义，insertionCount为0。允许原sparse、0x8001位图，再增加mode `0x8002`：

1. 128字节存活位图，位序与0x8001相同。
2. 1字节阵营mask，bit0..3对应owner1..4；高4位必须为0，恰有1或2位为1。活格数必须非零。
3. mask中阵营按owner升序构成调色板。单阵营不写逐格阵营；双阵营按活格local递增顺序写1bit索引，低位优先，0/1分别指向较小/较大owner。字节数为ceil(live/8)。尾字节未用位必须为0。

数据长度为单阵营129字节、双阵营129+ceil(live/8)字节（不含4字节瓦片头）。三/四阵营仍用0x8001的128+ceil(live/4)；空瓦片也用原位图。地图外存活位必须为0。非法mask、截断、padding、重复瓦片/坐标、计数、尾随字节在队列或绘制写入前拒绝。encoding 3不接受0x8002；不存在为旧客户端偷偷扩充mode的行为。

编码器比较稀疏、原2bit和局部调色板的实际字节数，仅严格更小时采用。整包再与ordered24/已协商delta-varint比较；未选中调色板瓦片则仍标3，小包/空包可标0/2。局部最小化保证已协商bitmap的同样输入启用palette不会增大包。紧凑解码保留原buffer和3×tileCount个uint32索引，visitBitmap直接应用，无额外百万格展开数组。

主线程和worker增加 `2-bitmap-palette` / `2-bitmap-palette-varint` 变体；不与旧bitmap共享不兼容包。逐代历史、快照首增量、epoch、内存和年龄上限保持；混用更多能力会存更多历史变体，总历史仍受16MiB约束。

### 诊断采样补充

network_status增加 `bufferedBytes`（采样时主棋盘socket的bufferedAmount），界面悬停延迟数字同步显示。它是待发送应用缓冲，不是客户端送达确认，也不包含全部操作系统/TLS/隧道队列。computed/sent是服务端处理反馈时的值，received/displayed是客户端更早采样的值，代号差不代表同时刻单向延迟。

测量、场景定义、复现与真实线路采集入口见 [局部调色板结果](performance/2026-09-29-local-palette.md)。
