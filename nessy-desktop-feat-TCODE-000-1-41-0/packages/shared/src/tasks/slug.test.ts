/**
 * UA3.2 — adapted from craft-agents-oss `v0.13.4:packages/shared/src/tasks/slug.test.ts` (Apache-2.0): every
 * upstream case is kept unchanged (they are the CONTROL — an ASCII title slugs exactly as upstream); the
 * "non-Latin fallback (UA3.2)" block pins the one divergence of `slug.ts`.
 */
import { describe, it, expect } from 'bun:test';
import { slugify, uniqueTaskSlug } from './slug.ts';

describe('slugify', () => {
  it('kebab-cases titles and strips edge dashes', () => {
    expect(slugify('  Fix the Login Flow!  ')).toBe('fix-the-login-flow');
    expect(slugify('---Weird___input---')).toBe('weird-input');
  });

  it('caps at 48 chars', () => {
    expect(slugify('a'.repeat(80)).length).toBe(48);
  });
});

describe('uniqueTaskSlug', () => {
  it('returns the base slug when free', () => {
    expect(uniqueTaskSlug('My Task', new Set())).toBe('my-task');
  });

  it('suffix-increments on collision and never overwrites', () => {
    const taken = new Set(['my-task', 'my-task-2']);
    expect(uniqueTaskSlug('My Task', taken)).toBe('my-task-3');
  });

  it('falls back to "task" for titles that slugify to nothing', () => {
    expect(uniqueTaskSlug('!!!', new Set())).toBe('task');
    expect(uniqueTaskSlug('!!!', new Set(['task']))).toBe('task-2');
  });

  it('keeps suffixed candidates within the 48-char cap', () => {
    const base = 'a'.repeat(48);
    const candidate = uniqueTaskSlug('a'.repeat(80), new Set([base]));
    expect(candidate.length).toBeLessThanOrEqual(48);
    expect(candidate.endsWith('-2')).toBe(true);
  });
});

describe('non-Latin fallback (UA3.2)', () => {
  const ASCII_SLUG = /^[a-z0-9][a-z0-9-]*$/;

  it('a Cyrillic title yields a non-empty ASCII slug of the shape task-<6 hex>', () => {
    const slug = slugify('Задача');
    expect(slug).toMatch(/^task-[0-9a-f]{6}$/);
    expect(slug).toMatch(ASCII_SLUG);
    expect(slugify('Проверить вход 2')).toMatch(/^task-[0-9a-f]{6}$/);
    expect(slugify('任务')).toMatch(/^task-[0-9a-f]{6}$/);
  });

  it('is deterministic per title (the editor re-derives the slug on every build) and differs between titles', () => {
    expect(slugify('Задача')).toBe(slugify('  задача  '));
    expect(slugify('Задача')).not.toBe(slugify('Задача 2'));
  });

  it('uniqueTaskSlug suffixes a taken Cyrillic slug instead of overwriting it', () => {
    const first = uniqueTaskSlug('Задача', new Set());
    expect(first).toBe(slugify('Задача'));
    expect(uniqueTaskSlug('Задача', new Set([first]))).toBe(`${first}-2`);
  });

  it('CONTROL: a title with any ASCII letter, or with no letters, slugs exactly as upstream', () => {
    const upstream = (s: string) =>
      s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    for (const title of ['Fix the Login Flow!', 'Fix логин', 'Café', '2026', '!!!', '', '---Weird___input---']) {
      expect(slugify(title)).toBe(upstream(title));
    }
  });

  it('slug.ts imports nothing, so the renderer can take it without fs', async () => {
    const source = await Bun.file(new URL('./slug.ts', import.meta.url)).text();
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
    // Positive control on the same instrument: storage.ts does import fs.
    const storage = await Bun.file(new URL('./storage.ts', import.meta.url)).text();
    expect(storage).toMatch(/^import .* from 'fs';$/m);
  });
});
