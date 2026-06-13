# DeepSeek Chat SSE 流式协议技术文档

> 基于对 `chat.deepseek.com` 实际抓包日志（`ds-agent-debug.txt`）的逆向分析。  
> 后续凡涉及 SSE 解析的代码改动，必须对照本文档。

---

## 1. 传输层

DeepSeek 使用标准 **Server-Sent Events（SSE）** 格式传输流式响应：

```
data: <JSON>\n\n
data: <JSON>\n\n
data: [DONE]\n\n
```

- 每个 SSE 事件以 `data: ` 开头，以 `\n\n`（两个换行）结束
- 单个事件内部可能有多行（以 `\n` 分隔），每行都以 `data:` 开头
- 最终以 `data: [DONE]` 标识流结束

---

## 2. 帧类型总览

DeepSeek 的 SSE 流中有且仅有以下几种 JSON 帧：

| 帧类型 | 特征 | 说明 |
|--------|------|------|
| **全量快照帧（初始化）** | `v` 是对象，包含完整 `response` 结构 | 流开始时发送，初始化会话 |
| **全量快照帧（Fragment 切换）** | `p` 存在，`v` 是数组，元素为 Fragment 对象 | 切换活跃 Fragment（如 THINK→RESPONSE） |
| **增量帧（带 p）** | `p` 存在，`v` 是字符串 | 向当前活跃 Fragment 追加内容 |
| **增量帧（无 p）** | 无 `p` 字段，`v` 是字符串 | 同上，DeepSeek 会混用两种格式 |
| **元数据帧** | `p` 指向非 content 字段（如 elapsed_secs、status） | 不含正文，用于传递元信息 |

---

## 3. 帧结构详解

### 3.1 全量快照帧（初始化）

流开始时发送，`v` 字段是完整的 response 对象。

```json
{
  "v": {
    "response": {
      "message_id": 2,
      "role": "ASSISTANT",
      "thinking_enabled": true,
      "status": "WIP",
      "fragments": [
        {
          "id": 2,
          "type": "THINK",
          "content": "好的",
          "elapsed_secs": null,
          "references": [],
          "stage_id": 1
        }
      ],
      "conversation_mode": "DEFAULT"
    }
  }
}
```

**关键信息：**
- `fragments` 数组中的最后一个元素是当前活跃的 Fragment
- `type` 字段标识 Fragment 类型：`"THINK"` = 思考内容，`"RESPONSE"` = 正文回复
- `content` 字段是该 Fragment 的**初始内容**（不是增量，是全量）
- 这一帧必须被处理，否则会丢失 Fragment 的初始字符（本项目曾因此丢失"好的"、"你好"）

### 3.2 全量快照帧（Fragment 切换）

当模型从思考切换到回复（或其他 Fragment 类型切换）时发送。

```json
{
  "p": "response/fragments",
  "v": [
    {
      "id": 3,
      "type": "RESPONSE",
      "content": "你好",
      "references": [],
      "stage_id": 1
    }
  ]
}
```

**关键信息：**
- `p` 字段为 `"response/fragments"`
- `v` 是数组，包含**新增的** Fragment（注意：不是所有 Fragment 的全量列表）
- `v` 中最后一个元素是新的活跃 Fragment，其 `type` 标识新的内容类型
- `content` 是新 Fragment 的初始内容（同样不是增量）
- 收到此帧后必须更新"当前活跃 Fragment 类型"状态

### 3.3 增量帧（带 p 字段）

```json
{ "p": "response/fragments/-1/content", "v": "，" }
```

**关键信息：**
- `p = "response/fragments/-1/content"` 中的 `-1` 表示**最后一个（即当前活跃）Fragment**
- `v` 是字符串增量，需追加到当前活跃 Fragment 对应的累积器
- **不能**仅凭 `p` 判断是思考还是正文，必须依赖外部状态（`_currentFragType`）

### 3.4 增量帧（无 p 字段）

```json
{ "v": "用户" }
{ "v": "只是" }
{ "v": "打了个" }
```

**关键信息：**
- ⚠️ **极易踩坑**：这种帧没有 `p` 字段，但与 3.3 完全等价
- `v` 是字符串增量，同样追加到当前活跃 Fragment
- DeepSeek 在同一个流中会**混用**两种增量帧格式，规律不明确
- **错误处理方式**：把无 `p` 帧当作"正文"，导致思考内容误路由到回复

### 3.5 元数据帧

```json
{ "p": "response/fragments/-1/elapsed_secs", "v": 2.226109195 }
{ "p": "response/status", "v": "WIP" }
```

**关键信息：**
- `p` 指向非 content 路径，`v` 通常是数字或非内容字符串
- 这类帧应直接跳过，不追加到任何累积器
- 需特别注意 `p` 含 `"status"` 的帧（DeepSeek 用来更新状态）

---

## 4. 完整流时序图

```
时间轴  帧类型                            活跃Fragment    thinkingAcc    responseAcc
────────────────────────────────────────────────────────────────────────────────────
t=0    全量快照帧（初始化）               THINK           "好的"         ""
       └─ fragments[0] = {THINK, "好的"}

t=0    增量帧 {p:"response/fragments/-1/content", v:"，"}
                                         THINK           "好的，"       ""

t=0    增量帧 {v:"用户"}                  THINK           "好的，用户"   ""
t=0    增量帧 {v:"只是"}                  THINK           "好的，用户只是" ""
...（大量思考内容增量帧）...

t=2.2  元数据帧 {p:"response/fragments/-1/elapsed_secs", v:2.226}
                                         THINK           "好的，..."    ""   ← 思考结束

t=2.2  全量快照帧（Fragment切换）         RESPONSE        "好的，..."    "你好"
       └─ p:"response/fragments"
       └─ v:[{RESPONSE, "你好"}]

t=2.2  增量帧 {p:"response/fragments/-1/content", v:"！"}
                                         RESPONSE        "好的，..."    "你好！"

t=2.2  增量帧 {v:"👋"}                   RESPONSE        "好的，..."    "你好！👋"
...（大量正文内容增量帧）...

t=N    data: [DONE]                      —               最终思考       最终正文
```

---

## 5. 解析规则（规范定义）

### 5.1 必须维护的状态

```javascript
var pTracker = {
  _currentFragType: 'THINK',  // 当前活跃 Fragment 类型，初始为 THINK
  _resetThinkingLen: undefined, // 快照替换后需重置的 lastLen（下次 fire 用）
  _resetResponseLen: undefined, // 同上
  // ... 其他 p 字段统计（调试用）
};
```

### 5.2 帧路由决策树

```
收到一帧 obj
│
├─ obj.v 是对象或数组？
│  └─ 提取 frags（fragments 列表）
│     ├─ 更新 pTracker._currentFragType = frags最后一项.type
│     ├─ 若有 THINK 内容：thinkingAcc.val = snapThink（全量替换）
│     │  且设置 _resetThinkingLen = 0
│     └─ 若有 RESPONSE 内容：responseAcc.val = snapText（全量替换）
│        且设置 _resetResponseLen = 0
│
└─ obj.v 是字符串？
   ├─ p 含 "status" → 直接跳过（return）
   ├─ p 含 "think" 或 "reason" → thinkingAcc.val += v
   ├─ p === "" 或 p === "response/fragments/-1/content"
   │  或 p === "response/fragments/-1" → 按 _currentFragType 路由
   │  ├─ _currentFragType === "RESPONSE" → responseAcc.val += v
   │  └─ 其他（默认 THINK）           → thinkingAcc.val += v
   └─ 其他明确路径（如 "response/title"）→ responseAcc.val += v
```

### 5.3 lastLen 重置机制

快照帧会用全量内容**替换**（非追加）累积器，导致旧的 `lastLen > acc.val.length`，
从而 `substring(lastLen)` 返回空字符串，内容无法触发 UI 更新。

解决方案：在 `_processSSELine` 里，快照替换累积器时同步设置 `pTracker._resetXLen = 0`；
在下一次 `_fireStreamCallbacks` 里读取并清除这个信号，将 `lastLen` 重置为 0，
确保快照内容被完整地作为新 delta 发射出去。

```javascript
// _processSSELine 里（快照帧处理完毕后）：
if (snapThink && snapThink !== thinkingAcc.val) { pTracker._resetThinkingLen = 0; }
if (snapText  && snapText  !== responseAcc.val)  { pTracker._resetResponseLen = 0; }

// _fireStreamCallbacks 里（计算 delta 前）：
if (pTracker._resetThinkingLen !== undefined) {
  lastThinkingLen = pTracker._resetThinkingLen;
  delete pTracker._resetThinkingLen;
}
if (pTracker._resetResponseLen !== undefined) {
  lastResponseLen = pTracker._resetResponseLen;
  delete pTracker._resetResponseLen;
}
```

---

## 6. 常见陷阱与历史 Bug

### Bug 1：初始快照帧被忽略 → 丢失首批字符

**现象：** 每次对话开头固定丢失 2 个字符（如"好的"、"你好"）  
**原因：** 初始快照帧的 `v` 是对象，代码只处理 `typeof v === 'string'` 的情况，整帧被跳过  
**修复：** 增加对 `v` 为对象/数组时的快照帧解析逻辑

### Bug 2：增量帧无 p 字段 → 思考内容误路由到正文

**现象：** 模型的完整思考过程显示在"回复"区域，"思考"区域为空  
**原因：** 代码遇到无 `p` 字段的帧，直接走 `else` 分支路由到 `responseAcc`  
**修复：** 将 `p === ''`（空字符串，即无 p 字段的情况）纳入"按 `_currentFragType` 路由"分支

### Bug 3：Fragment 切换快照 → 新内容丢失

**现象：** 模型切换到正文阶段后，正文的前几个字符（快照帧的 content）丢失  
**原因1：** 快照帧只更新 `_currentFragType`，但未设置 `_resetResponseLen`，导致 `lastLen=131 > "你好".length=2`，delta 为空  
**原因2：** 旧代码用 `snapText.length > responseAcc.val.length` 条件限制替换，快照内容比已累积内容短时被过滤掉  
**修复：** 快照帧无条件替换累积器，并通过 `_resetXLen = 0` 信号通知 fire 函数从头发射

### Bug 4：pTracker 在 XHR 路径传 null → 状态无法跨帧传递

**现象：** XHR 发起的请求（非 fetch）的响应，Fragment 类型状态每帧丢失  
**原因：** XHR 的 `readystatechange` 回调里调用 `_processSSELine(line, ..., null)`，`null` 无法持久化 `_currentFragType`  
**修复：** 在 XHR send 闭包内创建 `var xhrPTracker = {}`，贯穿整个请求生命周期传入

---

## 7. 其他 p 路径参考

实际观测到的 `p` 字段值（来自日志）：

| p 值 | 含义 | 处理方式 |
|------|------|---------|
| `"response/fragments/-1/content"` | 当前活跃 Fragment 的内容增量 | 按 `_currentFragType` 路由 |
| `"response/fragments"` | Fragment 列表快照（切换信号） | 解析 v 数组，更新活跃类型 |
| `"response/fragments/-1/elapsed_secs"` | 当前 Fragment 耗时 | 跳过 |
| `"response/status"` | 响应状态（WIP/DONE 等） | 跳过（含 "status" 判断） |
| `undefined`（无 p 字段） | 内容增量（等同于 `fragments/-1/content`） | 按 `_currentFragType` 路由 |

---

## 8. 代码位置

- **核心解析函数：** `src/preload/index.js` → `_processSSELine(line, thinkingAcc, responseAcc, pTracker)`
- **回调触发函数：** `src/preload/index.js` → `_fireStreamCallbacks(thinkingAcc, responseAcc, isFinal, lastThinkingLen, lastResponseLen, pTracker)`
- **fetch 路径：** `earlyHookCode` 字符串中的 `window.fetch = async function()` 段
- **XHR 路径：** `earlyHookCode` 字符串中的 `XMLHttpRequest.prototype.send` 段

> ⚠️ 注意：`_processSSELine` 和 `_fireStreamCallbacks` 通过 `.toString()` 序列化后注入页面主环境，  
> 因此它们必须是**纯函数**（无外部变量依赖），所有状态通过参数传递。
