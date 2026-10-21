/**
 * P6.166 — the AGENT half: the host's one auto-memory switch is read on the
 * codex path too, and only the OFF direction is written.
 *
 * The writer half and the measurement that justifies it live in
 * `codex-responses-adapter/src/__tests__/config-writer-memories.test.ts`. This
 * file is the reader: `getMemoryEnabled()` → `CodexConfigOptions.memoriesEnabled`.
 * The two are separate because they are in separate packages and the writer
 * cannot import the host's config store — the same split
 * `claude-auto-memory-off-switch.test.ts` has for the claude arm.
 *
 * WHAT EACH TEST KILLS:
 *  - "off writes the option" dies if the reader is removed — the shipped state,
 *    where a user who turned memory off and switched to codex got it back on.
 *  - "on writes NOTHING" is not the same assertion inverted. Writing our `true`
 *    would re-assert a default we did not choose on a subsystem whose defaults
 *    are codex's, which is the mistake `applyAutoMemoryOffSwitch` documents for
 *    the claude spelling ("`0` does not mean permitted, it FORCES memory on").
 *  - "a switch that cannot be read decides nothing" dies if the throw path
 *    starts writing a value. A config we could not read is not a user's choice.
 *  - the wiring test dies if the reader exists and `writeCodexConfig` stops
 *    being handed it — a knob nothing forwards is the defect wearing a fix.
 */
import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as configStorage from '../../config/storage.ts';
import type { BackendConfig } from '../backend/types.ts';

// `mock.module` is process-global and bun runs every file in one process, so the
// seam delegates to the real module outside this suite's own fixture and
// `afterAll` puts the untouched module back. The snapshot is taken FIRST:
// restoring from the imported namespace would restore the MOCK.
const realStorage = { ...configStorage };

let memoryEnabled: boolean | Error = true;

mock.module('../../config/storage.ts', () => ({
  ...realStorage,
  getMemoryEnabled: () => {
    if (memoryEnabled instanceof Error) throw memoryEnabled;
    return memoryEnabled;
  },
}));

afterAll(() => {
  mock.module('../../config/storage.ts', () => realStorage);
});

afterEach(() => { memoryEnabled = true; });

const { CodexAgent } = await import('../codex-agent.ts');

function createConfig(override?: { read?: boolean; write?: boolean }): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-codex-memories',
      name: 'Codex Memories Workspace',
      rootPath: '/tmp/ws-codex-memories-root',
      workspaceRootPath: '/tmp/ws-codex-memories-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-memories',
    } as never,
    session: {
      id: 'session-codex-memories',
      workspaceRootPath: '/tmp/ws-codex-memories-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
      ...(override ? { memoryScopeOverride: override } : {}),
    } as never,
    model: 'tgpt/qwen35-397b-a17b-fp8',
    isHeadless: true,
  } as BackendConfig;
}

function option(override?: { read?: boolean; write?: boolean }): { memoriesEnabled?: boolean } {
  const agent = new CodexAgent(createConfig(override));
  return (agent as unknown as { codexMemoriesOption: () => { memoriesEnabled?: boolean } })
    .codexMemoriesOption();
}

describe('P6.166 · the host auto-memory switch is read on the codex path', () => {
  it('writes the option when the switch is off', () => {
    memoryEnabled = false;
    expect(option()).toEqual({ memoriesEnabled: false });
  });

  it('writes NOTHING when the switch is on', () => {
    memoryEnabled = true;
    expect(option()).toEqual({});
  });

  it('writes nothing when the switch cannot be read', () => {
    memoryEnabled = new Error('config unreadable');
    expect(option()).toEqual({});
  });
});

/**
 * P6.754 — the config table and the wire answer THE SAME question.
 *
 * `codexMemoriesOption` used to read the app-wide switch alone while
 * `applyCodexThreadMemoryMode` resolved this chat's scope, so for a chat with an
 * override the two disagreed and the wire won only because it is sent later.
 * That made a refused `thread/memoryMode/set` — it is `#[experimental]` — silently
 * decide the chat's memory the other way.
 *
 * The per-chat value belongs in this config BECAUSE the config is per-chat:
 * `createRuntime` mints a fresh `CODEX_HOME` with `mkdtempSync` per runtime.
 *
 * WHAT EACH TEST KILLS: the first dies if the option goes back to reading the
 * global switch alone (the opted-out chat's table disappears); the second dies
 * the same way in the opposite direction (an opted-IN chat keeps a table that
 * turns its memory off); the third dies if either site stops routing through
 * `projectSessionMemoryScopeToCodex`, which is what makes the agreement
 * structural rather than two conditions that happen to match today.
 */
describe('P6.754 · [memories] follows this chat\'s scope, not the app-wide switch alone', () => {
  it('an opted-OUT chat gets the table even while the app-wide switch is ON', () => {
    memoryEnabled = true;
    expect(option({ read: false, write: false })).toEqual({ memoriesEnabled: false });
  });

  it('an opted-IN chat gets NO table even while the app-wide switch is OFF', () => {
    memoryEnabled = false;
    expect(option({ read: true, write: true })).toEqual({});
  });

  it('one axis off is the same lossy conjunction the wire sends', () => {
    memoryEnabled = true;
    // `projectSessionMemoryScopeToCodex` is `read && write`, so half-on is off.
    expect(option({ write: false })).toEqual({ memoriesEnabled: false });
    expect(option({ read: false })).toEqual({ memoriesEnabled: false });
  });

  it('both sites collapse the two axes in the ONE place that knows how', () => {
    const source = readFileSync(fileURLToPath(new URL('../codex-agent.ts', import.meta.url)), 'utf8');
    // The config site and the wire site each reach the shared projection —
    // `buildCodexThreadMemoryModeSetParams` is its wire-side caller.
    expect(source).toContain('projectSessionMemoryScopeToCodex(scope)');
    expect(source).toContain('buildCodexThreadMemoryModeSetParams(threadId, scope)');
  });
});

describe('P6.166 · the option reaches the writer', () => {
  const SOURCE = readFileSync(fileURLToPath(new URL('../codex-agent.ts', import.meta.url)), 'utf8');

  it('is spread into the writeCodexConfig call, after the other explicit-only options', () => {
    expect(SOURCE).toContain('...this.codexMemoriesOption(),');
    const spread = SOURCE.indexOf('...this.codexMemoriesOption(),');
    // It has to be inside the `writeCodexConfig({ … })` argument, not merely
    // defined somewhere above it.
    expect(SOURCE.slice(0, spread)).toContain('writeCodexConfig({');
  });
});

/**
 * P6.390 — the CODEX arm of the per-chat memory scope.
 *
 * The per-chat override is a property of one thread, and codex has a
 * control for exactly that — `thread/memoryMode/set`, `#[experimental]` at
 * `rust-v0.148.0`, reachable because `initialize` already declares
 * `experimentalApi: true`. So this is the native mechanism projected onto,
 * rather than a second switch built beside it.
 */
describe('P6.390 · this chat\'s memory scope is sent as codex\'s own thread memory mode', () => {
  interface Sent { method: string; params: unknown }

  async function sendFor(
    override: { read?: boolean; write?: boolean } | undefined,
    options: { refuse?: boolean } = {},
  ): Promise<Sent[]> {
    const sent: Sent[] = [];
    const client = {
      request: async (method: string, params: unknown) => {
        sent.push({ method, params });
        if (options.refuse) throw new Error('thread/memoryMode/set requires experimentalApi capability');
        return {};
      },
    };
    const config = createConfig();
    (config.session as unknown as { memoryScopeOverride?: unknown }).memoryScopeOverride = override;
    const agent = new CodexAgent(config);
    await (agent as unknown as {
      applyCodexThreadMemoryMode: (c: unknown, id: string, by: string) => Promise<void>;
    }).applyCodexThreadMemoryMode(client, 'thread-1', 'thread/start');
    return sent;
  }

  it('sends `enabled` when nothing is turned off — the mode is PERSISTED per thread', async () => {
    // The reason the fully-on case is not skipped: codex stores the mode in its
    // own state DB, so a chat excluded once would stay excluded for ever if
    // nothing ever said `enabled` again.
    memoryEnabled = true;
    expect(await sendFor(undefined)).toEqual([
      { method: 'thread/memoryMode/set', params: { threadId: 'thread-1', mode: 'enabled' } },
    ]);
  });

  it('sends `disabled` when the chat turned an axis off, without touching the global switch', async () => {
    memoryEnabled = true;
    expect((await sendFor({ read: false }))[0]?.params).toEqual({ threadId: 'thread-1', mode: 'disabled' });
    // The conjunction: one codex enum over two axes, so either axis closes it.
    expect((await sendFor({ write: false }))[0]?.params).toEqual({ threadId: 'thread-1', mode: 'disabled' });
  });

  it('lets the chat opt back IN over an app-wide off switch — the override wins in either direction', async () => {
    memoryEnabled = false;
    expect((await sendFor(undefined))[0]?.params).toEqual({ threadId: 'thread-1', mode: 'disabled' });
    expect((await sendFor({ read: true, write: true }))[0]?.params)
      .toEqual({ threadId: 'thread-1', mode: 'enabled' });
  });

  it('sends NOTHING when the switch cannot be read, and never fails the runtime build', async () => {
    memoryEnabled = new Error('config unreadable');
    expect(await sendFor(undefined)).toEqual([]);
    memoryEnabled = true;
    // A server without the experimental capability names itself; the thread keeps
    // its own mode and the session still starts.
    expect(sendFor(undefined, { refuse: true })).resolves.toHaveLength(1);
  });

  it('is called at the ONE point every thread-open path converges on', () => {
    const source = readFileSync(fileURLToPath(new URL('../codex-agent.ts', import.meta.url)), 'utf8');
    expect(source).toContain('await this.applyCodexThreadMemoryMode(client, threadId, openedBy);');
    // After the id exists and before the runtime is published, so `thread/start`,
    // `thread/resume` and `thread/fork` are all covered by that one line.
    const call = source.indexOf('await this.applyCodexThreadMemoryMode(');
    expect(source.slice(0, call)).toContain('const threadId = threadResult.thread?.id ?? null;');
  });
});
