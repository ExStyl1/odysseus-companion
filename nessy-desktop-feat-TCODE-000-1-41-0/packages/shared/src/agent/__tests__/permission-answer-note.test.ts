/**
 * P6.864 (the YES arm) — the note a user attaches when they APPROVE a
 * permission prompt reaches the model.
 *
 * `permissions.md#add-a-comment-when-you-answer-a-permission-prompt`, verbatim:
 * *"**Yes**: Claude Code runs the action, then sends your comment to Claude
 * after the result."* The NO half is native on all three runtimes and landed as
 * P6.951 (claude, codex) and P6.963 (Pi). This half has NO channel on any of
 * them — the SDK's allow branch carries no feedback field, codex's approval
 * response has nowhere to put one, and a Pi allow receipt's `reason` is absent
 * by contract — so the host supplies it once, on `BaseAgent`, and every backend
 * inherits the queue.
 *
 * The behaviour is exercised on a real agent; the DELIVERY is pinned by source
 * for the other two, because importing three agent module graphs in one file
 * costs minutes and proves nothing the text does not (each backend composes its
 * own user tail, and the question is only whether the drain is in it).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-answer-note',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-root',
      workspaceRootPath: '/tmp/ws-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-answer-note',
    } as never,
    session: {
      id: 'session-answer-note',
      workspaceRootPath: '/tmp/ws-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as never,
    model: 'pi/test-model',
    isHeadless: true,
  };
}

interface NoteQueue {
  recordPermissionAnswerNote(note: string): void;
  consumePermissionAnswerNotes(): string | undefined;
}

function queue(): NoteQueue {
  return new PiAgent(createConfig()) as unknown as NoteQueue;
}

/** Comment-stripped source, so a docblock quoting a call is not the evidence. */
function stripped(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the approval note queue (P6.864)', () => {
  it('carries the user’s words with the sentence that gives them a referent', () => {
    const agent = queue();
    agent.recordPermissionAnswerNote('  use the staging bucket  ');

    const drained = agent.consumePermissionAnswerNotes();
    // Read into a local BEFORE asserting a shape — see AGENTS.md on
    // `toMatchObject` overwriting the value it matched.
    expect(drained).toContain('use the staging bucket');
    // Trimmed: whitespace is not a note, exactly as the card and the deny arm
    // treat it.
    expect(drained).not.toContain('  use the staging bucket  ');
    // By the time the model reads this, the approval it belongs to is already
    // above it in the transcript — without the sentence the note reads as a
    // fresh instruction with no referent.
    expect(drained).toContain('approving a permission prompt');
    expect(drained).toContain('<permission_answer_notes>');
  });

  it('is ONE-SHOT, like every other host queue on this tail', () => {
    const agent = queue();
    agent.recordPermissionAnswerNote('first');
    expect(agent.consumePermissionAnswerNotes()).toContain('first');
    // NEGATIVE: a second turn must not re-read it. A re-stamped preamble is the
    // #862 shape, and this text is user-authored guidance that has already been
    // acted on.
    expect(agent.consumePermissionAnswerNotes()).toBeUndefined();
  });

  it('keeps every note of a burst, in the order they were answered', () => {
    const agent = queue();
    agent.recordPermissionAnswerNote('one');
    agent.recordPermissionAnswerNote('two');
    const drained = agent.consumePermissionAnswerNotes() ?? '';
    expect(drained.indexOf('one')).toBeGreaterThan(-1);
    expect(drained.indexOf('two')).toBeGreaterThan(drained.indexOf('one'));
    // Plural, because the sentence is read by a model that has to know how many
    // things it is being handed.
    expect(drained).toContain('these notes');
  });

  it('ignores an empty answer and is bounded on both axes', () => {
    const agent = queue();
    // NEGATIVE: nothing typed is not a note. The wire field is optional and the
    // card sends none, but an external client may.
    agent.recordPermissionAnswerNote('   ');
    expect(agent.consumePermissionAnswerNotes()).toBeUndefined();

    // BOUNDARY: only a turn drains this, and a session can answer many prompts
    // between two turns.
    for (let i = 0; i < 20; i += 1) agent.recordPermissionAnswerNote(`note-${i}`);
    const many = agent.consumePermissionAnswerNotes() ?? '';
    expect(many).toContain('note-7');
    expect(many).not.toContain('note-8');

    // BOUNDARY, the other axis: one enormous note cannot own the preamble.
    agent.recordPermissionAnswerNote('x'.repeat(5000));
    const long = agent.consumePermissionAnswerNotes() ?? '';
    expect(long).toContain('...[truncated]');
    expect(long.length).toBeLessThan(2000);
  });
});

describe('every runtime drains it, and the host fills it (P6.864)', () => {
  // One per runtime, which is what makes this a host mechanism rather than a
  // claude feature: a backend that composes a user tail and does not drain the
  // queue would accept the note and never show it to anyone.
  it('claude drains it in BOTH of its composition sites', () => {
    const claude = stripped('../claude-agent.ts');
    // Two sites, and exactly one of them composes any given message — they both
    // consume the once-per-turn mode signal through `buildContextParts`.
    expect(claude.split('consumePermissionAnswerNotes()').length - 1).toBe(2);
  });

  it('pi drains it beside the hook feedback on the same tail', () => {
    const pi = stripped('../pi-agent.ts');
    expect(pi).toContain('this.consumePermissionAnswerNotes(),');
  });

  it('codex drains it above every hook-authored band', () => {
    const codex = stripped('../codex-agent.ts');
    expect(codex).toContain('const permissionAnswerNotes = this.consumePermissionAnswerNotes();');
    expect(codex).toContain('permissionAnswerNotes,');
  });

  it('the host records it ABOVE the branch that returns early for Pi', () => {
    const manager = stripped('../../../../server-core/src/sessions/SessionManager.ts');
    const record = 'recordPermissionAnswerNote?.(options.comment)';
    expect(manager).toContain(record);
    // The ordering IS the test: a Pi tool prompt settles through
    // `directPermissionResolvers` and returns before `managed.agent` is read, so
    // a record placed with the agent dispatch would reach claude and codex and
    // silently skip Pi.
    expect(manager.indexOf(record))
      .toBeLessThan(manager.indexOf('const directResolver = this.directPermissionResolvers.get(requestId)'));
    // NEGATIVE: only an approval. A denial's note is already native on all
    // three, and recording it here as well would say it twice.
    expect(manager).toContain('if (allowed && options?.comment) {');
  });
});
