/**
 * F1.768 — a project the user kept RESTRICTED must not hand the claude child its `.claude` content.
 *
 * MEASURED before this suite existed (`work/wjcritdd/f1768-probe.ts`: the vendored claude 2.1.267, a
 * loopback Messages stub, the turn-shape options from the product's own `buildClaudeTurnShapeOptions`):
 * with the host's trust at "Keep restricted" the child was handed `settingSources: ['user','project','local']`
 * exactly as for a trusted project, and it ran the project's `.claude/settings.json` `SessionStart` command
 * hook (with the project's `env` block applied), started the command of the project's `.mcp.json` server,
 * and put the project's `CLAUDE.md` and `CLAUDE.local.md` into the model's context.
 * `permissions.md#what-runs-before-you-trust-a-folder` is why: for "`claude -p` or the SDK, folder never
 * trusted" it lists settings-file hooks and the `env` block as "Used" and `.mcp.json` servers as "Connected
 * without asking, approved or not. The SDK loads them only when `settingSources` includes project settings."
 *
 * The host's gate is therefore the list itself: `project` and `local` only for a project the host trusted.
 * These cases pin the options the agent ACTUALLY hands the SDK (the SDK's `query` is captured, the way
 * `claude-session-tool-whitelist.test.ts` captures it), plus the pure gate and the diagnostics fact.
 *
 *   bun scripts/bun-test-lock.ts run --label <lane> -- bun test ./packages/shared/src/agent/__tests__/claude-project-trust-setting-sources.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, setDefaultTimeout } from 'bun:test';
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceClaudeConfigDirPath } from '../options.ts';
import type { BackendConfig } from '../backend/types.ts';
import { CONFIG_DIR } from '../../config/paths.ts';

// Importing `claude-agent.ts` is this file's wall-clock cost; the cases are milliseconds.
setDefaultTimeout(120_000);

const realSdk = { ...sdkPackage };
const captured: Array<Record<string, unknown>> = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    captured.push(input.options);
    const iterator = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    async function* serve(): AsyncGenerator<unknown> {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-768', uuid: `init-${captured.length}` };
        yield {
          type: 'result', subtype: 'success', result: 'ok', num_turns: 1,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        };
      }
    }
    const stream = serve() as AsyncGenerator<unknown> & { interrupt(): Promise<unknown> };
    stream.interrupt = async () => ({ still_queued: [] });
    return stream;
  },
}));

afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk);
});

const agentModule = await import('../claude-agent.ts');
const { ClaudeAgent } = agentModule;
// Read through the namespace so a build WITHOUT the gate still loads this file and fails case by case.
const gate = (agentModule as Record<string, unknown>).claudeSettingSourcesForProjectTrust as
  | ((sources: readonly string[] | undefined, trusted: boolean) => string[] | undefined)
  | undefined;

const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

beforeAll(() => {
  mkdirSync(CONFIG_DIR, { recursive: true });
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify({
      storageLayoutVersion: 2, workspaceRefs: [], activeWorkspaceId: null, activeSessionId: null,
    }, null, 2), 'utf-8');
  }
});

afterEach(() => {
  captured.length = 0;
});

const WORKSPACE_ROOT = '/tmp/nessy-f1-768';
let counter = 0;

async function oneTurn(projectTrusted: boolean | undefined, mini = false, sdkCwd?: string): Promise<{ options: Record<string, unknown>; facts: string }> {
  counter += 1;
  const agent = new ClaudeAgent({
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    ...(projectTrusted === undefined ? {} : { projectTrusted }),
    ...(mini ? { systemPromptPreset: 'mini' } : {}),
    // F1.789 — what SessionManager hands every agent; it decides the child's CLAUDE_CONFIG_DIR.
    ...(sdkCwd ? { envOverrides: { NESSY_WORKSPACE_ID: 'ws-f1-768' } } : {}),
    workspace: {
      id: 'ws-f1-768', name: 'F1.768', rootPath: WORKSPACE_ROOT, workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: {
      id: `session-f1-768-${counter}`, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: sdkCwd ?? WORKSPACE_ROOT,
      ...(sdkCwd ? { sdkCwd } : {}),
    } as never,
    onBetweenTurnsEvent: () => {},
  } as BackendConfig);
  try {
    expect(agent.isMiniAgent()).toBe(mini);
    const chatImpl = (agent as unknown as { chatImpl: (message: string) => AsyncGenerator<unknown> }).chatImpl.bind(agent);
    for await (const _event of chatImpl('F1.768 one turn')) { /* drain */ }
    expect(captured).toHaveLength(1);
    return { options: captured[0]!, facts: agent.getRecentStderr() };
  } finally {
    agent.destroy();
  }
}

describe('F1.768 — the claude child loads project settings only for a project the host trusted', () => {
  it('(a) a restricted project hands the SDK the user source alone, and the diagnostics say why', async () => {
    const { options, facts } = await oneTurn(false);
    expect(options.settingSources).toEqual(['user']);
    expect(options.cwd).toBeDefined();
    expect(facts).toContain('[claude] This project is not trusted in this app');
    expect(facts).toContain('.mcp.json');
  });

  it('(b) no trust decision at all is untrusted — fail-closed, the host-wide rule', async () => {
    const { options } = await oneTurn(undefined);
    expect(options.settingSources).toEqual(['user']);
  });

  it('(c) CONTROL — a trusted project keeps the documented triple and records no fact', async () => {
    const { options, facts } = await oneTurn(true);
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
    expect(facts).not.toContain('This project is not trusted');
  });

  it('(d) the mini branch is gated the same way (one list, both branches)', async () => {
    const restricted = await oneTurn(false, true);
    expect(restricted.options.settingSources).toEqual(['user']);
    captured.length = 0;
    const trusted = await oneTurn(true, true);
    expect(trusted.options.settingSources).toEqual(['user', 'project', 'local']);
  });
});

describe('F1.768 — the pure gate', () => {
  it('drops project and local for an untrusted project, whatever the operator narrowed to', () => {
    expect(typeof gate).toBe('function');
    expect(gate!(undefined, false)).toEqual(['user']);
    expect(gate!(['user', 'project', 'local'], false)).toEqual(['user']);
    expect(gate!(['project', 'local'], false)).toEqual([]);
    expect(gate!([], false)).toEqual([]);
  });

  it('BOUNDARY — a trusted project is byte-identical: absent stays absent, a narrowed list stays as typed', () => {
    expect(typeof gate).toBe('function');
    expect(gate!(undefined, true)).toBeUndefined();
    expect(gate!(['project'], true)).toEqual(['project']);
    expect(gate!([], true)).toEqual([]);
  });
});

describe('F1.789 — a trusted project is trusted by the claude CLI too (its own `hasTrustDialogAccepted`)', () => {
  // The child reads `<CLAUDE_CONFIG_DIR>/.claude.json` (the vendored 2.1.274 bundle: `join(CLAUDE_CONFIG_DIR ||
  // homedir(), ".claude.json")`), and `CLAUDE_CONFIG_DIR` is the Workspace's own directory.
  const claudeJson = (): string => join(workspaceClaudeConfigDirPath('ws-f1-768')!, '.claude.json');
  const project = (): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1789-project-')));
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'src'));
    return root;
  };
  const entryFor = (root: string): unknown => {
    if (!existsSync(claudeJson())) return undefined;
    return (JSON.parse(readFileSync(claudeJson(), 'utf-8')).projects ?? {})[root]?.hasTrustDialogAccepted;
  };

  it('THE CLAIM: a turn in a trusted project writes the entry on the repository root, before the child starts', async () => {
    const root = project();
    const { options } = await oneTurn(true, false, join(root, 'src'));
    expect(options.cwd).toBe(join(root, 'src'));
    expect(entryFor(root)).toBe(true);
  });

  it('NEGATIVE: a restricted project gets no entry, and one left from an earlier trust is withdrawn', async () => {
    const root = project();
    await oneTurn(false, false, root);
    expect(entryFor(root)).toBeUndefined();
    captured.length = 0;
    await oneTurn(true, false, root);
    expect(entryFor(root)).toBe(true);
    captured.length = 0;
    await oneTurn(false, false, root);
    expect(entryFor(root)).toBe(false);
  });
});
