/**
 * P3.241 — the checks that would have caught the drift, not just the entries it
 * was missing.
 *
 * P6.35 taught `capabilities/native-sources.ts` about `AGENTS.override.md` and
 * codex's per-directory supersession. Two siblings held copies of the same list
 * and learned nothing: `agents/definitions.ts`' agent-definition exclusion, and
 * the ancestor walk behind the nestor-cloud `agents_md` request field. Both
 * stayed green, because a duplicated list drifts without failing anything.
 *
 * So these tests do not assert the missing names. They assert that the copies
 * are gone: a name added to `PROJECT_INSTRUCTION_FILES` reaches both readers
 * with neither file edited, and the rule holder stays light enough for the
 * lighter of them to import.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { readUserAgentDefinitions } from '../../agents/index.ts';
import { buildNestorCloudMetadata } from '../../agent/backend/nestor-cloud/metadata-builder.ts';
import {
  AGENTS_MD_INSTRUCTION_FILE,
  AGENTS_OVERRIDE_INSTRUCTION_FILE,
  PROJECT_INSTRUCTION_FILES,
  agentsMdInstructionFilesIn,
  instructionFileExistsAt,
} from '../instruction-files.ts';

function workspace(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const cwd = join(root, 'packages', 'app');
  mkdirSync(cwd, { recursive: true });
  return { root, cwd };
}

describe('the instruction-file rule has ONE holder', () => {
  /**
   * The constraint that lets the rule be shared at all: `agents/definitions.ts`
   * is loaded inside the Pi subprocess (`pi-agent-server/src/orchestrator/*`
   * imports `agents/index.ts` by relative path), so an edge into the collector
   * would drag `gray-matter`, the permission parser and the MCP stack in with
   * it. `utils/tool-grant-list.ts` documents the same measurement for the same
   * reason. Break this and the next lane's cheapest fix is a second copy.
   */
  it('is a leaf: the rule holder imports nothing but node:fs and node:path', () => {
    const source = readFileSync(join(dirname(import.meta.dir), 'instruction-files.ts'), 'utf-8');
    const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map(m => m[1]);

    // Positive control on the same rig: the regex does find imports elsewhere.
    const collectorSpecifiers = [...readFileSync(
      join(dirname(import.meta.dir), 'native-sources.ts'),
      'utf-8',
    ).matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map(m => m[1]);
    expect(collectorSpecifiers.length).toBeGreaterThan(5);
    expect(collectorSpecifiers).toContain('gray-matter');

    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter(spec => spec !== 'node:fs' && spec !== 'node:path')).toEqual([]);
  });

  /**
   * The drift itself, driven through the public loader rather than the constant:
   * this is the assertion that was silently false between P6.35 and P3.241.
   */
  it('excludes EVERY project instruction file from the agent-definition scan', () => {
    const root = mkdtempSync(join(tmpdir(), 'instruction-file-exclusion-'));
    for (const [index, name] of PROJECT_INSTRUCTION_FILES.entries()) {
      writeFileSync(join(root, name), `---\nname: instruction-file-${index}\nsystemPrompt: Not an agent.\n---\nProject instructions.\n`);
    }
    // Positive control on the same rig: a real definition beside them loads.
    writeFileSync(join(root, 'real-agent.md'), '---\nname: real-agent\nsystemPrompt: An actual agent.\n---\nDo the thing.\n');

    const names = readUserAgentDefinitions(root).map(def => def.name);

    expect(names).toEqual(['real-agent']);
    for (const [index] of PROJECT_INSTRUCTION_FILES.entries()) {
      expect(names).not.toContain(`instruction-file-${index}`);
    }
  });

  it('answers is_file, not existence — a DIRECTORY named AGENTS.md is not one', () => {
    const root = mkdtempSync(join(tmpdir(), 'instruction-file-is-file-'));
    mkdirSync(join(root, AGENTS_MD_INSTRUCTION_FILE));
    writeFileSync(join(root, 'CLAUDE.md'), 'real');

    expect(instructionFileExistsAt(join(root, AGENTS_MD_INSTRUCTION_FILE))).toBe(false);
    expect(instructionFileExistsAt(join(root, 'CLAUDE.md'))).toBe(true);
    expect(instructionFileExistsAt(join(root, 'absent.md'))).toBe(false);
  });

  it('narrows to the AGENTS.md family for a reader that carries only that chain', () => {
    const root = mkdtempSync(join(tmpdir(), 'instruction-file-family-'));

    expect(agentsMdInstructionFilesIn(root))
      .toEqual([AGENTS_OVERRIDE_INSTRUCTION_FILE, AGENTS_MD_INSTRUCTION_FILE]);

    writeFileSync(join(root, AGENTS_OVERRIDE_INSTRUCTION_FILE), 'override');
    expect(agentsMdInstructionFilesIn(root)).toEqual([AGENTS_OVERRIDE_INSTRUCTION_FILE]);
  });
});

describe('the nestor-cloud agents_md walk reads the same rule', () => {
  it('carries AGENTS.override.md, and only it, where codex loads only it', () => {
    const { root, cwd } = workspace('nestor-cloud-override-');
    writeFileSync(join(root, AGENTS_MD_INSTRUCTION_FILE), 'root rules');
    writeFileSync(join(cwd, AGENTS_MD_INSTRUCTION_FILE), 'app rules');
    writeFileSync(join(cwd, AGENTS_OVERRIDE_INSTRUCTION_FILE), 'app override');

    const content = buildNestorCloudMetadata({
      workspaceRootPath: root,
      workingDirectory: cwd,
      projectTrusted: true,
    }).agents_md?.content ?? '';

    // Per DIRECTORY: the ancestor without an override keeps its AGENTS.md.
    expect(content).toContain(`# ${AGENTS_MD_INSTRUCTION_FILE}\n\nroot rules`);
    expect(content).toContain(`packages/app/${AGENTS_OVERRIDE_INSTRUCTION_FILE}\n\napp override`);
    expect(content).not.toContain('app rules');
  });

  it('carries the override even where no AGENTS.md exists to supersede', () => {
    const { root, cwd } = workspace('nestor-cloud-override-only-');
    writeFileSync(join(root, AGENTS_OVERRIDE_INSTRUCTION_FILE), 'root override');

    const content = buildNestorCloudMetadata({
      workspaceRootPath: root,
      workingDirectory: cwd,
      projectTrusted: true,
    }).agents_md?.content ?? '';

    expect(content).toContain(`# ${AGENTS_OVERRIDE_INSTRUCTION_FILE}\n\nroot override`);
  });

  it('still withholds the override from an UNTRUSTED project (fail-closed)', () => {
    const { root, cwd } = workspace('nestor-cloud-override-untrusted-');
    writeFileSync(join(root, AGENTS_OVERRIDE_INSTRUCTION_FILE), 'root override');

    expect(buildNestorCloudMetadata({
      workspaceRootPath: root,
      workingDirectory: cwd,
    }).agents_md).toBeUndefined();
  });
});
