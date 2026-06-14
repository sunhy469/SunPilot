# 开发优化方案：附件上传、Agent Loop 与 Skill 集成修复

更新日期：2026-06-14

本文档记录当前 SunPilot 前端对话框与后端 Agent Loop 中的若干待优化问题，提供根因分析、改进方案和实现步骤，供后续开发迭代参考。

---

## 一、OSS 图片/文件上传方案

### 现状

当前 ChatComposer 使用 Ant Design `Upload` 组件，`beforeUpload` 直接返回 `false` 阻止自动上传，附件仅在前端本地状态中暂存（`useState<UploadFile[]>`），没有上传到远端存储的通道。

### 问题

- 图片/文件无法跨设备访问
- 浏览器内存中暂存的本地 URL 无法传给后端 agent 使用
- 生成的商品图、视频等产物未走 OSS 存储

### 改进方案

**架构：前端直传 OSS + 后端记录引用**

```
用户选文件 → 前端调用 API 获取 OSS 预签名 URL
         → 前端直传文件到 OSS
         → 前端拿到 OSS URL，作为 AttachmentRef 随消息发出
         → 后端 Agent 收到 OSS URL，可下载/引用
```

**实现步骤：**

1. **新增 API 端点** `POST /v1/upload/presign`
   ```ts
   // packages/api/src/http/register-routes.ts
   app.post("/v1/upload/presign", async (request) => {
     const { fileName, contentType } = request.body;
     const presignedUrl = await ossClient.createPresignedUrl(fileName, contentType);
     const publicUrl = ossClient.publicUrl(fileName);
     return { presignedUrl, publicUrl, key: fileName };
   });
   ```

2. **新增 OSS 客户端模块** `packages/api/src/storage/oss-client.ts`
   - 支持 AWS S3 / 阿里云 OSS / MinIO（S3 兼容协议）
   - 提供 `createPresignedUrl`、`publicUrl`、`delete` 方法
   - 配置通过 `config.json` 管理

3. **前端 Upload 组件改造** `packages/web/src/pages/ChatPage/components/ChatComposer.tsx`
   ```tsx
   // 替换 beforeUpload 逻辑：
   beforeUpload: async (file) => {
     const { presignedUrl, publicUrl } = await requestPresignedUrl({
       fileName: file.name,
       contentType: file.type,
     });
     await fetch(presignedUrl, { method: "PUT", body: file });
     return { ...file, url: publicUrl, status: "done" };
   }
   ```

4. **环境变量 & 配置**
   ```json
   // config.json 新增
   {
     "oss": {
       "endpoint": "https://s3.amazonaws.com",
       "bucket": "sunpilot-uploads",
       "region": "us-east-1",
       "accessKey": "OSS_ACCESS_KEY",
       "secretKey": "OSS_SECRET_KEY",
       "publicBaseUrl": "https://cdn.example.com"
     }
   }
   ```

---

## 二、剪贴板粘贴 / 拖拽上传文件

### 现状

ChatComposer 仅支持点击 "+" 按钮通过文件选择器上传。不支持：
- `Ctrl+V` / `Cmd+V` 粘贴图片/文件
- 拖拽文件到对话框区域

### 改进方案

**利用 Ant Design Upload 的 `paste` 和 `drag` 能力**，在对话框容器级别监听。

**实现步骤：**

1. **ChatComposer 增加粘贴监听**
   ```tsx
   // ChatComposer.tsx — 在 TextArea 或外层 Flex 上添加
   const handlePaste = useCallback((e: React.ClipboardEvent) => {
     const items = e.clipboardData?.items;
     if (!items) return;
     for (const item of items) {
       if (item.kind === "file") {
         const file = item.getAsFile();
         if (file) {
           const uid = `paste_${Date.now()}_${file.name}`;
           setAttachments((prev) => [
             ...prev,
             { uid, name: file.name, originFileObj: file, type: file.type } as UploadFile,
           ]);
         }
       }
     }
   }, []);
   ```

2. **外层增加拖拽区域**（Upload 组件 `Dragger` 模式可选）
   ```tsx
   <Upload.Dragger
     multiple
     showUploadList={false}
     beforeUpload={() => false}
     onChange={(info) => setAttachments(info.fileList)}
     className="chat-composer__drop-zone"
   >
     {/* 现有三层结构放在这里 */}
   </Upload.Dragger>
   ```
   或者保持现有布局，在 `.chat-composer-wrap` 上监听 `onDragOver` / `onDrop`。

3. **CSS 拖拽高亮提示**
   ```css
   .chat-composer__drop-zone.drag-over {
     border-color: #93c5fd;
     background: rgba(37, 99, 235, 0.04);
   }
   ```

---

## 三、发送按钮携带附件

### 现状

`useChat.send()` 签名是 `(message: string) => void`，仅传递文本。`sendChatMessage` 虽然支持 `attachments` 参数，但从未被传入。ChatComposer 中的 `attachments` 状态在发送后丢失。

### 根因链路

```
ChatComposer
  │ attachments 存在本地 useState
  │ 发送时 → onSend(currentValue)  ← 只传了文字！
  ▼
useChat.send(message: string)        ← 签名无 attachments
  │ sendChatMessage(socket, { message })
  │ attachments 字段未传入
  ▼
WebSocket → AgentService.handleChatCommand
  │ attachments: input.attachments   ← 收到空/undefined
  ▼
AgentLoopInput.attachments = []      ← 永远空数组
```

### 改进方案

**三步联动修改：**

**1. ChatComposer — 发送时传递附件**
```tsx
const handleSend = useCallback(() => {
  const text = currentValue.trim();
  if (!text || disabled) return;
  onSend(text, attachments.map(a => ({
    id: a.uid,
    name: a.name,
    type: a.type ?? "application/octet-stream",
    sizeBytes: a.size,
  })));
  setAttachments([]);  // 清空已发送的附件
  setCurrentValue("");
}, [...]);
```

**2. useChat — 签名扩展**
```ts
// useChat.ts
const send = useCallback(
  (message: string, attachments?: AttachmentRef[]) => {
    // ...
    const transmit = () =>
      sendChatMessage(socket, {
        ...(conversationId ? { conversationId } : {}),
        message: text,
        attachments,  // ← 新增传递
      });
  }, [...]
);
```

**3. ChatComposer 类型对齐**
```ts
// ChatComposer props
onSend: (text: string, attachments?: AttachmentRef[]) => void;
```

---

## 四、Agent Loop 与 Skill 集成断裂修复

### 现状

用户可通过 `skill.json` 注册自定义 Skill（如 jaderoad 的 `product.source.search1688`），Agent 在上下文构建时能列出技能给 LLM，但当用户要求使用某技能时，Agent Loop 无法触发实际工具调用。

### 根因分析

Agent Loop 的 **意图分类（IntentRouter）和工具决策（ToolDecisionEngine）是两层独立系统**：

```
用户: "搜索1688货源"
  │
  ▼
IntentRouter.route()
  ├─ 规则匹配：DEFAULT_INTENT_RULES 中没有 "搜索/查找/货源" 正则
  ├─ LLM 分类：prompt 仅列出 11 种硬编码类型，无 "web_search/product_search"
  └─ 结果 → "question_answering" (requiresTool: false)
  │
  ▼
ToolDecisionEngine.decide()
  └─ intent.requiresTool === false → 直接返回 no_tool
  │
  ▼
handleNoTool() → LLM 纯文本回复 "正在搜索..."
  （Skill 目录从未被查询！）
```

**核心矛盾**：IntentRouter 完全不知道 Skill 注册表的存在。即使 LLM 上下文里列出了所有 Skill，意图分类层的 prompt 和规则与 Skill 目录没有联动。

### 改进方案

**方案：IntentRouter 注入 Skill 感知能力**

在 LLM 分类阶段，将已注册 Skill 的名称和描述注入分类 prompt，让 LLM 能够把用户请求映射到具体 Skill。同时增加 `use_skill` 意图类型，对应"用户指定了要使用的 Skill"的场景。

**1. loop-types.ts — 新增意图类型**
```ts
export type IntentType =
  | "casual_chat"
  | "question_answering"
  // ... existing types ...
  | "use_skill"     // 新增：用户明确要使用某个 Skill
  | "unknown";
```

**2. IntentRouter — LLM 分类 prompt 注入 Skill 列表**
```ts
// intent-router.ts: classifyWithLlm()
// 注入 deps: { listSkills?: () => Promise<SkillSummary[]> }
private async classifyWithLlm(message: string): Promise<RoutedIntent | null> {
  const skills = await this.deps.listSkills?.() ?? [];
  const skillList = skills
    .filter(s => s.enabled)
    .map(s => `- ${s.id}: ${s.name} — ${s.description}`)
    .join('\n');

  const prompt = `Available skills:
${skillList || '(none)'}

Classify the user's intent into EXACTLY ONE of these categories:
- use_skill: user wants to use a specific available skill
- casual_chat: greetings, small talk, thanks
- question_answering: asking for information or explanation
...

User message: "${message}"
Respond with ONLY the category name, nothing else.`;
  // ... rest of LLM call
}
```

**3. defaultsForType — 新增 use_skill 处理**
```ts
case "use_skill":
  return {
    type,
    confidence: 0.7,
    requiresPlanning: false,
    requiresTool: true,          // ← 关键：标记为需要工具
    requiresApproval: false,
    riskLevel: "medium",
    candidateSkills: [],         // ← 交给 ToolDecisionEngine 匹配
    reason: "LLM classified as skill usage",
  };
```

**4. INTENT_SKILL_MAP — 新增映射**
```ts
export const INTENT_SKILL_MAP: Record<string, string[]> = {
  // ... existing ...
  use_skill: [],  // 特殊：不指定 skill，让 ToolDecisionEngine 全量匹配
};
```

**5. ToolDecisionEngine — 降级全量匹配**
```ts
// tool-decision-engine.ts: decide()
// 对于 use_skill 意图，candidateSkills 为空时，匹配全部可用 Skill 中
// 名称或描述与用户消息相关的
if (intent.type === "use_skill" && matchedSkills.length === 0) {
  // 用 LLM 从 availableSkills 中选择最匹配的
  const bestMatch = await this.selectSkillWithLlm(
    context.currentMessage.content,
    availableSkills
  );
  if (bestMatch) {
    return { type: "use_tool", toolCalls: [buildToolCall(bestMatch)], ... };
  }
}
```

**6. DEFAULT_INTENT_RULES — 增加搜索类中文规则**
```ts
{
  type: "use_skill",
  patterns: [
    /\b(搜索|查找|找|搜|货源|同款|1688|淘宝)\b/i,
    /\b(search|find|lookup|source)\b/i,
  ],
  requiresPlanning: false,
  requiresTool: true,
  requiresApproval: false,
  riskLevel: "medium",
  candidateSkills: [],  // 空 = 全量匹配
},
```

### 最终修复后的完整链路

```
用户: "搜索1688货源"
  │
  ▼
IntentRouter (注入 skill 列表)
  ├─ 规则匹配: "搜索"|"货源"|"1688" → use_skill
  └─ requiresTool: true
  │
  ▼
ToolDecisionEngine
  ├─ candidateSkills 为空 → 从 skill 目录全量匹配
  ├─ "product.source.search1688" 名称/描述匹配 "搜索" "货源"
  └─ 返回 use_tool + toolCall
  │
  ▼
handleUseTool() → executeToolDecision()
  └─ ExecutionOrchestrator 调用 jaderoad:product.source.search1688
  └─ 返回 OneBound API 搜索结果
  │
  ▼
ResponseComposer → LLM 总结结果 → 用户看到真实数据
```

---

## 五、实施优先级

| 优先级 | 模块 | 预估工时 | 依赖 |
|--------|------|----------|------|
| P0 | Agent Loop Skill 断裂修复 | 2–3 天 | 无 |
| P1 | 发送按钮携带附件 | 0.5 天 | 无 |
| P2 | 粘贴/拖拽上传 | 1 天 | 无 |
| P3 | OSS 上传方案 | 2–3 天 | 需要 OSS/S3 基础设施 |

P0 是最关键的修复，直接影响所有自定义 Skill（包括 jaderoad）能否被正确调用。其余三个是附件功能的渐进增强。
