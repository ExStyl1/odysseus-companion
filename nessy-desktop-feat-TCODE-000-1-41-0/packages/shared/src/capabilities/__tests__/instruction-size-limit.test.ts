/**
 * P6.389 arm (1) — an instruction or memory file over the documented 4 MiB is
 * SKIPPED whole, with a named diagnostic, instead of being loaded in part.
 *
 * `memory.md`, fetched 2026-09-06, verbatim: *"This limit applies only to
 * `MEMORY.md`. Claude Code loads a CLAUDE.md file of up to 4 MiB in full and
 * skips a larger file. Shorter files produce better adherence."* — and, in
 * §*Keep memory files short*, *"Claude Code skips a file over 4 MiB."*
 *
 * The control is the row's own: a file JUST UNDER the limit loading whole. It
 * is written at the real size rather than against a lowered knob, because a
 * threshold tested at zero manufactures its own pass.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';

import { buildNativeCapabilityInventory } from '../native-sources.ts';
import { INSTRUCTION_FILE_MAX_BYTES, readMemoryFile } from '../../agent/memory/memory-store.ts';
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

/** A file of exactly `bytes` bytes whose first line is recognisable. */
function writeSized(path: string, bytes: number): void {
  const head = '# instructions\n';
  writeFileSync(path, head + 'x'.repeat(Math.max(0, bytes - head.length)));
}

function context(workspaceRoot: string): WorkspacePolicyContext {
  return {
    workspaceId: 'ws-uuid-1',
    workspaceRootPath: workspaceRoot,
    projectTrustState: 'trusted',
    workingDirectory: workspaceRoot,
    projectKey: 'proj-1',
  } as WorkspacePolicyContext;
}

function env(configDir: string, homeSkills: string) {
  return { configDir, homeAgentsSkillsDir: homeSkills, adminSkillsDirs: [] as readonly string[] };
}

describe('the documented 4 MiB instruction/memory limit', () => {
  it('skips an oversized instruction file whole and records why', () => {
    const configDir = tmp('size-config-');
    const homeSkills = tmp('size-home-');
    const workspaceRoot = tmp('size-ws-');
    const oversized = join(workspaceRoot, 'CLAUDE.md');
    writeSized(oversized, INSTRUCTION_FILE_MAX_BYTES + 1);

    const { records, droppedInstructionLayers } = buildNativeCapabilityInventory(
      context(workspaceRoot), env(configDir, homeSkills),
    );
    expect(records.some(r => r.sourcePath === oversized)).toBe(false);
    expect(droppedInstructionLayers).toEqual([
      { path: oversized, reason: 'over-size-limit', limit: INSTRUCTION_FILE_MAX_BYTES },
    ]);
  });

  it('control — a file one byte under the limit is a record like any other', () => {
    const configDir = tmp('size-config-');
    const homeSkills = tmp('size-home-');
    const workspaceRoot = tmp('size-ws-');
    const justUnder = join(workspaceRoot, 'CLAUDE.md');
    writeSized(justUnder, INSTRUCTION_FILE_MAX_BYTES);

    const { records, droppedInstructionLayers } = buildNativeCapabilityInventory(
      context(workspaceRoot), env(configDir, homeSkills),
    );
    expect(records.some(r => r.kind === 'instruction' && r.sourcePath === justUnder)).toBe(true);
    expect(droppedInstructionLayers ?? []).toEqual([]);
  });

  it('the reader agrees with the record: an oversized file reads as empty, not as a prefix', () => {
    const dir = tmp('size-read-');
    const oversized = join(dir, 'MEMORY.md');
    writeSized(oversized, INSTRUCTION_FILE_MAX_BYTES + 1);
    expect(readMemoryFile(oversized)).toBe('');

    const under = join(dir, 'under.md');
    writeSized(under, 64);
    expect(readMemoryFile(under)).toContain('# instructions');
  });
});
