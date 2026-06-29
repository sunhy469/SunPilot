/**
 * Shared JSON Schema utilities for tool argument validation.
 *
 * §5.5 of agent_1688_attachment_duplicate_streaming_bugfix_plan.md:
 * Unifies anyOf/oneOf disjunction checks previously duplicated between
 * ReAct ToolCallGuard and the defensive execution boundary.
 */

/**
 * Extract anyOf/oneOf branches from a JSON Schema object.
 */
export function getAnyOfBranches(schema: Record<string, unknown>): Array<Record<string, unknown>> {
  const candidates: Array<unknown> = [];
  if (Array.isArray(schema.anyOf)) candidates.push(...schema.anyOf);
  if (Array.isArray(schema.oneOf)) candidates.push(...schema.oneOf);
  return candidates.filter(
    (c): c is Record<string, unknown> => c !== null && typeof c === "object",
  );
}

/**
 * Extract required field names from a JSON Schema.
 *
 * Handles anyOf/oneOf correctly:
 * - If top-level `required` exists → return those fields (they're mandatory).
 * - If no top-level `required` but `anyOf`/`oneOf` exists → return only fields
 *   that are required in ALL branches (intersection).
 * - If neither exists → return all property names (conservative fallback).
 */
export function extractRequiredFields(schema?: Record<string, unknown>): string[] {
  if (!schema) return [];
  const required = schema.required;
  if (Array.isArray(required)) {
    return required.filter((f): f is string => typeof f === "string");
  }

  // Check for anyOf/oneOf branches
  const branches = getAnyOfBranches(schema);
  if (branches.length > 0) {
    const allBranchFields = branches.map(
      (b) => (Array.isArray(b.required) ? b.required.filter((f): f is string => typeof f === "string") : []) as string[],
    );
    if (allBranchFields.length > 0) {
      const intersection = allBranchFields[0]!.filter((field) =>
        allBranchFields.every((bf) => bf.includes(field)),
      );
      return intersection;
    }
    // Branches exist but none have `required` — nothing is universally required
    return [];
  }

  // No top-level required and no anyOf/oneOf — conservative: treat all props as required
  const properties = schema.properties;
  if (properties && typeof properties === "object") {
    return Object.keys(properties);
  }
  return [];
}

/**
 * Find required fields that are missing or empty in the current arguments.
 *
 * anyOf/oneOf-aware. A field is only considered "missing" if:
 * 1. It's in the top-level `required` AND absent, OR
 * 2. It's in ALL anyOf/oneOf branches AND absent (universally required), OR
 * 3. There are no anyOf/oneOf branches (standard required check).
 *
 * Fields that are required in only SOME anyOf/oneOf branches are NOT
 * individually missing — they're part of a disjunctive requirement.
 */
export function findMissingRequired(
  args: Record<string, unknown>,
  schema?: Record<string, unknown>,
): string[] {
  if (!schema) return [];

  // Top-level required always takes precedence
  const topRequired = schema.required;
  if (Array.isArray(topRequired)) {
    return topRequired.filter((field) => {
      if (typeof field !== "string") return false;
      const value = args[field];
      return value === undefined || value === null || value === "";
    });
  }

  // Check anyOf/oneOf branches
  const branches = getAnyOfBranches(schema);
  if (branches.length > 0) {
    const branchRequireds = branches.map(
      (b) => (Array.isArray(b.required) ? b.required.filter((f): f is string => typeof f === "string") : []) as string[],
    );

    // First: check if any branch is fully satisfied
    for (const br of branchRequireds) {
      if (br.length === 0) continue; // empty branch is always satisfied
      const allPresent = br.every((field) => {
        const value = args[field];
        return value !== undefined && value !== null && value !== "";
      });
      if (allPresent) {
        // This branch is satisfied → the disjunction is met → no missing fields
        return [];
      }
    }

    // No branch fully satisfied — return fields required in ALL branches that are absent
    if (branchRequireds.length > 0) {
      const intersection = branchRequireds[0]!.filter((field) =>
        branchRequireds.every((bf) => bf.includes(field)),
      );
      return intersection.filter((field) => {
        const value = args[field];
        return value === undefined || value === null || value === "";
      });
    }
    return [];
  }

  // No top-level required and no anyOf/oneOf — conservative fallback
  const properties = schema.properties;
  if (properties && typeof properties === "object") {
    return Object.keys(properties).filter((field) => {
      const value = args[field];
      return value === undefined || value === null || value === "";
    });
  }
  return [];
}

/**
 * Check if all anyOf/oneOf branches in a schema are unsatisfied.
 *
 * When a schema uses anyOf/oneOf (e.g. imageUrl OR imageDataUrl), the
 * standard `findMissingRequired` correctly returns no universally-missing
 * fields (because each field is only required in some branches). But if
 * ALL branches are unsatisfied, the disjunction itself is broken and
 * the tool must not be executed.
 *
 * Returns true when: schema has anyOf/oneOf branches AND every branch
 * has at least one required field that is absent/empty.
 */
export function checkAnyOfUnsatisfied(
  args: Record<string, unknown>,
  schema?: Record<string, unknown>,
): boolean {
  if (!schema) return false;

  const branches = getAnyOfBranches(schema);
  if (branches.length === 0) return false;

  // Check if ANY branch is fully satisfied
  for (const branch of branches) {
    const branchRequired = branch.required;
    if (!Array.isArray(branchRequired) || branchRequired.length === 0) {
      // Empty-required branch is always satisfied → disjunction met
      return false;
    }
    const allPresent = branchRequired.every((field) => {
      if (typeof field !== "string") return true;
      const value = args[field];
      return value !== undefined && value !== null && value !== "";
    });
    if (allPresent) return false; // This branch satisfied → disjunction met
  }

  // No branch satisfied → disjunction broken
  return true;
}
