/**
 * P6.588 — `CLAUDE_CODE_DISABLE_CLAUDE_MDS` has exactly one reader, and it is
 * the host's, so the same variable answers the same way on all three runtimes.
 *
 * `env-vars.md#variables`: *"Set to `1` to prevent loading any CLAUDE.md memory
 * files into context, including user, project, and auto memory files"*.
 *
 * The positive and the negative arm run over ONE fixture so the difference
 * between them is the variable and nothing else.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  DISABLE_INSTRUCTION_FILES_ENV,
  buildNativeCapabilityInventory,
  resetInstructionFilesDisabledNotice,
} from '../native-sources.ts';
import type { WorkspacePolicyContext } from '../types.ts';

const roots: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/**
 * Set or clear the variable the Bun-safe way: `delete` FIRST, then assign.
 * Assigning over a name Bun pre-created a slot for leaves it readable by
 * property and invisible to `Object.keys`/spread, and every subprocess env in
 * this tree is built by spreading `process.env`. This name is not one of those
 * today; the shape is unconditional because that list cannot be complete.
 */
function setEnv(value: string | undefined): void {
  delete process.env[DISABLE_INSTRUCTION_FILES_ENV];
  if (value !== undefined) process.env[DISABLE_INSTRUCTION_FILES_ENV] = value;
  resetInstructionFilesDisabledNotice();
}

afterEach(() => {
  setEnv(undefined);
  while (roots.length) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  configDir: string;
  workspaceRoot: string;
  env: { configDir: string; homeAgentsSkillsDir: string; adminSkillsDirs: readonly string[] };
}

function makeFixture(): Fixture {
  const configDir = tmp('mds-config-');
  const homeSkills = tmp('mds-home-skills-');
  const workspaceRoot = tmp('mds-ws-');
  // One of every family the variable is supposed to reach.
  writeFileSync(join(configDir, 'MEMORY.md'), '# Memory\n- a user memory line\n');
  writeFileSync(join(workspaceRoot, 'CLAUDE.md'), '# project instructions\n');
  const rulesDir = join(workspaceRoot, '.agents', 'rules');
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(rulesDir, 'app.md'), '---\npaths: packages/app/**\n---\nApp rule.');
  // A skill, as the control that only MEMORY families are withheld.
  const skillDir = join(configDir, 'skills', 'shared');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: shared\ndescription: shared skill\n---\nBody');
  return {
    configDir,
    workspaceRoot,
    env: { configDir, homeAgentsSkillsDir: homeSkills, adminSkillsDirs: [] },
  };
}

function context(fx: Fixture): WorkspacePolicyContext {
  return {
    workspaceId: 'ws-uuid-1',
    workspaceRootPath: fx.workspaceRoot,
    projectTrustState: 'trusted',
    workingDirectory: fx.workspaceRoot,
    projectKey: 'proj-1',
  } as WorkspacePolicyContext;
}

describe('CLAUDE_CODE_DISABLE_CLAUDE_MDS', () => {
  it('loads instruction, memory and rule layers when it is unset (control)', () => {
    const fx = makeFixture();
    setEnv(undefined);
    const { records } = buildNativeCapabilityInventory(context(fx), fx.env);
    expect(records.some(r => r.kind === 'memory' && r.logicalName === 'MEMORY.md')).toBe(true);
    expect(records.some(r => r.kind === 'instruction' && r.logicalName === 'CLAUDE.md')).toBe(true);
    expect(records.some(r => r.kind === 'memory' && r.memoryFormat === 'rule')).toBe(true);
    expect(records.some(r => r.kind === 'skill')).toBe(true);
  });

  it('withholds every instruction, memory and rule layer when it is set, and says so once', () => {
    const fx = makeFixture();
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      setEnv('1');
      const { records } = buildNativeCapabilityInventory(context(fx), fx.env);
      expect(records.some(r => r.kind === 'memory')).toBe(false);
      expect(records.some(r => r.kind === 'instruction')).toBe(false);
      // The control: it is a MEMORY switch, not an everything switch.
      expect(records.some(r => r.kind === 'skill')).toBe(true);
    } finally {
      console.warn = realWarn;
    }
    // Transparent, and latched: one line naming the variable, not one per file.
    expect(warnings.filter(line => line.includes(DISABLE_INSTRUCTION_FILES_ENV))).toHaveLength(1);
  });

  it('reads a standard boolean, so `0` leaves the layers loading', () => {
    const fx = makeFixture();
    setEnv('0');
    const { records } = buildNativeCapabilityInventory(context(fx), fx.env);
    expect(records.some(r => r.kind === 'instruction' && r.logicalName === 'CLAUDE.md')).toBe(true);
  });
});
