# SunPilot Skill 范式规范详细总结

更新日期：2026-06-28

依据：`packages/protocol/src/schemas.ts`、`packages/skill-sdk/src/index.ts`、`packages/skill-runner/src/registry.ts` 与 `runner.ts`。

## 1. 定位

Skill 是 SunPilot 的工具扩展单元。Agent Core 负责发现和决定调用哪个 capability，SkillRunner 负责加载、校验和执行。一个 Skill 可以暴露多个 capability，每个 capability 都有 input/output Zod schema、risk 和异步 handler。

当前安全边界是应用层 allowlist，不是进程隔离：Skill entry 通过 dynamic `import()` 加载到 daemon 进程。只安装受信代码。

## 2. 推荐目录

```text
~/.sunpilot/skills/example-skill/
  skill.json
  README.md
  dist/
    index.js
  schemas/                 # 可选，manifest 也可内嵌 JSON Schema
    input.json
    output.json
```

Registry 扫描传入目录下的一级子目录；如果扫描根本身包含 `skill.json`，也会把它当成一个 Skill。

当前 daemon 实际只传入 `~/.sunpilot/skills`。`config.json` 中的 `skills.directories` 尚未用于 Registry 构造，因此配置额外目录不会生效。

## 3. skill.json 合同

```json
{
  "schemaVersion": "sunpilot.skill/v1",
  "id": "example.lookup",
  "name": "Example Lookup",
  "version": "1.0.0",
  "description": "Looks up an example record.",
  "entry": "dist/index.js",
  "readme": "README.md",
  "author": { "name": "Example Team" },
  "runtime": { "node": ">=22", "module": "esm" },
  "capabilities": [
    {
      "name": "lookup",
      "title": "Lookup",
      "description": "Find one record by id.",
      "inputSchema": {
        "type": "object",
        "properties": { "id": { "type": "string" } },
        "required": ["id"]
      },
      "outputSchema": {
        "type": "object",
        "properties": { "name": { "type": "string" } },
        "required": ["name"]
      },
      "risk": "low",
      "permissions": []
    }
  ],
  "permissions": {
    "filesystem": { "read": [], "write": [] },
    "network": { "allow": ["api.example.com"] },
    "env": { "allow": ["EXAMPLE_API_KEY"] },
    "shell": false
  }
}
```

约束：

- `schemaVersion` 必须为 `sunpilot.skill/v1`；
- `runtime.module` 必须为 `esm`；
- 至少一个 capability；
- risk 只能是 `low / medium / high / critical`；
- `entry`、`readme` 和字符串 schema 路径必须是 Skill 根目录内的相对路径；
- `readme` 和字符串 schema 必须存在；Registry 当前只解析 entry 路径，不在 reload 时强制 entry 文件存在；执行 import 时才会失败。

## 4. SDK entry

```ts
import { z } from "zod";
import { defineSkill } from "@sunpilot/skill-sdk";

export default defineSkill({
  id: "example.lookup",
  version: "1.0.0",
  capabilities: {
    lookup: {
      input: z.object({ id: z.string().min(1) }),
      output: z.object({ name: z.string() }),
      risk: "low",
      async handler(input, ctx) {
        const apiKey = await ctx.secrets.get("EXAMPLE_API_KEY");
        const response = await ctx.http.request<{ name: string }>({
          method: "GET",
          url: `https://api.example.com/items/${encodeURIComponent(input.id)}`,
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        ctx.events.emit("skill.progress", { stage: "done" });
        return { name: response.body.name };
      },
    },
  },
});
```

entry 的 `id` 和 `version` 必须与 manifest 完全一致；capability 名必须在 manifest 和 entry 两处同时存在。

## 5. SkillContext

| API                        | 用途                          | 约束                                            |
| -------------------------- | ----------------------------- | ----------------------------------------------- |
| `signal`                   | 取消/超时                     | handler 应传给内部异步操作                      |
| `events.emit`              | 进度事件                      | `skill.progress` 归一化为 `agent.tool.delta`    |
| `artifacts.write`          | 写产物                        | 写到 SunPilot artifact 目录并持久化             |
| `files.readText/writeText` | 文件访问                      | 路径必须命中 manifest allowlist                 |
| `memory.write`             | 写 run-scope tool observation | 自动持久化、审计并发事件                        |
| `secrets.get`              | 读取 env                      | 名称必须在 `permissions.env.allow`              |
| `http.request`             | HTTP 请求                     | host 必须在 `permissions.network.allow`         |
| `logger`                   | skill 日志                    | 写入 `~/.sunpilot/logs/skill.log`，payload 脱敏 |

HTTP allowlist 支持精确 host、hostname 和子域匹配。审计会隐藏 authorization/cookie/token/key/secret 类 header；Skill 自己不应把密钥拼进 URL 或日志。

## 6. Registry 生命周期

```text
daemon start / POST /v1/skills/reload
  -> SkillRegistry.reload()
  -> 扫描 skill.json
  -> Zod 校验 + 路径约束
  -> 读取 README 前 20 行
  -> upsert skills 表
  -> 原子替换内存 Map
  -> 写 skill.load / skill.load.failed audit
  -> 清空 skill/embedding cache
```

reload 使用 promise mutex，新的 Map 完整构建后才替换旧快照，避免并发读取半成品。加载失败不会阻断其他 Skill。

## 7. Agent 到 Runner 链路

```text
IntentRouter / ToolRetriever
  -> ToolDecisionEngine
  -> 参数生成、归一化、schema 校验/repair
  -> PermissionPolicy / ApprovalGate / ToolSandbox
  -> ExecutionOrchestrator
  -> SkillToolExecutor
  -> SkillRunner.execute(step)
  -> capability.handler(input, ctx)
  -> output schema 校验
  -> tool result persistence / projection / reflection
```

Skill 不应自行决定审批。risk 和 permission mode 由上层 Agent Runtime 统一处理。

## 8. Runner 执行保证

- 默认最大并发 `4`，等待队列按 slot 释放推进；
- 默认超时 `300000ms`，超时会 abort 并写 audit；
- run 被 interrupted 时拒绝开始或中断 active controller；
- handler 前做 input Zod parse，返回后做 output Zod parse；
- manifest 声明 `shell: true` 会被直接拒绝，当前没有 shell API；
- network 只能通过 `ctx.http.request()`；
- capability 运行、文件、网络、secret、memory、timeout 都写审计记录。

## 9. 已知边界

1. dynamic import 的模块顶层代码可绕过 `SkillContext`，所以 allowlist 不是强安全沙箱。
2. `skills.directories` 和 `autoReload` 目前写入 config，但 daemon 未按它们动态装配/监听。
3. manifest 的 capability `permissions: string[]` 目前主要是描述字段，真正执行约束来自顶层 `permissions`。
4. manifest JSON Schema 与 runtime Zod schema 没有自动等价性校验，开发者必须用测试保持一致。
5. Skill id 没有强制命名空间格式，建议团队自行采用 `vendor.skill`。
6. runner 不支持独立依赖安装、签名校验和版本锁仓。

## 10. 开发与验收规范

每个 Skill 至少覆盖：

1. manifest schema 和路径穿越拒绝；
2. 正常 input/output；
3. 缺参和非法参数；
4. network/files/env allowlist 正反例；
5. timeout 与 abort；
6. handler 错误的 audit/tool failure；
7. 高风险 capability 的 approval；
8. structured result 被后续 Agent 正确消费。

发布前还应固定 `id`、语义化 `version`、README 使用说明、最小权限和真实 API mock。对不可信第三方 Skill，在进程隔离完成之前不要安装到生产 daemon。
