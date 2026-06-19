# 思考过程动态标题与重复提示优化方案

日期：2026-06-19

范围：仅前端展示优化方案，不涉及后端 agent loop、工具执行、上下文构建或消息协议变更。

## 问题背景

当前对话流式过程中，页面可能同时出现两个表达相近的提示：

- 思考过程容器标题：固定显示“思考过程”。
- 容器外部状态条：显示“闪电 icon + 正在思考 + 动态点点点”。

这会让界面显得重复：用户已经看到思考过程区域了，下面又出现一条“正在思考”。更自然的交互是把“正在思考”融合到思考过程标题里：

- streaming 中：标题位置显示“闪电 icon + 正在思考 + 动态 ...”。
- final 完成后：标题恢复为“思考过程”。
- 折叠后：显示“思考过程 (N 步)”。

## 当前代码位置

主要文件：

- `packages/web/src/pages/ChatPage/components/AssistantMessage.tsx`
- `packages/web/src/pages/ChatPage/components/AssistantMessage.css`

关键位置：

- `ThinkingProcessSection()`：当前固定标题在 `AssistantMessage.tsx` 约 `415-478`。
- `MessagePartsRenderer()`：把 `thinkingParts` 传给 `ThinkingProcessSection()`。
- 外部空状态提示：`AssistantMessage.tsx` 约 `694-707`，当 `hasParts && !hasContent` 时显示“正在思考”。
- 现有图标：文件顶部已经引入 `ThunderboltOutlined` 和 `TypingDots`。

## 目标交互

### 1. 流式思考中

当 assistant message 正在 streaming，并且 `thinkingParts.length > 0`：

```text
⌄  闪电icon  正在思考 ...
```

标题应显示在原“思考过程”标题的位置。动态点可以复用 `TypingDots`，也可以用 CSS dot animation。

此时不再额外显示容器外部的“正在思考”状态条。

### 2. 完成后展开

当 `isStreaming === false`，如果用户展开思考过程：

```text
⌄  思考过程
```

或者为了保留步骤信息：

```text
⌄  思考过程 (N 步)
```

建议展开态保持简洁，显示“思考过程”；折叠态显示步数。

### 3. 完成后折叠

当前逻辑会在完成后自动折叠，这是合理的。折叠态继续显示：

```text
›  ✓  思考过程 (N 步)
```

## 推荐实现方案

### Step 1：新增标题渲染逻辑

在 `ThinkingProcessSection()` 内部增加一个标题片段，不改变外层数据结构：

```tsx
const titleNode = isStreaming ? (
  <>
    <ThunderboltOutlined className="thinking-section__active-icon" />
    <Text type="secondary" className="thinking-section__title">
      正在思考
    </Text>
    <TypingDots />
  </>
) : (
  <Text type="secondary" className="thinking-section__title">
    思考过程
  </Text>
);
```

然后把展开态标题处原来的：

```tsx
<Text type="secondary" className="thinking-section__title">
  思考过程
</Text>
```

替换为：

```tsx
{titleNode}
```

注意：`ThinkingProcessSection()` 当前作用域可以直接使用已经 import 的 `ThunderboltOutlined` 和 `TypingDots`。

### Step 2：完成后折叠态保持现有展示

折叠态建议不显示“正在思考”，因为折叠只会在完成后出现。保留当前：

```tsx
<CheckCircleOutlined className="thinking-section__icon" />
<Text type="secondary" className="thinking-section__summary">
  思考过程 ({stepCount} 步)
</Text>
```

如果后续允许用户在 streaming 时手动折叠，可增加条件：

```tsx
{isStreaming ? <ThunderboltOutlined /> : <CheckCircleOutlined />}
{isStreaming ? "正在思考" : `思考过程 (${stepCount} 步)`}
```

但第一版不建议扩大交互面，保持 streaming 默认展开即可。

### Step 3：隐藏外部重复“正在思考”状态条

当前外部提示条件大致是：

```tsx
hasParts && !hasContent && (isPending || (isStreaming && noTextPartContent))
```

这条状态会在已有思考过程容器时重复出现。建议改成：

```tsx
const hasThinkingParts = Boolean(msg.parts?.some((part) =>
  part.type === "status" ||
  part.type === "tool_use" ||
  part.type === "tool_result" ||
  part.type === "text"
));
```

然后外部“正在思考”状态条增加限制：

```tsx
!hasThinkingParts
```

更精确一点，可以让 `MessagePartsRenderer()` 内部处理所有 `hasParts` 的 loading 状态；外部状态条只保留给“还没有任何 parts，但 message 已经 started”的极早期阶段。

建议最终语义：

- 没有 parts：外部显示“正在准备上下文...”或 typing dots。
- 有 parts 且 streaming：思考过程标题显示“正在思考 ...”。
- 工具结果完成但还没有 final text：思考过程里已有“正在整理搜索结果...”等 status，不再额外显示第二条。

### Step 4：CSS 样式调整

新增或调整样式：

```css
.thinking-section__active-icon {
  font-size: 13px;
  color: var(--sp-blue);
}

.thinking-section__header .typing-dots {
  margin-left: 2px;
}
```

如果 `TypingDots` 的尺寸在标题里偏大，建议新增紧凑变体。最小改造可以复用当前组件，后续再抽：

```tsx
<TypingDots className="typing-dots--compact" />
```

如果 `TypingDots` 当前不支持 className，就先用 CSS 选择器限制 `.thinking-section__header .typing-dots`。

## UI 状态矩阵

| 状态 | 思考过程标题 | 外部状态条 |
|---|---|---|
| message started，但还没有 parts | 不显示思考过程容器 | 可显示“正在准备上下文...” |
| parts 已出现，streaming 中 | “闪电 icon + 正在思考 + ...” | 不显示“正在思考” |
| 工具执行中 | 标题仍为“正在思考...”；内部 status 显示具体工具状态 | 不显示重复状态 |
| 工具完成，等待 final text | 标题仍为“正在思考...”；内部显示“正在整理结果...” | 不显示重复状态 |
| final answer 完成 | 折叠为“思考过程 (N 步)” | 不显示 |
| 用户手动展开完成后的思考过程 | “思考过程” | 不显示 |

## 验收标准

1. 流式过程中，原“思考过程”标题位置动态显示：

   ```text
   闪电 icon + 正在思考 + 动态 ...
   ```

2. 最终答案完成后，标题恢复为：

   ```text
   思考过程
   ```

   自动折叠时显示：

   ```text
   思考过程 (N 步)
   ```

3. 当思考过程容器已经出现时，页面下方不再额外出现“正在思考 ...”状态条。

4. “正在匹配工具 / 正在执行工具 / 正在生成回答”等具体 status 仍保留在思考过程内容区内，不丢失。

5. 移动端和桌面端标题不换行、不挤压工具状态内容。

## 建议测试

### 组件测试

补充 `AssistantMessage` 相关测试：

- streaming + thinking parts：应渲染“正在思考”，不渲染外部重复状态条。
- completed + thinking parts：应渲染“思考过程 (N 步)”折叠标题。
- no parts + pending：仍显示“正在准备上下文...”。

### 手工验收场景

1. 发送图片 + 生成脚本请求。
2. 观察初始阶段：没有 parts 前可以显示准备状态。
3. 出现第一个 status/text/tool part 后，标题变为“正在思考 ...”。
4. 工具执行和整理结果都在思考过程内部显示。
5. 最终脚本出现后，思考过程自动折叠为“思考过程 (N 步)”。

## 风险与注意事项

- 不要把“正在思考”做成新的后端事件，前端可由 `isStreaming` 和 `thinkingParts.length` 推导。
- 不要移除具体 status part，否则用户看不到“正在匹配工具 / 正在执行工具”的细节。
- 不要让 `TypingDots` 影响标题高度，避免流式过程中布局跳动。
- 如果未来加入 `semanticRole: "progress" | "final"`，这里应继续按 `thinkingParts` 是否存在来判断标题状态，不依赖文本内容。
