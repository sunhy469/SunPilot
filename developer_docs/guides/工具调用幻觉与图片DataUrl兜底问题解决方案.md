# 工具调用幻觉与图片 DataUrl 兜底问题解决方案

## 背景

当前对话中暴露出两个独立但会互相放大的问题：

1. 模型调用协议层面的幻觉：豆包偶发把函数调用以 `<FunctionCallBegin>...<FunctionCallEnd>` 文本输出，而不是通过 API 原生 `tool_calls` 字段返回。
2. 图片参数走了 `imageDataUrl` fallback：1688 搜图工具收到的是 `data:image/...;base64,...`，不是 OSS public URL。

这两个问题都会导致用户看到“工具好像准备执行了，但结果不稳定”的体验。前者会直接阻断工具执行，后者可能让三方搜图 API 识图质量下降或走到兼容路径。

## 问题一：模型调用协议层面的幻觉

### 现象

异常回答中出现类似文本：

```text
<FunctionCallBegin>[{"name":"Search1688Goods","parameters":{"query":"男士冰丝格子短袖衬衫 低价 大码 爸爸装"}}]<FunctionCallEnd>
```

UI 同时显示“匹配到 1 个工具，准备执行...”，但随后没有真正进入工具执行卡片，也没有稳定展示 1688 工具结果。

### 当前链路

SunPilot 已经使用原生 Function Calling：

- `ToolRetriever` 检索候选工具，并由 `buildStreamingToolDefinitions()` 转成模型 `tools`。
- `streamLlmTurn()` 调用模型时传入 `tools` 与 `tool_choice: "auto"`。
- `OpenAICompatibleChatProvider` 将 `request.tools` 写入 `/chat/completions` 请求 body。
- provider 只把 `choices[].delta.tool_calls` 识别为工具调用，把 `choices[].delta.content` 识别为普通文本。

关键代码：

- `packages/core/src/agent-kernel/tools/tool-decision-engine.ts:1047` 构造候选工具定义。
- `packages/core/src/agent-kernel/tools/tool-decision-engine.ts:1731` 调用模型并传入 `tools` / `tool_choice`。
- `packages/core/src/llm/openai-compatible.provider.ts:89` 将 `tools` 写入 HTTP body。
- `packages/core/src/llm/openai-compatible.provider.ts:141` 区分 `content` 与 `tool_calls`。
- `packages/core/src/agent-kernel/tools/tool-decision-engine.ts:1125` 如果本轮没有 `toolCalls`，就把模型文本视为最终回答并退出循环。

### 根因

“匹配到 1 个工具”只表示 SunPilot 前置检索/安全阶段认为本轮应该给模型一个候选工具，并不等于模型已经发起工具调用。

真正执行工具的条件是模型返回结构化字段：

```json
choices[].delta.tool_calls
```

异常时模型把函数调用写进了：

```json
choices[].delta.content
```

因此 SunPilot 当前会把 `<FunctionCallBegin>...` 当普通文本流式展示。由于 `toolCallAccumulator` 没有收到 `tool_calls`，`result.toolCalls.length === 0`，工具循环直接结束。

短追问更容易触发该问题，例如“有没有便宜点的”。这类问题高度依赖历史上下文，模型更容易“模拟下一步动作”，把工具调用格式写成正文。

### 解决方案

#### P0：禁止伪函数调用文本透出

在 `streamLlmTurn()` 内部增加正文过滤：

- 如果 chunk.delta 中出现 `<FunctionCallBegin>` 或 `<FunctionCallEnd>`，不要直接 `stream.appendText()` 到前端。
- 将这类内容暂存到 `syntheticToolCallBuffer`。
- 如果本轮最终没有原生 `tool_calls`，尝试解析该 buffer。

这样至少不会把模型协议幻觉直接展示给用户。

#### P0：兼容解析方舟文本函数调用

新增兼容解析器，例如：

```ts
parseTextualFunctionCalls(text: string): ToolCall[]
```

支持这些形态：

```text
<FunctionCallBegin>[{"name":"1688_search","parameters":{"keyword":"..."}}]<FunctionCallEnd>
<FunctionCallBegin>[{"name":"Search1688Goods","parameters":{"query":"..."}}]<FunctionCallEnd>
```

解析后做三步校验：

1. 只有本轮确实传入了 `tools` 时才启用。
2. 解析出的函数名必须能映射到当前候选工具，不能执行候选集外的工具。
3. 参数必须重新走 `canonicalizeArgs()`、schema validation、permission policy，不允许绕过现有安全门。

映射策略：

- 优先匹配 provider tool name。
- 再匹配 skill id / skill name 的规范化别名。
- 对 `Search1688Goods`、`1688_search` 这类已观察到的别名，只允许映射到 `jaderoad:product.source.search1688`，并写入显式别名表，避免误匹配。

#### P1：强化系统提示

在工具调用轮的 system prompt 中增加约束：

```text
需要调用工具时，必须使用 API tool_calls/function calling。
禁止在正文输出 <FunctionCallBegin>、<FunctionCallEnd>、JSON 函数调用片段或伪工具调用文本。
如果不调用工具，只输出自然语言回答。
```

这只能降低概率，不能作为唯一防线。

#### P1：增加观测指标

为以下情况写 trace / event：

- `model_textual_tool_call_detected`
- `model_textual_tool_call_recovered`
- `model_textual_tool_call_rejected`

记录字段：

- modelId
- provider
- originalTextLength
- parsedFunctionName
- mappedSkillId
- rejectedReason

这样后续可以量化豆包模型在短追问、多轮工具任务中的格式漂移频率。

### 验收标准

- 当模型返回标准 `tool_calls` 时，现有路径不变。
- 当模型返回 `<FunctionCallBegin>...` 且函数名可映射到当前候选工具时，后端继续执行工具，前端不展示伪函数调用文本。
- 当模型返回候选集外函数名时，不执行，并展示可恢复错误或重新请求模型。
- 短追问“有没有便宜点的”应能继续执行 1688 工具，而不是直接把伪调用文本展示为答案。

## 问题二：图片为什么不是 OSS URL，而是 imageDataUrl

### 现象

工具参数显示：

```text
imageDataUrl: data:image/png;base64,iVBORw0KGgo...
```

这不是 OSS URL。标准 OSS URL 应该是 `https://...` 形式，并填入 `imageUrl` 或 `url`。

### 当前上传链路

前端上传图片时走：

1. `useOssUpload.uploadFile()` 请求 presigned URL。
2. 上传文件到 OSS。
3. 成功后返回 `{ url: publicUrl, key }`。
4. `useFileAttachments` 将 `url` 写入 `UploadFile.url`，将 `key` 写入 `response.key`。
5. `uploadFileToAttachmentRef()` 转成后端 `AttachmentRef`，包含 `url`、`dataUrl`、`storageKey`。
6. 工具参数填充时优先选择 attachment.url，拿不到 URL 才使用 attachment.dataUrl。

关键代码：

- `packages/web/src/pages/ChatPage/hooks/useOssUpload.ts:28` 请求 presigned URL。
- `packages/web/src/pages/ChatPage/hooks/useOssUpload.ts:41` 成功返回 `publicUrl`。
- `packages/web/src/pages/ChatPage/hooks/useFileAttachments.ts:122` 上传成功后写入 `url`。
- `packages/web/src/pages/ChatPage/hooks/useFileAttachments.ts:124` 如果没有 URL，则生成 dataUrl fallback。
- `packages/web/src/features/chat/attachment-utils.ts:10` 将 UploadFile 转为 AttachmentRef。
- `packages/core/src/agent-kernel/tools/tool-decision-engine.ts:2516` 工具参数优先 URL，再 dataUrl。
- `packages/core/src/agent-kernel/tools/tool-decision-engine.ts:2601` 有 URL 时填 `imageUrl`。
- `packages/core/src/agent-kernel/tools/tool-decision-engine.ts:2607` 有 dataUrl 时填 `imageDataUrl`。

### 哪一步出现问题

不是 1688 工具主动把 OSS URL 改成了 dataUrl，而是更早的上传/附件转换阶段没有拿到可用 `url`。

会落到 `imageDataUrl` 的情况包括：

1. OSS 未配置。
   `useOssUpload.uploadFile()` 捕获 `oss_not_configured` 后返回空 URL。

2. OSS presign 或上传失败。
   `useFileAttachments` catch 分支会尝试把小图片读成 dataUrl。

3. OSS 返回了 key，但 publicUrl 为空或不可用。
   当前 `response.key` 会作为 `storageKey` 保留，但工具参数填充并不会把 `storageKey` 转成 `imageUrl`。

4. 发送时机过早。
   如果用户在上传完成前发送，理论上 UI gate 应阻止。但如果状态转换或 response 字段丢失，最终 AttachmentRef 可能只有 dataUrl。

5. 图片来自粘贴/截图，且本地 preview 正常，但 OSS 上传没有成功。
   UI 上能看到图，不等于后端有公网 URL。

### 已定位的 OSS 直传失败场景

从浏览器 Network 可以看到：

- `POST /v1/upload/presign` 返回 200，并返回 `presignedUrl`、`publicUrl`、`key`。
- OSS `OPTIONS` preflight 返回 200，说明 CORS 预检通过。
- 真正的 OSS `PUT presignedUrl` 返回 403。
- 随后访问 `publicUrl` 返回 `404 NoSuchKey`，说明对象并没有成功写入 OSS。

因此这不是 1688 工具问题，也不是 `publicUrl` 本身生成后又被工具改写，而是 OSS 直传 PUT 失败后触发了前端 dataUrl fallback。

已发现的代码级原因是 V4 presign 的 canonical URI 与阿里云 OSS 校验口径不一致。阿里云返回的错误 CanonicalRequest 中包含 bucket 资源路径，而当前实现只签了 object key。已将 V4 canonical URI 统一改为：

```text
/<bucket>/<key>
```

实际访问 URL 仍保持：

```text
https://<bucket>.<endpoint>/<key>?...
```

同时建议将 `ALIYUN_OSS_PUBLIC_BASE_URL` 配成 HTTPS：

```env
ALIYUN_OSS_PUBLIC_BASE_URL=https://jadeco.oss-cn-shanghai.aliyuncs.com
```

否则 HTTPS 站点加载 HTTP 图片会遇到 mixed content 风险。

### 风险

`imageDataUrl` 本身是设计允许的 fallback，但对 1688 搜图不一定是最佳输入：

- 三方 API 可能更适合公网 URL。
- base64 体积大，容易影响模型上下文和日志展示。
- 如果 fallback 读到的是占位图或压缩图，识图可能偏离真实商品。
- 工具 UI 展示参数时会泄露很长的 base64，降低可读性。

### 解决方案

#### P0：1688 搜图优先强制 OSS URL

对 `jaderoad:product.source.search1688` 增加更严格的执行前校验：

- 如果有 `imageUrl`，正常执行。
- 如果只有 `imageDataUrl`，先尝试服务端上传/转存到 OSS，得到 public URL 后再执行。
- 如果转存失败，再根据工具能力决定是否允许 dataUrl 兜底。

推荐策略：

```text
imageUrl > server-side upload dataUrl to OSS > imageDataUrl fallback > ask user to retry upload
```

#### P0：不要把 dataUrl 直接暴露在工具 UI

工具参数展示层应隐藏或截断 base64：

```text
imageDataUrl: [base64 image, image/png, 123KB]
```

不要展示完整 `data:image/...`。

#### P1：上传完成门禁改为“业务可用引用”

当前发送校验允许 `url || dataUrl || storageKey`。对 1688 搜图这类强依赖外部图片引用的工具，应增加任务级门禁：

- 用户明确要搜图/1688 同款时，优先要求 `url`。
- 如果只有 `dataUrl`，前端提示“图片正在上传或未获得公网 URL”，允许用户等待或继续使用 fallback。
- 如果只有 `storageKey`，后端应能解析成 public URL 或 signed URL，否则不应视为可用图片引用。

#### P1：补齐 storageKey 到 URL 的后端解析

如果 AttachmentRef 有 `storageKey` 但没有 `url`，后端可通过存储服务生成 signed/public URL，然后填入 `imageUrl`。这样能避免“OSS 已上传但 URL 丢失”时退化成 dataUrl。

#### P1：记录附件来源诊断

在工具调用 metadata 中记录：

- selectedImageSource: `url` | `dataUrl` | `storageKey`
- attachmentId
- hasUrl
- hasDataUrl
- hasStorageKey
- dataUrlBytes
- uploadProvider

1688 结果异常时可以直接判断是否因为图片输入来源退化。

### 验收标准

- 正常 OSS 配置下，1688 搜图参数应优先显示 `imageUrl`，不是 `imageDataUrl`。
- OSS 未配置或上传失败时，前端/后端明确提示当前使用 dataUrl fallback。
- 如果只有 dataUrl，后端能转存为 URL 或明确记录 fallback 原因。
- 工具 UI 不展示完整 base64。
- 同一张图片的 1688 搜图不应因为 dataUrl fallback 被误识别为不相关品类。

## 综合修复优先级

### 第一阶段：止血

1. 在 `streamLlmTurn()` 中屏蔽 `<FunctionCallBegin>` 文本透出。
2. 增加文本函数调用解析兜底，只允许映射当前候选工具。
3. 工具 UI 隐藏完整 `imageDataUrl`。
4. 成功完成时清理前端旧 error，避免“结果正确但页面仍错误”的错位。

### 第二阶段：稳定工具执行

1. 强化工具调用 prompt，禁止正文伪函数调用。
2. 对 1688 搜图实现 dataUrl 服务端转存 OSS。
3. 对 `storageKey` 实现后端 URL 解析。
4. 增加 textual tool call 与 image source trace 指标。

### 第三阶段：架构收敛

1. 将 Function Calling 兼容层抽成 provider adapter，隔离不同模型的工具调用格式漂移。
2. 将图片引用规范收敛为统一 `ImageRef`：
   - `publicUrl`
   - `signedUrl`
   - `storageKey`
   - `dataUrl`
   - `sourceQuality`
3. 工具执行层只消费解析后的 `ImageRef`，不直接依赖前端上传字段。

## 推荐结论

工具匹配问题不是 SunPilot 没有使用原生工具调用，而是豆包偶发将工具调用协议幻觉成正文文本。应保留原生 `tool_calls` 主路径，同时增加 `<FunctionCallBegin>` 兼容兜底和安全校验。

图片问题不是 1688 工具生成了错误格式，而是上传链路没有拿到 OSS public URL 后触发了 dataUrl fallback。应优先修 OSS URL 生成/保留链路，并为 1688 搜图增加 dataUrl 转存或明确降级提示。
