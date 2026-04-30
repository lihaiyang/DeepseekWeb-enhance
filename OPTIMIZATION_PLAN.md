# DS Agent 优化计划

> 基于 2026-04-30 代码审查，按优先级排列的优化任务清单。

---

## 第一阶段：Agent 能力扩展（核心竞争力）

### 1.1 真正的多轮 Agentic Loop ✅

- [x] **问题**：当前 `runAgenticLoop` 注入工具结果后立即 `break`，依赖外部网络钩子重新触发，实际只执行一轮
- [x] **目标**：实现完整的"执行工具 → 注入结果 → 等待 AI 新响应 → 检测新工具调用 → 继续执行"的闭环
- [x] **关键改动**：
  - `agent.js` 中 `runAgenticLoop` 改为持续监听 AI 响应，而非 break
  - 工具结果注入后等待 SSE 流结束，再检测新工具调用
  - 增加循环终止条件：AI 不再调用工具 / 达到最大步数 / 用户手动停止
- [x] **涉及文件**：`src/renderer/agent.js`、`src/preload/index.js`

### 1.2 工具生态扩展

- [ ] **Git 操作工具** — `git_status`、`git_diff`、`git_log`、`git_branch`、`git_commit`
- [ ] **网络请求工具** — `http_request`（GET/POST/PUT/DELETE，支持 headers、body）
- [ ] **网页搜索工具** — `web_search`（对接搜索 API）
- [ ] **网页抓取工具** — `web_fetch`（获取网页内容并转 Markdown）
- [ ] **浏览器自动化工具** — `browser_navigate`、`browser_click`、`browser_screenshot`（集成 Playwright）
- [ ] **数据库查询工具** — `db_query`（SQLite/MySQL）
- [ ] **图片处理工具** — `image_resize`、`image_convert`、`image_ocr`
- [ ] **涉及文件**：`src/server/tools/` 下新增模块，`src/server/mcp-handler.js` 注册

### 1.3 工具调用检测鲁棒性提升

- [ ] **问题**：正则匹配 `\`\`\`mcp:工具名` 在 SSE 流式传输中 token 边界截断导致漏检
- [ ] **目标**：实现缓冲式检测，容忍不完整的工具调用格式
- [ ] **关键改动**：
  - 增加流式缓冲区，累积到完整格式后再检测
  - 支持多种工具调用格式（JSON 代码块、函数调用风格等）
  - 增加 `flex match` 的准确性（当前按工具名在内容中搜索可能误匹配）
- [ ] **涉及文件**：`src/renderer/agent.js`

---

## 第二阶段：架构重构（工程质量基础）

### 2.1 模块拆分

- [ ] **问题**：`agent.js`（1180 行）、`preload/index.js`（388 行）单文件巨型模块
- [ ] **目标**：按职责拆分为独立模块
- [ ] **拆分方案**：

```
src/renderer/
├── agent.js              → 入口，组装各模块
├── ui/
│   ├── panel.js          → 面板创建、模式切换
│   ├── styles.js         → CSS 样式注入
│   ├── messages.js       → 消息气泡渲染（用户/AI/思考/工具）
│   └── input.js          → 输入区域、发送逻辑
├── core/
│   ├── tool-registry.js  → 工具注册、tool hint 构建
│   ├── tool-detector.js  → 工具调用检测
│   ├── agent-loop.js     → Agentic 循环逻辑
│   └── shortcuts.js      → 键盘快捷键
└── dom/
    ├── finders.js        → DOM 元素查找（输入框、发送按钮）
    └── injector.js       → 内容注入（setInputValue 等）

src/preload/
├── index.js              → contextBridge + 注入编排
├── hooks/
│   ├── fetch-hook.js     → fetch 拦截
│   ├── xhr-hook.js       → XHR 拦截
│   └── sse-parser.js     → SSE 流解析
└── anti-fingerprint.js   → 反指纹注入
```

- [ ] **涉及文件**：`src/renderer/agent.js`、`src/preload/index.js`

### 2.2 TypeScript 迁移

- [ ] **目标**：逐步迁移核心模块到 TypeScript
- [ ] **迁移顺序**：
  1. `src/server/tools/` — 工具模块（纯逻辑，无 DOM，迁移成本最低）
  2. `src/server/mcp-handler.js` — 工具注册中心
  3. `src/main/index.js` — 主进程
  4. `src/preload/` — 预加载脚本
  5. `src/renderer/` — 渲染进程（最后迁移，DOM 操作多）
- [ ] **关键改动**：
  - 添加 `tsconfig.json`
  - 添加构建脚本（tsc 编译到 `dist/`）
  - 定义核心类型：`ToolDefinition`、`ToolCall`、`AgentState`、`PanelMode` 等
- [ ] **涉及文件**：全部源文件

### 2.3 测试覆盖

- [ ] **目标**：为核心模块添加单元测试
- [ ] **测试范围**：
  - 工具模块：`execute_command`、`read_file`、`write_file`、`edit_file`、`search_in_files`
  - 工具调用检测：`checkForToolCalls` 各种边界情况
  - 路径校验：`validatePath` 安全边界
  - SSE 解析：各种 DeepSeek 响应格式
- [ ] **测试框架**：Vitest 或 Jest
- [ ] **涉及文件**：`src/server/tools/`、`src/renderer/agent.js`

---

## 第三阶段：可靠性与稳定性

### 3.1 DOM 选择器鲁棒性

- [ ] **问题**：`findInputElement()` 和 `findSendButton()` 依赖通用选择器，DeepSeek 改版即失效
- [ ] **目标**：多策略降级查找 + 版本适配
- [ ] **关键改动**：
  - 为每个支持的站点维护独立的选择器配置
  - 实现多策略查找：aria-label → data-* 属性 → CSS class → 结构位置
  - 查找失败时提供明确的错误提示和手动操作指引
  - 增加站点版本检测和适配机制
- [ ] **涉及文件**：`src/renderer/agent.js`

### 3.2 工具调用重试机制

- [ ] **目标**：工具执行失败时自动重试（可配置次数和策略）
- [ ] **关键改动**：
  - 区分可重试错误（超时、网络）和不可重试错误（权限、路径不存在）
  - 指数退避重试策略
  - 重试信息反馈给 AI，让 AI 决定是否调整参数
- [ ] **涉及文件**：`src/server/mcp-handler.js`、`src/renderer/agent.js`

### 3.3 结构化日志系统

- [ ] **问题**：仅 `console.log`，缺乏持久化和结构化
- [ ] **目标**：分级日志 + 文件持久化 + 日志查看面板
- [ ] **关键改动**：
  - 实现 `Logger` 类：`debug`/`info`/`warn`/`error` 四级
  - 日志写入 `~/.ds-agent/logs/` 目录，按日期滚动
  - 控制面板增加"日志"标签页，支持实时查看和搜索
  - 关键操作（工具调用、Agent 循环）记录结构化日志
- [ ] **涉及文件**：`src/main/index.js`、`src/renderer/control-panel.html`

### 3.4 `search_in_files` 异步化

- [ ] **问题**：同步遍历大目录会阻塞主线程
- [ ] **目标**：改为异步实现，支持进度回调
- [ ] **关键改动**：
  - 使用 `fs.promises` 异步 API
  - 分批处理，每批之间 `setImmediate` 让出事件循环
  - 支持取消正在进行的搜索
- [ ] **涉及文件**：`src/server/tools/shell.js`

### 3.5 错误边界与优雅降级

- [ ] **目标**：工具执行失败或 DOM 变化时优雅降级，不影响整体使用
- [ ] **关键改动**：
  - 工具调用包裹 try-catch，错误信息友好化
  - DOM 操作失败时回退到手动模式提示
  - Agent 循环异常时自动恢复空闲状态
- [ ] **涉及文件**：`src/renderer/agent.js`、`src/server/mcp-handler.js`

---

## 第四阶段：用户体验

### 4.1 多站点支持

- [ ] **目标**：支持 ChatGPT、Claude、Kimi 等主流 AI 聊天平台
- [ ] **关键改动**：
  - 抽象站点适配层：选择器配置、SSE 格式解析、请求格式
  - 每个站点独立适配器
  - 控制面板站点选择下拉生效
- [ ] **涉及文件**：`src/renderer/agent.js`、`src/preload/index.js`、`src/renderer/control-panel.html`

### 4.2 对话持久化

- [ ] **目标**：关闭窗口后对话历史不丢失
- [ ] **关键改动**：
  - 对话历史保存到本地 JSON 文件
  - 支持对话列表、切换、删除
  - 支持导出对话为 Markdown
- [ ] **涉及文件**：`src/renderer/agent.js`、`src/main/index.js`

### 4.3 工具调用确认功能生效

- [ ] **问题**：设置面板有"工具调用前确认"开关，但 `agent.js` 中完全没有对应逻辑
- [ ] **目标**：开启后每次工具调用前弹出确认对话框
- [ ] **关键改动**：
  - 在 `runAgenticLoop` 中检查 `confirm_tools` 配置
  - 通过 IPC 弹出确认对话框
  - 支持"本次会话不再提示"选项
- [ ] **涉及文件**：`src/renderer/agent.js`、`src/main/index.js`

### 4.4 亮色主题

- [ ] **目标**：支持亮色/暗色主题切换
- [ ] **关键改动**：
  - CSS 变量化颜色值
  - 添加亮色主题配色方案
  - 控制面板增加主题切换选项
- [ ] **涉及文件**：`src/renderer/agent.js`、`src/renderer/control-panel.html`

### 4.5 可自定义快捷键

- [ ] **目标**：用户可自定义快捷键
- [ ] **关键改动**：
  - 快捷键配置持久化
  - 控制面板增加快捷键设置区域
  - 快捷键冲突检测
- [ ] **涉及文件**：`src/renderer/agent.js`、`src/renderer/control-panel.html`

---

## 第五阶段：分发与运维

### 5.1 自动更新

- [ ] **目标**：应用启动时检查更新，支持自动下载安装
- [ ] **方案**：`electron-updater` + GitHub Releases
- [ ] **涉及文件**：`src/main/index.js`、`package.json`

### 5.2 崩溃报告

- [ ] **目标**：异常时收集现场信息，便于排查问题
- [ ] **关键改动**：
  - 全局未捕获异常处理
  - 崩溃时保存堆栈、系统信息、最近日志
  - 提供"发送报告"选项
- [ ] **涉及文件**：`src/main/index.js`

### 5.3 配置文件加密

- [ ] **问题**：`mcp.json` 中 API key 等敏感信息明文存储
- [ ] **目标**：敏感字段加密存储
- [ ] **方案**：使用 `safeStorage`（Electron 内置）加密敏感配置
- [ ] **涉及文件**：`src/main/index.js`、`src/server/mcp-handler.js`

## 优化进度追踪

| 阶段 | 任务 | 状态 | 完成日期 |
|------|------|------|----------|
| 一 | 1.1 多轮 Agentic Loop | ✅ 已完成 | 2026-04-30 |
| 一 | 1.2 工具生态扩展 | ⬜ 待开始 | - |
| 一 | 1.3 工具调用检测鲁棒性 | ⬜ 待开始 | - |
| 二 | 2.1 模块拆分 | ⬜ 待开始 | - |
| 二 | 2.2 TypeScript 迁移 | ⬜ 待开始 | - |
| 二 | 2.3 测试覆盖 | ⬜ 待开始 | - |
| 三 | 3.1 DOM 选择器鲁棒性 | ⬜ 待开始 | - |
| 三 | 3.2 工具调用重试机制 | ⬜ 待开始 | - |
| 三 | 3.3 结构化日志系统 | ⬜ 待开始 | - |
| 三 | 3.4 search_in_files 异步化 | ⬜ 待开始 | - |
| 三 | 3.5 错误边界与优雅降级 | ⬜ 待开始 | - |
| 四 | 4.1 多站点支持 | ⬜ 待开始 | - |
| 四 | 4.2 对话持久化 | ⬜ 待开始 | - |
| 四 | 4.3 工具调用确认生效 | ⬜ 待开始 | - |
| 四 | 4.4 亮色主题 | ⬜ 待开始 | - |
| 四 | 4.5 可自定义快捷键 | ⬜ 待开始 | - |
| 五 | 5.1 自动更新 | ⬜ 待开始 | - |
| 五 | 5.2 崩溃报告 | ⬜ 待开始 | - |
| 五 | 5.3 配置文件加密 | ⬜ 待开始 | - |

