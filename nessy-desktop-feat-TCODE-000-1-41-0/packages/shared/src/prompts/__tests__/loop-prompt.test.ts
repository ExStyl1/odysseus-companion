import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NESSY_AGENT_PROJECT_DIR } from '../../projects/nessy-agent-layout.ts';
import {
  BUILTIN_LOOP_MAINTENANCE_PROMPT,
  MAX_LOOP_MD_BYTES,
  resolveLoopPrompt,
} from '../loop-prompt.ts';

const roots: string[] = [];

function dir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeProjectLoopMd(projectDir: string, content: string): void {
  mkdirSync(join(projectDir, NESSY_AGENT_PROJECT_DIR), { recursive: true });
  writeFileSync(join(projectDir, NESSY_AGENT_PROJECT_DIR, 'loop.md'), content, 'utf8');
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('resolveLoopPrompt (`scheduled-tasks.md:100`-`:120`)', () => {
  test('the project file wins over the user file (`:108`)', () => {
    const project = dir('nessy-loop-project-');
    const config = dir('nessy-loop-config-');
    writeProjectLoopMd(project, 'project instructions');
    writeFileSync(join(config, 'loop.md'), 'user instructions', 'utf8');

    const resolved = resolveLoopPrompt(project, config);
    expect(resolved).toEqual({ prompt: 'project instructions', source: 'project', truncated: false });
  });

  test('the user file applies when the project defines none (`:109`)', () => {
    const project = dir('nessy-loop-project-');
    const config = dir('nessy-loop-config-');
    writeFileSync(join(config, 'loop.md'), 'user instructions', 'utf8');

    const resolved = resolveLoopPrompt(project, config);
    expect(resolved).toEqual({ prompt: 'user instructions', source: 'user', truncated: false });
  });

  test('absent both, the builtin maintenance prompt applies (`:120`)', () => {
    const resolved = resolveLoopPrompt(dir('nessy-loop-project-'), dir('nessy-loop-config-'));
    expect(resolved).toEqual({
      prompt: BUILTIN_LOOP_MAINTENANCE_PROMPT,
      source: 'builtin',
      truncated: false,
    });
    // The paraphrased builtin keeps the three documented items in order and the
    // guard (`:82`-`:88`).
    const positions = [
      BUILTIN_LOOP_MAINTENANCE_PROMPT.indexOf('unfinished'),
      BUILTIN_LOOP_MAINTENANCE_PROMPT.indexOf('pull request'),
      BUILTIN_LOOP_MAINTENANCE_PROMPT.indexOf('cleanup'),
      BUILTIN_LOOP_MAINTENANCE_PROMPT.indexOf('new initiatives'),
      BUILTIN_LOOP_MAINTENANCE_PROMPT.indexOf('irreversible'),
    ];
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test('content beyond 25,000 BYTES is truncated on a character boundary (`:120`)', () => {
    const project = dir('nessy-loop-project-');
    // 24,999 ASCII bytes, then a 4-byte emoji straddling the cap
    // (bytes 24,999..25,002), then a tail that must not survive.
    const content = `${'a'.repeat(MAX_LOOP_MD_BYTES - 1)}\u{1F600}tail`;
    writeProjectLoopMd(project, content);

    const resolved = resolveLoopPrompt(project, dir('nessy-loop-config-'));
    expect(resolved.truncated).toBe(true);
    expect(resolved.source).toBe('project');
    // The straddling character is dropped entirely — never a broken byte.
    expect(resolved.prompt).toBe('a'.repeat(MAX_LOOP_MD_BYTES - 1));
    expect(Buffer.byteLength(resolved.prompt, 'utf8')).toBeLessThanOrEqual(MAX_LOOP_MD_BYTES);
    expect(resolved.prompt.includes('�')).toBe(false);

    // Exactly at the cap nothing is cut.
    writeProjectLoopMd(project, 'b'.repeat(MAX_LOOP_MD_BYTES));
    const atCap = resolveLoopPrompt(project, dir('nessy-loop-config-'));
    expect(atCap.truncated).toBe(false);
    expect(atCap.prompt).toHaveLength(MAX_LOOP_MD_BYTES);
  });

  test('a blank project file falls through to the user file rather than delivering nothing', () => {
    const project = dir('nessy-loop-project-');
    const config = dir('nessy-loop-config-');
    writeProjectLoopMd(project, '   \n');
    writeFileSync(join(config, 'loop.md'), 'user instructions', 'utf8');
    expect(resolveLoopPrompt(project, config).source).toBe('user');
  });

  test('re-reads on every call, so edits take effect on the next iteration (`:120`)', () => {
    const project = dir('nessy-loop-project-');
    const config = dir('nessy-loop-config-');
    writeProjectLoopMd(project, 'first version');
    expect(resolveLoopPrompt(project, config).prompt).toBe('first version');
    writeProjectLoopMd(project, 'second version');
    expect(resolveLoopPrompt(project, config).prompt).toBe('second version');
  });
});
