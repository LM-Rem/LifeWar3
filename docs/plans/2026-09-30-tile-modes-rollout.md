# 瓦片三模式生产接入计划

目标：将已验证的SOLID/RLE/MASK接入显式协商的encoding5，先消除原型重复编码与规划开销，保证旧协议兼容。

架构：现有planBitmap仅执行一次；MASK直接按变化数算成本；SOLID复用live/mask统计，RLE遇到复杂前缀或超过收益上界立即放弃，只扫描有希望的瓦片。写包仅一次，整包与已有有序编码择小。新能力tileModes依赖bitmapTiles+paletteTiles，独立历史变体，生产拒绝实验250。

步骤：
1. public/tile-mode-planner.js有界筛选；public/bitmap-codec.js接入三模式读写与紧凑应用，旧编码字节不变。
2. board-protocol/engine/server/room-runtime/app/generation-queue接入协商、缓存、恢复边界。
3. 实验测试复用于生产编解码，补能力拒绝、旧模式隔离；真实socket主线程/worker混用、重连、背压测试。
4. 离线矩阵增加生产候选，测量编码和包大小；浏览器主图/小地图像素一致；P03/P04/P05逐代端到端对照。
5. npm test，更新协议、README、实测报告。保留前轮未提交实验成果。不重启用户现有服务、不自动提交git。

门槛：目标结构/中等密度保留显著字节收益，旧客户端字节兼容，高变化避免原型额外5–6ms，全部重建和浏览器逐代一致；如发现性能回归先修复再完成接入。

完成记录（2026-10-01）：以上五步均已完成。5040 包、浏览器像素与兼容路径、六组端到端、全套 212 通过/4 GPU 跳过。详见[实施结果](../performance/2026-10-01-tile-modes-rollout.md)。
