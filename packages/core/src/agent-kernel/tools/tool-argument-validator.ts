/** Deterministic JSON-Schema subset used at both Guard and execution boundaries. */
export function validateToolArguments(
  value: Record<string, unknown>,
  schema?: Record<string, unknown>,
): string[] {
  return validateJsonSchemaValue(value, schema);
}

export function validateJsonSchemaValue(
  value: unknown,
  schema?: Record<string, unknown>,
): string[] {
  if (!schema) return [];
  return validateNode(value, schema, "$", true);
}

function validateNode(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  rejectEmptyRequired = false,
): string[] {
  const errors: string[] = [];

  const anyOf = objectSchemas(schema.anyOf);
  if (anyOf.length > 0 && !anyOf.some((branch) =>
    validateNode(value, branch, path, rejectEmptyRequired).length === 0
  )) {
    errors.push(`${path} does not satisfy any allowed schema branch`);
  }

  const oneOf = objectSchemas(schema.oneOf);
  if (oneOf.length > 0) {
    const matches = oneOf.filter((branch) =>
      validateNode(value, branch, path, rejectEmptyRequired).length === 0
    ).length;
    if (matches !== 1) errors.push(`${path} must satisfy exactly one schema branch`);
  }

  for (const branch of objectSchemas(schema.allOf)) {
    errors.push(...validateNode(value, branch, path, rejectEmptyRequired));
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(item, value))) {
    errors.push(`${path} must be one of the allowed values`);
  }
  if ("const" in schema && !deepEqual(schema.const, value)) {
    errors.push(`${path} must equal the required constant`);
  }

  const allowedTypes = typeof schema.type === "string"
    ? [schema.type]
    : Array.isArray(schema.type)
      ? schema.type.filter((item): item is string => typeof item === "string")
      : [];
  if (allowedTypes.length > 0 && !allowedTypes.some((type) => matchesType(value, type))) {
    errors.push(`${path} must be ${allowedTypes.join(" or ")}`);
    return errors;
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path} must contain at least ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path} must contain at most ${schema.maxLength} characters`);
    }
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern, "u").test(value)) {
          errors.push(`${path} does not match the required pattern`);
        }
      } catch {
        errors.push(`${path} uses an invalid schema pattern`);
      }
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path} must be at least ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path} must be at most ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path} must contain at least ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${path} must contain at most ${schema.maxItems} items`);
    }
    if (schema.uniqueItems === true) {
      const unique = new Set(value.map(stableStringify));
      if (unique.size !== value.length) errors.push(`${path} items must be unique`);
    }
    if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
      value.forEach((item, index) => {
        errors.push(...validateNode(
          item,
          schema.items as Record<string, unknown>,
          `${path}[${index}]`,
          rejectEmptyRequired,
        ));
      });
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [];
    for (const field of required) {
      const child = record[field];
      if (
        child === undefined ||
        child === null ||
        (rejectEmptyRequired && child === "")
      ) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties as Record<string, unknown>
      : {};
    const allowedPropertyNames = collectPropertyNames(schema);
    for (const [field, child] of Object.entries(record)) {
      const childSchema = properties[field];
      if (childSchema && typeof childSchema === "object" && !Array.isArray(childSchema)) {
        errors.push(...validateNode(
          child,
          childSchema as Record<string, unknown>,
          `${path}.${field}`,
          rejectEmptyRequired,
        ));
      } else if (
        schema.additionalProperties === false &&
        !allowedPropertyNames.has(field)
      ) {
        errors.push(`Unexpected field: ${field}`);
      } else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object" &&
        !Array.isArray(schema.additionalProperties)
      ) {
        errors.push(...validateNode(
          child,
          schema.additionalProperties as Record<string, unknown>,
          `${path}.${field}`,
          rejectEmptyRequired,
        ));
      }
    }
  }

  return [...new Set(errors)];
}

function collectPropertyNames(schema: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  const properties = schema.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const name of Object.keys(properties)) names.add(name);
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    for (const branch of objectSchemas(schema[keyword])) {
      for (const name of collectPropertyNames(branch)) names.add(name);
    }
  }
  return names;
}

function objectSchemas(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return !!value && typeof value === "object" && !Array.isArray(value);
    case "null": return value === null;
    default: return true;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
