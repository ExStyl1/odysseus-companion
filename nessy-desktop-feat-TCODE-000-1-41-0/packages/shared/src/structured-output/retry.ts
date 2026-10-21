/**
 * The ONE shared structured-output retry loop (R18).
 *
 * Consumed by the production subagent and workflow schema paths (replacing
 * their hardcoded 2-attempt loops) and by the Pi turn-level
 * validate-and-reprompt loop. Configurable attempts, default 5, env knob
 * `NESSY_MAX_STRUCTURED_OUTPUT_RETRIES` — one parser for the knob lives here.
 */

import { validateStructuredOutputText, type CompiledStructuredOutputSchema } from './validator.ts';

export const DEFAULT_MAX_STRUCTURED_OUTPUT_RETRIES = 5;
export const MAX_STRUCTURED_OUTPUT_RETRIES_ENV = 'NESSY_MAX_STRUCTURED_OUTPUT_RETRIES';

/**
 * Resolve the attempt cap: per-call override, else the env knob, else 5.
 * Malformed or non-positive values fall back to the default.
 */
/**
 * Retries above this are indistinguishable from a hang for the user and turn a
 * misconfigured env (`1e10`, a stray large number) into an unbounded model-call
 * loop. 50 is far above any documented or sane setting (Claude's default is 5).
 */
export const MAX_STRUCTURED_OUTPUT_RETRIES_CEILING = 50;

export function resolveMaxStructuredOutputRetries(
  override?: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const clamp = (value: number): number => Math.min(value, MAX_STRUCTURED_OUTPUT_RETRIES_CEILING);
  if (override !== undefined && Number.isInteger(override) && override > 0) return clamp(override);
  const raw = env[MAX_STRUCTURED_OUTPUT_RETRIES_ENV]?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) return clamp(parsed);
  }
  return DEFAULT_MAX_STRUCTURED_OUTPUT_RETRIES;
}

export interface SchemaRetryAttemptContext {
  /** 1-based attempt number. */
  attempt: number;
  /** The resolved attempt cap for this run. */
  maxAttempts: number;
  /** Validation errors from the previous attempt; null on the first. */
  retryErrors: string[] | null;
}

export interface SchemaRetryAttemptOutcome<T> {
  result: T;
  /**
   * The text to validate, or `null` when the attempt produced nothing
   * validatable (aborted/errored child, empty turn) — a `null` stops the loop
   * and passes the attempt's result through unchanged.
   */
  text: string | null;
}

export type SchemaRetryRun<T> =
  | { kind: 'valid'; result: T; attempts: number; value: unknown }
  | { kind: 'passthrough'; result: T; attempts: number }
  | { kind: 'exhausted'; result: T; attempts: number; errors: string[] };

export interface RunSchemaRetryLoopOptions<T> {
  compiled: CompiledStructuredOutputSchema;
  /** Per-call attempt override; beats the env knob. */
  maxAttempts?: number;
  /** Env source for the knob (tests); defaults to process.env. */
  env?: Record<string, string | undefined>;
  runAttempt(context: SchemaRetryAttemptContext): Promise<SchemaRetryAttemptOutcome<T>>;
}

/**
 * Established reprompt sentence shared by every schema retry path. Turn-level
 * retries send it alone (the conversation already carries the original ask);
 * child-session retries prepend the original task via buildSchemaRetryPrompt.
 */
export function buildSchemaRetryNote(errors: readonly string[]): string {
  return `The previous result did not match outputSchema: ${errors.join('; ')}. Return only valid JSON matching the schema.`;
}

export function buildSchemaRetryPrompt(baseTask: string, errors: readonly string[]): string {
  return `${baseTask}\n\n${buildSchemaRetryNote(errors)}`;
}

export async function runSchemaRetryLoop<T>(options: RunSchemaRetryLoopOptions<T>): Promise<SchemaRetryRun<T>> {
  const maxAttempts = resolveMaxStructuredOutputRetries(options.maxAttempts, options.env);
  let retryErrors: string[] | null = null;
  let last: SchemaRetryAttemptOutcome<T> | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const outcome = await options.runAttempt({ attempt, maxAttempts, retryErrors });
    last = outcome;
    if (outcome.text === null) {
      return { kind: 'passthrough', result: outcome.result, attempts: attempt };
    }
    const validated = validateStructuredOutputText(options.compiled, outcome.text);
    if (validated.ok) {
      return { kind: 'valid', result: outcome.result, attempts: attempt, value: validated.value };
    }
    retryErrors = validated.errors;
  }

  return {
    kind: 'exhausted',
    result: last!.result,
    attempts: maxAttempts,
    errors: retryErrors ?? [],
  };
}
