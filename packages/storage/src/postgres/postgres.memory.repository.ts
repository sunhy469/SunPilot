import type {
  MemoryRecord,
  MemoryRelationEntry,
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
  summary, source, confidence, importance, metadata, quality_score, quality_metadata,
  created_at, updated_at, last_accessed_at, expires_at, superseded_by, deleted_at,
  stale_reason, stale_since
`;

export class PostgresMemoryRepository implements MemoryRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: MemoryRecord): Promise<MemoryRecord> {
    const normalized = normalizeMemoryInput(input);
    const embeddingValue = normalized.embedding?.length
      ? formatVector(normalized.embedding)
      : null;
    const qualityMetadata = normalized.quality
      ? JSON.stringify(normalized.quality)
      : null;
    const result = await this.pool.query(
      `INSERT INTO memory_metadata (
         id, run_id, step_id, key, value, scope, scope_id, type, title, content,
         summary, source, confidence, importance, metadata, quality_score, quality_metadata,
         embedding, created_at, updated_at, last_accessed_at, expires_at, superseded_by, deleted_at
       ) VALUES (
         $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15::jsonb, $16, $17::jsonb,
         $18::vector, $19, $20, $21, $22, $23, $24
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
        normalized.quality?.score ?? null,
        qualityMetadata,
        embeddingValue,
        normalized.createdAt,
        normalized.updatedAt,
        normalized.lastAccessedAt ?? null,
        normalized.expiresAt ?? null,
        normalized.supersededBy ?? null,
        normalized.deletedAt ?? null,
      ],
    );
    // Persist relations if present
    if (normalized.relations?.length) {
      await this.saveRelations(normalized.id, normalized.relations);
    }
    return mapMemory(result.rows[0]);
  }

  async update(
    id: string,
    input: UpdateMemoryInput,
  ): Promise<MemoryRecord | null> {
    const embeddingValue = input.embedding?.length
      ? formatVector(input.embedding)
      : null;
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
           quality_score = COALESCE($14, quality_score),
           quality_metadata = COALESCE($15::jsonb, quality_metadata),
           embedding = COALESCE($16::vector, embedding),
           expires_at = COALESCE($17, expires_at),
           stale_reason = COALESCE($18, stale_reason),
           stale_since = COALESCE($19, stale_since),
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
        input.qualityScore ?? null,
        input.qualityMetadata === undefined ? null : JSON.stringify(input.qualityMetadata),
        embeddingValue,
        input.expiresAt ?? null,
        input.staleReason ?? null,
        input.staleSince ?? null,
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
      [...values, Number(input.limit ?? 100)],
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
    // Escape ILIKE wildcards in query to prevent them from being interpreted as SQL patterns
    const escapedQuery = query?.replace(/[%_\\]/g, '\\$&');

    // ── Scoring ────────────────────────────────────────────────────
    // Hybrid score: keyword (up to 0.45) + semantic (up to 0.45) + quality (0.10)
    // When embedding is available, semantic term dominates pure-vector recall.

    // Param indices are computed ONCE and never mutated — critical for
    // correctness when WHERE clauses from buildMemoryWhere shift $1..$N.
    // embedding comes first (if present), then query (if present),
    // then limit (always, pushed last).
    const embeddingParamIndex = hasEmbedding ? values.length + 1 : -1;
    const queryParamIndex = hasQuery
      ? values.length + (hasEmbedding ? 1 : 0) + 1
      : -1;

    const semanticSql = hasEmbedding
      ? `(1 - (embedding <=> $${embeddingParamIndex}::vector)) * 0.45`
      : `0`;
    const keywordSql = hasQuery
      ? `(
          CASE WHEN title ILIKE '%' || $${queryParamIndex} || '%' ESCAPE '\\' THEN 0.20 ELSE 0 END +
          CASE WHEN summary ILIKE '%' || $${queryParamIndex} || '%' ESCAPE '\\' THEN 0.15 ELSE 0 END +
          CASE WHEN content ILIKE '%' || $${queryParamIndex} || '%' ESCAPE '\\' THEN 0.10 ELSE 0 END
        )`
      : `0`;
    // Quality score: importance + confidence + recency decay + access decay + scope boost (§P2-8).
    // Recency: ~30-day half-life on content age, weight decays linearly.
    // Access recency: ~10-day half-life on last_accessed_at, boosts frequently-used memories.
    // Scope boost: step-scope +0.15, run-scope +0.10, conversation-scope +0.05.
    // Contradicted/superseded memories are filtered by WHERE, so no penalty needed here.
    // Uses bind parameters to prevent SQL injection (§security-review).
    let scopeBoostSql = "0";
    // Track additional bind param indices for scope boost
    let stepIdParamIdx = -1;
    let runIdParamIdx = -1;
    if (input.stepId) {
      stepIdParamIdx = values.length + (hasEmbedding ? 1 : 0) + (hasQuery ? 1 : 0) + 1;
      runIdParamIdx = stepIdParamIdx + 1;
      scopeBoostSql = `CASE WHEN step_id = $${stepIdParamIdx} THEN 0.15 WHEN run_id = $${runIdParamIdx} THEN 0.10 WHEN scope = 'conversation' THEN 0.05 ELSE 0 END`;
    } else if (input.runId) {
      runIdParamIdx = values.length + (hasEmbedding ? 1 : 0) + (hasQuery ? 1 : 0) + 1;
      scopeBoostSql = `CASE WHEN run_id = $${runIdParamIdx} THEN 0.10 WHEN scope = 'conversation' THEN 0.05 ELSE 0 END`;
    } else if (input.conversationId) {
      scopeBoostSql = `CASE WHEN scope = 'conversation' THEN 0.05 ELSE 0 END`;
    }
    const qualitySql =
      `(COALESCE(importance, 0) * 0.15 + COALESCE(confidence, 0) * 0.10 + ` +
      `GREATEST(0, 1 - EXTRACT(EPOCH FROM (NOW() - COALESCE(updated_at, created_at))) / 2592000) * 0.05 + ` +
      `GREATEST(0, 1 - EXTRACT(EPOCH FROM (NOW() - COALESCE(last_accessed_at, updated_at, created_at))) / 864000) * 0.05 + ` +
      `${scopeBoostSql})`;
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
      params.push(escapedQuery);
      queryClause = `${where ? `${where} AND` : "WHERE"} (title ILIKE '%' || $${queryParamIndex} || '%' ESCAPE '\\' OR summary ILIKE '%' || $${queryParamIndex} || '%' ESCAPE '\\' OR content ILIKE '%' || $${queryParamIndex} || '%' ESCAPE '\\' OR key ILIKE '%' || $${queryParamIndex} || '%' ESCAPE '\\' OR value::text ILIKE '%' || $${queryParamIndex} || '%' ESCAPE '\\')`;
    }
    // When only embedding (no text query), no ILIKE pre-filter —
    // pure vector recall based on cosine similarity.

    // Push scope boost bind parameters (if any)
    if (stepIdParamIdx > 0) {
      params.push(input.stepId ?? null);
      params.push(input.runId ?? null);
    } else if (runIdParamIdx > 0) {
      params.push(input.runId ?? null);
    }

    // ── Relevance (for display/debug) ───────────────────────────────
    const relevanceSql = hasQuery
      ? `(
          CASE WHEN title ILIKE '%' || $${queryParamIndex} || '%' ESCAPE '\\' THEN 1 ELSE 0 END +
          CASE WHEN summary ILIKE '%' || $${queryParamIndex} || '%' ESCAPE '\\' THEN 0.7 ELSE 0 END +
          CASE WHEN content ILIKE '%' || $${queryParamIndex} || '%' ESCAPE '\\' THEN 0.5 ELSE 0 END +
          CASE WHEN key ILIKE '%' || $${queryParamIndex} || '%' ESCAPE '\\' THEN 0.4 ELSE 0 END
        )`
      : hasEmbedding
        ? `(1 - (embedding <=> $${embeddingParamIndex}::vector))`
        : `0`;

    const limit = Number(input.limit ?? 10);
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

  // ── Relations ─────────────────────────────────────────────────────

  async saveRelations(
    memoryId: string,
    relations: MemoryRelationEntry[],
  ): Promise<void> {
    if (!relations.length) return;
    // Batch insert — skip duplicates via ON CONFLICT DO NOTHING
    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < relations.length; i++) {
      const r = relations[i]!;
      const base = i * 7;
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`,
      );
      params.push(
        memoryId,
        r.targetId,
        r.relation,
        new Date().toISOString(),
        r.reason ?? null,
        r.confidence ?? null,
        new Date().toISOString(),
      );
    }
    await this.pool.query(
      `INSERT INTO memory_relations (source_memory_id, target_memory_id, relation, established_at, reason, confidence, created_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (source_memory_id, target_memory_id, relation) DO NOTHING`,
      params,
    );
  }

  async findRelated(
    memoryId: string,
    relation?: string,
    limit = 10,
  ): Promise<RetrievedMemoryRecord[]> {
    // Accept comma-separated relations for multi-type filtering
    const relationFilter = relation
      ? `AND mr.relation = ANY($2::text[])`
      : `AND mr.relation != 'contradicts'`; // Exclude negative relations by default
    const params: unknown[] = [memoryId];
    if (relation) {
      params.push(relation.split(",").map((r) => r.trim()).filter(Boolean));
    }
    params.push(limit);

    const result = await this.pool.query(
      `SELECT DISTINCT m.*, 0.5 AS score, 0.5 AS relevance
       FROM memory_metadata m
       JOIN memory_relations mr ON (
         (mr.source_memory_id = $1 AND mr.target_memory_id = m.id)
         OR (mr.target_memory_id = $1 AND mr.source_memory_id = m.id)
       )
       WHERE m.deleted_at IS NULL
         AND (m.expires_at IS NULL OR m.expires_at > NOW())
         AND m.superseded_by IS NULL
         ${relationFilter}
       ORDER BY mr.established_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(mapRetrievedMemory);
  }

  // ── Pruning ───────────────────────────────────────────────────────

  async hardDeleteOlderThan(
    column: string,
    before: string,
  ): Promise<number> {
    // Validate column to prevent SQL injection
    const allowedColumns = ["deleted_at", "expires_at"];
    if (!allowedColumns.includes(column)) {
      throw new Error(`Invalid pruning column: ${column}`);
    }

    // Delete relations first (CASCADE handles most, but explicit is safer)
    await this.pool.query(
      `DELETE FROM memory_relations
       WHERE source_memory_id IN (
         SELECT id FROM memory_metadata WHERE ${column} IS NOT NULL AND ${column} < $1
       )
       OR target_memory_id IN (
         SELECT id FROM memory_metadata WHERE ${column} IS NOT NULL AND ${column} < $1
       )`,
      [before],
    );

    const result = await this.pool.query(
      `DELETE FROM memory_metadata
       WHERE ${column} IS NOT NULL AND ${column} < $1`,
      [before],
    );
    return result.rowCount ?? 0;
  }

  async hardDeleteSupersededOlderThan(before: string): Promise<number> {
    // superseded_by stores a UUID, so we prune by updated_at when superseded_by IS NOT NULL
    // Delete relations first
    await this.pool.query(
      `DELETE FROM memory_relations
       WHERE source_memory_id IN (
         SELECT id FROM memory_metadata
         WHERE superseded_by IS NOT NULL AND updated_at < $1
       )
       OR target_memory_id IN (
         SELECT id FROM memory_metadata
         WHERE superseded_by IS NOT NULL AND updated_at < $1
       )`,
      [before],
    );

    const result = await this.pool.query(
      `DELETE FROM memory_metadata
       WHERE superseded_by IS NOT NULL AND updated_at < $1`,
      [before],
    );
    return result.rowCount ?? 0;
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
  if (input.stepId) {
    values.push(input.stepId);
    clauses.push(`step_id = $${values.length}`);
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
  if (scopes.has("user")) {
    if (input.userId) {
      values.push(input.userId);
      clauses.push(`(scope = 'user' AND scope_id = $${values.length})`);
    } else {
      clauses.push("scope = 'user'");
    }
  }
  if (scopes.has("project")) {
    if (input.projectId) {
      values.push(input.projectId);
      clauses.push(`(scope = 'project' AND scope_id = $${values.length})`);
    } else {
      clauses.push("scope = 'project'");
    }
  }
  if (scopes.has("conversation")) {
    if (input.conversationId) {
      values.push(input.conversationId);
      clauses.push(`(scope = 'conversation' AND scope_id = $${values.length})`);
    } else {
      clauses.push("scope = 'conversation'");
    }
  }
  if (scopes.has("run")) {
    if (input.runId) {
      values.push(input.runId);
      clauses.push(`(scope = 'run' AND scope_id = $${values.length})`);
    } else {
      clauses.push("scope = 'run'");
    }
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
    quality: row.quality_metadata != null
      ? (typeof row.quality_metadata === "object"
          ? (row.quality_metadata as MemoryRecord["quality"])
          : undefined)
      : undefined,
    createdAt: toIsoRequired(row.created_at),
    updatedAt: toIso(row.updated_at),
    lastAccessedAt: toIso(row.last_accessed_at),
    expiresAt: toIso(row.expires_at),
    supersededBy: row.superseded_by ?? undefined,
    deletedAt: toIso(row.deleted_at),
    staleReason: row.stale_reason ?? undefined,
    staleSince: toIso(row.stale_since),
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
