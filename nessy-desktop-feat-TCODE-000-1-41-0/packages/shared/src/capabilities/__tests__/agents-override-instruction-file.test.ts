/**
 * P6.35 — `AGENTS.override.md` steers codex and was invisible to our own
 * instruction collector.
 *
 * ## The two-tier evidence this file pins, and where each tier came from
 *
 * STRONG (the tier a codex claim needs): the shipped app-server binary,
 * `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server` reporting
 * `0.148.0`, carries the literal `AGENTS.override.md` next to `AGENTS.md` and
 * its own `core/src/agents_md.rs` tracing frame — 5 hits against a positive
 * control of 50 for `AGENTS.md` and a negative control of 0 for
 * `nessyNotARealCodexKey`. The source at `rust-v0.148.0`
 * (`codex-rs/core/src/agents_md.rs`) gives the rule the binary implements:
 *
 * ```rust
 * pub const DEFAULT_AGENTS_MD_FILENAME: &str = "AGENTS.md";
 * /// Preferred local override for AGENTS.md instructions.
 * pub const LOCAL_AGENTS_MD_FILENAME: &str = "AGENTS.override.md";
 * ```
 *
 * with `candidate_filenames` pushing the override FIRST and `agents_md_paths`
 * returning the first candidate whose `metadata.is_file` holds:
 *
 * ```rust
 * for name in candidate_filenames {
 *     let candidate = directory.join(name)…;
 *     match fs.get_metadata(&candidate, None).await {
 *         Ok(metadata) if metadata.is_file => return Ok(Some(candidate)),
 * ```
 *
 * So the choice is per DIRECTORY, by EXISTENCE, and made before any body is
 * read — which is why `supersedes even when the override is empty` below is a
 * test and not an oversight.
 *
 * WEAK (intent, not behaviour):
 * `learn.chatgpt.com/docs/agent-configuration/agents-md.md` — "In each directory
 * along the path, it checks for `AGENTS.override.md`, then `AGENTS.md`, then any
 * fallback names in `project_doc_fallback_filenames`. Codex includes at most one
 * file per directory." Recorded because it agrees with the source; it is not
 * what these assertions rest on.
 *
 * ## What was actually wrong
 *
 * Not an unimplemented feature — two independent readers of project
 * instructions that disagreed. In a repo carrying `AGENTS.override.md`, a codex
 * session was steered by that file while Pi and Claude read the `AGENTS.md` it
 * supersedes, and our Sources surface could name neither the override nor the
 * disagreement. Both halves are pinned here: the collector now SEES the file,
 * and it applies codex's own supersession so seeing it does not turn one silent
 * divergence into another (loading both where codex loads one).
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  AGENTS_OVERRIDE_INSTRUCTION_FILE,
  PROJECT_INSTRUCTION_FILES,
  WORKING_DIRECTORY_INSTRUCTION_FILES,
  agentsMdSupersededIn,
  buildNativeCapabilityInventory,
  discoverNestedInstructionFiles,
  projectInstructionFilesIn,
  workingDirectoryInstructionFilesIn,
} from '../native-sources.ts';
import { detectProjectContributions } from '../project-contribution-detect.ts';
import { getProjectContextFilesPrompt } from '../../prompts/system.ts';
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

function instructionPaths(project: string): string[] {
  const context: WorkspacePolicyContext = {
    workspaceId: 'ws',
    workspaceRootPath: tmp('ovr-ws-'),
    projectTrustState: 'trusted',
    projectTrustRevision: '1',
    projectRoot: project,
    workingDirectory: project,
    projectKey: 'pk' as WorkspacePolicyContext['projectKey'],
  };
  const { records } = buildNativeCapabilityInventory(context, {
    configDir: tmp('ovr-cfg-'),
    homeAgentsSkillsDir: tmp('ovr-home-'),
    instructionExcludes: [],
    // P2.455 — pinned OFF: the administrator tier's DEFAULT roots are absolute
    // machine-wide directories, so an unpinned rig reads the REAL ones on a
    // centrally managed host and a fixture everywhere else. `[]` means "no
    // administrator tier"; the standing guard is `admin-skills-dirs-pinned.test.ts`.
    adminSkillsDirs: [],
  });
  return records.filter(record => record.kind === 'instruction').map(record => record.sourcePath);
}

describe('the file set knows the name codex honours', () => {
  it('carries the override first, ahead of the file it supersedes', () => {
    expect(AGENTS_OVERRIDE_INSTRUCTION_FILE).toBe('AGENTS.override.md');
    expect(PROJECT_INSTRUCTION_FILES[0]).toBe('AGENTS.override.md');
    expect(PROJECT_INSTRUCTION_FILES).toContain('AGENTS.md');
    expect(WORKING_DIRECTORY_INSTRUCTION_FILES[0]?.relativePath).toBe('AGENTS.override.md');
  });
});

describe('agentsMdSupersededIn — codex selects on is_file, before reading', () => {
  it('is false for a directory that has only AGENTS.md', () => {
    const dir = tmp('ovr-plain-');
    writeFileSync(join(dir, 'AGENTS.md'), 'root contract');
    expect(agentsMdSupersededIn(dir)).toBe(false);
    expect(projectInstructionFilesIn(dir)).toContain('AGENTS.md');
    expect(workingDirectoryInstructionFilesIn(dir).map(entry => entry.relativePath))
      .toContain('AGENTS.md');
  });

  it('supersedes even when the override is empty — `is_file`, not content', () => {
    const dir = tmp('ovr-empty-');
    writeFileSync(join(dir, 'AGENTS.md'), 'root contract');
    writeFileSync(join(dir, 'AGENTS.override.md'), '');
    expect(agentsMdSupersededIn(dir)).toBe(true);
    expect(projectInstructionFilesIn(dir)).not.toContain('AGENTS.md');
    expect(projectInstructionFilesIn(dir)).toContain('AGENTS.override.md');
  });

  it('a DIRECTORY of that name supersedes nothing, and never throws', () => {
    const dir = tmp('ovr-dir-');
    mkdirSync(join(dir, 'AGENTS.override.md'));
    expect(agentsMdSupersededIn(dir)).toBe(false);
    expect(agentsMdSupersededIn(join(dir, 'does-not-exist'))).toBe(false);
  });
});

describe('the eager inventory — what the Sources surface can name', () => {
  it('records the override, and drops the AGENTS.md it supersedes', () => {
    const project = tmp('ovr-proj-');
    writeFileSync(join(project, 'AGENTS.md'), 'shared contract');
    writeFileSync(join(project, 'AGENTS.override.md'), 'local override');
    const paths = instructionPaths(project);
    expect(paths).toContain(join(project, 'AGENTS.override.md'));
    expect(paths).not.toContain(join(project, 'AGENTS.md'));
  });

  it('positive control: without an override, AGENTS.md is still recorded', () => {
    const project = tmp('ovr-ctl-');
    writeFileSync(join(project, 'AGENTS.md'), 'shared contract');
    const paths = instructionPaths(project);
    expect(paths).toContain(join(project, 'AGENTS.md'));
    expect(paths).not.toContain(join(project, 'AGENTS.override.md'));
  });

  it('supersession is per DIRECTORY: an ancestor override does not silence a nearer AGENTS.md', () => {
    const project = tmp('ovr-anc-');
    const nested = join(project, 'pkg');
    mkdirSync(nested);
    writeFileSync(join(project, 'AGENTS.md'), 'root contract');
    writeFileSync(join(project, 'AGENTS.override.md'), 'root override');
    writeFileSync(join(nested, 'AGENTS.md'), 'package contract');

    const context: WorkspacePolicyContext = {
      workspaceId: 'ws',
      workspaceRootPath: tmp('ovr-ws2-'),
      projectTrustState: 'trusted',
      projectTrustRevision: '1',
      projectRoot: project,
      workingDirectory: nested,
      projectKey: 'pk' as WorkspacePolicyContext['projectKey'],
    };
    const { records } = buildNativeCapabilityInventory(context, {
      configDir: tmp('ovr-cfg2-'),
      homeAgentsSkillsDir: tmp('ovr-home2-'),
      instructionExcludes: [],
      // P2.455 — pinned OFF: the administrator tier's DEFAULT roots are absolute
      // machine-wide directories, so an unpinned rig reads the REAL ones on a
      // centrally managed host and a fixture everywhere else. `[]` means "no
      // administrator tier"; the standing guard is `admin-skills-dirs-pinned.test.ts`.
      adminSkillsDirs: [],
    });
    const paths = records.filter(record => record.kind === 'instruction').map(record => record.sourcePath);
    expect(paths).toContain(join(project, 'AGENTS.override.md'));
    expect(paths).not.toContain(join(project, 'AGENTS.md'));
    expect(paths).toContain(join(nested, 'AGENTS.md'));
  });
});

describe('the nested walk below the working directory', () => {
  it('returns the package override instead of the package AGENTS.md', () => {
    const project = tmp('ovr-nested-');
    const pkg = join(project, 'packages', 'foo');
    mkdirSync(join(pkg, 'src'), { recursive: true });
    writeFileSync(join(pkg, 'AGENTS.md'), 'package contract');
    writeFileSync(join(pkg, 'AGENTS.override.md'), 'package override');
    writeFileSync(join(pkg, 'src', 'x.ts'), 'export const x = 1;');

    const found = discoverNestedInstructionFiles(join(pkg, 'src', 'x.ts'), project);
    expect(found.map(file => file.fileName)).toEqual(['AGENTS.override.md']);
    expect(found[0]!.content).toBe('package override');
  });
});

describe('the pre-trust preview names what the session will load', () => {
  it('lists the override and not the superseded AGENTS.md', () => {
    const root = tmp('ovr-detect-');
    writeFileSync(join(root, 'AGENTS.md'), '# guide');
    writeFileSync(join(root, 'AGENTS.override.md'), '# override');
    writeFileSync(join(root, 'CLAUDE.local.md'), '# local');
    const item = detectProjectContributions(root).items.find(entry => entry.itemType === 'AGENTS_MD');
    expect(item?.names).toEqual(['AGENTS.override.md', 'CLAUDE.local.md']);
  });
});

describe('the legacy project-context route agrees with the capability route', () => {
  it('attaches the override and not the AGENTS.md it supersedes', () => {
    const project = tmp('ovr-legacy-');
    writeFileSync(join(project, 'AGENTS.md'), 'SHARED-CONTRACT-MARKER');
    writeFileSync(join(project, 'AGENTS.override.md'), 'LOCAL-OVERRIDE-MARKER');
    const prompt = getProjectContextFilesPrompt(project, { homeDir: tmp('ovr-legacy-home-') });
    expect(prompt).toContain('LOCAL-OVERRIDE-MARKER');
    expect(prompt).not.toContain('SHARED-CONTRACT-MARKER');
  });

  it('positive control: without an override the shared contract still attaches', () => {
    const project = tmp('ovr-legacy-ctl-');
    writeFileSync(join(project, 'AGENTS.md'), 'SHARED-CONTRACT-MARKER');
    const prompt = getProjectContextFilesPrompt(project, { homeDir: tmp('ovr-legacy-home2-') });
    expect(prompt).toContain('SHARED-CONTRACT-MARKER');
  });
});
