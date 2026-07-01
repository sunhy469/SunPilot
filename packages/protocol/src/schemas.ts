import { z } from "zod";
import { AuditActor } from "./audit.js";

const runModeSchema = z.enum(["chat", "agent"]);

export const approvalDecisionSchema = z.object({
  reason: z.string().optional(),
  actor: z.string().default(AuditActor.LocalUser),
});

const skillRiskSchema = z.enum(["low", "medium", "high", "critical"]);
const skillTimeoutPolicySchema = z
  .object({
    defaultMs: z.number().int().positive(),
    maxMs: z.number().int().positive(),
    retryable: z.boolean(),
    maxRetries: z.number().int().min(0),
    backoffMs: z.number().int().min(0),
  })
  .refine((policy) => policy.defaultMs <= policy.maxMs, {
    message: "timeoutPolicy.defaultMs must not exceed maxMs",
    path: ["defaultMs"],
  });

const permissionDeclarationSchema = z.object({
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
        permissions: z.array(z.string()).default([]),
        idempotent: z.boolean().optional(),
        sideEffects: z
          .enum(["none", "readonly", "mutation", "network", "destructive"])
          .optional(),
        timeoutPolicy: skillTimeoutPolicySchema.optional(),
      }),
    )
    .min(1),
  permissions: permissionDeclarationSchema,
  trust: z.enum(["local-trusted", "isolated"]).default("isolated")
});
