/**
 * R29b Task 3 — a fork is inside the parent's session scope, a named subagent is
 * outside it. Asserted at the DELIVERY boundary (the `{ type: 'prompt',
 * systemPrompt }` RPC PiAgent hands its subprocess), not on the resolver
 * helpers: the whole class of defect being fixed here is a rule that exists in
 * one place and is read in none.
 *
 * Both sides are asserted in every case. The fork half of the output-style row
 * was already true by accident — the read was global — so a test that only
 * checked the fork would have passed before the fix and after it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import { getConfigPath, getOutputStyleId, setOutputStyleId } from '../../config/storage.ts';
import { STORAGE_LAYOUT_VERSION } from '../../config/paths.ts';
import { getSessionMemoryFilePath } from '../memory/memory-store.ts';
import { resolveChildOutputStyleId, resolveMemorySessionId } from '../child-session-scope.ts';

const WORKSPACE_ID = 'ws-fork-scope';
const PARENT_SESSION_ID = 'parent-session-fork-scope';
const CHILD_SESSION_ID = 'child-session-fork-scope';
// From the built-in `concise` style. NOT 'Lead with the result' — the base
// prompt's own writing guidance contains that phrase (system.ts:772), which
// would make this assertion pass with the style stripped.
const STYLE_SENTINEL = 'then include only the context needed to act';
const MEMORY_SENTINEL = 'SENTINEL_PARENT_SESSION_MEMORY';

let workspaceRoot: string;
let previousStyle: string;

function config(overrides: Partial<BackendConfig>): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: WORKSPACE_ID,
      name: 'Fork Scope Workspace',
      rootPath: workspaceRoot,
      workspaceRootPath: workspaceRoot,
      sessionRootPath: join(workspaceRoot, 'sessions'),
    } as never,
    session: { id: CHILD_SESSION_ID, workspaceRootPath: workspaceRoot, createdAt: 0, lastUsedAt: 0 } as never,
    isHeadless: true,
    ...overrides,
  } as BackendConfig;
}

/** One real turn; only the subprocess and the manifest are stubbed. */
async function captureSystemPrompt(overrides: Partial<BackendConfig>): Promise<string> {
  const agent = new PiAgent(config(overrides));
  const sent: Array<Record<string, unknown>> = [];
  const internals = agent as unknown as Record<string, unknown>;
  internals.ensureSubprocess = async () => {};
  internals.send = (message: Record<string, unknown>) => { sent.push(message); };
  internals.emitAutomationEvent = async () => {};
  internals.syncExecutionManifestForCurrentTurn = async () => ({
    snapshotGeneration: 'generation-1',
    manifestHash: 'hash-1',
    tools: [],
    deferredMcp: { candidatePiNames: [] },
  });
  const queue = (agent as unknown as Record<string, Record<string, unknown>>).eventQueue!;
  queue.reset = () => {};
  queue.drain = async function* () { yield { type: 'complete' }; };

  try {
    for await (const _event of (agent as unknown as {
      chatImpl(message: string): AsyncGenerator<unknown>
    }).chatImpl('do the task')) { /* drain */ }
  } finally {
    agent.destroy();
  }
  const prompt = sent.find(message => message.type === 'prompt');
  expect(prompt).toBeDefined();
  return prompt!.systemPrompt as string;
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'nessy-fork-scope-'));
  previousStyle = getOutputStyleId();
  // `setOutputStyleId` is a no-op without a config file, and the test config dir
  // starts empty — seed one so the style really is set.
  const configPath = getConfigPath();
  mkdirSync(join(configPath, '..'), { recursive: true });
  if (!existsSync(configPath)) writeFileSync(configPath, `{"storageLayoutVersion":${STORAGE_LAYOUT_VERSION},"workspaceRefs":[],"activeWorkspaceId":null}\n`);
  expect(setOutputStyleId('concise')).toBe(true);
  const memoryPath = getSessionMemoryFilePath(WORKSPACE_ID, PARENT_SESSION_ID);
  mkdirSync(join(memoryPath, '..'), { recursive: true });
  writeFileSync(memoryPath, `# Parent memory\n\n${MEMORY_SENTINEL}\n`);
});

afterEach(() => {
  setOutputStyleId(previousStyle);
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(join(getSessionMemoryFilePath(WORKSPACE_ID, PARENT_SESSION_ID), '..', '..'), { recursive: true, force: true });
});

describe('the output style reaches a fork and only a fork (sub-agents.md:933)', () => {
  it('lands on opposite sides for a fork and a named subagent', async () => {
    const fork = await captureSystemPrompt({ piChildKind: 'fork', childSystemPrompt: '' });
    const named = await captureSystemPrompt({ piChildKind: 'named', childSystemPrompt: 'scout prompt' });

    expect(fork).toContain(STYLE_SENTINEL);
    expect(named).not.toContain(STYLE_SENTINEL);
  });

  it('still applies to the main session, which is what the style is for', async () => {
    const main = await captureSystemPrompt({});
    expect(main).toContain(STYLE_SENTINEL);
  });

  // The AGT-4 live-probe shape: a USER-scope custom style file
  // (`<config>/output-styles/<slug>.md`, selected as `custom:<slug>`) whose
  // body demands a marker token. The builtin case above proves the rule; this
  // binds the custom-file resolution path (`discoverCustomOutputStyles`) the
  // wave fixture actually rides, so a regression scoped to that path cannot
  // hide behind a passing builtin assertion — and the fork half pins that a
  // custom style still reaches a fork (output-styles.md:104's exception).
  it('holds for a user-scope custom style file, the wave-probe shape', async () => {
    const marker = 'OSTYLE-UNIT-CDP-PROBE-MARKER';
    const stylesDir = join(getConfigPath(), '..', 'output-styles');
    mkdirSync(stylesDir, { recursive: true });
    writeFileSync(
      join(stylesDir, 'cdp-probe.md'),
      `---\nname: CDP probe\n---\nEnd every reply with the token ${marker}.\n`,
    );
    try {
      expect(setOutputStyleId('custom:cdp-probe')).toBe(true);
      const fork = await captureSystemPrompt({ piChildKind: 'fork', childSystemPrompt: '' });
      const named = await captureSystemPrompt({ piChildKind: 'named', childSystemPrompt: 'scout prompt' });
      expect(fork).toContain(marker);
      expect(named).not.toContain(marker);
    } finally {
      rmSync(stylesDir, { recursive: true, force: true });
    }
  });
});

describe("the parent's session memory reaches a fork and only a fork (sub-agents.md:1041)", () => {
  it('lands on opposite sides for a fork and a named subagent', async () => {
    const fork = await captureSystemPrompt({
      piChildKind: 'fork',
      piParentSessionId: PARENT_SESSION_ID,
      childSystemPrompt: '',
    });
    // A named subagent never carries a parent session id; even given one, its
    // kind keeps it on its own memory.
    const named = await captureSystemPrompt({
      piChildKind: 'named',
      piParentSessionId: PARENT_SESSION_ID,
      childSystemPrompt: 'scout prompt',
    });

    expect(fork).toContain(MEMORY_SENTINEL);
    expect(named).not.toContain(MEMORY_SENTINEL);
  });

  it('leaves a top-level session reading its own memory', async () => {
    const main = await captureSystemPrompt({});
    expect(main).not.toContain(MEMORY_SENTINEL);
  });
});

describe('the resolvers themselves', () => {
  it('gate on "is this a fork", not on the presence of a child prompt', () => {
    expect(resolveChildOutputStyleId('fork', 'concise')).toBe('concise');
    expect(resolveChildOutputStyleId(undefined, 'concise')).toBe('concise');
    expect(resolveChildOutputStyleId('named', 'concise')).toBeUndefined();

    expect(resolveMemorySessionId({ piChildKind: 'fork', piParentSessionId: 'p' }, 'c')).toBe('p');
    expect(resolveMemorySessionId({ piChildKind: 'named', piParentSessionId: 'p' }, 'c')).toBe('c');
    expect(resolveMemorySessionId({}, 'c')).toBe('c');
    // A fork with no recorded parent falls back to its own id rather than to
    // an empty one; the branch options would have failed the spawn first.
    expect(resolveMemorySessionId({ piChildKind: 'fork' }, 'c')).toBe('c');
  });
});
