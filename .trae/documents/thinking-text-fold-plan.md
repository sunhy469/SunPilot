# 思考过程折叠优化：将"思考文本"也纳入折叠区

## 问题

当前实现中，`ThinkingProcessSection` 只折叠 `status`/`tool_use`/`tool_result` 类型的 parts，而 `text` 类型的 parts 全部作为"产物"展示。但用户反馈：

> "我现在通过您上传的相机图片搜索1688平台按销量排序的Top5货源，请稍候。" 这句话也是思考过程的话，应该放进思考过程折叠区里，并不是只有 ai status 才会放到折叠的思考状态里。

## 后端 Parts 数据流分析

通过阅读 `assistant-message-stream.ts`、`agent-loop-engine.ts`、`tool-decision-engine.ts`，确认了以下模式：

### 典型 Parts 顺序（use_tool 路径）
```
[
  text: "我现在通过您上传的相机图片搜索1688平台...",     ← 思考文本（说明即将做什么）
  status: "正在调用工具: 搜索1688商品",                   ← 思考状态
  tool_use: 搜索1688商品, status: completed               ← 思考工具调用
  tool_result: "找到3个商品..."                            ← 思考工具结果
  status: "正在整理搜索结果...",                           ← 思考状态
  text: "为您找到以下商品：\n| 排名 | 商品名称 | ...",      ← 最终产物文本
]
```

### 关键规律
1. **Text 必然出现在 Tool Use 之前** — LLM system prompt 引导 + 确定性 preface 兜底
2. **最后一个 text part 是最终产物**，之前的 text parts 是思考过程说明
3. **Parts 顺序 = 调用时序**，严格按 push 顺序维护
4. **每组工具调用的模式固定**：`status → tool_use → tool_result`

## 修改方案

### 核心逻辑：基于位置判断 text 是否为"思考文本"

**规则**：在 parts 数组中，如果某个 text part 之后还存在任何 `status`/`tool_use`/`tool_result` 类型的 part，则该 text part 是"思考文本"；否则是"产物文本"。

等价表述：**最后一个 text part 是产物，其余所有 text parts 都是思考过程**。

### 具体修改

**文件**: `AssistantMessage.tsx`

#### 1. 修改 `MessagePartsRenderer` 的分组逻辑

```typescript
// 当前逻辑：
// thinking: status + tool_use + tool_result
// product:  text + error

// 新逻辑：
// 1. 找到最后一个 text part 的索引
// 2. 在此索引之前的所有 text parts → thinking
// 3. 最后一个 text part + 所有 error parts → product
// 4. status/tool_use/tool_result → thinking（不变）
```

实现：
```typescript
function MessagePartsRenderer({ parts, isStreaming }) {
  if (!parts || parts.length === 0) return null;

  // 找到最后一个 text part 的索引
  let lastTextIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === "text") {
      lastTextIdx = i;
      break;
    }
  }

  // 分组：最后一个 text 之前（含非最后 text）→ thinking，最后一个 text + error → product
  const thinkingParts: AssistantMessagePart[] = [];
  const productParts: AssistantMessagePart[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.type === "error") {
      productParts.push(part);
    } else if (part.type === "text" && i === lastTextIdx) {
      productParts.push(part);
    } else {
      thinkingParts.push(part);
    }
  }

  return (
    <Flex vertical gap={8} className="assistant-parts">
      <ThinkingProcessSection parts={thinkingParts} isStreaming={isStreaming} />
      {productParts.map((part) => (
        <PartRenderer key={part.id} part={part} isStreaming={...} />
      ))}
    </Flex>
  );
}
```

#### 2. ThinkingProcessSection 中 text parts 的渲染

思考文本在折叠区中应该以轻量样式渲染（不使用 ProductContentRenderer 的富卡片提取），因为：
- 思考文本通常是简短的说明性文字（如"我先调用XX检查相关信息"）
- 不需要提取表格/图片为 Rich Card
- 折叠区空间有限，简洁优先

新增 `ThinkingTextBlock` 组件：
```tsx
function ThinkingTextBlock({ part, isStreaming }: { part: AssistantTextPart; isStreaming: boolean }) {
  if (!part.content) return null;
  return (
    <div className="thinking-text-block">
      <MarkdownRenderer content={part.content} isStreaming={isStreaming} />
    </div>
  );
}
```

CSS：
```css
.thinking-text-block {
  font-size: 13px;
  line-height: 1.5;
  color: var(--sp-muted);
  opacity: 0.85;
}
.thinking-text-block .markdown-body {
  font-size: 13px;
}
```

#### 3. PartRenderer 在 ThinkingProcessSection 中使用 ThinkingTextBlock

ThinkingProcessSection 内部的 PartRenderer 需要区分：text parts 用 ThinkingTextBlock，其余不变。

最简方案：给 PartRenderer 加一个 `variant` prop：
```tsx
function PartRenderer({ part, isStreaming, variant = "default" }) {
  switch (part.type) {
    case "text":
      return variant === "thinking"
        ? <ThinkingTextBlock part={part} isStreaming={isStreaming} />
        : <TextPartBlock part={part} isStreaming={isStreaming} />;
    // ... 其余不变
  }
}
```

ThinkingProcessSection 中调用：
```tsx
<PartRenderer key={part.id} part={part} isStreaming={isStreaming} variant="thinking" />
```

#### 4. 无 text part 的边界情况

如果 parts 中没有 text part（`lastTextIdx === -1`），则所有 parts 都归入 thinking，product 为空。这种情况下：
- 思考区仍然展示（流式中可见，完成后折叠）
- 产物区为空，可能显示"正在整理结果..."占位（已有逻辑）

如果 parts 中只有一个 text part（`lastTextIdx` 是唯一的 text），则：
- 该 text 是产物，不折叠
- 其余 status/tool_use/tool_result 归入思考区折叠

### 不需要修改的文件

- `AssistantMessage.css` — 只需新增 `.thinking-text-block` 样式
- 后端代码 — 无需修改，parts 数据流不变

## 验证步骤

1. `npx tsc --noEmit` 无新增类型错误
2. 流式中：思考文本 + status + tool_use 全部展开可见，带动态效果
3. 消息完成后：所有思考内容（包括"我先调用XX"等文本）自动折叠为一行摘要
4. 最终产物文本（表格/图片等）始终可见，使用 ProductContentRenderer 富卡片渲染
5. 无工具调用的纯文本对话：text part 是产物，不折叠
