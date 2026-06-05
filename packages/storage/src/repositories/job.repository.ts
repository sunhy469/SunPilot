export interface JobRecord {
  id: string;
  runId: string;
  status: string;
  attempts: number;
  timeoutAt?: string;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface CreateJobInput {
  id: string;
  runId: string;
  status: string;
  attempts?: number;
  timeoutAt?: string;
  payload: unknown;
}

export interface JobRepository {
  create(input: CreateJobInput): Promise<JobRecord>;
  updateStatus(runId: string, status: string, incrementAttempts?: boolean): Promise<void>;
  list(runId?: string): Promise<JobRecord[]>;
  expireTimedOut(now?: string): Promise<string[]>;
}
