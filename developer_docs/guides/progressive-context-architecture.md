# 渐进式上下文架构设计

> 对比 Claude Code 的动态上下文机制，分析 SunPilot 的差距与演进方向。

---

## 一、两种上下文范式

### 1.1 Snapshot（快照式）— SunPilot 当前

```
ContextBuilder 在 LLM 调用前预组装全量上下文
→ 一次性打包发给 LLM
→ LLM 从给定上下文中找答案

  ┌─────────────────────────────────────┐
  │ ContextBuilder.build()              │
  │  ├── 52条对话历史 (全量)              │
  │  ├── 记忆检索 (hybrid + vector)       │
  │  ├── 全部技能目录                     │
  │  ├── 制品列表                        │
  │  ├── 工具结果                        │
  │  ├── 系统提示 + 安全策略              │
  │  └── Token预算裁剪                   │
  └──────────┬──────────────────────────┘
             │ 3.5k tokens 一次性注入
             ▼
         ┌──┴──┐
         │ LLM │
         └─────┘
```

**特点**：
- 上下文由工程管线预先决定，LLM 被动接收
- 工程上需要"猜"LLM 需要什么（对话历史、记忆、技能...）
- 永远存在"猜错"的问题——发太多浪费 token，发太少信息不足

### 1.2 Accumulation（累积式）— Claude Code

```
每轮 LLM 调用的 messages = 上一轮 messages + 本轮 tool_call + tool_result
上下文不预先组装，由 LLM 通过工具调用按需获取

  Round 1: [system] [user]                       ~500 tokens
      │ LLM: "我需要读文件 foo.ts"
      ▼
  Round 2: [system] [user] [assistant: tool_call] [tool: 文件内容]   ~2k tokens
      │ LLM: "还需要看 bar.ts 和 git log"
      ▼
  Round 3: [...上面全部...] [tool: 文件内容2] [tool: git log结果]    ~5k tokens
      │ LLM: "问题在第42行，修复如下"
      ▼
  Round 4: [...上面全部...] [assistant: 最终回答]                    ~6k tokens
```

**特点**：
- 上下文逐轮自然生长，每轮只多 2-3 条消息
- LLM 主动决定需要什么上下文，而不是被动接收
- 不需要 ContextBuilder 猜 LLM 要什么

---

## 二、核心差异对比

| 维度 | Snapshot (SunPilot) | Accumulation (Claude Code) |
|------|-------------------|--------------------------|
| **上下文来源** | 外部管线预组装 | 对话过程本身 |
| **第一轮大小** | 3.5k tokens | ~500 tokens |
| **历史消息** | 全量加载 (52条) | 为 0（每次都是新对话视角） |
| **技能/工具** | 全量 skill catalog 注入 prompt | 通用工具，LLM 已知 |
| **记忆检索** | 自动检索，注入 prompt | LLM 主动调用 search_memory |
| **文件/数据** | 无（产品搜索场景） | LLM 主动调用 read_file |
| **每轮增量** | tool_call + tool_result (相同) | tool_call + tool_result (相同) |
| **停止条件** | MAX_TOOL_ITERATIONS=5 或 LLM 停止 | LLM 自主停止，无硬上限 |
| **工程复杂度** | 高（需要构建检索管线） | 低（LLM 自己做决策） |

---

## 三、Claude Code 精要

### 3.1 第一轮极简

```
messages = [
    { role: "system", content: "你是 Claude。当前项目: SunPilot (TypeScript monorepo)。
                                你可以读取文件、搜索代码、执行命令。" },
    { role: "user",   content: "帮我修这个 bug" }
]
// ~200 tokens system + ~10 tokens user = ~210 tokens total
```

没有对话历史（每次请求是独立的）。
没有把所有文件内容注入。
没有预加载"相关代码"。
LLM 完全靠自己的判断力决定要看什么。

### 3.2 LLM 自己获取上下文

```
LLM 的决策过程完全自主：
  用户说 "修 bug"
  → LLM 想: "我需要知道是什么 bug，先看看 foo.ts"
  → LLM 调用: tool_call(read_file, "src/foo.ts")
  → 拿到文件内容
  → LLM 想: "问题在第 42 行，但我需要确认是谁引入的"
  → LLM 调用: tool_call(git_log, "src/foo.ts")
  → 拿到历史记录
  → LLM: "找到了，修复如下..."
```

**没有 ContextBuilder，没有 MemorySearch，没有 IntentRouter。** 只有 system prompt + 对话 + 工具结果。

### 3.3 Token 自然增长

```
Round 1:  210 tokens  (system + user)
Round 2:  410 tokens  (+ tool_call + tool_result: 文件内容)
Round 3:  810 tokens  (+ 又一轮 tool_call + tool_result)
Round 4: 1810 tokens  (+ tool_call + git log)
Round 5: 2200 tokens  (+ 最终回答)
```

随着轮次增长，早期轮次的 system prompt 和 tool call 逐渐被"推远"——LLM 注意力自然聚焦在最近几轮的上下文上。这就是 **recency bias 的工程化利用**。

---

## 四、SunPilot 的演进路径

### 4.1 当前架构（Snapshot）

```
用户消息
  → ContextBuilder (预组装全量上下文)
  → IntentRouter (4层级联分类)
  → ToolDecision (安全门控)
  → executeStreaming (while iter < 5)
      → LLM 调用 (含全量上下文 + 20个工具定义)
      → 工具执行
      → 注入结果
```

### 4.2 中期目标：Hybrid（混合式）

保留 IntentRouter 和 ToolDecision 的安全门控，但让第一轮 LLM 调用极简化：

```
用户消息
  → IntentRouter (保留，用于安全分类)
  → ToolDecision (保留，用于工具目录过滤)
  → executeStreaming
      → Round 1: 极简 messages (~500 tokens) + 过滤后的工具
         如果 LLM 需要更多上下文 → 调用 search_memory / search_history
      → Round 2+: 累积式
```

**具体改动**：

| 改动点 | 当前 | 目标 |
|--------|------|------|
| 第一轮历史消息 | 全量 52 条 | 最近 5 条 + 摘要 |
| Skill catalog | 全量注入 system prompt | LLM 通过 search_skills 工具按需查询 |
| 记忆 | 自动检索 + 注入 | LLM 通过 search_memory 工具按需查询 |
| System prompt | persona + rules + safety + catalog + policy (~600 tokens) | 仅 persona + rules (~150 tokens) |

### 4.3 长期目标：Accumulation（累积式）

SunPilot 完全转为累积式，ContextBuilder 退化为基础消息格式化：

```
用户消息
  → Round 1: system + user + minimal context
  → LLM 自主决策: 需要更多信息 → 调用工具
  → Round N: 累积上下文 + 工具结果 → 最终回答
```

保留的模块：
- **IntentRouter** → 安全分类（Layer 0 正则 + Layer 1 embedding），不再做 Layer 2 LLM
- **ApprovalGate** → 高危操作审批
- **PermissionPolicy** → 权限校验

退化的模块：
- **ContextBuilder** → 只构建 system prompt，不再预加载历史/记忆/技能
- **MemorySearch** → 改为工具，LLM 按需调用
- **SkillCatalog** → 改为工具，LLM 按需查询

---

## 五、关键设计决策

### 5.1 为什么 SunPilot 需要 ContextBuilder

SunPilot 是**产品搜索/图片分析 agent**，跟 Claude Code 有本质区别：

| | SunPilot | Claude Code |
|------|---------|-------------|
| **领域** | 电商/数据分析 | 通用编程 |
| **工具数量** | 5-15 个专用 skill | ~5 个通用工具 (read/write/search/bash) |
| **用户习惯** | 中老年用户，发简短指令 | 开发者，发详细需求 |
| **上下文需求** | 需要记忆（记住用户偏好、搜索习惯） | 不需要（每次独立编程任务） |

**SunPilot 不能完全去掉 ContextBuilder**——因为用户需要"记住上次搜了什么"，而 Claude Code 不需要。但可以**大幅瘦身**：

- 不加载全量对话历史 → 用摘要替代
- 不注入全量 skill catalog → LLM 按需查询
- 保留记忆检索 → 但要更精准（只加载相关的 3-5 条）

### 5.2 渐进式 vs 一次性：何时用哪种

| 场景 | 推荐策略 | 原因 |
|------|---------|------|
| **简单聊天** ("你好") | 一次性极简 context | 不需要任何工具或上下文 |
| **产品搜索** ("搜 1688 同款") | 渐进式 | 第一轮不需要历史，工具结果自然叠加 |
| **数据分析** ("最近销售趋势") | 渐进式 + 记忆注入 | 需要历史数据，但通过工具获取而非预加载 |
| **多轮偏好积累** | 混合式 | 需要记忆注入（用户偏好），但历史消息不要全发 |

---

## 六、实施路线

### Phase 1：第一轮瘦身（改动最小）

```
目标: 第一轮从 3.5k → ~1k tokens

1. buildStreamingMessages() 不加载全量历史 → 只带最近 5 条 + 摘要
2. skill catalog 不注入 system prompt → 作为独立消息，仅当 intent 需要时注入
3. MARKDOWN_RESPONSE_POLICY 移到最终回答轮
4. 系统 prompt 从 ~600 tokens 瘦到 ~150 tokens
```

### Phase 2：上下文工具化

```
目标: LLM 主动获取上下文

1. 新增工具: search_memory (记忆检索)
2. 新增工具: search_history (对话历史检索)
3. 新增工具: list_skills (技能目录查询)
4. 从 system prompt 中移除记忆/技能内容
```

### Phase 3：累积式 Loop

```
目标: 每轮上下文 = 上一轮 + 增量

1. ContextBuilder 退化为 system prompt 构建器
2. 第一轮 messages = system + user (极简)
3. 每轮追加 tool_call + tool_result
4. Token 预算限制每轮总 messages 数（超过时做 rolling truncation）
```

---

## 附录：token 增长模型对比

### Snapshot 模型

```
Token
  ^
3k│     ████████████████  ← 第一轮就 3.5k
  │     ████████████████
1k│     ████████████████
  │     ████████████████
  └─────┼────────────────→ Round
        1        2
```

### Accumulation 模型

```
Token
  ^
3k│                 ████  ← 到最后一轮才 3k
  │             ████
1k│         ████
  │     ████
  │ ██
  └─────┼────┼────┼────→ Round
        1    2    3    4
```

**累积模型的总 token 不一定少，但分布在多轮中，每轮响应更快（首 token 延迟低），LLM 注意力更集中。**
