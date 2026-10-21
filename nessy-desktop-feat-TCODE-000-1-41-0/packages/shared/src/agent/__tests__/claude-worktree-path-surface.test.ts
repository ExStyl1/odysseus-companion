/**
 * P2.453 — the pin under an overturned refusal.
 *
 * P6.20 refused to wire the shipped binary's own `-w, --worktree [name]` through
 * the SDK's `extraArgs`, on a stated premise: *a worktree the binary creates for
 * itself has a path the host never learns.* This row asked the one question that
 * decides it — does the SDK surface that path? — and the answer is that it does
 * more than surface it: `WorktreeCreate` lets the host CREATE the worktree and
 * hand the path back, and `WorktreeRemove` returns it on teardown.
 *
 * `hooks.md#worktreecreate`: *"Configuring a WorktreeCreate hook replaces that
 * default git behavior"*, and *"The hook must return the path to the created
 * worktree directory. Claude Code uses this path as the working directory for
 * the isolated session."* `hooks.md#worktreeremove`: *"Claude Code passes the
 * path returned by WorktreeCreate as `worktree_path` in the hook input."*
 *
 * ## Why a test and not only the comment at the `extraArgs` site
 *
 * A verdict written as prose beside code it does not touch has one failure mode,
 * and this repo has measured it repeatedly: the bundle moves and the prose stays
 * true-looking. So the verdict is pinned against the INSTALLED type surface
 * rather than restated. If a future SDK drops the event or renames the field,
 * this file goes red and the decision is reopened deliberately — instead of the
 * next lane reading a confident comment about a mechanism that no longer exists.
 *
 * Read from `sdk.d.ts` for the same reason `claude-live-settings.test.ts` reads
 * it: the runtime is a minified bundle plus a closed native binary, so the
 * declaration file is the only machine-checkable surface. Native-binary counts
 * measured beside it, one rig, one run: `WorktreeCreate` 44, `worktreePath` 73,
 * `WorktreeRemove` 27, `worktree_path` 5, `PreToolUse` 87 (positive control), a
 * nonsense string 0.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * The same resolution `claude-live-settings.test.ts` uses, and for the same
 * reason: the package's `exports` map does not publish `./sdk.d.ts`, so asking
 * for it by subpath resolves to nothing. Resolving the entry and swapping the
 * extension is what actually finds the installed file — and a first attempt at
 * this file did NOT do that, which turned every row below into a silent skip.
 * A skipped assertion is not a passing one.
 */
function sdkTypings(): string {
  const require_ = createRequire(import.meta.url);
  const entry = require_.resolve('@anthropic-ai/claude-agent-sdk');
  const path = entry.replace(/sdk\.mjs$/, 'sdk.d.ts');
  if (!existsSync(path)) throw new Error(`sdk.d.ts not found beside ${entry}`);
  return readFileSync(path, 'utf8');
}

/**
 * The declaration body between `<anchor>` and its closing brace. Regexes over
 * the whole file are the wrong instrument here and the first draft proved it:
 * the file ships CRLF and every field ends in `;`, so a `[^;]*` window stops at
 * the first field and reports a real declaration as missing.
 */
function typeBody(source: string, name: string): string {
  // `declare type` and not the bare name: every one of these also appears in the
  // file's own re-export list ~6800 lines earlier, and anchoring on the bare
  // name sliced THAT instead — a window that contained the right identifier and
  // none of its fields.
  const anchor = `declare type ${name} =`;
  const start = source.indexOf(anchor);
  if (start === -1) throw new Error(`sdk.d.ts declares no ${name}`);
  const end = source.indexOf('};', start);
  if (end === -1) throw new Error(`${anchor} has no closing brace`);
  return source.slice(start, end);
}

describe('P2.453 · the SDK still surfaces the created worktree\'s path', () => {
  const dts = sdkTypings();

  /**
   * POSITIVE CONTROL, first. A read that found none of the strings below would
   * be an instrument failure — a moved file, a renamed export — rather than a
   * finding, and this row's whole verdict rests on presence being real.
   */
  test('the declaration file is the one we think it is', () => {
    expect(dts.length).toBeGreaterThan(10_000);
    expect(dts).toContain("'PreToolUse'");
    expect(dts).not.toContain('ZZThisEventDoesNotExistZZ');
  });

  /**
   * KILLS: an SDK bump that drops either event. Both are load-bearing — create
   * is where the host would choose the path, remove is where it learns a
   * teardown it must sweep after.
   *
   * Read out of the `HOOK_EVENTS` tuple rather than searched for in the whole
   * file, and the first draft is why: a bare `toContain("'WorktreeCreate'")`
   * SURVIVED a mutant that removed both names from the tuple, because the same
   * literal still appears in `WorktreeCreateHookInput`'s `hook_event_name`. It
   * was reporting the type's existence and calling it registration.
   */
  test.each(['WorktreeCreate', 'WorktreeRemove'])('%s is still in HOOK_EVENTS', (event) => {
    const start = dts.indexOf('HOOK_EVENTS: readonly [');
    expect(start).toBeGreaterThan(-1);
    const tuple = dts.slice(start, dts.indexOf('];', start));
    expect(tuple).toContain(`'PreToolUse'`);
    expect(tuple).toContain(`'${event}'`);
  });

  /**
   * KILLS: the field rename that would silently turn the native route back into
   * P6.20's leak. `worktreePath` on the OUTPUT is the host telling Claude Code
   * where it put the worktree; `worktree_path` on the REMOVE input is Claude
   * Code telling the host which one is going away.
   */
  test('the path travels in both directions, under the names the page documents', () => {
    expect(typeBody(dts, 'WorktreeCreateHookSpecificOutput')).toContain('worktreePath: string');
    expect(typeBody(dts, 'WorktreeRemoveHookInput')).toContain('worktree_path: string');
  });

  /**
   * KILLS: reading the refuted premise as still-true. The row P6.20 wrote said
   * the host could never learn the path; the reason it can is that the hook
   * REPLACES creation rather than observing it, which is what the `name` input
   * field encodes — Claude Code asks for a worktree by slug and takes back a
   * path.
   */
  test('WorktreeCreate is an override, not an observer', () => {
    const body = typeBody(dts, 'WorktreeCreateHookInput');
    expect(body).toContain("hook_event_name: 'WorktreeCreate'");
    expect(body).toContain('name: string');
  });

  /**
   * KILLS: someone wiring the flag to close a decision row. P2.453 says decide,
   * and the decision is recorded at the `extraArgs` site in `claude-agent.ts`;
   * the day a lane actually wires it, this assertion is the prompt to move the
   * verdict rather than leave two contradictory records.
   */
  test('the verdict is recorded where the next reader will look', () => {
    const agent = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    // Co-located with the search term, not merely present in a 9000-line file:
    // the row says the answer belongs at the `extraArgs` site because that is
    // what a reader asking "why isn't `--worktree` wired" will grep for. A
    // first draft asserted bare presence and SURVIVED a mutant that gutted the
    // heading — it was testing that the string existed somewhere, which the
    // rest of the block guaranteed on its own.
    const at = agent.indexOf('`extraArgs`');
    expect(at).toBeGreaterThan(-1);
    // D1.111 — an END ANCHOR, not `bracedRegion`, and the reason is what the
    // region IS: a comment block. The first `{` at or after this anchor belongs
    // to whatever code follows the comment, so a brace scan would bound a
    // neighbour's body and call it this record. The end is the first CODE line
    // below the block, and it is asserted FOUND — an `indexOf` miss answers -1,
    // and `slice(at, -1)` is the whole rest of a 9 000-line file, which is
    // exactly the runaway a bound exists to prevent. The old bound was a
    // 6 000-character window, the largest in the tree.
    const end = agent.indexOf('settingSources:', at);
    expect(end).toBeGreaterThan(at);
    const window = agent.slice(at, end);
    expect(window).toContain('P2.453');
    expect(window).toContain('WorktreeCreate');
    expect(window).toContain('worktreePath');
    // The load-bearing half. A record that no longer says the premise was
    // refuted is a record the next lane will read as the original refusal.
    expect(window).toContain('THAT PREMISE IS REFUTED');
    // The boundary control, naming the NEXT decision record below this one: a
    // bound that ran away would swallow it. Spelled long enough that a
    // `P6.34x` row cannot satisfy it by prefix.
    expect(window).not.toContain('P6.34 — the configured additional roots');
  });
});
