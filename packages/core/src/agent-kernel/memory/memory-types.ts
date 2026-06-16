import type {
  MemoryRecord,
  MemoryScope,
  MemorySearchInput,
  MemoryType,
  MemoryRelationEntry,
  MemoryQualityScore,
  RetrievedMemoryRecord,
} from "@sunpilot/protocol";
import type {
  AgentContext,
  AgentLoopInput,
  AgentObservation,
  AgentPlan,
  AgentReflection,
  RoutedIntent,
} from "../loop-types.js";

export interface MemoryCandidate {
  key: string;
  title: string;
  content: string;
  summary?: string;
  type: MemoryType;
  scope: MemoryScope;
  scopeId?: string;
  source: string;
  confidence: number;
  importance: number;
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryWriteInput {
  input: AgentLoopInput;
  context: AgentContext;
  intent: RoutedIntent;
  plan?: AgentPlan;
  responseMessageId?: string;
  observation?: AgentObservation;
  reflection?: AgentReflection;
  /** When true, force a conversation summary even if goal is not yet achieved.
   *  Set when token budget is strained or many turns have passed. */
  forceSummary?: boolean;
  /** Rolling summary message range. Tracks which messages are covered
   *  by the summary so ContextBuilder can exclude them from raw history. */
  messageRange?: {
    fromMessageId: string;
    toMessageId: string;
  };
}

export interface MemoryWriteResult {
  written: MemoryRecord[];
  rejected: Array<{ candidate: MemoryCandidate; reason: string }>;
  superseded: Array<{ oldMemoryId: string; newMemoryId: string }>;
}

export interface MemoryRepositoryPort {
  create(input: MemoryRecord): Promise<MemoryRecord>;
  search(input?: MemorySearchInput): Promise<RetrievedMemoryRecord[]>;
  supersede(id: string, supersededBy: string): Promise<void>;
}

export interface SecretScanResult {
  hasSecrets: boolean;
  redactedText: string;
  reasons: string[];
}

export interface SecretRedactor {
  scan(text: string): SecretScanResult;
}

export interface MemoryPolicyDecision {
  action: "create" | "supersede" | "reject";
  reason: string;
  supersedeMemoryId?: string;
  /** When a contradiction is detected, the contradiction details. */
  contradiction?: {
    /** ID of the existing memory that is contradicted. */
    existingId: string;
    /** Source of the existing memory. */
    existingSource: string;
    /** Human-readable reason for the contradiction. */
    reason: string;
  };
}

export interface MemoryPolicy {
  classify(input: {
    candidate: MemoryCandidate;
    secretScan: SecretScanResult;
    similar: RetrievedMemoryRecord[];
  }): MemoryPolicyDecision;
}

export interface MemoryWriter {
  writeFromTurn(input: MemoryWriteInput): Promise<MemoryWriteResult>;
}
