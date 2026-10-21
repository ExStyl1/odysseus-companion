/**
 * Per-agent memory directories and the prompt block they produce
 * (`sub-agents.md:517-527`, `claude-directory.md`'s `agent-memory/` node).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEMORY_LOAD_BYTE_LIMIT, MEMORY_LOAD_LINE_LIMIT } from '@nessy-agent/session-tools-core';
import { CONFIG_DIR } from '../../../config/storage.ts';
import { NESSY_AGENT_PROJECT_DIR } from '../../../projects/nessy-agent-layout.ts';
import {
  AGENT_MEMORY_DIR,
  AGENT_MEMORY_LOCAL_DIR,
  AGENT_MEMORY_TOOLS,
  formatAgentMemoryPromptBlock,
  getAgentMemoryDirPath,
  prepareAgentMemoryDirectory,
  sanitizeAgentMemorySegment,
} from '../agent-memory.ts';

const temporaryRoots: string[] = [];

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'nessy-agent-memory-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  while (temporaryRoots.length) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

describe('per-agent memory directories', () => {
  it('maps the three documented scopes onto this fork’s namespaces', () => {
    const root = projectRoot();
    expect(getAgentMemoryDirPath('user', 'code-reviewer', { configDir: '/cfg' }))
      .toBe(join('/cfg', AGENT_MEMORY_DIR, 'code-reviewer'));
    expect(getAgentMemoryDirPath('user', 'code-reviewer'))
      .toBe(join(CONFIG_DIR, AGENT_MEMORY_DIR, 'code-reviewer'));
    expect(getAgentMemoryDirPath('project', 'code-reviewer', { projectRoot: root }))
      .toBe(join(root, NESSY_AGENT_PROJECT_DIR, AGENT_MEMORY_DIR, 'code-reviewer'));
    expect(getAgentMemoryDirPath('local', 'code-reviewer', { projectRoot: root }))
      .toBe(join(root, NESSY_AGENT_PROJECT_DIR, AGENT_MEMORY_LOCAL_DIR, 'code-reviewer'));
    // A project scope with no project root has nowhere to land.
    expect(getAgentMemoryDirPath('project', 'code-reviewer')).toBeUndefined();
  });

  it('reduces an imported plugin agent name to one contained path segment', () => {
    // Plugin agent keys/names carry ':' and '/', and this value becomes a
    // directory name — containment, not cosmetics.
    expect(sanitizeAgentMemorySegment('acme:reviewer/deep')).toBe('acme-reviewer-deep');
    expect(sanitizeAgentMemorySegment('../../etc')).toBe('etc');
    expect(sanitizeAgentMemorySegment('..')).toBe('');
    expect(getAgentMemoryDirPath('project', '../../etc', { projectRoot: '/w' }))
      .toBe(join('/w', NESSY_AGENT_PROJECT_DIR, AGENT_MEMORY_DIR, 'etc'));
    expect(getAgentMemoryDirPath('project', '  ', { projectRoot: '/w' })).toBeUndefined();
  });

  it('creates the directory, loads MEMORY.md and keeps the local scope out of git', () => {
    const root = projectRoot();
    const context = prepareAgentMemoryDirectory('local', 'reviewer', { projectRoot: root });
    expect(context).toBeDefined();
    expect(existsSync(context!.directory)).toBe(true);
    expect(context!.content).toBe('');
    expect(context!.truncated).toBe(false);
    // claude-directory.md marks `agent-memory/` committed and
    // `agent-memory-local/` the keep-it-out-of-git alternative.
    const ignorePath = join(root, NESSY_AGENT_PROJECT_DIR, AGENT_MEMORY_LOCAL_DIR, '.gitignore');
    expect(readFileSync(ignorePath, 'utf-8')).toBe('*\n');

    writeFileSync(join(context!.directory, 'MEMORY.md'), '# Memory\n\n- learned SENTINEL_FACT\n');
    const reloaded = prepareAgentMemoryDirectory('local', 'reviewer', { projectRoot: root });
    expect(reloaded!.content).toContain('SENTINEL_FACT');
    expect(reloaded!.truncated).toBe(false);
    // The project scope is committed, so it gets no ignore file of its own.
    prepareAgentMemoryDirectory('project', 'reviewer', { projectRoot: root });
    expect(existsSync(join(root, NESSY_AGENT_PROJECT_DIR, AGENT_MEMORY_DIR, '.gitignore'))).toBe(false);
  });

  it('cuts the index at 200 lines or 25KB, whichever comes first, and says so', () => {
    const root = projectRoot();
    const byLines = prepareAgentMemoryDirectory('project', 'liner', { projectRoot: root })!;
    writeFileSync(
      join(byLines.directory, 'MEMORY.md'),
      Array.from({ length: MEMORY_LOAD_LINE_LIMIT + 20 }, (_value, index) => `- entry ${index}`).join('\n'),
    );
    const linesLoaded = prepareAgentMemoryDirectory('project', 'liner', { projectRoot: root })!;
    expect(linesLoaded.truncated).toBe(true);
    expect(linesLoaded.content.split('\n')).toHaveLength(MEMORY_LOAD_LINE_LIMIT);
    expect(linesLoaded.content).not.toContain(`entry ${MEMORY_LOAD_LINE_LIMIT + 5}`);

    // The BYTE half, under the line limit: 20 lines of ~2 KB each.
    const byBytes = prepareAgentMemoryDirectory('project', 'byter', { projectRoot: root })!;
    writeFileSync(
      join(byBytes.directory, 'MEMORY.md'),
      Array.from({ length: 20 }, (_value, index) => `- ${'x'.repeat(2048)} ${index}`).join('\n'),
    );
    const bytesLoaded = prepareAgentMemoryDirectory('project', 'byter', { projectRoot: root })!;
    expect(bytesLoaded.truncated).toBe(true);
    expect(bytesLoaded.content.split('\n').length).toBeLessThan(MEMORY_LOAD_LINE_LIMIT);
    expect(Buffer.byteLength(bytesLoaded.content, 'utf-8')).toBeLessThanOrEqual(MEMORY_LOAD_BYTE_LIMIT);
  });

  it('refuses a symlinked namespace instead of writing through it', () => {
    const root = projectRoot();
    const elsewhere = projectRoot();
    symlinkSync(elsewhere, join(root, NESSY_AGENT_PROJECT_DIR));
    expect(prepareAgentMemoryDirectory('project', 'reviewer', { projectRoot: root })).toBeUndefined();
    expect(existsSync(join(elsewhere, AGENT_MEMORY_DIR))).toBe(false);
  });

  it('is entirely inert when auto memory is off', () => {
    // sub-agents.md:521 — with auto memory off "the `memory` field has no effect
    // and the subagent launches without the memory instructions or the memory
    // tool access described below". No context => the caller emits no block and
    // grants no tools, which is the whole of that sentence.
    const root = projectRoot();
    const configFile = join(CONFIG_DIR, 'config.json');
    const previous = existsSync(configFile) ? readFileSync(configFile, 'utf-8') : undefined;
    const base = previous
      ? JSON.parse(previous) as Record<string, unknown>
      : { storageLayoutVersion: 2, workspaceRefs: [], activeWorkspaceId: null };
    mkdirSync(CONFIG_DIR, { recursive: true });
    try {
      writeFileSync(configFile, JSON.stringify({ ...base, memoryEnabled: false }));
      expect(prepareAgentMemoryDirectory('project', 'reviewer', { projectRoot: root })).toBeUndefined();
      expect(existsSync(join(root, NESSY_AGENT_PROJECT_DIR))).toBe(false);
      // Positive control: the SAME call with the only difference being the
      // setting — otherwise "returns undefined" proves nothing about the gate.
      writeFileSync(configFile, JSON.stringify({ ...base, memoryEnabled: true }));
      expect(prepareAgentMemoryDirectory('project', 'reviewer', { projectRoot: root })).toBeDefined();
    } finally {
      if (previous === undefined) rmSync(configFile, { force: true });
      else writeFileSync(configFile, previous);
    }
  });

  it('never instructs a write it did not get, and asks for curation only when cut', () => {
    const root = projectRoot();
    const context = prepareAgentMemoryDirectory('user', 'reviewer', { configDir: root })!;
    const writable = formatAgentMemoryPromptBlock(context, { writable: true });
    expect(writable).toContain(context.directory);
    expect(writable).toContain('Read, Write and Edit');
    expect(writable).not.toContain('no write access');

    const readOnly = formatAgentMemoryPromptBlock(context, { writable: false });
    expect(readOnly).toContain('no write access');
    expect(readOnly).not.toContain('Read, Write and Edit');

    expect(writable).not.toContain('Curate it');
    const truncated = formatAgentMemoryPromptBlock(
      { ...context, content: '- kept', truncated: true },
      { writable: true },
    );
    expect(truncated).toContain('Curate it');
    expect(truncated).toContain(`${MEMORY_LOAD_LINE_LIMIT} lines`);
    // A read-only run is told what is missing but not to fix it.
    const truncatedReadOnly = formatAgentMemoryPromptBlock(
      { ...context, content: '- kept', truncated: true },
      { writable: false },
    );
    expect(truncatedReadOnly).toContain('cut at that limit');
    expect(truncatedReadOnly).not.toContain('Curate it');
  });

  it('grants exactly the three tools the page names', () => {
    expect([...AGENT_MEMORY_TOOLS]).toEqual(['read', 'write', 'edit']);
  });
});
