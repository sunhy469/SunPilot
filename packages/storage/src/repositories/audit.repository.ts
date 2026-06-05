export interface AuditRecord {
  id: string;
  runId?: string;
  stepId?: string;
  actor: string;
  action: string;
  target: string;
  risk?: string;
  payload: unknown;
  createdAt: string;
}

export interface CreateAuditInput {
  id?: string;
  runId?: string;
  stepId?: string;
  actor: string;
  action: string;
  target: string;
  risk?: string;
  payload: unknown;
  createdAt?: string;
}

export interface AuditRepository {
  create(input: CreateAuditInput): Promise<AuditRecord>;
  list(runId?: string): Promise<AuditRecord[]>;
}
