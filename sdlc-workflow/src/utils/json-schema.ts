/**
 * Minimal structural JSON-schema validator covering the subset the workflow
 * needs (object/array/string/number/boolean, properties, required, items,
 * enum). Returns human-readable error strings so the inference retry prompt
 * can quote them verbatim.
 */
export interface JsonSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: Array<string | number>;
  minItems?: number;
}

const typeOf = (value: unknown): string => {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
};

export const validateJson = (
  schema: JsonSchema,
  value: unknown,
  path = '$'
): string[] => {
  const errors: string[] = [];
  const actual = typeOf(value);

  if (actual !== schema.type) {
    return [`${path}: expected ${schema.type}, got ${actual}`];
  }

  if (schema.enum !== undefined) {
    if (!schema.enum.includes(value as string | number)) {
      errors.push(
        `${path}: value ${JSON.stringify(value)} not in [${schema.enum.join(', ')}]`
      );
    }
  }

  if (schema.type === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) {
        errors.push(`${path}.${key}: missing required property`);
      }
    }
    for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
      if (key in obj) {
        errors.push(...validateJson(propSchema, obj[key], `${path}.${key}`));
      }
    }
  }

  if (schema.type === 'array') {
    const arr = value as unknown[];
    if (schema.minItems !== undefined && arr.length < schema.minItems) {
      errors.push(
        `${path}: expected at least ${schema.minItems} items, got ${arr.length}`
      );
    }
    if (schema.items !== undefined) {
      arr.forEach((item, i) => {
        errors.push(
          ...validateJson(schema.items as JsonSchema, item, `${path}[${i}]`)
        );
      });
    }
  }

  return errors;
};

/**
 * Extract a JSON payload from a model response that may wrap it in a
 * ```json fence or surrounding prose.
 */
export const extractJson = (raw: string): unknown => {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : raw).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('no JSON object found in response');
  }
  return JSON.parse(candidate.slice(start, end + 1));
};
