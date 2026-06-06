import type { MemoryPolicy, MemoryPolicyDecision } from "./memory-types.js";

export class DefaultMemoryPolicy implements MemoryPolicy {
  classify(input: Parameters<MemoryPolicy["classify"]>[0]): MemoryPolicyDecision {
    const { candidate, secretScan, similar } = input;

    if (secretScan.hasSecrets) {
      return { action: "reject", reason: `contains secret-like content: ${secretScan.reasons.join(", ")}` };
    }
    if (candidate.confidence < 0.45) {
      return { action: "reject", reason: "confidence below memory threshold" };
    }
    if (candidate.importance < 0.35) {
      return { action: "reject", reason: "importance below memory threshold" };
    }
    if (candidate.content.trim().length < 12) {
      return { action: "reject", reason: "content too short for long-term memory" };
    }

    const supersede = similar.find((memory) =>
      memory.type === candidate.type &&
      memory.scope === candidate.scope &&
      (memory.scopeId ?? "") === (candidate.scopeId ?? "") &&
      (memory.relevance >= 0.9 || normalize(memory.title ?? memory.key) === normalize(candidate.title))
    );
    if (supersede) {
      return {
        action: "supersede",
        reason: `supersedes similar memory ${supersede.id}`,
        supersedeMemoryId: supersede.id,
      };
    }

    return { action: "create", reason: candidate.reason };
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
