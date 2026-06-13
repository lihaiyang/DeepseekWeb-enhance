# DS2API 工具调用完整实现指南

> 面向：想基于 DeepSeek Chat API 实现可靠工具调用（tool call）的开发者。
> 本文档基于 DS2API 的实际实现整理，覆盖所有标签定义、prompt 注入机制、消息交互流程、防幻觉策略、流式检测和重试机制。

---

## 目录

1. [整体架构概览](#1-整体架构概览)
2. [所有标签和标记定义](#2-所有标签和标记定义)
3. [Prompt 拼装完整流程](#3-prompt-拼装完整流程)
4. [消息标准化：用户消息、Agent 消息、工具结果的注入方式](#4-消息标准化用户消息agent-消息工具结果的注入方式)
5. [工具 Schema 注入：从 API tools 到 prompt 文本](#5-工具-schema-注入从-api-tools-到-prompt-文本)
6. [DSML 工具调用格式规范](#6-dsml-工具调用格式规范)
7. [DSML 标签归一化与容错机制](#7-dsml-标签归一化与容错机制)
8. [流式 Tool Sieve：实时检测与防泄漏](#8-流式-tool-sieve实时检测与防泄漏)
9. [输出侧：拦截、校验与空输出重试](#9-输出侧拦截校验与空输出重试)
10. [Output Integrity Guard：防幻觉顶层约束](#10-output-integrity-guard防幻觉顶层约束)
11. [一个完整的多轮交互示例](#11-一个完整的多轮交互示例)
12. [自实现清单](#12-自实现清单)

---

## 1. 整体架构概览

### 1.1 核心设计思想

DS2API 不把 `tools` 作为原生结构化 schema 直接下发给下游模型，而是**把工具能力、历史工具调用、工具结果全部压缩成 prompt 中的可见文本**。下游模型只收到一个纯文本 prompt + 文件引用 + 控制位。

### 1.2 请求处理主链路

```
客户端 API 请求（OpenAI/Claude/Gemini）
  │
  ├─ 1. 协议入口层：解析请求，提取 messages、tools、model
  │     ├─ OpenAI Chat:    internal/httpapi/openai/chat/
  │     ├─ OpenAI Responses: internal/httpapi/openai/responses/
  │     ├─ Claude:         internal/httpapi/claude/
  │     └─ Gemini:         internal/httpapi/gemini/
  │
  ├─ 2. 请求标准化层 (promptcompat)：统一为 StandardRequest
  │     └─ internal/promptcompat/request_normalize.go
  │
  ├─ 3. 消息标准化层：各协议消息 → 统一内部消息序列
  │     ├─ OpenAI: promptcompat/message_normalize.go
  │     ├─ Claude: internal/httpapi/claude/handler_utils.go
  │     └─ Gemini: internal/httpapi/gemini/convert_messages.go
  │
  ├─ 4. Tool Prompt 注入：tools → system prompt 文本
  │     └─ internal/promptcompat/tool_prompt.go
  │
  ├─ 5. Thinking Injection：最新 user 消息追加思考增强
  │     └─ internal/httpapi/openai/shared/thinking_injection.go
  │
  ├─ 6. Output Integrity Guard 前置
  │     └─ internal/prompt/messages.go: prependOutputIntegrityGuard()
  │
  ├─ 7. DeepSeek 风格 prompt 拼装：角色标记拼接
  │     └─ internal/prompt/messages.go: MessagesPrepareWithThinking()
  │
  ├─ 8. Current Input File（可选）：历史过长时拆分为文件
  │     └─ internal/httpapi/openai/history/current_input_file.go
  │
  ├─ 9. Completion Payload 组装：发送给 DeepSeek API
  │     └─ 最终 payload: { prompt, ref_file_ids, thinking_enabled, search_enabled }
  │
  ├─ 10. 输出处理
  │     ├─ 流式: 实时 SSE → tool sieve 分离工具调用/文本
  │     ├─ 非流式: 收集完整输出 → parse tool calls
  │     ├─ Empty Output Retry: 无输出时自动重试
  │     └─ assistantturn: 统一语义 → 各协议渲染
  │
  └─ 11. 协议渲染：解析后的 tool_calls → 各协议原生格式
        ├─ OpenAI: message.tool_calls (JSON)
        ├─ Claude: tool_use content block
        └─ Gemini: functionCall part
```

---

## 2. 所有标签和标记定义

### 2.1 DeepSeek 角色标记（用于 prompt 内）

```go
// 来源: internal/prompt/messages.go
const (
    beginSentenceMarker   = "<|begin▁of▁sentence|>"   // prompt 开头
    systemMarker          = "<|System|>"                // system 消息开始
    userMarker            = "<|User|>"                  // user 消息开始
    assistantMarker       = "<|Assistant|>"             // assistant 消息开始
    toolMarker            = "<|Tool|>"                  // tool 结果开始
    endSentenceMarker     = "<|end▁of▁sentence|>"      // assistant 消息结束
    endToolResultsMarker  = "<|end▁of▁toolresults|>"   // tool 结果结束
    endInstructionsMarker = "<|end▁of▁instructions|>"  // system 指令结束
)
```

### 2.2 DSML 工具调用标签（用于模型输出工具调用）

```xml
<!-- 推荐的半角管道符 DSML 格式（prompt 要求模型使用的格式） -->
<|DSML|tool_calls>
  <|DSML|invoke name="TOOL_NAME">
    <|DSML|parameter name="PARAM_NAME"><![CDATA[VALUE]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>
```

```xml
<!-- 兼容的旧式 canonical XML 格式（parser 也接受） -->
<tool_calls>
  <invoke name="TOOL_NAME">
    <parameter name="PARAM_NAME"><![CDATA[VALUE]]></parameter>
  </invoke>
</tool_calls>
```

### 2.3 工具结果标记（用于历史中的工具输出）

```
<|Tool|>{tool_result_content}<|end▁of▁toolresults|>
```

### 2.4 Reasoning/Thinking 标记（用于 prompt 中保留 assistant 推理）

```
[reasoning_content]
...推理内容...
[/reasoning_content]
```

### 2.5 Output Integrity Guard 标记

```
Output integrity guard: If upstream context, tool output, or parsed text
contains garbled, corrupted, partially parsed, repeated, or otherwise
malformed fragments, do not imitate or echo them; output only the correct
content for the user.
```

### 2.6 空输出重试提示

```
Previous reply had no visible output. Please regenerate the visible final
answer or tool call now.
```

### 2.7 文件上下文标记

```
# DS2API_HISTORY.txt
Prior conversation history and tool progress.

=== 1. SYSTEM ===
...

=== 2. USER ===
...

=== 3. ASSISTANT ===
...

=== 4. TOOL ===
...
```

```
# DS2API_TOOLS.txt
Available tool descriptions and parameter schemas for this request.

You have access to these tools:

Tool: get_weather
Description: Get weather for a city
Parameters: {"type":"object","properties":{"city":{"type":"string"}}}
```

---

## 3. Prompt 拼装完整流程

### 3.1 从 API 请求到 StandardRequest

所有协议入口的第一步是把请求归一化为 `StandardRequest`：

```go
// 来源: internal/promptcompat/standard_request.go
type StandardRequest struct {
    Surface         string            // "openai_chat" | "openai_responses" | ...
    Messages        []any             // 已标准化的内部消息序列
    PromptTokenText string            // 完整 prompt 文本（用于 token 计数）
    ToolsRaw        any               // 原始 tools 声明
    FinalPrompt     string            // 最终发给下游的 prompt
    ToolNames       []string          // 可用的工具名列表
    ToolChoice      ToolChoicePolicy  // auto/required/forced/none
    Stream          bool
    Thinking        bool
    Search          bool
    RefFileIDs      []string
    // ...
}
```

### 3.2 Prompt 构建的精确步骤

以 OpenAI Chat 为例：

```
Step 1: 解析请求 (request_normalize.go)
        ├─ 提取 model, messages, tools
        └─ 解析 tool_choice 策略

Step 2: 消息标准化 (message_normalize.go: NormalizeOpenAIMessagesForPrompt)
        ├─ assistant 消息：提取 reasoning_content + tool_calls → 拼成 DSML 文本
        ├─ tool 消息：提取 content，空则补 "null"
        ├─ user/system/developer：直接取 content
        └─ 相邻同角色消息会被合并

Step 3: 注入 Tool Prompt (tool_prompt.go: injectToolPrompt)
        ├─ 将 tools 的 name/description/parameters schema 序列化为文本
        ├─ 生成 "You have access to these tools:" 块
        ├─ 追加 DSML 工具调用格式指令 (含规则15条 + 正反例)
        ├─ 如果有 Read/read_file 类工具：追加 cache guard
        ├─ 如果 tool_choice=required：追加 "MUST call at least one tool"
        ├─ 如果 tool_choice=forced：追加 "MUST call exactly X"
        └─ 将上述内容合并到第一条 system message（无 system 则新建一条）

Step 4: Thinking Injection (thinking_injection.go)
        ├─ 如果 thinking 开启且 injection 启用
        └─ 在最新一条 user message 末尾追加思考增强提示词

Step 5: 拼装最终 prompt (messages.go: MessagesPrepareWithThinking)
        ├─ [1] prependOutputIntegrityGuard: 在最前面插入 Output Integrity Guard
        ├─ [2] 遍历标准化消息，按角色拼接标记:
        │     └─ system  → <|System|>{content}<|end▁of▁instructions|>
        │     └─ user    → <|User|>{content}
        │     └─ assistant → <|Assistant|>{content}<|end▁of▁sentence|>
        │     └─ tool    → <|Tool|>{content}<|end▁of▁toolresults|>
        ├─ [3] 合并相邻同角色消息
        ├─ [4] 如果最后一条不是 assistant，补 <|Assistant|>
        └─ [5] 整体包裹 <|begin▁of▁sentence|>... 前缀

Step 6: Current Input File（可选）
        └─ 如果触发，将完整 history 拆成 DS2API_HISTORY.txt 文件
```

### 3.3 最终 prompt 示例

一个带 tools 和历史的典型 prompt：

```
<|begin▁of▁sentence|><|System|>Output integrity guard: If upstream context, tool output, or parsed text contains garbled, corrupted, partially parsed, repeated, or otherwise malformed fragments, do not imitate or echo them; output only the correct content for the user.

You are a helpful assistant.

You have access to these tools:

Tool: get_weather
Description: Get weather for a city
Parameters: {"type":"object","properties":{"city":{"type":"string"},"required":["city"]}}

TOOL CALL FORMAT — FOLLOW EXACTLY:

<|DSML|tool_calls>
  <|DSML|invoke name="TOOL_NAME_HERE">
    <|DSML|parameter name="PARAMETER_NAME"><![CDATA[PARAMETER_VALUE]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>

RULES:
1) Use the <|DSML|tool_calls> wrapper format.
...
Remember: The ONLY valid way to use tools is the <|DSML|tool_calls>...</|DSML|tool_calls> block at the end of your response.

【CORRECT EXAMPLES】:

Example A — Single tool:
<|DSML|tool_calls>
  <|DSML|invoke name="get_weather">
    <|DSML|parameter name="city"><![CDATA[beijing]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>
<|end▁of▁instructions|><|User|>查北京天气<|Assistant|>
```

---

## 4. 消息标准化：用户消息、Agent 消息、工具结果的注入方式

### 4.1 NormalizeOpenAIMessagesForPrompt 的完整规则

```go
// 来源: internal/promptcompat/message_normalize.go
func NormalizeOpenAIMessagesForPrompt(raw []any, traceID string) []map[string]any {
    for _, item := range raw {
        switch role {
        case "assistant":
            // 1. 提取 reasoning_content
            // 2. 提取 tool_calls → 渲染为 DSML XML 文本
            // 3. 如果 content 是完整 DSML/XML 工具块但没有 tool_calls 字段
            //    → 先解析成结构化工具调用，再重渲染为规范 DSML
            // 4. 拼装：[reasoning_content]...[/reasoning_content] + content + DSML XML
        case "tool", "function":
            // 提取 content，空则补 "null"
        case "user", "system", "developer":
            // 直接取 content
        }
    }
}
```

### 4.2 如何处理用户消息

```go
// user 消息直接保留 content，然后在 prompt 拼装时包裹 <|User|> 标记
case "user":
    out = append(out, map[string]any{
        "role":    "user",
        "content": NormalizeOpenAIContentForPrompt(msg["content"]),
    })

// 最终在 prompt 中变为:
// <|User|>{用户原始文本}<|Assistant|>
```

### 4.3 如何处理 Agent（assistant）消息

assistant 消息标准化是最复杂的，因为需要同时处理 reasoning、普通文本、和工具调用：

```go
func buildAssistantContentForPrompt(msg map[string]any) string {
    // 1. 提取普通 content
    content := NormalizeOpenAIContentForPrompt(msg["content"])

    // 2. 提取 reasoning_content（支持 string 和 Claude-style 数组）
    reasoning := normalizeOpenAIReasoningContentForPrompt(msg["reasoning_content"])

    // 3. 将 tool_calls 渲染为 DSML XML
    toolHistory := prompt.FormatToolCallsForPrompt(msg["tool_calls"])

    // 4. 如果没有结构化 tool_calls 字段，
    //    但 content 本身是完整 DSML/XML 工具块
    //    → 解析后重新格式化为标准 DSML
    if toolHistory == "" {
        content = normalizeAssistantToolMarkupContentForPrompt(content)
    }

    // 5. 拼装: reasoning + content + tool_history
    parts := []string{}
    if reasoning != "" {
        parts = append(parts, "[reasoning_content]\n"+reasoning+"\n[/reasoning_content]")
    }
    if content != "" {
        parts = append(parts, content)
    }
    if toolHistory != "" {
        parts = append(parts, toolHistory)
    }
    return strings.Join(parts, "\n\n")
}
```

最终 assistant 在 prompt 中的形态：

```
<|Assistant|>[reasoning_content]
我需要先调用 get_weather 获取北京的天气信息
[/reasoning_content]

<|DSML|tool_calls>
  <|DSML|invoke name="get_weather">
    <|DSML|parameter name="city"><![CDATA[beijing]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls><|end▁of▁sentence|>
```

### 4.4 如何处理工具结果（tool result）

```go
// tool 消息的 content 直接作为文本保留
// 空 content 补 "null" 防止整个 turn 丢失
func buildToolContentForPrompt(msg map[string]any) string {
    content := NormalizeOpenAIContentForPrompt(msg["content"])
    if strings.TrimSpace(content) == "" {
        return "null"
    }
    return content
}
```

最终 tool 结果在 prompt 中的形态：

```
<|Tool|>{"temp": 18, "condition": "sunny"}<|end▁of▁toolresults|>
```

### 4.5 相邻同角色消息合并

```go
// 相邻同 role 的消息会被合并成一个块，中间插入 "\n\n"
for _, msg := range processed {
    if len(merged) > 0 && merged[len(merged)-1].Role == msg.Role {
        merged[len(merged)-1].Text += "\n\n" + msg.Text  // 合并
        continue
    }
    merged = append(merged, msg)
}
```

这意味着连续的 system 消息会被合并为一段，连续的 user 消息也会被合并。

### 4.6 末尾自动补 Assistant 标记

```go
// 如果最后一条消息不是 assistant，自动补 <|Assistant|>
if lastRole != "assistant" {
    parts = append(parts, assistantMarker)  // "<|Assistant|>"
}
```

这样模型就知道该它说话了。

---

## 5. 工具 Schema 注入：从 API tools 到 prompt 文本

### 5.1 注入流程

```go
// 来源: internal/promptcompat/tool_prompt.go
func injectToolPrompt(messages []map[string]any, tools []any, policy ToolChoicePolicy) []map[string]any {
    // 1. 遍历 tools，对每个 tool 提取 name, description, parameters schema
    // 2. 序列化为: "Tool: {name}\nDescription: {desc}\nParameters: {schema_json}"
    // 3. 用 "\n\n" 拼接所有 tool 的描述
    // 4. 拼上 "You have access to these tools:\n\n" 前缀
    // 5. 追加 DSML 工具调用格式指令（规则 + 正反例）
    // 6. 如果 tool_choice 是 required/forced，追加相应指令
    // 7. 如果有 read_file 类工具，追加 cache guard
    // 8. 将上述整体注入到第一条 system message 中
    
    // 注入方式：如果有 system message，追加到其 content 后面
    for i := range messages {
        if messages[i]["role"] == "system" {
            messages[i]["content"] = old_content + "\n\n" + toolPrompt
            return messages
        }
    }
    // 如果没有 system message，新建一条 system message 并放在最前面
    messages = append([]map[string]any{{"role": "system", "content": toolPrompt}}, messages...)
}
```

### 5.2 注入到 System prompt 的具体内容结构

注入后 system prompt 包含：

```
{原始 system/developer 内容}

You have access to these tools:

Tool: get_weather
Description: Get weather for a city
Parameters: {"type":"object","properties":{"city":{"type":"string"},"required":["city"]}}

Tool: search_files
Description: Search for files
Parameters: {"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}

TOOL CALL FORMAT — FOLLOW EXACTLY:

<|DSML|tool_calls>
  <|DSML|invoke name="TOOL_NAME_HERE">
    <|DSML|parameter name="PARAMETER_NAME"><![CDATA[PARAMETER_VALUE]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>

RULES: (15 条规则)

PARAMETER SHAPES:
- string => <|DSML|parameter name="x"><![CDATA[value]]></|DSML|parameter>
- object => <|DSML|parameter name="x"><field>...</field></|DSML|parameter>
- array => <|DSML|parameter name="x"><item>...</item><item>...</item></|DSML|parameter>
- number/bool/null => <|DSML|parameter name="x">plain_text</|DSML|parameter>

【WRONG — Do NOT do these】: (4 种错误示例)

【CORRECT EXAMPLES】:
(根据实际工具名动态生成)

Read-tool cache guard: If a Read/read_file-style tool result says ... (如有读文件工具)

7) For this response, you MUST call at least one tool from the allowed list. (如 required)
```

### 5.3 Current Input File 模式下的工具注入

当触发 `current_input_file`（上下文过长时拆分），工具描述会被单独上传为 `DS2API_TOOLS.txt` 文件，live prompt 中只保留格式指令 + 指针：

```
Available tool descriptions and parameter schemas are attached in
DS2API_TOOLS.txt. Treat DS2API_TOOLS.txt as the authoritative list
of callable tools and schemas; use only tools and parameters listed there.

TOOL CALL FORMAT — FOLLOW EXACTLY:
...
```

---

## 6. DSML 工具调用格式规范

### 6.1 Prompt 中教给模型的规则（共 15 条）

```go
// 来源: internal/toolcall/tool_prompt.go
func BuildToolCallInstructions(toolNames []string) string {
    return `TOOL CALL FORMAT — FOLLOW EXACTLY:

<|DSML|tool_calls>
  <|DSML|invoke name="TOOL_NAME_HERE">
    <|DSML|parameter name="PARAMETER_NAME"><![CDATA[PARAMETER_VALUE]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>

RULES:
1)  Use the <|DSML|tool_calls> wrapper format.
2)  Put one or more <|DSML|invoke> entries under a single <|DSML|tool_calls> root.
3)  Put the tool name in the invoke name attribute: <|DSML|invoke name="TOOL_NAME">.
3a) Tag punctuation alphabet: ASCII < > / = " plus the halfwidth pipe |.
4)  All string values must use <![CDATA[...]]>, even short ones.
5)  Every top-level argument must be a <|DSML|parameter name="ARG_NAME">...</|DSML|parameter> node.
6)  Objects use nested XML elements. Arrays may repeat <item> children.
7)  Numbers, booleans, and null stay plain text.
8)  Use only the parameter names in the tool schema. Do not invent fields.
9)  Fill parameters with actual values. Do not emit placeholder/blank/whitespace-only parameters.
10) If a required parameter value is unknown, ask the user or answer normally instead.
11) For shell tools (Bash/execute_command), command must be inside the command parameter. Never empty.
12) Do NOT wrap XML in markdown fences. Do NOT output explanations, role markers, or internal monologue.
13) First non-whitespace characters of the tool block must be exactly <|DSML|tool_calls>.
14) Never omit the opening <|DSML|tool_calls> tag.
15) Runtime also accepts legacy <tool_calls> / <invoke> / <parameter>, but prefer DSML form.

PARAMETER SHAPES:
- string => <![CDATA[value]]>
- object => <field>...</field>
- array  => <item>...</item>
- number/bool/null => plain_text

【WRONG — Do NOT do these】:
Wrong 1 — mixed text after XML
Wrong 2 — Markdown code fences
Wrong 3 — missing opening wrapper
Wrong 4 — empty parameters

Remember: The ONLY valid way to use tools is the <|DSML|tool_calls> block
at the end of your response.`
}
```

### 6.2 动态生成的正例

根据实际可用工具名动态生成 4 类示例：

| 示例类型 | 说明 |
|---------|------|
| Example A — Single tool | 单工具调用 |
| Example B — Two tools in parallel | 并行调用两个工具 |
| Example C — Nested XML parameters | 嵌套参数（如 MultiEdit、ask_followup_question） |
| Example D — Long script with CDATA | 长脚本参数（如 Bash 命令） |

具体工具名会根据以下规则匹配：
- `Read` / `read_file` → 文件读取
- `Bash` / `execute_command` → shell 命令
- `Write` / `write_to_file` → 文件写入
- `Glob` / `list_files` / `search_files` → 文件搜索
- `MultiEdit` → 多文件编辑
- `Task` / `ask_followup_question` → 对话类工具

如果当前可用工具不匹配任何已知类型，对应示例会自动省略。

---

## 7. DSML 标签归一化与容错机制

### 7.1 归一化的目标

模型实际输出可能因为 tokenizer 噪声、Unicode 推理偏差等产生各种格式变异。归一化层将这些变异统一映射回标准 XML 标签。

### 7.2 归一化流程

```go
// 来源: internal/toolcall/toolcalls_dsml.go
func normalizeDSMLToolCallMarkup(text string) (string, bool) {
    // Step 1: candidate-span canonicalization
    //   对已识别为工具标签壳的区域做窄 canonicalization
    //   - 折叠 confusable 字符（零宽、BOM、控制类）
    //   - 将 < > / | = 引号、Unicode 空白、dash/underscore 变体
    //     统一回 ASCII 语义
    //   - 不影响参数内容、普通正文、Markdown code span
    //
    canonicalized := canonicalizeToolCallCandidateSpans(text)

    // Step 2: 检测是否包含 DSML 或 canonical 标记
    hasDSML, hasCanonical := ContainsToolMarkupSyntaxOutsideIgnored(canonicalized)
    if !hasDSML && !hasCanonical {
        return canonicalized, true  // 无工具标记，直接返回
    }

    // Step 3: 标签重写
    //   以固定本地标签名 tool_calls/invoke/parameter 为准
    //   剥离标签名前的协议前缀壳（DSML、vendor名等）
    //   清理标签名后的非结构性分隔符
    //
    return rewriteDSMLToolMarkupOutsideIgnored(canonicalized), true
}
```

### 7.3 容错的标签变体列表

以下变体都会被归一化回 `<tool_calls>` / `<invoke>` / `<parameter>`：

| 类别 | 输入变体 | 归一化后 |
|------|---------|---------|
| 标准 DSML | `<\|DSML\|tool_calls>` | `<tool_calls>` |
| 管道符漏写 | `<DSML\|tool_calls>` | `<tool_calls>` |
| 空格分隔 | `<\|DSML tool_calls>` | `<tool_calls>` |
| 标签名粘连 | `<DSMLtool_calls>` | `<tool_calls>` |
| 多前导 | `<<\|DSML\|tool_calls>` | `<tool_calls>` |
| 多层前缀 | `<<DSML\|DSML\|tool_calls>` | `<tool_calls>` |
| 短横线 | `<dsml-tool-calls>` | `<tool_calls>` |
| 下划线 | `<dsml_tool_calls>` | `<tool_calls>` |
| PascalCase | `<DSmartToolCalls>` | `<tool_calls>` |
| 控制符 | `<DSML␂tool_calls>` | `<tool_calls>` |
| STX 原始符 | `<DSML\x02tool_calls>` | `<tool_calls>` |
| 任意前缀 | `<proto💥tool_calls>` | `<tool_calls>` |
| 全角感叹号 | `<！DSML！tool_calls>` | `<tool_calls>` |
| 顿号 | `<、DSML、tool_calls>` | `<tool_calls>` |
| CJK 尖括号 | `<DSM\|tool_calls>...〈/DSM\|tool_calls〉` | `<tool_calls>...</tool_calls>` |
| 弯引号属性 | `<DSM\|parameter name="command"\|>〈！[CDATA[...]]〉〈/DSM\|parameter〉` | `<parameter name="command"><![CDATA[...]]></parameter>` |
| 尾部分隔符 | `<DSMLtool_calls※>` | `<tool_calls>` |
| 实体分隔符 | `<\|DSML\|tool_calls\|>` | `<tool_calls>` |
| 全角 ASCII | `<ｄＳＭＬ\|tool_calls＞` | `<tool_calls>` |
| CDATA 开头漂移 | `<！[CDATA[` / `<、[CDATA[` | `<![CDATA[` |
| vendor 前缀 | `<vendor\|tool_calls>` | `<tool_calls>` |

**重要**: 只有标签名精确为 `tool_calls` / `invoke` / `parameter` 的会被归一化。`tool_calls_extra` / `ToolCallsExtra` 等扩展名不会命中，按普通文本处理。

### 7.4 缺失 Opening Wrapper 的窄修复

当模型输出了 `</tool_calls>` 结尾但漏了开头的 `<tool_calls>` 时：

```go
// 来源: internal/toolcall/toolcalls_parse_markup.go
func repairMissingXMLToolCallsOpeningWrapper(text string) string {
    // 1. 检查是否已经有完整的 opening tag → 有则跳过修复
    // 2. 找到第一个 <invoke name="..."> 
    // 3. 找到最后一个 </tool_calls>
    // 4. 如果 invoke 在 close 之前 → 补回 <tool_calls> 开头
    // 修复条件：wrapper-confidence 必须足够高
    //   - scanner 已识别出白名单工具壳结构
    //   - 剩余失败只是壳层结构问题
    //   - 不在白名单内的 near-miss 标签不会被修复
}
```

---

## 8. 流式 Tool Sieve：实时检测与防泄漏

### 8.1 工作原理

```javascript
// 来源: internal/js/helpers/stream-tool-sieve/sieve.js
function processToolSieveChunk(state, chunk, toolNames) {
    // state 维护以下关键状态:
    //   pending: 待处理文本缓冲
    //   capture: 疑似工具调用的捕获缓冲
    //   capturing: 是否处于捕获模式
    //   pendingToolCalls: 已解析完成待发送的工具调用

    // 主循环:
    while (true) {
        // 1. 如果有待发送的工具调用 → 输出 tool_calls 事件
        // 2. 如果在捕获模式 → 消费工具调用缓冲区
        // 3. 在 pending 中查找工具调用起始标记
        //    - 找到 → 切到捕获模式
        //    - 找不到 → 安全释放文本
    }
}
```

### 8.2 关键行为

- **Markdown 代码块防护**: 反引号围栏和波浪线围栏内的 XML 不触发捕获
- **嵌套围栏支持**: 4 反引号嵌套 3 反引号也正确识别
- **已确认的工具调用不会回流到 content**: 防止重复/混杂
- **不完整工具块保守缓冲**: 等待更多 chunk 到达，不半途截断
- **Malformed 完整 wrapper 作为文本释放**: 不吞内容也不伪造工具调用

### 8.3 流式收尾 fallback

流式结束时，如果正文为空但 thinking 中包含可执行工具调用 → 补发为结构化 tool_calls。如果客户端未开启 thinking，思维链只用于检测，不暴露为可见内容。

---

## 9. 输出侧：拦截、校验与空输出重试

### 9.1 Tool Choice 策略校验

```go
// 来源: internal/assistantturn/turn.go
func ValidateTurn(turn Turn, policy ToolChoicePolicy) *OutputError {
    // 1. tool_choice=required 但没有工具调用 → 422 tool_choice_violation
    if policy.IsRequired() && len(turn.ToolCalls) == 0 {
        return &OutputError{Status: 422, Message: "tool_choice requires at least one valid tool call."}
    }
    // 2. 有工具调用 → 通过
    if len(turn.ToolCalls) > 0 {
        return nil
    }
    // 3. 有可见文本 → 通过
    if turn.Text != "" {
        return nil
    }
    // 4. 空输出 → content_filter / upstream_empty_output / upstream_unavailable
}
```

### 9.2 Tool Choice 四种模式

| 模式 | 行为 |
|------|------|
| `auto` | 模型可以调用也可以不调用 |
| `none` | 完全禁用工具（不注入 tool prompt） |
| `required` | 必须至少调用一个工具，否则 422 |
| `forced` | 必须调用指定工具名，prompt 中指令 `"MUST call exactly this tool name: X"` |

### 9.3 检测到工具调用后的输出处理

```go
// 检测到 tool_calls 时的关键操作:
// 1. finish_reason 设为 "tool_calls"
// 2. message.content 设为 null（OpenAI）/ 不输出文本块（Claude）
// 3. tool_calls 按协议原生格式渲染
//    - OpenAI: { "tool_calls": [{ "id": "...", "function": { "name": "...", "arguments": "..." } }] }
//    - Claude: { "content": [{ "type": "tool_use", "name": "...", "input": {...} }] }
//    - Gemini: { "parts": [{ "functionCall": { "name": "...", "args": {...} } }] }
```

### 9.4 空输出重试机制

```go
// 来源: internal/assistantturn/turn.go
func ShouldRetryEmptyOutput(turn Turn, attempts, maxAttempts int) bool {
    return attempts < maxAttempts &&     // 最多 1 次
        !turn.ContentFilter &&           // 非 content_filter
        len(turn.ToolCalls) == 0 &&      // 没有工具调用
        turn.Text == ""                  // 没有可见文本
}
```

重试流程：

```
1. 第一次请求 → 模型返回思考链但无可见文本
2. 追加 prompt 后缀: "Previous reply had no visible output.
   Please regenerate the visible final answer or tool call now."
3. 设置 parent_message_id = 第一次的 response_message_id
   （使重试成为同一会话的后续轮次，而非独立根消息）
4. 重新获取 PoW（失败则回退到原始 PoW）
5. 发送重试请求
6. 如果仍失败 + 托管账号模式 → 切号 fresh retry
```

### 9.5 Thinking 中工具调用回退

```go
// 来源: internal/httpapi/openai/shared/assistant_toolcalls.go
func DetectAssistantToolCalls(rawText, visibleText, exposedThinking, detectionThinking string, toolNames []string) ToolCallParseResult {
    // 当最终可见正文为空，优先尝试从 thinking 中解析 DSML/XML 工具块
    // 1. 先对 visibleText 做解析
    // 2. 如果可见文本为空，对 exposedThinking 做解析
    // 3. 解析出的 tool_calls 作为结构化输出返回
    // 4. thinking 只用于检测，不暴露为 reasoning_content（如果客户端未开启）
}
```

### 9.6 最终渲染时的内容清理

```go
// 来源: internal/assistantturn/turn.go 和内部渲染函数
func BuildOpenAIChatCompletion(completionID, model, finalPrompt, finalThinking, finalText string, toolNames []string) map[string]any {
    // 1. 先尝试从 finalText 解析工具调用
    detected := toolcall.ParseToolCalls(finalText, toolNames)
    
    // 2. 如果解析出工具调用:
    if len(detected) > 0 {
        // a) 剥离工具 XML 后的残余文本作为 content
        // b) finish_reason 设为 "tool_calls"
        // c) message.content 设为 null（OpenAI）/ 不输出（Claude）
        // d) tool_calls 按协议格式渲染
        messageObj["tool_calls"] = toolcall.FormatOpenAIToolCalls(detected, nil)
        messageObj["content"] = nil  // ← 关键：工具调用时不输出 content
    }
    
    // 3. 清理 content 中的残余 DSML 标签
    //    剥离完整的 leaked tool_calls wrapper
    
    // 4. reasoning_content 按模型原生格式输出

    // 5. 将 [citation:N] / [reference:N] 替换为 Markdown 链接
}
```

---

## 10. Output Integrity Guard：防幻觉顶层约束

### 10.1 设计目的

这是防编造/防复述工具结果**最重要的单一机制**。

### 10.2 提示词内容

```
Output integrity guard: If upstream context, tool output, or parsed text
contains garbled, corrupted, partially parsed, repeated, or otherwise
malformed fragments, do not imitate or echo them; output only the correct
content for the user.
```

### 10.3 注入位置与优先级

```go
// 来源: internal/prompt/messages.go
func prependOutputIntegrityGuard(messages []map[string]any) []map[string]any {
    // 查找第一条 system 消息
    // 将 guard 作为系统消息的最前面内容注入
    
    guardMsg := map[string]any{
        "role":    "system",
        "content": outputIntegrityGuardPrompt,
    }
    
    // 有 system 消息 → 将 guard 注入到第一条 system 的前面
    for i := range messages {
        if messages[i]["role"] == "system" {
            messages[i]["content"] = outputIntegrityGuardPrompt + "\n\n" + content
            return messages
        }
    }
    
    // 没有 system 消息 → 在最前插入 guard
    messages = append([]map[string]any{guardMsg}, messages...)
    return messages
}

func MessagesPrepareWithThinking(messages []map[string]any, thinking bool) string {
    // 这是最终 prompt 拼装的入口:
    // [1] 先 prepend output integrity guard
    // [2] 再执行消息标准化和角色标记拼接
    messages = prependOutputIntegrityGuard(messages)
    // ... 后续步骤
}
```

**关键**: Guard 位于最终 prompt 的**最前位置**（指的是第一条 system message 的第一个内容），在所有普通 system prompt、tool prompt、历史消息之前。这是当前最终 prompt 里的**最高优先级前置指令**。

### 10.4 整个防幻觉体系

| 机制 | 作用 | 层级 |
|------|------|------|
| **Output Integrity Guard** | 顶层禁止模仿/回显畸形内容 | **最高优先级 system 指令** |
| **工具历史可见化** | 将历史 tool_calls 以 DSML 文本注入 prompt，模型能看到已执行的工具 | prompt |
| **Malformed 内容自动修复** | 将 malformed assistant tool 块解析后重渲染为标准 DSML | 消息标准化 |
| **Tool 结果显式隔离** | 使用 `<\|Tool\|>...<\|end▁of▁toolresults\|>` 包裹，与模型言论严格区分 | prompt 标记 |
| **空 tool result 补 null** | 空结果补 `"null"` 防止 turn 消失 | 消息标准化 |
| **Read-tool cache guard** | 读文件工具空结果时禁止编造/重复调用 | tool prompt |
| **content=null** | 调用工具时禁止同时输出文本 | 输出侧 |
| **空输出重试** | 无可见输出时主动让模型重试 | 运行时 |

---

## 11. 一个完整的多轮交互示例

### 11.1 客户端发送的 API 请求

```json
{
  "model": "deepseek-chat",
  "messages": [
    {"role": "system", "content": "你是一个天气助手"},
    {"role": "user", "content": "查一下北京天气"},
    {"role": "assistant", "content": null, "tool_calls": [
      {"id": "call_1", "type": "function", "function": {"name": "get_weather", "arguments": "{\"city\":\"beijing\"}"}}
    ]},
    {"role": "tool", "tool_call_id": "call_1", "content": "{\"temp\":18,\"condition\":\"sunny\"}"},
    {"role": "user", "content": "再查一下上海"}
  ],
  "tools": [
    {"type": "function", "function": {"name": "get_weather", "description": "Get weather for a city", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}
  ]
}
```

### 11.2 消息标准化后的内部表示

```
消息 0: { role: "system", content: "你是一个天气助手" }
消息 1: { role: "user",    content: "查一下北京天气" }
消息 2: { role: "assistant", multipart:
           - [reasoning_content] 空
           - content: 空
           - tool_calls: DSML XML }
消息 3: { role: "tool",    content: "{\"temp\":18,\"condition\":\"sunny\"}" }
消息 4: { role: "user",    content: "再查一下上海" }
```

### 11.3 Tool Prompt 注入后的消息

```
消息 0: { role: "system", content: "你是一个天气助手

You have access to these tools:

Tool: get_weather
Description: Get weather for a city
Parameters: {"type":"object","properties":...}

TOOL CALL FORMAT — FOLLOW EXACTLY:
(15 条规则 + 正反例)" }

消息 1: { role: "user", content: "查一下北京天气" }
消息 2: { role: "assistant", content: "<|DSML|tool_calls>..." }
消息 3: { role: "tool", content: "{\"temp\":18,\"condition\":\"sunny\"}" }
消息 4: { role: "user", content: "再查一下上海" }
```

### 11.4 Thinking Injection 追加后的消息

```
消息 0: { role: "system", ... } (同上)
消息 1: { role: "user", content: "查一下北京天气" }
消息 2: { role: "assistant", content: "<|DSML|tool_calls>..." }
消息 3: { role: "tool", content: "..." }
消息 4: { role: "user", content: "再查一下上海\n\nReasoning Effort: Absolute maximum with no shortcuts permitted. ..." }
```

### 11.5 最终拼装成的完整 prompt

```
<|begin▁of▁sentence|><|System|>Output integrity guard: If upstream context, tool output, or parsed text contains garbled, corrupted, partially parsed, repeated, or otherwise malformed fragments, do not imitate or echo them; output only the correct content for the user.

你是一个天气助手

---

You have access to these tools:

Tool: get_weather
Description: Get weather for a city
Parameters: {"type":"object","properties":{"city":{"type":"string"},"required":["city"]}}

TOOL CALL FORMAT — FOLLOW EXACTLY:

<|DSML|tool_calls>
  <|DSML|invoke name="TOOL_NAME_HERE">
    <|DSML|parameter name="PARAMETER_NAME"><![CDATA[PARAMETER_VALUE]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>

RULES:
1) Use the <|DSML|tool_calls> wrapper format.
...

【CORRECT EXAMPLES】:

Example A — Single tool:
<|DSML|tool_calls>
  <|DSML|invoke name="get_weather">
    <|DSML|parameter name="city"><![CDATA[beijing]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>
<|end▁of▁instructions|><|User|>查一下北京天气

<|Assistant|><|DSML|tool_calls>
  <|DSML|invoke name="get_weather">
    <|DSML|parameter name="city"><![CDATA[beijing]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls><|end▁of▁sentence|><|Tool|>{"temp":18,"condition":"sunny"}<|end▁of▁toolresults|><|User|>再查一下上海

Reasoning Effort: Absolute maximum with no shortcuts permitted.
...<|Assistant|>
```

### 11.6 下游返回 & 渲染回客户端

```
模型输出:
思考: 需要调用 get_weather 查询上海天气
正文: <|DSML|tool_calls><|DSML|invoke name="get_weather"><|DSML|parameter name="city"><![CDATA[shanghai]]></|DSML|parameter></|DSML|invoke></|DSML|tool_calls>

解析后 → OpenAI Chat 渲染:
{
  "choices": [{
    "finish_reason": "tool_calls",
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_abc",
        "type": "function",
        "function": {
          "name": "get_weather",
          "arguments": "{\"city\":\"shanghai\"}"
        }
      }]
    }
  }]
}
```

---

## 12. 自实现清单

如果你要基于 DeepSeek API 实现类似机制，以下是逐层检查清单：

### 12.1 Prompt 构建层

- [ ] 实现 DeepSeek 角色标记（`<|System|>` / `<|User|>` / `<|Assistant|>` / `<|Tool|>` 等）
- [ ] 将 API tools schema 序列化为文本并注入 system prompt
- [ ] 实现 DSML 工具调用格式指令（含规则、正反例）
- [ ] 实现 Output Integrity Guard 作为最高优先级 system 前置指令
- [ ] 实现历史 tool_calls → DSML XML 文本 的转换
- [ ] 实现历史 tool result → `<|Tool|>...<|end▁of▁toolresults|>` 的转换
- [ ] 实现 assistant reasoning → `[reasoning_content]...[/reasoning_content]` 的保留
- [ ] 实现相邻同角色消息的合并
- [ ] 实现末尾自动补 `<|Assistant|>`
- [ ] 实现 tool_choice 策略（auto / none / required / forced）
- [ ] 实现 read-tool cache guard（如有读文件工具）

### 12.2 输出解析层

- [ ] 实现 DSML/XML 工具调用解析（提提取 `<tool_calls>` + `<invoke>` + `<parameter>`）
- [ ] 实现 DSML 标签归一化（容错各种格式漂移）
- [ ] 实现缺失 opening wrapper 的窄修复
- [ ] 实现 Markdown 代码块内的工具 XML 不命中
- [ ] 实现 CDATA 保护和空内容处理
- [ ] 实现参数类型智能推断（schema 声明为 string → 自动字符串化）

### 12.3 流式处理层

- [ ] 实现 Tool Sieve：流式实时检测与分离工具调用
- [ ] 实现 Markdown fence 保护（围栏内不捕获工具调用）
- [ ] 实现不完整工具块的保守缓冲
- [ ] 实现 Malformed 完整 wrapper 作为文本释放
- [ ] 实现流式收尾 fallback（thinking 中工具调用补发）

### 12.4 输出控制层

- [ ] 实现检测到 tool_calls 时 content=null
- [ ] 实现 tool_choice 策略校验
- [ ] 实现空输出重试（同会话续对话）
- [ ] 实现切号 fresh retry（如托管账号模式）

### 12.5 其他

- [ ] 实现各协议渲染（OpenAI、Claude、Gemini）
- [ ] 实现上下文 token 计数（基于完整 prompt）
- [ ] 实现超长历史的文件拆分（current_input_file / history_split）
- [ ] 实现 citation/reference 标记的链接化
- [ ] 实现参数类型按 schema 自动字符串化

---

## 附录 A：关键源代码文件索引

| 功能 | 文件路径 |
|------|---------|
| 请求标准化（OpenAI） | `internal/promptcompat/request_normalize.go` |
| 消息标准化（OpenAI） | `internal/promptcompat/message_normalize.go` |
| Tool Prompt 注入 | `internal/promptcompat/tool_prompt.go` |
| DSML 工具调用格式模板 | `internal/toolcall/tool_prompt.go` |
| DSML 归一化 | `internal/toolcall/toolcalls_dsml.go` |
| 工具调用解析 | `internal/toolcall/toolcalls_parse.go` |
| 缺失 wrapper 修复 | `internal/toolcall/toolcalls_parse_markup.go` |
| Tool Sieve 流式检测 | `internal/js/helpers/stream-tool-sieve/sieve.js` |
| Prompt 角色标记拼装 | `internal/prompt/messages.go` |
| 工具调用历史格式化 | `internal/prompt/tool_calls.go` |
| Output Integrity Guard | `internal/prompt/messages.go` (prependOutputIntegrityGuard) |
| Assistant Turn 校验 | `internal/assistantturn/turn.go` |
| 空输出重试 | `internal/assistantturn/turn.go` |
| Reasoning 兼容 | `internal/promptcompat/reasoning.go` |
| Thinking Injection | `internal/promptcompat/thinking_injection.go` |
| 文件引用收集 | `internal/promptcompat/file_refs.go` |
| Current Input File | `internal/httpapi/openai/history/current_input_file.go` |
| Completion Runtime | `internal/completionruntime/nonstream.go` |
| OpenAI 渲染 | `internal/util/render.go` |
| StandardRequest 定义 | `internal/promptcompat/standard_request.go` |
| Claude 标准化 | `internal/httpapi/claude/standard_request.go` |
| Claude handler 工具注入 | `internal/httpapi/claude/handler_utils.go` |
| Gemini 消息转换 | `internal/httpapi/gemini/convert_messages.go` |
| Gemini 工具转换 | `internal/httpapi/gemini/convert_tools.go` |
| 响应式输入归一 | `internal/promptcompat/responses_input_normalize.go` |
| Prompt 构建 | `internal/promptcompat/prompt_build.go` |
| 文档：主兼容链路 | `docs/prompt-compatibility.md` |
| 文档：工具调用语义 | `docs/toolcall-semantics.md` |

---

## 附录 B：15 条 DSML 规则原文

（完整内容见 `internal/toolcall/tool_prompt.go` 中 `BuildToolCallInstructions` 函数）

---

## 附录 C：错误检查清单（Debug 时常见问题）

| 问题 | 排查方向 |
|------|---------|
| 模型不调用工具 | 检查 tool prompt 是否正确注入到 system message；检查 tool_choice 设置 |
| 工具调用格式错误 | 检查模型是否输出了 Markdown fence；检查是否有 opening wrapper 缺失 |
| 工具调用被当作文本 | 检查 DSML 归一化层；检查是否有 Unicode 分隔符漂移 |
| 工具调用泄漏到正文 | 检查 Tool Sieve 是否启用；检查 content=null 设置 |
| 模型编造工具结果 | 检查 Output Integrity Guard 是否正确注入到最前面 |
| 模型重复调用读文件 | 检查 read-tool cache guard 是否注入 |
| 空输出不重试 | 检查 ShouldRetryEmptyOutput 条件；检查 parent_message_id 设置 |
| 参数类型不对 | 检查参数 schema 声明是否准确；检查自动字符串化逻辑 |