import { z } from "zod";
import {
  MEMORY_SCOPES,
  MEMORY_TYPES,
  RUN_MODES,
  RUN_STATUSES,
} from "@sunpilot/protocol";

export const listRunsQuerySchema = z.object({
  status: z.enum(RUN_STATUSES).optional(),
  mode: z.enum(RUN_MODES).optional(),
  conversationId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  cursor: z.string().optional(),
});

export const memorySearchQuerySchema = z.object({
  query: z.string().optional(),
  runId: z.string().optional(),
  key: z.string().optional(),
  userId: z.string().optional(),
  projectId: z.string().optional(),
  conversationId: z.string().optional(),
  scope: z.enum(MEMORY_SCOPES).optional(),
  type: z.enum(MEMORY_TYPES).optional(),
  includeDeleted: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export const memoryCreateBodySchema = z.object({
  id: z.string().optional(),
  runId: z.string().optional(),
  stepId: z.string().optional(),
  key: z.string().min(1, "key is required"),
  value: z.unknown().optional(),
  scope: z.enum(MEMORY_SCOPES).optional(),
  scopeId: z.string().optional(),
  type: z.enum(MEMORY_TYPES).optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  summary: z.string().optional(),
  source: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  importance: z.number().min(0).max(1).optional(),
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  expiresAt: z.string().optional(),
});

export const memoryUpdateBodySchema = z.object({
  key: z.string().optional(),
  value: z.unknown().optional(),
  scope: z.enum(MEMORY_SCOPES).optional(),
  scopeId: z.string().optional(),
  type: z.enum(MEMORY_TYPES).optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  summary: z.string().optional(),
  source: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  importance: z.number().min(0).max(1).optional(),
  metadata: z.record(z.unknown()).optional(),
  expiresAt: z.string().optional(),
});

export const listConversationsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  cursor: z.string().optional(),
});

export const conversationEventsQuerySchema = z.object({
  afterSequence: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export const listApprovalsQuerySchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "expired"]).optional(),
  runId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export const listAuditLogsQuerySchema = z.object({
  runId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export const uploadPresignBodySchema = z.object({
  fileName: z.string().min(1, "fileName is required"),
  contentType: z.string().default("application/octet-stream"),
  sizeBytes: z.number().positive().optional(),
});

export const updateConversationBodySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
}).refine((d) => d.title !== undefined || d.pinned !== undefined, {
  message: "At least one of title or pinned must be provided",
});

export const createDigitalBeingBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  homeNodeId: z.string().min(1),
  conversationId: z.string().optional(),
});

export const updateDigitalBeingBodySchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  status: z.string().optional(),
  statusText: z.string().optional(),
});

export const createTaskBodySchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  input: z.record(z.unknown()).optional(),
});

export const sleepBeingBodySchema = z.object({
  reason: z.string().optional(),
});
