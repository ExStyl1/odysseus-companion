import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SessionToolContext } from '../context.ts';
import { handleRemember } from './remember.ts';

interface TestContextOptions {
  dataPath: string;
  memoryEnabled?: boolean;
  workingDirectory?: string;
  userMemoryPath?: string;
}

function makeContext(options: TestContextOptions): SessionToolContext {
  return {
    configRoot: '/config',
    sessionId: 'session-1',
    workspacePath: '/workspace',
    sourcesPath: '/workspace/sources',
    skillsPath: '/workspace/skills',
    plansFolderPath: '/workspace/sessions/session-1/plans',
    callbacks: {
      onPlanSubmitted: () => {},
      onAuthRequest: () => {},
    },
    fs: {} as SessionToolContext['fs'],
    loadSourceConfig: () => null,
    dataPath: options.dataPath,
    memoryEnabled: options.memoryEnabled ?? true,
    workingDirectory: options.workingDirectory,
    userMemoryPath: options.userMemoryPath,
  };
}

describe('handleRemember', () => {
  it('writes MEMORY.md in the session data folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nessy-remember-'));
    try {
      const result = await handleRemember(makeContext({ dataPath: dir }), { memory: 'Keep reviewer notes short.' });
      const filePath = join(dir, 'MEMORY.md');

      expect(result.isError).toBe(false);
      expect(result.content[0]?.text).toContain(filePath);
      // Agent-written entries carry the auto-memory marker (stripped at load,
      // consumed by the scheduled cleanup pass).
      expect(readFileSync(filePath, 'utf-8')).toMatch(
        /- Keep reviewer notes short\. <!-- nessy:auto:\d{4}-\d{2}-\d{2} -->/
      );
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes project-scoped MEMORY.md in the working directory', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nessy-remember-data-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'nessy-remember-project-'));
    try {
      const result = await handleRemember(
        makeContext({ dataPath: dataDir, workingDirectory: projectDir }),
        { memory: 'Project uses Bun gates.', scope: 'project' }
      );
      const filePath = join(projectDir, 'MEMORY.md');

      expect(result.isError).toBe(false);
      expect(result.content[0]?.text).toContain(filePath);
      expect(readFileSync(filePath, 'utf-8')).toContain('- Project uses Bun gates.');
      expect(existsSync(join(dataDir, 'MEMORY.md'))).toBe(false);
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('writes user-scoped MEMORY.md to the injected app memory path', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nessy-remember-data-'));
    const appDir = mkdtempSync(join(tmpdir(), 'nessy-remember-app-'));
    try {
      const filePath = join(appDir, 'MEMORY.md');
      const result = await handleRemember(
        makeContext({ dataPath: dataDir, userMemoryPath: filePath }),
        { memory: 'User prefers compact reports.', scope: 'user' }
      );

      expect(result.isError).toBe(false);
      expect(result.content[0]?.text).toContain(filePath);
      expect(readFileSync(filePath, 'utf-8')).toContain('- User prefers compact reports.');
      expect(existsSync(join(dataDir, 'MEMORY.md'))).toBe(false);
      expect(existsSync(join(appDir, '.nessy'))).toBe(false);
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(appDir, { recursive: true, force: true });
    }
  });

  // R56 · `memory.md:386` — the post-write measurement and its two outcomes.
  describe('post-write index measurement', () => {
    it('reminds the model when the write lands near a limit, and still saves', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'nessy-remember-near-'));
      const filePath = join(dir, 'MEMORY.md');
      try {
        // 180 lines is the 90 % near threshold; the append adds a blank line and
        // the entry, landing at 182 — near, not over.
        writeFileSync(filePath, Array.from({ length: 180 }, (_, i) => `- fact ${i + 1}`).join('\n'), 'utf-8');

        const result = await handleRemember(makeContext({ dataPath: dir }), { memory: 'One more fact.' });

        expect(result.isError).toBe(false);
        expect(result.content[0]?.text).toContain('Saved memory to');
        expect(result.content[0]?.text).toContain('near its read limit');
        expect(result.content[0]?.text).toContain('182 of 200 lines');
        expect(readFileSync(filePath, 'utf-8')).toContain('- One more fact.');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('returns the documented error over a limit — and the write still lands on disk', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'nessy-remember-over-'));
      const filePath = join(dir, 'MEMORY.md');
      try {
        writeFileSync(filePath, Array.from({ length: 212 }, (_, i) => `- fact ${i + 1}`).join('\n'), 'utf-8');

        const result = await handleRemember(makeContext({ dataPath: dir }), { memory: 'Over the edge.' });

        // `memory.md:386` — "the write still succeeds, but Claude Code returns an
        // error telling Claude to rewrite the index". Not a rollback.
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain('[ERROR] this write left the memory index at');
        expect(result.content[0]?.text).toContain('at 214 lines, over its 200-line read limit');
        expect(result.content[0]?.text).toContain('The write succeeded');
        expect(result.content[0]?.text).toContain('Rewrite it to under 140 lines now');
        expect(readFileSync(filePath, 'utf-8')).toContain('- Over the edge.');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // R56 · `memory.md:398` — the `modified` frontmatter stamp, and its ceiling.
  describe('modified frontmatter stamp', () => {
    it('stamps a file that has frontmatter and keeps the rest of the block intact', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'nessy-remember-fm-'));
      const filePath = join(dir, 'MEMORY.md');
      try {
        writeFileSync(filePath, '---\ntitle: Notes\n---\n\n# Memory\n', 'utf-8');

        await handleRemember(makeContext({ dataPath: dir }), { memory: 'First fact.' });
        const first = readFileSync(filePath, 'utf-8');
        await handleRemember(makeContext({ dataPath: dir }), { memory: 'Second fact.' });
        const second = readFileSync(filePath, 'utf-8');

        expect(first).toMatch(/^---\ntitle: Notes\nmodified: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\n---\n/);
        // The bullet lands after the closing fence, not inside the block.
        expect(first.slice(first.indexOf('\n---\n', 4))).toContain('- First fact.');
        // Refreshed, never duplicated.
        expect(second.match(/^modified:/gm)).toHaveLength(1);
        expect(second).toContain('title: Notes');
        expect(second).toContain('- Second fact.');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('never adds frontmatter to a file that has none', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'nessy-remember-nofm-'));
      const filePath = join(dir, 'MEMORY.md');
      try {
        // Both shapes the writer can produce: a fresh seed and an append.
        await handleRemember(makeContext({ dataPath: dir }), { memory: 'Seeded fact.' });
        await handleRemember(makeContext({ dataPath: dir }), { memory: 'Appended fact.' });

        const content = readFileSync(filePath, 'utf-8');
        expect(content.startsWith('---')).toBe(false);
        expect(content).not.toContain('modified:');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('blocks when memory is disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nessy-remember-'));
    try {
      const result = await handleRemember(makeContext({ dataPath: dir, memoryEnabled: false }), { memory: 'do not save' });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('Memory is disabled');
      expect(existsSync(join(dir, 'MEMORY.md'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * P6.389 — the four documented kinds of note, recorded as a `type`
   * frontmatter field. `memory.md`: "Claude saves four kinds of notes for
   * itself. Claude records the kind as a `type` field in the memory file's
   * frontmatter".
   */
  describe('the documented note kind', () => {
    it('records the kind in frontmatter, and stamps `modified` in the block it created', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'nessy-remember-type-'));
      try {
        const result = await handleRemember(
          makeContext({ dataPath: dir }),
          { memory: 'Prefers short reviews.', type: 'feedback' },
        );
        expect(result.isError).toBe(false);
        const text = readFileSync(join(dir, 'MEMORY.md'), 'utf-8');
        expect(text.startsWith('---\ntype: feedback\n')).toBe(true);
        expect(text).toMatch(/^modified: /m);
        expect(text).toContain('Prefers short reviews.');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('leaves an existing kind alone — an index holds notes of several kinds', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'nessy-remember-type2-'));
      try {
        const ctx = makeContext({ dataPath: dir });
        await handleRemember(ctx, { memory: 'Role: reviewer.', type: 'user' });
        await handleRemember(ctx, { memory: 'Prefers short reviews.', type: 'feedback' });
        const text = readFileSync(join(dir, 'MEMORY.md'), 'utf-8');
        expect(text).toContain('type: user');
        expect(text).not.toContain('type: feedback');
        expect(text).toContain('Prefers short reviews.');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('refuses an unknown kind BY NAME and writes nothing', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'nessy-remember-type3-'));
      try {
        const result = await handleRemember(
          makeContext({ dataPath: dir }),
          { memory: 'Prefers short reviews.', type: 'preference' },
        );
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain('preference');
        expect(result.content[0]?.text).toContain('user, feedback, project, reference');
        expect(existsSync(join(dir, 'MEMORY.md'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

/**
 * P-WJ-c-2 (WJ-c's proposed row, taken in place by WJ-f) — the project scope
 * takes an ABSOLUTE directory, on all three runtimes.
 *
 * `getMemoryPath`'s project branch was a truthiness test, so any non-empty
 * string was accepted and `join('docs', 'MEMORY.md')` resolves against THIS
 * PROCESS's own working directory — the codex child's, or the app's — which no
 * caller ever chose. The three binders all pass the raw
 * `session.workingDirectory` with no absoluteness check of their own (pi's
 * `getSessionToolContext`, claude's `getSessionScopedTools(...)` call site and
 * the `--working-directory` argv the codex child spreads), which is why the
 * guard sits in the shared handler rather than in one of them: a check on one
 * runtime would have manufactured exactly the silent divergence the host exists
 * to remove.
 *
 * The rows run under a temporary CWD and restore it in a `finally`. That is not
 * hygiene, it is the instrument: a regression of this guard WRITES, and without
 * the chdir the file it writes lands in the repository — so the assertion that
 * nothing was written is both meaningful and safe. Only non-escaping values are
 * driven for the same reason.
 */
describe('handleRemember · scope=project refuses a RELATIVE working directory', () => {
  const RELATIVE = ['.', 'docs', './nested/project', '~/project'];

  it.each(RELATIVE)('refuses %j by name and writes nothing beside the process cwd', async (relative) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nessy-remember-rel-data-'));
    const cwd = mkdtempSync(join(tmpdir(), 'nessy-remember-rel-cwd-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(cwd);
      const result = await handleRemember(
        makeContext({ dataPath: dataDir, workingDirectory: relative }),
        { memory: 'Relative project directories are refused.', scope: 'project' },
      );

      expect(result.isError).toBe(true);
      // Named: the sentence says which fault this is and carries the value the
      // host bound, because a user cannot see it anywhere else.
      expect(result.content[0]?.text).toContain('ABSOLUTE workingDirectory');
      expect(result.content[0]?.text).toContain(JSON.stringify(relative));
      // And the write did not happen anywhere the value could have pointed.
      expect(existsSync(resolve(cwd, relative, 'MEMORY.md'))).toBe(false);
      expect(existsSync(join(dataDir, 'MEMORY.md'))).toBe(false);
    } finally {
      process.chdir(previousCwd);
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('still SAVES for an absolute directory — the control that proves the guard discriminates', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nessy-remember-abs-data-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'nessy-remember-abs-project-'));
    try {
      const result = await handleRemember(
        makeContext({ dataPath: dataDir, workingDirectory: projectDir }),
        { memory: 'Absolute project directories still save.', scope: 'project' },
      );

      expect(result.isError).toBe(false);
      expect(readFileSync(join(projectDir, 'MEMORY.md'), 'utf-8'))
        .toContain('- Absolute project directories still save.');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('leaves the NO-PROJECT sentence byte-identical', async () => {
    // The refusal every runtime already answers for a session that chose no
    // project. It is quoted in `session-mcp-server`'s own context docblock and
    // asserted by `remember-scopes.test.ts` over the real transport, so a guard
    // that folded the two faults into one message would have moved a sentence
    // users and two other suites already depend on.
    const dataDir = mkdtempSync(join(tmpdir(), 'nessy-remember-none-'));
    try {
      const result = await handleRemember(
        makeContext({ dataPath: dataDir }),
        { memory: 'No project here.', scope: 'project' },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text)
        .toBe('[ERROR] remember with scope=project requires workingDirectory in context.');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
