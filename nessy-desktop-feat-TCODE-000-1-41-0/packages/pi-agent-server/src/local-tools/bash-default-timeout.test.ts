/**
 * P2.345, the default half.
 *
 * `env-vars.md#variables`, verbatim: "`BASH_DEFAULT_TIMEOUT_MS` | Default
 * timeout for long-running bash commands (default: 120000, or 2 minutes)".
 *
 * The subprocess is the only layer that still knows the model sent no `timeout`
 * of its own — one hop down, `index.ts`'s `options?.timeout ?? 120_000` cannot
 * tell an omitted value from a model that chose 120000 — so the operator default
 * is resolved at the tool-input seam. This drives the PRODUCTION port built by
 * `buildRuntimeBackedToolExecutionPorts`, not a double, because a double that
 * dropped the argument under test would go green either way.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  BASH_DEFAULT_TIMEOUT_COMPAT_ENV_VAR,
  BASH_DEFAULT_TIMEOUT_ENV_VAR,
} from '../../../shared/src/agent/pi-harness/process-supervisor-port.ts';
import { buildRuntimeBackedToolExecutionPorts } from './runtime-backed-tools.ts';

const TOUCHED = [BASH_DEFAULT_TIMEOUT_ENV_VAR, BASH_DEFAULT_TIMEOUT_COMPAT_ENV_VAR] as const;
const saved = new Map<string, string | undefined>();
for (const key of TOUCHED) saved.set(key, process.env[key]);

afterEach(() => {
  for (const key of TOUCHED) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function bashOperationFor(input: Record<string, unknown>): { timeout?: number } {
  const ports = buildRuntimeBackedToolExecutionPorts('/tmp/nessy-bash-default-timeout');
  const port = ports.find(candidate => candidate.semanticId === 'bash');
  if (!port || port.dispatch.kind !== 'local') throw new Error('bash local port missing');
  const call = port.dispatch.toLocalCall(
    input,
    { executionId: 'execution-1' } as never,
    new AbortController().signal,
  );
  return call.operation as { timeout?: number };
}

describe('bash tool default timeout', () => {
  test('an omitted timeout takes the documented 120000 when the operator set nothing', () => {
    for (const key of TOUCHED) delete process.env[key];

    expect(bashOperationFor({ command: 'printf ok' }).timeout).toBe(120_000);
  });

  test('an omitted timeout takes the operator default, in both spellings', () => {
    process.env[BASH_DEFAULT_TIMEOUT_COMPAT_ENV_VAR] = '300000';
    expect(bashOperationFor({ command: 'printf ok' }).timeout).toBe(300_000);

    process.env[BASH_DEFAULT_TIMEOUT_ENV_VAR] = '240000';
    expect(bashOperationFor({ command: 'printf ok' }).timeout).toBe(240_000);
  });

  test('a model-chosen timeout still wins, and the sub-second floor is unchanged', () => {
    // The discriminating half: without it, hard-coding the operator default at
    // this seam would pass the two tests above and silently discard the model's
    // own number — the value the host ceiling exists to bound.
    process.env[BASH_DEFAULT_TIMEOUT_COMPAT_ENV_VAR] = '300000';

    expect(bashOperationFor({ command: 'printf ok', timeout: 3000 }).timeout).toBe(3_000);
    expect(bashOperationFor({ command: 'printf ok', timeout: 2 }).timeout).toBe(1_000);
  });
});
