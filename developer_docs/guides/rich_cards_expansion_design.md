# Rich Cards 扩展开发方案

更新日期：2026-06-20

本文档面向 `packages/web/src/rich-cards` 的下一轮扩展。目标不是只增加几个展示组件，而是把 Rich Card 做成 SunPilot 对话产物的结构化渲染层：能覆盖更多业务形态，能承载必要交互，能与 Streamdown 的 Markdown 流式渲染配合，并且能在卡片内部复用 Markdown/URL 语义。

## 1. 当前实现基线

### 1.1 前端入口

当前 Rich Card 主要集中在：

| 文件 | 作用 |
| --- | --- |
| `packages/web/src/rich-cards/types.ts` | 定义 `RichCardType`、`RichCardView` 和各类 `data` 结构 |
| `packages/web/src/rich-cards/RichCardRenderer.tsx` | 通过 `CARD_REGISTRY` 将 `type` 分发到具体组件，并用单卡片 ErrorBoundary 隔离失败 |
| `packages/web/src/rich-cards/MarkdownRenderer.tsx` | 包装 `Streamdown`，为普通消息提供代码块、表格、链接、图片等 Markdown 渲染 |
| `packages/web/src/pages/ChatPage/components/AssistantMessage.tsx` | 普通文本走 `ProductContentRenderer`，完成后的 `message.cards` 走 `RichCardRenderer` |
| `packages/web/src/pages/ChatPage/hooks/useChat.ts` | 在 `agent.message.completed` 事件里读取 `cards` 并写入 `ChatMessage.cards` |

现有类型已经包含 `progress`、`chart`、`summary`、`file`、`info`、`error`、`table`、`video`、`metric`、`timeline`、`code`、`gallery`、`tool_result`、`skill_result`、`diagnostic`、`status`、`link_preview`。这说明扩展点已经具备，但还缺少统一的数据契约、交互协议和卡片内部富文本能力。

### 1.2 后端卡片来源

后端侧与 Rich Card 相关的关键路径：

| 文件 | 作用 |
| --- | --- |
| `packages/core/src/agent-kernel/assistant-message-stream.ts` | `setRichCards()` 将卡片写入 `richCards`，`complete()` 时保存到 message metadata 并通过 `agent.message.completed` 发给前端 |
| `packages/core/src/agent-kernel/tools/rich-card-builder.ts` | 从 artifacts、工具结果、结构化表格等生成 RichCardView 兼容对象 |
| `packages/core/src/agent-kernel/tools/tool-decision-engine.ts` | 工具执行完成后构建 rich cards，并传给 `AssistantMessageStream` |

当前卡片不是通过 `agent.message.part.delta` 流式追加，而是在 `agent.message.completed` 时一次性到达；正文流式阶段仍由 `Streamdown` 渲染 Markdown。后续如果要支持卡片边执行边更新，需要新增 card part 或 card delta 事件，不能只改 `RichCardRenderer`。

### 1.3 当前契约漂移

扩展前建议先修正以下兼容问题，否则新增卡片会继续放大前后端偏差：

| 问题 | 位置 | 影响 | 建议 |
| --- | --- | --- | --- |
| 后端可生成 `type: "image"`，前端 `RichCardType` 没有 `image` | `rich-card-builder.ts` / `types.ts` | 单张图片卡片会落入未知类型 | 前端新增 `image`，或后端单图也统一输出 `gallery` |
| 后端 `gallery.data.items`，前端 `GalleryCardData.images` | `rich-card-builder.ts` / `MediaCards.tsx` | 多图卡片无法显示 | 前端做兼容归一化，同时后端改为 `images` |
| 后端 `metric.data` 是单个 `{ label, value }`，前端要求 `{ metrics: [] }` | `rich-card-builder.ts` / `types.ts` | 指标卡片数据结构不匹配 | 支持单指标输入归一化，后端改为数组 |
| `SkillResultCardData.steps` 前端是步骤数组，后端 `fromSkillResult.steps` 是 number | `types.ts` / `rich-card-builder.ts` | skill_result 可能渲染异常 | 后端改为步骤数组，或字段改名 `stepCount` |
| 表格单元格只按纯文本渲染 | `TableCard.tsx` | URL、Markdown 链接、强调文本无法点击或格式化 | 抽出 RichText 渲染器，表格列可声明文本模式 |

## 2. 扩展目标

本轮 Rich Card 应该形成四层能力：

1. 卡片类型更全：覆盖图表、媒体、数据表、列表、确认、步骤、审批、地图、引用、文件、商品、表单等常见对话产物。
2. 卡片可交互：不是所有卡片都只读，部分卡片需要本地状态、确认状态、选择状态、展开折叠、复制下载、播放预览、排序筛选等行为。
3. Streamdown 适配：Markdown 完成后可抽取结构化内容为卡片；流式中保持 Streamdown 稳定渲染；最终状态可将 Markdown 表格、图片、任务列表升级为 Rich Card。
4. 卡片内部富文本适配：表格、列表、描述、摘要等字段能识别 Markdown 链接、裸 URL、邮箱、文件路径、代码片段等，并渲染为可点击或有语义的节点。

## 3. 建议新增卡片类型

### 3.1 数据与图表类

| 类型 | 用途 | 关键数据 | 交互 |
| --- | --- | --- | --- |
| `bar_chart` | 直方图、横向条形图、排行 | `items[]`、`axis`、`unit`、`stacked` | tooltip、点击过滤、图例开关 |
| `pie_chart` | 饼图、占比图 | `items[]`、`totalLabel` | hover 高亮、图例切换 |
| `line_chart` | 趋势、时间序列 | `series[]`、`xAxis`、`yAxis` | 点位 tooltip、范围选择 |
| `area_chart` | 累计趋势、流量变化 | `series[]` | 同 line_chart |
| `scatter_chart` | 分布、相关性 | `points[]`、`xKey`、`yKey` | 点位详情 |
| `radar_chart` | 多维评分 | `axes[]`、`series[]` | 图例切换 |
| `heatmap` | 时间热力、矩阵评分 | `rows[]`、`columns[]`、`cells[]` | 单元格 tooltip |
| `stat_grid` | 多指标概览 | `metrics[]` | 复制值、展开解释 |
| `kpi_card` | 单指标重点展示 | `label`、`value`、`trend` | 查看来源 |

现有 `chart` 可以保留为兼容类型，但新实现建议拆成更明确的 `bar_chart`、`pie_chart`、`line_chart` 等，避免 `ChartCardData.chartType` 无限膨胀。

### 3.2 媒体与文件类

| 类型 | 用途 | 关键数据 | 交互 |
| --- | --- | --- | --- |
| `image` | 单图展示 | `src`、`alt`、`caption` | 预览、下载、复制链接 |
| `gallery` | 多图展示 | `images[]` | 预览组、轮播、选择 |
| `video` | 视频播放器 | `src`、`poster`、`tracks[]` | 播放、全屏、字幕、倍速 |
| `audio` | 音频播放器 | `src`、`duration`、`transcript` | 播放、跳转、查看转写 |
| `file_bundle` | 多文件输出 | `files[]` | 下载、复制路径、按类型过滤 |
| `pdf_preview` | PDF 或文档预览 | `src`、`pages` | 翻页、下载、打开外链 |
| `link_preview` | 链接预览 | `url`、`title`、`description`、`image` | 打开链接、复制链接 |

### 3.3 文本与知识类

| 类型 | 用途 | 关键数据 | 交互 |
| --- | --- | --- | --- |
| `rich_text` | 卡片化摘要、说明、建议 | `content`、`format` | 复制、链接点击 |
| `definition_list` | 参数、术语、配置说明 | `items[]` | 复制字段 |
| `quote_card` | 引用、证据片段 | `quote`、`source`、`url` | 打开来源 |
| `citation_list` | 多来源引用 | `items[]` | 跳转来源、复制引用 |
| `code_diff` | 代码差异 | `language`、`diff` | 展开、复制 |
| `json_viewer` | JSON/结构化响应 | `value`、`collapsedDepth` | 展开折叠、复制路径 |

### 3.4 列表与任务类

| 类型 | 用途 | 关键数据 | 交互 |
| --- | --- | --- | --- |
| `checklist` | 用户逐条确认信息 | `items[]`、`stateKey`、`required` | 勾选、全选、提交确认 |
| `action_list` | 每条带动作的建议列表 | `items[]`、`actions[]` | 执行动作、标记完成 |
| `ranked_list` | 排名、推荐、候选项 | `items[]`、`score` | 排序、展开理由 |
| `timeline` | 事件时间线 | `items[]` | 展开详情 |
| `steps` | 操作步骤、执行计划 | `steps[]` | 展开、完成标记 |
| `approval_summary` | 权限/风险审批摘要 | `items[]`、`riskLevel` | 同意、拒绝、查看详情 |

### 3.5 表格与数据集合类

| 类型 | 用途 | 关键数据 | 交互 |
| --- | --- | --- | --- |
| `table` | 通用表格 | `columns[]`、`rows[]` | 排序、筛选、分页 |
| `comparison_table` | 多方案对比 | `subjects[]`、`criteria[]` | 高亮差异、选择方案 |
| `product_grid` | 商品/供应商搜索结果 | `items[]` | 收藏、查看详情、打开链接 |
| `record_card` | 单条业务记录 | `fields[]` | 复制字段、打开详情 |
| `kanban` | 分组状态列表 | `columns[]`、`cards[]` | 拖拽可后置，先只读 |

### 3.6 表单与选择类

| 类型 | 用途 | 关键数据 | 交互 |
| --- | --- | --- | --- |
| `choice_group` | 单选/多选确认 | `options[]`、`mode` | 选择、提交 |
| `form_card` | 少量字段采集 | `fields[]`、`submit` | 输入、校验、提交 |
| `rating_card` | 评分反馈 | `scale`、`labels` | 打分、提交 |
| `date_picker_card` | 日期/时间选择 | `mode`、`min`、`max` | 选择、提交 |

这些交互型卡片需要明确“本地 UI 状态”和“已提交业务状态”的边界，不能只依赖 React 组件内部 `useState`。

## 4. 类型系统设计

### 4.1 RichCardView 元数据

建议把 `RichCardView` 从单一 `data` 包装扩展为稳定协议：

```ts
export interface RichCardView<TData = unknown> {
  id: string;
  type: RichCardType;
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: TData;
  version?: 1;
  layout?: {
    density?: "compact" | "comfortable";
    width?: "message" | "wide";
  };
  interaction?: RichCardInteraction;
  metadata?: {
    source?: "model" | "tool" | "artifact" | "markdown";
    runId?: string;
    toolCallId?: string;
    artifactIds?: string[];
  };
}
```

`title` 和 `subtitle` 也建议支持 `RichTextValue`，这样后端可以传 Markdown 链接或文件名，前端仍能统一渲染。

### 4.2 交互协议

交互状态建议分三类：

| 状态层 | 存储位置 | 适用场景 |
| --- | --- | --- |
| 临时 UI 状态 | 卡片组件内部 `useState` | 展开折叠、hover、播放、当前页码 |
| 会话内确认状态 | `RichCardRenderer` 上层的 `cardStateById` 或 `useChat` 状态 | checklist 勾选、选择项、用户已读确认 |
| 后端持久状态 | 新增 card action 事件或 REST/RPC | 审批通过、确认条款、提交表单、执行动作 |

建议新增统一事件：

```ts
export type RichCardAction =
  | {
      type: "toggle_item";
      cardId: string;
      itemId: string;
      checked: boolean;
    }
  | {
      type: "submit";
      cardId: string;
      payload: Record<string, unknown>;
    }
  | {
      type: "open_link";
      cardId: string;
      url: string;
    };

export interface RichCardRendererProps {
  cards?: RichCardView[];
  stateByCardId?: Record<string, unknown>;
  onAction?: (action: RichCardAction) => void;
}
```

第一阶段可以只在前端记录 checklist 的勾选状态；第二阶段再把 `submit` 通过 JSON-RPC 或 REST 发送给 daemon。

### 4.3 Checklist 数据结构

带确认框的分条列表建议定义为：

```ts
export interface ChecklistCardData {
  items: Array<{
    id: string;
    label: RichTextValue;
    description?: RichTextValue;
    checked?: boolean;
    required?: boolean;
    disabled?: boolean;
    evidence?: RichTextValue;
  }>;
  mode?: "local" | "submit";
  submitLabel?: string;
  requireAll?: boolean;
  confirmationText?: RichTextValue;
}
```

行为规则：

1. 每条 item 必须有稳定 `id`，不能用数组下标作为确认记录。
2. `checked` 是初始状态；用户点击后写入 `stateByCardId[card.id].checkedItemIds`。
3. `mode: "local"` 表示勾选即记录在前端消息状态中；`mode: "submit"` 表示点击提交后才触发后端动作。
4. `required` 项未确认时，提交按钮禁用。
5. disabled 项只展示状态，不允许用户改写。

## 5. Rich Card 内部 Markdown/URL 适配

### 5.1 问题

`MarkdownRenderer` 已经能把普通消息中的 `[链接](https://example.com)` 渲染成可点击链接；但 `TableCard` 当前直接把 cell 值交给 Ant Design Table，单元格中的 URL 或 Markdown 链接会变成普通字符串。这会造成同一条回复里 Markdown 表格可点击、Rich Card 表格不可点击的体验割裂。

### 5.2 RichTextValue

建议新增轻量富文本模型：

```ts
export type RichTextValue =
  | string
  | {
      text: string;
      format?: "plain" | "markdown" | "auto";
      href?: string;
      tone?: "default" | "muted" | "success" | "warning" | "danger";
    };
```

渲染优先级：

1. `href` 存在：渲染为链接。
2. `format: "markdown"`：使用受限 Markdown 渲染。
3. `format: "auto"` 或普通字符串：自动识别裸 URL、Markdown 链接、邮箱、行内代码。
4. `format: "plain"`：纯文本，不做链接化。

### 5.3 RichTextRenderer

建议在 `packages/web/src/rich-cards/components/RichTextRenderer.tsx` 新增组件，供所有卡片复用：

```ts
export function RichTextRenderer({
  value,
  inline = true,
}: {
  value?: RichTextValue;
  inline?: boolean;
}) {
  // 1. normalize value
  // 2. parse markdown links: [label](url)
  // 3. linkify bare URLs
  // 4. render safe React nodes
}
```

实现边界：

1. 表格单元格默认使用 `inline=true`，只允许链接、加粗、行内代码、换行。
2. 卡片正文可使用 `inline=false`，允许列表、段落、引用。
3. 不直接把后端 HTML 注入 DOM，不使用 `dangerouslySetInnerHTML`。
4. 链接统一加 `target="_blank"` 和 `rel="noopener noreferrer"`。
5. URL 识别应处理尾随标点，例如 `https://a.com,` 中逗号不属于链接。

### 5.4 表格列级配置

`TableCardData` 建议扩展：

```ts
export interface TableCardData {
  columns: Array<{
    key: string;
    label: RichTextValue;
    type?: "text" | "number" | "link" | "markdown" | "badge" | "image" | "actions";
    width?: number;
    sortable?: boolean;
  }>;
  rows: Array<Record<string, RichTextValue | number | boolean | null>>;
  pagination?: false | { pageSize?: number };
}
```

`TableCard` 里根据 `column.type` 选择 render：

| type | 渲染 |
| --- | --- |
| `text` | `RichTextRenderer` 自动识别链接 |
| `markdown` | `RichTextRenderer` 受限 Markdown |
| `link` | 值为 URL 时直接可点击，值为 `{ text, href }` 时显示 text |
| `number` | 右对齐，可显示单位 |
| `badge` | 状态 Tag |
| `image` | 缩略图 |
| `actions` | 按钮组，触发 `onAction` |

## 6. Streamdown 适配方案

### 6.1 保持流式阶段稳定

当前 `ProductContentRenderer` 在 `isStreaming` 时直接将完整内容交给 `MarkdownRenderer`，完成后才提取 Markdown 表格和图片为 Rich Card。这个方向是正确的：流式阶段 Markdown 可能不完整，过早抽卡容易导致布局跳动和解析错误。

建议保留规则：

1. 流式中只用 Streamdown 渲染文本，不做卡片抽取。
2. 完成后执行结构化抽取，生成 `markdown-derived` cards。
3. 抽取后的剩余 Markdown 继续由 `MarkdownRenderer` 渲染。

### 6.2 抽取器升级

当前 `extractStructuredContent()` 只支持简单表格和单行图片。建议改为独立模块：

```text
packages/web/src/rich-cards/markdown/
├── extractMarkdownCards.ts
├── parseMarkdownTable.ts
├── parseMarkdownImages.ts
├── parseMarkdownTaskList.ts
└── types.ts
```

第一阶段支持：

| Markdown 输入 | Rich Card 输出 |
| --- | --- |
| Markdown table | `table` |
| `![alt](src)` 连续图片 | `gallery` |
| `- [ ] item` / `- [x] item` | `checklist` |
| 裸 URL 独立一行 | `link_preview` |
| fenced `json` 且为数组对象 | `table` 或 `json_viewer` |
| fenced `diff` | `code_diff` |

注意：任务列表在普通 Markdown 里可以继续展示成视觉 checkbox，但如果要记录用户确认状态，应升级为 `checklist` Rich Card，而不是复用 Streamdown 的静态 task list。

### 6.3 Streamdown 组件补齐

`MarkdownRenderer.tsx` 里已经定义了 `TaskListItem`，但当前 `markdownComponents` 没有覆盖 `li`，因此 task list 的自定义 checkbox 样式未真正挂上。建议：

1. 确认 Streamdown 对 task list 的组件参数格式。
2. 将 `li` 接入 `TaskListItem`，或按 Streamdown 官方支持方式接入 task list renderer。
3. 普通 Markdown task list 仍只读；可交互确认走 `checklist` card。

### 6.4 卡片 DSL 可选方案

如果后续希望模型直接输出卡片，可支持 fenced block：

````markdown
```sunpilot-card
{
  "type": "checklist",
  "title": "请确认订单信息",
  "data": {
    "items": [
      { "id": "sku", "label": "SKU 已确认", "required": true }
    ],
    "mode": "submit"
  }
}
```
````

这类 DSL 必须只在最终完成态解析，且需要 JSON schema 校验；解析失败时回退成普通代码块。

## 7. 组件拆分建议

为了避免 `MediaCards.tsx` 和 `ChartCard.tsx` 继续膨胀，建议目录改为：

```text
packages/web/src/rich-cards/
├── RichCardRenderer.tsx
├── MarkdownRenderer.tsx
├── types.ts
├── registry.ts
├── richText/
│   ├── RichTextRenderer.tsx
│   ├── linkify.ts
│   └── types.ts
├── markdown/
│   ├── extractMarkdownCards.ts
│   └── parseMarkdownTable.ts
├── components/
│   ├── data/
│   │   ├── TableCard.tsx
│   │   ├── BarChartCard.tsx
│   │   └── PieChartCard.tsx
│   ├── media/
│   │   ├── ImageCard.tsx
│   │   ├── GalleryCard.tsx
│   │   └── VideoCard.tsx
│   ├── interactive/
│   │   ├── ChecklistCard.tsx
│   │   ├── ChoiceGroupCard.tsx
│   │   └── FormCard.tsx
│   └── system/
│       ├── ToolResultWidget.tsx
│       └── SkillResultWidget.tsx
└── __tests__/
    ├── RichTextRenderer.test.tsx
    ├── TableCard.test.tsx
    └── extractMarkdownCards.test.ts
```

`registry.ts` 负责维护 `RichCardType -> renderer`，`RichCardRenderer.tsx` 只做容器、错误隔离、状态分发。

## 8. 后端协议同步

### 8.1 共享类型

目前前端 `RichCardType` 和后端 `RichCardOutput.type` 没有共享强类型。建议将 Rich Card schema 提到共享包，例如：

```text
packages/protocol/src/rich-cards.ts
```

然后前后端分别引用：

| 包 | 引用 |
| --- | --- |
| `packages/core` | 构建、校验、发送卡片 |
| `packages/web` | 渲染、交互、测试 |
| `packages/protocol` | 类型和 schema 单一来源 |

如果暂时不移动类型，也至少要在 `rich-card-builder.ts` 中增加单元测试，覆盖前端已支持类型的数据形状。

### 8.2 事件协议

短期保持：

```text
agent.message.completed.params.cards
```

中期新增交互动作：

```text
rich_card.action
```

建议 payload：

```ts
{
  conversationId: string;
  messageId: string;
  cardId: string;
  action: RichCardAction;
}
```

长期如需流式卡片更新，可新增：

| 事件 | 用途 |
| --- | --- |
| `agent.message.card.started` | 创建卡片占位 |
| `agent.message.card.updated` | patch 卡片 data 或 interaction state |
| `agent.message.card.completed` | 卡片完成 |

这一步会影响 `useChat.ts` 的消息归并逻辑，建议等只读和本地交互卡片稳定后再做。

## 9. 实施路线

### Phase 1：契约修正与富文本底座

1. 修正 `image/gallery/metric/skill_result` 的前后端数据契约。
2. 新增 `RichTextValue`、`RichTextRenderer`、`linkify`。
3. 改造 `TableCard`、`SummaryCard`、`InfoCard`、`TimelineCard` 等文本字段使用 `RichTextRenderer`。
4. 为表格单元格 URL、Markdown 链接、邮箱、行内代码加测试。

验收标准：

1. Rich Card 表格中的 `https://example.com` 可点击。
2. Rich Card 表格中的 `[官网](https://example.com)` 显示为“官网”并可点击。
3. 原普通 Markdown 链接渲染不回退。
4. 后端 builder 生成的 `gallery`、`metric` 能被前端正常显示。

### Phase 2：新增展示型卡片

优先实现：

1. `image`
2. `bar_chart`
3. `pie_chart`
4. `line_chart`
5. `audio`
6. `file_bundle`
7. `record_card`
8. `comparison_table`
9. `json_viewer`
10. `code_diff`

图表可以先用 CSS/SVG/Ant Design 基础组件实现，避免引入重型图表库；当需求进入复杂交互图表时再评估 `echarts` 或 `recharts`。

### Phase 3：新增交互型卡片

优先实现：

1. `checklist`
2. `choice_group`
3. `approval_summary`
4. `action_list`
5. `rating_card`

第一阶段交互只在本地记录；第二阶段为 `submit` 类动作接入后端事件。Checklist 是最小闭环：用户勾选某条确认项，前端状态立即变化，并能在同一消息生命周期内记住已确认项目。

### Phase 4：Markdown 抽取升级

1. 将 `AssistantMessage.tsx` 内的 `extractStructuredContent()` 移到 `rich-cards/markdown`。
2. 使用更稳健的 Markdown 解析器或最小 AST 解析，而不是继续手写行级 split。
3. 完成态将 Markdown task list 抽成 `checklist`。
4. 完成态将连续图片抽成 `gallery`，将表格抽成 `table`。
5. 为 streaming/static 两种路径分别加测试。

### Phase 5：协议共享与后端生成

1. 将 Rich Card schema 移入 `packages/protocol`。
2. 后端 `RichCardBuilder` 增加更多 builder 方法。
3. 工具结果和 artifacts 按 schema 输出。
4. 对来自模型的 card DSL 做 schema 校验和失败回退。

## 10. 测试建议

### 10.1 单元测试

| 测试 | 覆盖 |
| --- | --- |
| `RichTextRenderer.test.tsx` | URL 自动链接、Markdown 链接、邮箱、行内代码、纯文本模式 |
| `TableCard.test.tsx` | 列类型、链接单元格、空值、排序分页 |
| `ChecklistCard.test.tsx` | 勾选、必选项、disabled、submit payload |
| `extractMarkdownCards.test.ts` | 表格、图片、task list、代码块回退 |
| `RichCardRenderer.test.tsx` | 未知类型、缺失 id、单卡片错误隔离 |

### 10.2 集成测试

| 测试 | 覆盖 |
| --- | --- |
| `useChat.test.ts` | `agent.message.completed.cards` 写入消息、保留已有 cards |
| ChatPage 渲染测试 | 完成态 Markdown 表格升级为 table card |
| 后端 builder 测试 | `RichCardBuilder` 输出与前端 schema 对齐 |

### 10.3 验证命令

```bash
pnpm --filter @sunpilot/web test
pnpm --filter @sunpilot/web build
pnpm --filter @sunpilot/core test -- rich-card
git diff --check
```

如果本轮只改前端，可先跑 web 测试和构建；如果同步修改后端 schema/builder，再补 core 测试。

## 11. 关键设计取舍

### 11.1 不把所有 Markdown 都变成卡片

普通 Markdown 仍适合叙述、解释、短代码、简单列表。Rich Card 应用于结构化、可操作、可预览、可确认、可复用的数据。否则会让对话页过度卡片化，阅读成本变高。

### 11.2 交互型卡片必须有稳定 id

Checklist、choice、form、approval 这类卡片不能依赖数组下标保存状态。后端必须提供稳定 `card.id` 和 `item.id`；前端 fallback id 只适合只读展示，不适合可提交交互。

### 11.3 卡片内部富文本应受限

Rich Card 内部需要链接和轻量格式，但不需要完整 Markdown 文档能力。表格单元格里允许标题、图片、复杂列表会破坏密度和可读性；应限制为 inline rich text。

### 11.4 Streamdown 继续负责流式正文

Streamdown 的价值在于流式 Markdown 容错。Rich Card 的价值在于完成态结构化和交互。两者应该协作，而不是互相替代。

## 12. 推荐优先级

最高优先级：

1. 修正前后端 Rich Card 契约漂移。
2. 增加 `RichTextRenderer`，解决表格和卡片内部链接不可点击。
3. 实现 `checklist`，建立交互型卡片的最小闭环。
4. 将 Markdown task list、table、image 的完成态抽取迁移到独立模块。

随后再扩展图表和媒体矩阵：

1. `bar_chart`
2. `pie_chart`
3. `line_chart`
4. `image`
5. `audio`
6. `file_bundle`
7. `comparison_table`
8. `json_viewer`

这样推进能先解决用户可感知的真实缺口：链接可点击、确认可记录、后端生成可显示；再逐步扩展视觉和业务覆盖面。
