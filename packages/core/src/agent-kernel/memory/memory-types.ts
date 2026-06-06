import type {
  MemoryRecord,
  MemoryScope,
  MemorySearchInput,
  MemoryType,
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
