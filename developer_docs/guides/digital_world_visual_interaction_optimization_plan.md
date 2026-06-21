# 数字生命画布视觉与交互优化开发文档

更新日期：2026-06-21

本文档针对当前数字生命页面的实际效果和代码实现做开发优化规划。重点关注页面布局、机器人建模、画布拖动能力、当前完成度和下一步优化路线。本文只作为架构与开发指导，不修改代码。

## 1. 当前观察结论

从当前页面效果看，数字生命功能已经完成了“能进入页面、能看到白色画布、能看到节点和道路、能看到机器人、能触发移动”的第一版可视化雏形。

但现在还不能认为它达到了数字世界产品形态，主要问题是：

- 页面布局像一张静态流程图，数字世界感不足。
- 机器人建模太小、太扁平、识别度弱，当前更像一个灰色小图标。
- 工作台节点外观过于统一，像白色卡片流程节点，不像真实工作室里的桌子、仓库、发布台。
- 画布不能拖动，也没有 viewport/camera 概念，大画布空间虽然存在，但用户不能探索。
- 世界内容集中在画布中部偏小区域，右侧和下方大量空白没有被设计利用。
- 底部“去视频工作台/去产物箱/去 TikTok/回家”仍是开发测试条，不应作为正式产品操作长期保留。
- 右侧悬浮 dock 基本可用，但现在是纯工具入口，没有和世界对象形成清晰关系。

## 2. 复查依据

本次复查参考了：

- 当前页面截图。
- `packages/web/src/features/digital-world/DigitalWorld.tsx`
- `packages/web/src/features/digital-world/DigitalWorld.scss`
- `packages/web/src/features/digital-world/canvas/WorldApp.ts`
- `packages/web/src/features/digital-world/canvas/DigitalBeingEntity.ts`
- `packages/web/src/features/digital-world/canvas/WorkstationNode.ts`
- `packages/web/src/features/digital-world/mock/mockWorld.ts`
- `packages/web/src/features/digital-world/hooks/useWorldApp.ts`
- `packages/web/src/features/digital-world/hooks/useBeingMovement.ts`
- `developer_docs/guides/digital_world_implementation_review_report.md`

当前分支中 `developer_docs/guides/digital_world_mvp_plan.md` 处于删除状态，因此本文对阶段要求的判断主要结合现有实现、已有复查报告和页面实际效果。

## 3. 当前完成度判断

| 模块 | 完成度 | 判断 |
| --- | --- | --- |
| 页面入口 | 基本完成 | 左侧“数字生命”入口可进入独立画布页面，ChatHeader 已隐藏。 |
| 白色画布 | 基本完成 | 页面和 PixiJS canvas 都是白色背景，符合明亮数字工作室方向。 |
| 静态世界 | 部分完成 | 有网格、道路、节点、机器人，但视觉仍像流程图。 |
| 机器人建模 | 未达标 | 当前机器人由简单圆形、矩形、履带拼成，尺寸小、层次弱、缺少角色感和工作状态表现。 |
| 画布拖动 | 未完成 | 当前没有拖动画布、平移 viewport、缩放、回到中心等能力。 |
| 前端路径动画 | 基本完成 | 已有 Dijkstra 和 RouteAnimator，能沿道路移动。 |
| 数据同步 | 部分完成 | `WorldApp.setData()` 已支持数据变化重绘，但前端交互状态和后端世界状态仍需更明确同步策略。 |
| 任务和产物面板 | 部分完成 | UI 面板已有，但接口契约、日志、任务列表等仍需继续修正。 |
| 后端世界模型 | 部分完成 | Storage/API/Platform 骨架已存在，但还不是稳定闭环。 |
| Agent Core/Skill 接入 | 未完成 | 当前不应视为真实接入完成。 |

构建检查结果：

```text
pnpm --filter @sunpilot/web build       通过
pnpm --filter @sunpilot/api build       通过
pnpm --filter @sunpilot/platform build  通过
pnpm --filter @sunpilot/storage build   通过
```

这说明当前问题不是编译阻断，而是体验完成度、交互架构和运行契约仍未打磨完成。

## 4. 页面布局问题

### 4.1 世界主体过小

当前世界节点集中在画布中央，节点之间间距像流程图布局。白色画布很大，但真正可识别的世界只占中间小块区域。

问题：

- 大画布没有形成“可探索空间”。
- 用户第一眼看到的是大量空白网格，而不是一个有生命的工作室。
- 机器人和工作台比例偏小，无法承载产品情绪。

建议：

- 初始视口应让世界主体占据右侧画布 55%-70% 的宽度。
- home、主路口、视频工作台、产物箱、TikTok 发布台之间保持道路关系，但整体放大。
- 底部测试按钮不要遮挡世界主体，后续应移到开发模式或任务面板内。

### 4.2 工作台像流程卡片

当前 `WorkstationNode` 使用白色圆角矩形、顶部色条、emoji 图标、状态灯。这种结构干净但产品感不足。

问题：

- 节点太像流程图节点。
- 工作台之间差异主要靠 emoji 和文字，不够像真实世界物件。
- emoji 在不同平台渲染不一致，未来容易破坏统一视觉。

建议：

- 工作台继续保持白色、浅灰边框，但要从“卡片”升级为“小型设备/桌面/站点”。
- `home` 应像充电舱或小房间。
- `video_workstation` 应像剪辑桌，包含屏幕、素材片段、时间线元素。
- `artifact_box` 应像开放式收纳箱或仓储柜。
- `tiktok_station` 应像发布终端，有上传箭头、播放符号和平台标识。
- `material_library` 应像文件柜或素材架。
- 后续不要继续依赖 emoji，建议使用 Pixi Graphics 组合或统一图标纹理。

### 4.3 悬浮工具入口缺少上下文

右侧 dock 现在是独立工具条，功能完整但和世界对象的关系弱。

建议：

- 保留右侧 dock 作为全局入口。
- 节点点击后应出现局部操作，如点击产物箱打开产物面板、点击机器人打开状态/对话。
- dock 中“日志”和“状态”目前复用同一个面板，后续应拆成不同视图。

## 5. 机器人建模问题

当前 `DigitalBeingEntity` 的实现是：

- 两条履带：深色小矩形。
- 身体：深灰圆角矩形。
- 头部：灰色圆。
- 眼睛：两个白点。

这能表达“机器人”，但没有形成“数字生命”的角色记忆点。

### 5.1 主要问题

- 尺寸太小，在当前画布比例下不够突出。
- 轮廓太简单，像小图标，不像住在工作室里的机器人员工。
- 缺少正面朝向、侧向移动、待机、工作、休眠状态变化。
- 色彩过暗，和白色世界关系有点割裂。
- 头顶状态气泡和机器人比例不协调，气泡比角色更醒目。
- 没有阴影、底盘厚度、机械臂、屏幕眼睛等能增强角色感的结构。

### 5.2 建议的机器人方向

机器人应升级为“小型履带式 AI 员工”，但不要复制任何具体版权角色。

建议结构：

- 底部：更宽的履带底盘，左右履带有浅色轮点或履带齿。
- 身体：圆角矩形主机，颜色使用浅灰白或柔和蓝灰，不要整块深灰。
- 头部：小屏幕或双目传感器，眼睛可有发光状态。
- 手臂：两侧短机械臂，工作时可轻微展开。
- 状态灯：身体侧面或头部顶部保留小绿灯。
- 阴影：底部增加柔和椭圆阴影，让角色站在世界里。
- 尺寸：建议从当前约 `28x36` 提升到 `44x56` 或 `52x64`，并根据画布缩放统一处理。

### 5.3 状态表现

建议为机器人增加状态变体：

| 状态 | 视觉表现 |
| --- | --- |
| idle | 眼睛常亮，轻微呼吸动画，履带静止。 |
| moving | 履带滚动点或底盘轻微上下浮动，朝向目标方向。 |
| working | 机械臂展开，头部或身体状态灯闪烁。 |
| waiting | 眼睛变成黄色或显示省略号。 |
| sleeping | 眼睛关闭，机器人靠近 home，状态灯变暗。 |
| error | 状态灯红色，气泡提示错误。 |

### 5.4 实现建议

短期仍可用 Pixi Graphics 实现，不需要马上引入复杂贴图。

建议拆分：

```text
DigitalBeingEntity
  bodyLayer
  trackLayer
  headLayer
  eyeLayer
  armLayer
  shadowLayer
  statusLightLayer
```

并提供这些方法：

```text
setPosition(x, y)
setFacing(direction)
setStatus(status)
setWorkingProgress(progress)
playIdle()
playMove()
playSleep()
destroy()
```

这样后续动画不会全部塞进 `draw()` 里。

## 6. 画布拖动与 viewport 缺口

当前 `WorldApp` 直接把 grid、road、node、being 加到 `app.stage`。这意味着现在没有明确的世界容器和相机层。

当前能力：

- 支持 resize。
- 支持数据变化后 `setData()` 重绘。
- 支持机器人沿道路移动。

缺失能力：

- 不能按住拖动画布。
- 不能滚轮缩放。
- 不能回到世界中心。
- 不能限制拖动边界。
- 不能区分“世界坐标”和“屏幕坐标”。
- 网格现在更像屏幕背景，不是可被相机平移的世界地面。

### 6.1 推荐交互目标

MVP 下一步至少应支持：

- 鼠标按住空白画布拖动世界。
- 触控板/滚轮可选支持缩放。
- 双击空白或点击按钮回到机器人当前位置。
- 拖动时不触发节点点击。
- 节点、机器人、状态气泡随世界一起移动。
- 右侧 dock、底部任务入口、抽屉等 UI 不跟随世界移动。

### 6.2 推荐技术结构

建议给 PixiJS 增加 viewport/camera 分层：

```text
app.stage
  screenLayer        固定屏幕层：dock 相关锚点、调试 overlay 可选
  viewport           可平移缩放的世界层
    gridLayer
    roadLayer
    nodeLayer
    beingLayer
    effectLayer
    statusBubbleLayer
```

状态面板、任务面板、产物箱面板继续由 React/AntD 承担，不放进 PixiJS。

### 6.3 拖动画布实现要求

建议新增 WorldViewport 或 CameraController：

```text
canvas/WorldViewport.ts
canvas/CameraController.ts
hooks/useCanvasInteraction.ts
```

基础职责：

- 监听 `pointerdown`、`pointermove`、`pointerup`、`pointerupoutside`。
- 只在点击空白区域时开始拖动。
- 记录 pointer 初始位置和 viewport 初始偏移。
- 更新 viewport.x / viewport.y。
- 提供 `centerOn(nodeId | being)`。
- 提供 `fitWorldToView()`。
- 后续再加入 wheel zoom。

拖动边界建议：

- MVP 可以先不做复杂边界，只限制不能把世界完全拖出视口。
- 后续根据 world bounds 计算 `minX/maxX/minY/maxY`。

### 6.4 不建议现在做的事

- 不建议一开始引入复杂地图编辑器能力。
- 不建议允许拖动节点位置。
- 不建议把 React 面板也放进 PixiJS viewport。
- 不建议先做无限画布缩放，再做基础拖动；顺序应该先平移，再缩放。

## 7. 当前代码层面的风险

### 7.1 WorldApp 已有重绘，但还没有交互层

`WorldApp.setData()` 已经可以在 nodes/edges id 集合变化时重绘，这是一个好方向。

但现在 grid、road、node、being 都直接挂在 stage 下。后续加拖动时，如果继续直接移动 stage，会影响未来固定屏幕层；更建议新增 viewport container，只移动 viewport。

### 7.2 stopTicker 使用内部结构风险

`WorldApp.stopTicker()` 当前通过 `this.app.ticker.remove(...this.app.ticker.callbacks)` 停止 ticker。

虽然当前 build 通过，但这类直接访问 ticker callbacks 的方式不够稳。后续更建议由 RouteAnimator 自己注册/注销，WorldApp 只管理自己创建的 controller。

### 7.3 状态气泡属于世界层还是屏幕层需要定

现在状态气泡在 PixiJS 中跟随机器人移动。加入 viewport 后，它可以继续作为世界层的一部分。

如果未来状态气泡改为 React DOM，需要做世界坐标到屏幕坐标转换，并在拖动画布时同步更新。

短期建议继续放 PixiJS 世界层，避免过早复杂化。

### 7.4 开发测试条需要降级

底部 `MovementTestBar` 对 Phase 2 验证有用，但截图中它已经变成正式页面的一部分。

建议：

- 开发环境保留。
- 生产或正式体验中隐藏。
- 正式移动应由任务面板、节点点击、或机器人操作菜单触发。

## 8. 下一步优化路线

### Step 1：先做视觉比例和机器人重建

目标：

- 让第一眼从“流程图”变成“白色数字工作室”。
- 让机器人有角色感，成为页面视觉主角。

任务：

- 放大世界主体布局，减少无意义空白。
- 重做 `DigitalBeingEntity`，采用分层结构。
- 增加底盘阴影、履带细节、机械臂、状态灯。
- 调整机器人尺寸到约 `44x56` 或 `52x64`。
- 调整状态气泡大小和位置，不要压过机器人。
- 减少 emoji 依赖，至少为核心节点改成统一 Graphics 图形。

验收：

- 截图中机器人不用放大也能一眼识别。
- home、视频工作台、产物箱、TikTok 发布台有明显差异。
- 页面不再像静态流程图。

### Step 2：实现画布拖动

目标：

- 用户可以拖动画布探索世界。
- 为未来更大地图和更多工作台打基础。

任务：

- 新增 viewport container。
- grid、road、node、being、bubble 挂到 viewport 下。
- 增加 pointer drag 逻辑。
- 增加 `centerOnBeing()`。
- 保留右侧 dock 和抽屉为固定 UI。

验收：

- 按住空白画布可以拖动世界。
- 拖动时节点、道路、机器人一起移动。
- 右侧 dock 不移动。
- 点击节点和拖动画布不会互相误触。

### Step 3：补基础相机控制

目标：

- 页面可以自动定位到世界主体。
- 用户迷路后能回到机器人位置。

任务：

- 初始进入时 `fitWorldToView()`。
- 新增“回到机器人”按钮或复用 dock。
- 支持可选 wheel zoom，缩放范围建议 `0.75 - 1.6`。
- 根据 world bounds 限制拖动范围。

验收：

- 首屏世界主体占比合理。
- 用户拖走后能一键回到机器人。
- 缩放不会导致节点文字不可读。

### Step 4：优化节点与工作台交互

目标：

- 世界对象本身可交互，不只靠右侧 dock。

任务：

- 节点 hover 高亮。
- 节点 click 打开对应面板。
- 机器人 click 打开状态或对话面板。
- 产物箱节点 click 打开产物箱。
- TikTok 发布台 click 打开发布状态。

验收：

- 用户可以直接点击世界里的对象理解和操作。
- dock 变成全局入口，不是唯一入口。

### Step 5：修正数据和任务闭环

这一步延续 `digital_world_implementation_review_report.md` 的后端建议。

任务：

- 修复 `world_actions.created_at` 缺失和 repository 排序问题。
- 增加任务列表 GET API。
- 增加 action log API。
- 接入默认 world seed。
- 明确 mock fallback 和真实世界状态的边界。

验收：

- 任务面板能显示真实任务。
- 状态面板能显示真实动作日志。
- 刷新页面后位置和任务状态来自后端。

### Step 6：再进入 Agent Core/Skill 闭环

目标：

- 在世界模型和交互稳定后，再让 `work_on` 真实创建 Agent Run。

任务：

- 定义 Platform 到 Agent Core 的窄接口。
- `work_on` 创建 run 后保持 working/waiting。
- run completed 后再创建 WorldArtifact。
- run failed/waiting approval 映射到 WorldAction 和 DigitalBeing 状态。

验收：

- Agent Run 没完成前，世界不提前显示“工作完成”。
- Skill 真实产物进入产物箱。
- 失败和等待授权可见。

## 9. 推荐优先级

优先级最高：

1. 重做机器人建模。
2. 加 viewport 和拖动画布。
3. 调整世界布局比例。
4. 隐藏或降级底部 MovementTestBar。
5. 修正任务列表、动作日志和 world_actions DB 契约。

暂时不要优先做：

- 多数字生命。
- 复杂 3D。
- 自定义皮肤。
- 多平台发布矩阵。
- 真正的 Skill 发布闭环。

原因是当前最大短板不是后端能力数量，而是“这个世界看起来不像一个可以生活和工作的数字空间”。先把视觉主角、画布交互和基础世界感做出来，后续 Agent Core 和 Skill 接入才有承载体验。

## 10. 最终建议

下一轮开发建议命名为：

```text
Digital World Visual Interaction Phase
```

范围只做三件事：

```text
机器人重建
画布拖动
世界布局比例优化
```

这三个点完成后，再回到任务状态机和后端真实闭环。否则继续往后接 Agent Core 和 Skill，会让一个还不好看、不能拖动、缺少世界感的页面承载复杂流程，产品体验会显得很散。
