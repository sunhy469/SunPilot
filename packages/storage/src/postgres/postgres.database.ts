import type { DatabaseContext } from "../database/database.types.js";
import { PostgresApprovalRepository } from "./postgres.approval.repository.js";
import { PostgresArtifactRepository } from "./postgres.artifact.repository.js";
import { PostgresAuditRepository } from "./postgres.audit.repository.js";
import { PostgresConversationRepository } from "./postgres.conversation.repository.js";
import type { PostgresPool } from "./postgres.client.js";
import { PostgresEventRepository } from "./postgres.event.repository.js";
import { PostgresJobRepository } from "./postgres.job.repository.js";
import { PostgresMemoryRepository } from "./postgres.memory.repository.js";
import { PostgresMessageRepository } from "./postgres.message.repository.js";
import { PostgresRunRepository } from "./postgres.run.repository.js";
import { PostgresSettingRepository } from "./postgres.setting.repository.js";
import { PostgresSkillRepository } from "./postgres.skill.repository.js";
import { PostgresStepRepository } from "./postgres.step.repository.js";
import { PostgresWorkflowRepository } from "./postgres.workflow.repository.js";

export class PostgresDatabaseContext implements DatabaseContext {
  readonly conversations: PostgresConversationRepository;
  readonly messages: PostgresMessageRepository;
  readonly runs: PostgresRunRepository;
  readonly events: PostgresEventRepository;
  readonly steps: PostgresStepRepository;
  readonly approvals: PostgresApprovalRepository;
  readonly artifacts: PostgresArtifactRepository;
  readonly memory: PostgresMemoryRepository;
  readonly settings: PostgresSettingRepository;
  readonly audit: PostgresAuditRepository;
  readonly jobs: PostgresJobRepository;
  readonly workflows: PostgresWorkflowRepository;
  readonly skills: PostgresSkillRepository;

  constructor(private readonly pool: PostgresPool) {
    this.conversations = new PostgresConversationRepository(pool);
    this.messages = new PostgresMessageRepository(pool);
    this.runs = new PostgresRunRepository(pool);
    this.events = new PostgresEventRepository(pool);
    this.steps = new PostgresStepRepository(pool);
    this.approvals = new PostgresApprovalRepository(pool);
    this.artifacts = new PostgresArtifactRepository(pool);
    this.memory = new PostgresMemoryRepository(pool);
    this.settings = new PostgresSettingRepository(pool);
    this.audit = new PostgresAuditRepository(pool);
    this.jobs = new PostgresJobRepository(pool);
    this.workflows = new PostgresWorkflowRepository(pool);
    this.skills = new PostgresSkillRepository(pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
