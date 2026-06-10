# SunPilot AI 前后端项目抽象为 TypeScript Skill 的 Codex 提示词

更新日期：2026-06-11（更新：ctx.http 已可用、workflow 已移除、全限定 id 已就绪）

本文档是一份可直接交给 Codex 使用的完整提示词，用于把一个已有的 Spring Boot + React + 数据库 AI 应用项目，抽象为一组符合 SunPilot 当前规范的 TypeScript Skill。

使用方式：把下面"完整提示词"整段复制给 Codex，并把目标 AI 应用项目路径、SunPilot 项目路径、期望 skill 名称、需要优先迁移的业务能力补充进去。

## 完整提示词

你是一个资深全栈工程迁移专家和 TypeScript 插件架构工程师。现在要把一个已有的 AI 应用项目抽象为一组可接入 SunPilot 的 TypeScript skills。

### 任务背景

源项目是一个前后端 AI 应用：

```text
后端：Spring Boot / Java
前端：React
数据库：可能包含 MySQL/PostgreSQL 等业务表
配置：大量 .env / application.yml / application.properties 环境变量
外部能力：多个 RESTful API、多个 AI 模型接口、第三方平台接口
典型接口：Seedance 视频生成、Seedream 图片生成、1688 货源获取、商品文案生成、素材批量生成等
```

目标项目是 SunPilot：

```text
SunPilot 是 TypeScript monorepo
Skill SDK: packages/skill-sdk
Skill Runner: packages/skill-runner
Skill manifest schema: packages/protocol/src/types.ts 和 packages/protocol/src/schemas.ts
Skill 默认安装目录: ~/.sunpilot/skills
```

你要完成的是"抽象与生成 TypeScript Skill"，不是把原项目整站迁移成 SunPilot 页面。

### 总目标

请分析源项目的 controller、service、client、DTO、entity、repository、scheduled job、configuration、`.env`/`application.yml`、React 页面/表单/状态/API client、数据库 schema/migration/SQL/JPA entity。

然后抽象出一组符合 SunPilot 规范的 TypeScript skills。

要求：

1. Skill 是业务域插件。
2. Capability 是 Agent 可以独立调用、独立审批、独立失败重试的一项工具能力。
3. 不要机械迁移 Java Controller 方法。
4. 不要把 React 页面组件迁移为 Skill。
5. 要从前端表单和页面中提取输入字段、业务意图、用户工作流。
6. 要从后端 service/client 中提取真正的外部 API 调用、模型调用和业务动作。
7. 要从数据库中识别哪些数据应变成 skill config、input schema、output schema、artifact metadata、memory。
8. 生成 TypeScript ESM skill，能被 SunPilot 当前 `SkillRegistry` 和 `SkillRunner` 加载。

### SunPilot Skill 规范

每个 skill 目录必须包含：

```text
<skill-root>/
  skill.json
  README.md
  package.json
  tsconfig.json
  src/
    index.ts
    schemas.ts
    clients/
    capabilities/
    utils/
  dist/
    index.js
  schemas/
    *.input.json
    *.output.json
```

`skill.json` 必须满足：

```json
{
  "schemaVersion": "sunpilot.skill/v1",
  "id": "cross-border-ecommerce",
  "name": "外贸电商",
  "version": "0.1.0",
  "description": "Cross-border ecommerce AI tools.",
  "entry": "dist/index.js",
  "readme": "README.md",
  "runtime": { "node": ">=22", "module": "esm" },
  "capabilities": [],
  "permissions": {
    "filesystem": { "read": [], "write": [] },
    "network": { "allow": [] },
    "env": { "allow": [] },
    "shell": false
  }
}
```

Skill entry 必须默认导出 `defineSkill()`：

```ts
import { defineSkill } from "@sunpilot/skill-sdk";
import { videoGenerateSeedanceInput, videoGenerateSeedanceOutput } from "./schemas.js";

export default defineSkill({
  id: "cross-border-ecommerce",
  version: "0.1.0",
  capabilities: {
    "video.generate.seedance": {
      input: videoGenerateSeedanceInput,
      output: videoGenerateSeedanceOutput,
      risk: "medium",
      async handler(input, ctx) {
        // implementation using ctx.http / ctx.secrets / ctx.artifacts
      },
    },
  },
});
```

Capability 命名规范：`<domain>.<action>[.<provider>]`

推荐示例：

```text
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

Agent tool id 使用全限定格式：

```text
<skill-id>:<capability-name>
```

例如：`cross-border-ecommerce:video.generate.seedance`、`cross-border-ecommerce:image.generate.seedream`。

### 权限规范

所有 secret 通过 manifest 声明：

```json
{
  "permissions": {
    "env": {
      "allow": ["SEEDANCE_API_KEY", "SEEDREAM_API_KEY", "ALI1688_APP_KEY", "ALI1688_APP_SECRET"]
    }
  }
}
```

所有外部 RESTful host 通过 manifest 声明：

```json
{
  "permissions": {
    "network": {
      "allow": ["ark.cn-beijing.volces.com", "open.volcengineapi.com", "gw.open.1688.com"]
    }
  }
}
```

**当前 SunPilot 已支持 `ctx.http`。** 所有外部 API 调用必须通过：

```ts
const response = await ctx.http.request({
  method: "POST",
  url: "https://ark.cn-beijing.volces.com/api/v1/video/generate",
  headers: { "Authorization": `Bearer ${apiKey}` },
  body: { prompt: input.prompt },
});
```

禁止直接 `process.env` 读取 secret，必须用：

```ts
const apiKey = await ctx.secrets.get("SEEDANCE_API_KEY");
```

禁止把 secret 写入 artifact、memory、event、log、handler output。

### Artifact 规范

模型生成的图片、视频、文档必须写入 SunPilot artifact：

```ts
const artifact = await ctx.artifacts.write({
  name: "product-ad-video.mp4",
  type: "video",
  content: videoBuffer,
  mimeType: "video/mp4",
  metadata: { provider: "seedance", model: "seedance", productId: input.productId, prompt: input.prompt },
});

return { status: "completed", artifactId: artifact.id, providerTaskId: result.taskId };
```

输出 schema 返回 artifact id、mimeType、provider、model，不返回 base64。

### 数据库抽象规范

| 源项目数据库内容 | 迁移方式 |
| --- | --- |
| 模型配置、prompt 模板、默认参数 | 迁移为 skill config、schema default、README 或 constants |
| 商品、订单、用户、素材记录 | 优先通过 REST API，不直接连 DB |
| 生成历史、任务状态 | 迁移为 artifact metadata、capability output、events、memory |
| 文件路径、上传记录 | 迁移为 SunPilot artifact |
| 后台 CRUD 管理 | 只有 Agent 需要调用的动作才抽成 capability |

### 前端抽象规范

从 React 代码反推：
- 用户填写哪些字段 → Zod input schema
- 表单校验规则 → Zod refinements
- 上传文件类型 → input file type constraints
- 页面流程 → capability 拆分

不迁移 React 组件、CSS、路由、管理后台页面、toast/modal。

### Capability 拆分原则

一个 capability 必须：Agent 可独立调用、用户可理解、可独立审批、可独立失败/重试、输入输出边界清晰。

不过细（getToken、signRequest、pollTask），不过粗（runEcommerceBusiness、generateEverything）。

长任务（如视频生成）优先做一个同步等待的 capability，handler 内部 submit → poll → download → write artifact。如果超过 timeout，拆成 `.submit` / `.check`。

### 推荐外贸电商 Skill 设计

默认生成一个业务域 skill：

```text
Skill id: cross-border-ecommerce
Skill name: 外贸电商
```

优先抽象：

```text
product.source.search1688     — 搜索 1688 货源
product.source.detail1688     — 商品详情/SKU/价格
product.copy.generate         — 外贸商品文案
product.title.optimize        — 英文标题优化
image.generate.seedream       — Seedream 商品图 → artifact
image.edit.product            — 商品图编辑换背景 → artifact
video.generate.seedance       — Seedance 营销视频 → artifact
listing.generate              — 上架草稿（标题、描述、卖点）
material.batch.generate       — 批量营销素材
```

### 输出要求

按以下顺序工作：

1. **Step 1：扫描源项目** — 读取后端 controller/service/client、前端 pages/components、配置文件、数据库 schema，输出分析摘要。
2. **Step 2：设计 Skill 列表** — 输出 capability 表格（输入来源、输出、Provider/API、权限、风险）。
3. **Step 3：生成 TypeScript Skill 文件** — 生成完整 skill 目录结构。
4. **Step 4：生成测试** — 使用 `testSkill()` mock provider client。
5. **Step 5：生成 SunPilot 接入说明** — build、安装、reload、调用、env 配置。
6. **Step 6：输出迁移报告** — 已生成 skills、来源文件、未迁移内容、需人工确认项。

### 严格约束

必须遵守：

1. 不要把 Spring Boot 项目整体搬进 skill。
2. 不要生成 Java 代码。
3. 不要迁移 React UI。
4. 不要直接连接数据库。
5. 不要直接使用 `process.env`。
6. 不要把 secret 写入日志、artifact、memory、event、output。
7. 不要把 base64 大文件放在 output。
8. 不要生成 `workflow.*`、`WorkflowRegistry`、`WorkflowToolExecutor`。
9. 不要把 controller/service 方法名直接当 capability 名。
10. 不要创建不可独立调用的 capability。

必须做到：

1. 生成符合 `sunpilot.skill/v1` 的 `skill.json`。
2. 生成默认导出 `defineSkill()` 的 TypeScript ESM entry。
3. 每个 capability 有 Zod input/output。
4. 每个 capability 有 JSON schema 文件。
5. 每个外部 API host 写入 `permissions.network.allow`。
6. 每个 env secret 写入 `permissions.env.allow`。
7. 图片/视频/文档结果写 artifact。
8. 长任务支持 `ctx.signal`。
9. 长任务发 `skill.progress`。
10. 输出完整迁移报告。

### 当前 SunPilot 代码状态（2026-06-11 已就绪）

以下能力已可用，无需额外改造：

- ✅ `ctx.http` — 受控 HTTP API（SkillHttpApi + SkillRunner 实现）
- ✅ network permission allow — manifest 声明后自动校验
- ✅ binary artifact write — `ctx.artifacts.write()` 支持 Buffer
- ✅ 全限定 capability id — catalog 使用 `<skill-id>:<capability-name>` 格式
- ✅ `testSkill()` HTTP fake — 测试 helper 支持 mock HTTP 请求
- ✅ workflow 已移除 — 不要生成 workflow 相关代码

### 期望最终目录

```text
generated-skills/
  cross-border-ecommerce/
    skill.json
    README.md
    package.json
    tsconfig.json
    src/
      index.ts
      schemas.ts
      capabilities/
      clients/
      utils/
      index.test.ts
    schemas/
    MIGRATION_REPORT.md
```

### 验收标准

```text
skill.json 可被 SkillRegistry 解析
entry 可被 SkillRunner 动态 import
definition.id/version 与 manifest 一致
capability 名称与 manifest 一致
input/output schema 明确
env/network 权限声明完整
artifact 输出规范
README 能指导安装和配置
MIGRATION_REPORT 能追溯来源文件
```

开始执行前，请先输出你的扫描计划；然后直接读取代码并生成结果，不要只停留在建议。
