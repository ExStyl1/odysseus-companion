import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendMemoryFile,
  capMemoryIndexLoad,
  formatMemoryPromptBlock,
  getMemoryFileMode,
  getProjectMemoryFilePath,
  readMemoryFile,
  getSessionMemoryFilePath,
  getUserMemoryFilePath,
  loadMemoryPromptBlock,
  MEMORY_LOAD_BYTE_LIMIT,
  MEMORY_LOAD_LINE_LIMIT,
  MEMORY_RULES_DIR,
} from '../memory-store.ts';

import { SESSIONS_DIR } from '../../../workspaces/paths.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'nessy-memory-'));
}

describe('memory store', () => {
  it('returns empty content for a missing MEMORY.md', () => {
    const dir = tempDir();
    try {
      expect(readMemoryFile(join(dir, 'MEMORY.md'))).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends memory atomically with a 0600 file mode', () => {
    const dir = tempDir();
    const filePath = join(dir, 'MEMORY.md');
    try {
      appendMemoryFile(filePath, 'User prefers concise status updates.');
      appendMemoryFile(filePath, 'Project uses Bun gates.');

      expect(readMemoryFile(filePath)).toContain('- User prefers concise status updates.');
      expect(readMemoryFile(filePath)).toContain('- Project uses Bun gates.');
      expect(getMemoryFileMode(filePath)).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // R56 · `memory.md:398` — "Any file that has frontmatter gets the field the
  // next time Claude writes it … Claude Code never adds frontmatter to a file
  // that has none." The UI/RPC writer is the sibling of the `remember` tool and
  // must format the file the same way; the helper's own matrix lives in
  // `packages/session-tools-core/src/memory-index.test.ts`.
  it('stamps the modified frontmatter field on the UI/RPC append, keeping mode 0600', () => {
    const dir = tempDir();
    const filePath = join(dir, 'MEMORY.md');
    try {
      writeFileSync(filePath, '---\ntitle: Notes\n---\n\n# Memory\n', 'utf-8');
      appendMemoryFile(filePath, 'User prefers concise status updates.');

      const content = readFileSync(filePath, 'utf-8');
      expect(content).toMatch(/^---\ntitle: Notes\nmodified: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\n---\n/);
      expect(content).toContain('- User prefers concise status updates.');
      expect(getMemoryFileMode(filePath)).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps prompt reads to 200 lines', () => {
    const dir = tempDir();
    const filePath = join(dir, 'MEMORY.md');
    try {
      writeFileSync(filePath, Array.from({ length: 250 }, (_, index) => `line ${index + 1}`).join('\n'), 'utf-8');

      const lines = readMemoryFile(filePath).split('\n');
      expect(lines).toHaveLength(200);
      expect(lines.at(-1)).toBe('line 200');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // `memory.md:384` — "The first 200 lines of `MEMORY.md`, or the first 25KB,
  // whichever comes first, are loaded at the start of every conversation."
  // The line half above is `readMemoryFile`'s own slice; these cover the helper
  // that is the single definition of what loads, including the byte half that
  // had no representation anywhere in the repo.
  describe('capMemoryIndexLoad', () => {
    const cases: Array<{
      name: string;
      text: string;
      expect: (result: string, text: string) => void;
    }> = [
      {
        name: 'cuts on the line cap when it comes first',
        text: Array.from({ length: 250 }, (_, index) => `line ${index + 1}`).join('\n'),
        expect: result => {
          expect(result.split('\n')).toHaveLength(MEMORY_LOAD_LINE_LIMIT);
          expect(result.endsWith('line 200')).toBe(true);
          expect(Buffer.byteLength(result, 'utf-8')).toBeLessThanOrEqual(MEMORY_LOAD_BYTE_LIMIT);
        },
      },
      {
        name: 'cuts on the byte cap when it comes first, on a whole line',
        // 150 lines of ~300 bytes: under the line cap, over 25 KB.
        text: Array.from({ length: 150 }, (_, index) => `line ${index + 1} ${'x'.repeat(300)}`).join('\n'),
        expect: (result, text) => {
          const lines = result.split('\n');
          expect(lines.length).toBeLessThan(150);
          expect(Buffer.byteLength(result, 'utf-8')).toBeLessThanOrEqual(MEMORY_LOAD_BYTE_LIMIT);
          // Whole lines only, in order, no severed tail.
          expect(lines).toEqual(text.split('\n').slice(0, lines.length));
        },
      },
      {
        name: 'keeps a multi-byte character whole when the budget lands astride it',
        // 400 two-byte characters per line; the cut lands mid-line, which is the
        // only shape that can split a character at all.
        text: Array.from({ length: 60 }, () => `- ${'я'.repeat(400)}`).join('\n'),
        expect: result => {
          expect(Buffer.byteLength(result, 'utf-8')).toBeLessThanOrEqual(MEMORY_LOAD_BYTE_LIMIT);
          expect(result).not.toContain('�');
          expect(Buffer.from(result, 'utf-8').toString('utf-8')).toBe(result);
        },
      },
      {
        name: 'never erases the index when one line alone exceeds the byte budget',
        text: `- ${'я'.repeat(MEMORY_LOAD_BYTE_LIMIT)}`,
        expect: result => {
          expect(result.length).toBeGreaterThan(0);
          expect(Buffer.byteLength(result, 'utf-8')).toBeLessThanOrEqual(MEMORY_LOAD_BYTE_LIMIT);
          expect(result).not.toContain('�');
          expect(Buffer.from(result, 'utf-8').toString('utf-8')).toBe(result);
        },
      },
      {
        name: 'leaves an index inside both caps byte-for-byte alone',
        text: Array.from({ length: 30 }, (_, index) => `- entry ${index + 1}`).join('\n'),
        expect: (result, text) => expect(result).toBe(text),
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, () => {
        testCase.expect(capMemoryIndexLoad(testCase.text), testCase.text);
      });
    }

    it('is deterministic on the exact byte boundary', () => {
      // Two-byte characters against an odd budget: the last whole character fits
      // at 24 bytes and the 25th byte would be half of the next one.
      expect(capMemoryIndexLoad('я'.repeat(100), 200, 25)).toBe('я'.repeat(12));
      expect(capMemoryIndexLoad('я'.repeat(100), 200, 24)).toBe('я'.repeat(12));
    });
  });

  it('byte-caps the MEMORY.md index in the fallback composer but never a rule file', () => {
    // `memory.md:390` — "This limit applies only to `MEMORY.md`. CLAUDE.md files
    // are loaded in full regardless of length". Rules load with instruction
    // priority, so they must survive the composer uncapped.
    const workspaceRoot = tempDir();
    const userConfigDir = tempDir();
    const rulesDir = join(workspaceRoot, MEMORY_RULES_DIR);
    // Both ~46 KB across 150 lines: under the line cap, over the byte cap.
    const oversized = (label: string): string =>
      Array.from({ length: 150 }, (_, index) => `- ${label} ${index + 1} ${'x'.repeat(300)}`).join('\n');
    try {
      mkdirSync(rulesDir, { recursive: true });
      writeFileSync(getUserMemoryFilePath(userConfigDir), oversized('index'), 'utf-8');
      writeFileSync(join(rulesDir, 'style.md'), oversized('rule'), 'utf-8');

      const prompt = loadMemoryPromptBlock(workspaceRoot, undefined, { userConfigDir });

      // The rule loads in full — its last line is present.
      expect(prompt).toContain('- rule 150 ');
      // The index does not: its tail is dropped and its head survives.
      expect(prompt).toContain('- index 1 ');
      expect(prompt).not.toContain('- index 150 ');
      const keptIndexLines = prompt.match(/- index \d+ /g) ?? [];
      expect(keptIndexLines.length).toBeGreaterThan(0);
      expect(keptIndexLines.length).toBeLessThan(150);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(userConfigDir, { recursive: true, force: true });
    }
  });

  it('formats memory as a static prompt block', () => {
    expect(formatMemoryPromptBlock('remember this')).toBe('\n\n<memory>\nremember this\n</memory>');
    expect(formatMemoryPromptBlock('')).toBe('');
  });

  it('loads merged project, user, and local session MEMORY.md scopes with deduplication', () => {
    const workspaceRoot = tempDir();
    const workingDirectory = tempDir();
    const userConfigDir = tempDir();
    const workspaceId = `memory-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sessionId = 'session-1';
    try {
      appendMemoryFile(getProjectMemoryFilePath(workingDirectory), 'Project uses Bun gates.');
      appendMemoryFile(getProjectMemoryFilePath(workingDirectory), 'Shared memory line.');
      appendMemoryFile(getUserMemoryFilePath(userConfigDir), 'User prefers concise reports.');
      appendMemoryFile(getUserMemoryFilePath(userConfigDir), 'Shared memory line.');
      appendMemoryFile(getSessionMemoryFilePath(workspaceId, sessionId), 'Session reviewer is Alice.');
      appendMemoryFile(getSessionMemoryFilePath(workspaceId, sessionId), 'Shared memory line.');

      const prompt = loadMemoryPromptBlock(workspaceRoot, sessionId, {
        workingDirectory,
        userConfigDir,
        workspaceId,
        projectTrusted: true,
      });

      expect(prompt).toContain('<memory>');
      expect(prompt).toContain('- User prefers concise reports.');
      expect(prompt).toContain('- Project uses Bun gates.');
      expect(prompt).toContain('- Session reviewer is Alice.');
      expect(prompt.indexOf('Project uses')).toBeLessThan(prompt.indexOf('User prefers'));
      expect(prompt.indexOf('User prefers')).toBeLessThan(prompt.indexOf('Session reviewer'));
      expect(prompt.match(/Shared memory line/g)).toHaveLength(1);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(workingDirectory, { recursive: true, force: true });
      rmSync(userConfigDir, { recursive: true, force: true });
      rmSync(join(SESSIONS_DIR, workspaceId), { recursive: true, force: true });
    }
  });

  it('strips auto-memory markers before dedup so marked and unmarked duplicates collapse', () => {
    const userConfigDir = tempDir();
    try {
      writeFileSync(getUserMemoryFilePath(userConfigDir), [
        '# Memory',
        '',
        '- Shared memory line.',
        '',
        '- Shared memory line. <!-- nessy:auto:2026-07-18 -->',
        '',
        '- Agent-only line. <!-- nessy:auto:2026-07-18 -->',
        '',
      ].join('\n'), 'utf-8');

      const prompt = loadMemoryPromptBlock(undefined, undefined, { userConfigDir });

      expect(prompt).not.toContain('nessy:auto');
      expect(prompt).toContain('- Agent-only line.');
      expect(prompt.match(/Shared memory line/g)).toHaveLength(1);
    } finally {
      rmSync(userConfigDir, { recursive: true, force: true });
    }
  });

  it('withholds project MEMORY.md when the project is untrusted but keeps user memory', () => {
    const workingDirectory = tempDir();
    const userConfigDir = tempDir();
    try {
      appendMemoryFile(getProjectMemoryFilePath(workingDirectory), 'Project-only secret memory.');
      appendMemoryFile(getUserMemoryFilePath(userConfigDir), 'User memory always loads.');

      const prompt = loadMemoryPromptBlock(undefined, undefined, {
        workingDirectory,
        userConfigDir,
        // projectTrusted omitted -> fail-closed
      });

      expect(prompt).not.toContain('Project-only secret memory.');
      expect(prompt).toContain('User memory always loads.');
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
      rmSync(userConfigDir, { recursive: true, force: true });
    }
  });

  it('inlines @import and @path references from memory files', () => {
    const workingDirectory = tempDir();
    try {
      writeFileSync(join(workingDirectory, 'imported.md'), 'Imported memory line.\n', 'utf-8');
      writeFileSync(join(workingDirectory, 'also-imported.md'), 'Also imported line.\n', 'utf-8');
      writeFileSync(getProjectMemoryFilePath(workingDirectory), [
        '# Memory',
        '@import ./imported.md',
        '@also-imported.md',
      ].join('\n'), 'utf-8');

      const prompt = loadMemoryPromptBlock(undefined, undefined, { workingDirectory, projectTrusted: true });

      expect(prompt).toContain('Imported memory line.');
      expect(prompt).toContain('Also imported line.');
      expect(prompt).not.toContain('@import ./imported.md');
      expect(prompt).not.toContain('@also-imported.md');
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });

  it('stops a five-deep import chain at the documented four hops', () => {
    // `memory.md:97` — "Imported files can recursively import other files, with a
    // maximum depth of four hops." The root is hop 0; hop 5 must not load.
    // MEMORY_IMPORT_DEPTH_LIMIT was 5, so it did.
    const workingDirectory = tempDir();
    try {
      writeFileSync(getProjectMemoryFilePath(workingDirectory), '# Memory\n@./hop1.md\n', 'utf-8');
      for (const hop of [1, 2, 3, 4]) {
        writeFileSync(join(workingDirectory, `hop${hop}.md`), `hop ${hop} body\n@./hop${hop + 1}.md\n`, 'utf-8');
      }
      writeFileSync(join(workingDirectory, 'hop5.md'), 'hop 5 body\n', 'utf-8');

      const prompt = loadMemoryPromptBlock(undefined, undefined, { workingDirectory, projectTrusted: true });

      for (const hop of [1, 2, 3, 4]) expect(prompt).toContain(`hop ${hop} body`);
      expect(prompt).not.toContain('hop 5 body');
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });

  it('reads imports anywhere in a line, and never inside a code span, a fence or a comment', () => {
    // `memory.md:99` and `:101`. One recogniser, shared with both live
    // deliveries — the fallback composer must not be able to disagree with them
    // about what a file says.
    const workingDirectory = tempDir();
    try {
      for (const name of ['README', 'package.json', 'backticked.md', 'fenced.md', 'commented.md']) {
        writeFileSync(join(workingDirectory, name), `body of ${name}`, 'utf-8');
      }
      writeFileSync(getProjectMemoryFilePath(workingDirectory), [
        '# Memory',
        'See @README for project overview and @package.json for available npm commands for this project.',
        'Write `@backticked.md` in backticks to keep it literal.',
        '```text',
        '@fenced.md',
        '```',
        '<!-- @commented.md -->',
      ].join('\n'), 'utf-8');

      const prompt = loadMemoryPromptBlock(undefined, undefined, { workingDirectory, projectTrusted: true });

      expect(prompt).toContain('body of README');
      expect(prompt).toContain('body of package.json');
      // The prose that names them survives — deleting the line would take the
      // whole sentence with it.
      expect(prompt).toContain('See @README for project overview');
      expect(prompt).not.toContain('body of backticked.md');
      expect(prompt).not.toContain('body of fenced.md');
      expect(prompt).not.toContain('body of commented.md');
      expect(prompt).toContain('`@backticked.md`');
      expect(prompt).toContain('@fenced.md');
      // `memory.md:161` — the block-level comment itself never reaches the model.
      expect(prompt).not.toContain('@commented.md');
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });

  it('loads unscoped .agents/rules markdown recursively, and never `paths:` rules', () => {
    // R28: a `paths` glob describes the FILE the rule fires on, so it cannot be
    // evaluated against the working directory. The legacy prompt block now
    // carries unscoped rules only (any working directory), and path-scoped
    // rules reach the model through the per-read trigger instead.
    const workspaceRoot = tempDir();
    const appDirectory = join(workspaceRoot, 'packages', 'app');
    const rulesDir = join(workspaceRoot, '.agents', 'rules');
    try {
      mkdirSync(appDirectory, { recursive: true });
      mkdirSync(join(rulesDir, 'frontend'), { recursive: true });

      writeFileSync(join(rulesDir, 'style.md'), 'Use unscoped memory rules.', 'utf-8');
      writeFileSync(join(rulesDir, 'frontend', 'react.md'), 'Use nested memory rules.', 'utf-8');
      writeFileSync(join(rulesDir, 'app.md'), [
        '---',
        'paths:',
        '  - packages/app/**',
        '---',
        'Use app-specific memory rules.',
      ].join('\n'), 'utf-8');

      for (const workingDirectory of [appDirectory, workspaceRoot]) {
        const prompt = loadMemoryPromptBlock(workspaceRoot, 'session-1', { workingDirectory });
        expect(prompt).toContain('Use unscoped memory rules.');
        expect(prompt).toContain('Use nested memory rules.');
        expect(prompt).not.toContain('Use app-specific memory rules.');
      }
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
