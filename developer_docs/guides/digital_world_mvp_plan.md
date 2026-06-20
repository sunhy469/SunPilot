# 数字生命 Digital World MVP 构建路线

更新日期：2026-06-20

本文档定义 SunPilot 数字生命的产品模型、执行逻辑、Agent Core 边界、PixiJS 前端架构和分阶段构建路线。它是后续实现数字生命页面、世界模型、任务执行、产物箱和 Skill 调用链路的主参考文档。

## 1. 核心定位

数字生命不是聊天机器人的皮肤，而是一个住在数字工作室里的机器人员工。

它的形象参考 WALL-E 的方向：小型履带式机器人员工，有工作状态、有移动路径、有任务、有产物、有休眠。设计时只借鉴“履带底盘、小型工作机器人、会回家休息”的气质，不复制 WALL-E 的具体角色形象、比例、颜色、眼睛造型或版权特征。

核心隐喻：

```text
Digital Being          数字生命个体，像一个履带式机器人员工
Agent Core             大脑，负责思考、规划、调用工具、处理结果
Database / Memory      记忆和世界状态，记录经验、任务、位置、产物
Skill Tools            手和工具，负责生成视频、发布 TK、分析商品等实际能力
Platform World Model   身体和世界，负责位置、道路、任务、产物、休眠、动作日志
PixiJS Canvas          用户看到的 2D 数字世界
```

最重要的边界：

```text
画布不调用 Skill。
数字生命不绕过 Agent Core 直接调用 Skill。
Platform World Engine 负责任务编排和世界状态。
Agent Core 负责智能执行和 Skill 调用。
Skill Runner 负责具体工具执行。
Database 负责记住 Agent 记忆和世界状态。
```

## 2. 世界形态

MVP 是一个 2D 平面世界，不做 3D。

世界中有道路、节点和工作台。数字生命只能沿道路移动，不能随意漂浮。未来会做动态路径规划，让数字生命根据当前位置和目标节点自动选择路线。

基础布局示例：

```text
                 [素材库]
                    |
[家 Home] ---- [主路口] ---- [视频工作台] ---- [产物箱]
                    |
             [TikTok 发布台]
                    |
              [日志/状态区]
```

节点类型：

| 节点 | 作用 | 视觉建议 |
| --- | --- | --- |
| `home` | 数字生命休眠、待机、恢复能量 | 小房间、充电舱、机器人小窝 |
| `video_workstation` | 生成脚本、制作视频、处理素材 | 工作台 + 视频/剪辑图标 |
| `artifact_box` | 保存产物，如视频、图片、脚本、发布结果 | 产物箱、仓库、发光盒子 |
| `tiktok_station` | 发布 TikTok/TK 内容 | TikTok logo 风格图标 + 发布工作台 |
| `material_library` | 素材库、商品资料、历史资料入口 | 文件柜、素材架、资源库 |
| `status_station` | 查看当前任务、日志、状态 | 面板、监控屏、日志终端 |

工作台可以统一是“桌子 + logo + 状态灯”的结构，但每个工作台的外观要有差异，方便用户一眼识别。

## 3. 产品行为

数字生命是持续存在的个体，但不是一直工作。它有任务、有状态、有额度限制，也会因为任务完成、额度用完或等待用户确认而回家休眠。

典型任务：“制作视频并发布到 TikTok”：

```text
1. wake
   从 home 醒来

2. plan_route(video_workstation)
   规划去视频工作台的路径

3. move_to(video_workstation)
   沿道路移动

4. work(make_video)
   Platform 创建 Agent Run
   Agent Core 选择并调用视频生成 Skill

5. artifact_created(video)
   视频产物写入数据库，并显示进入产物箱

6. move_to(artifact_box)
   去产物箱检查/登记产物

7. move_to(tiktok_station)
   去 TikTok 发布台

8. work(publish_to_tiktok)
   Platform 创建 Agent Run
   Agent Core 调用 TikTok 发布 Skill

9. publish_done
   记录发布结果、URL、时间、失败原因或成功状态

10. move_to(home)
    返回家

11. sleep
    进入休眠，避免继续消耗额度
```

所有状态都要显示。用户不一定一直看着屏幕，但系统仍然要有具体状态提示和动作记录，回来后能看到它做到了哪一步。

头顶状态提示示例：

```text
正在去视频工作台
正在生成视频脚本
正在调用视频生成工具
视频已放入产物箱
正在前往 TikTok 发布台
正在发布视频
发布完成，准备回家
今日额度已用完，进入休眠
等待用户确认 TikTok 账号授权
工具调用失败，等待重试
```

## 4. Agent Core 边界

Agent Core 是数字生命的大脑，但它不是世界引擎，也不是 UI 引擎。

Agent Core 负责：

- 理解用户和平台下发的智能任务。
- 根据上下文规划执行步骤。
- 选择合适 Skill。
- 构建 Skill 参数。
- 调用 Skill Runner。
- 处理工具结果、失败和重试。
- 写入 Agent 记忆、事件、运行轨迹。

Agent Core 不负责：

- 画布渲染。
- 路径规划。
- 机器人从一个节点移动到另一个节点。
- 产物在画布上的摆放动画。
- 休眠动画。
- 数字生命在世界中的坐标。
- 普通产品 CRUD。

Platform World Engine 负责：

- 创建数字生命。
- 创建世界节点。
- 管理道路图。
- 规划移动路径。
- 创建 WorldTask。
- 拆分 WorldAction。
- 判断哪些动作需要 Agent Core。
- 调用 Agent Core 创建 run。
- 监听 run 结果。
- 更新世界状态和产物状态。

Skill 调用链路：

```text
Digital Being
  -> Platform WorldTask
  -> WorldAction: work(make_video)
  -> Agent Core Run
  -> Tool Decision / Skill Selection
  -> Skill Runner
  -> Artifact / Result
  -> Agent Core completes
  -> Platform updates WorldState
  -> PixiJS Canvas plays state changes
```

禁止链路：

```text
Digital Being -> Skill Runner
PixiJS Canvas -> Skill Runner
PixiJS Canvas -> Agent Core direct tool call
```

## 5. 数据模型

MVP 后端建模不应只用 `conversation` 表示数字生命。正确模型是：

```text
DigitalBeing
  绑定 conversationId
  可选绑定 currentRunId
  保存世界位置、状态、名称、角色、休眠原因、任务队列

Conversation
  保存用户和数字生命的对话记录

Run
  保存一次 Agent Core 执行

WorldNode
  保存世界节点，如 home、video_workstation、artifact_box、tiktok_station

WorldEdge
  保存道路，连接两个 WorldNode

WorldTask
  保存高层任务，如 make_and_publish_video

WorldAction
  保存可执行动作，如 move_to、work_on、pickup、dropoff、publish、sleep

WorldArtifact
  保存产物，如 video、image、script、report、publish_result

WorldActionLog
  保存动作事件，用于画布播放、审计和回放
```

### 5.1 DigitalBeing

```ts
interface DigitalBeing {
  id: string;
  tenantId?: string;
  userId?: string;
  name: string;
  description?: string;
  visualProfile: {
    bodyType: "tracked_worker";
    color?: string;
    icon?: string;
  };
  status:
    | "idle"
    | "moving"
    | "working"
    | "waiting"
    | "publishing"
    | "sleeping"
    | "error";
  currentNodeId: string;
  targetNodeId?: string;
  homeNodeId: string;
  currentTaskId?: string;
  currentActionId?: string;
  currentRunId?: string;
  conversationId: string;
  statusText?: string;
  sleepReason?: "task_done" | "budget_exhausted" | "waiting_user" | "cooldown" | "manual";
  budget: {
    dailyRunLimit?: number;
    dailySkillCallLimit?: number;
    tokenBudget?: number;
    usedRuns?: number;
    usedSkillCalls?: number;
    cooldownUntil?: string;
  };
  createdAt: string;
  updatedAt: string;
}
```

### 5.2 WorldNode

```ts
interface WorldNode {
  id: string;
  type:
    | "home"
    | "video_workstation"
    | "artifact_box"
    | "tiktok_station"
    | "material_library"
    | "status_station";
  name: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  icon?: string;
  logo?: "tiktok" | "video" | "box" | "home" | "material";
  enabled: boolean;
}
```

### 5.3 WorldEdge

```ts
interface WorldEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  distance: number;
  bidirectional: boolean;
  locked?: boolean;
}
```

### 5.4 WorldTask

```ts
interface WorldTask {
  id: string;
  beingId: string;
  type:
    | "make_video"
    | "publish_to_tiktok"
    | "make_and_publish_video"
    | "return_home"
    | "sleep";
  status: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";
  title: string;
  input: Record<string, unknown>;
  currentActionId?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}
```

### 5.5 WorldAction

```ts
interface WorldAction {
  id: string;
  taskId: string;
  beingId: string;
  type:
    | "wake"
    | "plan_route"
    | "move_to"
    | "work_on"
    | "artifact_created"
    | "pickup"
    | "dropoff"
    | "publish"
    | "return_home"
    | "sleep";
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  fromNodeId?: string;
  toNodeId?: string;
  routeNodeIds?: string[];
  agentRunId?: string;
  statusText: string;
  startedAt?: string;
  completedAt?: string;
  error?: unknown;
}
```

### 5.6 WorldArtifact

```ts
interface WorldArtifact {
  id: string;
  tenantId?: string;
  beingId: string;
  taskId?: string;
  runId?: string;
  type: "video" | "image" | "script" | "report" | "publish_result";
  title: string;
  uri?: string;
  thumbnailUri?: string;
  locationNodeId: string;
  status: "created" | "stored" | "carried" | "published" | "failed";
  metadata?: Record<string, unknown>;
  createdAt: string;
}
```

## 6. 状态机

数字生命状态：

```text
idle
  空闲，可接任务

moving
  正在沿道路移动

working
  正在执行智能任务，通常关联 Agent Core run

waiting
  等待用户、等待授权、等待外部结果、等待冷却

publishing
  正在发布产物，可视为 working 的业务子状态

sleeping
  休眠，不主动消耗额度

error
  当前任务失败，等待重试、取消或人工处理
```

状态转换：

```text
sleeping -> idle
idle -> moving
moving -> working
working -> moving
working -> waiting
working -> error
waiting -> working
waiting -> sleeping
moving -> sleeping
error -> idle
error -> sleeping
```

休眠不是装饰，是额度控制机制：

```text
task_done          任务完成后回家睡觉
budget_exhausted   今日额度或 Skill 调用额度用完
waiting_user       等待用户确认或授权
cooldown           避免高频调用模型或工具
manual             用户手动让数字生命休眠
```

## 7. 路径规划

数字生命在 2D 世界中必须沿道路移动。道路由 `WorldNode` 和 `WorldEdge` 组成图结构。

MVP 路径规划：

```text
输入：currentNodeId, targetNodeId, worldEdges
算法：Dijkstra 或 A*
输出：routeNodeIds
渲染：PixiJS 沿节点中心点折线路径移动
```

第一阶段建议先使用 Dijkstra，因为世界节点少、实现稳定。后续如果节点变多，再加入 A* 启发式。

路径规划服务归属：

```text
packages/platform/src/digital-world/path-planner.ts
```

前端 PixiJS 可以有本地路径动画，但最终路径应来自 platform，避免不同客户端算出不一致路线。

前端临时 MVP 可以本地硬编码道路图，等后端世界模型落地后再切到 API。

## 8. API 规划

长期 API 应归属 `packages/api`，业务实现归属 `packages/platform`。

```text
Client -> packages/api -> packages/platform -> packages/storage
```

建议接口：

```http
GET    /v1/digital-world
GET    /v1/digital-beings
POST   /v1/digital-beings
GET    /v1/digital-beings/:id
PATCH  /v1/digital-beings/:id
POST   /v1/digital-beings/:id/tasks
POST   /v1/digital-beings/:id/sleep
POST   /v1/digital-beings/:id/wake
GET    /v1/digital-beings/:id/actions
GET    /v1/digital-beings/:id/artifacts
GET    /v1/world-nodes
GET    /v1/world-actions?beingId=xxx
```

MVP 的第一步只做前端 PixiJS 画布时，不实现这些接口。

## 9. 前端页面目标

数字生命页面不再显示聊天页顶部占位区域。左侧边栏保持不变，右侧主区域全部交给数字生命画布。

目标布局：

```text
┌──────────────┬──────────────────────────────────────────────┐
│ 左侧边栏      │ PixiJS Digital World Canvas                  │
│ 新对话        │                                              │
│ 插件          │  [悬浮状态按钮] [产物箱] [对话] [任务]        │
│ 数字生命      │                                              │
│ Debug         │          2D 世界 + 道路 + 工作台 + 数字生命   │
└──────────────┴──────────────────────────────────────────────┘
```

右侧画布边缘悬浮按钮：

```text
状态
产物
对话
任务
日志
设置
唤醒/休眠
```

这些按钮不是世界节点，而是用户操作入口。它们可以打开抽屉、弹窗或浮层。

## 10. PixiJS 选型

选择 PixiJS v8。

原因：

- 数字生命是 2D 世界，PixiJS 是成熟的 2D GPU 渲染引擎。
- 适合道路、节点、工作台、机器人、状态气泡、移动动画。
- 相比 DOM/CSS，后续做路径动画、粒子、连线、发光效果更稳。
- 相比原生 Canvas 2D，PixiJS 有场景图、Ticker、事件、Container、Sprite、Graphics。
- 相比 Three.js，MVP 不需要 3D 心智和相机复杂度。

画面压力判断：

```text
1 个数字生命 + 十几个工作台 + 道路 + 少量状态气泡：压力很低
20 个数字生命 + 若干状态动画：仍然可控
真正的压力来自大量粒子、复杂滤镜、大量动态文字和低端移动设备
```

性能原则：

- 静态地图层和道路层尽量缓存。
- 工作台 logo 用纹理或 SVG 转纹理，不每帧重画复杂 Graphics。
- 机器人动画用少量 Container/Sprite/Graphics 组合。
- 状态气泡 MVP 可以用 React DOM 悬浮层，避免 Pixi Text 排版成本。
- 粒子和滤镜不是 MVP 必须项。
- resize、destroy、context lost 要处理，避免 WebGL 资源泄漏。

## 11. 前端目录规划

```text
packages/web/src/features/digital-world/
  index.ts
  DigitalWorld.tsx
  DigitalWorld.scss
  types.ts
  constants.ts

  canvas/
    WorldApp.ts
    WorldGrid.ts
    RoadLayer.ts
    WorkstationNode.ts
    DigitalBeingEntity.ts
    StatusBubbleLayer.ts
    FloatingActionLayer.ts

  path/
    graph.ts
    dijkstra.ts
    route-animation.ts

  components/
    WorldFloatingDock.tsx
    StatusPanel.tsx
    ArtifactBoxPanel.tsx
    BeingChatPanel.tsx
    TaskPanel.tsx

  hooks/
    useWorldApp.ts
    useDigitalWorldBootstrap.ts
    useBeingMovement.ts
    useCanvasResize.ts

  bridge/
    syncWorldState.ts
    screenPosition.ts

  mock/
    mockWorld.ts
```

第一步只需要：

```text
DigitalWorld.tsx
DigitalWorld.scss
canvas/WorldApp.ts
canvas/WorldGrid.ts
canvas/RoadLayer.ts
canvas/WorkstationNode.ts
canvas/DigitalBeingEntity.ts
hooks/useWorldApp.ts
mock/mockWorld.ts
```

## 12. 构建路线

### Phase 0：PixiJS 引入和页面骨架

目标：

- 安装 `pixi.js`。
- 建立 `features/digital-world` 文件夹。
- 数字生命菜单切换后，右侧全屏显示 PixiJS 画布。
- 左侧边栏保持不变。
- 数字生命页面不显示 ChatHeader 顶部占位。
- 不接接口，不做建模，不调用 Agent Core。

验收：

- 点击左侧“数字生命”后，右侧是完整画布。
- 画布随容器尺寸 resize。
- 离开数字生命页面时销毁 PixiJS Application。
- `pnpm --filter @sunpilot/web build` 通过。

### Phase 1：静态世界

目标：

- 绘制背景网格。
- 绘制道路。
- 绘制 home、video_workstation、artifact_box、tiktok_station。
- 绘制 1 个履带式数字生命。
- 显示头顶状态气泡。

不做：

- 后端 API。
- Agent Core。
- Skill 调用。
- 真实路径规划。

验收：

- 页面看起来像一个数字工作室。
- 用户能看出家、工作台、产物箱、发布台。
- 数字生命形象是小型履带式机器人员工。

### Phase 2：前端本地路径动画

目标：

- 本地 mock 世界图。
- 本地 Dijkstra 算出路径。
- 数字生命沿道路从 home 移动到 video_workstation。
- 头顶状态提示跟随移动变化。

不做：

- 后端持久化。
- Agent Core。
- Skill 调用。

验收：

- 点击测试按钮后，数字生命能沿道路移动。
- 不穿墙、不直线飞行。
- 移动完成后状态变为“已到达视频工作台”。

### Phase 3：世界模型后端

目标：

- 在 `packages/platform` 建立 digital-world 模块。
- 新增 DigitalBeing、WorldNode、WorldEdge、WorldTask、WorldAction、WorldArtifact 的服务层。
- `packages/api` 提供数字生命和世界状态接口。
- 数据落到 `packages/storage`。

验收：

- 刷新页面后数字生命位置和任务状态能恢复。
- Mac/Windows/Mobile 未来可复用同一套接口。

### Phase 4：任务执行状态机

目标：

- 用户给数字生命派发任务。
- Platform 将任务拆成 WorldAction。
- move_to、sleep、pickup、dropoff 由 World Engine 执行。
- work_on、publish 等智能动作触发 Agent Core run。

验收：

- “制作视频并发布到 TK”能拆成多个可观察动作。
- 每个动作都有状态提示。
- 失败时能进入 waiting 或 error。

### Phase 5：Agent Core 和 Skill 接入

目标：

- `work_on(make_video)` 创建 Agent Run。
- Agent Core 根据任务上下文选择 Skill。
- Skill 生成 Artifact。
- Platform 接收 run 完成事件并创建 WorldArtifact。
- 画布显示产物进入产物箱。

验收：

- 数字生命不会直接调用 Skill。
- 所有工具调用仍走 Agent Core。
- 产物在世界状态中可查询。

### Phase 6：产物箱和发布台

目标：

- 产物箱显示视频、脚本、图片、发布结果。
- 数字生命移动到 TikTok 发布台。
- `publish_to_tiktok` 调用 Agent Core 和发布 Skill。
- 发布结果写入 WorldArtifact metadata。

验收：

- 用户能通过悬浮按钮打开产物箱。
- 发布成功/失败都有状态提示。
- 数字生命任务完成后回家休眠。

## 13. MVP 范围控制

第一版必须做：

- 右侧全画布。
- 静态 2D 世界。
- 履带式数字生命。
- 家、工作台、产物箱、TikTok 发布台。
- 道路网络。
- 本地路径动画。
- 头顶状态提示。
- 边缘悬浮按钮占位。

第一版不做：

- 多数字生命。
- 多 Agent 协作。
- 真实视频生成。
- 真实 TikTok 发布。
- 后端世界建模。
- Agent Core 调用。
- Skill 调用。
- 自定义皮肤。
- 3D。
- 音效。
- 多用户协作。

## 14. 风险

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| PixiJS 和 React 状态同步复杂 | 中 | Canvas 内渲染，React 只管外部浮层；用桥接层同步 |
| 一开始做太多建模导致 MVP 慢 | 高 | Phase 0-2 只做前端世界，不接接口 |
| 视觉做成普通流程图 | 高 | 坚持“履带式机器人员工 + 道路 + 工作台” |
| 直接把机器人等同 conversation | 高 | DigitalBeing 是独立实体，conversation 只是绑定对话 |
| Agent Core 被产品 CRUD 污染 | 高 | 所有产品模型放 platform，core 保持纯 Agent |
| 无限运行导致额度消耗 | 高 | 休眠、冷却、任务上限、Skill 调用上限作为世界机制 |
| 每个状态都查 heavy trace | 中 | 先用 run/status，后续聚合 WorldAction 事件 |

## 15. 最终判断

数字生命的正确方向是：

```text
一个履带式 AI 机器人员工
生活在 2D 数字工作室
沿道路移动到不同工作台
通过 Agent Core 调用配置好的 Skill
把结果放入产物箱或发布到外部平台
任务完成或额度不足后回家休眠
所有状态都通过画布和动作日志可见
```

PixiJS 是合适的渲染选型。第一阶段最大风险不是性能，而是范围过大。因此应先完成“右侧全画布 + 静态世界 + 本地路径动画”，再进入后端建模和 Agent Core 接入。
