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
    deploy: ["deployment", "release", "publish", "launch"],
    bug: ["error", "issue", "defect", "problem", "故障"],
    fix: ["resolve", "repair", "fix", "修复"],
    config: ["configuration", "settings", "setup", "配置"],
    test: ["testing", "verify", "validate", "测试"],
    build: ["compile", "construct", "构建"],
    db: ["database", "postgres", "数据库"],
    api: ["endpoint", "interface", "接口"],
    error: ["failure", "crash", "exception", "错误"],
    slow: ["performance", "latency", "lag", "慢"],
    memory: ["remember", "recall", "记忆"],
    skill: ["capability", "tool", "plugin", "技能"],
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
