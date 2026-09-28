# 客户端顺序解耦与自适应位图 Implementation Plan

**Goal:** 保留服务器结算行为和逐代呈现，减少高变化棋盘传输量。

**Architecture:** v2 新增显式协商 bitmapTiles 能力和 encoding 3。每个触及瓦片选择 sparse16 或 occupancy+owner2；整包与 ordered24/delta-varint 择小。仅新能力连接解除客户端插入顺序约束，服务器 alive/changes 顺序不变。

**Tech Stack:** Node.js、WebSocket、JavaScript 类型数组、Canvas、node:test。

## 决策与边界

- 用户已授权制定并实施，在当前干净工作区完成，不另开实施会话。
- 选择瓦片自适应位图，而非固定全图位图（低变化时浪费）或通用压缩（已有积压风险）。
- 32×32 瓦片：4B 头（tileId、mode）；sparse 模式为 count 个 local+owner*1024 的 uint16；bitmap 模式 0x8001，为128B存活位图和 ceil(live/4) B阵营，每活格2bit表示owner-1。
- 位图包括整块最终状态，含删除和未变化格；边缘填充必须为零。快照可以含位图空格；空包继续用 encoding 0。
- encoding 3 包头 insertionCount=0，entryCount 为实际表示的有效格数（sparse为条目数，bitmap为有效瓦片面积）。先完整验证再写棋盘；保留队列内存计数。
- 协商能力贯穿主线程、房间worker、快照、历史重放、重连。独立缓存变体，未协商客户端不得收到新编码。新客户端连接旧服务器时回退。
- 快照后的新协议增量不依赖旧插入基准；原协议的首代有序恢复继续保留。
- 当前纹理渲染只依赖坐标最终值；CellStore 可保留作为兼容集合，但新能力不承诺遍历顺序。不得改变服务器 OrderedCells、AI 或结算。

## Task 1: 编解码

文件：public/board-protocol.js、public/bitmap-codec.js、tests/bitmap-protocol.test.js。
先覆盖快照、增量、稀疏/密集/混合、四阵营、边缘、删除、新生、同代修订、随机多代与非法载荷，再实现新编码及完整大小选择。运行 node --import ./tests/setup.js --test tests/bitmap-protocol.test.js tests/protocol-v2.test.js。

## Task 2: 协商与传输

文件：src/engine.js、src/server.js、src/room-runtime.js、public/app.js、public/generation-queue.js。
扩展参数、hello/request/ack/started、peer描述与历史变体；队列拒绝未协商encoding 3。覆盖混合客户端、主线程与worker、慢连接、恢复、连接代际。

## Task 3: 画面与性能

文件：tests/browser/protocol-v2.mjs、新增网络测试和性能脚本。
浏览器比较 v1/v2/bitmap 棋盘与主图/小地图像素；新能力只比较棋盘而非集合顺序，旧能力继续验证顺序。测50万高变化、低变化与快照的字节、编解码耗时，验证服务器输入未被重排。运行 npm test 与浏览器协议验证。

## Task 4: 文档

更新 docs/board-protocol-v2.md、README.md，新增实测报告，区分理论带宽与实际测量；不将局部微基准当作公网20Hz认证。新客户端刷新后自动协商，旧客户端可共存。
