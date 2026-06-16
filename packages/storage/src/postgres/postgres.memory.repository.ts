import type {
  MemoryRecord,
  MemoryScope,
  MemorySearchInput,
  RetrievedMemoryRecord,
} from "@sunpilot/protocol";
import type {
  ListMemoryInput,
  MemoryRepository,
  UpdateMemoryInput,
} from "../repositories/memory.repository.js";
import type { PostgresPool } from "./postgres.client.js";

const MEMORY_COLUMNS = `
  id, run_id, step_id, key, value, scope, scope_id, type, title, content,
  summary, source, confidence, importance, metadata, created_at, updated_at,
  last_accessed_at, expires_at, superseded_by, deleted_at
`;

export class PostgresMemoryRepository implements MemoryRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: MemoryRecord): Promise<MemoryRecord> {
    const normalized = normalizeMemoryInput(input);
    const embeddingValue = normalized.embedding?.length
      ? formatVector(normalized.embedding)
      : null;
    const result = await this.pool.query(
      `INSERT INTO memory_metadata (
         id, run_id, step_id, key, value, scope, scope_id, type, title, content,
         summary, source, confidence, importance, metadata, embedding, created_at, updated_at,
         last_accessed_at, expires_at, superseded_by, deleted_at
       ) VALUES (
         $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15::jsonb, $16::vector, $17, $18,
         $19, $20, $21, $22
       )
       RETURNING ${MEMORY_COLUMNS}`,
      [
        normalized.id,
        normalized.runId ?? null,
        normalized.stepId ?? null,
        normalized.key,
        JSON.stringify(normalized.value ?? null),
        normalized.scope,
        normalized.scopeId ?? null,
        normalized.type,
        normalized.title,
        normalized.content,
        normalized.summary ?? null,
        normalized.source,
        normalized.confidence,
        normalized.importance,
        JSON.stringify(normalized.metadata ?? {}),
        embeddingValue,
        normalized.createdAt,
        normalized.updatedAt,
        normalized.lastAccessedAt ?? null,
        normalized.expiresAt ?? null,
        normalized.supersededBy ?? null,
        normalized.deletedAt ?? null,
      ],
    );
    return mapMemory(result.rows[0]);
  }

  async update(
    id: string,
    input: UpdateMemoryInput,
  ): Promise<MemoryRecord | null> {
    const result = await this.pool.query(
      `UPDATE memory_metadata
       SET key = COALESCE($2, key),
           value = COALESCE($3::jsonb, value),
           scope = COALESCE($4, scope),
           scope_id = COALESCE($5, scope_id),
           type = COALESCE($6, type),
           title = COALESCE($7, title),
           content = COALESCE($8, content),
           summary = COALESCE($9, summary),
           source = COALESCE($10, source),
           confidence = COALESCE($11, confidence),
           importance = COALESCE($12, importance),
           metadata = COALESCE($13::jsonb, metadata),
           expires_at = COALESCE($14, expires_at),
           updated_at = NOW()
       WHERE id = $1
       RETURNING ${MEMORY_COLUMNS}`,
      [
        id,
        input.key ?? null,
        input.value === undefined ? null : JSON.stringify(input.value),
        input.scope ?? null,
        input.scopeId ?? null,
        input.type ?? null,
        input.title ?? null,
        input.content ?? null,
        input.summary ?? null,
        input.source ?? null,
        input.confidence ?? null,
        input.importance ?? null,
        input.metadata === undefined ? null : JSON.stringify(input.metadata),
        input.expiresAt ?? null,
      ],
    );
    return result.rows[0] ? mapMemory(result.rows[0]) : null;
  }

  async list(input: ListMemoryInput = {}): Promise<MemoryRecord[]> {
    const { where, values } = buildMemoryWhere(input);
    const result = await this.pool.query(
      `SELECT ${MEMORY_COLUMNS}
       FROM memory_metadata
       ${where}
       ORDER BY created_at DESC
       LIMIT $${values.length + 1}`,
      [...values, input.limit ?? 100],
    );
    return result.rows.map(mapMemory);
  }

  async search(
    input: MemorySearchInput = {},
  ): Promise<RetrievedMemoryRecord[]> {
    const { where, values } = buildMemoryWhere(input);
    const query = input.query?.trim();
    const hasQuery = Boolean(query);
    const hasEmbedding = Array.isArray(input.embedding) && input.embedding.length > 0;

    // ── Scoring ────────────────────────────────────────────────────
    // Hybrid score: keyword (up to 0.45) + semantic (up to 0.45) + quality (0.10)
    // When embedding is available, semantic term dominates pure-vector recall.

    // Embedding index within params
    let paramIdx = values.length;

    const semanticSql = hasEmbedding
      ? `(1 - (embedding <=> $${++paramIdx}::vector)) * 0.45`
      : `0`;
    const keywordSql = hasQuery
      ? `(
          CASE WHEN title ILIKE '%' || $${++paramIdx} || '%' THEN 0.20 ELSE 0 END +
          CASE WHEN summary ILIKE '%' || $${++paramIdx} || '%' THEN 0.15 ELSE 0 END +
          CASE WHEN content ILIKE '%' || $${++paramIdx} || '%' THEN 0.10 ELSE 0 END
        )`
      : `0`;
    // Quality score: importance + confidence + recency decay (§P2-8).
    // Recency: ~30-day half-life, weight decays linearly.
    // Contradicted/superseded memories are filtered by WHERE, so no penalty needed here.
    const qualitySql =
      `(COALESCE(importance, 0) * 0.15 + COALESCE(confidence, 0) * 0.10 + GREATEST(0, 1 - EXTRACT(EPOCH FROM (NOW() - COALESCE(updated_at, created_at))) / 2592000) * 0.10)`;
    const scoreSql = `(${keywordSql} + ${semanticSql} + ${qualitySql})`;

    // ── Query filtering ─────────────────────────────────────────────
    // When a text query is provided, ILIKE acts as a pre-filter for
    // lexical relevance. When ONLY embedding is provided (pure vector
    // recall), skip the ILIKE constraint so semantic results surface.
    // When embedding is available alongside a query, use hybrid: ILIKE
    // pre-filters the candidate set but vector score still contributes.
    const params: unknown[] = [...values];
    let queryClause = where;

    if (hasEmbedding) {
      params.push(formatVector(input.embedding!));
    }
    if (hasQuery) {
      params.push(query);
      queryClause = `${where ? `${where} AND` : "WHERE"} (title ILIKE '%' || $${params.length} || '%' OR summary ILIKE '%' || $${params.length} || '%' OR content ILIKE '%' || $${params.length} || '%' OR key ILIKE '%' || $${params.length} || '%' OR value::text ILIKE '%' || $${params.length} || '%')`;
    }
    // When only embedding (no text query), no ILIKE pre-filter —
    // pure vector recall based on cosine similarity.

    // ── Relevance (for display/debug) ───────────────────────────────
    const relevanceSql = hasQuery
      ? `(
          CASE WHEN title ILIKE '%' || $${params.length} || '%' THEN 1 ELSE 0 END +
          CASE WHEN summary ILIKE '%' || $${params.length} || '%' THEN 0.7 ELSE 0 END +
          CASE WHEN content ILIKE '%' || $${params.length} || '%' THEN 0.5 ELSE 0 END +
          CASE WHEN key ILIKE '%' || $${params.length} || '%' THEN 0.4 ELSE 0 END
        )`
      : hasEmbedding
        ? `(1 - (embedding <=> $1::vector))`
        : `0`;

    const limit = input.limit ?? 10;
    params.push(limit);

    const result = await this.pool.query(
      `SELECT ${MEMORY_COLUMNS}, ${scoreSql} AS score, ${relevanceSql} AS relevance
       FROM memory_metadata
       ${queryClause}
       ORDER BY score DESC, updated_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(mapRetrievedMemory);
  }

  async markAccessed(
    id: string,
    accessedAt = new Date().toISOString(),
  ): Promise<void> {
    await this.pool.query(
      "UPDATE memory_metadata SET last_accessed_at = $1, updated_at = NOW() WHERE id = $2",
      [accessedAt, id],
    );
  }

  async supersede(id: string, supersededBy: string): Promise<void> {
    await this.pool.query(
      "UPDATE memory_metadata SET superseded_by = $1, updated_at = NOW() WHERE id = $2",
      [supersededBy, id],
    );
  }

  async softDelete(
    id: string,
    reason: string,
    deletedAt = new Date().toISOString(),
  ): Promise<void> {
    await this.pool.query(
      `UPDATE memory_metadata
       SET deleted_at = $1,
           updated_at = NOW(),
           metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{deleteReason}', to_jsonb($2::text), true)
       WHERE id = $3`,
      [deletedAt, reason, id],
    );
  }
}

function buildMemoryWhere(input: MemorySearchInput): {
  where: string;
  values: unknown[];
} {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (!input.includeDeleted) clauses.push("deleted_at IS NULL");
  clauses.push("(expires_at IS NULL OR expires_at > NOW())");
  clauses.push("superseded_by IS NULL");

  if (input.runId) {
    values.push(input.runId);
    clauses.push(`run_id = $${values.length}`);
  }
  if (input.key) {
    values.push(input.key);
    clauses.push(`key = $${values.length}`);
  }
  if (input.types?.length) {
    values.push(input.types);
    clauses.push(`type = ANY($${values.length})`);
  }

  const visibleScopes = visibleScopeClauses(input, values);
  if (visibleScopes.length > 0) {
    clauses.push(`(${visibleScopes.join(" OR ")})`);
  } else if (input.scopes?.length) {
    clauses.push("FALSE");
  }

  return {
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

function visibleScopeClauses(
  input: MemorySearchInput,
  values: unknown[],
): string[] {
  const scopes = new Set<MemoryScope>(
    input.scopes ?? ["global", "user", "project", "conversation", "run"],
  );
  const clauses: string[] = [];

  if (scopes.has("global")) clauses.push("scope = 'global'");
  if (scopes.has("user") && input.userId) {
    values.push(input.userId);
    clauses.push(`(scope = 'user' AND scope_id = $${values.length})`);
  }
  if (scopes.has("project") && input.projectId) {
    values.push(input.projectId);
    clauses.push(`(scope = 'project' AND scope_id = $${values.length})`);
  }
  if (scopes.has("conversation") && input.conversationId) {
    values.push(input.conversationId);
    clauses.push(`(scope = 'conversation' AND scope_id = $${values.length})`);
  }
  if (scopes.has("run") && input.runId) {
    values.push(input.runId);
    clauses.push(`(scope = 'run' AND scope_id = $${values.length})`);
  }

  return clauses;
}

function normalizeMemoryInput(
  input: MemoryRecord,
): Required<
  Pick<MemoryRecord, "id" | "key" | "value" | "metadata" | "createdAt">
> &
  MemoryRecord {
  const content = input.content ?? stringifyMemoryValue(input.value);
  const title = input.title ?? input.key;
  const scope = input.scope ?? (input.runId ? "run" : "global");
  return {
    ...input,
    key: input.key,
    value: input.value,
    scope,
    scopeId: input.scopeId ?? (scope === "run" ? input.runId : undefined),
    type: input.type ?? "manual_note",
    title,
    content,
    summary: input.summary ?? content,
    source: input.source ?? "runtime",
    confidence: input.confidence ?? 0.8,
    importance: input.importance ?? 0.5,
    metadata: input.metadata ?? {},
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
  };
}

function stringifyMemoryValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

function mapMemory(row: any): MemoryRecord {
  return {
    id: row.id,
    runId: row.run_id ?? undefined,
    stepId: row.step_id ?? undefined,
    key: row.key,
    value: row.value,
    scope: row.scope ?? undefined,
    scopeId: row.scope_id ?? undefined,
    type: row.type ?? undefined,
    title: row.title ?? undefined,
    content: row.content ?? undefined,
    summary: row.summary ?? undefined,
    source: row.source ?? undefined,
    confidence:
      row.confidence === null || row.confidence === undefined
        ? undefined
        : Number(row.confidence),
    importance:
      row.importance === null || row.importance === undefined
        ? undefined
        : Number(row.importance),
    metadata: row.metadata ?? {},
    createdAt: toIsoRequired(row.created_at),
    updatedAt: toIso(row.updated_at),
    lastAccessedAt: toIso(row.last_accessed_at),
    expiresAt: toIso(row.expires_at),
    supersededBy: row.superseded_by ?? undefined,
    deletedAt: toIso(row.deleted_at),
  };
}

function mapRetrievedMemory(row: any): RetrievedMemoryRecord {
  return {
    ...mapMemory(row),
    score: Number(row.score ?? 0),
    relevance: Number(row.relevance ?? 0),
  };
}

function toIsoRequired(value: unknown): string {
  return toIso(value) ?? new Date().toISOString();
}

function toIso(value: unknown): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Format a number array as a pgvector-compatible string literal: '[1,2,3]' */
function formatVector(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
