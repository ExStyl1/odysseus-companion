/**
 * P2.510 — what the MODEL is told when it picks a source slug it may not use.
 *
 * `f2a4598f6` measured that every entry of `enabledSourceSlugs` becomes a path
 * segment in `getSourcePath`, and that a slug of `..` followed by `..` loaded a
 * `permissions.json` from outside the workspace and merged its allows in.
 * That escape is CONTAINED at the permissions merge, and it had to be: the
 * stored-session replay and the workspace default reach the same field without
 * passing through any tool schema. So this suite pins defence in depth, and not
 * the closure.
 *
 * What it does pin is the most visible possible answer. The SDK validates tool
 * input against this schema and hands the zod issues back to the model as an
 * error result, so a bad entry is named to the caller that chose it.
 */
import { describe, it, expect } from 'bun:test';
import { z } from 'zod';
import { SPAWN_SESSION_TOOL_INPUT_SCHEMA } from '../spawn-session-tool.ts';

/**
 * Parsed through the SHAPE, which is the load-bearing part of this file.
 *
 * `createSpawnSessionTool` hands the SDK `SPAWN_SESSION_TOOL_INPUT_SCHEMA.shape`
 * and the SDK rebuilds a `z.object` from it before validating. A refinement
 * placed on the OBJECT would satisfy a test written against the schema and be
 * discarded on the path that actually runs, so every assertion below goes
 * through the same reconstruction the SDK performs.
 */
const asTheSdkRebuildsIt = z.object(SPAWN_SESSION_TOOL_INPUT_SCHEMA.shape);

function parse(enabledSourceSlugs?: string[]) {
  return asTheSdkRebuildsIt.safeParse(
    enabledSourceSlugs === undefined ? { prompt: 'go' } : { prompt: 'go', enabledSourceSlugs },
  );
}

function issuesFor(enabledSourceSlugs: string[]) {
  const result = parse(enabledSourceSlugs);
  expect(result.success).toBe(false);
  return result.error!.issues.map(issue => ({ path: issue.path, message: issue.message }));
}

describe('P2.510: spawn_session reports an unusable source slug to the model', () => {
  it('accepts the lists a caller is meant to send', () => {
    // The positive control. Without it every assertion below passes just as
    // well against a schema that refuses the field outright.
    expect(parse(['github', 'gmail']).success).toBe(true);
    expect(parse([]).success).toBe(true);
    expect(parse(undefined).success).toBe(true);
  });

  it('accepts every slug that can name a real source directory', () => {
    // Containment, not spelling — `loadWorkspaceSources` enumerates DIRECTORY
    // NAMES, so an externally authored folder carries its own name through and
    // a spelling rule here would disable a working source. `..hidden` is not
    // the `..` dot segment and has to survive.
    expect(parse(['Mixed Case Source', 'dots.in.name', 'under_score', '..hidden']).success).toBe(true);
  });

  it('names the offending entry by index for each way a slug can be unusable', () => {
    expect(issuesFor([''])).toEqual([
      { path: ['enabledSourceSlugs', 0], message: expect.stringContaining('(blank)') },
    ]);
    expect(issuesFor(['   '])).toEqual([
      { path: ['enabledSourceSlugs', 0], message: expect.stringContaining('(blank)') },
    ]);
    expect(issuesFor(['nested/deep'])).toEqual([
      { path: ['enabledSourceSlugs', 0], message: expect.stringContaining('(not-contained)') },
    ]);
    expect(issuesFor(['nested\\deep'])).toEqual([
      { path: ['enabledSourceSlugs', 0], message: expect.stringContaining('(not-contained)') },
    ]);
    expect(issuesFor(['..'])).toEqual([
      { path: ['enabledSourceSlugs', 0], message: expect.stringContaining('(not-contained)') },
    ]);
    // Written as an escape, never as a byte: a literal NUL in a source file is
    // invisible to plain grep (AGENTS.md), and this suite has to stay greppable.
    expect(issuesFor(['bad\u0000name'])).toEqual([
      { path: ['enabledSourceSlugs', 0], message: expect.stringContaining('(control-character)') },
    ]);
    expect(issuesFor(['real', 'real'])).toEqual([
      { path: ['enabledSourceSlugs', 1], message: expect.stringContaining('(duplicate)') },
    ]);
  });

  it('blames only the entry that is wrong, at the index the caller declared', () => {
    // The escape `f2a4598f6` measured, travelling beside two usable entries.
    // The index has to be the DECLARED one: `partitionSourceSlugs` reports an
    // index into the array it was handed, and a reader holds that same array.
    expect(issuesFor(['github', '../..', 'gmail'])).toEqual([
      { path: ['enabledSourceSlugs', 1], message: expect.stringContaining('(not-contained)') },
    ]);
  });

  it('never echoes the slug text back out', () => {
    // `RejectedSourceSlug`'s rule, and the same split `permissionDslDiagnostics`
    // makes: a refused slug is externally authored and may itself be a path, so
    // the index and the closed reason travel and the value does not.
    const secret = '../../../etc/nessy-p2510-secret';
    const [issue] = issuesFor(['github', secret]);
    expect(issue!.message).not.toContain(secret);
    expect(issue!.message).not.toContain('etc');
    expect(issue!.path).toEqual(['enabledSourceSlugs', 1]);
  });

  it('leaves the tool schema the model reads unchanged', () => {
    // The refinement has to buy validation without altering the advertised
    // shape: a caller reading the JSON Schema still sees a plain array of
    // strings, so nothing about the tool the model sees moved.
    const field = SPAWN_SESSION_TOOL_INPUT_SCHEMA.shape.enabledSourceSlugs;
    const unrefined = z.array(z.string()).optional().describe('Source slugs to enable in the new session');
    expect(z.toJSONSchema(field, { io: 'input' })).toEqual(z.toJSONSchema(unrefined, { io: 'input' }));
  });
});
