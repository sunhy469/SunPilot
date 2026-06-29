# 移除 createDefaultLlmProvider() 修改方案

## 背景

P1-03 剩余问题：`createDefaultLlmProvider()` 只认 `SUNPILOT_LLM_API_KEY` / `DEEPSEEK_API_KEY`，
不识别 `SUNPILOT_DP_LLM_API_KEY`。而 `composition-root.ts` 内部已经自己从环境变量创建
provider 且能正确处理 DP 专用变量。`createDefaultLlmProvider()` 是冗余的中间层。

## 影响范围

| 文件 | 改动 |
|------|------|
| `packages/core/src/llm/openai-compatible.provider.ts` | 删除 `createDefaultLlmProvider` 函数及 export |
| `packages/core/src/llm.test.ts` | 删除 3 个调用该函数的测试用例 |
| `packages/daemon/src/server.ts` | 删除 import 和调用 |
| `packages/daemon/src/composition-root.ts` | `llmProvider` 改为 optional；删除 L159 死代码 |

## 详细步骤

### 步骤 1: `composition-root.ts` — 收口到自建 provider

**位置**: `packages/daemon/src/composition-root.ts`

#### 1a. `llmProvider` 改为 optional

```diff
  export function createAgentLoopService(deps: {
    database: DatabaseContext;
    skillRegistry: SkillRegistry;
    skillRunner?: import("@sunpilot/skill-runner").SkillRunner;
-   llmProvider: LlmProvider;
+   llmProvider?: LlmProvider;
    enableEnvironmentProviders?: boolean;
    ...
  })
```

#### 1b. 删除 L159 死代码

`LlmEmbeddingService` 构造函数接受 `llm` 参数但从不读取 `this.deps.llm`，
该字段是死代码。

```diff
  const embeddingService = new LlmEmbeddingService({
-   llm: deps.llmProvider,
    embeddingProvider,
    dimension: env.SUNPILOT_EMBEDDING_DIMENSIONS,
  });
```

同时清理 `LlmEmbeddingService` 的 deps 类型定义（`packages/core/src/agent-kernel/context/llm-embedding-service.ts`）：

```diff
  constructor(
    private readonly deps: {
-     llm: LlmProvider;
      embeddingProvider?: EmbeddingProvider;
      dimension?: number;
    },
  )
```

以及删除该文件中的 `import type { LlmProvider } from ...`。

### 步骤 2: `server.ts` — 删除调用

**位置**: `packages/daemon/src/server.ts`

#### 2a. 删除 import

```diff
  import {
    AgentService,
-   createDefaultLlmProvider,
    InMemoryAgentEventBus,
    ...
  } from "@sunpilot/core";
```

#### 2b. 删除调用

```diff
  const getChatAgent = async (): Promise<AgentService> => {
    if (chatAgent) return chatAgent as AgentService;
    chatAgentInit ??= (async () => {
-     const llmProvider = options.llmProvider ?? createDefaultLlmProvider();
      const { service, modelRouter, updateMemory, skillEmbeddingCache, embeddingService } = createAgentLoopService({
        database,
        skillRegistry,
        skillRunner,
-       llmProvider,
+       llmProvider: options.llmProvider,
        enableEnvironmentProviders: !options.llmProvider,
        ...
      });
    })();
  };
```

composition-root.ts L223 会在 `deps.llmProvider` 为 `undefined` 时自动从环境变量创建
provider，fallback 链完整：`SUNPILOT_DP_LLM_API_KEY → SUNPILOT_LLM_API_KEY → ""`。

### 步骤 3: `openai-compatible.provider.ts` — 删除函数

**位置**: `packages/core/src/llm/openai-compatible.provider.ts`

删除 L168-186 整个函数：

```diff
- export function createDefaultLlmProvider(
-   env: NodeJS.ProcessEnv = process.env,
-   fetchImpl?: FetchLike,
- ): OpenAICompatibleChatProvider {
-   const apiKey = env[LLM_API_KEY_ENV] ?? env[DEEPSEEK_API_KEY_ENV];
-   if (!apiKey) {
-     throw new Error(
-       `${LLM_API_KEY_ENV} or ${DEEPSEEK_API_KEY_ENV} is required.`,
-     );
-   }
-   return new OpenAICompatibleChatProvider(
-     {
-       apiKey,
-       baseUrl: env[LLM_BASE_URL_ENV] ?? DEFAULT_LLM_BASE_URL,
-       model: env[LLM_MODEL_ENV] ?? DEFAULT_LLM_MODEL,
-     },
-     fetchImpl,
-   );
- }
```

### 步骤 4: `index.ts` — 如果已导出则删除

检查 `packages/core/src/index.ts` 是否有 `createDefaultLlmProvider` 的 export。
当前确认没有，无需操作。如有则删除。

### 步骤 5: 测试文件 — 删除相关测试

**位置**: `packages/core/src/llm.test.ts`

删除 3 处调用 `createDefaultLlmProvider` 的测试用例（L54、L92、L100 附近）。
这些测试针对的是已删除的函数，保留会导致编译失败。

### 步骤 6: `LlmEmbeddingService` — 清理死代码

**位置**: `packages/core/src/agent-kernel/context/llm-embedding-service.ts`

```diff
- import type { LlmProvider } from "../../llm/llm.provider.js";

  constructor(
    private readonly deps: {
-     llm: LlmProvider;
      embeddingProvider?: EmbeddingProvider;
      dimension?: number;
    },
  )
```

并同步更新 `llm-embedding-service.test.ts` 中的构造函数调用。

## 验证

| 检查 | 命令 | 预期 |
|------|------|------|
| 类型检查 | `pnpm typecheck` | 通过 |
| 构建 | `pnpm build` | 通过 |
| 测试 | `pnpm test` | 通过，相关测试用例已清理 |
| Lint | `pnpm lint` | 无新增错误 |

## 风险评估

- **风险**: 低。函数未出现在 `packages/core/src/index.ts` 的 public export 中，不涉及
  对外 API 兼容性。
- **回滚**: 简单，恢复删除的函数和调用点即可。
- **功能影响**: 无。composition-root.ts 内部已有的 env 解析逻辑完全覆盖原有功能且更完善。
