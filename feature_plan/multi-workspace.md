# 多工作区（Multi-Workspace）实现方案

## 目标

每个工作区 = 独立窗口 + 独立工作目录 + 独立 DeepSeek 账号（cookie 隔离）。  
不同工作区的 DeepSeek 登录态各自持久化，重启后无需重新登录。

---

## 核心机制

Electron 的 `session.fromPartition('persist:xxx')` 为每个 partition 提供独立的 cookie 存储。  
Cookie 自动持久化在 `<userData>/Partitions/<partition>/Cookies`，零额外代码。

```
userData/
  Partitions/
    persist:ws-default/Cookies    ← 工作区A的DeepSeek登录态（账号1）
    persist:ws-proj-b/Cookies     ← 工作区B的DeepSeek登录态（账号2）
  pi-home/
    ws-default/                   ← 工作区A的pi配置(sessions/tools/models.json)
    ws-proj-b/                    ← 工作区B的pi配置
  app-config.json                 ← 所有工作区的元信息
```

### 为什么要独立 pi-home 目录？

pi 自己的 "workspace" 概念就是 cwd（工作目录）。pi 已经在 sessions/ 下按 cwd 自动分隔会话：

```
pi-home/sessions/
  --Users-xxx-code-proj-a--     ← cwd 为 ~/code/proj-a 的会话
  --Users-xxx-code-proj-b--     ← cwd 为 ~/code/proj-b 的会话
```

但多工作区的场景下**不同工作区使用不同 DeepSeek 账号**，每个账号对应一个独立的 HTTP server 端口，`models.json` 必须指向正确的端口：

```
工作区A（账号1）→ HTTP server :10001 → models.json 写死 http://127.0.0.1:10001/v1
工作区B（账号2）→ HTTP server :10002 → models.json 写死 http://127.0.0.1:10002/v1
```

所以必须每个工作区独立 `PI_CODING_AGENT_DIR`，不是因为 pi 的 workspace 概念冲突，而是因为 **models.json 的端口绑定是唯一的**。反过来说，如果多个工作区共用同一个 DeepSeek 账号，完全可以共享一个 pi-home，pi 会自己按 cwd 分 sessions。

---

## 配置 Schema 变更

### app-config.json（新）

```json
{
  "workspaces": [
    {
      "id": "ws-default",
      "name": "项目A",
      "cwd": "/Users/xxx/code/proj-a",
      "partition": "persist:ws-default"
    },
    {
      "id": "ws-proj-b",
      "name": "项目B",
      "cwd": "/Users/xxx/code/proj-b",
      "partition": "persist:ws-proj-b"
    }
  ],
  "mode": "expert",
  "promptTemplate": "..."
}
```

- `id`：唯一标识，partition 由 `persist:ws-<id>` 派生，无需手动指定 partition 字段（简化）
- `name`：用户自定义名称，默认取目录名
- 向后兼容：旧配置（无 workspaces 数组）启动时自动迁移为单工作区

### 向后兼容迁移逻辑

```
if (旧配置没有 workspaces) {
  从旧 workspace/cwd 字段自动创建默认工作区
  写入 workspaces 数组
}
```

---

## 架构对比

### 当前（单窗口）

```
mainWindow ── dsView (default session) ── LlmBridge ── HTTP server (1 port)
              └── PiRunner (1 cwd)
```

### 目标（多工作区）

```
WorkspaceManager
  ├── Workspace "default"
  │     ├── BrowserWindow (xterm)
  │     ├── BrowserView (partition: persist:ws-default)
  │     ├── LlmBridge (attached to this dsView)
  │     ├── HTTP server (port: 10001)
  │     └── PiRunner (cwd: ~/code/proj-a, piHome: userData/pi-home/ws-default)
  │
  └── Workspace "proj-b"
        ├── BrowserWindow (xterm)
        ├── BrowserView (partition: persist:ws-proj-b)
        ├── LlmBridge
        ├── HTTP server (port: 10002)
        └── PiRunner (cwd: ~/code/proj-b, piHome: userData/pi-home/ws-proj-b)
```

每个 Workspace 是完全自治的单元，除了共享 app-config.json 和日志文件之外互不干扰。

---

## 新增/修改文件清单

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/main/workspace-manager.js` | 管理工作区生命周期：创建、销毁、列表、配置持久化 |
| `src/main/workspace.js` | 单个工作区实例：持有 window、dsView、bridge、httpServer、runner |

### 修改文件

| 文件 | 改动范围 |
|------|----------|
| `src/main/index.js` | 大幅简化：只做 app 生命周期、tray、全局快捷键。窗口/工作区逻辑委托给 WorkspaceManager |
| `src/main/llm-bridge.js` | 接受 session partition 参数，设置 webRequest 头时作用于正确的 session |
| `src/main/http-server.js` | 无改动（每个 workspace 独立 createHttpServer，天然隔离） |
| `src/main/pi-home.js` | `prepare(port, workspaceId)` 接受 workspaceId，pi-home 子目录化 |
| `src/main/pi-runner.js` | 无改动（每个 workspace 独立 new PiRunner，天然隔离） |
| `src/preload/terminal.js` | 新增 workspace API：getName、getAccount |
| `src/renderer/terminal/index.html` | header 显示工作区名称 + 账号标识 |
| `src/renderer/terminal/terminal.js` | 渲染 workspace name |

---

## 各模块详细设计

### 1. workspace.js — 单个工作区实例

```javascript
class Workspace {
  constructor(config) {
    this.id = config.id;               // "ws-default"
    this.name = config.name;           // "项目A"
    this.cwd = config.cwd;             // "/Users/xxx/code/proj-a"
    this.partition = config.partition; // "persist:ws-default"

    this.window = null;     // BrowserWindow
    this.dsView = null;     // BrowserView
    this.bridge = null;     // LlmBridge
    this.httpServer = null; // HTTP server instance
    this.httpPort = 0;
    this.runner = null;     // PiRunner
  }

  async start() {
    // 1. 创建 BrowserWindow
    // 2. 创建 BrowserView（绑定 this.partition 的 session）
    // 3. 创建 LlmBridge，attach 到 dsView
    // 4. 创建 HTTP server，绑定随机端口
    // 5. 准备 pi-home（子目录：userData/pi-home/<id>/）
    // 6. 创建 PiRunner，绑定到 window 的 renderer
    // 7. 设置 IPC 路由
    // 8. 加载 DeepSeek 页面
  }

  async destroy() {
    // 清理：bridge、httpServer、runner、dsView、window
  }
}
```

**关键点：BrowserView 使用独立 session**

```javascript
// 在 workspace.js 中创建 BrowserView 时：
const ses = session.fromPartition(this.partition);
// 对该 session 也应用反指纹头
configureSessionForPartition(ses);

this.dsView = new BrowserView({
  webPreferences: {
    preload: path.join(__dirname, '..', 'preload', 'index.js'),
    session: ses,  // ← 关键：绑定独立 partition
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
  },
});
```

### 2. workspace-manager.js — 工作区管理器

```javascript
class WorkspaceManager {
  constructor() {
    this.workspaces = new Map();  // id → Workspace
  }

  // 从 app-config.json 恢复所有工作区
  async restoreAll() { ... }

  // 新建工作区（弹出目录选择 → 创建窗口 → 等用户登录）
  async createWorkspace(cwd, name) { ... }

  // 删除工作区
  async removeWorkspace(id) { ... }

  // 获取工作区列表
  list() { ... }

  // 持久化到 app-config.json
  _saveConfig() { ... }

  // 关闭所有工作区
  async shutdownAll() { ... }
}
```

**新建工作区流程：**

```
1. 用户触发（菜单/托盘/快捷键）
2. 弹出目录选择对话框
3. 生成 workspace id（uuid 或自增索引）
4. workspace = new Workspace({ id, name: 目录名, cwd, partition })
5. await workspace.start()
   - 创建窗口，header 显示 "登录 DeepSeek 账号"
   - dsView 加载 chat.deepseek.com，设为可见
   - HTTP server + PiRunner 待命
6. 用户在新窗口中登录 DeepSeek
7. 登录完成（cookie 自动通过 partition 持久化）
8. 用户可切换回终端视图开始工作
9. saveConfig：工作区信息写入 app-config.json
```

### 3. index.js — 简化为生命周期编排

改动要点：
- 移除全局的 `mainWindow`、`dsView`、`bridge`、`httpServer`、`runner` 变量
- 替换为 `const manager = new WorkspaceManager()`
- `app.whenReady()` 中调用 `manager.restoreAll()`
- IPC handler 移到每个 workspace 内部（或保留全局但按 workspace id 路由）
- Tray 菜单新增"新建工作区"选项

```javascript
// index.js 伪代码
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  configureSession();  // default session 反指纹（给主窗口用）
  wireGlobalIpc();     // 全局 IPC（tray、菜单等）

  manager = new WorkspaceManager();
  await manager.restoreAll();  // 恢复所有已保存的工作区

  createTray();  // 托盘含"新建工作区"
});
```

### 4. IPC 路由改动

当前 IPC 是扁平的（`pty:start`、`llm:thinking` 等），多 workspace 下需要知道消息来自哪个窗口。

**方案：利用 `event.sender` 找到对应的 BrowserWindow，反向查找 workspace**

```javascript
// 在 workspace.js 中注册 IPC 时：
function wireWorkspaceIpc(workspace) {
  // pty:start → 通过 sender 的 BrowserWindow id 匹配 workspace
  ipcMain.handle('pty:start', async (event) => {
    const ws = findWorkspaceByWebContents(event.sender);
    if (!ws) throw new Error('workspace not found');
    return ws.runner.start();
  });
  // ... 同理解析其他 IPC
}
```

或者在 preload 中注入 workspaceId，所有 IPC 消息带上 workspaceId。

**推荐方案：IPC 消息带上 workspaceId**。更简单可靠：

```javascript
// preload/terminal.js
contextBridge.exposeInMainWorld('dsAgent', {
  workspaceId: 'ws-default',  // ← 由 main 进程在加载前注入
  pty: {
    start: () => ipcRenderer.invoke('pty:start', workspaceId),
    // ...
  },
});
```

每个 workspace 创建 BrowserWindow 时，通过 `webContents.executeJavaScript` 或 query param 注入 workspaceId。

### 5. pi-home.js — 子目录化

每个 workspace 使用不同的 DeepSeek 账号 → 不同的 HTTP server 端口 → 需要不同的 `models.json`。  
因此每个 workspace 必须有独立的 `PI_CODING_AGENT_DIR`。

```javascript
// 改动前
function agentDir() {
  return path.join(app.getPath('userData'), 'pi-home');
}

// 改动后
function agentDir(workspaceId) {
  return path.join(app.getPath('userData'), 'pi-home', workspaceId);
}

function prepare(httpPort, workspaceId) {
  ensureDirs(workspaceId);
  ensureTools(agentDir(workspaceId));
  const modelsPath = writeModelsJson(httpPort, workspaceId);
  // ...
}
```

pi 自身按 cwd 分隔 sessions 的机制不变，每个 workspace 内仍然只有一个 cwd（因为网页版不能并发），
所以一个 workspace 的 pi-home 下只会有一个 cwd 对应的 session 目录。

### 6. 反指纹配置

需要在每个 partition session 上也应用反指纹：

```javascript
function configureSessionForPartition(ses) {
  ses.setUserAgent(CHROME_UA);
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    // 同原来的 configureSession 逻辑
  });
}
```

defaultSession 的 configureSession() 保留（给不涉及 DeepSeek 的窗口用）。

### 7. 终端 UI 改动

**header 区域：**

```
┌──────────────────────────────────────────────────────────┐
│ DS Agent  │ 📁 ~/code/proj-a  │ 🔵 工作号  │ 专家 │ ... │
│           │                   │            │      │     │
└──────────────────────────────────────────────────────────┘
```

- "工作号" 是当前 workspace 的 name，点击可重命名
- 不再需要全局的 workspace 切换按钮（每个窗口已绑定一个 workspace）
- "网页"按钮仍然存在，切换当前 workspace 的 DeepSeek 可见性

### 8. 托盘菜单改动

```
┌─────────────────────┐
│ 工作区              │
│   ├ 项目A (默认)    │  ← 点击显示该窗口
│   └ 项目B           │
│ 新建工作区...       │  ← 触发创建流程
├─────────────────────┤
│ 退出                │
└─────────────────────┘
```

---

## 实现步骤（建议顺序）

| 步骤 | 内容 | 文件 |
|------|------|------|
| **P1** | 抽取 `workspace.js`：把现有单窗口逻辑封装为 Workspace 类 | 新建 `workspace.js`，改动 `index.js` |
| **P2** | 改造 pi-home.js 支持子目录 | `pi-home.js` |
| **P3** | 创建 `workspace-manager.js`，实现多 workspace 管理 | 新建 `workspace-manager.js` |
| **P4** | app-config 迁移 + 恢复逻辑 | `workspace-manager.js` |
| **P5** | 新工作区创建流程（目录选择 → 窗口创建 → 登录引导） | `workspace-manager.js`、`workspace.js` |
| **P6** | Session partition 反指纹 | `workspace.js` |
| **P7** | IPC 路由改造（消息带 workspaceId） | `workspace.js`、`preload/terminal.js` |
| **P8** | 终端 UI：header 显示 workspace name | `index.html`、`terminal.js` |
| **P9** | 托盘菜单：工作区列表 + 新建入口 | `index.js` |
| **P10** | 测试：多窗口、重启持久化、cookie 隔离 | 手动测试 |

---

## 风险与注意事项

1. **内存**：每个 BrowserView ~50-100MB。2-3 个工作区完全可接受，不建议超过 5 个。
2. **端口**：每个 workspace 绑定一个随机端口（`server.listen(0)`），不会冲突。
3. **pi-home 迁移**：旧版 pi-home 下的 sessions/ 是按 cwd 命名的目录。迁移时将旧 sessions/ 目录整体复制到 `pi-home/<default-workspace-id>/sessions/`，pi 重启后自动识别对应 cwd 的会话历史。
4. **DeepSeek 并发限制**：网页版同一个账号不能并发请求。不同账号（不同 partition）互不影响。同一 workspace 内的请求仍然串行（LlmBridge 队列机制不变）。
5. **Cookie 过期**：完全依赖 Chromium session partition 机制。如果 DeepSeek 服务端让 cookie 过期，用户需要重新在该 workspace 的 DeepSeek 页面登录。
6. **向后兼容**：首次启动自动迁移旧配置，不影响现有用户。
