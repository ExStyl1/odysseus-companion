import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionToolContext } from '../context.ts';
import { handleSkillValidate } from './skill-validate.ts';

/**
 * F1.1161 (origin DN-266) — `skill_validate` took the session's working directory from its context and, failing that,
 * from `<workspace>/sessions/<id>/session.jsonl`: the pre-v2 layout. Storage v2 keeps sessions at
 * `<config>/sessions/<workspaceId>/<sessionId>/` and refuses (never migrates) a legacy tree, so that fallback could
 * only ever read nothing — or a stale file left in a workspace root. Every host fills `ctx.workingDirectory`
 * (`claude-context.ts`, `session-mcp-server`, Pi), so the fallback is removed, not re-pointed.
 */

let root = '';
const SLUG = 'f1161-demo';
const SKILL = `---\nname: F1.1161 demo\ndescription: A skill the project tier carries.\n---\n\nBody.\n`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skill-validate-f1161-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(overrides: Partial<SessionToolContext> = {}): SessionToolContext {
  const workspacePath = join(root, 'workspace');
  return {
    configRoot: root,
    sessionId: 'session-1',
    workspacePath,
    sourcesPath: join(workspacePath, 'sources'),
    skillsPath: join(workspacePath, 'skills'),
    plansFolderPath: join(workspacePath, 'plans'),
    callbacks: { onPlanSubmitted: () => {}, onAuthRequest: () => {} },
    fs: {
      exists: (path) => existsSync(path),
      readFile: (path) => readFileSync(path, 'utf8'),
      readFileBuffer: (path) => readFileSync(path),
      writeFile: (path, content) => writeFileSync(path, content, 'utf8'),
      isDirectory: () => false,
      readdir: () => [],
      stat: () => ({ size: 0, isDirectory: () => false }),
    },
    loadSourceConfig: () => null,
    ...overrides,
  } as SessionToolContext;
}

/** A project folder whose `.agents/skills/<slug>/SKILL.md` exists. */
function project(): string {
  const dir = join(root, 'project');
  mkdirSync(join(dir, '.agents', 'skills', SLUG), { recursive: true });
  writeFileSync(join(dir, '.agents', 'skills', SLUG, 'SKILL.md'), SKILL, 'utf8');
  return dir;
}

describe('F1.1161 — skill_validate reads the project tier from the context only', () => {
  it('a stale pre-v2 session.jsonl in the workspace root no longer decides the project tier', async () => {
    const dir = project();
    const legacy = join(root, 'workspace', 'sessions', 'session-1');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'session.jsonl'), `${JSON.stringify({ id: 'session-1', workingDirectory: dir })}\n`, 'utf8');

    const result = await handleSkillValidate(ctx(), { skillSlug: SLUG });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('SKILL.md not found');
    expect(text).toContain('Project-level skills (.agents/skills/) were not checked');
  });

  it('CONTROL — the context\'s working directory finds the same project skill', async () => {
    const dir = project();
    const result = await handleSkillValidate(ctx({ workingDirectory: dir }), { skillSlug: SLUG });
    expect(result.content[0]?.text ?? '').toContain(`Validated from project tier: ${join(dir, '.agents', 'skills', SLUG, 'SKILL.md')}`);
  });
});
