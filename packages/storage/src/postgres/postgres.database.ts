import type { DatabaseContext } from "../database/database.types.js";
import { PostgresApprovalRepository } from "./postgres.approval.repository.js";
import { PostgresArtifactRepository } from "./postgres.artifact.repository.js";
import { PostgresAuditRepository } from "./postgres.audit.repository.js";
import { PostgresConversationRepository } from "./postgres.conversation.repository.js";
import type { PostgresPool } from "./postgres.client.js";
import { withPostgresTransaction } from "./postgres.transaction.js";
import { PostgresEventRepository } from "./postgres.event.repository.js";
import { PostgresJobRepository } from "./postgres.job.repository.js";
import { PostgresIdempotencyRepository } from "./postgres.idempotency.repository.js";
import { PostgresMemoryRepository } from "./postgres.memory.repository.js";
import { PostgresMessageRepository } from "./postgres.message.repository.js";
import { PostgresModelCallRepository } from "./postgres.model-call.repository.js";
import { PostgresRunRepository } from "./postgres.run.repository.js";
import { PostgresRunStatusHistoryRepository } from "./postgres.run-status-history.repository.js";
import { PostgresSettingRepository } from "./postgres.setting.repository.js";
import { PostgresSkillRepository } from "./postgres.skill.repository.js";
import { PostgresStepRepository } from "./postgres.step.repository.js";
import { PostgresToolCallRepository } from "./postgres.tool-call.repository.js";
import { PostgresWorkflowRepository } from "./postgres.workflow.repository.js";

export class PostgresDatabaseContext implements DatabaseContext {
  readonly conversations: PostgresConversationRepository;
  readonly messages: PostgresMessageRepository;
  readonly modelCalls: PostgresModelCallRepository;
  readonly runs: PostgresRunRepository;
  readonly runStatusHistory: PostgresRunStatusHistoryRepository;
  readonly events: PostgresEventRepository;
  readonly steps: PostgresStepRepository;
  readonly toolCalls: PostgresToolCallRepository;
  readonly approvals: PostgresApprovalRepository;
  readonly artifacts: PostgresArtifactRepository;
  readonly memory: PostgresMemoryRepository;
  readonly settings: PostgresSettingRepository;
  readonly audit: PostgresAuditRepository;
  readonly jobs: PostgresJobRepository;
  readonly idempotency: PostgresIdempotencyRepository;
  readonly workflows: PostgresWorkflowRepository;
  readonly skills: PostgresSkillRepository;

  constructor(
    private readonly pool: PostgresPool,
    private readonly ownsPool = true,
  ) {
    this.conversations = new PostgresConversationRepository(pool);
    this.messages = new PostgresMessageRepository(pool);
    this.modelCalls = new PostgresModelCallRepository(pool);
    this.runs = new PostgresRunRepository(pool);
    this.runStatusHistory = new PostgresRunStatusHistoryRepository(pool);
    this.events = new PostgresEventRepository(pool);
    this.steps = new PostgresStepRepository(pool);
    this.toolCalls = new PostgresToolCallRepository(pool);
    this.approvals = new PostgresApprovalRepository(pool);
    this.artifacts = new PostgresArtifactRepository(pool);
    this.memory = new PostgresMemoryRepository(pool);
    this.settings = new PostgresSettingRepository(pool);
    this.audit = new PostgresAuditRepository(pool);
    this.jobs = new PostgresJobRepository(pool);
    this.idempotency = new PostgresIdempotencyRepository(pool);
    this.workflows = new PostgresWorkflowRepository(pool);
    this.skills = new PostgresSkillRepository(pool);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  async transaction<T>(
    work: (database: DatabaseContext) => Promise<T>,
  ): Promise<T> {
    if (!this.ownsPool) return work(this);
    return withPostgresTransaction(this.pool, (client) =>
      work(
        new PostgresDatabaseContext(client as unknown as PostgresPool, false),
      ),
    );
  }
}
