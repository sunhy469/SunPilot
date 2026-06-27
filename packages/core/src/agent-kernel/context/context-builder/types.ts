import type { AttachmentRef } from "../../loop-types.js";
import type { AgentEventBus } from "../../agent-event-bus.js";
import type { SummaryStaleDetector } from "../summary-stale-detector.js";

/**
 * Metrics collected during memory retrieval (§P3 — observability).
 *
 * Records timing and counts for each pipeline stage so operators
 * can monitor retrieval quality and diagnose performance regressions.
 */
export interface MemoryRetrievalMetrics {
  /** Number of memories from initial hybrid search. */
  initialHybridCount: number;
  /** Number of memories from vector-only recall. */
  vectorRecallCount: number;
  /** Total after dedup and merge of initial passes. */
  initialTotalCount: number;
  /** Whether multi-hop retrieval was attempted. */
  multiHopAttempted: boolean;
  /** Number of memories added by multi-hop expansion. */
  multiHopAddedCount: number;
  /** Multi-hop stage duration in milliseconds. */
  multiHopDurationMs: number;
  /** Whether query expansion was attempted. */
  queryExpansionAttempted: boolean;
  /** Number of expansion queries issued. */
  expansionQueryCount: number;
  /** Number of memories added by query expansion. */
  expansionAddedCount: number;
  /** Query expansion stage duration in milliseconds. */
  expansionDurationMs: number;
  /** Whether re-ranking was applied. */
  rerankApplied: boolean;
  /** Number of candidates before re-ranking. */
  rerankCandidateCount: number;
  /** Reranking stage duration in milliseconds. */
  rerankDurationMs: number;
  /** Number of memories after all stages (before compression). */
  finalCount: number;
  /** Number of memories after token budget trimming. */
  includedCount: number;
  /** Total memory retrieval wall-clock duration in milliseconds. */
  totalMemorySearchMs: number;
  /** Feature flags snapshot at retrieval time. */
  featureFlags: {
    multiHop: boolean;
    queryExpansion: boolean;
    mmrRerank: boolean;
  };
}

export interface ContextBuilderDeps {
  /** Fetch conversation messages for the given conversation. */
  listMessages: (
    conversationId: string,
    limit?: number,
  ) => Promise<
    Array<{
      id: string;
      role: string;
      content: string;
      attachments?: AttachmentRef[];
      createdAt: string;
    }>
  >;
  /** Vector similarity search for messages relevant to a query embedding.
   *  Uses pgvector cosine distance to find semantically similar messages.
   *  Falls back gracefully when no embedding provider is available. */
  searchMessages?: (
    conversationId: string,
    embedding: number[],
    limit: number,
  ) => Promise<
    Array<{
      id: string;
      role: string;
      content: string;
      attachments?: AttachmentRef[];
      createdAt: string;
    }>
  >;
  /** Fetch relevant memories with scope-aware isolation. */
  searchMemories?: (input: {
    query: string;
    runId: string;
    conversationId: string;
    userId?: string;
    limit?: number;
    /** Optional embedding vector for pure semantic (no-ILIKE) recall. */
    embedding?: number[];
    /** Filter by memory types (e.g. ["conversation_summary"]). */
    types?: string[];
    /** Filter by scopes (e.g. ["conversation"]). */
    scopes?: string[];
    /** Current step ID for scope-aware search. */
    stepId?: string;
  }) => Promise<
    Array<{
      id: string;
      type: string;
      title: string;
      content: string;
      source: string;
      confidence: number;
      scope?: string;
      scopeId?: string;
      score?: number;
      metadata?: Record<string, unknown>;
    }>
  >;
  /** List available skills. */
  listSkills?: () => Promise<
    Array<{
      id: string;
      name: string;
      description: string;
      category: string;
    }>
  >;
  /** Fetch artifacts related to the current run. */
  listArtifacts?: (runId: string) => Promise<
    Array<{
      id: string;
      name: string;
      type: string;
      summary?: string;
    }>
  >;
  /** Fetch recent tool results related to the current run. */
  listToolResults?: (runId: string) => Promise<
    Array<{
      toolCallId: string;
      name?: string;
      skillId?: string;
      status: string;
      summary?: string;
      content?: string;
      structured?: Record<string, unknown>;
    }>
  >;
  /** System prompt personas and rules. */
  systemPrompt?: {
    persona?: string;
    rules?: string[];
  };
  /** Safety policy rules. */
  safetyRules?: string[];
  /** Maximum tokens for the context window. */
  maxContextTokens?: number;
  /** Reserved tokens for model output. */
  reservedOutputTokens?: number;
  /** Generate an embedding vector for the given text (best-effort). */
  embedText?: (text: string) => Promise<number[]>;
  /** Summary stale detector — checks if conversation summaries need regeneration. */
  staleDetector?: SummaryStaleDetector;
  /** §P2-1: Event bus for emitting agent.error on critical source failures. */
  eventBus?: AgentEventBus;
  /** Optional memory re-ranker for improving retrieval quality (MMR / LLM). */
  memoryReranker?: import("../memory-reranker.js").MemoryReranker;
  /** Optional multi-hop retriever for relation-based memory expansion. */
  multiHopRetriever?: import("../multi-hop-retriever.js").MultiHopRetriever;
  /** Optional query expander for improving recall on short queries. */
  queryExpander?: import("../query-expander.js").QueryExpander;
  /** Callback for finding related memories (used by multi-hop). */
  findRelatedMemories?: (memoryId: string, relation?: string, limit?: number) => Promise<Array<{ id: string; type?: string; title?: string; content?: string; source?: string; confidence?: number; scope?: string; scopeId?: string; score?: number }>>;
  /** Current step ID for scope-aware retrieval. */
  stepId?: string;
  /** §7.4: Optional LLM summarizer for high-value memory compression.
   * When provided, memories of type user_preference / project_profile that
   * exceed the compression threshold are summarized via LLM instead of
   * truncated, preserving semantic content. */
  summarizeMemory?: (content: string, maxChars: number) => Promise<string>;
}
