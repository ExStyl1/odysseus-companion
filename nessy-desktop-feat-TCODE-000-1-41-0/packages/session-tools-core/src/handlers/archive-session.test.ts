/**
 * P6.466 — `archive_session` is an agent verb whose approval must survive
 * Bypass, and the handler's whole job is to report the host's verdict without
 * re-deciding it.
 *
 * The floor itself is asserted where it lives, in
 * `server-core/.../__tests__/archive-session-verb.test.ts`: the card is raised
 * by the host closure, because for a session MCP tool neither
 * `INTERACTION_ONLY_TOOLS` nor `findNonNegotiableFloors` is on codex's answer
 * path. What is asserted HERE is the other half of `done_means` (c) — that a
 * denial reaches the model as a refusal rather than as a completed archive.
 */
import { describe, expect, test } from 'bun:test';

import { handleArchiveSession } from './archive-session.ts';
import { ArchiveSessionSchema, TOOL_DESCRIPTIONS } from '../tool-defs.ts';
import type { ArchiveSessionVerdict, SessionToolContext } from '../context.ts';

function contextWith(verdict: ArchiveSessionVerdict) {
  const calls: Array<[string | undefined, boolean]> = [];
  const ctx = {
    sessionId: 'caller',
    archiveSession: async (sessionId: string | undefined, archived: boolean) => {
      calls.push([sessionId, archived]);
      return verdict;
    },
  } as unknown as SessionToolContext;
  return { ctx, calls };
}

describe('the wire schema', () => {
  test('an id-less call validates and means "archive me"', () => {
    expect(ArchiveSessionSchema.safeParse({}).success).toBe(true);
  });

  test('archived is a boolean when present, not a string', () => {
    expect(ArchiveSessionSchema.safeParse({ archived: 'false' }).success).toBe(false);
    expect(ArchiveSessionSchema.safeParse({ sessionId: 'other', archived: false }).success).toBe(true);
  });

  test('the description promises the card and says it cannot be remembered', () => {
    // `done_means` (b) is a promise the model must be able to read: an archive
    // that silently prompts is fine, one the model believes is silent is not.
    const description = TOOL_DESCRIPTIONS.archive_session;
    expect(description).toContain('every permission mode');
    expect(description).toContain('cannot be remembered');
    expect(description).toContain('the target is left exactly as it was');
  });
});

describe('the handler reports the host verdict', () => {
  test('a missing port is an honest refusal, not a silent success', async () => {
    const result = await handleArchiveSession({} as SessionToolContext, {});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('not available in this context');
  });

  test('archived defaults to true and the id defaults to the caller', async () => {
    const { ctx, calls } = contextWith({ status: 'applied' });
    await handleArchiveSession(ctx, {});
    expect(calls).toEqual([[undefined, true]]);
  });

  test('archived: false is the unarchive direction and is passed through', async () => {
    const { ctx, calls } = contextWith({ status: 'applied' });
    await handleArchiveSession(ctx, { sessionId: 'other', archived: false });
    expect(calls).toEqual([['other', false]]);
  });

  test('a denial is an ERROR — the model must not read it as an archive', async () => {
    const { ctx } = contextWith({ status: 'denied', note: 'Archive of session other was declined.' });
    const result = await handleArchiveSession(ctx, { sessionId: 'other' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('declined');
  });

  test('an unchanged flag is a SUCCESS — a no-op is not a failure to retry', async () => {
    // The boundary case that separates this from the denial above: both leave
    // the target untouched, and only one of them is a refusal.
    const { ctx } = contextWith({ status: 'unchanged' });
    const result = await handleArchiveSession(ctx, { sessionId: 'other' });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain('already archived');
  });

  test('a target outside the caller’s workspace is refused by name', async () => {
    const { ctx } = contextWith({ status: 'not-found' });
    const result = await handleArchiveSession(ctx, { sessionId: 'elsewhere' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('not found');
  });

  test('a throwing port is reported, not swallowed', async () => {
    const ctx = {
      archiveSession: async () => { throw new Error('bridge unreachable'); },
    } as unknown as SessionToolContext;
    const result = await handleArchiveSession(ctx, {});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('bridge unreachable');
  });
});
