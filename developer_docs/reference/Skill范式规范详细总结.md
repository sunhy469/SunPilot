# SunPilot Skill 范式规范详细总结

更新时间：2026-06-11

本文档基于当前工作区实际代码，总结 SunPilot 现有 Skill 接入范式、运行链路、权限边界、数据模型和开发约束。它描述的是项目代码里的 `@sunpilot/skill-sdk` / `@sunpilot/skill-runner` 机制，不是 Codex 本地 `SKILL.md` 说明文件机制。

## 1. 总体定位

SunPilot 当前的 Skill 是一套本地可安装的 ESM 插件机制：

```text
用户安装目录
  -> skill.json manifest
  -> SkillRegistry 扫描、校验、入库
  -> Agent ToolDecisionEngine 选择 capability
  -> SkillToolExecutor 创建 step
  -> SkillRunner 动态 import entry
  -> capability.handler(input, context)
  -> artifacts / memory / events / audit / step status
```

核心目标是把外部能力以统一的 tool/capability 形式暴露给 Agent，同时通过 manifest 做可发现、可审计、可授权，通过 SDK context 限制 Skill 代码访问系统内部状态。

当前相关包：

| 包 | 职责 |
| --- | --- |
| `packages/protocol` | 定义 `SkillManifest`、`InstalledSkillRecord`、权限、risk、step 等共享类型和 Zod schema。 |
| `packages/skill-sdk` | 给 Skill 作者使用，定义 `defineSkill()`、`SkillCapability`、`SkillContext` 和测试 helper。 |
| `packages/skill-runner` | 扫描 skill、校验 manifest、动态 import entry、执行 handler、权限检查、超时/并发/中断控制。 |
| `packages/core` | Agent 侧的 tool 选择、审批、执行编排和 `SkillToolExecutor`。 |
| `packages/daemon` | 装配 `SkillRegistry`、`SkillRunner`、数据库、Agent Loop 和 HTTP API。 |
| `packages/storage` | 持久化 installed skills、steps、events、artifacts、memory、audit、tool calls。 |

## 2. Skill 文件结构规范

一个可被当前 `SkillRegistry` 加载的 skill 目录至少需要：

```text
<skill-root>/
  skill.json
  README.md
  dist/
    index.js
  schemas/
    input.json
    output.json
```

实际文件名不强制固定，但 `skill.json` 中的 `entry`、`readme`、`inputSchema`、`outputSchema` 必须指向存在的相对路径。典型结构如下：

```json
{
  "schemaVersion": "sunpilot.skill/v1",
  "id": "example.files",
  "name": "Example Files",
  "version": "0.1.0",
  "description": "Read and summarize local files.",
  "entry": "dist/index.js",
  "readme": "README.md",
  "runtime": {
    "node": ">=22",
    "module": "esm"
  },
  "capabilities": [
    {
      "name": "filesystem.read",
      "title": "Read File",
      "description": "Read a text file from an allowed path.",
      "inputSchema": "schemas/read-input.json",
      "outputSchema": "schemas/read-output.json",
      "risk": "low",
      "permissions": ["filesystem.read"]
    }
  ],
  "permissions": {
    "filesystem": {
      "read": ["./data"],
      "write": []
    },
    "network": {
      "allow": []
    },
    "env": {
      "allow": []
    },
    "shell": false
  }
}
```

对应代码位置：

- Manifest TypeScript 类型：`packages/protocol/src/types.ts`
- Manifest Zod schema：`packages/protocol/src/schemas.ts`
- 路径安全校验：`packages/skill-runner/src/registry.ts`

## 3. Manifest 数据契约

`SkillManifest` 当前定义：

```ts
export interface SkillManifest {
  schemaVersion: "sunpilot.skill/v1";
  id: string;
  name: string;
  version: string;
  description: string;
  entry: string;
  readme: string;
  author?: { name: string };
  runtime: { node: string; module: "esm" };
  capabilities: SkillManifestCapability[];
  permissions: PermissionDeclaration;
}
```

`SkillManifestCapability` 当前定义：

```ts
export interface SkillManifestCapability {
  name: string;
  title: string;
  description: string;
  inputSchema: string | Record<string, unknown>;
  outputSchema: string | Record<string, unknown>;
  risk: SkillRisk;
  permissions: string[];
}
```

重要约束：

- `schemaVersion` 目前只接受 `sunpilot.skill/v1`。
- `runtime.module` 目前只接受 `esm`。
- `capabilities` 至少需要一个能力。
- `inputSchema` 和 `outputSchema` 可以是 JSON schema 对象，也可以是 skill 根目录内的相对路径。
- `permissions` 分两层：
  - manifest 顶层 `permissions` 是 runner 强制执行的权限边界。
  - capability 内的 `permissions` 是决策/审批层可消费的能力声明。

## 4. SDK entry 规范

Skill entry 是 ESM 模块，默认导出 `SkillDefinition`。建议使用 `defineSkill()`：

```ts
import { z } from "zod";
import { defineSkill } from "@sunpilot/skill-sdk";

const input = z.object({
  path: z.string(),
});

const output = z.object({
  content: z.string(),
});

export default defineSkill({
  id: "example.files",
  version: "0.1.0",
  capabilities: {
    "filesystem.read": {
      input,
      output,
      risk: "low",
      async handler(input, context) {
        const content = await context.files.readText(input.path);
        context.logger.info("file read", { path: input.path });
        return { content };
      },
    },
  },
});
```

SDK 类型定义在 `packages/skill-sdk/src/index.ts`：

```ts
export interface SkillDefinition {
  id: string;
  version: string;
  capabilities: Record<string, SkillCapability<any, any>>;
}

export interface SkillCapability<I, O> {
  input: ZodSchema<I>;
  output: ZodSchema<O>;
  risk: SkillRisk;
  handler(input: I, context: SkillContext): Promise<O>;
}
```

Runner 会强制校验 entry 默认导出的 `definition.id` 和 `definition.version` 必须与 manifest 一致。否则执行失败。

## 5. SkillContext 能力边界

Skill handler 不能直接访问 Agent 内部状态，只能通过 `SkillContext` 与宿主交互：

| Context API | 当前作用 | Runner 行为 |
| --- | --- | --- |
| `runId` / `stepId` / `skillId` / `capability` | 当前执行上下文标识 | 由 `SkillRunner` 从 `StepRecord` 注入。 |
| `signal` | 中断和超时信号 | run 被 interrupt 或执行超时时触发 abort。 |
| `events.emit(type, payload)` | 发出进度或自定义事件 | 标准事件透传，未知事件包装为 `agent.tool.delta`。 |
| `artifacts.write(input)` | 写 artifact | 写入 artifact 文件和 DB，追加 `agent.artifact.created` 事件。 |
| `files.readText(path)` | 读文本文件 | 检查 `manifest.permissions.filesystem.read` 后读取。 |
| `files.writeText(path, content)` | 写文本文件 | 检查 `manifest.permissions.filesystem.write` 后写入。 |
| `memory.write(key, value)` | 写运行记忆 | 创建 `MemoryRecord`，追加 `agent.memory.written` 事件。 |
| `secrets.get(name)` | 读取环境变量 | 必须在 `manifest.permissions.env.allow` 声明，audit 中隐藏 secret 名称。 |
| `logger.info/warn/error` | 写 skill 日志 | 写入 `logs/skill.log`，并做敏感信息 redaction。 |

这层 context 是 Skill 插件边界。Skill 作者应只依赖 SDK context，不依赖 `@sunpilot/core`、`@sunpilot/storage` 或 daemon 内部实现。

## 6. Registry 加载链路

入口代码：`packages/skill-runner/src/registry.ts`

`SkillRegistry.reload()` 当前流程：

```text
directories + bundledDirectories
  -> 如果 root/skill.json 存在，则 root 本身是 skill
  -> 否则扫描 root 下一级目录
  -> 读取 candidate/skill.json
  -> skillManifestSchema.parse()
  -> validateManifestPaths()
  -> 读取 README 前 20 行作为 readmeSummary
  -> 生成 InstalledSkillRecord
  -> db.skills.upsert(record)
  -> audit: skill.load
```

加载失败时：

```text
skill.load.failed
target = 失败的 skill 目录绝对路径
risk = high
payload.message = 错误信息
```

失败的 skill 不会阻断其他 skill 加载。

路径安全规则：

- `entry`、`readme`、schema 文件必须是相对路径。
- 路径 resolve 后必须位于 skill 根目录之内。
- 绝对路径和 `../` 路径穿越会失败。

测试覆盖在 `packages/skill-runner/src/registry.test.ts`，当前重点覆盖：

- valid skill load
- entry path escape
- readme missing
- bad skill 不影响 good skill

## 7. Daemon 装配链路

入口代码：`packages/daemon/src/server.ts`

daemon 启动时：

```ts
const paths = ensureSunPilotHome(getSunPilotPaths());
const skillRegistry = new SkillRegistry(database, [paths.skills]);
await skillRegistry.reload();
const skillRunner = new SkillRunner(..., skillRegistry, {
  timeoutMs: Number(process.env.SUNPILOT_SKILL_TIMEOUT_MS ?? 5 * 60_000),
  maxConcurrency: Number(process.env.SUNPILOT_SKILL_MAX_CONCURRENCY ?? 4),
});
```

默认 skill 目录来自 `getSunPilotPaths()`：

```text
~/.sunpilot/skills
```

配置文档中仍有 `skills.directories` 和 `skills.autoReload` 字段，但当前 daemon 实际构造 `SkillRegistry` 时使用的是 `paths.skills`。如果后续要支持多个目录，应让 server 读取 config 中的 `skills.directories`。

HTTP API：

```text
GET  /v1/skills
GET  /v1/skills/:id
POST /v1/skills/reload
POST /v1/skills/:id/enable
POST /v1/skills/:id/disable
```

对应位置：`packages/api/src/http/register-routes.ts`

## 8. Agent 决策链路

Skill 不直接被用户调用，而是进入 Agent 的 tool catalog。

主要链路：

```text
ContextBuilder.listSkills()
  -> skillRegistry.list()
  -> skill manifest capabilities
  -> AgentContext.availableSkills

ToolDecisionEngine.listSkills()
  -> skillRegistry.list()
  -> SkillSummary[]
  -> 根据 intent / plan / fallback map 选择 toolCalls
```

相关代码：

- `packages/daemon/src/composition-root.ts`
- `packages/core/src/agent-kernel/context/context-builder.ts`
- `packages/core/src/agent-kernel/tools/tool-decision-engine.ts`
- `packages/core/src/agent-kernel/tools/tool-types.ts`

当前 `composition-root.ts` 中对 Skill catalog 的处理方式：

```ts
const skillCapabilities = skills.flatMap((s) =>
  s.manifest.capabilities.map((capability) => ({
    id: capability.name,
    name: capability.title,
    description: capability.description,
    category: categoryFromCapability(capability.name),
  })),
);
```

注意：这里暴露给 Agent 的 `id` 是 capability name，而不是 manifest 的 skill id。执行时 `SkillToolExecutor.resolveCapability()` 支持两种形式：

```text
capabilityName
skillId:capabilityName
```

如果没有 `skillId:` 前缀，会遍历所有 enabled skill，找到第一个匹配 capability name 的 skill。因此当前规范里应避免不同 skill 暴露同名 capability，除非后续把 catalog id 收敛为全限定形式。

推荐后续改进：

```text
tool id = <skill-id>:<capability-name>
display name = capability.title
```

这样可以避免 capability name 全局冲突。

## 9. 执行链路

执行入口在 `packages/core/src/agent-kernel/execution/skill-tool-executor.ts`。

标准流程：

```text
ExecutionOrchestrator
  -> ToolExecutor.execute()
  -> SkillToolExecutor.execute()
  -> resolveCapability(listSkills(), input.skillId)
  -> create StepRecord(type="skill", status="running")
  -> SkillRunner.execute(step)
  -> update step status
  -> list new artifacts
  -> return normalized tool result
```

`StepRecord` 关键字段：

```ts
{
  id: input.toolCallId,
  runId: input.runId,
  type: "skill",
  name: target.capability.title,
  status: "running",
  skillId: target.skill.id,
  capability: target.capability.name,
  input: input.arguments
}
```

因此持久化 step 里真正记录的是：

- `skillId`: manifest id
- `capability`: capability name
- `input`: tool call arguments

执行成功后：

- `step.status = completed`
- `step.output = capability.output.parse(result)`
- `tool result.summary` 来自 output JSON 或 string
- 新增 artifacts 会被返回给 Agent observation

执行失败后：

- 如果 input signal aborted，step 标记 `cancelled`
- 否则 step 标记 `failed`
- error code 为 `AGENT_RUN_CANCELLED` 或 `AGENT_TOOL_EXECUTION_FAILED`

## 10. Runner 执行模型

入口代码：`packages/skill-runner/src/runner.ts`

`SkillRunner.execute(step)` 当前提供：

### 10.1 并发限制

```text
maxConcurrency 默认 4
环境变量 SUNPILOT_SKILL_MAX_CONCURRENCY 可调整
```

实现方式是进程内信号量：

```text
activeExecutions
waiters[]
acquireSlot()
releaseSlot()
```

### 10.2 超时限制

```text
timeoutMs 默认 5 分钟
环境变量 SUNPILOT_SKILL_TIMEOUT_MS 可调整
```

超时时：

- `AbortController.abort()`
- audit `skill.timeout`
- Promise reject

### 10.3 中断支持

`interruptRun(runId)` 会 abort 当前 run 下所有 active controller。Skill handler 应尊重 `context.signal`，尤其是长任务、循环、外部 IO。

### 10.4 输入输出校验

执行前：

```ts
const parsedInput = capability.input.parse(step.input);
```

执行后：

```ts
return capability.output.parse(result);
```

这意味着 Skill entry 里的 Zod schema 是 runtime 的真实输入/输出边界。Manifest 中的 JSON schema 当前主要用于 catalog/展示/未来 schema 交互，并不参与 `SkillRunner` 的 parse。

### 10.5 权限检查

当前 runner 强制：

- manifest 顶层 `permissions.shell === true` 时直接拒绝。
- manifest 顶层 `permissions.network.allow` 非空时直接拒绝。
- 文件读写按 allow path 检查。
- secret 读取按 `env.allow` 检查。

也就是说，MVP runner 目前不支持 shell 和 network，即便 manifest 声明了也会失败：

```text
Permission denied: shell access is not allowed in MVP runner.
Permission denied: network access is not available in MVP runner.
```

## 11. 持久化模型

Skill 安装记录：

- Type：`InstalledSkillRecord`
- Repository：`packages/storage/src/repositories/skill.repository.ts`
- Postgres：`packages/storage/src/postgres/postgres.skill.repository.ts`
- Migration：`packages/storage/src/migrations/006_catalog.sql`

表结构：

```sql
CREATE TABLE IF NOT EXISTS installed_skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  path TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  readme_summary TEXT,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Skill 执行不会写独立的 skill execution 表，而是复用 Agent runtime 的通用表：

- `steps`
- `tool_calls`
- `events`
- `artifacts`
- `memory`
- `audit_logs`

这种设计是合理的：Skill 是 Agent tool 的一种执行来源，执行事实应该进入通用 run timeline。

## 12. 测试范式

Skill SDK 提供本地测试 helper：`packages/skill-sdk/src/testing.ts`

```ts
testSkill(skill, capabilityName, input, {
  files: {
    "/tmp/input.txt": "hello"
  },
  secrets: {
    API_KEY: "test"
  }
});
```

该 helper 会：

- 调用 capability input parse
- 构造内存 files map
- 提供 fake artifacts API
- 提供 fake logger/events/memory
- 调用 handler
- 调用 output parse

适合 Skill 作者单测 capability handler，不适合测试 manifest 加载和 runner 权限边界。权限、超时、并发、中断应放在 `skill-runner` 层测试。

## 13. 当前设计优点

### 13.1 边界清楚

Skill 作者依赖 `@sunpilot/skill-sdk`，运行时依赖 `@sunpilot/skill-runner`，Agent 决策层只看 catalog summary。Skill 代码不直接依赖 core/storage/daemon。

### 13.2 manifest 和 runtime 双校验

manifest 用于发现、权限声明、schema 描述；entry runtime 用 Zod 做真实输入输出 parse。两层校验能避免加载和执行混在一起。

### 13.3 权限模型集中在 runner

文件、secret、artifact、memory、event、logger 全部由 context API 暴露，权限检查不分散在 Skill 代码中。

### 13.4 可观测性完整

加载、执行、文件读写、secret 读取、memory 写入、artifact 创建、超时都进入 audit/events/steps。

## 14. 当前设计问题

### 14.1 Tool id 没有全限定

Agent catalog 当前把 capability name 当成 skill id 使用，例如 `filesystem.read`。执行器会遍历所有 skill 找第一个 matching capability。这会带来冲突风险。

建议改为：

```text
tool id = <skill-id>:<capability-name>
```

并让 `ToolDecisionEngine`、plan、tool call、approval、tool_calls 表全部使用同一格式。

### 14.2 Manifest JSON schema 与 Zod schema 没有关联校验

manifest 的 `inputSchema` / `outputSchema` 与 entry 的 Zod schema 当前没有一致性检查。短期可以接受，但长期需要：

- 约定 manifest schema 用于 UI/form 生成。
- Zod schema 用于 runtime parse。
- 增加开发时验证或 build 脚本，避免两者漂移。

### 14.3 Config 中 skills.directories 当前没有被 daemon 使用

配置文件描述了多个 skill directories，但 `server.ts` 当前直接使用 `[paths.skills]`。如果要支持多目录安装，需要把 config 接入 `SkillRegistry`。

### 14.4 shell/network 权限声明已存在但 runner 不支持

manifest schema 支持 `shell`、`network.allow`，但 runner 当前直接拒绝。这是 MVP 合理约束，但文档和 API 应明确标识为 unsupported，避免 Skill 作者误以为可用。

### 14.5 workflow 仍作为伪 skill 混入 catalog

`composition-root.ts` 当前会把 `database.workflows.list()` 转成 `workflow.*` tool descriptor 混入 skill catalog。这让 Agent 侧同时存在 Skill 和 Workflow 两套 tool 来源，但 workflow 当前并没有真正执行 steps。建议按另一份优化文档清理。

## 15. 当前推荐开发规范

新增 Skill 时建议遵守：

1. 每个 skill 必须有稳定 `id`，建议反域名或产品域名前缀，例如 `sunpilot.files`、`acme.crm`。
2. capability name 应避免全局冲突，当前阶段建议继续使用明确命名，例如 `filesystem.read`、`crm.contact.search`。
3. `skill.json` 的 `permissions` 只声明 handler 实际需要的最小权限。
4. handler 必须使用 `context.signal` 响应取消，长任务应定期检查 `signal.aborted`。
5. 输入输出必须用 Zod schema 严格定义，不要返回 schema 外字段。
6. 产物必须通过 `context.artifacts.write()` 写，不要绕过 storage 路径。
7. 需要持久化给 Agent 使用的观察结果写入 `context.memory.write()`，普通调试信息写 logger。
8. secret 只能通过 `context.secrets.get()` 获取，不能直接读取 `process.env`。
9. 不要在 Skill 内部 import core/storage/daemon。
10. 测试至少覆盖 SDK helper 单测和 runner 层集成测试。

## 16. 建议的目标范式

长期建议将 SunPilot 的工具体系收敛为：

```text
SkillManifest
  -> SkillCapability[]
      -> atomic capability
      -> composite capability
      -> automation capability

Agent Tool Catalog
  -> <skill-id>:<capability-name>

Execution
  -> SkillToolExecutor
  -> SkillRunner
```

在这个范式下，所有可执行能力都叫 Skill Capability。所谓 workflow、automation、preset、recipe 都只是 capability 的不同实现方式，不再需要独立 workflow registry、workflow table 和 workflow executor。

