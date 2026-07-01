/**
 * Agent event types — the canonical event vocabulary for the Agent Runtime.
 * All chat, run, tool, approval, and response events use the `agent.*` namespace.
 */

/**
 * Protocol version for the agent event stream (A11). Producers MAY stamp
 * events with this version; consumers MAY use it to guard incompatible
 * payload shapes. Bumped on breaking changes to event payloads.
 */
export const AGENT_EVENT_PROTOCOL_VERSION = "1";

export const AGENT_EVENT_TYPES = [
  // Run lifecycle
  "agent.run.created",
  "agent.run.started",
  "agent.run.completed",
  "agent.run.failed",
  "agent.run.cancelled",
  "agent.run.interrupted",
  // Context
  "agent.context.started",
  "agent.context.completed",
  // Intent
  "agent.intent.detected",
  // Planning
  "agent.plan.created",
  "agent.plan.warnings",
  "agent.plan.validated",
  "agent.plan.revised",
  // Tool
  "agent.tool.selected",
  "agent.tool.started",
  "agent.tool.delta",
  "agent.tool.completed",
  "agent.tool.failed",
  "agent.tool_argument.generated",
  "agent.tool_argument.validation_failed",
  "agent.tool_output.validation_failed",
  // Approval
  "agent.approval.required",
  "agent.approval.approved",
  "agent.approval.rejected",
  "agent.approval.expired",
  // Artifact & Memory
  "agent.artifact.created",
  "agent.memory.written",
  // Model
  "agent.model.started",
  "agent.model.delta",
  "agent.model.completed",
  "agent.model.failed",
  "agent.react.turn.completed",
  "agent.clarification.requested",
  // Error
  "agent.error",
  // Message content-block events (§Phase 1 of streaming refactoring)
  "agent.message.started",
  "agent.message.part.started",
  "agent.message.part.delta",
  "agent.message.part.updated",
  "agent.message.completed",
  // Safety (§P0-3)
  "agent.safety.injection_detected",
  "agent.safety.sandbox_denied",
  "agent.safety.scope_reauth_required",
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];
