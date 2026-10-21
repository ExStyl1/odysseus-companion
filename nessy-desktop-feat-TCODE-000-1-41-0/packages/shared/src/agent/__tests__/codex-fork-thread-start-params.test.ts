/**
 * P3.61 — which `ThreadStartParams` fields survive a `thread/fork`, and the
 * invariant that keeps our two legs from drifting apart.
 *
 * ## The row's premise was REFUTED, and the refutation is the useful half
 *
 * The row says *"we re-pass `config` and `model` and nothing else, so any field
 * that does NOT inherit is silently lost on every fork."* Read off the code, we
 * pass FOUR params plus `threadId` — `cwd`, `model`, `config`,
 * `developerInstructions` — and the fork params are a strict superset of what
 * either `thread/start` leg sends. **Zero fields are silently lost today.**
 *
 * ## What the source says, at `github.com/openai/codex` tag `rust-v0.148.0`
 *
 * Read rather than assumed, and this is the part that makes the invariant below
 * worth enforcing. `ThreadForkParams` is a DIFFERENT struct from
 * `ThreadStartParams` (`codex-rs/app-server-protocol/src/protocol/v2/thread.rs`,
 * the two declared ~450 lines apart), and the fork handler rebuilds the thread's
 * `Config` FROM SCRATCH rather than cloning the parent's —
 * `codex-rs/app-server/src/request_processors/thread_processor.rs`,
 * `thread_fork_inner`: `let config = self.config_manager.load_for_cwd(
 * request_overrides, typesafe_overrides, history_cwd).await`, the same call
 * shape `thread/start` uses. So a field that is not re-passed falls back to the
 * on-disk `config.toml`, NOT to the parent thread.
 *
 * There are exactly three inheritance channels on that path:
 *
 * 1. `history_cwd` — `let history_cwd = Some(source_thread.cwd.clone());`
 * 2. `merge_persisted_approvals_reviewer`, which recovers `approvalsReviewer`
 *    out of the replayed rollout's `RolloutItem::TurnContext`;
 * 3. the replayed rollout itself, which carries `baseInstructions`,
 *    `developerInstructions`, `historyMode` and `dynamicTools`.
 *
 * Everything else — `model`, `modelProvider`, `serviceTier`, `sandbox`,
 * `permissions`, `config`, `approvalPolicy`, `personality` (the fork hard-codes
 * `/*personality*\/ None`), `ephemeral`, `threadSource`, `environments`,
 * `runtimeWorkspaceRoots`, `experimentalRawEvents` (hard-coded `false`) — is
 * NOT inherited. Note `approvalPolicy` in particular: `thread/resume` recovers
 * it with `latest_persisted_approval_policy` and the FORK path never calls that
 * helper, so the two walks differ on exactly the field a reader would assume
 * behaves the same.
 *
 * `developerInstructions` behaves as `codex-agent.ts` already records:
 * inherited (it was materialized into the parent's rollout as a developer
 * message) and NOT duplicated when re-passed (full initial context is injected
 * only when `reference_context_item.is_none()`, and a forked history always
 * restores that baseline first). Confirmed from source, not merely re-measured.
 *
 * ## Why the assertion is a SUBSET rule rather than a transcription
 *
 * The classification above is a reading of a vendor source at one tag; pinning
 * it as data here would be a second copy of someone else's file. What this file
 * pins instead is the property that makes the classification not matter: **every
 * `ThreadStartParams` field either `thread/start` leg sends must also be sent on
 * the `thread/fork` leg.** Under that rule a non-inheriting field cannot be lost
 * no matter which way the vendor classifies it, and adding a param to a
 * `thread/start` call without adding it to the fork fails here — which is the
 * only defect this row can actually still produce.
 *
 * Source-matched rather than driven, for `runtime-switch-costs`' reason: the
 * three call sites live inside a 6000-line class that needs an app-server, a
 * codex home and a live client to construct, and the proposition is about which
 * KEYS the request carries.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const AGENT_SOURCE = readFileSync(
  fileURLToPath(new URL('../codex-agent.ts', import.meta.url)),
  'utf8',
);

/**
 * The top-level keys of ONE object literal, reading from `openAt` — the index
 * of the character just after its `{`.
 *
 * Brace-matched rather than line-indented: an indentation rule would silently
 * return a short list the day the call is re-wrapped, which is the failure mode
 * a source-match test exists to avoid. Nesting depth is tracked so a key inside
 * a nested object or a conditional spread cannot be read as a param.
 *
 * Bare `...name` spreads come back beside the keys, because P6.102 gave the
 * branch fork and the session-init start ONE shared params object: a reader
 * that could not follow the spread would report both legs as zero-param and
 * make every subset rule below vacuous.
 */
function literalKeys(source: string, openAt: number): { keys: string[]; spreads: string[]; end: number } {
  let depth = 1;
  let i = openAt;
  // Everything nested deeper than the literal itself is blanked to spaces,
  // newlines kept, so the line regexes below see ONLY top-level properties. A
  // `{@link …}` inside a param comment nests and disappears the same way, and
  // so does a CONDITIONAL spread — `...(cond ? { k } : {})` — exactly as before.
  const masked: string[] = [];
  for (; i < source.length && depth > 0; i += 1) {
    const ch = source[i]!;
    const opening = ch === '{' || ch === '[' || ch === '(';
    const closing = ch === '}' || ch === ']' || ch === ')';
    if (opening) depth += 1;
    else if (closing) depth -= 1;
    const top = depth === 1 && !opening && !closing;
    masked.push(ch === '\n' ? '\n' : top ? ch : ' ');
  }
  const lines = masked.join('').split('\n');
  // Both spellings: `key: value` and the ES6 shorthand `key,` — the shorthand
  // is what a colon-only parser silently drops, and `config` is passed that
  // way on the fork leg, so this test read the fork as three params. And every
  // key a line carries, not only its first (F1.752): a line that STARTS with a
  // key is cut at a whitespace-led `//` (prose, not params) and split on its
  // top-level commas. A comma inside a string value would still split it.
  const keys = lines.flatMap(line => {
    if (!/^\s*[A-Za-z_][A-Za-z0-9_]*\s*[:,]/.test(line)) return [];
    const segments = line.replace(/\s\/\/.*$/, '').split(',');
    return segments.flatMap((segment, index) => {
      const named = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(:|$)/.exec(segment);
      // A bare name is the shorthand only when a comma followed it.
      if (!named || (named[2] !== ':' && index === segments.length - 1)) return [];
      return [named[1]!];
    });
  });
  const spreads = lines
    .map(line => /^\s*\.\.\.([A-Za-z_][A-Za-z0-9_]*)\s*,?\s*$/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
  return { keys, spreads, end: i };
}

/** The keys of `const <name> = { … }`, spreads resolved, cycles refused. */
function namedObjectKeys(source: string, name: string, seen: Set<string>): string[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const needle = `const ${name} = {`;
  const at = source.indexOf(needle);
  if (at === -1) return [];
  const read = literalKeys(source, at + needle.length);
  return [...read.keys, ...read.spreads.flatMap(inner => namedObjectKeys(source, inner, seen))];
}

/**
 * The params of every `client.request('<method>', …)` in the source — whether
 * they are written inline or handed over as a named object.
 */
function requestParamKeys(source: string, method: string): string[][] {
  const results: string[][] = [];
  const anchor = `'${method}', `;
  let at = source.indexOf(anchor);
  while (at !== -1) {
    const after = at + anchor.length;
    let keys: string[] = [];
    let next = after + 1;
    if (source[after] === '{') {
      const read = literalKeys(source, after + 1);
      keys = [...read.keys, ...read.spreads.flatMap(name => namedObjectKeys(source, name, new Set()))];
      next = read.end;
    } else {
      const named = /^([A-Za-z_][A-Za-z0-9_]*)\s*\)/.exec(source.slice(after));
      if (named) {
        keys = namedObjectKeys(source, named[1]!, new Set());
        next = after + named[0].length;
      }
    }
    results.push(keys.sort());
    at = source.indexOf(anchor, next);
  }
  return results;
}

describe('P3.61 · the params our codex fork carries', () => {
  const forks = requestParamKeys(AGENT_SOURCE, 'thread/fork');
  const starts = requestParamKeys(AGENT_SOURCE, 'thread/start');

  // The parser's own positive control. A regex that silently matched nothing
  // would make every subset assertion below vacuously true.
  it('finds the call sites and reads real keys off them', () => {
    // Two of each since P6.102: the BRANCH pair (a child thread forked from the
    // parent at the branch point) and the config-drift pair.
    expect(forks).toHaveLength(2);
    expect(starts).toHaveLength(2);
    for (const keys of [...forks, ...starts]) {
      expect(keys.length, 'a call site parsed to zero params').toBeGreaterThan(0);
      expect(keys).toContain('model');
    }
  });

  it('re-passes more than the row claims — the premise, refuted at the code', () => {
    // The row: "we re-pass `config` and `model` and nothing else". F1.1237 added `excludeTurns`, a
    // fork-only response flag (no `ThreadStartParams` counterpart), on both fork legs.
    expect(forks).toContainEqual(['config', 'cwd', 'developerInstructions', 'excludeTurns', 'model', 'threadId']);
  });

  /**
   * THE INVARIANT. `threadId` is the fork's own addressing param and has no
   * `thread/start` counterpart, so it is subtracted before the comparison;
   * everything else the fork sends is a `ThreadStartParams` field.
   *
   * Read against ANY fork leg rather than one fixed fork. Until F1.723 `config`
   * rode the drift pair alone, and a one-fork rule was red for a correct tree;
   * since F1.723 the session-init start carries it too — the host security
   * layer rides every thread open — and the any-fork reading stays so that a
   * param one pair legitimately adds alone is not read as a loss.
   */
  it('sends every param either thread/start leg sends', () => {
    for (const [index, startKeys] of starts.entries()) {
      const covered = forks.some(forkKeys => startKeys.every(key => forkKeys.includes(key)));
      expect(covered, `thread/start #${index} sends params no thread/fork leg carries`).toBe(true);
    }
  });

  /**
   * `config` is the override the drift fork exists to apply (since F1.723 the
   * session-init start sends one too, the host security layer): the fork loads
   * a drifted config layer, and `load_for_cwd` gives it the on-disk file rather
   * than the parent's overrides. A fork that stopped sending it would apply the OLD
   * permission profile — a silent widening whenever the drift was a tightening.
   */
  it('carries the config override the fork exists to apply', () => {
    expect(forks.some(keys => keys.includes('config'))).toBe(true);
  });

  /**
   * `model` is NOT inherited on a fork — the forked session only WARNS about a
   * mismatch (`core/src/session/mod.rs`: "resuming session with different
   * model: previous={prev}, current={curr}") and the freshly loaded config
   * wins. So dropping it here would move the user's session onto whatever
   * `config.toml` names, silently.
   */
  it('carries the model, which a fork does not inherit', () => {
    for (const keys of forks) expect(keys).toContain('model');
  });

  /**
   * The typed `approvalPolicy` / `sandbox` / `permissions` params are the trap
   * this file is really guarding: none of the three is inherited on a fork
   * (`thread/resume` recovers the approval policy, the fork path does not), and
   * today we express all three through `config`, which IS re-passed. If a lane
   * ever moves one onto a typed param, the subset rule above turns that into a
   * red instead of a silent revert to the on-disk value.
   */
  /**
   * THE INSTRUMENT'S OWN DISCRIMINATING POWER, proven without mutating
   * `codex-agent.ts` — a file another lane holds, where a temporary edit could
   * be swept into a neighbour's pathspec commit. So the mutant is a synthetic
   * source instead: the same extractor, the same subset rule, over a fork that
   * drops `config`. A rule that cannot fail on that would pass on the real file
   * for the same reason.
   */
  it('the subset rule catches a fork that drops a param the start leg sends', () => {
    const mutant = [
      "await requestWithinDeadline(this.client!, 'thread/fork', {",
      '  threadId: this.threadId,',
      '  cwd: this.workingDirectory,',
      '  model: this._model,',
      '}, timeoutMs);',
      "await requestWithinDeadline(this.client!, 'thread/start', {",
      '  cwd: this.workingDirectory,',
      '  model: this._model,',
      '  config,',
      '}, 1);',
    ].join('\n');
    const mutantFork = new Set(requestParamKeys(mutant, 'thread/fork')[0]);
    const mutantStart = requestParamKeys(mutant, 'thread/start')[0]!;
    expect(mutantStart.filter(key => !mutantFork.has(key))).toEqual(['config']);
    // And the shorthand form really is read — the defect that made this test's
    // first run report the real fork as three params instead of four.
    expect(mutantStart).toContain('config');
  });

  /**
   * F1.752 — two params on ONE line are two params. F1.723 wrote the session-init start's
   * `config` beside `cwd` on a single line, and a reader that took only a line's FIRST key
   * saw that leg without it, which is how the "the session-init start does not carry
   * `config`" sentences above outlived the code by a day with every assertion green.
   */
  it('reads every param a line carries, and none from a trailing comment', () => {
    const source = [
      "await client.request('thread/start', {",
      '  cwd: this.workingDirectory, config: this.layer(), // F1.723 — see: the note, also: this',
      '  model: this._model,',
      '});',
    ].join('\n');
    const [keys] = requestParamKeys(source, 'thread/start');
    expect(keys).toEqual(['config', 'cwd', 'model']);
  });

  it('expresses the permission layer through config, not through typed params', () => {
    for (const keys of [...forks, ...starts]) {
      // Since F1.723 the host security layer rides EVERY open and refork as `config`.
      expect(keys).toContain('config');
      expect(keys).not.toContain('approvalPolicy');
      expect(keys).not.toContain('sandbox');
      expect(keys).not.toContain('permissions');
    }
  });
});
