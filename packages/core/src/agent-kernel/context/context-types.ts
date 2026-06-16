import type { AttachmentRef, ContextMessage } from '../loop-types.js';

/**
 * ContextChunk — an auditable piece of context with source tracking.
 * Each chunk has provenance metadata for debugging and token budgeting.
 */
/** Trust level for context content provenance (§P2-7). */
export type TrustLevel =
  | 'system'        // System rules, safety policy — authoritative
  | 'user'          // User messages — trusted
  | 'memory'        // Recalled memories — medium trust
  | 'tool'          // Tool results — variable trust
  | 'external'      // Web content, parsed attachments — untrusted
  | 'untrusted';    // Flagged by injection detector — blocked

export interface ContextChunk {
  id: string;
  source:
    | 'system'
    | 'current_message'
    | 'conversation_history'
    | 'conversation_summary'
    | 'memory'
    | 'artifact'
    | 'tool_result'
    | 'skill_catalog'
    | 'run_state'
    | 'safety_policy';
  title: string;
  content: string;
  priority: number; // 0 = mandatory, higher = more trimmable
  tokenEstimate: number;
  metadata: Record<string, unknown>;
  createdAt?: string;
  /** Trust provenance (§P2-7). */
  trust?: TrustLevel;
  /** Original source URI (URL, file path, tool call ID). */
  sourceUri?: string;
  /** When this content was generated. */
  generatedAt?: string;
  /** When this content should be considered stale. */
  expiresAt?: string;
  /** Whether this content was blocked by safety. */
  blocked?: boolean;
  /** Warning message to show the model. */
  warning?: string;
  /** Authority level — higher = more authoritative. */
  authority?: number;
}

/**
 * Token allocation strategy per the architecture doc §11.4.
 */
export const DEFAULT_TOKEN_BUDGET: Record<string, number> = {
  system: 0.08,
  current_message: 0.08,
  recent_messages: 0.25,
  memories: 0.15,
  tool_results: 0.15,
  artifact_summaries: 0.1,
  skill_summaries: 0.08,
  run_state: 0.06,
  safety_policy: 0.05,
};

/**
 * Trim priority — lower priority chunks are trimmed first.
 * Mandatory chunks have priority 0 and are never trimmed.
 */
export const TRIM_ORDER: ContextChunk['source'][] = [
  'memory',                // low-relevance memories first
  'tool_result',           // old tool results
  'artifact',              // old artifact summaries
  'conversation_history',  // older raw messages (trimmed before summaries)
  'conversation_summary',  // compressed history (more token-efficient)
  'skill_catalog',         // long skill descriptions
];

export const MANDATORY_SOURCES: Set<ContextChunk['source']> = new Set([
  'system',
  'current_message',
  'safety_policy',
  'run_state',
]);

/** Rough token estimate: ~4 chars per token for English text. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
