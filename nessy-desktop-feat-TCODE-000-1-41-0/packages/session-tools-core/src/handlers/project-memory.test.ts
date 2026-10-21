/**
 * UB1.12 — `handleProjectMemoryAppend`. Copied from craft-agents-oss
 * `v0.15.1:packages/session-tools-core/src/handlers/project-memory.test.ts` (Apache-2.0),
 * with the schema arm added: upstream's 4,000-character cap lives on
 * `ProjectMemoryAppendSchema` (`z.string().max(4000)`) — the row's negative control —
 * so it is pinned by parsing the schema, not by the handler.
 */
import { describe, it, expect } from 'bun:test';
import { handleProjectMemoryAppend, ProjectMemoryAppendSchema } from './project-memory.ts';
import type { SessionToolContext, ProjectMemoryAppendInput } from '../context.ts';

function createCtx(append?: (input: ProjectMemoryAppendInput) => Promise<{ path: string; heading: string; bytesAppended: number }>): {
  ctx: SessionToolContext;
  calls: ProjectMemoryAppendInput[];
} {
  const calls: ProjectMemoryAppendInput[] = [];
  const ctx = {
    appendProjectMemory: async (input: ProjectMemoryAppendInput) => {
      calls.push(input);
      return append
        ? append(input)
        : { path: '/ws/projects/liza/MEMORY.md', heading: '2026-10-11T22:00:00.000Z — Explore', bytesAppended: 64 };
    },
  } as unknown as SessionToolContext;
  return { ctx, calls };
}

describe('handleProjectMemoryAppend', () => {
  it('appends the note and names the file and heading', async () => {
    const { ctx, calls } = createCtx();
    const result = await handleProjectMemoryAppend(ctx, { note: 'The consent page needs a JS click.' });

    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([{ note: 'The consent page needs a JS click.' }]);
    expect(result.content[0]!.text).toBe('Added to /ws/projects/liza/MEMORY.md under "## 2026-10-11T22:00:00.000Z — Explore".');
  });

  it('rejects an empty note without writing', async () => {
    const { ctx, calls } = createCtx();
    const result = await handleProjectMemoryAppend(ctx, { note: '  \n' });

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('reports sessions without a project', async () => {
    const { ctx } = createCtx(async () => { throw new Error('This session is not bound to a project.'); });
    const result = await handleProjectMemoryAppend(ctx, { note: 'x' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Failed to add the note: This session is not bound to a project.');
  });

  it('errors when the host does not provide the callback', async () => {
    const result = await handleProjectMemoryAppend({} as SessionToolContext, { note: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('not available');
  });

  // UB1.12 — the row's negative control, on the schema the session servers parse
  // before the handler runs: 4,000 characters is the cap, one more is refused.
  it('refuses a note over 4,000 characters at the schema', () => {
    expect(ProjectMemoryAppendSchema.safeParse({ note: 'a'.repeat(4000) }).success).toBe(true);
    expect(ProjectMemoryAppendSchema.safeParse({ note: 'a'.repeat(4001) }).success).toBe(false);
  });
});
