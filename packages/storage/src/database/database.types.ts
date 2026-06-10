import type {
  ApprovalRepository,
  ArtifactRepository,
  AuditRepository,
  ConversationRepository,
  EventRepository,
  IdempotencyRepository,
  MemoryRepository,
  MessageRepository,
  ModelCallRepository,
  RunRepository,
  RunStatusHistoryRepository,
  SkillRepository,
  SettingRepository,
  StepRepository,
  ToolCallRepository,
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
  transaction?<T>(work: (database: DatabaseContext) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
