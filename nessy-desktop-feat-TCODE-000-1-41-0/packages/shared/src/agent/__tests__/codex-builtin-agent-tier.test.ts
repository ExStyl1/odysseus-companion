/**
 * P6.156's codex arm — the bundled agents' inert model TIER, said once per
 * session on codex too.
 *
 * WHAT EACH TEST KILLS:
 *  - "names every bundled agent on a connection with no fast alias" dies if the
 *    mount is removed or the latch inverts: it is the shared sentence, and it is
 *    the only thing that made codex say anything at all here.
 *  - "does not claim uniformity for a tier the other two runtimes resolve" is
 *    the one that must not be simplified away. Passing `undefined` to the shared
 *    builder would have emitted a sentence whose own text says the tier is inert
 *    "the same on Pi, Claude and Codex" for `scout`, whose `small` tier Pi and
 *    claude DO resolve off the gateway `fast` alias — recording a real
 *    per-runtime loss as a shared fact.
 *  - "says once" dies if the latch is dropped: the notice would repeat on every
 *    runtime build (a respawn is not a new fact).
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../../config/paths.ts';
import { addLlmConnection, getLlmConnection } from '../../config/storage.ts';
import { BUILTIN_AGENT_DEFINITIONS } from '../../agents/definitions.ts';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';

const FAST_MODEL = 'tgpt/qwen36-35b-a3b-fp8';

function createConfig(connectionSlug?: string): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-codex-tier',
      name: 'Codex Tier Workspace',
      rootPath: '/tmp/ws-codex-tier-root',
      workspaceRootPath: '/tmp/ws-codex-tier-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-tier',
    } as any,
    session: {
      id: 'session-codex-tier',
      workspaceRootPath: '/tmp/ws-codex-tier-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
    ...(connectionSlug ? { connectionSlug } : {}),
  } as BackendConfig;
}

function harness(connectionSlug?: string) {
  const agent = new CodexAgent(createConfig(connectionSlug));
  const lines: string[] = [];
  const internals = agent as unknown as {
    debug: (message: string) => void;
    noteBuiltinAgentTiersOnce: () => void;
  };
  internals.debug = (message: string) => { lines.push(message); };
  return { lines, note: () => internals.noteBuiltinAgentTiersOnce() };
}

describe('P6.156 · the codex arm of the bundled-agent tier notice', () => {
  it('names every bundled agent when the connection resolves no tier at all', () => {
    const h = harness();
    h.note();
    expect(h.lines).toHaveLength(1);
    for (const definition of BUILTIN_AGENT_DEFINITIONS) {
      expect(h.lines[0]).toContain(definition.name);
    }
  });

  it('does not claim uniformity for the tier Pi and claude resolve', () => {
    const slug = `codex-tier-fast-${Date.now()}`;
    // The isolated config dir starts empty and `addLlmConnection` refuses to
    // create the file, so the fixture makes one. Guarded by the control below:
    // an unwritten connection fails HERE rather than silently turning the case
    // into the previous one.
    mkdirSync(CONFIG_DIR, { recursive: true });
    const configPath = join(CONFIG_DIR, 'config.json');
    if (!existsSync(configPath)) {
      writeFileSync(configPath, JSON.stringify({ storageLayoutVersion: 2, workspaceRefs: [], activeWorkspaceId: null }), 'utf-8');
    }
    addLlmConnection({
      slug,
      name: 'Gateway',
      providerType: 'nessy',
      models: [{ id: FAST_MODEL, shortName: 'fast' }],
    } as any);
    // Positive control: the alias really resolves on this connection, so a
    // failure below is about the notice and not about an unwritten fixture.
    expect(getLlmConnection(slug)?.models?.length).toBe(1);

    const h = harness(slug);
    h.note();
    const small = BUILTIN_AGENT_DEFINITIONS.filter(d => d.tier === 'small').map(d => d.name);
    const others = BUILTIN_AGENT_DEFINITIONS.filter(d => d.tier !== 'small').map(d => d.name);
    expect(small.length).toBeGreaterThan(0);
    const [shared, codexOnly] = h.lines;
    expect(shared).toBeDefined();
    expect(codexOnly).toBeDefined();
    // The shared sentence carries only the tiers that are inert everywhere.
    for (const name of others) expect(shared).toContain(name);
    for (const name of small) expect(shared).not.toContain(name);
    // And the codex-only loss is named, with the model it would have run on.
    for (const name of small) expect(codexOnly).toContain(name);
    expect(codexOnly).toContain(FAST_MODEL);
  });

  it('says it once per agent, not once per runtime build', () => {
    const h = harness();
    h.note();
    h.note();
    h.note();
    expect(h.lines).toHaveLength(1);
  });
});
