# 房间事件与通讯 Implementation Plan

2026-10-04 更新：按用户要求改为纯通讯，移除战场事件转发和显示，见 [调整方案](2026-10-04-chat-only.md)。下文保留初次实现记录。

**Goal:** 将 event-feed 改为可拖动、点击标题折叠的事件与通讯面板，提供全屏半透明历史/输入界面及独立房间聊天通道。

**Architecture:** `/ws/chat` 使用现有房间令牌绑定在线主会话，独立于地图及卡牌 WebSocket。主线程保存有界的事件/聊天记录及序号；房间 worker 通过独立事件消息转发事件，不等待地图背压或 frame ACK。客户端单独管理连接、历史、确认与输入状态。

**Tech Stack:** 原生 ES modules、Node.js/ws、Canvas 战场、HTML dialog、CSS 主题变量、VisualViewport、node:test 与已有 Playwright。

1. 在 `public/conversation-model.js` 和 `src/conversation.js` 实现文本校验、200 条历史、顺序/重连、重复请求防重及个人发言频率限制。为这些行为写确定性测试。
2. 在 `src/server.js` 添加专用入口、房间令牌绑定、发送/确认、背压补发及主会话生命周期清理；在 `src/room-runtime.js` 转发独立事件。验证房间隔离、错误令牌、主会话替换、地图/卡牌积压及 worker 阻塞期间聊天可用。
3. 在 `public/conversation.js` 独立实现客户端与 UI；修改 `public/index.html`、`public/app.js`、`public/style.css`、`public/cartoon.css` 接入。保持现有战斗事件的动画/音效处理，历史改由独立通道接收。标题栏拖动与折叠复用现有行为；Enter 打开、输入框 Enter 发送、中文组合输入不发送、Esc 关闭。
4. 移动端按 VisualViewport 的可视高度放置全屏界面，输入框保持在键盘上方；滚动历史时保留阅读位置并显示新消息入口。发送前校验，等待服务器确认，断线时保留草稿并提示状态。
5. 运行规则/联机测试和两种主题下的桌面/窄屏浏览器交互验收，检查安全文本显示、拖动/折叠、键盘隔离、自动重连、历史恢复及可视区域缩小。更新 README。

聊天默认房间全员可见，淘汰与结束后仍可对话。每条最多 500 字，每人 10 秒最多 5 条；历史仅保存在内存，新对局或服务器重启清空，不新增账号或云存储。

## 验收结果

- 全量 `npm test`：249 项通过、0 失败，4 项硬件 GPU 测试跳过；最终界面调整后，聊天与卡牌针对性测试及浏览器验收再次通过。
- 独立通道集成覆盖 inline/worker 两种模式、房间隔离、令牌校验、重复请求、背压追赶、主连接断开/恢复、结束后聊天及重开清空。地图与卡牌连接积压、worker 暂时阻塞期间，聊天仍可收发。
- `tests/browser/conversation.mjs` 验证两人聊天、纯文本显示、拖动/折叠、回车及中文输入、历史滚动位置、断线恢复与丢失确认防重、结果弹窗入口、两种主题及 390px 窄屏。截图保存在 `artifacts/conversation/`。
- 移动端输入法空间通过 VisualViewport 缩小模拟；尚未进行手机真机输入法验收。
