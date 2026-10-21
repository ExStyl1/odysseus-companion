/**
 * F1.638 (origin WJ-bv P-WJbv-1) — the operator's `sessionAllowedTools` NARROWS claude's built-in tools; it does not
 * pre-approve them.
 *
 * ## What was wrong
 *
 * P6.217 projected the whitelist onto `Options.allowedTools`. The SDK's own declaration of that option (`sdk.d.ts`,
 * 0.3.267): "List of tool names that are auto-allowed without prompting for permission. … To restrict which tools are
 * available, use the `tools` option instead." — and `agent-sdk/permissions.md#allow-and-deny-rules`: "`Read` and
 * `Grep` are auto-approved. Other tools not listed here still exist". So the field its own docblock calls a WHITELIST
 * (`config-defaults-schema.ts`) restricted nothing on claude and pre-approved what it named. Measured through the
 * real input (`config.json`, `sessionAllowedTools: ['Bash']`, the vendored 2.1.267 child, rig `work/wjcritb/`,
 * 2026-09-25): the child still listed 68 tools, 21 of them built-in, and the SDK emitted its
 * `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning for `Bash`.
 *
 * ## What these cases pin, through the literal `chatImpl` builds (not a builder's return — P6.1009)
 *
 * (a) A whitelist reaches the SDK as the `tools` list and never as `allowedTools`.
 * (b) CONTROL: absent means unchanged — the `claude_code` preset, no `allowedTools`.
 * (c) The mini agent's own list is narrowed by the whitelist rather than replaced by it (the whitelist is a ceiling).
 * (d) CONTROL for (c): the mini list is unchanged without a whitelist.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, setDefaultTimeout } from 'bun:test';
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackendConfig } from '../backend/types.ts';
import { CONFIG_DIR } from '../../config/paths.ts';

// Importing `claude-agent.ts` is this file's wall-clock cost; the cases are milliseconds (AGENTS.md: size the budget
// against the FILE, not the case).
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
        yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-638', uuid: `init-${captured.length}` };
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

const { ClaudeAgent } = await import('../claude-agent.ts');
const { MINI_AGENT_TOOLS } = await import('../base-agent.ts');

const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
/** The minimum a strict envelope accepts — `session-tool-universe.test.ts`'s seed, where the key lives (P6.912). */
const PRISTINE_CONFIG = { storageLayoutVersion: 2, workspaceRefs: [], activeWorkspaceId: null, activeSessionId: null };
let pristine = '';

beforeAll(() => {
  mkdirSync(CONFIG_DIR, { recursive: true });
  if (!existsSync(CONFIG_PATH)) writeFileSync(CONFIG_PATH, JSON.stringify(PRISTINE_CONFIG, null, 2), 'utf-8');
  pristine = readFileSync(CONFIG_PATH, 'utf-8');
});

afterEach(() => {
  writeFileSync(CONFIG_PATH, pristine, 'utf-8');
  captured.length = 0;
});

function writeConfig(patch: Record<string, unknown>): void {
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...JSON.parse(pristine), ...patch }, null, 2), 'utf-8');
}

const WORKSPACE_ROOT = '/tmp/nessy-f1-638';
let counter = 0;

/** One real turn through `chatImpl`; returns the options the SDK's `query` received. */
async function optionsOfOneTurn(mini = false): Promise<Record<string, unknown>> {
  counter += 1;
  const agent = new ClaudeAgent({
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    ...(mini ? { systemPromptPreset: 'mini' } : {}),
    workspace: {
      id: 'ws-f1-638', name: 'F1.638', rootPath: WORKSPACE_ROOT, workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: {
      id: `session-f1-638-${counter}`, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: WORKSPACE_ROOT,
    } as never,
    onBetweenTurnsEvent: () => {},
  } as BackendConfig);
  try {
    // The fixture's mode is asserted rather than assumed (AGENTS.md, the 2026-09-20 fixture trap).
    expect(agent.isMiniAgent()).toBe(mini);
    const chatImpl = (agent as unknown as { chatImpl: (message: string) => AsyncGenerator<unknown> }).chatImpl.bind(agent);
    for await (const _event of chatImpl('F1.638 one turn')) { /* drain */ }
    expect(captured).toHaveLength(1);
    return captured[0]!;
  } finally {
    agent.destroy();
  }
}

describe('F1.638 — the operator whitelist narrows claude’s built-in tools', () => {
  it('(a) reaches the SDK as the `tools` list, never as `allowedTools`', async () => {
    writeConfig({ sessionAllowedTools: ['Bash', 'Read'] });
    const options = await optionsOfOneTurn();
    // The names the operator wrote, in their order, plus the one tool the host keeps (see the builder's docblock):
    // `ToolSearch` loads the MCP tools the whitelist does not govern.
    expect(options.tools).toEqual(['Bash', 'Read', 'ToolSearch']);
    // Not a pre-approval any more: nothing reaches the SDK's auto-allow list.
    expect('allowedTools' in options).toBe(false);
  });

  it('(b) CONTROL — absent means unchanged: the claude_code preset, and no allowedTools', async () => {
    const options = await optionsOfOneTurn();
    expect(options.tools).toEqual({ type: 'preset', preset: 'claude_code' });
    expect('allowedTools' in options).toBe(false);
  });

  it('(c) narrows the mini agent’s own list instead of replacing it — the whitelist is a ceiling', async () => {
    writeConfig({ sessionAllowedTools: ['Bash', 'WebFetch'] });
    const options = await optionsOfOneTurn(true);
    // `WebFetch` is not a mini tool, so the ceiling cannot add it; `Read`/`Edit`/… are not whitelisted, so they go.
    expect(options.tools).toEqual(['Bash']);
    expect('allowedTools' in options).toBe(false);
  });

  it('(d) CONTROL — the mini list is unchanged without a whitelist', async () => {
    const options = await optionsOfOneTurn(true);
    expect(options.tools).toEqual([...MINI_AGENT_TOOLS]);
    expect('allowedTools' in options).toBe(false);
  });
});
