import { describe, expect, it } from 'bun:test';
import {
  SESSION_OUTPUT_SUMMARY_MAX_CHARS,
  summarizeSessionOutput,
  type SessionOutputMessage,
} from '../session-activity-summary.ts';

/**
 * P6.504 — the session-list activity line, derived with NO model call.
 *
 * The assertions that matter are the ones about what it REFUSES to produce: the
 * whole safety of a line rendered on forty rows is that it never invents, and
 * never quotes markup at the user.
 */
const m = (over: Partial<SessionOutputMessage> & { type: string }): SessionOutputMessage => ({ ...over });

describe('summarizeSessionOutput', () => {
  it('takes the first sentence of the last final assistant message', () => {
    expect(summarizeSessionOutput([
      m({ type: 'user', content: 'fix the failing build' }),
      m({ type: 'assistant', content: 'Old turn, should not win.' }),
      m({ type: 'tool', content: 'bun test' }),
      m({ type: 'assistant', content: 'The build is green again. I removed the duplicate import in `app.ts`.' }),
    ])).toBe('The build is green again.');
  });

  it('prefers a plan, because a plan IS what the session last produced', () => {
    expect(summarizeSessionOutput([
      m({ type: 'assistant', content: 'Looking into it.' }),
      m({ type: 'plan', content: '## Plan\n\n- Split the adapter\n\nI will split the adapter first.' }),
    ])).toBe('Plan Split the adapter I will split the adapter first.');
  });

  it('skips intermediate commentary — it is not the turn\'s answer', () => {
    expect(summarizeSessionOutput([
      m({ type: 'assistant', content: 'Done: the migration ran clean.' }),
      m({ type: 'assistant', content: 'Let me check one more file.', isIntermediate: true }),
    ])).toBe('Done: the migration ran clean.');
  });

  it('strips code fences, reasoning blocks and mentions rather than quoting them at the user', () => {
    const line = summarizeSessionOutput([
      m({ type: 'assistant', content: '```diff\n- old\n+ new\n```\n[file:src/a.ts] <thinking>x</thinking> **Applied** the patch to a.ts' }),
    ]);
    expect(line).toBe('Applied the patch to a.ts');
    expect(line).not.toContain('```');
    expect(line).not.toContain('<');
    // The reasoning block goes CONTENT AND ALL: a list row is visible without
    // opening the session, and reasoning is the model addressing itself.
    expect(line).not.toContain('x');
  });

  it('boundary — a long unpunctuated turn is cut on a word and marked as cut', () => {
    const long = `${'alpha '.repeat(60)}omega`;
    const line = summarizeSessionOutput([m({ type: 'assistant', content: long })])!;
    expect(line.length).toBeLessThanOrEqual(SESSION_OUTPUT_SUMMARY_MAX_CHARS + 1);
    expect(line.endsWith('…')).toBe(true);
    // Cut on a word boundary, never mid-token.
    expect(line.slice(0, -1).trim().endsWith('alpha')).toBe(true);
  });

  it('negative — invents nothing when there is no readable output', () => {
    expect(summarizeSessionOutput([])).toBeUndefined();
    expect(summarizeSessionOutput(undefined)).toBeUndefined();
    // A session that has only ever received a user turn.
    expect(summarizeSessionOutput([m({ type: 'user', content: 'hello' })])).toBeUndefined();
    // A last turn that is nothing but a code fence.
    expect(summarizeSessionOutput([m({ type: 'assistant', content: '```\nrm -rf build\n```' })])).toBeUndefined();
    // A last turn with no content at all (tool-only).
    expect(summarizeSessionOutput([m({ type: 'assistant' })])).toBeUndefined();
  });

  /**
   * The row's claim of runtime uniformity. There is no runtime input to this
   * function at all — the same stored transcript yields the same line whoever
   * wrote it — so the assertion is that the three identical inputs agree, and
   * the control is that a DIFFERENT transcript does not.
   */
  it('is runtime-blind by construction', () => {
    const transcript = [m({ type: 'assistant', content: 'Refactored the adapter. Tests pass.' })];
    const a = summarizeSessionOutput(transcript);
    const b = summarizeSessionOutput([...transcript]);
    expect(a).toBe(b!);
    expect(a).toBe('Refactored the adapter.');
    expect(summarizeSessionOutput([m({ type: 'assistant', content: 'Something else entirely.' })])).not.toBe(a!);
  });
});
