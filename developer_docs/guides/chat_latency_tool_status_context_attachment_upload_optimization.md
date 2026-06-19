# 对话响应速度、工具后空白、图片上下文与上传提示优化方案

## 目标

本文面向当前 SunPilot Chat 的 4 个问题给出开发优化方案，不直接修改代码：

1. 梳理当前对话流程，找出响应较慢、影响对话速度的原因。
2. 修复工具执行到“完成: 搜索 1688 货源 / Found 700 results.” 后，没有后续状态提示、也没有文本内容的问题。
3. 修复上一轮上传过图片，下一轮继续追问时却提示“没有上传图片”的上下文/附件恢复问题。
4. 删除上传图片时对话框里的“上传中”等上传等待提示，不再显示上传文字提示。

## 当前对话流程

### 1. 前端发送阶段

主要代码：

- `packages/web/src/pages/ChatPage/components/ChatComposer.tsx`
- `packages/web/src/pages/ChatPage/hooks/useFileAttachments.ts`
- `packages/web/src/pages/ChatPage/hooks/useOssUpload.ts`
- `packages/web/src/pages/ChatPage/hooks/useChat.ts`
- `packages/web/src/features/chat/ws.ts`

流程：

1. 用户输入文本、添加图片。
2. `useFileAttachments.addFiles()` 立即创建 `UploadFile`，状态为 `uploading`。
3. `useOssUpload.uploadFile()` 请求 presigned URL 并上传 OSS。
4. OSS 不可用时，小图片会走 `FileReader -> dataUrl` fallback。
5. `ChatComposer.handleSend()` 会检查是否仍在上传：
   - 如果 uploading，则设置 queued send，等待上传完成后自动发送。
   - 如果图片缺少 `url/dataUrl`，则标记 failed。
6. `useChat.send()` 插入本地 user message 和 assistant placeholder。
7. `sendChatMessage()` 通过 `/v1/ws` 发送 `chat.send`。

### 2. 后端 fast-ack 阶段

主要代码：

- `packages/api/src/ws/json-rpc-router.ts`
- `packages/core/src/agent/agent.service.ts`

流程：

1. `JsonRpcRouter` 收到 `chat.send`。
2. `AgentService.startChatCommand()` 执行 fast-ack：
   - 检查 conversation 是否存在。
   - 新建 conversation。
   - 新建 run。
   - 保存 user message。
   - 发布 `agent.run.created`。
   - 通过 `queueMicrotask()` 后台执行 Agent Loop。
3. `chat.send` JSON-RPC result 返回 `accepted/conversationId/runId/messageId`。

### 3. Agent Loop 阶段

主要代码：

- `packages/core/src/agent-kernel/agent-loop-engine.ts`
- `packages/core/src/agent-kernel/context/context-builder.ts`
- `packages/core/src/agent-kernel/tools/tool-decision-engine.ts`
- `packages/core/src/agent-kernel/response/response-composer.ts`
- `packages/core/src/agent-kernel/assistant-message-stream.ts`

流程：

1. `AgentLoopEngine.run()` 早发 `agent.message.started`，让前端创建 AI 消息区域。
2. `buildContextAndIntent()`：
   - `ContextBuilder.build()` 拉历史消息、conversation summary、memory、artifact、tool result、skill catalog。
   - `IntentRouter.route()` 做意图识别。
3. `maybeCreatePlan()` 在需要规划时创建 plan。
4. `decideTools()` 做安全门控和工具初筛。
5. `runContentBlockLoop()`：
   - use_tool：进入 `ToolDecisionEngine.executeStreaming()`。
   - no_tool：进入 `ResponseComposer.composeDirect()`。
6. `AssistantMessageStream` 输出：
   - `agent.message.part.started`
   - `agent.message.part.delta`
   - `agent.message.part.updated`
   - `agent.message.completed`

## 响应慢的原因梳理

这里要区分两种慢：

- 首屏反馈慢：用户发送后，AI 区域迟迟没有状态或文字。
- 总完成时间慢：工具执行、模型总结、上下文构建导致最终回答慢。

### A. 首屏反馈慢

#### 1. WS 在发送时才建立

如果 WS 连接不是在用户点击“新对话”时提前建立，而是在 `send()` 时才 `ensureSocket()`，首条消息会等待 WebSocket open 后才能真正 transmit。

优化方向：

- 延续前一份文档里的 `useChat.preconnect()` 方案。
- 点击“新对话”时只预连 WS，不创建 conversation。
- 用户选择历史会话时也可以预连。

#### 2. assistant placeholder 被历史合并影响

首轮新会话会经历：

```text
conversationId="" -> "pending" -> "conv_xxx"
```

这会触发 `useConversations` 拉取 `/messages`。如果合并策略覆盖了本地 assistant placeholder，或让最后一条 active message 不是 assistant，就会出现“AI 区域无提示”。

优化方向：

- 运行中的 assistant placeholder 不能被 `/messages` 覆盖。
- `MessageList` 不要只按最后一条消息判断 active assistant，应找最后一条 `status in ["pending", "streaming"]` 的 assistant。

#### 3. `agent.context.started/completed` 等内部状态没有用户可见映射

当前很多生命周期事件被视为 debug-only，不进入 `AssistantMessage` 的 visible parts。用户看到的就只有工具状态或文本；在上下文构建、意图识别、工具决策期间，如果没有 status part，就会感觉空白。

优化方向：

- 前端可以保留 debug-only，不展示完整内部事件。
- 但 UI 层必须有统一“AI 正在准备上下文/分析需求/选择工具”的轻量状态，不依赖 debug event。

### B. 总完成时间慢

#### 1. ContextBuilder 工作较重

`ContextBuilder.build()` 当前会做：

- 拉最多 100 条历史消息。
- 查询 conversation summary。
- stale summary 检测。
- memory hybrid search。
- memory pure vector recall。
- list artifacts。
- list tool results。
- list skills。
- token 压缩与预算裁剪。

这些都在进入模型调用前发生，会影响首个模型 token 时间。

优化方向：

- 将首屏状态与 ContextBuilder 解耦，先让 UI 出现 assistant placeholder。
- 给 ContextBuilder 各子阶段打耗时指标：
  - `history_fetch_ms`
  - `summary_search_ms`
  - `stale_detect_ms`
  - `memory_hybrid_ms`
  - `memory_vector_ms`
  - `skill_catalog_ms`
  - `budget_ms`
- 对 memory vector recall 设置短超时，超时后用 hybrid 结果继续。
- 对短对话/无复杂关键词的请求跳过 pure vector recall。

#### 2. 工具候选检索与全工具 fallback

`ToolDecisionEngine.retrieveStreamingTools()` 在 retriever 失败或空结果时，会 fallback 到所有 enabled skills，并且后续 `buildStreamingToolDefinitions()` 最多给模型 20 个工具。

影响：

- 工具 schema 变多，LLM 首轮 function calling 输入变大。
- 模型选择工具更慢。

优化方向：

- retriever 空结果不要直接全量 fallback，改为基于 intent/category 的小集合 fallback。
- 对 1688 场景直接锁定 `product.source.search1688` 及少量相关工具。
- 给 tool retrieval 增加耗时与候选数量日志。

#### 3. 工具执行后还要再跑一轮 LLM 总结

1688 搜索流程中，工具执行完成后，`injectStreamingToolResults()` 把 tool result 注入消息，然后 while loop 进入下一轮 `streamLlmTurn()`，让模型总结结果。

如果这轮 LLM 慢、失败、没有输出，用户就会卡在“完成: 搜索 1688 货源 / Found 700 results.”。

优化方向：

- 工具完成后立即显示“正在整理搜索结果...” status。
- 如果工具结果足够结构化，应先生成 deterministic summary 或 rich card，再等 LLM 精修。
- 给工具后总结设置短超时与兜底文本。

#### 4. 记忆写入在完成前执行

`runContentBlockLoop()` 在 `stream.complete()` 前执行 `writeMemories()`。如果记忆写入慢，会推迟 `agent.message.completed`，用户会感觉最终收尾慢。

优化方向：

- 将 memory write 改为 completion 后后台任务。
- 不让 memory write 阻塞最终 message completed。
- 失败只记录 debug/audit，不影响用户回复完成。

## 问题二：工具完成后无状态提示、无文本

### 当前现象

截图中已有：

```text
完成: 搜索 1688 货源
搜索 1688 货源
Found 700 results.
```

之后没有继续输出推荐文本、状态或兜底说明。

### 可能根因

1. 工具已完成，status part 被标记 completed。
2. 工具结果通过 `tool_result` part 展示了 summary。
3. 代码随后进入下一轮 `streamLlmTurn()` 让 LLM 总结工具结果。
4. 这期间没有新的 running status part，所以 UI 看起来停住。
5. 如果下一轮 LLM 没产生 text delta，`fullContent` 可能只有工具前 preface 或为空，最终用户看不到有效正文。
6. 如果工具返回 700 results，但 summary 只有一句 `Found 700 results.`，模型缺少具体 TopN 结构，也很难总结。

### P0 修复方案

#### 1. 工具完成后立即插入“整理结果”状态

在 `executeToolCalls()` 返回后、下一轮 `streamLlmTurn()` 前：

```ts
const summarizeStatus = stream.startStatus({
  label: "正在整理搜索结果...",
  metadata: { phase: "running" }
});
```

当下一轮 LLM 开始输出 text delta 时：

```ts
stream.updateStatus(summarizeStatus.id, {
  status: "completed",
  label: "已整理搜索结果"
});
```

如果 LLM 失败或超时：

```ts
stream.updateStatus(summarizeStatus.id, {
  status: "failed",
  label: "整理结果失败"
});
stream.addError({ message: "搜索已完成，但结果整理失败。你可以要求我重新整理或筛选。", recoverable: true });
```

#### 2. 工具结果后必须有 deterministic fallback 文本

对 1688 搜索这类结构化工具，不能完全依赖 LLM 总结。工具完成后至少应写入一段兜底 text part：

```text
已在 1688 匹配到 700 条相似货源。我可以继续按销量、价格、发货地或供应商资质筛选。你也可以直接让我展示 TOP5/TOP20。
```

如果用户当前请求就是“展示 TOP5”，兜底应该尝试从 structured result 直接渲染 Top5；如果 structured result 没有 Top5 明细，就明确说明：

```text
当前工具只返回了结果数量，没有返回可展示的 TOP5 明细。需要让搜索工具返回候选商品列表字段后才能展示。
```

#### 3. 1688 工具结果必须结构化

`summary: "Found 700 results."` 不够。工具应返回：

```ts
{
  total: 700,
  items: [
    {
      title,
      price,
      sales30d,
      supplier,
      location,
      url,
      imageUrl
    }
  ],
  sort: "sales_desc",
  filters: {...}
}
```

然后：

- Markdown 正文总结结论。
- Rich card/table 展示 TopN。
- tool_result summary 保留短句，但 structured 数据进入 card builder。

#### 4. 前端空白保护

`AssistantMessage` 需要处理：

- 有 completed status/tool_result，但没有 text content。
- 当前 run 仍 pending/streaming。

这时显示：

```text
正在整理结果...
```

不要只在 `hasContent` 或 text part 存在时才显示 AI 反馈。

## 问题三：上一轮上传图片，下一轮说没上传图片

### 直接原因

`AgentService.assertUsableImageAttachments()` 在进入 Agent Loop 前执行，它只检查当前请求 `input.attachments`：

```ts
const imageAttachments = (input.attachments ?? []).filter(isImageAttachment);
if (imageAttachments.length === 0) throw IMAGE_ATTACHMENT_REQUIRED;
```

这意味着：

- 上一轮用户上传了图片。
- 图片已经保存到上一条 user message metadata.attachments。
- 下一轮用户说“展示 TOP5 高销量货源的具体信息”。
- 当前请求没有新 attachments。
- 外层校验直接报“需要上传商品图片”。
- 代码根本不会进入 `ContextBuilder` 和 `ToolArgumentBuilder`，因此历史附件恢复逻辑没有机会执行。

这不是单纯“记忆”问题，而是入口校验位置过早、只看当前消息。

### 现有历史附件恢复能力

当前代码已有几处历史附件支持：

- `PostgresMessageRepository.create()` 会把 attachments 写入 `metadata.attachments`。
- `RepositoryAgentConversationStore.listMessages()` 会从 metadata 恢复 attachments。
- `ContextBuilder` 会把 history message attachments 放进 `context.messages[].metadata.attachments`。
- `DefaultToolArgumentBuilder` 会从 `context.messages[].metadata.attachments` 收集 `historicalAttachments`。

所以核心问题是：入口校验阻断了这条路径。

### P0 修复方案

#### 1. 移除或改造 AgentService 的当前附件硬校验

不要在 `AgentService.startChatCommand()` / `handleChatCommand()` 里只根据当前请求附件判断 1688 是否可执行。

建议改为：

- AgentService 只校验“如果当前请求带了 image attachment，则必须可用”。
- 不再因为当前请求没有附件就直接拒绝。
- 是否缺少图片，交给 Agent Loop 内部的 `ToolArgumentBuilder` 在拿到历史上下文后判断。

#### 2. 在 ToolArgumentBuilder 中明确使用最近图片

当前 `DefaultToolArgumentBuilder` 已收集历史附件，但还需要策略化：

- 当前消息附件优先。
- 最近一条历史 user image attachment 次之。
- 不使用太旧或跨主题图片。
- 只在当前消息语义是“继续/展示/筛选/这个相机/刚才那张图”等延续关系时使用历史图片。

建议增加：

```ts
resolveImageAttachmentForTool(context, skill) {
  if (context.currentMessage.attachments has image) return current;
  if (messageIsContinuation(context.currentMessage.content)) return latestHistoricalImage;
  return undefined;
}
```

#### 3. ContextBuilder 不应丢弃含附件的最近历史消息

含附件的 user message 对多轮图片任务非常重要。建议：

- 最近 N 条含 image attachment 的 user messages 设置更高优先级。
- 不被 conversation summary 覆盖掉。
- 即使原始文本很短，也保留 metadata.attachments。

策略：

```text
conversation_history_with_attachment priority = 5
normal conversation_history priority = 10
```

#### 4. conversation summary 需要记录附件锚点

如果历史消息被摘要覆盖，摘要需要保留附件引用：

```json
{
  "attachments": [
    {
      "messageId": "msg_xxx",
      "id": "upload_xxx",
      "type": "image/png",
      "url": "...",
      "dataUrl": "...",
      "storageKey": "..."
    }
  ]
}
```

`ContextBuilder` 在使用 summary 时，也要把这些 attachment anchors 转成可用上下文。

### P1 修复方案：对话级附件缓存

除了依赖历史消息，还可以维护 conversation-level attachment cache：

- key: `conversationId`
- value: 最近可用 image attachments
- 更新时机：用户发送带附件消息后
- 使用时机：当前消息无附件但工具需要图片时
- 过期策略：按消息数量或时间，例如 30 分钟/20 轮

这样 1688/搜图类工具不用每次都扫描全部历史。

## 问题四：删除上传图片时的“上传中”提示

### 当前提示来源

1. `ChatComposer.tsx`
   - `chat-composer__upload-status`
   - 文案：
     - `附件上传完成后将自动发送`
     - `上传中...`
     - `附件上传失败，点击重试`
2. `ChatComposer.tsx`
   - `statusLabel`
   - 文案：
     - `上传中 ${uploadProgress}%...`
     - `上传中...`
     - `附件上传完成后将自动发送...`
3. `AttachmentPreview.tsx`
   - 图片上传中显示 spinner 占位。
   - 文件上传中显示 loading icon。

### 需求解释

用户要求“对话框中的‘上传中’提示都删掉，不需要提示，不用加上传等待的提示”。

建议理解为：

- 删除文字提示。
- 不显示上传等待状态文案。
- 不因为上传中展示额外状态条。
- 但后台上传逻辑、发送 gate、失败保护仍保留。

### P0 修改方案

#### 1. 删除 ChatComposer 里的 upload status 文案区

移除或不渲染：

```tsx
{uploading && (
  <div className="chat-composer__upload-status">...</div>
)}
```

同时 `statusLabel` 不再返回 uploading/queued 文案：

```ts
case "uploading": return undefined;
```

#### 2. queued send 不显示“附件上传完成后将自动发送”

如果用户上传未完成就点击发送：

- 内部仍可 `setQueuedSend(true)`。
- 不显示等待提示。
- 发送按钮可以 disabled 或保持当前设计。

#### 3. 失败提示是否保留

建议保留失败提示，但不要叫“上传中”：

- 如果图片最终没有 `url/dataUrl/storageKey`，发送时用普通错误卡提示。
- 不在 composer 内显示上传进度。

如果要完全无上传提示，则失败也可以只在发送时统一报错。

#### 4. 附件预览 spinner 是否保留

如果严格理解“上传中提示都删掉”，可移除图片卡片里的 spinner，改为立即显示本地 preview：

- `useFileAttachments.addFiles()` 创建 entry 时同步生成 `thumbUrl` 或 preview dataUrl。
- `AttachmentPreview` 始终显示图片缩略图。
- 上传状态仅作为内部字段，不渲染文字。

这样用户只看到图片已经在输入框里，不看到“上传中”。

## 推荐实施顺序

### P0：修复会阻断业务的问题

1. 改造 `AgentService.assertUsableImageAttachments()`：不要因当前请求无附件直接拒绝 1688/搜图类后续追问。
2. 确保 `ToolArgumentBuilder` 能从最近历史 user image attachment 生成 `imageUrl/imageDataUrl/attachments`。
3. 工具完成后加入“正在整理结果...” status。
4. 工具后 LLM 总结失败/无输出时写入 deterministic fallback 文本。
5. 删除 composer 内所有“上传中/附件上传完成后将自动发送”文字提示。

### P1：提升速度与可感知反馈

1. 点击新对话时 WS preconnect。
2. ContextBuilder 子阶段耗时埋点。
3. memory vector recall 设置短超时。
4. skill catalog 与 tool definitions 缓存。
5. tool retriever 不再 fallback 到全部 enabled tools。
6. memory write 从 `stream.complete()` 前移到后台。

### P2：结构化结果与上下文长期稳定

1. 1688 工具返回 `items[]` 结构化结果。
2. RichCardBuilder 支持 1688 table/gallery card。
3. conversation summary 存附件 anchors。
4. conversation-level attachment cache。
5. 增加多轮图片追问测试。

## 验证清单

### 响应速度

1. 新会话首发后 100ms 内出现 user bubble 和 assistant pending。
2. WS 已预连接时，`chat.send` 不等待 socket open。
3. trace 中能看到：
   - context build 耗时
   - memory search 耗时
   - tool retrieval 耗时
   - LLM first token 耗时
   - tool execution 耗时
   - post-tool summary 耗时

### 工具后空白

1. 上传图片搜索 1688。
2. 出现 `完成: 搜索 1688 货源` 后，立即出现 `正在整理搜索结果...`。
3. 如果 LLM 正常，输出 Markdown 总结和 TopN。
4. 如果 LLM 无输出，仍出现 deterministic fallback。
5. 页面不再停留在只有 `Found 700 results.` 的状态。

### 历史图片上下文

1. 第一轮上传图片并搜索。
2. 第二轮不上传图片，发送“展示 TOP5 高销量货源的具体信息”。
3. 后端不应报 `IMAGE_ATTACHMENT_REQUIRED`。
4. ToolArgumentBuilder 应从历史消息附件恢复 image reference。
5. 1688 工具收到 imageUrl/imageDataUrl 或 attachments。

### 上传提示删除

1. 上传图片时，composer 不显示“上传中...”。
2. 不显示“上传中 50%...”。
3. 不显示“附件上传完成后将自动发送”。
4. 图片仍能正常预览。
5. 发送时仍不会把缺少可用引用的图片发给后端。

## 自动化测试建议

### Core

- `AgentService`
  - 当前请求无附件，但历史消息有 image attachment 时，不应在外层校验拒绝。
  - 当前请求带 image attachment 但缺少 `url/dataUrl/storageKey` 时，仍应拒绝。
- `ContextBuilder`
  - 含附件历史消息不会被摘要完全吞掉。
  - `context.messages[].metadata.attachments` 保留。
- `ToolArgumentBuilder`
  - 当前消息无附件时，能从最近历史 image attachment 填充 image args。
  - 非延续语义不误用很旧图片。
- `ToolDecisionEngine`
  - 工具完成后发出“整理结果”status。
  - post-tool LLM 无输出时写 fallback text。

### Web

- `ChatComposer`
  - uploading 时不渲染“上传中”文字。
  - queued send 时不渲染等待文案。
  - 上传完成后仍能调用 `onSend`。
- `AssistantMessage`
  - completed tool_result 后、text 为空且 run 未完成时显示“正在整理结果”。
- `MessageList`
  - active assistant 不依赖最后一条消息。

## 最终完成标准

完成后应达到：

- 用户发送后首屏反馈稳定，不再因为 context/tool/WS 阶段空白。
- 1688 搜索工具完成后，不会停在 `Found 700 results.`，一定有整理状态或兜底文本。
- 多轮图片任务能复用上一轮上传图片，不会错误提示“请先上传图片”。
- 对话框不再显示上传等待文案，上传过程更安静。
- 响应速度瓶颈可通过 trace/metrics 定位，而不是只能从 UI 体感猜测。
