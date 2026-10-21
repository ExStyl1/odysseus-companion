import { describe, expect, it } from 'bun:test';

import { PI_TOOL_BINDINGS } from '../../pi-harness/harness-tool-descriptor.ts';
import { FILE_PATH_TOOLS, expandToolPaths } from '../pre-tool-use.ts';

/**
 * `FILE_PATH_TOOLS` gates two things every file-touching call depends on: `~`
 * expansion, and the R28 path-scoped rule trigger. The gate receives the tool's
 * POLICY name — `PI_TOOL_BINDINGS`' `permissionName` on the Pi side — and two
 * of our file tools had no entry at all (`find` → `Find`, `ls` → `Ls`), so both
 * behaviours silently skipped them.
 *
 * Pinning the set against the bindings themselves is the point: a renamed or
 * added file tool now fails here instead of quietly losing its rules.
 */
describe('FILE_PATH_TOOLS covers the policy names the gate receives', () => {
  /** Pi descriptor ids whose input carries a file path. */
  const FILE_DESCRIPTOR_IDS = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls', 'notebook_edit']);

  it('contains the policy name of every file-path Pi tool', () => {
    const missing = PI_TOOL_BINDINGS
      .filter(binding => FILE_DESCRIPTOR_IDS.has(binding.descriptorId))
      .filter(binding => !FILE_PATH_TOOLS.has(binding.permissionName))
      .map(binding => `${binding.descriptorId} → ${binding.permissionName}`);
    expect(missing).toEqual([]);
  });

  it('keeps the Claude-only names — both runtimes share this set', () => {
    for (const name of ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'NotebookEdit']) {
      expect(FILE_PATH_TOOLS.has(name)).toBe(true);
    }
  });

  it('expands ~ for Find and Ls, which had no entry before', () => {
    for (const toolName of ['Find', 'Ls']) {
      const expanded = expandToolPaths(toolName, { path: '~/probe.txt' });
      expect(expanded.modified).toBe(true);
      expect(String(expanded.input.path).startsWith('~')).toBe(false);
    }
  });
});
