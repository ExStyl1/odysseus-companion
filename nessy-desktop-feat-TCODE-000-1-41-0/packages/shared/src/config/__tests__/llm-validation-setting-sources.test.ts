/**
 * F1.1185 — the Test / diagnostics probe (`validateAnthropicConnection`) loads
 * no Claude settings file.
 *
 * `agent-sdk/claude-code-features.md#control-filesystem-settings-with-settingsources`:
 * "Omitting `settingSources` is equivalent to `["user", "project", "local"]`",
 * and "To run without these, pass `settingSources: []`". The probe passed no
 * `settingSources` and no `cwd`, so it read `~/.claude/settings.json` and the
 * HOST process cwd's `.claude` files, whose `env` (`ANTHROPIC_BASE_URL`,
 * `CLAUDE_CODE_USE_BEDROCK`, …) outranks the child env F1.966 cleaned — the
 * key being tested went where the file said. F1.981 and F1.1006 pinned that
 * for session spawns only; the side children already pass `[]` (F1.792).
 *
 * At the `query()` seam: the SDK is replaced for this file's own calls only,
 * spread from a snapshot taken before mocking (AGENTS.md §Traps, `mock.module`).
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import * as claudeAgentSdk from '@anthropic-ai/claude-agent-sdk';

const realSdk = { ...claudeAgentSdk };
const realQuery = realSdk.query;

/** Fabricated. Never a real key. */
const FAKE_KEY = 'sk-ant-f1185-FABRICATED-0000';
const CONNECTION_BASE_URL = 'https://f1185-connection.example.invalid';

const captured: Array<Record<string, unknown>> = [];
/** Armed only while this file's own tests run: the last `mock.module` for a specifier is live for other files too. */
let rigArmed = false;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    if (!rigArmed) return (realQuery as unknown as (arg: unknown) => unknown)(input);
    captured.push(input.options);
    async function* answer(): AsyncGenerator<unknown> {
      yield { type: 'assistant', session_id: 'fake-f1185', message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] } };
    }
    return answer();
  },
}));

const { validateAnthropicConnection } = await import('../llm-validation.ts');

beforeAll(() => { rigArmed = true; });
afterAll(() => {
  rigArmed = false;
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk);
});

describe('F1.1185 · the Test / diagnostics probe loads no Claude settings file', () => {
  it('passes `settingSources: []`, so no user, project or local file can move the key under test', async () => {
    captured.length = 0;
    const result = await validateAnthropicConnection({ model: 'claude-sonnet-4-5', apiKey: FAKE_KEY });
    expect(result).toEqual({ success: true });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.settingSources).toEqual([]);
  });

  it('BOUNDARY — the connection\'s own endpoint and key still reach the probe, and it stays tool-less', async () => {
    captured.length = 0;
    await validateAnthropicConnection({ model: 'claude-sonnet-4-5', apiKey: FAKE_KEY, baseUrl: CONNECTION_BASE_URL });
    const env = captured[0]?.env as Record<string, string | undefined> | undefined;
    expect(env?.ANTHROPIC_BASE_URL).toBe(CONNECTION_BASE_URL);
    expect(env?.ANTHROPIC_API_KEY).toBe(FAKE_KEY);
    expect(captured[0]?.tools).toEqual([]);
  });
});
