# DS Agent

> ⚠️ **实验性项目，功能并不稳定。**
>
> 本项目通过模拟浏览器访问 DeepSeek 网页版来实现对话能力，**存在随时被官方反爬策略中断的风险**，不保证可用性。如果你需要大量、稳定地使用 DeepSeek，**强烈建议在 [DeepSeek 官方平台](https://platform.deepseek.com/) 为 API 充值**——价格非常便宜，且提供标准、可靠的 API 服务。

---

## 这是什么？

DS Agent 是一个基于 [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的桌面 Coding Agent 工具。它内置了一个终端（xterm.js），背后由 DeepSeek 模型驱动，**无需 API Key** 即可使用。

核心思路：在 Electron 应用内嵌入一个隐藏的 DeepSeek 网页版，通过本地 HTTP 服务（OpenAI Chat Completions 格式）桥接给 pi-coding-agent，让你拥有一个可以与文件系统交互、执行命令行、读写代码的 AI 编程助手。

## 工作原理

```
┌─────────────────────────────────────────────────┐
│                  Electron 壳                     │
│  ┌───────────┐   HTTP (127.0.0.1)   ┌─────────┐ │
│  │ pi (PTY)  │ ◄──────────────────► │ HTTP    │ │
│  │           │   OpenAI 兼容 API     │ Server  │ │
│  │ xterm.js  │                      └────┬────┘ │
│  └───────────┘                           │      │
│        ▲                                 ▼      │
│        │                          ┌────────────┐ │
│        │      用户终端界面         │  LLM Bridge│ │
│        └──────────────────────────┤            │ │
│                                   └─────┬──────┘ │
│                                         │        │
│  ┌──────────────────────────────────────▼──────┐ │
│  │         DeepSeek 网页版 (BrowserView)        │ │
│  │  通过 DOM 操作注入 prompt、解析 SSE 流       │ │
│  └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

1. **HTTP Server** 在 `127.0.0.1` 上提供 OpenAI 兼容的 `/v1/chat/completions` 端点
2. **LLM Bridge** 将请求翻译为 DeepSeek prompt，通过 IPC 发送到内嵌的 DeepSeek 网页
3. **DeepSeek 网页**（BrowserView）模拟用户输入，实时解析 SSE（Server-Sent Events）流
4. **pi-coding-agent** 连接本地 HTTP 服务，获得完整的 AI 编程助手能力
5. **xterm.js 终端** 提供与 pi 交互的界面

## 功能特性

- 🖥️ 桌面终端体验——基于 xterm.js 的全功能终端
- 🤖 内置 pi-coding-agent——文件搜索、代码读写、命令执行
- 🔍 离线工具支持——内置 fd 和 ripgrep，无需联网下载
- 📝 可编辑的 Prompt 模板——自定义系统提示词
- 🔀 Agent 模式切换——expert（完整推理）与 quick（快速响应）
- 🪟 DeepSeek 网页预览——随时切换回网页版手动交互
- ⌨️ 全局快捷键——`Ctrl+Shift+D` 切换终端/DeepSeek 视图
- 🖥️ 跨平台——Windows、macOS (Intel + Apple Silicon)、Linux

## 快速开始

### 前置要求

- Node.js 18+
- npm 或 yarn
- **一个 DeepSeek 账号**（免费注册即可）

### 安装与运行

```bash
# 克隆仓库
git clone https://github.com/lihaiyang/DeepseekWeb-enhance.git
cd DeepseekWeb-enhance

# 安装依赖
npm install

# 启动开发模式
npm run dev
```

首次启动时会打开 DeepSeek 网页，请在浏览器窗口中**登录你的 DeepSeek 账号**。登录状态会被 Electron 持久化，后续无需重复登录。

按 `Ctrl+Shift+D` 切换到终端界面，即可与 pi-coding-agent 对话。

### 构建安装包

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux

# 全平台
npm run build
```

构建产物在 `dist/` 目录下。

## 项目结构

```
src/
├── main/                    # Electron 主进程
│   ├── index.js             # 入口：窗口管理、IPC、生命周期
│   ├── llm-bridge.js        # LLM 请求调度、串行队列、超时处理
│   ├── http-server.js       # 本地 OpenAI 兼容 HTTP 服务
│   ├── pi-runner.js         # pi-coding-agent 进程管理
│   ├── pi-home.js           # pi 运行环境初始化（models.json、工具复制）
│   ├── pty-host.js          # 伪终端宿主进程
│   └── protocol/            # DeepSeek 协议适配
│       ├── build-prompt.js  # 构建发送给 DeepSeek 的 prompt
│       └── parse-stream.js  # 解析 DeepSeek SSE 流
├── renderer/                # 渲染进程（UI）
│   ├── terminal/            # 终端界面（xterm.js）
│   ├── prompt-editor/       # Prompt 模板编辑器
│   ├── deepseek/            # DeepSeek 网页交互层
│   │   ├── adapter.js       # OpenAI 请求 → DeepSeek 请求适配
│   │   ├── dom-bridge.js    # DOM 操作桥接
│   │   └── sse-parser.js    # SSE 流解析
│   └── api/DeepSeekClient.js # DeepSeek 网页端 API 封装
├── preload/                 # Electron preload 脚本
│   ├── index.js             # DeepSeek view preload
│   ├── terminal.js          # 终端 view preload
│   └── prompt-editor.js     # Prompt 编辑器 preload
vendor/
├── tools/                   # 预置工具二进制（已入库）
│   ├── win-x64/             # fd.exe, rg.exe
│   ├── darwin-x64/          # fd, rg
│   └── darwin-arm64/        # fd, rg
└── node/                    # 分平台 Node.js 运行时（构建时下载）
scripts/
├── fetch-tools.js           # 下载 fd/ripgrep 二进制
├── fetch-node.js            # 下载分平台 Node.js
├── build.js                 # 构建脚本
└── test-*.js                # 各模块测试
```

## 测试

```bash
# 运行所有测试
npm test

# 单独测试
npm run test:protocol   # 协议层测试
npm run test:http       # HTTP 服务测试
npm run test:bridge     # LLM 桥接测试
npm run test:pi         # pi 集成测试
```

## 技术栈

- **Electron** — 桌面应用框架
- **xterm.js** — 终端模拟器
- **pi-coding-agent** — AI 编程助手引擎
- **node-pty** — 伪终端
- **DeepSeek** — 后端大语言模型（通过网页版访问）

## 许可

[GPL-3.0](LICENSE)

---

> 💡 再次提醒：这是一个实验性项目。如果你发现它有用，请考虑在 [DeepSeek 官方平台](https://platform.deepseek.com/) 充值 API——既便宜又稳定，也是支持他们持续进步的最好方式。
