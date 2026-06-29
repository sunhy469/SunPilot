export type IdempotencyStatus = "processing" | "completed" | "failed";

export interface IdempotencyRecord {
  id: string;
  userId?: string;
  method: string;
  clientRequestId: string;
  requestHash: string;
  response?: unknown;
  error?: unknown;
  status: IdempotencyStatus;
  createdAt: string;
  expiresAt?: string;
}

export interface ReserveIdempotencyInput {
  id?: string;
  userId?: string;
  method: string;
  clientRequestId: string;
  requestHash: string;
  initialResponse?: unknown;
  expiresAt?: string;
}

export interface IdempotencyRepository {
  reserve(input: ReserveIdempotencyInput): Promise<{
    inserted: boolean;
    record: IdempotencyRecord;
  }>;
  complete(id: string, response: unknown): Promise<IdempotencyRecord | null>;
  fail(id: string, error: unknown): Promise<IdempotencyRecord | null>;
  /** Release a preparation-stage reservation before background work starts. */
  release(id: string): Promise<boolean>;
  findByKey(input: {
    userId?: string;
    method: string;
    clientRequestId: string;
  }): Promise<IdempotencyRecord | null>;
  /** §F5: delete expired in-flight reservations so they stop blocking retries. */
  cleanupExpired(): Promise<number>;
}
