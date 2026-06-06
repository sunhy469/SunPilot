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
  mode: z.enum(['chat', 'agent', 'workflow']).default('agent'),
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

export const runCreateSchema = z.object({
  input: z.unknown().default({}),
  workflowId: z.string().optional(),
  mode: z.enum(['chat', 'plan', 'auto', 'approval_required', 'dry_run']).default('approval_required'),
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
});

// ── Command interfaces ───────────────────────────────────────────────

export interface ChatSendParams {
  clientRequestId?: string;
  conversationId?: string;
  message: string;
  mode: 'chat' | 'agent' | 'workflow';
  attachments: Array<{
    id: string;
    name: string;
    type: string;
    sizeBytes?: number;
  }>;
}

export interface ChatStopParams {
  runId: string;
}

export interface ChatSendResult {
  accepted: boolean;
  conversationId: string;
  runId: string;
  messageId: string;
}

export interface ChatStopResult {
  stopped: boolean;
  runId: string;
}

export interface CreateRunParams {
  input?: unknown;
  workflowId?: string;
  mode?: 'chat' | 'plan' | 'auto' | 'approval_required' | 'dry_run';
}

export interface ConversationSubscribeParams {
  conversationId: string;
  lastSeenSequence?: number;
}

export interface ConversationSubscribeResult {
  subscribed: boolean;
  conversationId: string;
  replayed: number;
  latestSequence: number;
}

export interface RunSubscribeParams {
  runId?: string;
}

export interface RunSubscribeResult {
  runId: string;
  events: unknown[];
}

/** Connection context available to every command handler. */
export interface ClientConnectionContext {
  source: 'web' | 'cli' | 'api';
  connectionId: string;
  userId?: string;
  ip?: string;
  userAgent?: string;
}
