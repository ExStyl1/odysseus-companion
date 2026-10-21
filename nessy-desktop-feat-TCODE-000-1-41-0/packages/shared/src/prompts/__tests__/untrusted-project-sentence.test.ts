/**
 * F1.791 — the `claude-project-trust` and `codex-project-trust` session facts
 * reached only the diagnostics RPC (`session:getRecentStderr`), never the
 * model, so a model in an untrusted project could not explain why the
 * project's instructions were missing. One sentence now reaches the model:
 * through `getSystemPrompt` (Pi's base prompt and Claude's preset append) and
 * through codex's one prose channel, `codexDeveloperInstructions`.
 *
 * The heading is spelled here rather than imported, so the arms load (and fail
 * for the missing sentence) on a tree without the row.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSystemPrompt } from '../system.ts';
import { CodexAgent, codexDeveloperInstructions, type CodexDeveloperSections } from '../../agent/codex-agent.ts';

const HEADING = '## Project Trust';
const root = mkdtempSync(join(tmpdir(), 'nessy-f1791-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function promptFor(projectTrusted: boolean | undefined): string {
  return getSystemPrompt(undefined, undefined, root, root, undefined, undefined, false, 'session-f1791', undefined, 'ws-f1791', projectTrusted);
}

const developerSections = (self: Record<string, unknown>, port: number | undefined): CodexDeveloperSections | undefined =>
  (CodexAgent.prototype as unknown as { developerSections(this: unknown, port: number | undefined): CodexDeveloperSections | undefined })
    .developerSections.call({ buildSessionMcpSpec: () => undefined, ...self }, port);

describe('F1.791 · the model is told when the project is not trusted', () => {
  it('Pi and Claude: an untrusted project\'s system prompt says why its instructions are missing', () => {
    const prompt = promptFor(false);
    expect(prompt).toContain(HEADING);
    expect(prompt).toContain('Trust the project');
  });

  it('NEGATIVE — a trusted project, and a caller that passes no trust, get no such sentence', () => {
    expect(promptFor(true)).not.toContain(HEADING);
    expect(promptFor(undefined)).not.toContain(HEADING);
  });

  it('codex: an untrusted project with a root gets the section on its developer channel, with or without the bridge', () => {
    const sections = developerSections({ workingDirectory: root, config: { projectTrusted: false } }, undefined);
    expect(sections?.projectTrust).toContain(HEADING);
    expect(codexDeveloperInstructions(undefined, sections)).toContain(HEADING);
  });

  it('codex NEGATIVE — a trusted project, and a session with no working directory, get none', () => {
    expect(developerSections({ workingDirectory: root, config: { projectTrusted: true } }, undefined)?.projectTrust).toBeUndefined();
    expect(developerSections({ workingDirectory: undefined, config: { projectTrusted: false } }, undefined)?.projectTrust).toBeUndefined();
    expect(codexDeveloperInstructions()).not.toContain(HEADING);
  });
});
