/**
 * P2.495 — our mirror of the SDK's hook result, checked against the SDK's own
 * declaration instead of against a reader's memory of it.
 *
 * {@link SdkAutomationCallbackResult} in `types.ts` is a hand-written mirror of
 * `SyncHookJSONOutput` from the vendored `@anthropic-ai/claude-agent-sdk`. A
 * mirror is only worth having while it agrees with the thing it mirrors, and
 * this one had already fallen behind: `sdk.d.ts` unions
 * `WorktreeCreateHookSpecificOutput` into `SyncHookJSONOutput`'s
 * `hookSpecificOutput`, our copy carried PreToolUse's members and nothing else,
 * and the one caller that had to return a worktree path
 * (`agent/backend/claude/worktree-hooks.ts`) reached the wire through a cast.
 *
 * Two instruments, because the defect has two halves and neither instrument
 * sees the other's:
 *
 *  1. **The mirror ACCEPTS the shape** — `worktreeCreateResult` below is typed,
 *     so removing the field from `types.ts` makes `bun run typecheck` red. That
 *     is the half a runtime assertion cannot reach: `bun test` does not
 *     typecheck, so a type-only regression is invisible to it.
 *  2. **The mirror still MATCHES the SDK** — the row that reads
 *     `WorktreeCreateHookSpecificOutput`'s field names out of the installed
 *     `sdk.d.ts` and requires each one to be declared inside our
 *     `hookSpecificOutput` object. That is the half a typed literal cannot
 *     reach: a literal proves our type accepts what we wrote, never that what we
 *     wrote is what the SDK declares.
 *
 * Deliberately NOT a check that the two are equal in both directions. The
 * mirror flattens a discriminated union into one optional bag, so it carries
 * members from several events at once and each is optional where the SDK's own
 * member is required — see the field's docblock in `types.ts`. Requiring
 * equality would fail on that design rather than on a drift.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { SdkAutomationCallbackResult } from './types.ts';

/**
 * The same resolution `claude-worktree-path-surface.test.ts` uses, and for the
 * same recorded reason: the package's `exports` map does not publish the
 * declaration file, so asking for it by subpath resolves to nothing, and a
 * first attempt at that file turned every row into a silent skip.
 */
function sdkTypings(): string {
  const require_ = createRequire(import.meta.url);
  const entry = require_.resolve('@anthropic-ai/claude-agent-sdk');
  const path = entry.replace(/sdk\.mjs$/, 'sdk.d.ts');
  if (!existsSync(path)) throw new Error(`sdk.d.ts not found beside ${entry}`);
  return readFileSync(path, 'utf8');
}

/**
 * The declaration body between `declare type <name> =` and its closing brace.
 *
 * `declare type` and not the bare name, because every one of these also appears
 * in the file's own re-export list thousands of lines earlier and the bare name
 * slices THAT — a window holding the right identifier and none of its fields.
 */
function sdkTypeBody(source: string, name: string): string {
  const anchor = `declare type ${name} =`;
  const start = source.indexOf(anchor);
  if (start === -1) throw new Error(`sdk.d.ts declares no ${name}`);
  const end = source.indexOf('};', start);
  if (end === -1) throw new Error(`${anchor} has no closing brace`);
  return source.slice(start, end);
}

/** Field names declared directly in a type body, ignoring its doc comments. */
function fieldNames(body: string): string[] {
  return [...body.matchAll(/^\s{4}(\w+)\??:/gm)].map(match => match[1] as string);
}

/** Our own mirror, read as source: the object literal is not a named type. */
function mirrorHookSpecificOutputBody(): string {
  const source = readFileSync(fileURLToPath(new URL('./types.ts', import.meta.url)), 'utf8');
  const owner = source.indexOf('export interface SdkAutomationCallbackResult {');
  if (owner === -1) throw new Error('types.ts declares no SdkAutomationCallbackResult');
  const start = source.indexOf('hookSpecificOutput?: {', owner);
  if (start === -1) throw new Error('SdkAutomationCallbackResult declares no hookSpecificOutput');
  const end = source.indexOf('\n  };', start);
  if (end === -1) throw new Error('hookSpecificOutput has no closing brace');
  return source.slice(start, end);
}

/**
 * Instrument 1 — the TYPED assertion the row asked for.
 *
 * This value is what `withClaudeWorktreeHooks` returns for a leased worktree,
 * spelled against the mirror rather than against `unknown`. Before P2.495 the
 * mirror had no `worktreePath`, so the only honest reading of that callback's
 * result was its serialized bytes; with the field declared, the shape is
 * expressible and a reader of a hook result can reach the path by name.
 */
const worktreeCreateResult: SdkAutomationCallbackResult = {
  continue: true,
  hookSpecificOutput: {
    hookEventName: 'WorktreeCreate',
    worktreePath: '/repo/.nessy-worktrees/app/bold-oak-a3f2',
  },
};

describe('P2.495 · the SDK hook-result mirror carries WorktreeCreate\'s member', () => {
  test('a WorktreeCreate result is expressible against the mirror, and readable by name', () => {
    // The property access is the point: it does not compile while the mirror is
    // missing the field, and it is what a typed assertion elsewhere can now do
    // instead of round-tripping through JSON.
    expect(worktreeCreateResult.hookSpecificOutput?.worktreePath)
      .toBe('/repo/.nessy-worktrees/app/bold-oak-a3f2');
    expect(worktreeCreateResult.hookSpecificOutput?.hookEventName).toBe('WorktreeCreate');
  });

  test('every field the SDK declares on WorktreeCreateHookSpecificOutput is in the mirror', () => {
    const declared = fieldNames(sdkTypeBody(sdkTypings(), 'WorktreeCreateHookSpecificOutput'));
    // A dead extractor would report an empty set and pass the loop below
    // vacuously, so what it found is asserted before it is used.
    expect(declared).toEqual(['hookEventName', 'worktreePath']);

    const mirror = mirrorHookSpecificOutputBody();
    const missing = declared.filter(field => !new RegExp(`^\\s{4}${field}\\??:`, 'm').test(mirror));
    expect(missing).toEqual([]);

    // The DECLARED TYPE, not only the name. The SDK says `worktreePath: string`,
    // and a mirror that widened it to `unknown` would still accept the literal
    // above (everything is assignable to `unknown`) and still pass the name
    // check — so the one near-miss spelling that survives both other
    // instruments is pinned here.
    expect(/^\s{4}worktreePath\?: string;$/m.test(mirror)).toBe(true);
  });

  test('the extractor reads the mirror, not an empty string', () => {
    // The positive control for the row above: the same matcher against a member
    // the mirror has carried since P3.163, so an empty slice cannot pass as a
    // clean result.
    const mirror = mirrorHookSpecificOutputBody();
    expect(/^\s{4}permissionDecision\??:/m.test(mirror)).toBe(true);
    expect(/^\s{4}nonsenseFieldNoMirrorHas\??:/m.test(mirror)).toBe(false);
  });
});

/**
 * P7.14 — the classifier note the SDK lift to `0.3.247` brought, checked the
 * same two ways.
 *
 * Not folded into the WorktreeCreate row above: that one requires EVERY field
 * of its type, and `PostToolUseHookSpecificOutput` also declares
 * `updatedMCPToolOutput`, which this fork refuses on record (`hook-command.ts`:
 * "`updatedToolOutput` already covers MCP tools, and honouring both would give
 * one hook two ways to rewrite the same result"). A whole-type requirement here
 * would therefore fail on a deliberate refusal rather than on a drift.
 */
describe('P7.14 · the mirror carries PostToolUse\'s classifier note', () => {
  test('the SDK declares it, and so does the mirror', () => {
    const declared = fieldNames(sdkTypeBody(sdkTypings(), 'PostToolUseHookSpecificOutput'));
    // Asserted before it is used, for the same reason the row above does it: a
    // dead extractor reports an empty set and every membership check below then
    // passes vacuously.
    expect(declared).toContain('updatedToolOutput');
    expect(declared).toContain('classifierContext');

    const mirror = mirrorHookSpecificOutputBody();
    expect(/^\s{4}classifierContext\??: string;$/m.test(mirror)).toBe(true);
  });

  test('a PostToolUse note is expressible against the mirror, and readable by name', () => {
    const annotated: SdkAutomationCallbackResult = {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        classifierContext: 'This query ran against the staging database, not production.',
      },
    };
    expect(annotated.hookSpecificOutput?.classifierContext)
      .toBe('This query ran against the staging database, not production.');
  });
});
