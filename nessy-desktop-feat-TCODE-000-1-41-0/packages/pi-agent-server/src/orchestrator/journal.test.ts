/**
 * P2.184 — A PER-ITEM LOOP MUST CONTAIN ITS OWN FAILURE, or one bad item
 * silently becomes zero items processed.
 *
 * The journal is the worst instance of that class in this tree, because of
 * WHICH item is bad. It is append-only and written a line at a time, so the one
 * line that can be torn is the LAST one, after a crash — exactly the case an
 * append-only journal exists to survive. A bare per-line `JSON.parse` meant
 * that torn tail threw out of `load`, out of the CONSTRUCTOR, and out of
 * `execute` (the `new WorkflowJournal(...)` in `workflow-tool.ts` sits outside
 * its try), so a resume died with a raw `SyntaxError` that never mentions the
 * journal — and every good line before the bad one was discarded to punish it.
 *
 * The channel is the run's existing `logs`, rendered by `contentForResult`. A
 * SILENT partial replay would be its own defect: the model was told those
 * `agent()` calls would be skipped, and it has to learn that they will not be.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowJournal } from './journal.ts';
import type { ChildSessionResult } from './spawner.ts';

let sessionPath: string;

beforeEach(() => {
  sessionPath = mkdtempSync(join(tmpdir(), 'p2184-journal-'));
});

afterEach(() => {
  // Only ever the directory this test made, under the system temp dir.
  if (sessionPath.startsWith(tmpdir())) rmSync(sessionPath, { recursive: true, force: true });
});

function result(text: string): ChildSessionResult {
  return {
    agentId: `agent-${text}`,
    label: text,
    status: 'completed',
    text,
    tokensIn: 1,
    tokensOut: 2,
  } as unknown as ChildSessionResult;
}

/** Write a resume journal verbatim, so a torn tail can be written as one. */
function writeJournal(runId: string, body: string): void {
  const dir = join(sessionPath, '.orchestrator');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.jsonl`), body);
}

function line(promptHash: string, text: string): string {
  return `${JSON.stringify({ promptHash, result: result(text) })}\n`;
}

describe('WorkflowJournal.load — one torn line costs one line', () => {
  it('keeps every good line before a torn tail, and NAMES what it dropped', () => {
    // The realistic shape: the process died mid-`appendFileSync`.
    writeJournal('prev', `${line('h1', 'one')}${line('h2', 'two')}{"promptHash":"h3","resu`);

    const journal = new WorkflowJournal(sessionPath, 'run-2', 'prev');

    // Identity, not "something survived": both good entries, by hash.
    expect(journal.get('h1')?.text).toBe('one');
    expect(journal.get('h2')?.text).toBe('two');
    expect(journal.get('h3')).toBeUndefined();
    expect(journal.loadWarnings).toHaveLength(1);
    expect(journal.loadWarnings[0]).toContain('skipped 1 unreadable line(s)');
    expect(journal.loadWarnings[0]).toContain('2 cached result(s) kept');
  });

  it('does not throw out of the constructor on a torn journal', () => {
    // This is the before-state, stated as its own case: the throw escaped
    // `load`, the constructor, and `execute`, killing the whole workflow run.
    writeJournal('prev', 'not json at all\n');
    expect(() => new WorkflowJournal(sessionPath, 'run-2', 'prev')).not.toThrow();
  });

  it('a line that parses but is not a record counts as skipped, not as replayed', () => {
    writeJournal('prev', `${line('h1', 'one')}{"promptHash":42,"result":null}\n`);

    const journal = new WorkflowJournal(sessionPath, 'run-2', 'prev');

    expect(journal.get('h1')?.text).toBe('one');
    expect(journal.loadWarnings[0]).toContain('skipped 1 unreadable line(s)');
  });

  it('an unreadable journal FILE costs the replay, not the run, and says so', () => {
    // A directory where the journal should be: `readFileSync` throws EISDIR,
    // which used to escape the constructor exactly like a torn line.
    mkdirSync(join(sessionPath, '.orchestrator', 'prev.jsonl'), { recursive: true });

    const journal = new WorkflowJournal(sessionPath, 'run-2', 'prev');

    expect(journal.loadWarnings).toHaveLength(1);
    expect(journal.loadWarnings[0]).toContain('journal replay unavailable');
    expect(journal.loadWarnings[0]).toContain('every agent() call will run again');
  });

  it('POSITIVE CONTROL: a clean journal replays fully and warns about nothing', () => {
    // Without this the assertions above could be satisfied by a journal that
    // always warns, and "it named the loss" would mean nothing.
    writeJournal('prev', `${line('h1', 'one')}${line('h2', 'two')}`);

    const journal = new WorkflowJournal(sessionPath, 'run-2', 'prev');

    expect(journal.get('h1')?.text).toBe('one');
    expect(journal.get('h2')?.text).toBe('two');
    expect(journal.loadWarnings).toEqual([]);
  });

  it('POSITIVE CONTROL: no resume run id means no replay and no warning', () => {
    const journal = new WorkflowJournal(sessionPath, 'run-2');
    expect(journal.loadWarnings).toEqual([]);
    expect(journal.get('h1')).toBeUndefined();
  });
});

describe('the warnings reach the run\'s own log channel', () => {
  // Driving `workflowTool.execute` end to end would need a whole spawner; what
  // is worth pinning here is the WIRING, because a `loadWarnings` nobody reads
  // is the same silence in a different place.
  const source = readFileSync(join(import.meta.dir, 'workflow-tool.ts'), 'utf-8');

  it('workflow-tool reads loadWarnings into `logs`', () => {
    const wiring = source.match(/for \(const warning of journal\.loadWarnings\) logs\.push\(warning\)/g) ?? [];
    expect(wiring).toHaveLength(1);
    // Into `logs`, which `contentForResult` renders — not into a new field.
    expect(source).toContain('function contentForResult(result: OrchestrationResultPayload, logs: string[]');
  });

  it('POSITIVE CONTROL: the wiring detector flags a source with the push removed', () => {
    const stripped = source.replace(/for \(const warning of journal\.loadWarnings\) logs\.push\(warning\);/, '');
    expect(stripped.match(/journal\.loadWarnings\) logs\.push/g) ?? []).toHaveLength(0);
  });
});
