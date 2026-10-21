/**
 * Task 5.4 (partial, offline): drive the REAL bundled session-mcp-server process
 * with `--external-standalone-only` over MCP stdio and assert the Codex MVP tool
 * split holds end-to-end at the process level:
 *   - tools/list advertises only standalone-safe tools (no callback-dependent ones)
 *   - calling a gated tool returns a recoverable isError result (no crash / no
 *     thrown JSON-RPC error), so a Codex turn survives.
 *
 * The full "Codex drives an authenticated source" e2e is DEFER-TO-REVIEW — it
 * needs a configured, authenticated MCP/API source that can't be provisioned
 * headlessly. The credential-cache read path is covered by
 * `shared/src/sources/credential-cache.test.ts`.
 *
 * P3.130 adds the automation_create round-trip to the same harness: `index.ts`
 * runs `main()` at import, so a real process over stdio is the only way to
 * reach `createAutomationManager` at all.
 */
import { afterAll, beforeAll, test, expect, describe } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChildPool, type PooledRpcResponse } from './__tests__/child-pool.ts';

/** This file's reply shape; the pool is generic in exactly this (P6.908). */
type RpcResponse = PooledRpcResponse<{
  tools?: Array<{ name: string }>;
  content?: unknown;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}>;

/**
 * ONE child per distinct argv for the WHOLE FILE, instead of one per case
 * (P6.901).
 *
 * This server's boot is a cold, I/O-bound module graph — 28.3–46.6 s in a direct
 * probe and 70 689 ms under `bun test` at load 12.8 (P6.893's measurements). The
 * two cases below spawn IDENTICAL argv and paid it twice.
 *
 * WHAT THE TWO CASES ARE NO LONGER ISOLATED FROM, stated because sharing a child
 * is a real trade:
 *  - the WORKSPACE directory, the plans folder and the config root, now created
 *    once for the file. The second case writes `automations.json` into it; the
 *    first neither reads nor asserts the absence of that file, so the order of
 *    the two does not decide either verdict;
 *  - the SERVER PROCESS, so anything `index.ts` keeps between requests is carried
 *    from the first case to the second.
 */
const pool = createChildPool<RpcResponse['result']>();

/** The one workspace, plans folder and config root the file's child is given. */
let workspace: string;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'smcp-ext-'));
});

afterAll(async () => {
  await pool.killAll();
  rmSync(workspace, { recursive: true, force: true });
});

function standaloneArgs(): string[] {
  return [
    '--session-id', 's1',
    '--workspace-root', workspace,
    '--plans-folder', join(workspace, 'plans'),
    '--config-root', workspace,
    '--external-standalone-only',
  ];
}

/** Run one exchange on the child that owns this argv, and answer by CALLER id. */
const runMcpSession = (args: string[], requests: object[]) => pool.runMcpSession(args, requests);

describe('session-mcp-server --external-standalone-only (real process)', () => {
  test('tools/list is filtered; a gated tool returns a recoverable error', async () => {
    const responses = await runMcpSession(
      standaloneArgs(),
      [
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'call_llm', arguments: { prompt: 'x' } } },
      ],
    );

    const list = responses.get(2)?.result?.tools?.map((t) => t.name) ?? [];
    expect(list.length).toBeGreaterThan(0);
    expect(list).toContain('source_test');
    expect(list).toContain('config_validate');
    expect(list).toContain('automation_create');
    expect(list).toContain('automation_update');
    expect(list).not.toContain('call_llm');
    expect(list).not.toContain('SubmitPlan');
    expect(list).not.toContain('spawn_session');

    // Gated tool → recoverable isError result, NOT a JSON-RPC error / crash.
    const gated = responses.get(3);
    expect(gated?.result?.isError).toBe(true);
  }, 330_000);
});

describe('session-mcp-server automation_create (real process)', () => {
  /**
   * P3.130. `createAutomationManager` used to reach `createAutomationEntry`
   * through `args as Parameters<typeof createAutomationEntry>[1]` — an
   * assertion that the bag on the `AutomationManagerInterface` port really was
   * an `AutomationCreateInput`, checked by nothing. Nothing in this package
   * exercised the path either, so schema-vs-writer drift had no detector.
   *
   * The assertion is now `AutomationCreateSchema.parse(args)`, and this is its
   * positive control: a create has to survive the parse AND be accepted by the
   * shared writer AND land on disk. A negative twin would prove nothing — the
   * same schema runs one frame earlier in `handleAutomationCreate`, so a
   * malformed payload never reaches the line under test.
   */
  test('a valid create round-trips to automations.json and reports every field', async () => {
    const responses = await runMcpSession(
      standaloneArgs(),
      [
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'automation_create',
            arguments: {
              kind: 'scheduled',
              name: 'nightly-sweep',
              cron: '0 3 * * *',
              actions: [{ type: 'prompt', prompt: 'sweep' }],
            },
          },
        },
      ],
    );

    const result = responses.get(2)?.result;
    expect(result?.isError).toBeFalsy();

    // Every field of `AutomationManagementResult` survives the spread that
    // replaced the un-assignable direct pass (the interface carries no implicit
    // index signature); a stripped subset would be the regression to catch.
    const structured = result?.structuredContent ?? {};
    expect(typeof structured.automationId).toBe('string');
    expect(structured.event).toBe('SchedulerTick');
    expect(structured.matcherIndex).toBe(0);
    expect(structured.configPath).toBe(join(workspace, 'automations.json'));
    expect((structured.automation as { cron?: string } | undefined)?.cron).toBe('0 3 * * *');

    // The shared writer accepted the parsed value — the agreement the cast used
    // to assert without checking.
    const configPath = join(workspace, 'automations.json');
    expect(existsSync(configPath)).toBe(true);
    const stored = JSON.parse(readFileSync(configPath, 'utf8')) as {
      automations: Record<string, Array<{ id?: string; name?: string; cron?: string; actions?: unknown[] }>>;
    };
    const matcher = stored.automations.SchedulerTick?.[0];
    expect(matcher?.name).toBe('nightly-sweep');
    expect(matcher?.cron).toBe('0 3 * * *');
    // Reported id against on-disk id, in that order: the file is the reference,
    // and this way the `unknown` off the wire is the value under test rather
    // than an argument that would need a cast to be accepted.
    expect(structured.automationId).toBe(matcher?.id);
  }, 330_000);
});
