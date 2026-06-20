# 数字生命 PixiJS 初始画布接入指南

更新日期：2026-06-20

本文档只说明第一步如何在 Web 端建立数字生命页面架构、导入 PixiJS，并在“数字生命”页面显示出 PixiJS 画布。

本阶段不做接口、不做后端建模、不做 Agent Core 接入、不做 Skill 调用、不做真实任务。

## 1. 目标

点击左侧边栏“数字生命”后：

- 左侧边栏保持不变。
- 右侧区域全部是 PixiJS 画布。
- 数字生命页面顶部不再显示聊天页标题栏或占位区域。
- 不显示空白 `chat-page` 占位。
- 画布能自动适配右侧区域尺寸。
- 离开数字生命页面时销毁 PixiJS Application。

目标布局：

```text
┌──────────────┬──────────────────────────────────────────┐
│ Sidebar      │ PixiJS Canvas                            │
│ 新对话        │                                          │
│ 插件          │  初始阶段可显示背景色、网格、测试文字       │
│ 数字生命      │                                          │
│ Debug         │                                          │
└──────────────┴──────────────────────────────────────────┘
```

## 2. 安装依赖

在 workspace 中给 Web 包安装 PixiJS：

```bash
pnpm --filter @sunpilot/web add pixi.js@^8
```

不需要安装 `@types/pixi.js`，PixiJS v8 自带 TypeScript 类型。

安装后确认：

```bash
pnpm --filter @sunpilot/web build
```

## 3. 新建目录

新增目录：

```text
packages/web/src/features/digital-world/
  index.ts
  DigitalWorld.tsx
  DigitalWorld.scss
  canvas/
    WorldApp.ts
  hooks/
    useWorldApp.ts
```

本阶段先不建立模型目录、不建立 API 文件、不建立任务目录。

## 4. WorldApp.ts

`WorldApp.ts` 只负责 PixiJS Application 生命周期。

建议职责：

- 创建 `Application`。
- 初始化 canvas 尺寸。
- 挂载 `app.canvas` 到容器 DOM。
- 绘制一个最简单的背景、网格或测试文字。
- 提供 `resize(width, height)`。
- 提供 `destroy()`。

示例结构：

```ts
import { Application, Graphics, Text } from "pixi.js";

export class WorldApp {
  private app?: Application;

  async mount(container: HTMLElement) {
    const app = new Application();
    await app.init({
      width: container.clientWidth,
      height: container.clientHeight,
      backgroundColor: 0x0f172a,
      antialias: false,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      powerPreference: "high-performance",
    });

    container.appendChild(app.canvas);
    this.app = app;
    this.drawPlaceholder();
  }

  resize(width: number, height: number) {
    this.app?.renderer.resize(width, height);
  }

  destroy() {
    this.app?.destroy(true);
    this.app = undefined;
  }

  private drawPlaceholder() {
    if (!this.app) return;

    const bg = new Graphics()
      .rect(0, 0, this.app.renderer.width, this.app.renderer.height)
      .fill(0x0f172a);

    const label = new Text({
      text: "Digital World",
      style: {
        fill: 0xffffff,
        fontSize: 24,
        fontFamily: "sans-serif",
      },
    });
    label.x = 32;
    label.y = 32;

    this.app.stage.addChild(bg, label);
  }
}
```

实际实现时可以把 `drawPlaceholder()` 换成简单网格，但不要在本阶段引入机器人、路径规划或后端状态。

## 5. useWorldApp.ts

`useWorldApp` 负责把 React ref 和 PixiJS 生命周期连接起来。

建议职责：

- 接收容器 ref。
- `useEffect` 中创建 `WorldApp`。
- 使用 `ResizeObserver` 监听容器尺寸。
- 组件卸载时销毁 PixiJS。

示例结构：

```ts
import { useEffect, type RefObject } from "react";
import { WorldApp } from "../canvas/WorldApp";

export function useWorldApp(containerRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const world = new WorldApp();
    let disposed = false;

    void world.mount(container).then(() => {
      if (disposed) world.destroy();
    });

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      world.resize(width, height);
    });
    observer.observe(container);

    return () => {
      disposed = true;
      observer.disconnect();
      world.destroy();
    };
  }, [containerRef]);
}
```

## 6. DigitalWorld.tsx

`DigitalWorld` 是数字生命页面的第一层组件。

本阶段它只渲染一个容器，让 PixiJS 挂载进去。

```tsx
import { useRef } from "react";
import { useWorldApp } from "./hooks/useWorldApp";
import "./DigitalWorld.scss";

export function DigitalWorld() {
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  useWorldApp(canvasHostRef);

  return (
    <section className="digital-world">
      <div ref={canvasHostRef} className="digital-world__canvas-host" />
    </section>
  );
}
```

## 7. DigitalWorld.scss

右侧必须全部交给画布，不能保留聊天页顶部标题区。

```scss
.digital-world {
  width: 100%;
  height: 100%;
  min-height: 0;
  position: relative;
  overflow: hidden;
  background: #0f172a;
}

.digital-world__canvas-host {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

.digital-world__canvas-host canvas {
  width: 100%;
  height: 100%;
  display: block;
}
```

## 8. index.ts

```ts
export { DigitalWorld } from "./DigitalWorld";
```

## 9. 接入 ChatPage

当前 `ChatPage` 在所有 panel 下都会先渲染 `ChatHeader`，然后 `automation` 分支渲染一个空的 `chat-page`。

目标是：

- `activePanel === "automation"` 时不渲染 `ChatHeader`。
- `activePanel === "automation"` 时直接渲染 `<DigitalWorld />`。
- 其他 panel 保持现状。
- 左侧 Sidebar 不变。

建议结构：

```tsx
import { DigitalWorld } from "../../features/digital-world";

// ...

<div className="chat-page">
  {activePanel !== "automation" && (
    <ChatHeader
      // existing props
    />
  )}

  {activePanel === "automation" ? (
    <DigitalWorld />
  ) : activePanel === "plugins" ? (
    <PluginsEmptyView />
  ) : activePanel === "settings" ? (
    <SettingsPage />
  ) : activePanel === "debug" ? (
    // existing debug panel
  ) : (
    // existing chat panel
  )}
</div>
```

如果外层 `.chat-page` 自身有 padding、标题栏高度或布局约束导致画布不能铺满，则需要给自动化分支加单独 class：

```tsx
<div className={activePanel === "automation" ? "chat-page chat-page--digital-world" : "chat-page"}>
```

对应样式：

```scss
.chat-page--digital-world {
  padding: 0;
  overflow: hidden;
}
```

## 10. 本阶段不要做

不要做这些事：

- 不新增后端 API。
- 不新增数据库 migration。
- 不新增 `packages/platform` 的 digital-world 模块。
- 不绑定 conversation。
- 不创建 Agent Run。
- 不调用 Agent Core。
- 不调用 Skill。
- 不做产物箱数据。
- 不做路径规划。
- 不做真实数字生命状态机。

本阶段只验证：

```text
左侧边栏不变
数字生命页面右侧全画布
PixiJS 正常初始化
PixiJS 正常 resize
PixiJS 正常 destroy
Web build 通过
```

## 11. 验收命令

```bash
pnpm --filter @sunpilot/web build
git diff --check
```

手动验收：

```text
1. 启动 Web 开发服务
2. 打开聊天页
3. 点击左侧“数字生命”
4. 确认右侧没有顶部标题栏占位
5. 确认右侧完整显示 PixiJS 画布
6. 切换到其他侧边栏项后无报错
7. 再切回数字生命后画布可重新创建
```

## 12. 下一步

完成本指南后，再进入 `digital_world_mvp_plan.md` 的 Phase 1：

- 静态世界。
- 道路网络。
- 工作台节点。
- 履带式数字生命静态形象。
- 头顶状态气泡。

不要在 PixiJS 初始接入阶段同时做后端世界模型。先让画布稳定出现，再逐步增加世界内容。
