# 数字生命 Digital World 当前实现复查与继续优化报告

更新日期：2026-06-21

本文档基于 `developer_docs/guides/digital_world_mvp_plan.md` 的阶段要求，对当前已实现代码进行只读复查。复查范围包括 Web PixiJS 画布、前端面板与路径动画、API 路由、Platform digital-world 服务、Storage 仓储与迁移。本文只记录完成度、潜在问题和继续优化建议，不修改业务代码。

## 1. 总体结论

当前实现已经覆盖了 Phase 0、Phase 1、Phase 2 的主要前端目标，并且提前推进了 Phase 3、Phase 4 的后端模型、API、存储和任务执行骨架。

构建层面目前是通过的：

```text
pnpm --filter @sunpilot/web build       通过
pnpm --filter @sunpilot/api build       通过
pnpm --filter @sunpilot/platform build  通过
pnpm --filter @sunpilot/storage build   通过
```

但从运行行为看，当前实现还不能视为 Phase 3-6 完成。主要原因是：

- 前端任务列表和动作日志接口存在契约错配。
- PostgreSQL `world_actions` 查询使用了不存在的 `created_at` 字段，会导致真实数据库运行时报错。
- 后端默认世界数据有 seed 方法，但当前 daemon 装配路径没有调用，真实库为空时仍会回落到前端 mock。
- 任务执行器已经写了 Agent Core 接入入口，但 daemon 创建 platform services 时没有注入 agent，因此当前运行路径不会真正进入 Agent Core。
- `work_on`、`artifact_created`、`sleep` 等动作参数没有被正确保存，导致工作类型、产物类型和休眠原因会退化为默认值。
- Agent Run 只要创建成功就立刻被视为“工作完成”，还没有等待 run 完成事件，这不满足 Phase 5 的真实闭环要求。

## 2. 阶段完成度

| 阶段 | 完成度 | 判断 |
| --- | --- | --- |
| Phase 0：页面骨架和 PixiJS 容器 | 基本完成 | PixiJS 已引入，数字生命页面可渲染右侧全画布，白色背景和生命周期逻辑已具备。 |
| Phase 1：静态白色数字工作室 | 基本完成 | 已有网格、道路、工作台、数字生命、状态气泡和右侧悬浮按钮。视觉方向符合白色数字工作室要求。 |
| Phase 2：前端本地动作演示 | 基本完成 | 已有 mock 世界、Dijkstra、RouteAnimator 和测试移动按钮。需要补动画销毁和与后端状态同步策略。 |
| Phase 3：世界模型和持久化 | 部分完成 | Storage、Platform、API 模块已建立，但默认数据初始化、接口返回格式和真实库查询仍有阻断问题。 |
| Phase 4：任务状态机 | 部分完成 | TaskExecutor 可拆动作并顺序执行，但动作参数、日志接口、失败信息和异步执行可观测性不足。 |
| Phase 5：Agent Core 和 Skill 接入 | 未真正完成 | 代码有可选 agent 分支，但 daemon 未注入 agent；即使注入也只是启动 run 后立即完成动作。 |
| Phase 6：产物箱和发布台闭环 | 未完成 | 产物箱面板已有，但真实发布、发布结果 metadata、授权等待和回家休眠闭环还没有打通。 |

## 3. 已完成内容

### 3.1 Phase 0：页面骨架

已完成：

- `packages/web/package.json` 已加入 `pixi.js`。
- `packages/web/src/features/digital-world/` 目录已建立。
- `DigitalWorld.tsx` 已作为数字生命页面入口。
- `ChatPage.tsx` 在 `activePanel === "automation"` 时渲染 `<DigitalWorld />`，并隐藏 `ChatHeader`。
- `DigitalWorld.scss` 将页面背景固定为 `#ffffff`。
- `WorldApp` 使用 `Application.init()` 初始化 PixiJS，并设置 `backgroundColor: CANVAS_BG_COLOR`。
- `useWorldApp` 已处理 mount、resize observer 和 destroy。

评价：

Phase 0 的核心目标已经达到。后续需要重点验证浏览器中反复切换页面时 PixiJS canvas 是否重复挂载、资源是否释放干净。

### 3.2 Phase 1：静态白色数字工作室

已完成：

- `WorldGrid`、`RoadLayer`、`WorkstationNode`、`DigitalBeingEntity`、`StatusBubbleLayer` 已拆分。
- `constants.ts` 中 `CANVAS_BG_COLOR = 0xffffff`，网格和道路也使用浅色。
- mock 世界包含 home、crossroad、video_workstation、artifact_box、tiktok_station、material_library、log_station。
- `WorldFloatingDock` 已提供状态、产物、对话、任务、日志、设置、唤醒/休眠入口。

评价：

视觉方向符合“白色、明亮、可工作的数字工作室”。当前工作台仍主要是基础绘制，后续可以继续增强每类工作台的差异化，避免变成普通流程图。

### 3.3 Phase 2：前端本地动作演示

已完成：

- `mock/mockWorld.ts` 定义了节点、道路和初始数字生命。
- `path/graph.ts`、`path/dijkstra.ts`、`path/route-animation.ts` 已实现本地路径和移动动画。
- `MovementTestBar` 可触发去视频工作台、产物箱、TikTok、home。
- `useBeingMovement` 会停止旧动画并启动新动画。

评价：

Phase 2 的核心体验已经具备。当前动画只更新 PixiJS 本地状态，不写回后端；这是前端 MVP 阶段可接受的，但进入 Phase 3 后需要明确本地动画和服务端世界状态的同步边界。

### 3.4 Phase 3-4：后端骨架

已完成：

- `packages/platform/src/digital-world/` 已建立。
- 已有 `DigitalBeingService`、`WorldService`、`TaskService`、`TaskExecutor`、`path-planner`。
- `packages/storage/src/migrations/020_digital_world.sql` 定义了 digital_beings、world_nodes、world_edges、world_tasks、world_actions、world_artifacts、world_action_logs。
- Postgres 和 InMemory database context 都补了对应 repository。
- API 已注册 `/v1/digital-world`、`/v1/digital-beings`、`/v1/world-nodes`、任务、动作和产物相关接口。

评价：

这部分已经超过 Phase 0-2 的前端 MVP 范围，方向是对的，但还处于“骨架可编译”阶段。真实运行前必须先修正下面的阻断问题。

## 4. 主要潜在问题

### P0：PostgreSQL world_actions 查询会因缺少 created_at 字段失败

证据：

- `packages/storage/src/migrations/020_digital_world.sql` 的 `world_actions` 表只有 `started_at`、`completed_at`，没有 `created_at`。
- `packages/storage/src/postgres/postgres.world-action.repository.ts` 的 `listByTaskId()` 和 `listByBeingId()` 都使用 `ORDER BY created_at`。

影响：

- 创建任务后，`TaskExecutor.executeTask()` 会调用 `worldActions.listByTaskId()`，真实 PostgreSQL 下会报 `column "created_at" does not exist`。
- 前端状态面板或动作列表调用 `/v1/digital-beings/:id/actions` 时也会触发同类问题。
- Phase 4 的任务状态机在真实库中会被阻断。

建议：

- 给 `world_actions` 增加 `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`，并在 repository 返回模型中包含该字段；或者把排序字段改为已有字段，但更推荐补 `created_at`。

### P0：任务列表接口前后端不匹配

证据：

- `TaskPanel.tsx` 打开任务面板时 GET `endpoints.digitalBeingTasks(beingId)`。
- API 当前只注册了 `POST /v1/digital-beings/:id/tasks`，没有注册对应 GET。
- `TaskService` 已有 `listTasks()` 方法，但 API 没有暴露。

影响：

- 任务面板永远无法加载历史任务，只能显示“暂无任务”或吞掉 404。
- 用户创建任务后无法立即看到任务状态，Phase 4 的“每个动作都有状态提示和动作日志”体验不成立。

建议：

- 增加 `GET /v1/digital-beings/:id/tasks`，返回 `{ items }`。
- 创建任务成功后，前端应刷新任务列表或乐观追加返回的 task。

### P0：状态面板把 WorldAction 当成 WorldActionLog 使用

证据：

- `StatusPanel.tsx` 定义 `ActionLog` 需要 `eventType`、`createdAt`、`payload`。
- 但它请求的是 `endpoints.digitalBeingActions(beingId)`。
- API 的 `/v1/digital-beings/:id/actions` 返回 `task.listActions()`，也就是 WorldAction，不是 WorldActionLog。
- Storage 已有 `worldActionLogs.listByBeingId()`，但 Platform/TaskService/API 没有暴露日志查询。

影响：

- 状态面板时间线会拿不到 `eventType` 和 `createdAt`，真实渲染会出现空事件或 Invalid Date。
- “动作日志可见、可审计、可回放”的目标没有达成。

建议：

- 新增 `GET /v1/digital-beings/:id/action-logs` 或让 `/actions` 明确只返回动作、另设 `/logs` 返回日志。
- `StatusPanel` 分开展示当前 actions 和 action logs，避免语义混用。

### P1：默认世界 seed 没有接入启动流程

证据：

- `WorldService.seedDefaultWorld()` 已存在。
- 当前 `daemon/src/server.ts` 只调用 `createPlatformServices({ database })`，没有调用 `platform.world.seedDefaultWorld()`。
- `useDigitalWorldBootstrap()` 在 API 返回空 nodes 或空 beings 时直接 fallback 到 mock。

影响：

- 真实 PostgreSQL 初始化后 `/v1/digital-world` 可能返回空世界。
- 前端看起来能工作，但实际上用的是 mock，Phase 3 的“刷新后恢复真实位置和任务状态”容易被假象掩盖。

建议：

- 在 daemon 启动或迁移后显式 seed 默认 world nodes/edges。
- 明确是否自动创建默认 DigitalBeing；如果不自动创建，则页面应引导创建，而不是静默 fallback。
- 前端 fallback 应展示开发态提示，避免生产环境误以为已接入后端。

### P1：TaskExecutor 的动作参数没有完整保存

证据：

- `TASK_ACTION_MAP` 使用 `work_on:make_video`、`artifact_created:video`、`sleep:task_done` 这类模板。
- 创建 WorldAction 时只在 `type === "move_to"` 时写入 `toNodeId`。
- 后续 `work_on`、`artifact_created`、`sleep` 都读取 `action.toNodeId` 作为参数。

影响：

- `work_on` 无法知道真实工作类型，会退化为 `execute task` 或空标签。
- `artifact_created` 无法保存模板中的 `video`，只能使用默认值。
- `sleep:manual` 和 `sleep:task_done` 都会退化为默认 `task_done`。
- 动作日志 payload 也无法携带真实业务参数。

建议：

- 给 WorldAction 增加 `name`、`kind`、`params` 或 `payload` 字段，分别表达动作类型和动作参数。
- 不建议继续复用 `toNodeId` 表达工作类型、产物类型和休眠原因。

### P1：Agent Core 接入当前没有真正走通

证据：

- `TaskExecutor` 支持可选 `agent.startChatCommand()`。
- `createPlatformServices()` 接收可选 `agent`。
- 但 daemon 中调用的是 `createPlatformServices({ database })`，没有传入 `getChatAgent()` 或 AgentService。

影响：

- 当前运行时 `this.deps.agent` 为空，`work_on` 只走 Phase 4 fallback。
- Phase 5 的 Agent Core 和 Skill 接入不能算完成。

建议：

- 暂时把 Phase 5 标记为未完成，避免误判。
- 下一步需要设计 Platform 到 AgentService 的异步接口，而不是直接把完整 AgentService 强耦合进 Platform。

### P1：Agent Run 创建后立即标记工作完成，语义不正确

证据：

- `TaskExecutor` 在 `startChatCommand()` 返回 runId 后立即把 being 状态改成 `idle/工作完成`。
- 同一逻辑随后创建 WorldArtifact。
- 注释也说明未来才会订阅 live event bus。

影响：

- Agent Run 仍在执行时，世界状态已经显示完成。
- Skill 失败、等待审批、等待用户确认、工具调用失败都无法反映到 WorldAction。
- 产物可能在真实 Skill 产出前被提前创建，造成假产物。

建议：

- `work_on` 创建 run 后应进入 `waiting` 或 `working`，并保存 `agentRunId`。
- 只有监听到 run completed 和真实 artifact/result 后，才创建或更新 WorldArtifact。
- run failed/cancelled/waiting_approval 应映射到 WorldAction 和 DigitalBeing 状态。

### P1：产物可能重复创建

证据：

- `make_video` 和 `make_and_publish_video` 模板同时包含 `work_on:make_video` 和 `artifact_created:video`。
- 如果未来注入 agent，`work_on` 分支会创建 WorldArtifact。
- 后续 `artifact_created` 动作还会再创建一个 WorldArtifact。

影响：

- 同一个视频任务可能出现两个产物。
- 产物箱无法区分真实 Skill 产物和世界动作占位产物。

建议：

- 明确产物创建只有一个来源：建议由 Agent Run 结果或 Skill Artifact 驱动。
- `artifact_created` 更适合做“移动/登记/播放动画”的世界动作，不应重复创建业务产物。

### P2：前端 WorldApp 只更新数字生命位置和状态，不更新节点/道路/being 切换

证据：

- `useWorldApp` 的数据更新 effect 只调用 `updateBeingPosition()` 和 `updateBeingStatus()`。
- `WorldApp` 初次 mount 后不会根据新的 nodes/edges 重绘世界。

影响：

- 后端世界节点、道路变化后，画布不会重绘。
- 如果 API 从 mock fallback 切换到真实数据，或者未来支持多数字生命/切换 being，画布状态可能滞后。

建议：

- 增加 `WorldApp.setData()` 或 `WorldApp.renderWorld(data)`，在 nodes/edges/being 变化时可控重绘。
- 至少在节点/道路 id 集合变化时清理旧 stage 并重绘。

### P2：RouteAnimator 停止和组件卸载之间缺少统一清理

证据：

- `useBeingMovement` 在新动画开始前会 stop 旧 animator。
- 但组件卸载或 WorldApp destroy 时，`animatorRef` 没有统一 cleanup effect。

影响：

- 快速切换页面时，ticker callback 可能短时间持有已销毁的 Pixi 对象。
- 风险不一定马上爆，但属于 PixiJS 生命周期隐患。

建议：

- `useBeingMovement` 增加 unmount cleanup，停止 animator。
- `WorldApp.destroy()` 可统一停止内部动画资源，避免 hook 和 canvas 生命周期分裂。

### P2：前端 API wrapper 返回类型与 API 真实返回不一致

证据：

- `createDigitalBeing()`、`updateDigitalBeing()` 的 wrapper 声明返回单个 being。
- API POST/PATCH 实际返回 `{ item: being }`。
- `listDigitalBeings()` wrapper 期望 `{ items }`，API GET `/v1/digital-beings` 实际直接返回数组。

影响：

- 当前这些 wrapper 使用不多，所以 build 通过。
- 后续一旦复用会出现运行时读取错位。

建议：

- 统一 API 返回形态：列表统一 `{ items }`，创建/更新统一 `{ item }`。
- 前端 wrapper 与 API 路由保持严格一致。

## 5. 建议的继续优化顺序

### Step 1：先修阻断性 API/DB 契约

优先事项：

- 给 `world_actions` 补 `created_at` 字段，或修正 repository 排序字段。
- 增加 `GET /v1/digital-beings/:id/tasks`。
- 增加 action logs 查询 API。
- 修正 `/v1/digital-beings` 列表返回形态和前端 wrapper。

验收：

- 创建任务后不会触发数据库查询错误。
- 任务面板能显示任务列表。
- 状态面板能显示真实动作日志。
- API response shape 在前后端一致。

### Step 2：补默认世界初始化和真实 DigitalBeing 创建策略

优先事项：

- 在 daemon 启动流程调用 `world.seedDefaultWorld()`。
- 决定是否自动创建默认数字生命。
- 如果不自动创建，在前端显示创建入口或空状态，不要生产环境静默 fallback。

验收：

- 新数据库启动后 `/v1/digital-world` 至少有默认 nodes/edges。
- 页面能明确区分“真实世界状态”和“开发 mock 状态”。
- 刷新后数字生命位置来自后端。

### Step 3：整理 WorldAction 数据模型

优先事项：

- 为动作增加 `params/payload`，不要用 `toNodeId` 表达所有参数。
- `move_to` 使用 `toNodeId`。
- `work_on` 使用 `workType`。
- `artifact_created` 使用 `artifactType`。
- `sleep` 使用 `sleepReason`。

验收：

- `make_and_publish_video` 拆出的动作能准确表达目标节点、工作类型、产物类型和休眠原因。
- action log payload 能支撑画布播放和审计。

### Step 4：让 Phase 4 先稳定，不急着宣称 Phase 5

优先事项：

- `work_on` 在没有 Agent Core 时进入 mock completed，但要清楚标记为 mock。
- 失败时把 error 写入 WorldAction。
- TaskExecutor 不要吞掉错误细节。
- DigitalBeing 的 `currentTaskId/currentActionId` 在执行过程中同步更新。

验收：

- “制作视频并发布到 TK”能稳定拆成动作。
- 每个动作都有 pending/running/completed/failed 状态。
- 失败原因可在状态面板看到。
- 数字生命最终能回家休眠。

### Step 5：再接真实 Agent Core

优先事项：

- Platform 不直接依赖完整 AgentService，定义窄接口，例如 `startWorldActionRun()`。
- `work_on` 创建 run 后保持 `working/waiting`，不立即完成。
- 监听 run completed/failed/cancelled/waiting_approval。
- 只有真实 run 结果或 artifact 到达后才创建 WorldArtifact。

验收：

- Agent Run 运行中时画布显示正在工作。
- Agent Run 失败时 WorldAction 失败。
- Skill 真实产物能进入产物箱。
- 不出现重复产物。

### Step 6：前端同步与体验打磨

优先事项：

- `WorldApp` 支持 nodes/edges/being 数据变化后的重绘。
- RouteAnimator 增加卸载清理。
- 任务创建后刷新任务列表。
- 状态面板分开展示动作列表和动作日志。
- 移动测试按钮后续只在开发态显示。

验收：

- 后端状态变化后 5 秒轮询能驱动画布更新。
- 画布、面板和后端世界状态一致。
- 切换页面不会残留 Pixi ticker 或重复 canvas。

## 6. 当前可认为完成的验收项

可认为完成：

- 数字生命菜单进入后，右侧渲染数字世界页面。
- ChatHeader 在数字生命页面被隐藏。
- PixiJS 画布白色背景符合文档要求。
- 静态世界包含道路、工作台、数字生命和状态气泡。
- 前端本地路径动画能沿道路移动。
- Web/API/Platform/Storage build 通过。

暂不能认为完成：

- 真实数据库下任务执行稳定完成。
- 任务列表和动作日志可用。
- 刷新页面后一定恢复真实世界状态。
- Phase 5 Agent Core 接入。
- Phase 6 产物箱和发布台真实闭环。

## 7. 推荐下一轮开发目标

下一轮建议只以“Phase 3-4 稳定化”为目标，不要继续扩 Phase 5/6。

建议目标：

```text
真实数据库可 seed 默认世界
真实 DigitalBeing 可创建或自动初始化
任务可创建、可列出、可拆 action
action 可顺序执行并写入 action log
前端任务面板和状态面板能读取真实数据
数字生命最终能回家休眠
不调用 Agent Core，不调用 Skill
```

完成这些之后，再进入 Agent Core 接入会更稳。
