/**
 * P6.534 — the AGENT half: the host's bundled-skills switch is read on the codex
 * path too, and only the OFF direction is written.
 *
 * The writer half is
 * `codex-responses-adapter/src/__tests__/config-writer-bundled-skills.test.ts`.
 * The split is the same one `codex-auto-memory-off-switch.test.ts` has: the two
 * live in separate packages and the writer cannot import the host's config
 * store.
 *
 * ## What this row closed
 *
 * `disableBundledSkills` / `NESSY_DISABLE_BUNDLED_SKILLS` reached codex NOWHERE:
 * a cold managed `CODEX_HOME` came back holding codex's own bundled tree — 87
 * entries measured on the shipped `darwin-arm64` build — and the host switch
 * could not touch one of them. Native-first case (1): codex's own
 * `SkillsConfig.bundled.enabled` is the analogue and had never been written
 * (Q-den 76, option 1).
 *
 * WHAT EACH TEST KILLS:
 *  - "off writes the option" dies if the reader is removed — the shipped state.
 *  - "on writes NOTHING" is not that assertion inverted: `enabled = true` would
 *    re-assert a default we did not choose (`BundledSkillsConfig.enabled`
 *    defaults to `true`), the same mistake the memories switch documents.
 *  - "a switch that cannot be read decides nothing" dies if the throw path
 *    starts writing a value. This switch is a RESTRICTION, and inventing one
 *    from a read error removes skills nobody asked to remove.
 *  - the env arm dies if the reader stops composing the two halves — an operator
 *    who set only the env var must get the same codex behaviour as one who set
 *    the settings key.
 *  - the wiring test dies if the reader exists and `writeCodexConfig` stops
 *    being handed it — a knob nothing forwards is the defect wearing a fix.
 */
import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as configStorage from '../../config/storage.ts';
import { DISABLE_BUNDLED_SKILLS_ENV_VAR } from '../../config/bundled-skills-settings.ts';
import type { BackendConfig } from '../backend/types.ts';

// `mock.module` is process-global and bun runs every file in one process, so the
// seam delegates to the real module outside this suite's own fixture and
// `afterAll` puts the untouched module back. The snapshot is taken FIRST:
// restoring from the imported namespace would restore the MOCK.
const realStorage = { ...configStorage };

let storedConfig: unknown = {};

mock.module('../../config/storage.ts', () => ({
  ...realStorage,
  loadStoredConfig: () => {
    if (storedConfig instanceof Error) throw storedConfig;
    return storedConfig;
  },
}));

afterAll(() => {
  mock.module('../../config/storage.ts', () => realStorage);
});

const previousEnv = process.env[DISABLE_BUNDLED_SKILLS_ENV_VAR];
afterEach(() => {
  storedConfig = {};
  // `delete` first, then assign — assigning to a name Bun pre-created a slot for
  // leaves it invisible to `Object.keys` and to every subprocess env built by
  // spreading `process.env` (AGENTS.md §Traps). Unconditional, because the
  // restore path has the same hazard as the set path.
  delete process.env[DISABLE_BUNDLED_SKILLS_ENV_VAR];
  if (previousEnv !== undefined) process.env[DISABLE_BUNDLED_SKILLS_ENV_VAR] = previousEnv;
});

const { CodexAgent } = await import('../codex-agent.ts');

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-codex-bundled-skills',
      name: 'Codex Bundled Skills Workspace',
      rootPath: '/tmp/ws-codex-bundled-skills-root',
      workspaceRootPath: '/tmp/ws-codex-bundled-skills-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-bundled-skills',
    } as never,
    session: {
      id: 'session-codex-bundled-skills',
      workspaceRootPath: '/tmp/ws-codex-bundled-skills-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as never,
    model: 'tgpt/qwen35-397b-a17b-fp8',
    isHeadless: true,
  } as BackendConfig;
}

function option(): { bundledSkillsEnabled?: boolean } {
  // P6.704 (`026a44a42`) gave the BaseAgent constructor a store read of its own
  // — `resolvePlansDirectory(this.workingDirectory)` — so an unreadable config
  // now throws out of `new CodexAgent(...)` before this reader is ever reached,
  // and the "cannot be read" arm was measuring the constructor instead of the
  // switch. Construct against a readable store, then put the fixture in place:
  // the arms stay exactly what they were written to kill, because nothing the
  // constructor reads (`plansDirectory`) is set by any fixture here.
  const fixture = storedConfig;
  storedConfig = {};
  const agent = new CodexAgent(createConfig());
  storedConfig = fixture;
  return (agent as unknown as { codexBundledSkillsOption: () => { bundledSkillsEnabled?: boolean } })
    .codexBundledSkillsOption();
}

describe('P6.534 · the host bundled-skills switch is read on the codex path', () => {
  it('writes the option when the settings key is on', () => {
    storedConfig = { disableBundledSkills: true };
    expect(option()).toEqual({ bundledSkillsEnabled: false });
  });

  it('writes the option when only the env var is set', () => {
    delete process.env[DISABLE_BUNDLED_SKILLS_ENV_VAR];
    process.env[DISABLE_BUNDLED_SKILLS_ENV_VAR] = '1';
    storedConfig = {};
    expect(option()).toEqual({ bundledSkillsEnabled: false });
  });

  it('writes NOTHING when the switch is off — codex keeps its own default', () => {
    storedConfig = { disableBundledSkills: false };
    expect(option()).toEqual({});
  });

  it('writes nothing when the config cannot be read', () => {
    storedConfig = new Error('config unreadable');
    expect(option()).toEqual({});
  });
});

describe('P6.534 · the option reaches the writer', () => {
  const SOURCE = readFileSync(fileURLToPath(new URL('../codex-agent.ts', import.meta.url)), 'utf8');

  it('is spread into the writeCodexConfig call', () => {
    expect(SOURCE).toContain('...this.codexBundledSkillsOption(),');
    const spread = SOURCE.indexOf('...this.codexBundledSkillsOption(),');
    // Inside the `writeCodexConfig({ … })` argument, not merely defined above it.
    expect(SOURCE.slice(0, spread)).toContain('writeCodexConfig({');
  });
});
