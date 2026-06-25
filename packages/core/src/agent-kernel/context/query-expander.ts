/**
 * QueryExpander — generates alternative search queries to improve recall.
 *
 * When initial retrieval returns too few results (< 3), generates
 * 2-3 variations of the original query (synonyms, rephrasing) to
 * catch memories with different phrasing.
 */

export interface QueryExpander {
  expand(query: string): Promise<string[]>;
}

/**
 * SimpleQueryExpander — rule-based query expansion without LLM.
 *
 * Used when no LLM provider is available. Applies basic
 * synonym/word-form expansions for common terms.
 */
export class SimpleQueryExpander implements QueryExpander {
  private readonly synonyms: Record<string, string[]> = {
    // ── Deployment & release ───────────────────────────────────────
    deploy: ["deployment", "release", "publish", "launch", "ship", "rollout"],
    release: ["deploy", "publish", "launch", "ship", "rollout"],
    publish: ["deploy", "release", "launch"],
    launch: ["deploy", "release", "start", "begin"],

    // ── Bugs & errors ──────────────────────────────────────────────
    bug: ["error", "issue", "defect", "problem", "故障", "flaw", "glitch", "malfunction"],
    error: ["failure", "crash", "exception", "错误", "bug", "fault", "malfunction"],
    crash: ["failure", "error", "exception", "panic", "outage"],
    exception: ["error", "crash", "failure", "fault"],
    issue: ["bug", "problem", "defect", "ticket", "flaw"],

    // ── Fixing & resolving ─────────────────────────────────────────
    fix: ["resolve", "repair", "修复", "patch", "correct", "remedy", "address"],
    resolve: ["fix", "repair", "solve", "address", "handle"],
    patch: ["fix", "update", "hotfix", "remedy"],
    repair: ["fix", "resolve", "restore", "recover"],

    // ── Configuration & settings ───────────────────────────────────
    config: ["configuration", "settings", "setup", "配置", "options", "preferences", "parameters"],
    configuration: ["config", "settings", "setup", "options", "parameters"],
    settings: ["config", "configuration", "options", "preferences", "parameters"],
    setup: ["config", "configuration", "install", "initialize", "bootstrap"],

    // ── Testing & validation ───────────────────────────────────────
    test: ["testing", "verify", "validate", "测试", "check", "exam", "inspect"],
    testing: ["test", "verify", "validate", "check", "qa", "quality"],
    verify: ["validate", "test", "check", "confirm", "ensure"],
    validate: ["verify", "test", "check", "confirm", "sanitize"],

    // ── Building & compilation ────────────────────────────────────
    build: ["compile", "construct", "构建", "assemble", "package", "bundle", "transpile"],
    compile: ["build", "construct", "transpile", "assemble"],
    package: ["build", "bundle", "archive", "containerize"],

    // ── Databases & storage ─────────────────────────────────━━━━━━━
    db: ["database", "postgres", "数据库", "storage", "datastore", "schema"],
    database: ["db", "postgres", "storage", "datastore", "rdbms", "sql"],
    storage: ["database", "db", "disk", "persistence", "filesystem", "volume"],
    cache: ["caching", "redis", "memcached", "buffer", "store"],
    query: ["search", "lookup", "retrieve", "fetch", "select", "find"],
    migration: ["migrate", "schema", "upgrade", "transition", "transform"],

    // ── APIs & services ────────────────────────────────────────────
    api: ["endpoint", "interface", "接口", "service", "route", "handler", "gateway"],
    endpoint: ["api", "route", "url", "service", "interface", "handler"],
    service: ["api", "endpoint", "microservice", "server", "daemon", "worker"],
    rest: ["api", "http", "endpoint", "service"],
    gateway: ["api", "proxy", "router", "ingress", "loadbalancer"],

    // ── Performance & reliability ──────────────────────────────────
    slow: ["performance", "latency", "lag", "慢", "sluggish", "bottleneck", "delay"],
    performance: ["speed", "latency", "throughput", "efficiency", "optimization", "fast"],
    latency: ["delay", "lag", "slow", "response time", "wait"],
    throughput: ["performance", "bandwidth", "capacity", "rate", "volume"],
    scale: ["scaling", "scalability", "expand", "grow", "autoscale"],
    optimize: ["optimization", "improve", "tune", "enhance", "refine", "streamline"],

    // ── Monitoring & observability ─────────────────────────────────
    monitor: ["monitoring", "observe", "track", "watch", "metrics", "telemetry", "alert"],
    log: ["logging", "logs", "trace", "record", "journal", "audit"],
    metrics: ["monitoring", "telemetry", "stats", "measurements", "kpi"],
    alert: ["alarm", "notify", "warn", "notification", "trigger", "escalation"],
    trace: ["track", "follow", "monitor", "span", "trajectory", "observability"],

    // ── Security & access ──────────────────────────────────────────
    security: ["auth", "secure", "protection", "safety", "encryption", "permission"],
    auth: ["authentication", "authorization", "login", "credentials", "token", "session", "oauth"],
    authentication: ["auth", "login", "credentials", "identity", "verify"],
    authorization: ["auth", "permission", "access", "role", "privilege", "policy"],
    token: ["key", "credential", "secret", "jwt", "bearer", "session"],
    encrypt: ["encryption", "decrypt", "cipher", "hash", "encode", "secure"],
    secret: ["credential", "token", "key", "password", "sensitive"],

    // ── Infrastructure & DevOps ────────────────────────────────────
    container: ["docker", "podman", "image", "sandbox", "isolate", "runtime"],
    cluster: ["集群", "nodes", "group", "pool", "fleet", "swarm"],
    node: ["instance", "server", "machine", "host", "worker", "member"],
    instance: ["node", "server", "machine", "host", "vm", "container"],
    pipeline: ["流水线", "workflow", "ci/cd", "automation", "stages", "process"],
    orchestrate: ["orchestration", "coordinate", "manage", "调度", "automate", "arrange"],
    schedule: ["scheduling", "cron", "timer", "trigger", "plan", "queue", "dispatch"],
    trigger: ["fire", "invoke", "activate", "initiate", "start", "launch", "dispatch"],

    // ── Data & messaging ───────────────────────────────────────────
    queue: ["排队", "buffer", "pipe", "channel", "broker", "message queue"],
    stream: ["流", "pipeline", "flow", "channel", "reactive", "event"],
    batch: ["批量", "bulk", "group", "chunk", "aggregate", "mass"],
    event: ["事件", "message", "notification", "signal", "trigger", "hook"],
    message: ["消息", "event", "notification", "signal", "communication", "data"],

    // ── Memory & context ───────────────────────────────────────────
    memory: ["remember", "recall", "记忆", "context", "retention", "storage"],
    remember: ["memory", "recall", "retain", "保存", "store", "persist"],
    context: ["contextual", "background", "setting", "environment", "circumstance"],
    skill: ["capability", "tool", "plugin", "技能", "ability", "function", "extension"],
    tool: ["skill", "plugin", "extension", "utility", "function", "capability"],

    // ── Project & workflow ─────────────────────────────────────────
    project: ["project", "app", "application", "repo", "codebase", "repository"],
    workflow: ["process", "pipeline", "automation", "flow", "procedure", "routine"],
    task: ["job", "work", "assignment", "action", "operation", "step"],
    job: ["task", "work", "process", "operation", "execution", "run"],

    // ── General DevOps ─────────────────────────────────────────────
    backup: ["restore", "snapshot", "save", "archive", "copy", "replicate"],
    restore: ["backup", "recover", "rollback", "revert", "reinstate"],
    rollback: ["revert", "restore", "undo", "backtrack", "regression"],
    dependency: ["dependencies", "依赖", "requirement", "prerequisite", "library", "module"],
    environment: ["env", "context", "surroundings", "setup", "platform", "ecosystem"],
    cleanup: ["clean", "purge", "remove", "delete", "wipe", "clear", "tidy"],
    retry: ["retries", "reattempt", "replay", "repeat", "again", "backoff"],
    timeout: ["expire", "deadline", "limit", "ttl", "threshold"],
    health: ["healthy", "status", "check", "liveness", "readiness", "probe"],
  };

  async expand(query: string): Promise<string[]> {
    const lower = query.toLowerCase();
    const words = lower.split(/\s+/);
    const expanded = new Set<string>([query]);

    for (const word of words) {
      const syns = this.synonyms[word];
      if (syns) {
        for (const syn of syns) {
          // Escape regex special chars in the word to prevent injection
          const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          expanded.add(query.replace(new RegExp(escaped, "gi"), syn));
        }
      }
    }

    // Also add just the keyword pairings
    for (const word of words) {
      if (word.length > 2) expanded.add(word);
    }

    return [...expanded].slice(0, 4); // max 4 variants
  }
}
