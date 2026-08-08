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
 * Try to parse a JSON object from text that may contain surrounding noise.
 * Returns undefined when no balanced, parseable object is present.
 */
const tryParseJsonObject = (text: string): unknown | undefined => {
  const candidate = text.trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    return undefined;
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
};

interface FencedBlock {
  lang: string;
  body: string;
}

/**
 * Collect markdown fenced blocks with their language tags. Anchored so a
 * closing fence cannot be mistaken for an opening one.
 */
const collectFences = (raw: string): FencedBlock[] => {
  const fences: FencedBlock[] = [];
  const re =
    /(?:^|\n)```([\w+-]*)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?=\r?\n|$)/g;
  let match: RegExpExecArray | null = re.exec(raw);
  while (match !== null) {
    fences.push({ lang: match[1].toLowerCase(), body: match[2] });
    match = re.exec(raw);
  }
  return fences;
};

/**
 * Extract a JSON payload from a model response that may wrap it in a
 * ```json fence or surrounding prose.
 *
 * Preference: json-tagged fences (document order), then any other fence
 * that yields a parseable object (document order), then a raw scan.
 */
export const extractJson = (raw: string): unknown => {
  const fences = collectFences(raw);
  const candidates: string[] = [
    ...fences.filter(f => f.lang === 'json').map(f => f.body),
    ...fences.filter(f => f.lang !== 'json').map(f => f.body),
    raw
  ];

  for (const candidate of candidates) {
    const parsed = tryParseJsonObject(candidate);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  throw new Error('no JSON object found in response');
};
