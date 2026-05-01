# DS Agent 架构文档

## 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                      Electron App                        │
│                                                         │
│  ┌──────────┐     IPC      ┌──────────────────────────┐ │
│  │  Main    │◄────────────►│       Renderer           │ │
│  │ Process  │              │                          │ │
│  │          │              │  ┌────────────────────┐  │ │
│  │ 工具执行  │              │  │   agent.js         │  │ │
│  │ 文件系统  │              │  │   (Agent 核心)      │  │ │
│  │ 配置管理  │              │  │   - UI 面板         │  │ │
│  └──────────┘              │  │   - Agentic Loop   │  │ │
│                            │  │   - 工具调用检测     │  │ │
│                            │  └────────┬───────────┘  │ │
│                            │           │              │ │
│                            │  ┌────────▼───────────┐  │ │
│                            │  │   adapter.js       │  │ │
│                            │  │   (DeepSeek 适配器) │  │ │
│                            │  │   - sendMessage()  │  │ │
│                            │  │   - 流式回调        │  │ │
│                            │  └────────┬───────────┘  │ │
│                            │           │              │ │
│                            │  ┌────────▼───────────┐  │ │
│                            │  │   dom-bridge.js    │  │ │
│                            │  │   (DOM 操作桥)      │  │ │
│                            │  │   - findInput()    │  │ │
│                            │  │   - setInputValue()│  │ │
│                            │  └────────────────────┘  │ │
│                            │                          │ │
│                            │  ┌────────────────────┐  │ │
│                            │  │   sse-parser.js    │  │ │
│                            │  │   (SSE 流解析)      │  │ │
│                            │  └────────────────────┘  │ │
│                            │                          │ │
│                            │  ┌────────────────────┐  │ │
│                            │  │   preload/index.js │  │ │
│                            │  │   (网络拦截注入)     │  │ │
│                            │  │   - fetch 拦截      │  │ │
│                            │  │   - XHR 拦截        │  │ │
│                            │  │   - 系统提示词注入   │  │ │
│                            │  └────────────────────┘  │ │
│                            └──────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## 两条消息发送路径

DS Agent 向 DeepSeek 发送内容有两条完全不同的路径：

### 路径一：DOM 注入（用户消息 + 工具结果）

用于发送**对话内容**（用户输入、工具执行结果），这些内容需要出现在聊天记录中。

```
agent.js                    adapter.js              dom-bridge.js
   │                            │                        │
   │  sendMessage(text)         │                        │
   │──────────────────────────►│                        │
   │                            │  findInputElement()    │
   │                            │───────────────────────►│
   │                            │                        │ 查找 textarea 或
   │                            │                        │ contenteditable
   │                            │◄───────────────────────│
   │                            │                        │
   │                            │  input.focus()         │
   │                            │  setInputValue(text)   │
   │                            │───────────────────────►│
   │                            │                        │ textarea:
   │                            │                        │  原生 setter 设 value
   │                            │                        │  dispatch input/change
   │                            │                        │
   │                            │                        │ contenteditable:
   │                            │                        │  execCommand('insertText')
   │                            │                        │
   │                            │  findSendButton()      │
   │                            │───────────────────────►│
   │                            │                        │
   │                            │  sendBtn.click()       │
   │                            │  (或 dispatch Enter)   │
   │                            │                        │
   │  Promise<fullResponse>     │                        │
   │◄──────────────────────────│                        │
```

**关键实现细节：**

- **绕过 React 受控组件**：使用 `Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(element, value)` 直接设置原生 value，避免 React 的 setState 被覆盖
- **触发 React 事件**：手动 dispatch `InputEvent('input')` 和 `Event('change')`，让 React 感知到值变化
- **contenteditable 兼容**：对于 contenteditable 输入框，使用 `document.execCommand('insertText')` 插入文本

### 路径二：网络拦截注入（系统提示词）

用于注入**系统提示词**（工具列表、使用规则等），这些内容不应出现在聊天 UI 中。

```
agent.js                    preload/index.js           DeepSeek API
   │                            │                          │
   │  buildToolHint()           │                          │
   │  生成系统提示词              │                          │
   │                            │                          │
   │  window.__dsAgentToolHint  │                          │
   │  = hint                    │                          │
   │──────────────────────────►│                          │
   │                            │                          │
   │                            │  fetch() 被调用           │
   │                            │  (DeepSeek 发 API 请求)   │
   │                            │                          │
   │                            │  modifyRequestBody()     │
   │                            │  读取 __dsAgentToolHint   │
   │                            │  往 body.prompt 前拼接    │
   │                            │                          │
   │                            │  修改后的请求 ────────────►│
   │                            │                          │
   │                            │◄──── SSE 流式响应 ────────│
   │                            │                          │
   │                            │  sse-parser.js 解析       │
   │                            │  → onThinking(delta)     │
   │                            │  → onContent(delta)      │
   │                            │  → onEnd(fullResponse)   │
```

**关键实现细节：**

- **fetch 拦截**：重写 `window.fetch`，在请求发出前调用 `modifyRequestBody()`
- **XHR 拦截**：重写 `XMLHttpRequest.prototype.send`，同样在发送前修改 body
- **防重复注入**：检查 body 中是否已包含 `[系统指令]`，避免重复拼接
- **仅修改 prompt 字段**：只修改 `parsed.prompt`，不影响其他请求参数

### 为什么分两条路径？

| 维度 | DOM 注入 | 网络拦截 |
|------|----------|----------|
| 用途 | 用户消息、工具结果 | 系统提示词 |
| 是否可见 | 出现在聊天 UI | 不可见 |
| 注入时机 | 每次发送消息时 | 每个 API 请求自动带上 |
| 对 DeepSeek 前端 | 前端感知到（模拟用户输入） | 前端完全不知道 |
| 实现复杂度 | 需处理 React 受控组件 | 需处理 fetch/XHR 双拦截 |

## Agentic Loop 流程

```
用户输入
   │
   ▼
sendUserMessage()
   │
   ├─ 显示用户消息到面板
   ├─ adapter.sendMessage(text) ──► DeepSeek
   │                                    │
   │                              SSE 流式返回
   │                              onThinking / onContent / onEnd
   │                                    │
   ◄────────────────────────────────────┘
   │
   ▼
checkForToolCalls(fullResponse)
   │
   ├─ 无工具调用 → 结束
   │
   └─ 有工具调用 → runAgenticLoop(calls)
                     │
                     ▼
               ┌─────────────────┐
               │  for each call  │
               │  执行工具        │
               │  收集结果        │
               └────────┬────────┘
                        │
                        ▼
               构建 <tool_result> 消息
                        │
                        ▼
               adapter.sendMessage(combinedResult)
                        │
                        ▼
               checkForToolCalls(finalResponse)
                        │
               ┌────────┴────────┐
               │                 │
            有调用             无调用
               │                 │
               ▼                 ▼
          继续循环             结束
        (最多 maxAgentLoops 步)
```

**工具调用检测规则：**

- 只执行响应**末尾**的工具调用（忽略中间的示例代码）
- 使用正则匹配 `<tool_call>` 标签
- 去重：同一轮中已执行的调用不再重复执行

## 面板管理

### 启动流程

```
应用启动
   │
   ▼
init()
   │
   ├─ createPanel()         创建面板 DOM（默认隐藏）
   ├─ waitForLogin()        轮询检测登录状态
   ├─ 检查工具连接
   ├─ 加载工具注册表
   ├─ 设置键盘快捷键
   └─ selectExpertMode()    延迟 1s 自动切专家模式
```

### 登录检测

```
waitForLogin()
   │
   ▼
每秒轮询 dom-bridge.findInputElement()
   │
   ├─ 找到输入框 → 已登录 → showPanel()
   │
   └─ 60s 超时 → 保持隐藏，用户手动点 🤖
```

### 面板模式

| 模式 | 说明 |
|------|------|
| `compact` | 紧凑模式，仅显示基本消息 |
| `half` | 半屏模式，显示步骤详情 |
| `full` | 全屏模式，完整 Agent 面板 |

### 新建会话

```
newConversation()
   │
   ├─ stopAgentLoop()       停止当前 Agent
   ├─ 清空面板 UI
   ├─ 查找并点击 DeepSeek 侧边栏"开启新会话"按钮
   │   ├─ 策略1: 全文搜索关键词（开启新会话/新对话/New Chat）
   │   ├─ 策略2: 尝试常见 CSS 选择器
   │   └─ 策略3: 找侧边栏容器，点首个可点击子元素
   └─ selectExpertMode()    自动切专家模式 + 关智能搜索
```

## 模式与开关自动配置

`selectExpertMode()` 执行时自动完成以下配置：

| 配置项 | 目标状态 | 实现方式 |
|--------|----------|----------|
| 模型模式 | 专家模式 | 查找"专家模式"文本元素并点击 |
| 深度思考 | 开启 | 默认开启，无需额外操作 |
| 智能搜索 | **关闭** | `disableWebSearch()` 查找"智能搜索"并关闭 |

`disableWebSearch()` 实现：
1. 遍历 DOM 找文本为"智能搜索"的 `<span>`
2. 向上查找真正的可点击容器（button/label/role="switch"/cursor:pointer）
3. 检测容器及其祖先是否有 active/selected/checked 状态
4. 如果开启中 → 点击容器关闭

## 模块职责

| 文件 | 运行环境 | 职责 |
|------|----------|------|
| `src/main/index.js` | Main Process | Electron 主进程，工具执行、文件系统、IPC |
| `src/preload/index.js` | Preload | 网络拦截注入、contextBridge API 暴露 |
| `src/renderer/agent.js` | Renderer (isolated) | Agent 核心逻辑、UI 面板、Agentic Loop |
| `src/renderer/deepseek/adapter.js` | Renderer (main world) | DeepSeek 适配器，统一消息发送接口 |
| `src/renderer/deepseek/dom-bridge.js` | Renderer (main world) | DOM 操作工具集（查找输入框、设置值等） |
| `src/renderer/deepseek/sse-parser.js` | Renderer (main world) | SSE 流解析，提取 thinking/content |

### 运行环境说明

- **Main World**：直接注入到页面全局作用域，可访问页面原生 DOM 和变量
- **Isolated World**：通过 `contextBridge` 暴露有限 API，与页面隔离

`adapter.js`、`dom-bridge.js`、`sse-parser.js` 运行在 Main World，因为它们需要直接操作 DeepSeek 页面的 DOM 和拦截网络请求。

`agent.js` 运行在 Isolated World，通过 `window.__dsAgentAdapter` 等桥接对象与 Main World 通信。

## 键盘快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Enter` | 发送消息 |
| `Ctrl+Shift+N` | 新建会话 |
| `Ctrl+Shift+S` | 停止 Agent |
| `Ctrl+Shift+M` | 切换面板模式 |
