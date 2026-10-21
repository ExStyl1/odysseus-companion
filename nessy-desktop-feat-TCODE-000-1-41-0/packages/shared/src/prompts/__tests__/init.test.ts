import { describe, expect, it } from 'bun:test';

import {
  INIT_PROJECT_INSTRUCTIONS_FILENAME,
  INIT_PROJECT_INSTRUCTIONS_PROMPT,
} from '../init.ts';

describe('init project-instructions prompt', () => {
  it('matches the scaffold prompt snapshot', () => {
    // Snapshot the load-bearing macro contract: title "Repository Guidelines",
    // inspect-first, append-not-overwrite, the section outline, and the
    // 200-400 word length target.
    expect(INIT_PROJECT_INSTRUCTIONS_PROMPT).toMatchSnapshot();
  });

  it('targets AGENTS.md, our project context filename', () => {
    expect(INIT_PROJECT_INSTRUCTIONS_FILENAME).toBe('AGENTS.md');
    expect(INIT_PROJECT_INSTRUCTIONS_PROMPT).toContain('AGENTS.md');
    // The Codex "Repository Guidelines" contributor-guide framing.
    expect(INIT_PROJECT_INSTRUCTIONS_PROMPT).toContain('Repository Guidelines');
    expect(INIT_PROJECT_INSTRUCTIONS_PROMPT).toContain('200-400 words');
  });

  it('instructs inspecting the repo before writing', () => {
    expect(INIT_PROJECT_INSTRUCTIONS_PROMPT).toContain('inspect the repository');
    expect(INIT_PROJECT_INSTRUCTIONS_PROMPT).toContain('Do not invent');
  });

  it('refuses to overwrite an existing file and offers append/improve instead', () => {
    // Overwrite-safety branch: never replace an existing AGENTS.md.
    expect(INIT_PROJECT_INSTRUCTIONS_PROMPT).toContain('already exists');
    expect(INIT_PROJECT_INSTRUCTIONS_PROMPT).toContain('do NOT overwrite or replace it');
    expect(INIT_PROJECT_INSTRUCTIONS_PROMPT).toContain('append or improve it in place');
  });

  it('names the contributor-guide sections', () => {
    for (const section of [
      'Project Structure & Module Organization',
      'Build, Test, and Development Commands',
      'Coding Style & Naming Conventions',
      'Testing Guidelines',
      'Commit & Pull Request Guidelines',
    ]) {
      expect(INIT_PROJECT_INSTRUCTIONS_PROMPT).toContain(section);
    }
  });

  it('routes the write through the normal permission-gated tool path', () => {
    // Trust/permission invariant: the macro grants no elevated access; the
    // agent writes through its usual approval-gated file tool.
    expect(INIT_PROJECT_INSTRUCTIONS_PROMPT).toContain('normal file-writing tool');
    expect(INIT_PROJECT_INSTRUCTIONS_PROMPT).toContain('usual approval');
  });
});
