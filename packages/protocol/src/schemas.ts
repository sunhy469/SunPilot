import { z } from "zod";

export const runModeSchema = z.enum(["chat", "plan", "auto", "approval_required", "dry_run"]);

export const createRunSchema = z.object({
  input: z.unknown().default({}),
  workflowId: z.string().optional(),
  mode: runModeSchema.default("approval_required")
});

export const approvalDecisionSchema = z.object({
  reason: z.string().optional(),
  actor: z.string().default("local-user")
});

export const skillRiskSchema = z.enum(["low", "medium", "high", "critical"]);

export const permissionDeclarationSchema = z.object({
  filesystem: z
    .object({
      read: z.array(z.string()).default([]),
      write: z.array(z.string()).default([])
    })
    .default({ read: [], write: [] }),
  network: z.object({ allow: z.array(z.string()).default([]) }).default({ allow: [] }),
  env: z.object({ allow: z.array(z.string()).default([]) }).default({ allow: [] }),
  shell: z.boolean().default(false)
});

export const skillManifestSchema = z.object({
  schemaVersion: z.literal("sunpilot.skill/v1"),
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  entry: z.string().min(1),
  readme: z.string().min(1),
  author: z.object({ name: z.string() }).optional(),
  runtime: z.object({
    node: z.string().min(1),
    module: z.literal("esm")
  }),
  capabilities: z
    .array(
      z.object({
        name: z.string().min(1),
        title: z.string().min(1),
        description: z.string().min(1),
        inputSchema: z.union([z.string(), z.record(z.unknown())]),
        outputSchema: z.union([z.string(), z.record(z.unknown())]),
        risk: skillRiskSchema,
        permissions: z.array(z.string()).default([])
      }),
    )
    .min(1),
  permissions: permissionDeclarationSchema
});

// ── Agent command schemas ──────────────────────────────────────────

export const agentChatSendSchema = z.object({
  clientRequestId: z.string().optional(),
  conversationId: z.string().optional(),
  message: z.string().min(1, "message is required"),
  mode: z.enum(["chat", "agent", "workflow"]).default("agent"),
  attachments: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        type: z.string(),
        sizeBytes: z.number().optional(),
      }),
    )
    .default([]),
});

export const agentChatStopSchema = z.object({
  runId: z.string().min(1, "runId is required"),
});

export const agentConversationSubscribeSchema = z.object({
  conversationId: z.string().min(1),
  lastSeenSequence: z.number().int().min(0).optional(),
});

export const agentRunCancelSchema = z.object({
  runId: z.string().min(1),
});

export const agentRunResumeSchema = z.object({
  runId: z.string().min(1),
});

export const agentRunRetrySchema = z.object({
  runId: z.string().min(1),
});
