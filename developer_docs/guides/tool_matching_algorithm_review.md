# SunPilot 上下文构建与记忆体系审查

更新时间：2026-06-17
审查对象：当前本地代码中的 `ContextBuilder`、`ContextBudgeter`、`SummaryStaleDetector`、`DefaultMemoryWriter`、`DefaultMemoryPolicy`、`PostgresMemoryRepository`、`LlmEmbeddingService` 及 daemon composition 接线。

> 文件名沿用 `tool_matching_algorithm_review.md`，但本文已覆盖为上下文构建、记忆写入、记忆检索和治理闭环审查。

## 总体结论

SunPilot 当前上下文与记忆体系的架构方向和主流 agent runtime 方案没有明显偏离。

它已经不是简单的“把最近几轮历史消息拼进 prompt”，而是逐步形成了主流 agent 系统常见的两条主链路：

```text
Context Engineering
  system + safety + current user message
  -> compressed history summaries
  -> scoped memory recall
  -> artifacts / observations / skill catalog / run state
  -> trust metadata + token budget + context snapshot

Memory
  explicit / intent / task-summary candidates
  -> secret redaction
  -> policy classify create/supersede/reject
  -> quality + relation metadata
  -> scoped Postgres/pgvector hybrid retrieval
  -> context injection
```

和 OpenAI Agents SDK、LangChain/LangGraph、MCP 等主流方案相比，SunPilot 的大方向是对的：它拥有显式上下文块、短期历史压缩、长期记忆、scope 隔离、trust metadata、token budget、Postgres/pgvector 检索、trace/debug 基础。主要差距不在架构范式，而在生产级细节：context eval、memory provenance、trust enforcement、summary 生命周期、memory quality ranking、用户反馈治理。

一句话判断：

```text
上下文构建：方向正确，已进入 context engineering 阶段；还需加强 trust enforcement、summary stale 接线和 context eval。
记忆系统：底座较强，具备 scope、hybrid recall、quality、supersede；还需把质量、反馈、来源证据真正接到回答和治理闭环。
```

## 主流架构基准

本次对照的主流基准：

- OpenAI Agents SDK 强调 agent runtime 需要模型、状态、guardrails、tracing、外部能力调用记录等组成；当应用自己拥有 orchestration、approvals、state 时，需要把上下文与状态作为一等公民管理。
- LangChain/LangGraph 把 context engineering 定义为给模型提供正确的信息，并以正确格式组织；常见策略是 write、select、compress、isolate。
- LangGraph 短期记忆通常在 thread/checkpoint state 中维护，长期记忆进入跨 thread/store。
- MCP 标准把外部资源、提示、能力描述标准化；对 SunPilot 来说，更重要的是让上下文来源、资源元数据和证据链保持可发现、可追溯。

一个主流生产级 agent core 通常会有：

| 维度 | 主流做法 |
|---|---|
| Context | 多源上下文选择、压缩、隔离、trust/provenance、token budget、可回放 snapshot |
| Memory | scoped short/long-term memory，write-manage-read loop，质量/置信/时间衰减，矛盾处理，用户治理 |
| State | run/thread checkpoint、resume、approval continuation、model/trace 记录 |
| Eval | context retention eval、memory precision/recall eval、summary stale eval、scope isolation eval |

SunPilot 当前基本站在这条路线上。

## 当前实现概览

### 1. 上下文构建

#### 1.1 架构总览

核心文件：

| 文件 | 职责 |
|---|---|
| `packages/core/src/agent-kernel/context/context-builder.ts` | 统一上下文组装管线，从多数据源收集 → 打包 → 预算裁剪 → 输出 AgentContext |
| `packages/core/src/agent-kernel/context/context-types.ts` | `ContextChunk` 类型定义、TrustLevel、TRIM_ORDER、MANDATORY_SOURCES、token 估计算法 |
| `packages/core/src/agent-kernel/context/context-budgeter.ts` | Token 预算控制器：mandatory/optional 分离 → trim priority 排序 → 贪心裁剪 |
| `packages/core/src/agent-kernel/context/summary-stale-detector.ts` | Summary 过期检测：goal-change / correction / fact-change / preference-conflict 四维判断 |
| `packages/daemon/src/composition-root.ts` | DI 接线：将各 data source 实现注入 ContextBuilder |

当前 `ContextBuilder.build()` 的数据流：

```text
                        ┌─────────────────────────────────┐
                        │     ContextBuilder.build()       │
                        │     (context-builder.ts:124)     │
                        └──────────────┬──────────────────┘
                                       │
          ┌────────────────────────────┼────────────────────────────┐
          │                            │                            │
          ▼                            ▼                            ▼
  ┌──────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
  │  Mandatory (P0)  │     │   Scoped Retrieval   │     │   Catalog / State    │
  │  never trimmed   │     │   priority 8-25      │     │   priority 0-20      │
  ├──────────────────┤     ├──────────────────────┤     ├──────────────────────┤
  │ system persona   │     │ conversation summary  │     │ skill catalog (P20)  │
  │ system rules     │     │ raw history (P10)     │     │ artifacts (P25)      │
  │ safety policy    │     │ memories (P15)        │     │ tool results (P18)   │
  │ current message  │     │   ├─ hybrid search    │     │ run state (P0)       │
  │ external attach  │     │   └─ vector recall    │     │                      │
  │ run state        │     │   → merge + top-15    │     │                      │
  └────────┬─────────┘     └──────────┬───────────┘     └──────────┬───────────┘
           │                          │                            │
           └──────────────────────────┼────────────────────────────┘
                                      │
                                      ▼
                        ┌─────────────────────────────┐
                        │     TokenBudgeter.apply()   │
                        │     (context-budgeter.ts)   │
                        │                             │
                        │  mandatory → always keep    │
                        │  optional → sort by:        │
                        │   1. TRIM_ORDER index       │
                        │   2. explicit priority      │
                        │  → greedy fill to budget    │
                        └─────────────┬───────────────┘
                                      │
                                      ▼
                        ┌─────────────────────────────┐
                        │       AgentContext          │
                        │  + contextSnapshot          │
                        │    (included/excluded list) │
                        └─────────────────────────────┘
```

ContextChunk 类型体系（`context-types.ts`）：

| 字段 | 类型 | 用途 |
|---|---|---|
| `source` | 11 种枚举值 | 标识数据来源（system / memory / external / …） |
| `priority` | `number` | 0 = mandatory（不可裁剪），越大越容易被裁剪 |
| `tokenEstimate` | `number` | `Math.ceil(content.length / 4)`，用于预算计算 |
| `trust` | `TrustLevel` | 5 级可信度：system → user → memory → tool → external → untrusted |
| `authority` | `number` | 权威等级，越高越权威（system=10） |
| `sourceUri` | `string?` | 来源 URI，如 `memory:<id>`、`tool_call:<id>` |
| `metadata` | `Record<string, unknown>` | 携带 source-specific 元数据（messageId, confidence, scope 等） |
| `expiresAt` / `generatedAt` | `string?` | 时效性标记（已定义但尚未充分利用） |
| `blocked` / `warning` | `boolean?` / `string?` | safety 标记（已定义，当前仅 external 片段使用 warning） |

#### 1.2 做得比较好的方面

**1. 上下文源已完整建模为 ContextChunk**

每个 chunk 自带 source、priority、trust、sourceUri、metadata，形成了可审计的上下文来源追踪基础。这比"把所有东西拼成一个大字符串"先进一个阶段 — 它让 token budget、debug panel、provenance trace 都可以按 chunk 粒度操作。

**2. Mandatory/optional 分离 + 二级排序裁剪**

`TokenBudgeter.apply()`（`context-budgeter.ts:27`）的策略是：
1. 先捞出 `MANDATORY_SOURCES`（system / current_message / safety_policy / run_state），永远不裁剪
2. optional chunk 按 `TRIM_ORDER` 索引（第一排序键）+ `priority`（第二排序键）排列
3. 贪心填充到 `maxTokens - reservedForOutput`

这比简单保留最近 N 条的策略更精细：低优先级但高价值的 chunk（如 summary）可以比高优先级但低价值的 chunk（如旧 history）活得更久。

**3. 双路 Memory Recall + 去重**

`ContextBuilder.build()` 中 memory 检索是两轮（`context-builder.ts:359-398`）：
- **Pass 1**：Hybrid search（keyword + embedding），limit=10，走 ILIKE pre-filter + pgvector
- **Pass 2**：Pure vector recall（embedding only, empty query），limit=5，跳过 ILIKE pre-filter
- 去重合并（hybrid ID 预填入 `seenIds`，vector recall 无法注入重复条目）后按 score 降序取 top-15

这有效覆盖了"语义相近但词法不同"的记忆，是比单纯 keyword search 更完整的方案。

**4. Summary 压缩历史 + type/scopes 直取**

Conversation summary 通过 `types: ["conversation_summary"]` + `scopes: ["conversation"]` 直接从 Postgres 检索（跳过 ILIKE 预过滤），通过 `messageRange` 标记覆盖的消息 ID 范围（`context-builder.ts:253-303`），被覆盖的原始消息不再进入 context，由 summary 替代。这比"永远保留最近 N 条"或"靠 query 字符串匹配 summary"在真实 DB 环境下更可靠。

**5. contextSnapshot 已有基础（已补全）**

`build()` 末尾（`context-builder.ts:546-566`）已记录 included/excluded chunk 列表，含 `trust`、`sourceUri`、`score`、`warning` 字段，是 debug panel 和 provenance trace 的直接数据来源。

**6. SummaryStaleDetector 已完整接入**

四维 stale 检测（goal-change / correction / fact-change / preference-conflict）已通过 `ContextBuilderDeps.staleDetector` 接入 `build()` 主链路，severity → priority 映射：critical→14, warning→12, info→8。Stale summary 携带 `warning` 和具体原因文本。

**7. Per-source 内容截断已实施**

在 token budget 裁剪前对 `tool_result`（2000 chars）、`artifact`（1000 chars）、`memory`（800 chars）、`conversation_history`（4000 chars）做 source-specific 截断，被截断的 chunk 打上 `metadata.truncated = true` 标记。

**8. Context golden tests 已建立**

6 个场景的 golden tests 覆盖：长对话压缩、用户纠正、外部注入、预算裁剪、scope 隔离、stale summary。
- 去重合并后按 score 降序取 top-15

这有效覆盖了"语义相近但词法不同"的记忆，是比单纯 keyword search 更完整的方案。

**4. Summary 压缩历史**

Conversation summary 通过 `messageRange` 标记覆盖的消息 ID 范围（`context-builder.ts:253-303`），被覆盖的原始消息不再进入 context，由 summary 替代。这比"永远保留最近 N 条"在 token 效率上有显著提升。

**5. contextSnapshot 已有基础**

`build()` 末尾（`context-builder.ts:546-566`）已记录 included/excluded chunk 列表和 trim reason，这是 debug panel 和 provenance trace 的直接数据来源。

#### 1.3 主要差距与具体分析

**Gap 1 — Trust 停留在 prompt 约束层面，不是强 enforcement**  *(P1 — 进行中)*

- **现状**：`trust` 字段已写入 chunk metadata 和 snapshot。`appendAttachmentLines` 在 direct/no-tool 路径也加了 `[EXTERNAL — unverified source]` 前缀。但 enforcement 仍依赖 prompt 提示词。
- **剩余差距**：在 context assembly 阶段未将不同 trust level 的内容物理隔离到不同 message section；ResponseComposer 未要求对 memory/external 来源引用携带 sourceUri citation。

**Gap 2 — SummaryStaleDetector** ✅ 已完成

- **已修复**：四维检测（goal-change / correction / fact-change / preference-conflict）已通过 `ContextBuilderDeps.staleDetector` 完整接入 `build()`。Severity → priority 映射：critical→14, warning→12。Stale summary 携带 `warning` 和具体原因。`composition-root.ts` 已注入 `SummaryStaleDetector` 实例。

**Gap 3 — Token budget 内容级压缩** ✅ 已完成

- **已修复**：在 token budget 裁剪前实施 per-source 截断：`tool_result`（2000 chars）、`artifact`（1000 chars）、`memory`（800 chars）、`conversation_history`（4000 chars）。被截断 chunk 打上 `metadata.truncated = true`。
- **剩余差距**：暂无细粒度 projection（如只保留特定 JSON 字段）；embedding-based relevance scoring 作为第三排序键尚未实施。

**Gap 4 — Context eval 体系** ✅ 已完成

- **已修复**：6 个 golden test 场景覆盖：长对话压缩、用户纠正、外部注入、预算裁剪、scope 隔离、stale summary。`context-builder.test.ts` 从 3 个测试扩展到 9 个。

**Gap 5 — contextSnapshot 信息** ✅ 已完成

- **已修复**：snapshot 现在记录 `trust`、`sourceUri`、`score`、`warning` 字段。

**Gap 6 — Summary recall 在真实 DB 下失效** ✅ 已修复

- **已修复**：`ContextBuilder` 改用 `types: ["conversation_summary"]` + `scopes: ["conversation"]` 直取 summary，不再依赖 ILIKE 匹配 query 字符串。`ContextBuilderDeps.searchMemories` 和 daemon wrapper 已扩展支持 `types`/`scopes` 透传。

**Gap 7 — Memory hybrid+vector 去重未生效** ✅ 已修复

- **已修复**：`seenIds` 现在预填入 `new Set(hybridMemories.map(m => m.id))`，确保 vector recall 无法注入 hybrid 已有记录的重复条目。

#### 1.4 优化建议 *(2026-06-17 更新 — 仅剩余项)*

✅ 已完成的 P0 项：SummaryStaleDetector 接入、context golden tests（7 场景）、contextSnapshot 补全、summary type/scopes 直取、memory dedup、per-source 截断、expiresAt/generatedAt 生命周期、当前消息参与 stale 检测。

| 优先级 | 建议 | 改动范围 | 预估工作量 |
|---|---|---|---|
| **P1** | Trust-based 上下文隔离：untrusted content 物理分区 | `response-composer.ts`：将 external/memory 来源放入独立 `<untrusted_data>` message section，要求 citation | 中（~100 行） |
| **P1** | Memory quality scoring 真正影响 recall | Postgres `search()` score 接入 `quality.score`、`userConfirmed`、`sourceCredibility` | 中（~80 行） |
| **P2** | Embedding-based context relevance scoring | 对 memory/tool_result chunk 做 embedding 相似度打分，作为 TokenBudgeter 第三排序键 | 中（~120 行） |
| **P2** | 在 RunDebugPanel 展示 contextSnapshot 的 trust / sourceUri / trim reason | `RunDebugPanel.tsx`：渲染 snapshot 详情 | 中（~200 行） |
| **P2** | Memory governance 闭环 | 用户确认/删除/纠错 → repository metadata → consolidation 任务 | 大（~400 行） |

### 2. 记忆系统

核心文件：

- `packages/core/src/agent-kernel/memory/memory-writer.ts`
- `packages/core/src/agent-kernel/memory/memory-policy.ts`
- `packages/core/src/agent-kernel/memory/secret-redactor.ts`
- `packages/storage/src/postgres/postgres.memory.repository.ts`
- `packages/storage/src/repositories/memory.repository.ts`
- `packages/daemon/src/composition-root.ts`

当前写入流程：

```text
extract candidates
  explicit remember
  memory_update intent
  completed task / forced / rolling conversation summary

secret scan
  reject secret-like content

similar search
  scope-aware search
  type-aware search

policy decision
  create
  supersede
  reject
  contradiction handling

quality + relations
  source credibility
  confidence / importance
  evidence
  confirmedBy / contradicts

repository write
  Postgres memory_metadata
  pgvector embedding
  scope / type / metadata
```

当前读取流程：

```text
ContextBuilder
  -> searchMemories(query + embedding, limit 10)
  -> searchMemories(empty query + embedding, limit 5)
  -> merge/dedupe
  -> sort by score
  -> inject top 15 as memory chunks
```

Postgres 检索已经包含：

- scope isolation：global/user/project/conversation/run 可见性。
- deleted/superseded/expired 过滤。
- keyword score + semantic score + quality score。
- pure vector recall 时跳过 ILIKE pre-filter。

做得比较好的地方：

- 记忆不再是纯聊天历史，有明确 scope/type/source/confidence/importance。
- 写入前有 secret redaction。
- 有 contradiction/supersede 的 policy 框架。
- 有 conversation_summary，且 summary 带 messageRange，可用于压缩历史。
- repository 支持 hybrid 和 vector recall。
- 有 governance API/UI 的基础。

主要问题：

1. memory quality 和 relation 还没有充分影响 recall。

   Repository 的 score 目前主要使用 `importance`、`confidence`、recency，没有直接展开 `quality.score`、`quality.sourceCredibility`、`relations`、用户确认状态等结构化字段。

2. memory provenance 到最终回答还不够强。

   `ContextBuilder` 把 `sourceUri: memory:<id>` 放进 chunk，但最终回答是否引用了哪条 memory、是否可在 UI 中追溯，还需要更完整的 response provenance。

3. 记忆写入仍偏启发式。

   explicit memory 和 task summary 比较可靠，但“什么值得长期记忆”还主要靠关键词/反射结果。成熟方案通常会有更明确的 memory extraction prompt、schema、review/feedback、自动 stale/supersede 任务。

4. conversation summary 的生命周期还需要治理。

   当前 summary 能压缩历史，但 regenerate、stale mark、summary chain、summary version merge 还不够完整。

5. embedding fallback 对 memory recall 的语义能力有限。

   如果没有真实 embedding provider，memory search 的 semantic term 会退化成 lexical/hash signal。它可用，但不能按真正语义记忆来评估。

建议优先级：

| 优先级 | 建议 |
|---|---|
| P0 | 增加 memory eval：write precision、recall hit rate、contradiction handling、stale summary、scope isolation |
| P0 | 回答中记录 memory provenance：哪些 memory 被使用、哪些被忽略、最终回答引用了哪些 |
| P1 | Repository scoring 接入 `quality.score`、userConfirmed、sourceCredibility、relations/conflict 状态 |
| P1 | 将 `SummaryStaleDetector` 与 summary 更新/标记 stale API 串起来 |
| P1 | 为 memory extraction 增加结构化 schema 和 LLM candidate extraction，而不只靠关键词 |
| P2 | 支持 periodic consolidation：合并重复记忆、清理低质量记忆、提升用户确认记忆 |

## 与主流方案差距

### 不大的部分

以下方面 SunPilot 和主流方案差距不大，属于同一架构路线：

- 上下文不是裸 prompt，而是分 source、priority、trust、budget。
- 记忆是 scoped store，不是单纯 conversation buffer。
- Postgres + pgvector 支撑 local-first state/memory 是合理选择。
- 事件、trace、model calls、plan snapshots 等可观测性正在形成。
- summary compression 和 memory recall 已经进入 agent runtime 主链路。

### 差距明显的部分

| 维度 | 当前差距 | 影响 |
|---|---|---|
| Eval | context/memory eval 还不够体系化 | 很难知道召回、摘要、裁剪是否真的稳定 |
| Provenance | context/memory 证据没有完整贯穿到最终回答和 UI | 用户难以判断回答用了什么来源 |
| Trust enforcement | trust 多数是提示约束 | untrusted 内容隔离不够硬 |
| Memory feedback | 用户确认、纠错、删除、stale 与 ranking 没完全闭环 | 记忆会随时间漂移 |
| Summary lifecycle | stale、regenerate、merge、version 还不完整 | 长线程容易被旧摘要带偏 |
| Compression | 主要是 summary + chunk trimming | 对超长 observation / artifact / memory 的细粒度压缩不足 |

## 建议目标架构

### Context Builder

```text
Context Source Registry
  system / safety / current message
  history / summary / memory / observation / artifact / skill / external

Context Selection
  source-specific retrievers
  trust/authority labels
  relevance score

Context Compression
  rolling summaries
  observation projection
  artifact digest
  memory concise form

Context Isolation
  trusted instructions
  user intent
  untrusted data
  observations

Context Snapshot
  included/excluded chunks
  score/trust/sourceUri
  trim reason
```

### Memory

```text
Write
  candidate extraction
  -> redaction
  -> policy
  -> quality/relation
  -> scoped store

Manage
  supersede
  -> stale
  -> user confirmation
  -> consolidation
  -> deletion

Read
  hybrid recall
  -> vector recall
  -> quality/risk/provenance ranking
  -> context injection
  -> response citation
```

## 推荐落地顺序 *(2026-06-17 更新)*

1. ✅ **补 context/memory eval** — 6 个 context golden tests 已落地（`context-builder.test.ts`）

2. ✅ **把 provenance 打通到回答和 UI** — contextSnapshot 已补全 trust / sourceUri / score / warning

3. **让 memory quality 真正影响召回** — 未完成

   - Postgres score 接入 `metadata.quality.score` 或顶层 `quality` 字段。
   - 用户确认记忆加权。
   - contradiction/stale 记忆降权或过滤。

4. ✅ **把 SummaryStaleDetector 接入主链路** — 四维检测已通过 `ContextBuilderDeps.staleDetector` 接入

5. **增强 context isolation** — 部分完成

   - ✅ `appendAttachmentLines` 在 direct/no-tool 路径增加了 `[EXTERNAL]` warning。
   - 剩余：external/observation/memory 分区呈现、untrusted data 结构化隔离。

6. **补 memory governance 闭环** — 未完成

   - 用户确认、删除、纠错、降权进入 repository metadata。
   - 定期 consolidation 合并重复记忆。
   - 低质量、过期、被反复纠正的记忆自动降权。

## 当前评分 *(2026-06-17 更新)*

| 模块 | 评分 | 说明 |
|---|---:|---|
| 上下文构建 | 8.5/10 | 多源、summary（type/scopes 直取）、budget（含 per-source 截断）、trust、snapshot（含 trust/sourceUri/score）、stale detection 完整接入、6 个 golden tests；剩余：trust 物理隔离、embedding relevance scoring |
| 记忆系统 | 7.5/10 | scoped hybrid memory 底座不错，stale_reason/stale_since migration 已补；quality/provenance/governance 还要闭环 |
| 与主流上下文/记忆架构一致性 | 8.5/10 | 路线正确，不需要推倒重来；已进入 context engineering 阶段 |

## 最终判断 *(2026-06-17 更新)*

SunPilot 当前的上下文构建和记忆方案与主流 agent 架构差别不大，甚至已经具备不少生产级系统才会开始补的部件：scope-aware memory、summary compression（type/scopes 直取）、trust metadata、context snapshot（含 trust/sourceUri/score）、stale detection（四维接入）、per-source content truncation、Postgres/pgvector hybrid recall、trace/debug、context golden tests（6 场景）。

本轮已闭环的工程项：

- ✅ eval — 6 个 golden tests 验证召回、压缩、裁剪、scope isolation、stale detection
- ✅ provenance — contextSnapshot 记录 trust / sourceUri / score / warning
- ✅ stale detection — SummaryStaleDetector 完整接入 ContextBuilder 主链路
- ✅ content compression — tool_result / artifact / memory / history 截断
- ✅ summary recall — type/scopes 直取 + daemon 透传，避免 ILIKE 漏召
- ✅ memory dedup — seenIds 预填入 hybrid IDs，vector recall 不重复

剩余需要补的：

- trust enforcement — untrusted content 物理隔离到独立 message section
- memory quality ranking — quality.score / userConfirmed / sourceCredibility 接入 scoring
- memory governance — 用户确认、删除、纠错进入闭环；定期 consolidation
- summary lifecycle — regenerate、merge、version 治理

因此下一步不建议重构大架构。应该沿着现有模块继续补 trust enforcement、memory quality ranking 和 memory governance。

## 参考资料

- OpenAI Agents SDK guide: https://developers.openai.com/api/docs/guides/agents
- OpenAI Agents SDK tracing: https://openai.github.io/openai-agents-python/tracing/
- LangChain context engineering: https://docs.langchain.com/oss/python/langchain/context-engineering
- LangChain short-term memory: https://docs.langchain.com/oss/python/langchain/short-term-memory
- LangChain context engineering strategies: https://www.langchain.com/blog/context-engineering-for-agents
- Model Context Protocol specification: https://modelcontextprotocol.io/specification/2025-06-18
