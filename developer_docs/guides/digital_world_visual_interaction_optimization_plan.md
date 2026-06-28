# Digital World 当前实现与后续优化方案

更新日期：2026-06-28

本文已按当前代码覆盖旧视觉改造计划，区分已实现能力、实验边界和下一步工作。

## 1. 当前定位

Digital World 是 SunPilot 的可视化任务工作台：PostgreSQL 保存世界、数字生命、任务、动作、日志和产物；Platform 推进任务状态；Web 用 PixiJS 展示节点、道路、移动和工作状态。

它已不只是静态 mock 画布，但也还不是通用 Agent 世界模型。后端 task type 仍映射为固定 action 模板，开发环境仍允许 mock fallback。

## 2. 当前全栈结构

```text
DigitalWorld React page
  -> useDigitalWorldBootstrap
  -> GET /v1/digital-world + WS/poll fallback
  -> platform WorldService / DigitalBeingService / TaskService
  -> PostgreSQL world repositories

TaskService.createTask
  -> TaskExecutor 固定 action template
  -> move/wake/work/artifact/sleep
  -> work_on 启动 AgentService.startChatCommand
  -> liveEventBus 收到 run terminal event
  -> TaskExecutor.onAgentRunCompleted
  -> 继续剩余 actions / 写 artifact / 完成 task
```

## 3. 已实现的视觉与交互

### Canvas

- PixiJS `Application + viewport Container`；
- 点阵网格、渐变背景、道路和路口；
- workstation 图标纹理缓存，减少重复 Graphics 构建；
- 数字生命机器人、动态阴影、鼠标跟随、状态气泡；
- working sparks、road flow、sleep Zzz 粒子；
- light/dark theme 与简单音效；
- 多数字生命渲染与选择。

### Camera 与路径

- 鼠标/触控拖动画布；
- 滚轮和按钮缩放、pivot zoom、边界约束；
- 居中/定位数字生命；
- Dijkstra 路径与 route animation；
- 动画中忽略轮询位置回写，避免瞬移；
- resize 和销毁时清理 listener/ticker/animator。

### 产品交互

- 节点点击打开任务、产物、状态、聊天等面板；
- 数字生命点击切换当前对象；
- Task、Artifact、Chat、Status、Action Log 面板；
- sleep/wake、回家和定位；
- 键盘快捷键：`F` 定位、`H` 回家、`1..5` 面板、`+/-` 缩放；
- dev editor 支持节点拖动、添加/删除和 JSON import/export；
- 开发 mock 数据会显示 `DEV MOCK` 标记。

## 4. 数据同步

首次加载请求 `/v1/digital-world`。连接共享 WebSocket 后监听 `world.state.changed` 并立即重新拉取；HTTP polling 始终作为兜底，WS 已连接时降低频率。

生产环境接口失败或空世界不使用 mock 覆盖真实问题；Vite DEV 才允许 `mockWorld` fallback。

当前同步模型是“事件触发全量 refetch”，不是细粒度 world patch。规模较小时简单可靠，节点/生命数量增长后需要增量协议。

## 5. 后端任务能力

`TASK_ACTION_MAP` 当前支持：

| task type                | 行为概述                                                         |
| ------------------------ | ---------------------------------------------------------------- |
| `make_video`             | 唤醒 → 视频工作台 → Agent 工作 → 登记产物 → 产物箱 → 回家 → 休眠 |
| `publish_to_tiktok`      | 唤醒 → 产物箱 → TikTok 站 → Agent 工作 → 回家 → 休眠             |
| `make_and_publish_video` | 组合制作和发布序列                                               |
| `return_home`            | 回家                                                             |
| `sleep`                  | 休眠                                                             |

Task claim 在 transaction 可用时原子执行，action 顺序运行。`work_on` 启动异步 Agent Run 并暂停后续 action；run completed/failed/cancelled 后由 event bridge 续跑或结束。

## 6. 当前主要问题

### P1：任务编排固定

未知 task type 的 action template 为空，task 会被创建但不会形成通用执行计划。视觉世界看起来是自主 Agent，实际主要编排仍由固定 map 决定。

### P1：事件合同不够专用

前端监听 `world.state.changed`，但主状态变化仍依赖 polling 保底。应由 Platform 在事务提交后稳定发布带 entity/version 的世界事件。

### P1：Agent 产物映射依赖 terminal event payload

server 从 `agent.run.completed` payload 中尝试收集 artifacts；如果实际产物只在 repository 而不在 payload，WorldArtifact 可能缺失。应按 runId 查询 artifact repository 作为事实源。

### P2：前后端各有路径逻辑

Platform 有 `path-planner.ts`，Web 有 graph/dijkstra/route-animation。后端决定目标和 route，前端又可本地求路，需要固定哪一层是 route 的权威来源。

### P2：WorldApp 仍很大

它同时管理 application、camera、theme、entity、editor、sound、particle、interaction 和 data diff。虽已有子类，但 orchestration 仍集中，后续功能会继续放大生命周期风险。

### P2：无大规模性能基线

当前 texture cache、dirty redraw 和 event delegation 是正确方向，但没有固定 50/100 节点、多生命、长时间 ticker 的 FPS/内存门禁。

## 7. 推荐优化路线

### 阶段一：保证业务事实一致

1. Platform 为 world entity 更新发布稳定事件，包含 `entityType/id/version/change`。
2. terminal run 后从 artifact repository 按 runId 读取产物。
3. 对 unknown task type 明确返回 400，不能静默创建不执行任务。
4. 为 task/action 状态迁移增加幂等与恢复测试。

### 阶段二：升级任务计划

1. 定义持久化 `WorldPlan`：goal、steps、preconditions、risk、expected artifacts。
2. 固定模板作为安全 quick path，Agent planner 作为可审批扩展路径。
3. PlanValidator 校验节点存在、路径可达、capability 可用和风险。
4. 每个 action 使用 idempotency key，失败后支持从安全 checkpoint 续跑。

### 阶段三：增量同步与画布拆分

1. 从全量 refetch 迁移为 versioned patch，同时保留 snapshot recovery。
2. 把 `WorldApp` 拆为 scene coordinator、entity registry、interaction controller、effects manager、editor plugin。
3. 统一后端 route 为事实源，前端只负责动画插值。
4. 对 mobile gesture、无障碍和低性能设备提供降级模式。

### 阶段四：建立视觉和任务评测

- 任务成功率、action 恢复率、artifact 完整率；
- world event 到画面更新时间；
- 100 节点/20 生命的 FPS、内存和 ticker 泄漏；
- 断网重连后 snapshot 一致性；
- Agent 失败/取消/审批等待时的视觉状态准确性。

## 8. 验收标准

1. 生产环境 API 失败时不展示 mock 世界；
2. 同一 task 不能被并发执行两次；
3. Agent Run 结束后 action/task/being/artifact 状态一致；
4. WS 丢失后 polling 能恢复，重连后无重复动画；
5. 动画中服务端轮询不导致位置跳回；
6. editor 只在显式开发入口可用；
7. destroy 后无 ticker、socket、DOM listener 泄漏；
8. 未知 task type 给出明确错误；
9. 画布视觉状态可以追溯到持久化业务状态。

## 9. 最终建议

视觉层的基础优化已经大体完成，下一阶段不应继续把主要精力放在装饰效果。优先级应转向“世界状态是否可信、任务是否可恢复、Agent 计划是否可验证”。当业务事实、事件合同和 plan/action 模型稳定后，再做更丰富的角色、场景和动画才不会把实验画布包装成不可解释的黑盒。
