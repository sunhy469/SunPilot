# Agent 对话流式、1688 图片参数与旧路径删除修复方案

## 1. 背景与现象

本方案针对当前 Agent 对话链路中的三个高优先级问题：

1. 用户上传图片后调用“搜索 1688 货源”仍然报错：

   ```json
   [{ "code": "custom", "message": "Either imageUrl or imageDataUrl is required", "path": [] }]
   ```

2. 流式响应已经生效，但同一轮对话中会出现两段几乎一模一样的回答，并且两段内容会一起显示。

3. 执行过程先卡顿一段时间，随后一次性刷出大量“搜索 1688 货源”工具调用和相同的缺参错误。

从当前代码看，这不是单个 UI 展示问题，而是以下三类问题叠加：

- 附件引用在前端、AgentService、消息持久化、ContextBuilder、ToolArgumentBuilder、ToolDecisionEngine 之间没有形成单一可靠契约，尤其是 `dataUrl` 在持久化链路中会被丢失。
- 新内容块流式路径和旧 `agent.response.*` / narrative fallback 路径仍然并存，可能导致同一 `messageId` 或同一语义内容被两套路径写入。
- `ToolDecisionEngine.executeStreaming()` 对“缺少必需参数”这类不可执行错误继续把工具暴露给模型下一轮，导致模型反复选择同一个 1688 工具，最终刷屏。

## 2. 当前代码中的关键证据

### 2.1 首轮当前消息依赖 `input.attachments`

`packages/core/src/agent-kernel/context/context-builder.ts` 中，当前消息上下文来自 `AgentLoopInput`：

```ts
currentMessage: {
  id: input.userMessageId,
  content: input.message,
  attachments: input.attachments ?? [],
}
```

这意味着：如果 WebSocket `chat.send` 请求没有携带带 `url` 或 `dataUrl` 的附件，后端当前轮无法从 UI 缩略图补出图片。

### 2.2 用户消息持久化会丢 `dataUrl`

`packages/core/src/agent/agent.service.ts` 中两处用户消息持久化只保存：

```ts
attachments: input.attachments?.map((a) => ({
  id: a.id,
  name: a.name,
  type: a.type,
  sizeBytes: a.sizeBytes,
  url: a.url,
  storageKey: a.storageKey,
}))
```

缺失字段：

- `dataUrl`
- `provider`
- `checksum`

同时 `packages/storage/src/repositories/message.repository.ts` 的 `CreateMessageInput.attachments` 类型也没有 `dataUrl`。结果是：即使首轮 `input.attachments` 有 `dataUrl`，一旦进入历史消息、恢复、重试、二次上下文构建，就会丢失 dataUrl。

### 2.3 前端本地消息也没有保留 `dataUrl`

`packages/web/src/pages/ChatPage/hooks/useChat.ts` 的本地用户消息只渲染：

```ts
attachments: attachments?.map((a) => ({
  id: a.id,
  name: a.name,
  type: a.type,
  sizeBytes: a.sizeBytes,
  url: a.url,
  storageKey: a.storageKey,
}))
```

这会制造一种错觉：UI 能显示用户上传图片，但本地消息对象和服务端持久化消息都不一定保留可供工具执行的 `dataUrl`。

### 2.4 参数构建逻辑本身能填图片，但前提是附件存在

`packages/core/src/agent-kernel/tools/tool-argument-builder.ts` 和 `packages/core/src/agent-kernel/tools/tool-decision-engine.ts` 都已经具备从附件填充：

- `imageUrl`
- `image_url`
- `imageDataUrl`
- `image_data_url`
- `attachments`

因此目前错误更像是附件链路丢失或重试循环中上下文附件为空，而不是“完全没有实现图片参数映射”。

### 2.5 缺参后仍继续工具循环，导致刷屏

`packages/core/src/agent-kernel/tools/tool-decision-engine.ts` 的 `executeStreaming()` 中，工具失败后会：

1. 将失败 summary 注入 `currentMessages`
2. 继续下一轮 LLM turn
3. 下一轮仍然带着同一批 tools
4. 模型再次选择同一个 1688 工具

当前只在 `allFailed && iteration >= 2` 时才强制让模型解释失败。对于“缺 `imageUrl` 或 `imageDataUrl`”这类确定性缺参错误，应该在第一次发现时立即停止工具循环，而不是继续让模型选择工具。

### 2.6 新旧路径并存会制造重复回答

当前仍存在以下兼容/回退路径：

- `agent.message.*` 内容块事件
- `agent.response.*` legacy 事件
- `runContentBlockLoop()`
- `runNarrativeLoop()` fallback
- `ResponseComposer.composeDirect()` 的 stream 模式与非 stream 模式
- 前端 `useChat.ts` 同时处理 `agent.message.*` 和 `agent.response.*`

当模型先输出一段“我将使用图片调用 1688...”文本，随后工具失败触发 fallback 或下一轮模型解释时，用户会看到两段语义重复的内容。即使 messageId 相同，多个 text part 也会被渲染成连续重复段落。

## 3. 结论

这次问题的根因不是单点 bug，而是“附件契约未闭环 + 工具缺参仍执行 + 旧路径未删除”共同导致。

必须把 Agent 对话路径收敛为唯一的新路径：

```text
Web ChatComposer
  -> chat.send attachments
  -> AgentService.startChatCommand
  -> AgentLoopInput.attachments
  -> ContextBuilder.currentMessage.attachments
  -> ToolArgumentBuilder / native function argument merge
  -> ExecutionOrchestrator
  -> AssistantMessageStream content blocks
  -> Web useChat content-block reducer
```

旧路径不再参与用户对话：

```text
agent.response.started
agent.response.delta
agent.response.completed
runNarrativeLoop fallback
composeDirect non-stream assistant persistence
重复的 legacy response 前端 reducer
```

兼容期如果必须保留 legacy 事件，只允许从新内容块事件派生只读调试事件，不允许 legacy 事件再创建、追加或保存 assistant message。

## 4. 修复目标

### P0 目标

1. 用户上传图片后，1688 工具调用必须拿到 `imageUrl` 或 `imageDataUrl`。
2. 如果图片引用不可用，不能执行工具，必须只产生一个澄清/错误内容块。
3. 同一轮 assistant 只能有一个 messageId、一个 active stream、一个最终 `agent.message.completed`。
4. 缺参错误不能触发重复工具调用循环。
5. 删除或下线旧用户对话路径，防止回退到旧实现。

### 非目标

- 不要求保留旧 `agent.response.*` 作为用户可见 UI 数据源。
- 不要求让模型“自己修复”图片参数。图片参数必须由确定性附件契约填充。
- 不要求每次工具失败都进入反思循环。缺参类失败应直接停止。

## 5. 详细修复方案

### 5.1 统一附件协议

将以下类型全部扩展为同一组字段：

- `packages/web/src/features/chat/types.ts`
- `packages/core/src/agent/agent.types.ts`
- `packages/core/src/agent-kernel/loop-types.ts`
- `packages/storage/src/repositories/message.repository.ts`
- `packages/protocol/src/agent-commands.ts`

统一字段：

```ts
interface AttachmentRef {
  id: string;
  name: string;
  type: string;
  sizeBytes?: number;
  url?: string;
  dataUrl?: string;
  storageKey?: string;
  provider?: "aliyun-oss" | "s3" | "minio" | "local";
  checksum?: string;
}
```

任何层级不得丢弃 `dataUrl`。如果因安全或大小限制不保存 `dataUrl`，必须显式转换为后端可读取的 `url` 或 `storageKey`，不能静默丢失。

### 5.2 修复前端发送链路

检查并修改：

- `packages/web/src/features/chat/attachment-utils.ts`
- `packages/web/src/pages/ChatPage/hooks/useFileAttachments.ts`
- `packages/web/src/pages/ChatPage/components/ChatComposer.tsx`
- `packages/web/src/pages/ChatPage/hooks/useChat.ts`

要求：

1. `uploadFileToAttachmentRef()` 必须输出 `dataUrl`。
2. `validateAttachmentsForSend()` 必须检查最终 `AttachmentRef[]`，而不是只检查 antd `UploadFile` 的 UI 状态。
3. `sendChatMessage()` 前增加硬断言：

   ```ts
   const imageAttachments = attachments?.filter(isImageAttachment) ?? [];
   if (imageAttachments.some((a) => !a.url && !a.dataUrl && !a.storageKey)) {
     throw new Error("IMAGE_ATTACHMENT_REF_MISSING");
   }
   ```

4. 本地用户消息显示对象也必须保留 `dataUrl/provider/checksum`，避免本地状态和真实发送状态不一致。
5. 发送后清空附件前，必须确保 `sendChatMessage()` 收到的是不可变快照。

### 5.3 修复 AgentService 持久化链路

修改 `packages/core/src/agent/agent.service.ts` 中所有 `createMessage({ attachments })` 映射，保留完整字段：

```ts
attachments: input.attachments?.map((a) => ({
  id: a.id,
  name: a.name,
  type: a.type,
  sizeBytes: a.sizeBytes,
  url: a.url,
  dataUrl: a.dataUrl,
  storageKey: a.storageKey,
  provider: a.provider,
  checksum: a.checksum,
}))
```

同时修改：

- `packages/core/src/agent/repository-conversation.service.ts`
- `packages/storage/src/repositories/message.repository.ts`
- `packages/storage/src/testing/in-memory-database.context.ts`
- `packages/storage/src/postgres/postgres.conversation.repository.ts`

验收标准：

- 首轮 `input.attachments` 有 `dataUrl` 时，`ContextBuilder.currentMessage.attachments` 有 `dataUrl`。
- 持久化后 `messages.listByConversationId()` 返回的历史消息仍有 `dataUrl`。
- retry/resume 后仍能从历史消息或 run input 中恢复图片引用。

### 5.4 增加 AgentService 入参校验

在 `startChatCommand()` 和 `handleChatCommand()` 入口增加附件完整性校验。

规则：

```ts
function assertUsableImageAttachments(input: {
  message: string;
  attachments?: AttachmentRef[];
}) {
  const asksImageSearch =
    /1688|货源|同款|搜图|图片|相机|商品/i.test(input.message);

  if (!asksImageSearch) return;

  const imageAttachments = (input.attachments ?? []).filter(isImageAttachment);
  if (imageAttachments.length === 0) {
    throw new AgentInputError("IMAGE_ATTACHMENT_REQUIRED");
  }

  const usable = imageAttachments.some(
    (a) => Boolean(a.url || a.dataUrl || a.storageKey),
  );
  if (!usable) {
    throw new AgentInputError("IMAGE_ATTACHMENT_REF_MISSING");
  }
}
```

如果校验失败：

- 不创建 tool call。
- 不进入 LLM 工具循环。
- 直接发一个 `agent.message.completed`，内容是让用户重新上传或等待上传完成。
- UI 只显示一条错误说明，不显示工具调用失败刷屏。

### 5.5 强化 ToolArgumentBuilder 的 anyOf 处理

当前已有 `checkAnyOfUnsatisfied()`，但它在 `ToolDecisionEngine` 内部也有一份实现。建议：

1. 把 anyOf/oneOf 校验抽成一个共享函数：

   ```text
   packages/core/src/agent-kernel/tools/tool-schema-utils.ts
   ```

2. `DefaultToolArgumentBuilder.findMissingRequired()` 和 `ToolDecisionEngine.executeToolCalls()` 统一调用。

3. 对 1688 schema 的错误信息生成友好 missing key：

   ```text
   imageUrl|imageDataUrl
   ```

   而不是空字符串或底层 zod custom error。

### 5.6 缺参必须停止工具循环

修改 `ToolDecisionEngine.executeStreaming()` / `executeToolCalls()` 的契约。

新增内部状态：

```ts
type ToolLoopStopReason =
  | "missing_required_arguments"
  | "schema_validation_failed"
  | "permission_denied"
  | "all_tools_failed"
  | "max_iterations";
```

当 `executeToolCalls()` 发现以下错误时：

- `TOOL_ARGUMENT_MISSING`
- `Either imageUrl or imageDataUrl is required`
- `schema_validation_failed`
- `IMAGE_ATTACHMENT_REF_MISSING`

必须返回：

```ts
{
  artifacts: [],
  summaries: [failedSummary],
  stop: {
    reason: "missing_required_arguments",
    message: "缺少可用图片引用，不能调用 1688 货源搜索。"
  }
}
```

`executeStreaming()` 收到 `stop` 后：

1. 不再把 tools 传给下一轮模型。
2. 不再让模型重新选择同一个工具。
3. 只追加一个 error part 或 clarification text part。
4. 立即退出循环。

伪代码：

```ts
const toolResults = await this.executeToolCalls(...);

if (toolResults.stop?.reason === "missing_required_arguments") {
  stream?.addError({
    code: "TOOL_ARGUMENT_MISSING",
    message: toolResults.stop.message,
    recoverable: true,
  });
  break;
}
```

### 5.7 删除旧路径和 fallback

必须删除或彻底下线以下用户可见路径：

#### 删除 `agent.response.*` 对 UI 的写入能力

前端 `useChat.ts` 中：

- 删除 `agent.response.started` 创建 assistant message 的逻辑。
- 删除 `agent.response.delta` 追加 assistant content 的逻辑。
- 删除 `agent.response.completed` 修改 assistant message 的逻辑。

保留方式：

- 如果后端仍临时发 `agent.response.*`，前端只记录到 debug event trace，不再影响 `messages`。

#### 删除 `AssistantMessageStream.start()` 的 legacy emit

当前 `AssistantMessageStream.start()` 会同时 emit：

- `agent.message.started`
- `agent.response.started`

应改为只 emit：

```text
agent.message.started
```

兼容期如果必须有 legacy event，应由 debug adapter 独立生成，不得进入主 WebSocket UI reducer。

#### 删除 `runNarrativeLoop()` fallback

`AgentLoopEngine.runContentBlockLoop()` catch 中当前会 fallback 到 `runNarrativeLoop()`。这会造成重复 preface、重复工具状态、重复后置总结。

要求：

- 删除 `runNarrativeLoop()`。
- `executeStreaming()` 如果模型不支持 native function calling，应在 model provider capability 层提前判断，走同一个 content-block direct answer 或明确报错，而不是进入旧执行/反思/回答路径。
- 工具执行失败不应该通过 fallback 重新执行同一 tool call。

#### 删除旧 `composeDirect` 非 stream 用户路径

`ResponseComposer.composeDirect()` 的非 stream 模式只可用于测试或 CLI 兼容，不得用于 Web Agent 用户对话。

AgentLoopEngine 中所有用户可见回答必须传入：

```ts
stream: { stream, textPartId }
```

### 5.8 单一消息生命周期

每个 run 只允许一个 assistant `messageId`。

生命周期：

```text
agent.message.started
agent.message.part.started
agent.message.part.delta*
agent.message.part.updated*
agent.message.completed
agent.run.completed
```

禁止：

- 同一 run 产生两个 assistant messageId。
- 同一 text part 中重复写入同一 preface。
- `agent.message.completed` 后再追加 delta。
- legacy response event 再创建第二条 assistant message。

建议在 `useChat.ts` 中维护：

```ts
activeAssistantByRunId: Map<runId, messageId>
completedMessageIds: Set<messageId>
seenPartDeltaKeys: Set<messageId:partId:offsetOrSeq>
```

其中 delta 去重不能只按字符串内容去重，因为正常文本可能重复；应由服务端提供 part-local sequence 或 offset。短期可以只保证同一 `messageId + partId` 的状态机不会在 completed 后继续 append。

### 5.9 工具调用去重与熔断

在 `ToolDecisionEngine.executeStreaming()` 中增加同一 run 的工具调用签名去重：

```ts
const signature = `${skillId}:${stableJson(finalArgs)}`;
if (seenToolCallSignatures.has(signature)) {
  stream?.addError({
    code: "DUPLICATE_TOOL_CALL_BLOCKED",
    message: "已阻止重复工具调用。",
    recoverable: true,
  });
  break;
}
seenToolCallSignatures.add(signature);
```

对于 1688 缺参场景，签名会是同一个空参数或缺图片参数的调用，应第一次就阻断。

### 5.10 1688 工具参数合同

为 1688 skill 明确输入合同：

```ts
type Search1688Input =
  | { imageUrl: string; query?: string }
  | { imageDataUrl: string; query?: string };
```

执行前必须满足：

```ts
Boolean(args.imageUrl || args.imageDataUrl)
```

不允许只传：

- `attachments`
- `url`
- `image_url`
- `image_data_url`

在进入 skill runner 前统一 canonicalize：

```ts
if (!args.imageUrl && args.image_url) args.imageUrl = args.image_url;
if (!args.imageDataUrl && args.image_data_url) args.imageDataUrl = args.image_data_url;
if (!args.imageUrl && args.url && isImageUrl(args.url)) args.imageUrl = args.url;
```

最终传给 skill 的参数至少包含 canonical 字段之一。

## 6. 推荐落地顺序

### 第 1 步：先堵住参数缺失执行

目标：不再刷屏。

修改点：

- `AgentService.startChatCommand()`
- `AgentService.handleChatCommand()`
- `ToolDecisionEngine.executeToolCalls()`
- `ToolDecisionEngine.executeStreaming()`

验收：

- 图片搜索请求无可用图片引用时，不调用 1688 工具。
- UI 只显示一条“图片尚未上传完成/缺少图片引用”的错误块。
- 不出现多次 `失败: 搜索 1688 货源`。

### 第 2 步：修复附件全链路保真

目标：有图时 1688 一定拿到 `imageUrl` 或 `imageDataUrl`。

修改点：

- 前端 AttachmentRef
- AgentService createMessage
- MessageRepository 类型
- RepositoryConversationService
- Postgres/InMemory message repository
- ContextBuilder 历史附件恢复

验收：

- 首轮上传 OSS URL 成功：tool args 有 `imageUrl`。
- 首轮 OSS URL 失败但小图 dataUrl 成功：tool args 有 `imageDataUrl`。
- 重新打开会话后再次基于历史图片搜索：tool args 仍有图片引用。

### 第 3 步：删除旧响应路径

目标：不再重复回答。

修改点：

- `AssistantMessageStream.start()`
- `AgentLoopEngine.runContentBlockLoop()`
- 删除 `runNarrativeLoop()`
- `useChat.ts` 删除 legacy response 对 messages 的写入
- 相关测试改成 `agent.message.*`

验收：

- 同一 run 只有一个 assistant message。
- 同一回答不会出现两个相同 preface。
- `agent.response.*` 即使存在，也不会改变 UI message state。

### 第 4 步：增加回归测试

新增测试建议：

1. `packages/core/src/agent-kernel/tools/tool-argument-builder.test.ts`

   - image url attachment -> `imageUrl`
   - image dataUrl attachment -> `imageDataUrl`
   - historical attachment with dataUrl -> `imageDataUrl`
   - no usable image -> missing `imageUrl|imageDataUrl`

2. `packages/core/src/agent-kernel/tools/tool-decision-engine.test.ts`

   - 1688 缺图不执行工具，返回 clarification/error。
   - 1688 dataUrl-only 图片可执行。
   - 同一缺参工具不会在 streaming loop 中重复调用。

3. `packages/web/src/App.test.tsx`

   - 只收到 `agent.message.*` 时逐字/逐块显示。
   - 同时收到 legacy `agent.response.delta` 时不重复追加。
   - `agent.message.completed` 后再到的 delta 被忽略。

4. `packages/daemon/src/json-rpc-router.test.ts`

   - `agent.message.part.delta` 不降级。
   - `agent.response.delta` 不再作为主 UI 消息事件。

## 7. 验收清单

### 7.1 1688 图片搜索

- [ ] 上传图片后点击发送，WebSocket `chat.send.params.attachments[0]` 包含 `url` 或 `dataUrl`。
- [ ] `AgentLoopInput.attachments[0]` 包含同样字段。
- [ ] `ContextBuilder.currentMessage.attachments[0]` 包含同样字段。
- [ ] `ToolArgumentBuilderResult.arguments` 包含 `imageUrl` 或 `imageDataUrl`。
- [ ] `ExecutionOrchestrator` 收到的 `plannedCall.arguments` 包含 canonical 字段。
- [ ] 不再出现 `Either imageUrl or imageDataUrl is required`。

### 7.2 缺图保护

- [ ] 图片上传未完成时点击发送，只进入 queued 状态，不进入 agent run。
- [ ] 图片上传失败且无法生成 dataUrl 时，前端阻止发送。
- [ ] 后端收到缺图请求时，直接返回单条内容块错误，不执行 1688 工具。
- [ ] 缺图错误不会触发工具重试循环。

### 7.3 流式和重复回答

- [ ] 用户发送后立即出现一个 assistant message。
- [ ] 文本按 `agent.message.part.delta` 增量出现。
- [ ] 同一 run 不出现两个 assistant message。
- [ ] 同一 preface 不出现两次。
- [ ] `agent.response.*` 不再改变主聊天消息。

### 7.4 工具调用展示

- [ ] 每个 tool call 只显示一个 `tool_use`。
- [ ] 缺参时显示一个 `error` part。
- [ ] 不出现连续多个相同的 “失败: 搜索 1688 货源”。
- [ ] Run 最终状态为 `completed` 或可恢复错误，不停在 executing。

## 8. 必须删除或禁用的旧代码点

以下列表是本次后续实现时需要重点处理的旧路径：

1. `AssistantMessageStream.start()` 中 emit `agent.response.started` 的逻辑。
2. `useChat.ts` 中根据 `agent.response.started` 创建 assistant message 的逻辑。
3. `useChat.ts` 中根据 `agent.response.delta` 追加 assistant content 的逻辑。
4. `useChat.ts` 中根据 `agent.response.completed` 完成 message 的逻辑。
5. `AgentLoopEngine.runContentBlockLoop()` catch 中 fallback 到 `runNarrativeLoop()` 的逻辑。
6. `AgentLoopEngine.runNarrativeLoop()` 整个方法。
7. `ResponseComposer.composeClarification()` 中 emit `agent.response.delta` 的逻辑。
8. 任何不传 `stream` 的 Web Agent 用户可见回答路径。

删除后，如果测试依赖 legacy event，应更新测试到 `agent.message.*`。不要为了测试保留旧用户路径。

## 9. 风险与注意事项

1. 删除 legacy response UI 路径后，部分旧测试会失败，这是预期的，需要改成内容块事件断言。
2. 如果 CLI 或 REST 非 Web 客户端仍依赖 `agent.response.delta`，应通过 adapter 从 `agent.message.part.delta` 派生，而不是让 Agent Core 双发两套主事件。
3. `dataUrl` 可能较大，必须保留 4 MB 限制。超过限制时必须依赖 OSS `url` 或后端可签名 `storageKey`。
4. `storageKey` 不能直接传给第三方 1688 工具，必须先转换为可访问 URL，或由后端读取对象并生成 `imageDataUrl`。
5. 不要让 LLM 负责补图片参数。图片参数属于结构化输入，必须由系统确定性填充。

## 10. 最小完成定义

本 bug 修复可以认为完成，必须同时满足：

1. 1688 图片搜索成功路径：

   ```text
   uploaded image -> imageUrl/imageDataUrl -> one tool call -> results or business error
   ```

2. 1688 缺图失败路径：

   ```text
   missing image ref -> zero tool calls -> one visible error block
   ```

3. 流式响应路径：

   ```text
   agent.message.started -> part delta stream -> message.completed
   ```

4. 不存在用户可见旧路径：

   ```text
   agent.response.* cannot create or mutate chat messages
   ```

5. 重复执行保护：

   ```text
   same run + same skill + same args cannot execute repeatedly after deterministic validation failure
   ```

## 11. 建议命令

修复实现完成后建议执行：

```bash
pnpm -r build
pnpm --filter @sunpilot/core test
pnpm --filter @sunpilot/web test
pnpm --filter @sunpilot/daemon test
git diff --check
```

如果要专门复现本问题，建议增加一组端到端测试：

```text
case A: OSS URL image -> search1688 receives imageUrl
case B: OSS failed + small image dataUrl -> search1688 receives imageDataUrl
case C: no image ref -> no tool call, one error block
case D: tool schema custom error -> no retry loop
case E: both agent.message.* and agent.response.* arrive -> UI renders only once
```
