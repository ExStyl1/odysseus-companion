/**
 * The `headersHelper` executor (`mcp/headers-helper.ts`).
 *
 * `mcp.md:795-799`: stdout must be "a JSON object of string key-value pairs";
 * the command runs "in a shell with a 10-second timeout"; and the helper env
 * table (`mcp.md:805-813`) is `CLAUDE_CODE_MCP_SERVER_NAME`,
 * `CLAUDE_CODE_MCP_SERVER_URL`, and `CLAUDE_PLUGIN_ROOT` "Set only when a
 * plugin provides the server".
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpHeadersHelperError, resolveMcpDynamicHeaders } from '../headers-helper.ts';

const CONTEXT = { serverName: 'internal-api', url: 'https://mcp.internal.example.test/mcp' };

async function failureOf(promise: Promise<unknown>): Promise<McpHeadersHelperError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(McpHeadersHelperError);
    return error as McpHeadersHelperError;
  }
  throw new Error('expected the helper to fail');
}

describe('resolveMcpDynamicHeaders', () => {
  it('accepts a flat object of string values', async () => {
    const headers = await resolveMcpDynamicHeaders(
      { command: `echo '{"Authorization": "Bearer fresh", "X-Trace": "t1"}'` },
      CONTEXT,
    );

    expect(headers).toEqual({ Authorization: 'Bearer fresh', 'X-Trace': 't1' });
  }, 15_000);

  it.each([
    ['non-JSON stdout', 'echo not-json'],
    ['a nested object value', `echo '{"a": {"b": "c"}}'`],
    ['a non-string value', `echo '{"a": 1}'`],
    ['a JSON array', `echo '["a"]'`],
  ])('rejects %s as malformed-stdout', async (_label, command) => {
    const error = await failureOf(resolveMcpDynamicHeaders({ command }, CONTEXT));

    expect(error.reason).toBe('malformed-stdout');
  }, 15_000);

  it('rejects a non-zero exit with the named reason, quoting no output', async () => {
    const error = await failureOf(resolveMcpDynamicHeaders(
      { command: `echo '{"Authorization": "Bearer secret-material"}'; exit 3` },
      CONTEXT,
    ));

    expect(error.reason).toBe('non-zero-exit');
    // Helper stdout may be a credential; the error never carries it.
    expect(error.message).not.toContain('secret-material');
  }, 15_000);

  it('kills a hanging helper at the deadline and names the timeout', async () => {
    const startedAt = Date.now();
    const error = await failureOf(resolveMcpDynamicHeaders(
      { command: 'sleep 30' },
      CONTEXT,
      { timeoutMs: 250 },
    ));

    expect(error.reason).toBe('timeout');
    // SIGTERM at the deadline, not the 30s the command wanted.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 15_000);

  it('times out even when a surviving grandchild still holds the stdout pipe', async () => {
    // The shape that hung CI: the shell backgrounds a process that outlives its
    // SIGTERM and keeps the stdout pipe open, so `close` never fires. The
    // deadline must settle the promise on its own — otherwise the connection
    // waits forever instead of degrading to static headers.
    const startedAt = Date.now();
    const error = await failureOf(resolveMcpDynamicHeaders(
      { command: 'sleep 30 & sleep 30' },
      CONTEXT,
      { timeoutMs: 250 },
    ));

    expect(error.reason).toBe('timeout');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 15_000);

  it('exposes the documented server variables, with CLAUDE_PLUGIN_ROOT only for plugin helpers', async () => {
    const command = `printf '{"X-Name": "%s", "X-Url": "%s", "X-Root": "%s"}' "$CLAUDE_CODE_MCP_SERVER_NAME" "$CLAUDE_CODE_MCP_SERVER_URL" "\${CLAUDE_PLUGIN_ROOT:-unset}"`;

    expect(await resolveMcpDynamicHeaders({ command }, CONTEXT)).toEqual({
      'X-Name': 'internal-api',
      'X-Url': 'https://mcp.internal.example.test/mcp',
      'X-Root': 'unset',
    });
    expect(await resolveMcpDynamicHeaders({ command, pluginRoot: '/cache/bundle' }, CONTEXT)).toEqual({
      'X-Name': 'internal-api',
      'X-Url': 'https://mcp.internal.example.test/mcp',
      'X-Root': '/cache/bundle',
    });
  }, 15_000);

  it('runs from the spec cwd (plugin root for plugin-provided helpers, mcp.md:816)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'headers-helper-cwd-'));
    try {
      const headers = await resolveMcpDynamicHeaders(
        { command: `printf '{"X-Cwd": "%s"}' "$(pwd -P)"`, cwd: directory },
        CONTEXT,
      );

      expect(headers['X-Cwd']).toBe(realpathSync(directory));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
