import type {
  AgentTraceRepository,
  ApprovalRepository,
  ArtifactRepository,
  AuditRepository,
  ConversationRepository,
  DigitalBeingRepository,
  EventRepository,
  IdempotencyRepository,
  MemoryRepository,
  MessageRepository,
  ModelCallRepository,
  PlanSnapshotRepository,
  RunRepository,
  RunStatusHistoryRepository,
  SkillRepository,
  SettingRepository,
  StepRepository,
  ToolCallRepository,
  WorldActionLogRepository,
  WorldActionRepository,
  WorldArtifactRepository,
  WorldEdgeRepository,
  WorldNodeRepository,
  WorldTaskRepository,
} from "../repositories/index.js";

export interface DatabaseContext {
  conversations: ConversationRepository;
  messages: MessageRepository;
  modelCalls: ModelCallRepository;
  runs: RunRepository;
  runStatusHistory: RunStatusHistoryRepository;
  events: EventRepository;
  steps: StepRepository;
  toolCalls: ToolCallRepository;
  approvals: ApprovalRepository;
  artifacts: ArtifactRepository;
  memory: MemoryRepository;
  settings: SettingRepository;
  audit: AuditRepository;
  idempotency: IdempotencyRepository;
  skills: SkillRepository;
  digitalBeings: DigitalBeingRepository;
  worldNodes: WorldNodeRepository;
  worldEdges: WorldEdgeRepository;
  worldTasks: WorldTaskRepository;
  worldActions: WorldActionRepository;
  worldActionLogs: WorldActionLogRepository;
  worldArtifacts: WorldArtifactRepository;
  /** Optional — agent trace persistence (§P0-2). */
  agentTraces?: AgentTraceRepository;
  /** Optional — plan snapshot persistence (§P0-2). */
  planSnapshots?: PlanSnapshotRepository;
  transaction?<T>(work: (database: DatabaseContext) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
