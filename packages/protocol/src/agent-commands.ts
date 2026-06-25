/**
 * Agent command types — JSON-RPC method params and results
 * for commands sent from Web/CLI/API to the daemon.
 */

import { z } from 'zod';

// ── Zod schemas ──────────────────────────────────────────────────────

export const chatSendSchema = z.object({
  clientRequestId: z.string().optional(),
  conversationId: z.string().optional(),
  message: z.string().min(1, 'message is required'),
  mode: z.enum(['chat', 'agent']).default('agent'),
  permissionMode: z.enum(['ask', 'auto', 'full']).default('auto'),
  modelId: z.enum(['dp', 'seed']).optional(),
  attachments: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        type: z.string(),
        sizeBytes: z.number().optional(),
        url: z.string().optional(),
        /** Base64-encoded data URL as fallback when no public URL is available. */
        dataUrl: z.string().optional(),
        storageKey: z.string().optional(),
        provider: z.enum(["aliyun-oss", "s3", "minio", "local"]).optional(),
        checksum: z.string().optional(),
      }),
    )
    .default([]),
});

export const chatStopSchema = z.object({
  runId: z.string().min(1, 'runId is required'),
});

export const conversationSubscribeSchema = z.object({
  conversationId: z.string().min(1),
  lastSeenSequence: z.number().int().min(0).optional(),
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
