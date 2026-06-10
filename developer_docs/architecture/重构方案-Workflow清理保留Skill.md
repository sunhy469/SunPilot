# SunPilot Workflow 清理并保留 Skill 优化方案

更新时间：2026-06-11

本文档基于当前工作区实际代码，说明为什么建议清理独立 Workflow 概念、只保留 Skill 作为统一 tool/capability 抽象，并给出分阶段重构方案、代码清理清单、数据迁移策略和验收标准。

## 1. 结论

当前 SunPilot 中 Workflow 和 Skill 已经在 Agent tool 层重叠。Workflow 目前并不是完整 workflow engine，而是被包装成 `workflow.*` 伪 skill 进入 tool catalog，再由 `WorkflowToolExecutor` 返回 workflow definition。它没有真正执行 `WorkflowRegistry.BusinessWorkflow.plan()` 生成的 steps。

建议方向：

```text
删除 workflow 作为一等概念
保留 skill 作为唯一可执行 tool 抽象
把 workflow / preset / automation 表达为 Skill capability
```

目标架构：

```text
Agent
  -> ToolDecisionEngine
  -> Skill catalog
  -> SkillToolExecutor
  -> SkillRunner
  -> capability.handler()
```

不再需要：

```text
workflow.*
WorkflowRegistry
WorkflowToolExecutor
WorkflowToolExecutorAdapter
ToolExecutorBridge workflow 分支
workflows table/repository/API
workflow_execution 特殊 intent
```

## 2. 当前 Workflow 实际状态

### 2.1 报告中的风险判断

`developer_docs/dev_docs/SunPilot_当前架构评测报告.md` 中 R4 已明确指出：

- `WorkflowToolExecutor` 当前更像“把 workflow definition 作为 tool 结果返回并记录 step”的适配层。
- 它不是完整 workflow engine。
- 如果 workflow 是编排 DSL，应继续实现 step-level execution。
- 如果 workflow 只是预置 tool descriptor，应重命名并降低“workflow execution”预期。

结合当前代码，更推荐第二条路：清理 workflow，收敛到 skill。

### 2.2 Workflow 包定义了目标，但执行链路没有落地

`packages/workflow/src/registry.ts` 定义：

```ts
export interface BusinessWorkflow {
  id: string;
  title: string;
  version: string;
  description: string;
  match(input, context): Promise<{ score: number; reason: string }>;
  plan(input, context): Promise<WorkflowPlan>;
}
```

注释中也写明 workflow 应该是：

```text
多步骤编排（计划 -> 审批 -> 步骤执行）
```

但当前 `WorkflowToolExecutor` 没有调用 `match()`，也没有调用 `plan()`，更没有执行 `WorkflowPlan.steps`。

### 2.3 WorkflowToolExecutor 当前只是返回 definition

`packages/workflow/src/executor.ts` 中成功路径核心逻辑：

```ts
const result: WorkflowToolResult = {
  status: "completed",
  summary: `Workflow ${workflowRecord.title} executed.`,
  content: JSON.stringify({
    workflowId: input.workflowId,
    title: workflowRecord.title,
    version: workflowRecord.version,
    definition: workflowRecord.definition,
  }),
  artifacts: [],
};
```

这说明当前 workflow 的“执行”只是把记录内容返回，并没有执行步骤。

### 2.4 Workflow 以伪 skill 形式进入 Agent

当前装配在 `packages/daemon/src/composition-root.ts`。

Context catalog：

```ts
const workflows = await deps.database.workflows.list();
return [
  ...skillCapabilities,
  ...workflows
    .filter((workflow) => workflow.enabled)
    .map((workflow) => {
      const descriptor = workflowToToolDescriptor(workflow);
      return {
        id: descriptor.id,
        name: descriptor.name,
        description: descriptor.description,
        category: descriptor.category,
      };
    }),
];
```

Tool decision catalog：

```ts
const workflows = await deps.database.workflows.list();
return [
  ...skillCapabilities,
  ...workflows.map((workflow) => {
    const descriptor = workflowToToolDescriptor(workflow);
    return {
      ...descriptor,
      permissions: [] as Permission[],
    };
  }),
];
```

`workflowToToolDescriptor()` 会生成：

```ts
{
  id: `workflow.${workflow.id}`,
  category: "workflow",
  riskHints: { defaultRisk: "medium" }
}
```

因此 workflow 在 Agent 看来已经是一个特殊 skillId，只是执行器单独路由。

### 2.5 ToolExecutorBridge 维护了双执行器分支

`packages/core/src/agent-kernel/execution/tool-executor-bridge.ts`：

```ts
if (input.skillId.startsWith("workflow.")) {
  return this.deps.workflowExecutor.execute(input);
}
return this.deps.skillExecutor.execute(input);
```

这增加了分支复杂度，但没有换来真正 workflow engine 能力。

## 3. 为什么应清理 Workflow

### 3.1 概念重复

当前系统里可被 Agent 调用的东西本质都是 tool call。Skill 已经具备：

- manifest
- capability
- input/output schema
- risk
- permissions
- enable/disable
- registry
- runner
- audit
- event
- artifact
- memory
- timeout
- cancellation

Workflow 当前也只是 tool call 的一种来源，且没有独立执行深度。继续保留两套 catalog 会让开发者困惑：

```text
什么时候写 Skill？
什么时候写 Workflow？
Workflow 是不是比 Skill 更高级？
Workflow 会不会真的执行步骤？
```

当前答案并不清晰。

### 3.2 执行语义不一致

Skill 真实执行 handler：

```text
input parse -> permission check -> handler -> output parse
```

Workflow 当前执行：

```text
find workflow record -> create step -> return definition JSON
```

这会导致用户和开发者误以为 workflow 已完成业务流程，但实际只是返回描述。

### 3.3 存储和 API 成本过高

当前为了 workflow 维护了：

- `WorkflowRecord`
- `WorkflowPlan`
- `WorkflowStepPlan`
- `WorkflowRepository`
- Postgres workflow repository
- in-memory workflow repository
- `workflows` table
- `/v1/workflows` API
- daemon workflows reload/list/findById 接口
- metrics workflow count

在没有完整执行引擎前，这些成本偏高。

### 3.4 Skill 已足够表达复合能力

多步骤流程可以作为 Skill capability 实现：

```text
skill id: sunpilot.automation
capability: daily.close
capability: project.audit
capability: report.generate
```

handler 内部可以：

- 调用多个 SDK context API
- 分阶段 emit progress event
- 写多个 artifacts
- 写 memory
- 在必要时返回结构化步骤结果

这比维护 workflow 独立概念更直接。

## 4. 目标范式

### 4.1 统一术语

统一后只保留：

```text
Skill
Capability
Tool call
Step
Approval
Artifact
Memory
```

不再在代码主路径中使用：

```text
Workflow
workflow.*
workflow_execution
WorkflowToolExecutor
```

如果产品上仍想表达“自动化流程”，建议作为 UI/文档层标签：

```text
Automation Skill
Composite Skill
Preset Skill
Recipe Skill
```

但底层仍然是 `SkillManifestCapability`。

### 4.2 复合能力表达

复合能力示例：

```json
{
  "schemaVersion": "sunpilot.skill/v1",
  "id": "sunpilot.automation",
  "name": "SunPilot Automation",
  "version": "0.1.0",
  "description": "Built-in business automations.",
  "entry": "dist/index.js",
  "readme": "README.md",
  "runtime": { "node": ">=22", "module": "esm" },
  "capabilities": [
    {
      "name": "daily.close",
      "title": "Daily Close",
      "description": "Run a daily closing routine.",
      "inputSchema": "schemas/daily-close.input.json",
      "outputSchema": "schemas/daily-close.output.json",
      "risk": "medium",
      "permissions": ["memory.write", "artifact.write"]
    }
  ],
  "permissions": {
    "filesystem": { "read": [], "write": [] },
    "env": { "allow": [] },
    "network": { "allow": [] },
    "shell": false
  }
}
```

Entry：

```ts
export default defineSkill({
  id: "sunpilot.automation",
  version: "0.1.0",
  capabilities: {
    "daily.close": {
      input,
      output,
      risk: "medium",
      async handler(input, ctx) {
        ctx.events.emit("skill.progress", { stage: "collecting" });
        await ctx.memory.write("daily.close.started", { input });

        ctx.events.emit("skill.progress", { stage: "generating-report" });
        const artifact = await ctx.artifacts.write({
          name: "daily-close.md",
          type: "document",
          content: "# Daily close\n",
          mimeType: "text/markdown",
        });

        return {
          status: "completed",
          artifactId: artifact.id,
        };
      },
    },
  },
});
```

## 5. 分阶段重构方案

### Phase A：同步优化 Skill 规范和核心代码

清理 workflow 后，Skill 会成为唯一工具抽象。因此不能只删除 workflow 分支，还需要把当前 Skill 规范补齐到能承载真实业务插件的程度，尤其是 RESTful 外部 API、模型生成、图片/视频 artifact、`.env` secret、数据库查询类能力。

本阶段建议作为 workflow 清理的前置或并行工作。

#### A.1 将 tool id 收敛为全限定 capability id

当前 `composition-root.ts` 暴露给 Agent 的 skill id 是：

```ts
id: capability.name
```

这会导致两个 skill 只要有同名 capability，就会发生选择和执行歧义。`SkillToolExecutor.resolveCapability()` 已经支持：

```text
<skill-id>:<capability-name>
```

因此建议把 Agent catalog、plan、tool call、approval、tool_calls 表中的 `skillId` 统一为全限定格式：

```text
cross-border-ecommerce:video.generate.seedance
cross-border-ecommerce:image.generate.seedream
cross-border-ecommerce:product.source.search1688
```

代码修改点：

- `packages/daemon/src/composition-root.ts`
  - ContextBuilder `listSkills`
  - ToolDecisionEngine `listSkills`
- `packages/core/src/agent-kernel/tools/tool-decision-engine.ts`
- `packages/core/src/agent-kernel/planning/rule-based-planner.ts`
- `packages/core/src/agent-kernel/execution/skill-tool-executor.ts`

目标规则：

```text
对 Agent 暴露：skillId:capabilityName
对 StepRecord 持久化：skillId = manifest.id, capability = capability.name
对 UI 展示：capability.title
```

这样 Agent 调用的是唯一工具，runner 仍能记录清晰的 skill/capability 双字段。

#### A.2 增加受控 HTTP / RESTful API 能力

当前 manifest 已有：

```ts
network?: { allow?: string[] };
```

但 `SkillRunner` 当前直接拒绝 network 权限：

```text
Permission denied: network access is not available in MVP runner.
```

对于外贸电商、模型生成、1688 货源接口等场景，必须补一个受控 HTTP SDK，而不是让 skill handler 自己随意 `fetch()`。

建议在 `packages/skill-sdk/src/index.ts` 增加：

```ts
export interface SkillHttpApi {
  request(input: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    url: string;
    headers?: Record<string, string>;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    timeoutMs?: number;
    responseType?: "json" | "text" | "arrayBuffer";
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: unknown;
  }>;
}

export interface SkillContext {
  http: SkillHttpApi;
}
```

`SkillRunner` 中实现 `ctx.http.request()`：

1. 解析 URL。
2. 校验 host 是否命中 `manifest.permissions.network.allow`。
3. 记录 audit：`network.request`，target 使用 origin/host，headers/body 做脱敏。
4. 注入 `context.signal` 和 timeout。
5. 限制响应体大小。
6. 支持 `json`、`text`、`arrayBuffer`。
7. 对 API key、Authorization、cookie、token 字段做 redaction。

Manifest 示例：

```json
{
  "permissions": {
    "network": {
      "allow": [
        "ark.cn-beijing.volces.com",
        "open.volcengineapi.com",
        "gw.open.1688.com"
      ]
    },
    "env": {
      "allow": [
        "SEEDANCE_API_KEY",
        "SEEDREAM_API_KEY",
        "ALI1688_APP_KEY",
        "ALI1688_APP_SECRET"
      ]
    },
    "filesystem": { "read": [], "write": [] },
    "shell": false
  }
}
```

原则：

```text
所有外部 RESTful API 必须通过 ctx.http
所有 secret 必须通过 ctx.secrets.get
禁止 skill 直接读 process.env
禁止 skill 直接使用无审计 fetch 访问外网
```

#### A.3 明确图片、视频、文件的 artifact 存储规范

模型生成的图片、视频、Excel、Markdown、JSON 结果不应该保存在 skill 目录，也不应该回写原 Spring Boot 项目的 uploads 目录。它们应该统一进入 SunPilot Artifact 系统：

```ts
const artifact = await ctx.artifacts.write({
  name: "product-ad-video.mp4",
  type: "video",
  content: videoBuffer,
  mimeType: "video/mp4",
  metadata: {
    provider: "seedance",
    model: "seedance",
    productId: input.productId,
    prompt: input.prompt,
  },
});
```

当前 artifact 写入由 `packages/skill-runner/src/runner.ts` 中 `context.artifacts.write()` 负责，底层调用 `@sunpilot/storage` 的 `writeArtifact()`，并写入 DB 和 `agent.artifact.created` 事件。

建议补充规范：

- 外部模型返回临时 URL 时，skill 应下载文件内容后写入 artifact。
- 外部模型返回 base64 时，skill 应解码为 Buffer 后写入 artifact。
- 输出 schema 中返回 artifact id，而不是直接返回超长 base64。
- metadata 中记录 provider、model、prompt、sourceUrl、productId、generation parameters。
- 大文件应限制大小，并在 HTTP SDK 中提供响应体大小保护。

推荐输出：

```json
{
  "status": "completed",
  "artifactId": "artifact_xxx",
  "mimeType": "video/mp4",
  "provider": "seedance"
}
```

不推荐输出：

```json
{
  "videoBase64": "超长内容"
}
```

#### A.4 将 env / secret 从“可读取变量”升级为正式契约

从原 AI 应用迁移时，`.env` 往往包含大量变量。不要把所有变量原样暴露给 skill，而要按 capability 需要最小化声明。

建议增加文档和校验规则：

```text
manifest.permissions.env.allow 是唯一 secret 白名单
handler 只能 ctx.secrets.get(name)
secret 名称、值、Authorization header 均不能进入 artifact/memory/event/log
缺失 secret 时返回结构化错误
```

对外贸电商 skill，建议按 provider 分组命名：

```text
SEEDANCE_API_KEY
SEEDANCE_BASE_URL
SEEDREAM_API_KEY
SEEDREAM_BASE_URL
ALI1688_APP_KEY
ALI1688_APP_SECRET
ALI1688_ACCESS_TOKEN
OPENAI_COMPATIBLE_API_KEY
OPENAI_COMPATIBLE_BASE_URL
```

如果同一个 Java 项目里有很多模型，不能把所有 `.env` 变量都塞进一个 capability。应在 skill README 中列出 provider 到 env 的映射，并在代码中按实际 capability 读取。

#### A.5 增加数据库访问迁移策略

原 Spring Boot 项目通常有 JPA Entity、Mapper、Repository、SQL 表。迁移为 Skill 时，不建议让 skill 直接连接原业务数据库，除非这是明确的外部系统集成能力。

建议分类：

| 原项目内容 | 迁移方式 |
| --- | --- |
| 业务配置、模型配置、prompt 模板 | 转成 skill 内部 config、schema defaults 或 README 说明。 |
| 用户/订单/商品等业务表读取 | 如果必须访问，定义为独立 capability，并通过受控 HTTP/API 或只读 DB adapter。 |
| 文件记录、生成历史 | 转成 SunPilot artifact + metadata + memory。 |
| 任务状态表 | 转成 capability output + events + artifacts，必要时用外部 task id。 |
| Spring Boot CRUD 后台接口 | 只有 Agent 需要调用的动作才抽象为 capability。 |

如果后续确实需要 DB SDK，应新增独立受控 API：

```ts
ctx.database.query(...)
```

并在 manifest 中声明：

```json
{
  "permissions": {
    "database": {
      "allow": ["readonly:legacy_product_db"]
    }
  }
}
```

但当前 SunPilot 规范尚未实现该能力。因此第一阶段应优先通过 RESTful API、artifact 和 memory 表达，不建议直接迁移数据库连接逻辑。

#### A.6 将外贸电商定义为业务域 Skill

对用户描述的 Spring Boot + React AI 应用，建议 Skill 粒度是“外贸电商”，Capability 粒度是可独立调用、审批、失败重试的一项业务动作。

推荐：

```text
Skill id: cross-border-ecommerce
Skill name: 外贸电商

Capabilities:
  product.source.search1688
  product.source.detail1688
  product.copy.generate
  product.title.optimize
  image.generate.seedream
  image.edit.product
  video.generate.seedance
  listing.generate
  material.batch.generate
```

不推荐：

```text
Skill: seedance
Skill: seedream
Skill: 1688
Skill: product-controller
Skill: video-service
```

除非这些 provider 将来要被很多业务域复用，才考虑拆成底层 provider skills。

#### A.7 为长任务模型生成补充异步任务规范

视频生成常见模式是：

```text
submit task -> get taskId -> poll status -> download result
```

Skill handler 可以同步等待完成，但必须：

- 使用 `ctx.signal` 支持取消。
- 每次 poll 间隔合理。
- 通过 `ctx.events.emit("skill.progress", ...)` 发进度。
- 超时后返回 `timeout` 或结构化错误。
- 完成后下载结果并写 artifact。

推荐输出：

```json
{
  "status": "completed",
  "providerTaskId": "task_xxx",
  "artifactId": "artifact_xxx"
}
```

如果选择不等待完成，也可以拆成两个 capability：

```text
video.generate.seedance.submit
video.generate.seedance.check
```

拆分原则：

```text
Agent 是否需要单独调用/重试/审批
外部任务是否可能超过单个 skill timeout
用户是否需要看到中间任务状态
```

#### A.8 更新测试基线

Skill 优化后至少补这些测试：

- `packages/skill-sdk/src/testing.test.ts`
  - 新增 `ctx.http` fake。
- `packages/skill-runner/src/runner.test.ts`
  - network allow 命中时允许请求。
  - network allow 未命中时拒绝。
  - Authorization header audit redaction。
  - arrayBuffer response 可写 artifact。
  - `ctx.signal` 中断 HTTP 请求。
- `packages/core/src/agent-kernel/tools/tool-decision-engine.test.ts`
  - 全限定 skill id 选择。
- `packages/core/src/agent-kernel/execution/skill-tool-executor.ts`
  - `<skill-id>:<capability>` 解析优先。
- `packages/daemon/src/composition-root.test.ts`
  - catalog 暴露全限定 capability id。

验收命令：

```bash
pnpm --filter @sunpilot/skill-sdk test
pnpm --filter @sunpilot/skill-runner test
pnpm --filter @sunpilot/core test
pnpm --filter @sunpilot/daemon test
pnpm -r build
pnpm -r lint
pnpm test
```

### Phase 0：冻结 Workflow 新增能力

目标：避免继续扩大 workflow 面积。

动作：

1. 不再新增 `packages/workflow` 功能。
2. 不再新增 `/v1/workflows` API 消费方。
3. 不再让新测试依赖 `workflow.*`。
4. 文档标注 workflow 为待移除概念。

验收：

- 新需求只通过 skill/capability 表达。
- 当前 workflow 代码不再增长。

### Phase 1：将内置 Workflow 迁移为 Skill

当前 `packages/workflow/src/registry.ts` 的 `WorkflowRegistry.records()` 会把注册的 `BusinessWorkflow` 转成 `WorkflowRecord`。但当前代码中 daemon 只是创建空 registry：

```ts
const workflows = new WorkflowRegistry();
for (const record of workflows.records()) {
  await database.workflows.upsert(record);
}
```

这意味着当前默认没有真正内置 workflow。迁移重点是测试和潜在用户 DB 数据。

动作：

1. 新增一个内置 skill 包或 fixture skill，用于承载原 workflow preset。
2. 如果存在原 workflow 定义，将其转换为 skill capability。
3. 将原 `workflow.<id>` 调用改为 `<skill-id>:<capability-name>`。
4. 更新测试中使用的 `workflow.daily.close`。

建议命名：

```text
sunpilot.automation:daily.close
sunpilot.automation:project.audit
sunpilot.automation:report.generate
```

验收：

- Agent tool catalog 中不再需要 workflow descriptor 也能看到对应 automation capability。
- 原 workflow 相关测试有 skill 等价测试覆盖。

### Phase 2：收敛 ToolExecutor

当前执行链路：

```text
ToolExecutorBridge
  -> workflow.* -> WorkflowToolExecutorAdapter -> WorkflowToolExecutor
  -> other      -> SkillToolExecutor -> SkillRunner
```

目标执行链路：

```text
ExecutionOrchestrator
  -> SkillToolExecutor
  -> SkillRunner
```

需要修改：

- 删除 `packages/core/src/agent-kernel/execution/workflow-tool-executor-adapter.ts`
- 删除 `packages/core/src/agent-kernel/execution/tool-executor-bridge.ts`
- `composition-root.ts` 中不再创建 `WorkflowToolExecutor`
- `composition-root.ts` 中直接把 `SkillToolExecutor` 注入 `ExecutionOrchestrator`

目标代码形态：

```ts
const skillExecutor = new SkillToolExecutor(...);

const executionOrchestrator = new ExecutionOrchestrator({
  toolExecutor: skillExecutor,
  eventBus: rawEventBus,
  toolCalls: deps.database.toolCalls,
});
```

验收：

- `workflow.*` 分支消失。
- `ExecutionOrchestrator` 仍只依赖 `ToolExecutor` 接口。
- Skill 执行测试全部通过。

### Phase 3：清理 ToolDecisionEngine 的 workflow 特判

当前 `ToolDecisionEngine` 中存在：

```ts
if (intent.type === "workflow_execution") {
  const workflowSkills = availableSkills.filter(
    (skill) => skill.category === "workflow",
  );
  ...
}
```

需要删除：

- `workflow_execution` 特殊匹配逻辑
- `category === "workflow"` 依赖
- `ToolDecisionEngine` 中命名 workflow 的 reason
- `tool-decision-engine.test.ts` 中 workflow 专属用例

替代方式：

- 如果用户表达“执行自动化流程”，Intent 可以映射到普通 tool intent。
- `INTENT_SKILL_MAP` 中新增具体 skill capability fallback。
- 或保留泛化 intent 名称 `automation_execution`，但候选 skill 仍是普通 skill id。

建议短期处理：

```text
workflow_execution -> code/modification/file/question 等现有 intent
或重命名为 automation_execution
```

如果保留 `automation_execution`，也不应该引入 `category: "workflow"`，而应该匹配：

```text
sunpilot.automation:daily.close
sunpilot.automation:project.audit
```

验收：

- `ToolDecisionEngine` 不再出现 `workflow` 字符串。
- `SkillSummary.category` 可以删除 `"workflow"`，或暂时保留但不再使用。

### Phase 4：清理 ContextBuilder 和 catalog

当前 `composition-root.ts` 在两个位置把 workflows 混进 skill catalog：

1. ContextBuilder `listSkills`
2. ToolDecisionEngine `listSkills`

需要删除：

```ts
const workflows = await deps.database.workflows.list();
...
workflowToToolDescriptor(workflow)
```

只保留：

```ts
const skills = deps.skillRegistry.list();
const skillCapabilities = skills.flatMap(...);
return skillCapabilities;
```

同时建议修正当前 skill capability id 不是全限定的问题：

当前：

```ts
id: capability.name
```

建议：

```ts
id: `${s.id}:${capability.name}`
```

这样能够避免不同 skill 之间 capability name 冲突，并与 `SkillToolExecutor.resolveCapability()` 已支持的 `skillId:capabilityName` 格式对齐。

验收：

- Agent context 中 `Available Skills` 只来自 installed skills。
- 没有 workflow descriptor 混入 catalog。
- tool call 使用全限定 skill capability id。

### Phase 5：清理 API 与 daemon workflow 管理接口

当前 API：

```text
GET  /v1/workflows
GET  /v1/workflows/:id
POST /v1/workflows/reload
```

位置：`packages/api/src/http/register-routes.ts`

当前 daemon deps：

```ts
workflows: {
  reload()
  list()
  findById()
}
```

位置：

- `packages/api/src/composition/api-deps.ts`
- `packages/daemon/src/server.ts`

需要删除：

- API deps 中的 workflows 字段
- HTTP workflows routes
- server.ts 中 `WorkflowRegistry` 初始化和 reload/list/findById
- metrics 中 workflow count

替代：

```text
GET  /v1/skills
POST /v1/skills/reload
POST /v1/skills/:id/enable
POST /v1/skills/:id/disable
```

验收：

- REST API 不再暴露 `/v1/workflows`。
- daemon 不再 import `@sunpilot/workflow`。
- metrics 不再输出 workflow 相关指标。

### Phase 6：清理 storage/protocol workflow 类型与 repository

当前 protocol：

```ts
export interface WorkflowStepPlan
export interface WorkflowPlan
export interface WorkflowRecord
```

位置：`packages/protocol/src/types.ts`

当前 storage：

- `packages/storage/src/repositories/workflow.repository.ts`
- `packages/storage/src/postgres/postgres.workflow.repository.ts`
- `packages/storage/src/database/database.types.ts` 中 `workflows`
- `packages/storage/src/testing/in-memory-database.context.ts` 中 workflow map
- `packages/storage/src/migrations/006_catalog.sql` 中 `workflows` 表

建议：

1. TypeScript 类型直接删除。
2. Repository 接口和实现删除。
3. `DatabaseContext` 删除 `workflows` 字段。
4. In-memory DB 删除 workflow map。
5. 新增 cleanup migration 处理历史 `workflows` 表。

Migration 策略有两种：

方案 A：保守保留表但代码不再访问

```sql
-- 不 drop workflows，只让代码不再使用。
-- 优点：不破坏已有数据。
-- 缺点：schema 噪音保留。
```

方案 B：新增 migration drop 表

```sql
DROP TABLE IF EXISTS workflows;
```

优点是彻底清理，缺点是不可逆。如果担心用户数据，可以先导出到 `installed_skills` 或 artifact，再 drop。

建议当前阶段采用方案 A 或分两步：

```text
第一版：代码不再访问 workflows，migration 不 drop
第二版：确认无迁移需求后 drop workflows
```

验收：

- `DatabaseContext` 不再有 `workflows`。
- `rg "WorkflowRecord|WorkflowPlan|workflows"` 不再命中主代码路径。
- migration 防漏测试仍通过。

### Phase 7：删除 packages/workflow 包

需要修改：

- 删除 `packages/workflow`
- 删除根 workspace 对它的隐式依赖
- 删除相关 package dependency：
  - `@sunpilot/workflow` from `packages/daemon/package.json`
  - `@sunpilot/workflow` from `packages/core/package.json` 如果存在
  - pnpm lock 更新
- 删除 imports：
  - `WorkflowToolExecutor`
  - `workflowToToolDescriptor`
  - `WorkflowToolExecutorAdapter`

验收：

```bash
pnpm -r build
pnpm -r lint
pnpm test
```

全部通过。

### Phase 8：文档更新

需要更新：

- `developer_docs/dev_docs/SunPilot_当前架构评测报告.md`
- `developer_docs/dev_docs/SunPilot_当前工程实现总结.md`
- `developer_docs/dev_docs/SunPilot_代码文件职责索引.md`
- `developer_docs/config_docs/SunPilot_文件路径与作用说明.md`
- `developer_docs/config_docs/SunPilot_环境变量配置说明.md`
- `developer_docs/cmd_docs/SunPilot_命令使用手册.md` 如果提到 workflow

重点替换：

```text
workflow 生态
Workflow runtime
workflow registry
/v1/workflows
workflow_execution
workflow.*
```

替换为：

```text
Skill capability
Automation skill
Composite skill
```

## 6. 代码清理清单

本节是面向开发实施的具体参考。目标不是一次性复制所有片段，而是明确每个文件的职责变化、删除点、目标代码形态和测试落点。

### 6.0 推荐提交顺序

建议不要在一个提交里同时删除 workflow、改 skill catalog、加 HTTP SDK。推荐拆成下面几组提交：

```text
commit 1: Skill catalog 改为全限定 capability id
commit 2: Skill SDK / Runner 增加受控 ctx.http
commit 3: composition-root 移除 workflow catalog 混入
commit 4: ExecutionOrchestrator 直接使用 SkillToolExecutor，删除 ToolExecutorBridge workflow 分支
commit 5: ToolDecisionEngine / Intent 删除 workflow_execution 特判
commit 6: API / daemon / metrics 删除 workflows 管理面
commit 7: storage / protocol 删除 workflow 类型和 repository
commit 8: 删除 packages/workflow 包和依赖
commit 9: 文档与测试更新
```

每组提交后至少跑对应包测试，最后跑全量：

```bash
pnpm -r build
pnpm -r lint
pnpm test
```

### 6.1 `packages/daemon/src/composition-root.ts`

当前职责：

- 把 installed skill capabilities 转成 Agent 可见 skill catalog。
- 把 workflows 转成 `workflow.*` descriptor 混入 catalog。
- 创建 `WorkflowToolExecutor`、`WorkflowToolExecutorAdapter`、`SkillToolExecutor`、`ToolExecutorBridge`。

目标职责：

- 只从 `skillRegistry.list()` 生成 skill catalog。
- catalog id 使用全限定格式：`<skill-id>:<capability-name>`。
- 直接把 `SkillToolExecutor` 注入 `ExecutionOrchestrator`。
- 不再 import `@sunpilot/workflow`。

#### 6.1.1 删除 imports

删除：

```ts
import {
  ToolExecutorBridge,
  WorkflowToolExecutorAdapter,
} from "@sunpilot/core";
import { WorkflowToolExecutor, workflowToToolDescriptor } from "@sunpilot/workflow";
```

保留：

```ts
import {
  SkillToolExecutor,
  ExecutionOrchestrator,
  // other existing imports
} from "@sunpilot/core";
```

如果 `ToolExecutorBridge` 和 `WorkflowToolExecutorAdapter` 是从 `@sunpilot/core` 统一导出的，也要同步更新 `packages/core/src/index.ts`，不再导出它们。

#### 6.1.2 新增 catalog 映射 helper

建议在 `composition-root.ts` 底部或局部新增 helper，避免 ContextBuilder 和 ToolDecisionEngine 两处重复：

```ts
function capabilityToolId(skillId: string, capabilityName: string): string {
  return `${skillId}:${capabilityName}`;
}
```

如果希望更集中，也可以放到 `packages/core/src/agent-kernel/tools/tool-types.ts`，但第一阶段放在 composition root 即可。

#### 6.1.3 修改 ContextBuilder `listSkills`

当前代码形态：

```ts
const skills = deps.skillRegistry.list();
const skillCapabilities = skills.flatMap((s) =>
  s.manifest.capabilities.map((capability) => ({
    id: capability.name,
    name: capability.title,
    description: capability.description,
    category: categoryFromCapability(capability.name),
  })),
);
const workflows = await deps.database.workflows.list();
return [
  ...skillCapabilities,
  ...workflows
    .filter((workflow) => workflow.enabled)
    .map((workflow) => {
      const descriptor = workflowToToolDescriptor(workflow);
      return {
        id: descriptor.id,
        name: descriptor.name,
        description: descriptor.description,
        category: descriptor.category,
      };
    }),
];
```

目标代码形态：

```ts
const skills = deps.skillRegistry.list();
return skills
  .filter((skill) => skill.enabled)
  .flatMap((skill) =>
    skill.manifest.capabilities.map((capability) => ({
      id: capabilityToolId(skill.id, capability.name),
      name: capability.title,
      description: capability.description,
      category: categoryFromCapability(capability.name),
    })),
  );
```

注意：

- `availableSkills[].id` 从 capability name 改为全限定 tool id。
- `categoryFromCapability()` 仍可按 capability name 判断，不要传全限定 id，否则 `cross-border-ecommerce:video.generate.seedance` 可能无法按前缀分类。

#### 6.1.4 修改 ToolDecisionEngine `listSkills`

当前代码形态：

```ts
const skills = deps.skillRegistry.list();
const skillCapabilities = skills.flatMap((s) =>
  s.manifest.capabilities.map((capability) => ({
    id: capability.name,
    name: capability.title,
    description: capability.description,
    category: categoryFromCapability(capability.name),
    enabled: s.enabled,
    permissions: normalizeCapabilityPermissions(capability.permissions),
    defaultTimeoutMs: 60_000,
    maxTimeoutMs: 300_000,
    supportsAbort: true,
    idempotent: false,
    riskHints: {
      defaultRisk: capability.risk as "low" | "medium" | "high" | "critical",
    },
  })),
);
const workflows = await deps.database.workflows.list();
return [
  ...skillCapabilities,
  ...workflows.map((workflow) => {
    const descriptor = workflowToToolDescriptor(workflow);
    return {
      ...descriptor,
      permissions: [] as Permission[],
    };
  }),
];
```

目标代码形态：

```ts
const skills = deps.skillRegistry.list();
return skills.flatMap((skill) =>
  skill.manifest.capabilities.map((capability) => ({
    id: capabilityToolId(skill.id, capability.name),
    name: capability.title,
    description: capability.description,
    category: categoryFromCapability(capability.name),
    enabled: skill.enabled,
    permissions: normalizeCapabilityPermissions(capability.permissions),
    defaultTimeoutMs: 60_000,
    maxTimeoutMs: 300_000,
    supportsAbort: true,
    idempotent: false,
    riskHints: {
      defaultRisk: capability.risk as "low" | "medium" | "high" | "critical",
    },
  })),
);
```

#### 6.1.5 删除 workflow executor 装配

删除整段：

```ts
const workflowToolExecutor = new WorkflowToolExecutor({
  findWorkflow: (id) => deps.database.workflows.findById(id),
  getRun: async (runId) =>
    (await deps.database.runs.findById(runId)) ?? undefined,
  createStep: async (step) => {
    await deps.database.steps.create({
      id: step.id,
      runId: step.runId,
      type: step.type as "skill" | "approval" | "builtin" | "manual",
      name: step.name,
      status: step.status as StepRecord["status"],
      skillId: step.skillId,
      input: step.input ?? {},
    });
  },
  updateStepStatus: (id, status, output, error) =>
    deps.database.steps.updateStatus(
      id,
      status as "completed" | "failed" | "cancelled" | "interrupted",
      output,
      error,
    ),
});

const workflowExecutor = new WorkflowToolExecutorAdapter(workflowToolExecutor);
```

删除：

```ts
const toolExecutor = new ToolExecutorBridge({
  skillExecutor,
  workflowExecutor,
});
```

目标代码形态：

```ts
const executionOrchestrator = new ExecutionOrchestrator({
  toolExecutor: skillExecutor,
  eventBus: rawEventBus,
  toolCalls: deps.database.toolCalls,
});
```

### 6.2 `packages/core/src/agent-kernel/execution/skill-tool-executor.ts`

当前 `resolveCapability()` 已支持：

```ts
const [skillId, capabilityName] = requested.includes(":")
  ? requested.split(":", 2)
  : [undefined, requested];
```

建议把“非全限定 capability name”降级为兼容路径，并在未来删除。

目标增强代码：

```ts
function resolveCapability(
  skills: InstalledSkillRecord[],
  requested: string,
):
  | {
      skill: InstalledSkillRecord;
      capability: InstalledSkillRecord["manifest"]["capabilities"][number];
    }
  | undefined {
  const separator = requested.indexOf(":");
  const skillId = separator >= 0 ? requested.slice(0, separator) : undefined;
  const capabilityName =
    separator >= 0 ? requested.slice(separator + 1) : requested;

  if (skillId) {
    const skill = skills.find((item) => item.enabled && item.id === skillId);
    const capability = skill?.manifest.capabilities.find(
      (item) => item.name === capabilityName,
    );
    return skill && capability ? { skill, capability } : undefined;
  }

  // Backward compatibility only. New tool calls should always use
  // <skill-id>:<capability-name>.
  for (const skill of skills) {
    if (!skill.enabled) continue;
    const capability = skill.manifest.capabilities.find(
      (item) => item.name === capabilityName,
    );
    if (capability) return { skill, capability };
  }
  return undefined;
}
```

如果想严格化，可在没有冒号时直接失败：

```ts
if (!requested.includes(":")) {
  return undefined;
}
```

但建议先保留兼容，避免旧测试和旧数据一次性断裂。

### 6.3 `packages/core/src/agent-kernel/execution/tool-executor-bridge.ts`

清理 workflow 后这个文件不再需要。

删除文件：

```text
packages/core/src/agent-kernel/execution/tool-executor-bridge.ts
```

同时删除所有 import：

```ts
import { ToolExecutorBridge } from "...";
```

如果 `packages/core/src/index.ts` 或 barrel export 有：

```ts
export * from "./agent-kernel/execution/tool-executor-bridge.js";
```

也要删除。

### 6.4 `packages/core/src/agent-kernel/execution/workflow-tool-executor-adapter.ts`

清理 workflow 后这个文件不再需要。

删除文件：

```text
packages/core/src/agent-kernel/execution/workflow-tool-executor-adapter.ts
```

同时删除 barrel export。

### 6.5 `packages/core/src/agent-kernel/tools/tool-types.ts`

当前 `SkillSummary.category` 包含：

```ts
| "workflow"
```

目标是删除 `"workflow"`。如果还想保留“自动化”产品分类，可以新增 `"automation"`，但不要绑定独立 workflow runtime。

目标代码形态：

```ts
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  category:
    | "filesystem"
    | "shell"
    | "code"
    | "web"
    | "memory"
    | "artifact"
    | "automation"
    | "custom";
  enabled: boolean;
  permissions: Permission[];
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  supportsAbort: boolean;
  idempotent: boolean;
  riskHints: {
    defaultRisk: RiskLevel;
    destructiveArgs?: string[];
    externalHosts?: string[];
  };
}
```

`INTENT_SKILL_MAP` 中删除或替换：

```ts
workflow_execution: [],
```

如果保留自动化意图：

```ts
automation_execution: [
  "cross-border-ecommerce:material.batch.generate",
  "cross-border-ecommerce:listing.generate",
],
```

注意：这里必须使用全限定 tool id。

### 6.6 `packages/core/src/agent-kernel/tools/tool-decision-engine.ts`

删除 workflow 特判：

```ts
if (intent.type === "workflow_execution") {
  const workflowSkills = availableSkills.filter(
    (skill) => skill.category === "workflow",
  );
  ...
}
```

目标逻辑：

```ts
const matchedSkills = intent.candidateSkills
  .flatMap((candidateId) =>
    availableSkills.filter(
      (skill) =>
        skill.id === candidateId ||
        skill.name.toLowerCase().includes(candidateId.toLowerCase()),
    ),
  )
  .filter((skill, idx, arr) => arr.findIndex((item) => item.id === skill.id) === idx);

if (matchedSkills.length === 0) {
  const fallbackIds = INTENT_SKILL_MAP[intent.type] ?? [];
  const fallbackSkills = fallbackIds
    .flatMap((id) => availableSkills.filter((skill) => skill.id === id))
    .filter((skill, idx, arr) => arr.findIndex((item) => item.id === skill.id) === idx);

  if (fallbackSkills.length === 0) {
    return {
      type: "no_tool",
      reason: `No available skills matched intent '${intent.type}'`,
    };
  }

  return {
    type: "use_tool",
    toolCalls: fallbackSkills.map(toToolCall),
    reason: `Matched ${fallbackSkills.length} fallback skill(s) for intent '${intent.type}'`,
  };
}

return {
  type: "use_tool",
  toolCalls: matchedSkills.map(toToolCall),
  reason: `Matched ${matchedSkills.length} skill(s) for intent '${intent.type}'`,
};
```

可抽 helper：

```ts
function toToolCall(skill: SkillSummary) {
  return {
    id: `tc_${crypto.randomUUID()}`,
    skillId: skill.id,
    name: skill.name,
    arguments: {},
    permissions: skill.permissions,
    reason: `Matched skill '${skill.name}'`,
    riskLevel: skill.riskHints.defaultRisk,
    requiresApproval:
      skill.riskHints.defaultRisk === "high" ||
      skill.riskHints.defaultRisk === "critical",
    timeoutMs: Math.min(skill.defaultTimeoutMs, skill.maxTimeoutMs),
  };
}
```

### 6.7 `packages/core/src/agent-kernel/intent/*`

需要检查并删除或重命名：

```text
workflow_execution
```

涉及文件：

```text
packages/core/src/agent-kernel/loop-types.ts
packages/core/src/agent-kernel/intent/intent-types.ts
packages/core/src/agent-kernel/intent/intent-router.ts
packages/core/src/agent-kernel/agent-loop-engine.ts
```

当前 `agent-loop-engine.ts` 中有类似：

```ts
if (skillId.startsWith("workflow.")) return "workflow_execution";
```

目标：

```ts
if (skillId.includes(":")) return "tool_execution";
```

或者如果现有类型里没有 `tool_execution`，则回退到更泛化的 intent 类型，不再根据 `workflow.` 前缀判断。

如果产品仍需要“执行自动化”意图，建议改成：

```text
automation_execution
```

但它仍然选择普通 skill capability，不再有 runtime 特殊分支。

### 6.8 `packages/skill-sdk/src/index.ts`

为了支持外贸电商、模型生成和第三方 RESTful API，建议增加受控 HTTP context。

新增类型：

```ts
export type SkillHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface SkillHttpRequest {
  method: SkillHttpMethod;
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  responseType?: "json" | "text" | "arrayBuffer";
}

export interface SkillHttpResponse<TBody = unknown> {
  status: number;
  headers: Record<string, string>;
  body: TBody;
}

export interface SkillHttpApi {
  request<TBody = unknown>(
    input: SkillHttpRequest,
  ): Promise<SkillHttpResponse<TBody>>;
}
```

修改 `SkillContext`：

```ts
export interface SkillContext {
  runId: string;
  stepId: string;
  skillId: string;
  capability: string;
  signal: AbortSignal;
  events: SkillEventApi;
  artifacts: SkillArtifactApi;
  files: SkillFileApi;
  memory: SkillMemoryApi;
  secrets: SkillSecretApi;
  http: SkillHttpApi;
  logger: SkillLogger;
}
```

注意：这会影响所有测试 helper 和所有手写 SkillContext mock。

### 6.9 `packages/skill-sdk/src/testing.ts`

`testSkill()` 需要补 fake HTTP。

新增 options：

```ts
export interface TestSkillOptions {
  files?: Record<string, string>;
  secrets?: Record<string, string | undefined>;
  http?: {
    request(input: SkillHttpRequest): Promise<SkillHttpResponse>;
  };
}
```

在 handler context 中补：

```ts
http: {
  async request(input) {
    if (!options.http) {
      throw new Error(`Test HTTP request not mocked: ${input.method} ${input.url}`);
    }
    return options.http.request(input);
  },
},
```

测试时可写：

```ts
await testSkill(skill, "image.generate.seedream", input, {
  secrets: { SEEDREAM_API_KEY: "test-key" },
  http: {
    async request(request) {
      expect(request.url).toContain("seedream");
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { imageUrl: "https://example.test/image.png" },
      };
    },
  },
});
```

### 6.10 `packages/skill-runner/src/runner.ts`

当前 runner 对 network 直接拒绝：

```ts
if ((installed.manifest.permissions.network?.allow?.length ?? 0) > 0) {
  throw new Error("Permission denied: network access is not available in MVP runner.");
}
```

目标：删除这段拒绝逻辑，改为通过 `ctx.http.request()` 做受控访问。

#### 6.10.1 新增 network allow helper

```ts
function isNetworkAllowed(url: URL, allowedHosts: string[] | undefined): boolean {
  if (!allowedHosts?.length) return false;
  return allowedHosts.some((allowed) => {
    const normalized = allowed.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return (
      url.host === normalized ||
      url.hostname === normalized ||
      url.hostname.endsWith(`.${normalized}`)
    );
  });
}
```

是否允许子域名要按安全策略决定。如果不想自动允许子域名，删除 `endsWith` 分支。

#### 6.10.2 新增 HTTP body 构造 helper

```ts
function buildRequestBody(body: unknown): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return body;
  return JSON.stringify(body);
}
```

#### 6.10.3 新增 header redaction helper

```ts
function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    const lower = key.toLowerCase();
    output[key] =
      lower === "authorization" ||
      lower === "cookie" ||
      lower.includes("token") ||
      lower.includes("key") ||
      lower.includes("secret")
        ? "[REDACTED]"
        : value;
  }
  return output;
}
```

#### 6.10.4 在 SkillContext 中注入 http

在 `capability.handler(parsedInput, { ... })` 的 context 对象中新增：

```ts
http: {
  request: async (request) => {
    const url = new URL(request.url);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    if (!isNetworkAllowed(url, installed.manifest.permissions.network?.allow)) {
      throw new Error(`Permission denied: network access is not allowed for ${url.host}`);
    }

    await db.audit({
      runId: step.runId,
      stepId: step.id,
      actor: AuditActor.Daemon,
      action: "network.request",
      target: url.origin,
      risk: capability.risk,
      payload: {
        skillId: step.skillId,
        capability: step.capability,
        method: request.method,
        url: `${url.origin}${url.pathname}`,
        headers: redactHeaders(request.headers),
      },
    });

    const response = await fetch(url, {
      method: request.method,
      headers: {
        ...(request.body && typeof request.body !== "string"
          ? { "content-type": "application/json" }
          : {}),
        ...request.headers,
      },
      body: buildRequestBody(request.body),
      signal: controller.signal,
    });

    const headers = Object.fromEntries(response.headers.entries());
    const responseType = request.responseType ?? "json";
    const body =
      responseType === "arrayBuffer"
        ? Buffer.from(await response.arrayBuffer())
        : responseType === "text"
          ? await response.text()
          : await response.json();

    return {
      status: response.status,
      headers,
      body,
    };
  },
},
```

后续增强：

- 加 `AbortSignal.timeout(request.timeoutMs)` 与 run signal 组合。
- 限制最大响应体大小。
- 对非 2xx 是否 throw 需要统一策略。建议不自动 throw，由 skill client 判断状态码；但 audit 记录 status。
- 对 response body 做 redaction 后写 debug log，默认不要记录完整 body。

### 6.11 `packages/protocol/src/types.ts` 和 `packages/protocol/src/schemas.ts`

当前 `PermissionDeclaration` 已有：

```ts
export interface PermissionDeclaration {
  filesystem?: { read?: string[]; write?: string[] };
  network?: { allow?: string[] };
  env?: { allow?: string[] };
  shell?: boolean;
}
```

如果短期不实现 DB SDK，不需要改 protocol。

如果要为未来数据库受控访问预留，可以新增：

```ts
database?: { allow?: string[] };
```

并在 `permissionDeclarationSchema` 中新增：

```ts
database: z.object({ allow: z.array(z.string()).default([]) }).default({ allow: [] }),
```

但建议先不要加，避免规范承诺超过 runner 能力。

### 6.12 `packages/api/src/http/register-routes.ts`

删除 Workflows routes：

```ts
app.get("/v1/workflows", async () => database.workflows.list());
app.get<{ Params: { id: string } }>(
  "/v1/workflows/:id",
  async (request, reply) => {
    const workflow = await workflows.findById(request.params.id);
    return workflow ?? reply.code(404).send({ error: "not_found" });
  },
);
app.post("/v1/workflows/reload", async () => {
  await workflows.reload();
  return database.workflows.list();
});
```

保留 Skills routes：

```ts
app.get("/v1/skills", async () => database.skills.list());
app.get<{ Params: { id: string } }>(
  "/v1/skills/:id",
  async (request, reply) => {
    const skill = await skills.findById(request.params.id);
    return skill ?? reply.code(404).send({ error: "not_found" });
  },
);
app.post("/v1/skills/reload", async () => {
  await skills.reload();
  return database.skills.list();
});
```

如果 dashboard status 中有 workflows count，也要删除：

```ts
workflows: (await workflows.list()).length,
```

### 6.13 `packages/api/src/composition/api-deps.ts`

删除：

```ts
workflows: {
  reload(): Promise<unknown>;
  list(): Promise<unknown[]>;
  findById(id: string): Promise<unknown | null>;
};
```

所有使用 `deps.workflows` 的地方同步删除。

### 6.14 `packages/daemon/src/server.ts`

删除 import：

```ts
import { WorkflowRegistry } from "@sunpilot/workflow";
```

删除启动初始化：

```ts
const workflows = new WorkflowRegistry();
for (const record of workflows.records()) {
  await database.workflows.upsert(record);
}
```

删除 API deps：

```ts
workflows: {
  reload: async () => {
    for (const record of workflows.records()) {
      await database.workflows.upsert(record);
    }
  },
  list: async () => database.workflows.list(),
  findById: async (id: string) => database.workflows.findById(id),
},
```

删除 createAgentLoopService 入参：

```ts
workflows,
```

如果 `createMetricsHandler()` 需要 workflows，也删除对应参数。

### 6.15 `packages/daemon/src/metrics.ts`

当前 metrics 里有 workflow summary source：

```ts
workflows: { list(): unknown[] };
```

删除：

- interface 中的 workflows
- createMetricsHandler 参数中的 workflows
- `workflows.list()` 统计
- Prometheus output 中 workflow gauge

保留 skill metrics：

```text
sunpilot_skills_total
sunpilot_skills_enabled
sunpilot_tool_calls_total
sunpilot_tool_latency_ms
```

### 6.16 `packages/storage/src/database/database.types.ts`

当前：

```ts
import type { WorkflowRepository } from "../repositories/workflow.repository.js";

export interface DatabaseContext {
  workflows: WorkflowRepository;
  skills: SkillRepository;
  ...
}
```

目标：

```ts
export interface DatabaseContext {
  skills: SkillRepository;
  ...
}
```

删除 workflow import 和字段。

### 6.17 `packages/storage/src/postgres/postgres.database.ts`

删除 import：

```ts
import { PostgresWorkflowRepository } from "./postgres.workflow.repository.js";
```

删除字段：

```ts
readonly workflows: PostgresWorkflowRepository;
```

删除 constructor 初始化：

```ts
this.workflows = new PostgresWorkflowRepository(pool);
```

### 6.18 `packages/storage/src/postgres/index.ts`

删除：

```ts
export * from "./postgres.workflow.repository.js";
```

### 6.19 `packages/storage/src/repositories/index.ts`

删除：

```ts
export type * from "./workflow.repository.js";
```

### 6.20 `packages/storage/src/testing/in-memory-database.context.ts`

删除：

```ts
private readonly workflowRecords = new Map<string, WorkflowRecord>();
```

删除：

```ts
readonly workflows = {
  upsert: async (input: WorkflowRecord): Promise<WorkflowRecord> => { ... },
  list: async (): Promise<WorkflowRecord[]> => { ... },
  findById: async (id: string): Promise<WorkflowRecord | null> => { ... },
};
```

同时删除 `WorkflowRecord` type import。

### 6.21 `packages/storage/src/paths.ts`

当前 config 里可能还有：

```ts
workflows: {
  directories: [join(paths.home, "workflows")],
  autoReload: true,
}
```

目标删除：

- `SunPilotConfig.workflows`
- default config 中 `workflows`
- config merge 中 `workflows`
- config sanitize 中 `workflows`

保留：

```ts
skills: {
  directories: [join(paths.home, "skills")],
  autoReload: true,
}
```

注意：当前 daemon 还没有真正使用 `skills.directories`，后续应补上，但这不属于 workflow 删除的硬依赖。

### 6.22 `packages/storage/src/migrations`

当前 `006_catalog.sql` 创建：

```sql
CREATE TABLE IF NOT EXISTS workflows (...);
CREATE TABLE IF NOT EXISTS installed_skills (...);
```

历史 migration 不建议直接改，因为已发布数据库可能依赖 migration checksum/顺序。建议新增：

```text
packages/storage/src/migrations/013_drop_workflows.sql
```

保守版本：

```sql
-- 013_drop_workflows: stop using workflows catalog.
-- Keep the table for compatibility in this release.
```

彻底版本：

```sql
DROP TABLE IF EXISTS workflows;
```

如果新增 migration，要同步修改：

```text
packages/storage/src/postgres/postgres.migrations.ts
```

确保 migration list 注册新文件。

### 6.23 `packages/protocol/src/types.ts`

删除：

```ts
export interface WorkflowStepPlan { ... }
export interface WorkflowPlan { ... }
export interface WorkflowRecord { ... }
```

如果 `WorkflowStepPlan` 的结构还想保留给未来 composite skill，可以重命名为非 workflow 概念，例如：

```ts
export interface SkillStepPlan {
  id: string;
  name: string;
  type: "skill" | "approval" | "builtin" | "manual";
  skillId?: string;
  capability?: string;
  input: unknown;
  dependsOn?: string[];
  risk?: SkillRisk;
}
```

但不要在第一阶段过度设计。当前建议先删除 workflow 类型。

### 6.24 `packages/workflow`

最终删除整个包：

```text
packages/workflow
```

同时更新：

```text
pnpm-workspace.yaml
pnpm-lock.yaml
packages/daemon/package.json
packages/core/package.json
```

删除依赖：

```json
"@sunpilot/workflow": "workspace:*"
```

### 6.25 测试替换参考

#### 6.25.1 `packages/daemon/src/composition-root.test.ts`

当前 workflow 测试大概率形态：

```ts
await db.workflows.upsert({
  id: "daily.close",
  title: "Daily Close",
  enabled: true,
  definition: { description: "..." },
  ...
});

// expect skillId: "workflow.daily.close"
```

目标：改成 installed skill fixture：

```ts
const automationSkill: InstalledSkillRecord = {
  id: "sunpilot.automation",
  name: "SunPilot Automation",
  version: "0.1.0",
  path: "/tmp/sunpilot/skills/automation",
  enabled: true,
  manifest: {
    schemaVersion: "sunpilot.skill/v1",
    id: "sunpilot.automation",
    name: "SunPilot Automation",
    version: "0.1.0",
    description: "Automation capabilities.",
    entry: "dist/index.js",
    readme: "README.md",
    runtime: { node: ">=22", module: "esm" },
    capabilities: [
      {
        name: "daily.close",
        title: "Daily Close",
        description: "Run daily close automation.",
        inputSchema: {},
        outputSchema: {},
        risk: "medium",
        permissions: [],
      },
    ],
    permissions: {},
  },
  installedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
```

期望 tool call：

```ts
expect.objectContaining({
  skillId: "sunpilot.automation:daily.close",
});
```

最终 step：

```ts
expect.objectContaining({
  type: "skill",
  skillId: "sunpilot.automation",
  capability: "daily.close",
});
```

#### 6.25.2 `packages/core/src/agent-kernel/tools/tool-decision-engine.test.ts`

删除 workflow 专属测试：

```text
selects a named workflow skill for workflow intent
```

替换为：

```text
selects a named automation skill capability for automation intent
```

测试数据：

```ts
listSkills: async () => [
  {
    id: "sunpilot.automation:daily.close",
    name: "Daily Close",
    description: "Run daily close automation.",
    category: "automation",
    enabled: true,
    permissions: [],
    defaultTimeoutMs: 60_000,
    maxTimeoutMs: 300_000,
    supportsAbort: true,
    idempotent: false,
    riskHints: { defaultRisk: "medium" },
  },
],
```

#### 6.25.3 `packages/core/src/agent-kernel/context/context-builder.test.ts`

当前可能断言：

```ts
id: "workflow.daily-report",
category: "workflow",
```

目标：

```ts
id: "sunpilot.automation:daily-report.generate",
category: "automation",
```

#### 6.25.4 删除 `packages/workflow/src/executor.test.ts`

如果其中有有价值的 step 状态覆盖，应迁移到：

```text
packages/core/src/agent-kernel/execution/skill-tool-executor.test.ts
```

或者补到 daemon composition root 测试中，验证 skill execution 成功、失败、取消。

### 6.26 可直接删除的文件

```text
packages/workflow/src/executor.ts
packages/workflow/src/executor.test.ts
packages/workflow/src/registry.ts
packages/workflow/src/tool-adapter.ts
packages/workflow/src/index.ts
packages/workflow/package.json
packages/workflow/tsconfig.json

packages/core/src/agent-kernel/execution/workflow-tool-executor-adapter.ts
packages/core/src/agent-kernel/execution/tool-executor-bridge.ts

packages/storage/src/repositories/workflow.repository.ts
packages/storage/src/postgres/postgres.workflow.repository.ts
```

是否立即删除 `packages/workflow` 取决于是否还有未迁移测试。建议等 Phase 1 到 Phase 6 完成后再删包。

### 6.27 需要修改的文件

```text
packages/daemon/src/composition-root.ts
packages/daemon/src/server.ts
packages/daemon/src/metrics.ts
packages/daemon/package.json

packages/api/src/composition/api-deps.ts
packages/api/src/http/register-routes.ts

packages/core/src/agent-kernel/tools/tool-types.ts
packages/core/src/agent-kernel/tools/tool-decision-engine.ts
packages/core/src/agent-kernel/tools/tool-decision-engine.test.ts
packages/core/src/agent-kernel/context/context-builder.test.ts
packages/core/src/agent-kernel/intent/intent-router.ts
packages/core/src/agent-kernel/intent/intent-types.ts
packages/core/src/agent-kernel/loop-types.ts
packages/core/src/agent-kernel/agent-loop-engine.ts

packages/protocol/src/types.ts

packages/storage/src/database/database.types.ts
packages/storage/src/database/index.ts
packages/storage/src/postgres/index.ts
packages/storage/src/postgres/postgres.database.ts
packages/storage/src/testing/in-memory-database.context.ts
packages/storage/src/repositories/index.ts
packages/storage/src/paths.ts

developer_docs/*
```

### 6.28 需要重点改测试的文件

```text
packages/daemon/src/composition-root.test.ts
packages/core/src/agent-kernel/tools/tool-decision-engine.test.ts
packages/core/src/agent-kernel/context/context-builder.test.ts
packages/workflow/src/executor.test.ts
```

其中 `packages/workflow/src/executor.test.ts` 最终删除；其他测试改为使用 automation skill。

## 7. 数据迁移建议

当前 `workflows` 表结构：

```sql
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  version TEXT NOT NULL,
  source TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  definition JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

因为当前 workflow 没有真实执行语义，历史数据更像 preset catalog。建议迁移策略：

### 7.1 短期兼容迁移

不立刻 drop 表，代码停止读写：

```text
workflows table remains unused
new runtime ignores workflows
all new automations are installed skills
```

优点：

- 不破坏已有用户数据。
- 回滚简单。
- 可以后续提供导出工具。

缺点：

- DB 中保留历史表。

### 7.2 中期导出迁移

如果发现用户已有 workflows 数据，可以提供一次性导出：

```text
SELECT * FROM workflows
  -> 生成 ~/.sunpilot/skills/migrated-automations/<id>/skill.json
  -> definition 写入 README 或 schemas/config
  -> entry 使用通用 automation runner
```

但当前 workflow definition 没有标准可执行 DSL，因此自动迁移到可执行 skill 不一定可靠。更现实的迁移是保留记录作为文档 artifact。

### 7.3 最终清理

确认无兼容要求后新增 migration：

```sql
-- 013_drop_workflows.sql
DROP TABLE IF EXISTS workflows;
```

同时更新 migration 注册和防漏测试。

## 8. 风险与应对

### R1. 用户可能已经依赖 `/v1/workflows`

应对：

- 先在一个版本中返回 deprecation warning。
- 下一版本删除 route。
- 文档明确使用 `/v1/skills`。

### R2. 测试里 workflow 用例覆盖了一些 Agent 执行路径

应对：

- 用 automation skill 替代 workflow fixture。
- 保留“Agent 能执行 enabled tool”的覆盖，不保留 workflow 专属覆盖。

### R3. Intent 中 `workflow_execution` 删除后影响自然语言路由

应对：

- 若仍需要“执行流程”语义，改成 `automation_execution`。
- `automation_execution` 只映射普通 skill capability。

### R4. 删除 workflows 表可能破坏已有 DB

应对：

- 第一阶段代码停用但不 drop 表。
- 最终 drop 前提供 migration 说明或导出方案。

### R5. Skill capability 当前 id 没有全限定

清 workflow 时建议顺手解决：

```text
capability.name -> skill.id:capability.name
```

否则 workflow 清了，但多个 automation skill 仍可能出现 capability name 冲突。

## 9. 推荐实施顺序

建议按以下 PR 或提交顺序推进：

1. 新增 automation skill fixture，并让 Agent 测试通过 skill 执行复合能力。
2. 将 catalog 中 skill capability id 改为全限定格式。
3. 删除 workflowToToolDescriptor 混入 catalog 的逻辑。
4. 删除 ToolDecisionEngine 的 workflow 特判。
5. 删除 ToolExecutorBridge 和 WorkflowToolExecutorAdapter，ExecutionOrchestrator 直接使用 SkillToolExecutor。
6. 删除 `/v1/workflows` API 和 daemon workflows deps。
7. 删除 DatabaseContext workflows repository 和 Postgres/in-memory 实现。
8. 删除 `packages/workflow` 包。
9. 更新文档和架构报告。
10. 运行完整验证。

建议每一步都运行：

```bash
pnpm --filter @sunpilot/core test
pnpm --filter @sunpilot/daemon test
pnpm --filter @sunpilot/storage test
```

最终运行：

```bash
pnpm -r build
pnpm -r lint
pnpm test
```

## 10. 完成后的架构形态

完成清理后，主路径应变成：

```text
Web / CLI / HTTP
  -> api
  -> AgentService
  -> AgentLoopEngine
  -> ContextBuilder skill catalog
  -> ToolDecisionEngine
  -> ApprovalGate
  -> ExecutionOrchestrator
  -> SkillToolExecutor
  -> SkillRunner
  -> Skill capability handler
  -> events / artifacts / memory / audit / response
```

包职责会更清晰：

| 包 | 清理后职责 |
| --- | --- |
| `protocol` | 不再定义 Workflow 类型，只保留 Skill/tool/Agent runtime 契约。 |
| `core` | 不依赖 workflow adapter，只保留通用 ToolExecutor 和 SkillToolExecutor。 |
| `daemon` | 只装配 SkillRegistry 和 SkillRunner。 |
| `storage` | 只持久化 installed_skills，不再持久化 workflows catalog。 |
| `skill-sdk` | 支持原子能力和复合能力。 |
| `skill-runner` | 作为唯一外部能力运行时。 |

## 11. 最终验收标准

代码层：

```bash
rg "workflow" packages
```

允许残留：

- migration 历史注释或旧 SQL 文件
- changelog / 文档中解释历史迁移的文字

不应残留：

- `workflow.*` skillId 路由
- `WorkflowToolExecutor`
- `WorkflowRegistry`
- `WorkflowRecord`
- `database.workflows`
- `/v1/workflows`
- `workflow_execution` 特殊 intent

测试层：

```bash
pnpm -r build
pnpm -r lint
pnpm test
```

全部通过。

产品层：

- 用户看到的是 Skills / Capabilities / Automations，不再看到 Workflow 作为独立菜单或 API。
- 所有可执行能力都能从 `/v1/skills` 查询。
- Agent timeline 中 tool step 仍显示 `type: "skill"`。
- 审批、artifact、memory、audit 行为不回退。

## 12. 关键设计原则

清理 workflow 不是删除“多步骤能力”，而是删除“重复抽象”。多步骤能力仍然存在，只是表达为 Skill capability：

```text
workflow as concept     -> remove
automation as product   -> keep
automation as runtime   -> skill capability
```

这样 SunPilot 的可执行能力模型会更统一，后续要扩展复杂编排时，也可以在 SkillRunner 内部增加 composite capability 支持，而不是重新维护一套并行 workflow runtime。
