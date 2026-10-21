/**
 * S1 — instruction files BELOW the working directory.
 *
 * `memory.md:157` whole: "Claude also discovers `CLAUDE.md` and
 * `CLAUDE.local.md` files in subdirectories under your current working
 * directory. Instead of loading them at launch, they are included when Claude
 * reads files in those subdirectories." `:63` from the other side: files "in the
 * directory hierarchy above the working directory are loaded in full at launch.
 * Files in subdirectories load on demand when Claude reads files in those
 * directories."
 *
 * Discovery used to walk ANCESTORS ONLY, so a monorepo package's own
 * `AGENTS.md` reached the model on no path at all. The first test here is that
 * gap, pinned from the inventory side; the rest pin the on-read walk.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  MAX_NESTED_INSTRUCTION_FILES,
  MAX_NESTED_INSTRUCTION_FILE_BYTES,
  buildNativeCapabilityInventory,
  discoverNestedInstructionFiles,
} from '../native-sources.ts';
import type { WorkspacePolicyContext } from '../types.ts';

const roots: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** A monorepo: a root contract, a package contract, and a file under it. */
function monorepo(): { project: string; trigger: string } {
  const project = tmp('nested-proj-');
  writeFileSync(join(project, 'AGENTS.md'), 'root contract');
  mkdirSync(join(project, 'packages', 'foo', 'src'), { recursive: true });
  writeFileSync(join(project, 'packages', 'foo', 'AGENTS.md'), 'foo package contract');
  writeFileSync(join(project, 'packages', 'foo', 'src', 'x.ts'), 'export const x = 1;');
  return { project, trigger: join(project, 'packages', 'foo', 'src', 'x.ts') };
}

describe('the eager inventory never reaches below the working directory', () => {
  it('records the cwd instruction file and not the package one', () => {
    const { project } = monorepo();
    const context: WorkspacePolicyContext = {
      workspaceId: 'ws',
      workspaceRootPath: tmp('nested-ws-'),
      projectTrustState: 'trusted',
      projectTrustRevision: '1',
      projectRoot: project,
      workingDirectory: project,
      projectKey: 'pk' as WorkspacePolicyContext['projectKey'],
    };
    const { records } = buildNativeCapabilityInventory(context, {
      configDir: tmp('nested-cfg-'),
      homeAgentsSkillsDir: tmp('nested-home-'),
      instructionExcludes: [],
      // P2.455 — pinned OFF: the administrator tier's DEFAULT roots are absolute
      // machine-wide directories, so an unpinned rig reads the REAL ones on a
      // centrally managed host and a fixture everywhere else. `[]` means "no
      // administrator tier"; the standing guard is `admin-skills-dirs-pinned.test.ts`.
      adminSkillsDirs: [],
    });
    const instructions = records.filter(record => record.kind === 'instruction').map(record => record.sourcePath);
    expect(instructions).toContain(join(project, 'AGENTS.md'));
    // The gap this task closes: eager discovery walks ancestors only.
    expect(instructions).not.toContain(join(project, 'packages', 'foo', 'AGENTS.md'));
  });
});

describe('discoverNestedInstructionFiles', () => {
  it('returns the package instruction file when a file under it is read', () => {
    const { project, trigger } = monorepo();
    const found = discoverNestedInstructionFiles(trigger, project);
    expect(found.map(file => file.absolutePath)).toEqual([
      join(project, 'packages', 'foo', 'AGENTS.md'),
    ]);
    expect(found[0]!.content).toBe('foo package contract');
    expect(found[0]!.fileName).toBe('AGENTS.md');
  });

  it('returns every file between the read file and the cwd, outermost first', () => {
    const { project, trigger } = monorepo();
    // memory.md:155 — "content is ordered from the filesystem root down to your
    // working directory", so the nearest file must land LAST.
    writeFileSync(join(project, 'packages', 'CLAUDE.md'), 'packages layer');
    writeFileSync(join(project, 'packages', 'foo', 'src', 'CLAUDE.md'), 'src layer');
    expect(discoverNestedInstructionFiles(trigger, project).map(file => file.absolutePath)).toEqual([
      join(project, 'packages', 'CLAUDE.md'),
      join(project, 'packages', 'foo', 'AGENTS.md'),
      join(project, 'packages', 'foo', 'src', 'CLAUDE.md'),
    ]);
  });

  it('keeps all three documented names', () => {
    const { project, trigger } = monorepo();
    const dir = join(project, 'packages', 'foo');
    writeFileSync(join(dir, 'CLAUDE.md'), 'claude layer');
    writeFileSync(join(dir, 'CLAUDE.local.md'), 'local layer');
    expect(discoverNestedInstructionFiles(trigger, project).map(file => file.fileName))
      .toEqual(['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md']);
  });

  it('never returns the working directory\'s own file, which loads eagerly', () => {
    const { project, trigger } = monorepo();
    expect(discoverNestedInstructionFiles(trigger, project).map(file => file.absolutePath))
      .not.toContain(join(project, 'AGENTS.md'));
  });

  it('returns nothing for a file outside the working directory', () => {
    const { project } = monorepo();
    const outside = tmp('nested-outside-');
    writeFileSync(join(outside, 'AGENTS.md'), 'someone else');
    expect(discoverNestedInstructionFiles(join(outside, 'x.ts'), project)).toEqual([]);
  });

  it('skips a file that is already loaded and one the excludes matcher rejects', () => {
    const { project, trigger } = monorepo();
    const packageFile = join(project, 'packages', 'foo', 'AGENTS.md');
    expect(discoverNestedInstructionFiles(trigger, project, {
      alreadyLoaded: new Set([packageFile]),
    })).toEqual([]);
    expect(discoverNestedInstructionFiles(trigger, project, {
      isExcluded: path => path === packageFile,
    })).toEqual([]);
  });

  it('honours the accumulation cap', () => {
    const project = tmp('nested-deep-');
    let dir = project;
    const depth = MAX_NESTED_INSTRUCTION_FILES + 4;
    for (let level = 0; level < depth; level += 1) {
      dir = join(dir, `level${level}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'AGENTS.md'), `level ${level}`);
    }
    const trigger = join(dir, 'x.ts');
    writeFileSync(trigger, 'x');
    expect(discoverNestedInstructionFiles(trigger, project)).toHaveLength(MAX_NESTED_INSTRUCTION_FILES);
    expect(discoverNestedInstructionFiles(trigger, project, { limit: 2 })).toHaveLength(2);
    expect(discoverNestedInstructionFiles(trigger, project, { limit: 0 })).toEqual([]);
  });

  it('truncates a body larger than the per-file bound and drops an empty one', () => {
    const { project, trigger } = monorepo();
    const dir = join(project, 'packages', 'foo');
    writeFileSync(join(dir, 'AGENTS.md'), 'x'.repeat(MAX_NESTED_INSTRUCTION_FILE_BYTES + 500));
    writeFileSync(join(dir, 'CLAUDE.md'), '   \n  \n');
    const found = discoverNestedInstructionFiles(trigger, project);
    expect(found.map(file => file.fileName)).toEqual(['AGENTS.md']);
    expect(found[0]!.content.endsWith('... (truncated)')).toBe(true);
    expect(found[0]!.content.length).toBeLessThan(MAX_NESTED_INSTRUCTION_FILE_BYTES + 100);
  });
});
