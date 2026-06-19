# AI 消息状态优化计划：动态等待效果 + 思考过程折叠 + 产物富卡片化

## 摘要

三个核心优化：
1. **工具等待动态效果**：工具在等待执行结果时，显示旋转/脉冲加载动画
2. **思考过程折叠**：消息完成后，将"思考过程"（status、tool_use、tool_result）自动折叠隐藏，类似 Trae Solo
3. **产物富卡片化渲染**：最终产物（表格、图片、代码等）同时使用 Rich Card 和 Streamdown 渲染，不只是用 Streamdown 展示 Markdown

---

## 当前状态分析

### 消息 Parts 结构
- `text` — 最终文本产物（通过 MarkdownRenderer/Streamdown 渲染）
- `status` — 思考过程状态行（running/completed/failed）
- `tool_use` — 工具调用（思考过程）
- `tool_result` — 工具结果（思考过程）
- `error` — 错误提示

### 当前渲染架构
```
[思考过程 parts: status / tool_use / tool_result]  ← 全部展开，无折叠
[文本产物: MarkdownRenderer(Streamdown)]             ← 纯 Markdown 渲染
[富卡片: RichCardRenderer]                           ← 独立渲染，仅在 cards 非空时
```

### 问题
1. **工具等待无动态效果**：ToolUsePartBlock running 时只有静态图标
2. **思考过程与产物不区分**：完成后仍全部展开
3. **产物只用 Markdown 渲染**：表格、图片等结构化内容在 Streamdown 中渲染为普通 HTML，没有利用 Rich Card 的增强交互（Ant Design Table、Image.PreviewGroup 画廊、代码块复制等）
4. **Rich Card 与 Markdown 割裂**：Rich Card 仅来自后端 `RichCardBuilder`（目前只生成 gallery/image/video/file/info），前端 Markdown 中的表格/图片/代码无法自动升级为 Rich Card

---

## 修改方案

### 1. 工具等待动态效果

**文件**: `AssistantMessage.tsx` + `AssistantMessage.css`

#### ToolUsePartBlock 添加运行态动画
- `status === "running"` 或 `status === "pending"`：
  - 图标改为 `LoadingOutlined`（自带旋转动画）
  - 添加 CSS 类 `assistant-tool-use--running`
  - 整行添加微弱脉冲背景动画
- `status === "completed"`：
  - 图标改为 `CheckCircleOutlined`（绿色）
  - CSS 类 `assistant-tool-use--completed`
- `status === "failed"`：
  - 图标改为 `CloseCircleOutlined`（红色）
  - CSS 类 `assistant-tool-use--failed`

#### CSS 新增
```css
.assistant-tool-use--running { background: rgba(37, 99, 235, 0.04); }
.assistant-tool-use--running .assistant-tool-use__icon { color: var(--sp-blue); animation: pulse 1.5s ease-in-out infinite; }
.assistant-tool-use--completed { background: rgba(22, 163, 74, 0.04); }
.assistant-tool-use--completed .assistant-tool-use__icon { color: #16a34a; }
.assistant-tool-use--failed { background: rgba(220, 38, 38, 0.04); }
.assistant-tool-use--failed .assistant-tool-use__icon { color: #dc2626; }
```

### 2. 思考过程折叠（Trae Solo 模式）

**文件**: `AssistantMessage.tsx` + `AssistantMessage.css`

#### MessagePartsRenderer 改造
将 parts 分为两组：
- **思考过程组**（thinking parts）：`type === "status" | "tool_use" | "tool_result"`
- **产物组**（product parts）：`type === "text" | "error"`

渲染逻辑：
```
[思考过程折叠区 ThinkingProcessSection] ← 完成后折叠，流式中展开
[文本产物 TextPartBlock]                 ← 始终可见，通过 MarkdownRenderer 渲染
[错误提示 ErrorPartBlock]                ← 始终可见
```

#### 新组件 ThinkingProcessSection
```tsx
function ThinkingProcessSection({ parts, isStreaming }: {
  parts: AssistantMessagePart[];
  isStreaming: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  // 消息完成时自动折叠
  useEffect(() => {
    if (!isStreaming) setCollapsed(true);
  }, [isStreaming]);

  if (parts.length === 0) return null;

  // 折叠态：一行摘要 "✓ 思考过程 (N 步)"
  // 展开态：完整 status / tool_use / tool_result 序列
}
```

- 折叠态：`CheckCircleOutlined` 绿色图标 + "思考过程 (N 步)" + 点击展开
- 展开态：完整思考过程 + 顶部"收起"按钮
- 流式中：始终展开，带动态效果
- 完成后：自动折叠为摘要行

#### 移除 StatusPartBlock 的独立折叠逻辑
当前 `StatusPartBlock` 在 completed 时自行折叠为 `✓ label`，改为统一由 `ThinkingProcessSection` 管理，`StatusPartBlock` 始终展示完整内容。

### 3. 产物富卡片化渲染

**核心思路**：在前端 MarkdownRenderer 渲染后，对 Markdown 中的结构化内容（表格、图片组、代码块）进行"升级"，用对应的 Rich Card 组件替换渲染，实现比纯 Markdown 更丰富的交互体验。

**文件**: `AssistantMessage.tsx`（新增 `ProductContentRenderer` 组件）

#### 3.1 实现方案：Markdown 内容后处理提取

在 `TextPartBlock` 渲染时，对 Markdown 内容做结构化提取：

1. **表格提取**：解析 Markdown 中的表格语法，提取为 `TableCardData`，用 `TableCard`（Ant Design Table）渲染
2. **图片组提取**：连续的图片语法提取为 `GalleryCardData`，用 `GalleryCard`（Ant Design Image.PreviewGroup）渲染
3. **代码块**：保留 Streamdown 的 `CodeBlock` 组件渲染（已有复制/折叠功能，与 `CodeCard` 功能等价，无需替换）
4. **其余文本**：仍用 Streamdown 渲染

#### 3.2 新组件 ProductContentRenderer

```tsx
function ProductContentRenderer({ content, isStreaming }: {
  content: string;
  isStreaming: boolean;
}) {
  // 流式中：直接用 MarkdownRenderer 渲染全部内容（保证流式体验流畅）
  if (isStreaming) {
    return <MarkdownRenderer content={content} isStreaming />;
  }

  // 完成后：提取结构化内容，分别渲染
  const { tables, images, remainingMarkdown } = extractStructuredContent(content);

  return (
    <Flex vertical gap={12}>
      {/* Markdown 文本（去除表格和图片后的内容） */}
      {remainingMarkdown && <MarkdownRenderer content={remainingMarkdown} />}

      {/* 表格用 Ant Design TableCard 渲染 */}
      {tables.map((table, idx) => (
        <TableCard key={`table-${idx}`} data={table} />
      ))}

      {/* 图片组用 GalleryCard 渲染 */}
      {images.length > 0 && (
        <GalleryCard data={{ images }} />
      )}
    </Flex>
  );
}
```

#### 3.3 extractStructuredContent 函数

纯前端 Markdown 解析函数，从 Markdown 文本中提取结构化内容：

```typescript
function extractStructuredContent(markdown: string): {
  tables: TableCardData[];
  images: Array<{ src: string; alt?: string; caption?: string }>;
  remainingMarkdown: string;
} {
  const tables: TableCardData[] = [];
  const images: Array<{ src: string; alt?: string; caption?: string }> = [];
  const remainingLines: string[] = [];

  // 逐行扫描 Markdown：
  // - 表格块（|...|...|\n|---|---|\n|...|...|）→ 提取为 TableCardData
  // - 图片行（![alt](url)）→ 提取为 GalleryCardData.images 项
  // - 其余行 → 保留到 remainingMarkdown
}
```

#### 3.4 为什么只在完成后提取，流式中不提取

- 流式输出时 Markdown 内容不完整（表格可能只有表头没有数据行），提取会失败
- Streamdown 的 `parseIncompleteMarkdown` 已经能优雅处理流式中的不完整语法
- 完成后内容稳定，可以安全解析和替换

#### 3.5 与后端 Rich Card 的关系

- 后端 `RichCardBuilder` 生成的卡片（gallery/image/video/file 等）继续通过 `cards` 字段渲染，不受影响
- 前端提取的表格/图片是对 Markdown 文本内容的增强渲染，与后端卡片互补
- 两者在视觉上并列展示，不冲突

---

## 具体文件修改清单

### 1. `AssistantMessage.tsx`
- **ToolUsePartBlock**：根据 `part.status` 切换图标和 CSS 类
- **StatusPartBlock**：移除独立折叠逻辑，始终展示完整内容
- **MessagePartsRenderer**：将 parts 分为 thinking/product 两组，thinking 组包裹在 `ThinkingProcessSection` 中
- **新增 ThinkingProcessSection**：思考过程折叠区
- **新增 ProductContentRenderer**：产物内容渲染器，完成后提取表格/图片用 Rich Card 渲染
- **新增 extractStructuredContent**：Markdown 结构化内容提取函数
- **TextPartBlock**：改用 `ProductContentRenderer` 替代直接调用 `MarkdownRenderer`

### 2. `AssistantMessage.css`
- 新增 `.assistant-tool-use--running/completed/failed` 状态样式
- 新增 `.thinking-section*` 折叠区样式
- 移除 `.assistant-status-block--collapsed` 相关样式

---

## 验证步骤

1. `npx tsc --noEmit` 无新增类型错误
2. 流式中：status/tool_use 带旋转/脉冲动画，思考过程完全展开，文本用 Streamdown 流式渲染
3. 消息完成后：思考过程自动折叠为一行摘要，点击可展开
4. 完成后的表格用 Ant Design Table 渲染（支持排序、固定表头等）
5. 完成后的连续图片用 GalleryCard 渲染（支持预览组）
6. 后端 Rich Card（video/image 等）继续正常渲染
7. 错误提示始终可见（不折叠）
