/**
 * Agent command types — JSON-RPC method params and results
 * for commands sent from Web/CLI/API to the daemon.
 */

import { z } from 'zod';

const MAX_MESSAGE_CHARS = 100_000;
const MAX_INLINE_ATTACHMENT_CHARS = 4 * 1024 * 1024;
const attachmentSchema = z.object({
  id: z.string().trim().min(1).max(256),
  name: z.string().trim().min(1).max(512),
  type: z.string().trim().min(1).max(128),
  sizeBytes: z.number().int().nonnegative().optional(),
  url: z.string().max(4096).optional(),
  dataUrl: z.string().max(MAX_INLINE_ATTACHMENT_CHARS).optional(),
  storageKey: z.string().max(2048).optional(),
  provider: z.enum(["aliyun-oss", "s3", "minio", "local"]).optional(),
  checksum: z.string().max(256).optional(),
});

// ── Zod schemas ──────────────────────────────────────────────────────

export const chatSendSchema = z.object({
  clientRequestId: z.string().max(256).optional(),
  conversationId: z.string().min(1).max(256).optional(),
  message: z.string().max(MAX_MESSAGE_CHARS).default(''),
  mode: z.enum(['chat', 'agent']).default('agent'),
  permissionMode: z.enum(['ask', 'auto', 'full']).default('auto'),
  modelId: z.enum(['dp', 'seed']).optional(),
  attachments: z
    .array(attachmentSchema)
    .max(20)
    .default([]),
}).superRefine((val, ctx) => {
  // Allow attachment-only messages: message may be empty IF at least one
  // attachment is present. A completely empty request (no text, no
  // attachments) is still rejected.
  if (val.message.trim().length === 0 && val.attachments.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['message'],
      message: 'message is required when no attachments are provided',
    });
  }
});

export const chatStopSchema = z.object({
  runId: z.string().min(1, 'runId is required'),
});

export const conversationSubscribeSchema = z.object({
  conversationId: z.string().min(1),
  lastSeenSequence: z.number().int().min(0).optional(),
  /** False when opening persisted history: subscribe to future events only. */
  replayMissedEvents: z.boolean().default(true),
});

export const conversationUnsubscribeSchema = z.object({
  conversationId: z.string().min(1),
});

export const runSubscribeSchema = z.object({
  runId: z.string().optional(),
});

export const runUnsubscribeSchema = z.object({
  runId: z.string().optional(),
});

export const runCancelSchema = z.object({
  runId: z.string().min(1),
});

export const runResumeSchema = z.object({
  runId: z.string().min(1),
  message: z.string().trim().min(1).optional(),
  attachments: z.array(attachmentSchema).max(20).optional(),
});

export const runRetrySchema = z.object({
  runId: z.string().min(1),
});

export const approvalDecideSchema = z.object({
  approvalId: z.string().min(1),
  reason: z.string().optional(),
  actor: z.string().default('local-user'),
  strategy: z
    .enum(['cancel', 'interrupt', 'continue_without_tool'])
    .default('interrupt'),
});

/**
 * Dedicated schema for `approval.reject` params (A12).
 * Distinct from `approvalDecideSchema` so reject-specific validation can
 * evolve independently; reason is optional to preserve backwards
 * compatibility with existing callers that omit it.
 */
export const approvalRejectSchema = z.object({
  approvalId: z.string().min(1),
  reason: z.string().optional(),
  actor: z.string().default('local-user'),
  strategy: z
    .enum(['cancel', 'interrupt', 'continue_without_tool'])
    .default('interrupt'),
});

// ── Command interfaces ───────────────────────────────────────────────

export interface ChatSendParams {
  clientRequestId?: string;
  conversationId?: string;
  message: string;
  mode: 'chat' | 'agent';
  /** User-selected permission mode: ask=always approve, auto=risk-based, full=never approve. */
  permissionMode?: 'ask' | 'auto' | 'full';
  /** User-selected chat model. When unset, the default model is used. */
  modelId?: 'dp' | 'seed';
  attachments: Array<{
    id: string;
    name: string;
    type: string;
    sizeBytes?: number;
    url?: string;
    /** Base64-encoded data URL as fallback when no public URL is available. */
    dataUrl?: string;
    storageKey?: string;
    provider?: 'aliyun-oss' | 's3' | 'minio' | 'local';
    checksum?: string;
  }>;
}

export interface ChatStopParams {
  runId: string;
}
