import type {
  ApprovalRepository,
  ArtifactRepository,
  AuditRepository,
  ConversationRepository,
  EventRepository,
  JobRepository,
  MemoryRepository,
  MessageRepository,
  RunRepository,
  SkillRepository,
  SettingRepository,
  StepRepository,
  WorkflowRepository
} from "../repositories/index.js";

export interface DatabaseContext {
  conversations: ConversationRepository;
  messages: MessageRepository;
  runs: RunRepository;
  events: EventRepository;
  steps: StepRepository;
  approvals: ApprovalRepository;
  artifacts: ArtifactRepository;
  memory: MemoryRepository;
  settings: SettingRepository;
  audit: AuditRepository;
  jobs: JobRepository;
  workflows: WorkflowRepository;
  skills: SkillRepository;
  close(): Promise<void>;
}
