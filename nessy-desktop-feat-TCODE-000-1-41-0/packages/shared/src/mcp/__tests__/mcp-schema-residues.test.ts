/**
 * F1.699 — the F1.665 residues that change behaviour.
 *
 * (1) + (3): `source_test` failed a whole source for ONE tool whose input-schema
 * property name the Anthropic contract refuses, while the pool drops only that
 * tool (`McpClientPool.malformedToolProperties`) — and the skipped-tools warning
 * rode that failure result, where `source-test.ts` never prints it. The probe
 * now skips the same tool the pool drops, names it in the warning line, and
 * passes.
 *
 * (4): Ajv's "unknown format ... ignored" warning went to the console on every
 * listing, refresh and hydration, once per tool with such a `format`, because the
 * host compiles each schema in a fresh validator. The host's validators are
 * silent; the compile outcome is unchanged.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateStdioMcpConnection } from '../validation.ts';
import { FRESH_AJV_PER_OUTPUT_SCHEMA, toolSchemaCompileError } from '../client.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = (name: string) => join(HERE, 'fixtures', name);

describe('F1.699 — source_test skips the tool the pool drops, and says so', () => {
  it('passes a server with one bad property name, lists the rest, and names the skipped tool', async () => {
    const result = await validateStdioMcpConnection({
      command: 'node',
      args: [FIXTURE('mcp-server-bad-property.mjs')],
      timeout: 8000,
    });

    expect(result.success).toBe(true);
    expect(result.tools).toEqual(['echo']);
    expect(result.warning).toContain('1 tool skipped');
    expect(result.warning).toContain('"spaced"');
    expect(result.warning).toContain('file name');
  }, 15000);

  it('CONTROL — a clean server passes with no warning', async () => {
    const result = await validateStdioMcpConnection({
      command: 'node',
      args: [FIXTURE('mcp-server-good.mjs')],
      timeout: 8000,
    });

    expect(result.success).toBe(true);
    expect(result.tools).toEqual(['echo']);
    expect(result.warning).toBeUndefined();
  }, 15000);
});

describe('F1.699 — the host validators do not log Ajv\'s unknown-format warning', () => {
  const warn = spyOn(console, 'warn');
  afterEach(() => { warn.mockClear(); });

  const UNKNOWN_FORMAT = { type: 'object', properties: { day: { type: 'string', format: 'nessy-unknown-format' } } };

  it('compiles a schema with an unknown format silently, on the listing check and the output validator', () => {
    expect(toolSchemaCompileError(UNKNOWN_FORMAT)).toBeUndefined();
    const validate = FRESH_AJV_PER_OUTPUT_SCHEMA.getValidator(UNKNOWN_FORMAT as never);
    expect(validate({ day: 'monday' }).valid).toBe(true);

    expect(warn).not.toHaveBeenCalled();
  });

  it('CONTROL — a schema Ajv cannot compile is still refused with its reason', () => {
    const error = toolSchemaCompileError({ type: 'object', anyOf: { properties: {} } });
    expect(error).toContain('anyOf');
  });
});
