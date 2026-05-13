# Agent 上下文管理方案

## 背景

DS Agent 每次 `send()` 都会点击"开启新会话"，把完整上下文作为一条自包含消息发送给 DeepSeek。随着对话增长，如果把全部历史消息都发过去，会出现两个问题：

1. **Token 浪费**：很早之前的中间工具结果、推理过程没必要每次都发
2. **超长截断**：超过 DeepSeek 上下文窗口后，最前面的内容会被截掉，可能正好截掉关键信息

## 方案：ContextManager

在 `ConversationManager`（存全量）和 `DeepSeekClient`（发送）之间加一层 **ContextManager**，负责从全量历史中**筛选出最优上下文子集**。

```
ConversationManager          ContextManager           DeepSeekClient
(全量历史)        →          (筛选+压缩)      →       (发送)
                              ├─ 保留原始任务
                              ├─ 保留最近 N 轮
                              ├─ 截断过长工具结果
                              └─ Token 预算控制
```

## 核心策略：分层保留 + Token 预算

参考 pi-agent、opencode 等开源项目，采用分层保留策略：

```
┌──────────────────────────────────────────────┐
│  Layer 1: 系统提示词（必留，不计入预算）       │
├──────────────────────────────────────────────┤
│  Layer 2: 原始任务（第一条用户消息，必留）      │
├──────────────────────────────────────────────┤
│  Layer 3: 最近 N 轮对话（user+assistant+tool） │
│           从最新往前数，直到 token 预算用完      │
├──────────────────────────────────────────────┤
│  Layer 4: 更早的消息（如果预算还有剩余）        │
│           工具结果超过阈值则截断                │
└──────────────────────────────────────────────┘
```

### 优先级规则

| 优先级 | 内容 | 处理方式 |
|--------|------|---------|
| P0 | 系统提示词 | 始终保留，单独计算 token |
| P1 | 第一条用户消息（原始任务） | 始终保留，防止 AI 忘记目标 |
| P2 | 最近 N 个 user-assistant-tool 轮次 | 从最新往前取，直到预算用完 |
| P3 | 更早的工具结果 | 超过 2000 字符的截断，保留头尾 |
| P4 | 更早的对话 | 预算不够就丢弃 |

### 工具结果截断

超过 `maxToolResultLength` 的工具结果会被截断，保留前 60% 和后 40%：

```
[前 60% 内容]

... [中间省略 N 字符] ...

[后 40% 内容]
```

## 配置项

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maxTokens` | 200000 | 上下文 token 总预算（不含系统提示词），DeepSeek 支持 1M |
| `minRecentExchanges` | 5 | 最少保留最近几轮完整对话 |
| `maxToolResultLength` | 8000 | 单个工具结果最大字符数（超过则截断） |
| `keepFirstUserMessage` | true | 是否始终保留第一条用户消息 |
| `charsPerToken` | 2 | 字符/token 估算比例（混合中英文取保守值） |

## Token 估算

不引入额外依赖，用简单规则估算：

```javascript
function estimateTokens(text) {
  // 中文约 1.5 字符/token，英文约 4 字符/token
  // 混合场景取保守值 2 字符/token
  return Math.ceil(text.length / 2);
}
```

## 数据流

```diff
// agent.js sendUserMessage() 中：
- const messages = conversationManager.getMessages();
- const fullResponse = await deepseekClient.send(messages, systemPrompt);

+ const allMessages = conversationManager.getMessages();
+ const ctx = contextManager.buildContext(allMessages, systemPrompt);
+ const fullResponse = await deepseekClient.send(ctx.messages, systemPrompt);
```

`ConversationManager` 仍然保存全量历史（用于本地持久化和会话恢复），`ContextManager` 只负责每次发送前筛选子集。

## 文件结构

| 文件 | 说明 |
|------|------|
| `src/renderer/context/ContextManager.js` | 核心上下文管理逻辑 |
| `src/preload/index.js` | 注入 ContextManager |
| `src/renderer/agent.js` | sendUserMessage() 和 agent loop 中接入 |

## 扩展性

- 可通过 `contextManager.setConfig(key, value)` 动态调整参数
- 配置通过 `config:set` IPC 持久化，下次启动自动加载
- 后续可扩展为更智能的摘要/压缩策略（如对旧消息做 LLM 摘要）
