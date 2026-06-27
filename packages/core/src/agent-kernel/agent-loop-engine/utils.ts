import type { Permission, RiskLevel, RoutedIntent } from "../loop-types.js";

export function intentFromSkillId(skillId: string): RoutedIntent["type"] {
  if (skillId.startsWith("filesystem.")) return "file_operation";
  if (skillId.startsWith("shell.")) return "shell_operation";
  if (skillId.startsWith("memory.")) return "memory_update";
  if (skillId.startsWith("artifact.")) return "artifact_generation";
  if (skillId.includes(":") || skillId.startsWith("automation"))
    return "automation_execution";
  return "unknown";
}

/** §P1-1: Map intent type to a user-facing progress label. */
export function intentLabelForStatus(intent: RoutedIntent): string {
  switch (intent.type) {
    case "casual_chat": return "正在理解对话...";
    case "question_answering": return "正在分析问题...";
    case "project_analysis": return "正在分析项目结构...";
    case "code_generation": case "code_modification": return "正在理解代码需求...";
    case "file_operation": return "正在准备文件操作...";
    case "shell_operation": return "正在准备命令执行...";
    case "automation_execution": return "正在准备自动化任务...";
    case "artifact_generation": return "正在准备生成内容...";
    case "use_skill": return intent.candidateSkills.length > 0
      ? `正在准备调用工具...`
      : "正在理解需求...";
    default: return "正在理解需求...";
  }
}


export function maxRiskLevel(left: RiskLevel, right: RiskLevel): RiskLevel {
  const order: Record<RiskLevel, number> = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };
  return order[left] >= order[right] ? left : right;
}

/**
 * Summarize tool arguments for display in approval UI.
 * Truncates long values to keep the approval card readable.
 */
export function summarizeArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const summarized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > 200) {
      summarized[key] = value.slice(0, 200) + "...";
    } else if (Array.isArray(value) && value.length > 5) {
      summarized[key] = `[${value.length} items]`;
    } else {
      summarized[key] = value;
    }
  }
  return summarized;
}

/**
 * Build human-readable risk reasons for approval events.
 */
export function buildRiskReasons(
  riskLevel: RiskLevel,
  action: { skillId: string; permissions?: Permission[] },
): string[] {
  const reasons: string[] = [];
  if (riskLevel === "high" || riskLevel === "critical") {
    reasons.push(`Risk level: ${riskLevel}`);
  }
  const perms = action.permissions ?? [];
  if (
    perms.includes("filesystem.write") ||
    perms.includes("filesystem.delete")
  ) {
    reasons.push("Writes to filesystem");
  }
  if (perms.includes("shell.execute")) {
    reasons.push("Executes shell commands");
  }
  if (perms.includes("network.request")) {
    reasons.push("Makes network requests");
  }
  if (perms.includes("external.send")) {
    reasons.push("Sends data externally");
  }
  if (reasons.length === 0) {
    reasons.push("Low-risk operation");
  }
  return reasons;
}

/**
 * §B19: Race a promise against a timeout, ensuring the timer is cleared
 * when the primary promise wins. Without this, the setTimeout keeps the
 * event loop alive and fires a no-op resolve after the primary promise
 * already resolved.
 *
 * Returns `undefined` if the timeout fires first, or the primary value
 * if it resolves within the timeout.
 */
export async function racePreliminaryWithTimeout<T>(
  primary: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      primary.then((value) => {
        if (timer) clearTimeout(timer);
        return value;
      }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * §3.2: Non-blocking peek at a promise — returns the resolved value
 * immediately if the promise has already settled, or `undefined` if it's
 * still pending. Used to check pre-inference availability WITHOUT adding
 * latency to the critical path.
 *
 * Implementation: races the primary promise against a microtask-deferred
 * `undefined`. If the primary is already settled, it wins the race in the
 * same microtask; otherwise the deferred `undefined` resolves first.
 */
export async function peekResolvedPromise<T>(primary: Promise<T>): Promise<T | undefined> {
  return Promise.race([
    primary,
    Promise.resolve().then(() => undefined as T | undefined),
  ]);
}
