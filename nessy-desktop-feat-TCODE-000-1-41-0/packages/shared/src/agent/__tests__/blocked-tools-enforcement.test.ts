/**
 * P3.351 — the `blockedTools` enforcement predicate, pinned against the REAL
 * gate rather than against a restatement of it.
 *
 * Two halves, and the second is the one that stops drift:
 *
 *   1. the classifier's own rules, over `ALWAYS_ALLOWED_TOOLS` imported from
 *      `mode-manager.ts` — never a copy;
 *   2. a DRIVE of `shouldAllowToolInMode` with two real workspaces, one
 *      declaring the name in `blockedTools` and one not, asserting the verdict
 *      is IDENTICAL for everything the classifier calls pre-empted and
 *      DIFFERENT for what it calls enforced. A predicate that agreed with a
 *      reading of the branches and disagreed with the branches would pass (1)
 *      and fail (2).
 *
 * The drive is why this file is in `shared` and not beside the renderer: the
 * gate needs `fs`, `os` and a workspace on disk.
 */

import { afterEach, describe, it, expect, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BLOCKED_TOOL_PREEMPTION_KINDS,
  classifyBlockedToolDeclaration,
  partitionBlockedToolDeclarations,
} from '../blocked-tools-enforcement.ts';
import { ALWAYS_ALLOWED_TOOLS, shouldAllowToolInMode, type PermissionMode } from '../mode-manager.ts';
import { permissionsConfigCache } from '../permissions-config.ts';

// The drive builds workspaces and runs the Bash validator, which on a host with
// a real PowerShell spawns a parser per call. Same reason and value as
// `mode-gate.test.ts`, whose header carries the measurement (P2.254).
setDefaultTimeout(120_000);

const tempWorkspaces: string[] = [];

function workspaceWith(config: Record<string, unknown>): string {
  const workspaceRootPath = mkdtempSync(join(tmpdir(), 'nessy-blocked-tools-'));
  writeFileSync(
    join(workspaceRootPath, 'permissions.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf-8',
  );
  tempWorkspaces.push(workspaceRootPath);
  permissionsConfigCache.invalidateWorkspace(workspaceRootPath);
  return workspaceRootPath;
}

afterEach(() => {
  permissionsConfigCache.clear();
  for (const workspaceRootPath of tempWorkspaces.splice(0)) {
    rmSync(workspaceRootPath, { recursive: true, force: true });
  }
});

describe('classifyBlockedToolDeclaration', () => {
  it('reports the always-allowed set exactly, and by its own membership', () => {
    // Not a list of names: the assertion is over whatever the real set holds,
    // so adding a name there cannot leave this test asserting the old shape.
    expect(ALWAYS_ALLOWED_TOOLS.size).toBeGreaterThan(0);
    for (const name of ALWAYS_ALLOWED_TOOLS) {
      expect(classifyBlockedToolDeclaration(name, ALWAYS_ALLOWED_TOOLS))
        .toEqual({ kind: 'always-allowed', matched: name });
    }
  });

  it('matches ANY `__<name>` suffix, not only the mcp__…__ spelling the docs describe', () => {
    expect(classifyBlockedToolDeclaration('mcp__session__read_mcp_resource', ALWAYS_ALLOWED_TOOLS))
      .toEqual({ kind: 'always-allowed-suffix', matched: 'read_mcp_resource' });
    // The width is the finding: no `mcp__` prefix, still pre-empted.
    expect(classifyBlockedToolDeclaration('anything__Read', ALWAYS_ALLOWED_TOOLS))
      .toEqual({ kind: 'always-allowed-suffix', matched: 'Read' });
  });

  it('reports every browser spelling under the browser branch, canonical and legacy', () => {
    for (const name of ['browser_tool', 'mcp__session__browser_tool', 'browser_snapshot', 'browser_evaluate']) {
      expect(classifyBlockedToolDeclaration(name, ALWAYS_ALLOWED_TOOLS)).toEqual({ kind: 'browser-tool' });
    }
  });

  it('reports Bash under the command classifier', () => {
    expect(classifyBlockedToolDeclaration('Bash', ALWAYS_ALLOWED_TOOLS)).toEqual({ kind: 'bash-classifier' });
  });

  it('returns null for a name the list really does block', () => {
    expect(classifyBlockedToolDeclaration('SomeRealTool', ALWAYS_ALLOWED_TOOLS)).toBeNull();
    // The four hardcoded write tools are honoured by the branch too — the path
    // branch can refuse them first, but with a different message, and the
    // BLOCKED claim a user reads is true either way.
    for (const name of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      expect(classifyBlockedToolDeclaration(name, ALWAYS_ALLOWED_TOOLS)).toBeNull();
    }
  });

  it('accepts any iterable, not only a Set, and does not mutate what it is given', () => {
    const asArray = [...ALWAYS_ALLOWED_TOOLS];
    expect(classifyBlockedToolDeclaration('Read', asArray)).toEqual({ kind: 'always-allowed', matched: 'Read' });
    expect(asArray).toEqual([...ALWAYS_ALLOWED_TOOLS]);
  });

  it('exposes every kind it can report', () => {
    const reported = new Set<string>();
    for (const name of ['Read', 'anything__Read', 'browser_tool', 'Bash']) {
      const verdict = classifyBlockedToolDeclaration(name, ALWAYS_ALLOWED_TOOLS);
      if (verdict) reported.add(verdict.kind);
    }
    expect([...reported].sort()).toEqual([...BLOCKED_TOOL_PREEMPTION_KINDS].sort());
  });
});

describe('partitionBlockedToolDeclarations', () => {
  it('splits a declared list and keeps declaration order on both sides', () => {
    const declared = ['WebFetch', 'SomeRealTool', 'Bash', 'AnotherRealTool', 'browser_tool'];
    const { enforced, unenforceable } = partitionBlockedToolDeclarations(declared, ALWAYS_ALLOWED_TOOLS);
    expect(enforced).toEqual(['SomeRealTool', 'AnotherRealTool']);
    expect(unenforceable.map(entry => entry.tool)).toEqual(['WebFetch', 'Bash', 'browser_tool']);
    expect(unenforceable.map(entry => entry.preemption.kind))
      .toEqual(['always-allowed', 'bash-classifier', 'browser-tool']);
  });

  it('an empty declaration yields two empty sides', () => {
    expect(partitionBlockedToolDeclarations([], ALWAYS_ALLOWED_TOOLS))
      .toEqual({ enforced: [], unenforceable: [] });
  });
});

describe('the predicate against the real gate (drive, not read)', () => {
  /** Inputs the gate needs to reach its branch; everything else takes `{}`. */
  const TOOL_INPUTS: Record<string, unknown> = {
    // Read-only per the pattern the declaring workspace also carries — this is
    // the arm that proves `blockedTools: ["Bash"]` leaves a shell running.
    Bash: { command: 'ls -la' },
    browser_tool: { command: 'snapshot' },
    mcp__session__browser_tool: { command: 'snapshot' },
    browser_snapshot: { command: 'snapshot' },
  };

  const DECLARED = [
    'WebFetch', 'WebSearch', 'Read', 'TodoWrite',
    'mcp__session__read_mcp_resource', 'anything__Read',
    'browser_tool', 'mcp__session__browser_tool', 'browser_snapshot',
    'Bash',
    'SomeRealTool',
  ];

  // The reason text embeds the workspace path, so two temp roots differ on a
  // string comparison for reasons that have nothing to do with the list. Only
  // the ALLOWED verdict is compared; the enforced arm asserts the reason names
  // the tool, which is the blockedTools branch's own message.
  function verdicts(mode: PermissionMode) {
    const declaring = workspaceWith({ blockedTools: DECLARED, allowedBashPatterns: ['^ls( |$)'] });
    const silent = workspaceWith({ allowedBashPatterns: ['^ls( |$)'] });
    return DECLARED.map(tool => ({
      tool,
      declared: shouldAllowToolInMode(tool, TOOL_INPUTS[tool] ?? {}, mode, {
        permissionsContext: { workspaceRootPath: declaring },
      }),
      undeclared: shouldAllowToolInMode(tool, TOOL_INPUTS[tool] ?? {}, mode, {
        permissionsContext: { workspaceRootPath: silent },
      }),
    }));
  }

  for (const mode of ['plan'] as PermissionMode[]) {
    it(`in ${mode}: everything the predicate calls pre-empted is INERT at the gate`, () => {
      let inertCount = 0;
      for (const { tool, declared, undeclared } of verdicts(mode)) {
        if (!classifyBlockedToolDeclaration(tool, ALWAYS_ALLOWED_TOOLS)) continue;
        inertCount += 1;
        // Declaring the name changed nothing, and the call still runs.
        expect(`${tool}: declared=${declared.allowed} undeclared=${undeclared.allowed}`)
          .toBe(`${tool}: declared=true undeclared=true`);
      }
      // Guards the shape of the case list itself — a rename that silently
      // emptied it would otherwise leave a green test asserting nothing.
      expect(inertCount).toBe(DECLARED.length - 1);
    });

    it(`in ${mode}: the one name the predicate calls enforced really is blocked by the list`, () => {
      const row = verdicts(mode).find(entry => entry.tool === 'SomeRealTool')!;
      expect(row.undeclared.allowed).toBe(true);
      expect(row.declared.allowed).toBe(false);
      expect(String((row.declared as { reason?: string }).reason ?? '')).toContain('SomeRealTool');
    });
  }

  it('the Bash impostor: a non-read-only command is refused with or WITHOUT the declaration', () => {
    // A verdict probe that drove only this command would score the declaration
    // green. It is the same refusal either way, from the classifier.
    const declaring = workspaceWith({ blockedTools: ['Bash'], allowedBashPatterns: ['^ls( |$)'] });
    const silent = workspaceWith({ allowedBashPatterns: ['^ls( |$)'] });
    const input = { command: 'rm -rf /tmp/nessy-blocked-tools-probe' };
    const declared = shouldAllowToolInMode('Bash', input, 'plan', {
      permissionsContext: { workspaceRootPath: declaring },
    });
    const undeclared = shouldAllowToolInMode('Bash', input, 'plan', {
      permissionsContext: { workspaceRootPath: silent },
    });
    expect(declared.allowed).toBe(false);
    expect(undeclared.allowed).toBe(false);
    expect(String((declared as { reason?: string }).reason ?? '')).toContain('read-only allowlist');
  });
});
