/**
 * F1.666 + F1.674 — every claude SIDE child the host spawns is tool-less: `tools: []`, with or without the operator's
 * `sessionAllowedTools`. The MAIN child is untouched (F1.638 governs it).
 *
 * ## What was wrong
 *
 * The host spawns two claude children outside the main session, and neither passed `tools` at all:
 * `ClaudeAgent.queryLlm` — the route of `call_llm`, `advisor_consult` and `/btw` (`BaseAgent.preExecuteCallLlm`,
 * `consultAdvisor`, `askSideQuestion`) — and `ClaudeAgent.runMiniCompletion` (titles, summaries, the branch fallback).
 * With `tools` undefined the SDK sends no `--tools` flag, so each child ran with Claude Code's default built-in set,
 * outside the host's PreToolUse gate and credential floor (neither child carries `hooks`, `canUseTool` or the flag
 * settings the main child gets). Measured on the vendored 2.1.267 (rig `work/wjcritl/`, 2026-09-25): both children
 * offered their model the CLI's 22 default built-ins whatever the whitelist said; a `Read` the `queryLlm` child asked
 * for, of a file inside its cwd, came back with the contents and no card; and with NO whitelist and the child's cwd at
 * `/`, a `Read` of a file under `$HOME` did too — on every default install, one `mcp__session__call_llm` call away.
 *
 * F1.666 (`a1e68cff3`) emptied the list under a whitelist only; F1.674 empties it always. Both children are tool-less
 * by their own contracts — for `/btw` the page itself, `interactive-mode.md#side-questions-with-/btw`: "No tool access:
 * side questions answer only from what is already in context".
 *
 * ## What these cases pin, through the real methods (the SDK's `query` is the only double)
 *
 * (a) Under a whitelist the `queryLlm` child gets `tools: []` — no built-in tool at all.
 * (b) The same for the `runMiniCompletion` child.
 * (c) The `/btw` route (`askSideQuestion`) reaches (a); `advisor_consult` and `call_llm` ride the same method.
 * (d) Structured output survives: `outputFormat` is still passed, and the child keeps its own `StructuredOutput` tool
 *     with `tools: []` (measured, rig arm `raw-empty-schema`).
 * (e) With NO whitelist both side children get `tools: []` too (F1.674) — the default install.
 * (f) CONTROL: the MAIN child's `tools` is F1.638's answer, with and without a whitelist — this row does not touch it.
 * (g) F1.698 — `tools: []` removes BUILT-INS only: without `strictMcpConfig` the CLI's own MCP discovery (a
 *     `~/.claude.json` server, a cwd `.mcp.json` server, plugins) still connected servers and offered their tools to a
 *     `tools: []` child (measured on the vendored 2.1.267, rig DN-065, 2026-09-26; with the flag: zero servers, zero
 *     tools, `StructuredOutput` kept). Both side children pass the SDK's own `strictMcpConfig: true`.
 * (h) CONTROL for (g): the MAIN child leaves `strictMcpConfig` unset (Q-den 65 = option 2, `claudeCliDiscoveredMcpNotice`).
 * (i) F1.792 (+ F1.675) — with `settingSources` unset (= all three, `agent-sdk/claude-code-features.md`) a side child
 *     loaded the user, project and local CLAUDE.md into its first request and FIRED every tier's SessionStart,
 *     UserPromptSubmit, Stop and SessionEnd hooks, all from the host process's cwd (measured on the vendored 2.1.267,
 *     rig DN-075, 2026-09-26: 3 CLAUDE.md markers and 12 hook markers; with `settingSources: []` zero of either). Both
 *     side children and the `/btw` route pass the SDK's own `settingSources: []`, whatever the operator's env var says.
 * (j) CONTROL for (i): the MAIN child keeps its own list — `['user']` for an untrusted project (F1.768).
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
    const result = {
      type: 'result', subtype: 'success', result: 'F1.666 ok', num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
    // A STRING prompt is a one-shot side child; the async-iterable prompt is the main live child (F1.638's double).
    if (typeof input.prompt === 'string') {
      return (async function* serveSide(): AsyncGenerator<unknown> {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'F1.666 ok' }] } };
        yield result;
      })();
    }
    const iterator = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    async function* serveMain(): AsyncGenerator<unknown> {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-674', uuid: `init-${captured.length}` };
        yield result;
      }
    }
    const stream = serveMain() as AsyncGenerator<unknown> & { interrupt(): Promise<unknown> };
    stream.interrupt = async () => ({ still_queued: [] });
    return stream;
  },
}));

afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk);
});

const { ClaudeAgent } = await import('../claude-agent.ts');

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

const WORKSPACE_ROOT = '/tmp/nessy-f1-666';
let counter = 0;

type SideChildAgent = InstanceType<typeof ClaudeAgent>;

/** One real spawn; returns the options the SDK's `query` received for it. */
async function optionsOf(
  spawn: (agent: SideChildAgent) => Promise<unknown>,
  miniModel = 'claude-haiku-4-5',
): Promise<Record<string, unknown>> {
  counter += 1;
  const agent = new ClaudeAgent({
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    miniModel,
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-f1-666', name: 'F1.666', rootPath: WORKSPACE_ROOT, workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: {
      id: `session-f1-666-${counter}`, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: WORKSPACE_ROOT,
    } as never,
    onBetweenTurnsEvent: () => {},
  } as BackendConfig);
  try {
    await spawn(agent);
    expect(captured).toHaveLength(1);
    return captured[0]!;
  } finally {
    agent.destroy();
  }
}

const queryLlm = (agent: SideChildAgent) => agent.queryLlm({ prompt: 'F1.666 side question' });
const miniCompletion = (agent: SideChildAgent) => agent.runMiniCompletion('F1.666 title please');
/** One real main turn through `chatImpl`, as F1.638's `claude-session-tool-whitelist.test.ts` drives it. */
async function mainTurn(agent: SideChildAgent): Promise<void> {
  const chatImpl = (agent as unknown as { chatImpl: (message: string) => AsyncGenerator<unknown> }).chatImpl.bind(agent);
  for await (const _event of chatImpl('F1.674 main turn')) { /* drain */ }
}

describe('F1.666 + F1.674 — the claude side children are tool-less', () => {
  it('(a) the queryLlm child (call_llm / advisor_consult / /btw) gets no built-in tool under a whitelist', async () => {
    writeConfig({ sessionAllowedTools: ['Bash', 'Read'] });
    const options = await optionsOf(queryLlm);
    expect(options.tools).toEqual([]);
    expect('allowedTools' in options).toBe(false);
  });

  it('(b) the runMiniCompletion child (titles, summaries) gets no built-in tool under a whitelist', async () => {
    writeConfig({ sessionAllowedTools: ['Bash', 'Read'] });
    const options = await optionsOf(miniCompletion);
    expect(options.tools).toEqual([]);
    expect('allowedTools' in options).toBe(false);
  });

  it('(c) the /btw route (askSideQuestion) reaches the same tool-less child', async () => {
    writeConfig({ sessionAllowedTools: ['Bash'] });
    const options = await optionsOf(agent => agent.askSideQuestion({ question: 'F1.666 btw', transcript: [] }));
    expect(options.tools).toEqual([]);
  });

  it('(d) structured output survives: outputFormat is still passed beside tools: []', async () => {
    writeConfig({ sessionAllowedTools: ['Bash'] });
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
    const options = await optionsOf(agent => agent.queryLlm({ prompt: 'F1.666 schema', outputSchema: schema }));
    expect(options.tools).toEqual([]);
    expect(options.outputFormat).toEqual({ type: 'json_schema', schema });
  });

  it('(e) F1.674 — with NO whitelist (the default install) both side children get tools: [] too', async () => {
    const llm = await optionsOf(queryLlm);
    expect(llm.tools).toEqual([]);
    captured.length = 0;
    const mini = await optionsOf(miniCompletion);
    expect(mini.tools).toEqual([]);
  });

  it('(f) CONTROL — the MAIN child keeps F1.638’s answer, with and without a whitelist', async () => {
    const without = await optionsOf(mainTurn);
    expect(without.tools).toEqual({ type: 'preset', preset: 'claude_code' });
    captured.length = 0;
    writeConfig({ sessionAllowedTools: ['Bash'] });
    const withWhitelist = await optionsOf(mainTurn);
    expect(withWhitelist.tools).toEqual(['Bash', 'ToolSearch']);
  });

  it('(g) F1.698 — both side children pass strictMcpConfig: true, so no CLI-discovered MCP server joins them', async () => {
    const llm = await optionsOf(queryLlm);
    expect(llm.strictMcpConfig).toBe(true);
    captured.length = 0;
    const mini = await optionsOf(miniCompletion);
    expect(mini.strictMcpConfig).toBe(true);
    captured.length = 0;
    const btw = await optionsOf(agent => agent.askSideQuestion({ question: 'F1.698 btw', transcript: [] }));
    expect(btw.strictMcpConfig).toBe(true);
  });

  it('(h) CONTROL for (g) — the MAIN child leaves strictMcpConfig unset (Q-den 65)', async () => {
    const main = await optionsOf(mainTurn);
    expect('strictMcpConfig' in main).toBe(false);
  });

  it('(i) F1.792 — both side children pass settingSources: [], so no settings file, hook or CLAUDE.md loads', async () => {
    const llm = await optionsOf(queryLlm);
    expect(llm.settingSources).toEqual([]);
    captured.length = 0;
    const mini = await optionsOf(miniCompletion);
    expect(mini.settingSources).toEqual([]);
    captured.length = 0;
    const btw = await optionsOf(agent => agent.askSideQuestion({ question: 'F1.792 btw', transcript: [] }));
    expect(btw.settingSources).toEqual([]);
  });

  it('(j) CONTROL for (i) — the MAIN child keeps its own list: the user tier for an untrusted project (F1.768)', async () => {
    const main = await optionsOf(mainTurn);
    expect(main.settingSources).toEqual(['user']);
  });

  // F1.1214 — platform.claude.com/docs/en/build-with-claude/thinking.md, the per-model table: `"disabled"` is a
  // "400 error" on Claude Opus 5.5, Sonnet 5.5, Fable 5.1 and Fable 5. A mini model of that class runs adaptive at
  // `low` effort (the lowest the API allows); Haiku 4.5 ("Thinking off" for `"disabled"`) keeps the old shape.
  it('(k) F1.1214 — the mini child never sends thinking disabled to an always-on model', async () => {
    const opus55 = await optionsOf(miniCompletion, 'claude-opus-5-5');
    expect(opus55.thinking).toEqual({ type: 'adaptive' });
    expect(opus55.effort).toBe('low');
    captured.length = 0;
    const haiku = await optionsOf(miniCompletion);
    expect(haiku.thinking).toEqual({ type: 'disabled' });
    expect('effort' in haiku).toBe(false);
  });

  // F1.1110 (origin DN-075) — every side-child call wrote its own transcript, one `.jsonl` per call under the Claude
  // config dir's `projects/<host-cwd slug>/` (rig-observed by DN-075, 2026-09-26). A side child is never resumed, so it
  // passes the SDK's own `persistSession: false` ("When false, disables session persistence to disk", `sdk.d.ts`;
  // `agent-sdk/typescript.md` Options); `claude-persist-session-e2e.test.ts` measured that option writing no `.jsonl`.
  it('(l) F1.1110 — both side children and the /btw route pass persistSession: false, so no transcript file is written', async () => {
    const llm = await optionsOf(queryLlm);
    expect(llm.persistSession).toBe(false);
    captured.length = 0;
    const mini = await optionsOf(miniCompletion);
    expect(mini.persistSession).toBe(false);
    captured.length = 0;
    const btw = await optionsOf(agent => agent.askSideQuestion({ question: 'F1.1110 btw', transcript: [] }));
    expect(btw.persistSession).toBe(false);
  });

  it('(m) CONTROL for (l) — the MAIN child keeps the SDK default (persisted, resumable) on a default install', async () => {
    const main = await optionsOf(mainTurn);
    expect(main.persistSession).not.toBe(false);
  });

  // F1.1109 (origin DN-075) — `settingSources: []` leaves the auto memory keyed by the host process's cwd loading (rig
  // DN-075: the MEMORY.md marker still reached the first request); `agent-sdk/claude-code-features.md`'s isolation
  // warning pairs the option with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in `env`, the runtime's own switch.
  const memoryOff = (options: Record<string, unknown>): unknown =>
    (options.env as Record<string, string | undefined> | undefined)?.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  it('(n) F1.1109 — both side children and the /btw route switch the runtime\'s auto memory off in their env', async () => {
    const llm = await optionsOf(queryLlm);
    expect(memoryOff(llm)).toBe('1');
    captured.length = 0;
    const mini = await optionsOf(miniCompletion);
    expect(memoryOff(mini)).toBe('1');
    captured.length = 0;
    const btw = await optionsOf(agent => agent.askSideQuestion({ question: 'F1.1109 btw', transcript: [] }));
    expect(memoryOff(btw)).toBe('1');
  });

  it('(o) CONTROL for (n) — the MAIN child keeps the session\'s own memory switch (on by default)', async () => {
    const main = await optionsOf(mainTurn);
    expect(memoryOff(main)).not.toBe('1');
  });
});
