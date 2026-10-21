/**
 * Draft-07 structured-output schema validation (R18).
 *
 * Contract source: code.claude.com/docs/en/agent-sdk/structured-outputs.md —
 * schemas are validated as JSON Schema draft-07 and schemas declaring a newer
 * version are rejected; an invalid schema fails the run at startup with an
 * error naming the problem; the `format` keyword is accepted as an annotation
 * and never enforced (deliberately no ajv-formats).
 */

import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';

/** Named-error prefix for the schema-itself gate. */
export const STRUCTURED_OUTPUT_SCHEMA_ERROR_PREFIX = 'invalid structured-output schema: ';

export interface CompiledStructuredOutputSchema {
  /** Validate a parsed JSON value. `null` when valid; all validation errors otherwise. */
  validate(value: unknown): string[] | null;
}

export type StructuredOutputTextResult =
  | { ok: true; value: unknown }
  | { ok: false; errors: string[] };

/** The draft-07 identifiers a schema may declare in `$schema`. */
const DRAFT_07_SCHEMA_IDS = new Set([
  'http://json-schema.org/draft-07/schema#',
  'http://json-schema.org/draft-07/schema',
  'https://json-schema.org/draft-07/schema#',
  'https://json-schema.org/draft-07/schema',
]);

function gateError(problem: string): Error {
  return new Error(`${STRUCTURED_OUTPUT_SCHEMA_ERROR_PREFIX}${problem}`);
}

function formatAjvErrors(errors: readonly ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) return ['value does not match the schema'];
  return errors.map(error => {
    const path = error.instancePath || '$';
    const detail = error.keyword === 'additionalProperties'
      && typeof (error.params as { additionalProperty?: unknown }).additionalProperty === 'string'
      ? ` (${(error.params as { additionalProperty: string }).additionalProperty})`
      : '';
    return `${path} ${error.message ?? `fails ${error.keyword}`}${detail}`;
  });
}

/**
 * Validate the caller's schema as JSON Schema draft-07 and compile it.
 * Throws the named `invalid structured-output schema: …` error when the schema
 * itself is invalid or declares a non-draft-07 `$schema` — this is the
 * documented fail-at-startup gate, replacing the pre-v2.1.205 fail-open shape.
 */
export function compileStructuredOutputSchema(schema: unknown): CompiledStructuredOutputSchema {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw gateError('schema must be a JSON Schema object');
  }
  const declared = (schema as { $schema?: unknown }).$schema;
  if (declared !== undefined) {
    if (typeof declared !== 'string' || !DRAFT_07_SCHEMA_IDS.has(declared)) {
      throw gateError(
        `$schema must be JSON Schema draft-07; got ${typeof declared === 'string' ? declared : JSON.stringify(declared)}`,
      );
    }
  }

  // A fresh Ajv per compile keeps `$id` registrations from colliding across
  // unrelated caller schemas. `validateFormats: false` makes `format` a pure
  // annotation; `strict: false` tolerates unknown annotation keywords the way
  // draft-07 documents; the (default) meta-schema validation enforces the
  // schema-itself gate.
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  let compiled: ValidateFunction;
  try {
    compiled = ajv.compile(schema);
  } catch (error) {
    throw gateError(error instanceof Error ? error.message : String(error));
  }

  return {
    validate(value: unknown): string[] | null {
      if (compiled(value)) return null;
      return formatAjvErrors(compiled.errors);
    },
  };
}

/** Parse assistant text as JSON and validate it against a compiled schema. */
export function validateStructuredOutputText(
  compiled: CompiledStructuredOutputSchema,
  text: string,
): StructuredOutputTextResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`result is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const errors = compiled.validate(value);
  if (errors) return { ok: false, errors };
  return { ok: true, value };
}
