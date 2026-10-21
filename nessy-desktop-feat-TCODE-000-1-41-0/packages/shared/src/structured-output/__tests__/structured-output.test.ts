/**
 * Turn-level structured output (R18): the draft-07 validator + shared retry loop.
 *
 * Contract source: code.claude.com/docs/en/agent-sdk/structured-outputs.md —
 * "The SDK validates schemas with JSON Schema draft-07, so schemas that declare
 * a newer version are rejected"; format "is accepted as an annotation and isn't
 * enforced by the SDK's validator"; "A schema that isn't valid JSON Schema
 * fails the run at startup with an error naming the problem."
 */

import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_MAX_STRUCTURED_OUTPUT_RETRIES,
  MAX_STRUCTURED_OUTPUT_RETRIES_ENV,
  STRUCTURED_OUTPUT_SCHEMA_ERROR_PREFIX,
  buildSchemaRetryPrompt,
  compileStructuredOutputSchema,
  resolveMaxStructuredOutputRetries,
  runSchemaRetryLoop,
  validateStructuredOutputText,
} from '../index.ts';

// Every feature the old hand-rolled checker ignored, each with a passing and a
// failing datum (doc-verification § R18: enum, const, $ref, items incl.
// element validation, additionalProperties, oneOf/anyOf/allOf, numeric bounds,
// pattern were all silently unenforced).
const ENFORCED_FEATURES: Array<{ name: string; schema: Record<string, unknown>; pass: unknown; fail: unknown }> = [
  { name: 'enum', schema: { type: 'string', enum: ['a', 'b'] }, pass: 'a', fail: 'c' },
  { name: 'const', schema: { const: 42 }, pass: 42, fail: 41 },
  {
    name: '$ref (internal)',
    schema: {
      definitions: { id: { type: 'integer', minimum: 1 } },
      type: 'object',
      required: ['id'],
      properties: { id: { $ref: '#/definitions/id' } },
    },
    pass: { id: 3 },
    fail: { id: 0 },
  },
  { name: 'items element validation', schema: { type: 'array', items: { type: 'number' } }, pass: [1, 2], fail: [1, 'two'] },
  {
    name: 'array element validation at depth',
    schema: {
      type: 'object',
      required: ['rows'],
      properties: {
        rows: { type: 'array', items: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } } },
      },
    },
    pass: { rows: [{ n: 1 }, { n: 2 }] },
    fail: { rows: [{ n: 1 }, { n: 'x' }] },
  },
  {
    name: 'additionalProperties',
    schema: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
    pass: { a: 'x' },
    fail: { a: 'x', b: 1 },
  },
  { name: 'oneOf', schema: { oneOf: [{ type: 'string' }, { type: 'number' }] }, pass: 'x', fail: true },
  { name: 'anyOf', schema: { anyOf: [{ type: 'string' }, { type: 'number' }] }, pass: 7, fail: false },
  { name: 'allOf', schema: { allOf: [{ type: 'integer' }, { minimum: 10 }] }, pass: 12, fail: 5 },
  { name: 'numeric bounds', schema: { type: 'number', minimum: 0, maximum: 10 }, pass: 5, fail: 11 },
  { name: 'pattern', schema: { type: 'string', pattern: '^[a-z]+$' }, pass: 'abc', fail: 'ABC' },
];

describe('compileStructuredOutputSchema', () => {
  for (const feature of ENFORCED_FEATURES) {
    it(`enforces ${feature.name}`, () => {
      const compiled = compileStructuredOutputSchema(feature.schema);
      expect(compiled.validate(feature.pass)).toBeNull();
      const errors = compiled.validate(feature.fail);
      expect(Array.isArray(errors)).toBe(true);
      expect(errors!.length).toBeGreaterThan(0);
    });
  }

  it('accepts format as an annotation only (no ajv-formats): a non-email passes format: email', () => {
    const compiled = compileStructuredOutputSchema({ type: 'string', format: 'email' });
    expect(compiled.validate('definitely not an email')).toBeNull();
  });

  it('accepts an explicit draft-07 $schema declaration', () => {
    const compiled = compileStructuredOutputSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'string',
    });
    expect(compiled.validate('ok')).toBeNull();
  });

  it('rejects a schema declaring a newer draft with the named error', () => {
    expect(() => compileStructuredOutputSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
    })).toThrow(new RegExp(`^${STRUCTURED_OUTPUT_SCHEMA_ERROR_PREFIX}.*2020-12`));
  });

  it('rejects a schema that is not valid JSON Schema with an error naming the problem', () => {
    expect(() => compileStructuredOutputSchema({ type: 123 })).toThrow(
      new RegExp(`^${STRUCTURED_OUTPUT_SCHEMA_ERROR_PREFIX}`),
    );
    expect(() => compileStructuredOutputSchema('not a schema')).toThrow(
      new RegExp(`^${STRUCTURED_OUTPUT_SCHEMA_ERROR_PREFIX}`),
    );
    expect(() => compileStructuredOutputSchema(null)).toThrow(
      new RegExp(`^${STRUCTURED_OUTPUT_SCHEMA_ERROR_PREFIX}`),
    );
  });
});

describe('validateStructuredOutputText', () => {
  const compiled = compileStructuredOutputSchema({
    type: 'object',
    required: ['ok'],
    properties: { ok: { type: 'boolean' } },
  });

  it('returns the parsed value for conforming JSON text', () => {
    const outcome = validateStructuredOutputText(compiled, '{"ok": true}');
    expect(outcome).toEqual({ ok: true, value: { ok: true } });
  });

  it('reports unparseable text as a JSON error, not a crash', () => {
    const outcome = validateStructuredOutputText(compiled, 'not json at all');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errors.join(' ')).toContain('not valid JSON');
    }
  });

  it('reports validation errors for parseable non-conforming text', () => {
    const outcome = validateStructuredOutputText(compiled, '{"ok": "yes"}');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errors.length).toBeGreaterThan(0);
    }
  });
});

describe('resolveMaxStructuredOutputRetries', () => {
  it('defaults to 5', () => {
    expect(DEFAULT_MAX_STRUCTURED_OUTPUT_RETRIES).toBe(5);
    expect(resolveMaxStructuredOutputRetries(undefined, {})).toBe(5);
  });

  it('honors the env knob', () => {
    expect(MAX_STRUCTURED_OUTPUT_RETRIES_ENV).toBe('NESSY_MAX_STRUCTURED_OUTPUT_RETRIES');
    expect(resolveMaxStructuredOutputRetries(undefined, { NESSY_MAX_STRUCTURED_OUTPUT_RETRIES: '3' })).toBe(3);
  });

  it('falls back to the default on a malformed or non-positive env value', () => {
    expect(resolveMaxStructuredOutputRetries(undefined, { NESSY_MAX_STRUCTURED_OUTPUT_RETRIES: 'many' })).toBe(5);
    expect(resolveMaxStructuredOutputRetries(undefined, { NESSY_MAX_STRUCTURED_OUTPUT_RETRIES: '0' })).toBe(5);
    expect(resolveMaxStructuredOutputRetries(undefined, { NESSY_MAX_STRUCTURED_OUTPUT_RETRIES: '-2' })).toBe(5);
  });

  it('lets a per-call override beat the env knob', () => {
    expect(resolveMaxStructuredOutputRetries(2, { NESSY_MAX_STRUCTURED_OUTPUT_RETRIES: '7' })).toBe(2);
  });

  it('clamps env and override values to the ceiling (a misconfigured 1e10 must not loop forever)', () => {
    expect(resolveMaxStructuredOutputRetries(undefined, { NESSY_MAX_STRUCTURED_OUTPUT_RETRIES: '10000000000' })).toBe(50);
    expect(resolveMaxStructuredOutputRetries(undefined, { NESSY_MAX_STRUCTURED_OUTPUT_RETRIES: '1e10' })).toBe(50);
    expect(resolveMaxStructuredOutputRetries(9999, {})).toBe(50);
    expect(resolveMaxStructuredOutputRetries(undefined, { NESSY_MAX_STRUCTURED_OUTPUT_RETRIES: '50' })).toBe(50);
    expect(resolveMaxStructuredOutputRetries(undefined, { NESSY_MAX_STRUCTURED_OUTPUT_RETRIES: '49' })).toBe(49);
  });
});

describe('runSchemaRetryLoop', () => {
  const compiled = compileStructuredOutputSchema({
    type: 'object',
    required: ['ok'],
    properties: { ok: { type: 'boolean' } },
  });

  it('returns the parsed value once an attempt validates, passing prior errors to the retry', async () => {
    const seenErrors: Array<string[] | null> = [];
    const run = await runSchemaRetryLoop<string>({
      compiled,
      env: {},
      runAttempt: async ({ attempt, retryErrors }) => {
        seenErrors.push(retryErrors);
        return { result: `attempt-${attempt}`, text: attempt === 1 ? '{"ok":"nope"}' : '{"ok":true}' };
      },
    });
    expect(run.kind).toBe('valid');
    if (run.kind === 'valid') {
      expect(run.value).toEqual({ ok: true });
      expect(run.attempts).toBe(2);
      expect(run.result).toBe('attempt-2');
    }
    expect(seenErrors[0]).toBeNull();
    expect(seenErrors[1]?.length).toBeGreaterThan(0);
  });

  it('exhausts at the default 5 attempts and carries the last validation errors', async () => {
    let attempts = 0;
    const run = await runSchemaRetryLoop<number>({
      compiled,
      env: {},
      runAttempt: async () => {
        attempts += 1;
        return { result: attempts, text: '{"ok":"still wrong"}' };
      },
    });
    expect(attempts).toBe(5);
    expect(run.kind).toBe('exhausted');
    if (run.kind === 'exhausted') {
      expect(run.attempts).toBe(5);
      expect(run.errors.length).toBeGreaterThan(0);
    }
  });

  it('honors the env knob and lets the per-call override beat it', async () => {
    let envAttempts = 0;
    await runSchemaRetryLoop<number>({
      compiled,
      env: { NESSY_MAX_STRUCTURED_OUTPUT_RETRIES: '3' },
      runAttempt: async () => {
        envAttempts += 1;
        return { result: envAttempts, text: 'bad' };
      },
    });
    expect(envAttempts).toBe(3);

    let overrideAttempts = 0;
    await runSchemaRetryLoop<number>({
      compiled,
      maxAttempts: 2,
      env: { NESSY_MAX_STRUCTURED_OUTPUT_RETRIES: '4' },
      runAttempt: async () => {
        overrideAttempts += 1;
        return { result: overrideAttempts, text: 'bad' };
      },
    });
    expect(overrideAttempts).toBe(2);
  });

  it('passes through an attempt that produced nothing validatable without retrying', async () => {
    let attempts = 0;
    const run = await runSchemaRetryLoop<string>({
      compiled,
      env: {},
      runAttempt: async () => {
        attempts += 1;
        return { result: 'aborted-child', text: null };
      },
    });
    expect(attempts).toBe(1);
    expect(run.kind).toBe('passthrough');
    if (run.kind === 'passthrough') {
      expect(run.result).toBe('aborted-child');
    }
  });
});

describe('buildSchemaRetryPrompt', () => {
  it('keeps the established reprompt wording and appends the validation errors', () => {
    const prompt = buildSchemaRetryPrompt('return json', ['$.ok must be boolean']);
    expect(prompt).toContain('return json');
    expect(prompt).toContain('The previous result did not match outputSchema');
    expect(prompt).toContain('$.ok must be boolean');
    expect(prompt).toContain('Return only valid JSON matching the schema.');
  });
});
