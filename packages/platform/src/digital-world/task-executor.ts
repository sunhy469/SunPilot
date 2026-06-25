import type { DatabaseContext } from "@sunpilot/storage";
import type { PlatformRequestContext } from "../context.js";
import { BeingNotFoundError } from "./digital-being.errors.js";
import { planRoute } from "./path-planner.js";

const TASK_ACTION_MAP: Record<string, string[]> = {
  make_video: ["wake", "move_to:video_workstation", "work_on:make_video", "artifact_created:video", "move_to:artifact_box", "move_to:home", "sleep:task_done"],
  publish_to_tiktok: ["wake", "move_to:artifact_box", "move_to:tiktok_station", "work_on:publish_to_tiktok", "move_to:home", "sleep:task_done"],
  make_and_publish_video: ["wake", "move_to:video_workstation", "work_on:make_video", "artifact_created:video", "move_to:artifact_box", "move_to:tiktok_station", "work_on:publish_to_tiktok", "move_to:home", "sleep:task_done"],
  return_home: ["move_to:home"],
  sleep: ["sleep:manual"],
};

/** Narrow interface for Agent Core — Platform does not depend on full AgentService. */
interface WorldAgent {
  startChatCommand: (
    input: {
      conversationId?: string;
      message: string;
      mode?: "chat" | "agent";
    },
    ctx: { source: "web" | "cli" | "api" },
  ) => Promise<{ runId: string; conversationId: string }>;
}

type ExecuteActionResult =
  | { status: "completed" }
  | { status: "waiting_agent"; runId: string }
  | { status: "failed"; error: string };

export class TaskExecutor {
  constructor(
    private readonly deps: {
      database: DatabaseContext;
      /** Async factory to lazily obtain the AgentService. */
      getAgent?: () => Promise<WorldAgent>;
    },
  ) {}

  async executeTask(ctx: PlatformRequestContext, taskId: string): Promise<void> {
    const task = await this.deps.database.worldTasks.findById(taskId);
    if (!task) return;

    const actionTemplates = TASK_ACTION_MAP[task.type] ?? [];
    if (actionTemplates.length === 0) return;

    // Atomically claim the task: verify it's still queued, then mark running.
    // Guards against concurrent executors double-claiming the same task
    // (previously a non-atomic SELECT-then-UPDATE race).
    const claimed = await this.claimTask(taskId);
    if (!claimed) return;

    // Sync being's currentTaskId
    const beingId = task.beingId;
    await this.deps.database.digitalBeings.update(beingId, { currentTaskId: taskId });

    // Create actions
    const being = await this.deps.database.digitalBeings.findById(beingId);
    if (!being) throw new BeingNotFoundError(beingId);

    for (let i = 0; i < actionTemplates.length; i++) {
      const template = actionTemplates[i]!;
      const [type, ...paramParts] = template.split(":");
      const param = paramParts.join(":") || undefined;

      // Build params based on action type
      const params = this.buildActionParams(type!, param);

      await this.deps.database.worldActions.create({
        id: `wa_${crypto.randomUUID()}`,
        taskId: task.id,
        beingId,
        type: type!,
        toNodeId: type === "move_to" ? param : undefined,
        params,
        statusText: this.getActionStatusText(type!, param),
      });
    }

    // Execute actions sequentially
    const actions = await this.deps.database.worldActions.listByTaskId(taskId);
    for (const action of actions) {
      try {
        // Sync being's currentActionId before each action
        await this.deps.database.digitalBeings.update(beingId, { currentActionId: action.id });
        const actionResult = await this.executeAction(ctx, action.id, beingId);

        if (actionResult.status === "waiting_agent") {
          // The action started an async Agent Run. Stop executing further actions
          // — the task will be resumed by onAgentRunCompleted() when the run finishes.
          return;
        }

        if (actionResult.status === "failed") {
          throw new Error(actionResult.error);
        }

        // actionResult.status === "completed": continue to next action
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        // Write error to the current action
        await this.deps.database.worldActions.update(action.id, {
          status: "failed",
          error: { message: errorMessage },
          completedAt: new Date().toISOString(),
        }).catch(() => {});

        // Log the failure
        await this.deps.database.worldActionLogs.create({
          id: `wal_${crypto.randomUUID()}`,
          actionId: action.id,
          beingId,
          eventType: `${action.type}.failed`,
          payload: { type: action.type, params: action.params, error: errorMessage },
        }).catch(() => {});

        // Clear being's currentTaskId/currentActionId on failure
        await this.deps.database.digitalBeings.update(beingId, {
          currentTaskId: undefined,
          currentActionId: undefined,
        });
        await this.deps.database.worldTasks.update(taskId, {
          status: "failed",
          completedAt: new Date().toISOString(),
        });
        return;
      }
    }

    // Clear being's currentTaskId/currentActionId after all actions complete
    await this.deps.database.digitalBeings.update(beingId, {
      currentTaskId: undefined,
      currentActionId: undefined,
    });

    await this.deps.database.worldTasks.update(taskId, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
  }

  /**
   * Atomically claim a queued task and mark it running.
   * Returns the task on success, or null if the task is missing or no longer
   * claimable (e.g. already taken by another executor or in a terminal state).
   */
  private async claimTask(taskId: string) {
    const db = this.deps.database;
    const claim = async (dbc: DatabaseContext) => {
      const current = await dbc.worldTasks.findById(taskId);
      if (!current || current.status !== "queued") return null;
      await dbc.worldTasks.update(taskId, {
        status: "running",
        startedAt: new Date().toISOString(),
      });
      return current;
    };
    return db.transaction ? db.transaction(claim) : claim(db);
  }

  private buildActionParams(type: string, param?: string): Record<string, unknown> {
    switch (type) {
      case "move_to":
        return { targetNodeId: param ?? "" };
      case "work_on":
        return { workType: param ?? "" };
      case "artifact_created":
        return { artifactType: param ?? "" };
      case "sleep":
        return { sleepReason: param ?? "" };
      case "wake":
        return {};
      default:
        return {};
    }
  }

  private async executeAction(ctx: PlatformRequestContext, actionId: string, beingId: string): Promise<ExecuteActionResult> {
    const action = await this.deps.database.worldActions.findById(actionId);
    if (!action) return { status: "failed", error: "Action not found" } as ExecuteActionResult;

    // Update action to running
    await this.deps.database.worldActions.update(actionId, {
      status: "running",
      startedAt: new Date().toISOString(),
    });

    // Update being status
    const being = await this.deps.database.digitalBeings.findById(beingId);
    if (!being) throw new BeingNotFoundError(beingId);

    switch (action.type) {
      case "wake": {
        await this.deps.database.digitalBeings.update(beingId, {
          status: "idle",
          statusText: "已醒来",
          sleepReason: undefined,
        });
        break;
      }
      case "move_to": {
        const targetNodeId = action.params.targetNodeId as string | undefined ?? action.toNodeId;
        if (!targetNodeId) break;

        const edges = await this.deps.database.worldEdges.list();
        const route = planRoute(being.currentNodeId, targetNodeId, edges);

        await this.deps.database.digitalBeings.update(beingId, {
          status: "moving",
          targetNodeId,
          statusText: `正在前往${this.getNodeName(targetNodeId)}`,
        });

        // Update action with route
        await this.deps.database.worldActions.update(actionId, {
          routeNodeIds: route ?? undefined,
          fromNodeId: being.currentNodeId,
        });

        // Move being to target (simplified - no animation on backend)
        await this.deps.database.digitalBeings.update(beingId, {
          currentNodeId: targetNodeId,
          targetNodeId: undefined,
          statusText: `已到达${this.getNodeName(targetNodeId)}`,
        });
        break;
      }
      case "work_on": {
        const workType = action.params.workType as string ?? "";

        if (this.deps.getAgent) {
          // Phase 5: Call Agent Core to start an agent run
          const agent = await this.deps.getAgent();
          const result = await agent.startChatCommand(
            {
              conversationId: being.conversationId,
              message: workType || "execute task",
              mode: "agent",
            },
            { source: "api" },
          );

          // Store the agent runId on the action
          await this.deps.database.worldActions.update(actionId, {
            agentRunId: result.runId,
          });

          // Keep action in working status — the run executes asynchronously.
          // Completion is handled by onAgentRunCompleted() when the run finishes.
          await this.deps.database.digitalBeings.update(beingId, {
            status: "working",
            statusText: `正在${this.getWorkLabel(workType)}（Agent 运行中）`,
          });

          // Do NOT mark the action as completed; return waiting_agent so the
          // sequential executor stops here until the Agent Run completes.
          return { status: "waiting_agent", runId: result.runId };
        } else {
          // Phase 4 fallback: mock work with clear mock marking
          await this.deps.database.digitalBeings.update(beingId, {
            status: "working",
            statusText: `正在${this.getWorkLabel(workType)}（模拟）`,
          });

          await this.deps.database.digitalBeings.update(beingId, {
            status: "idle",
            statusText: `${this.getWorkLabel(workType)}完成（模拟）`,
          });
        }
        break;
      }
      case "artifact_created": {
        // artifact_created only registers/animates the artifact in the world.
        // The actual WorldArtifact is created by the Agent Run result
        // (via onAgentRunCompleted), not here — to avoid duplicate creation.
        const artifactType = action.params.artifactType as string ?? "video";
        await this.deps.database.digitalBeings.update(beingId, {
          statusText: `${artifactType} 产物已登记`,
        });
        break;
      }
      case "sleep": {
        const reason = action.params.sleepReason as string ?? "task_done";
        await this.deps.database.digitalBeings.update(beingId, {
          status: "sleeping",
          sleepReason: reason,
          statusText: reason === "task_done" ? "任务完成，已休眠" : "已休眠",
        });
        break;
      }
    }

    // Log the action
    await this.deps.database.worldActionLogs.create({
      id: `wal_${crypto.randomUUID()}`,
      actionId,
      beingId,
      eventType: `${action.type}.completed`,
      payload: { type: action.type, params: action.params },
    });

    // Mark action as completed
    await this.deps.database.worldActions.update(actionId, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });

    return { status: "completed" };
  }

  /**
   * Called when an Agent Run completes (success, failure, or cancellation).
   * This resumes the sequential action executor from the paused work_on action.
   */
  async onAgentRunCompleted(
    ctx: PlatformRequestContext,
    runId: string,
    status: "completed" | "failed" | "cancelled",
    artifacts?: Array<{ type: string; title: string; uri?: string }>,
  ): Promise<void> {
    // Find the action that owns this run
    const action = await this.findActionByRunId(runId);
    if (!action) return;

    const being = await this.deps.database.digitalBeings.findById(action.beingId);
    if (!being) return;

    if (status === "failed" || status === "cancelled") {
      // Mark the action as failed
      await this.deps.database.worldActions.update(action.id, {
        status: "failed",
        error: { message: `Agent run ${status}`, runId },
        completedAt: new Date().toISOString(),
      });

      await this.deps.database.worldActionLogs.create({
        id: `wal_${crypto.randomUUID()}`,
        actionId: action.id,
        beingId: action.beingId,
        eventType: `work_on.${status}`,
        payload: { type: "work_on", runId, status },
      });

      // Clear being task state
      await this.deps.database.digitalBeings.update(action.beingId, {
        status: "idle",
        statusText: `工作失败（Agent ${status === "failed" ? "出错" : "取消"}）`,
        currentTaskId: undefined,
        currentActionId: undefined,
      });

      // Mark the task as failed
      await this.deps.database.worldTasks.update(action.taskId, {
        status: "failed",
        completedAt: new Date().toISOString(),
      });
      return;
    }

    // Run completed successfully — create WorldArtifact from Agent Run result
    if (artifacts && artifacts.length > 0) {
      for (const artifact of artifacts) {
        await this.deps.database.worldArtifacts.create({
          id: `wart_${crypto.randomUUID()}`,
          beingId: action.beingId,
          taskId: action.taskId,
          runId,
          type: artifact.type,
          title: artifact.title,
          uri: artifact.uri,
          locationNodeId: being.currentNodeId,
          status: "created",
        });
      }
    }

    // Mark the work_on action as completed
    await this.deps.database.worldActions.update(action.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });

    await this.deps.database.worldActionLogs.create({
      id: `wal_${crypto.randomUUID()}`,
      actionId: action.id,
      beingId: action.beingId,
      eventType: "work_on.completed",
      payload: { type: "work_on", runId, artifactCount: artifacts?.length ?? 0 },
    });

    // Resume executing remaining actions in the task
    const taskActions = await this.deps.database.worldActions.listByTaskId(action.taskId);
    const currentIdx = taskActions.findIndex((a) => a.id === action.id);
    for (let i = currentIdx + 1; i < taskActions.length; i++) {
      const nextAction = taskActions[i]!;
      try {
        await this.deps.database.digitalBeings.update(action.beingId, { currentActionId: nextAction.id });
        await this.executeAction(ctx, nextAction.id, action.beingId);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        await this.deps.database.worldActions.update(nextAction.id, {
          status: "failed",
          error: { message: errorMessage },
          completedAt: new Date().toISOString(),
        }).catch(() => {});
        await this.deps.database.digitalBeings.update(action.beingId, {
          currentTaskId: undefined,
          currentActionId: undefined,
        });
        await this.deps.database.worldTasks.update(action.taskId, {
          status: "failed",
          completedAt: new Date().toISOString(),
        });
        return;
      }
    }

    // All actions completed
    await this.deps.database.digitalBeings.update(action.beingId, {
      currentTaskId: undefined,
      currentActionId: undefined,
    });
    await this.deps.database.worldTasks.update(action.taskId, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
  }

  /** Find a running action by its agentRunId. */
  private async findActionByRunId(runId: string) {
    // Query all beings' actions — this is a simple scan.
    // For production scale, add a dedicated query method.
    const beings = await this.deps.database.digitalBeings.list();
    for (const being of beings) {
      const actions = await this.deps.database.worldActions.listByBeingId(being.id);
      const found = actions.find((a) => a.agentRunId === runId && a.status === "running");
      if (found) return found;
    }
    return null;
  }

  private getActionStatusText(type: string, param?: string): string {
    switch (type) {
      case "wake": return "醒来";
      case "move_to": return `前往${this.getNodeName(param ?? "")}`;
      case "work_on": return `执行${this.getWorkLabel(param ?? "")}`;
      case "artifact_created": return "产物已登记";
      case "sleep": return "休眠";
      default: return type;
    }
  }

  private getNodeName(nodeId: string): string {
    const names: Record<string, string> = {
      home: "家",
      video_workstation: "视频工作台",
      artifact_box: "产物箱",
      tiktok_station: "TikTok 发布台",
      material_library: "素材库",
      crossroad: "主路口",
    };
    return names[nodeId] ?? nodeId;
  }

  private getWorkLabel(workType: string): string {
    const labels: Record<string, string> = {
      make_video: "视频制作",
      publish_to_tiktok: "TikTok 发布",
    };
    return labels[workType] ?? workType;
  }
}
