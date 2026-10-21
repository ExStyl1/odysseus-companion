/**
 * P3.75 — a `Read` deny rule must also block `Edit` and `Write`.
 *
 * ## The sentence, quoted rather than summarised
 *
 * `permissions.md#read-and-edit`: "A `Read` deny rule also blocks the Edit and
 * Write tools on the same path, including creating a new file there.
 * NotebookEdit isn't covered, so add an `Edit` deny rule for paths no tool may
 * change. The check requires Claude Code v2.1.208 or later on edits, and
 * v2.1.228 or later on writes."
 *
 * The ledger's summary of that sentence dropped its second half. The carve-out
 * is the load-bearing part: the binding is Edit and Write, and `NotebookEdit`
 * is EXPLICITLY outside it.
 *
 * ## The row's premise is REFUTED at HEAD, and the refutation is why this file
 * exists rather than a fix
 *
 * The sweep that opened this (`claude-sweep-triage.md` F64.2) measured it by
 * IDENTIFIER: the vendored binary carries "is covered by a Read deny rule"
 * twice, the repo carries `readDeny|read deny|denyRead` zero times in the two
 * decision files, with `'deny rule'` as the positive control. That is a real
 * measurement of a real absence — of the STRING. The behaviour is present
 * anyway, and by a shape no identifier probe could find: `parseClaudeRuleString`
 * compiles `Read(p)` and `Edit(p)` to the SAME tool-agnostic `pathGlob` matcher,
 * and `evaluatePermissionDslV1` tests it against every path parameter the
 * request carries. There is no cross-tool lookup because there is nothing to
 * look up.
 *
 * Measured through the shared evaluator (2026-08-28): with one
 * `deny Read(secrets/**)` rule, `Read`, `Edit`, `Write`, `MultiEdit`, `Grep` and
 * `Glob` on `/workspace/secrets/a.txt` all return `deny`.
 *
 * ## Which makes the safety ACCIDENTAL, and that is what is being fixed here
 *
 * Nothing in the code said this sentence was being honoured, so the obvious
 * tightening — binding each rule to the tool family it names, which the same
 * page's `Edit(path)`/`Read(path)` sentence argues for — would silently DELETE
 * the documented Read→Edit/Write binding while looking like a correctness fix.
 * That is the accidental-safety shape this plan has met repeatedly. The pins
 * below are the compensating control: a tool binding cannot be introduced
 * without a named failure here.
 *
 * **A tool binding HAS since been introduced, on the ALLOW side only, and this
 * file is what kept it from taking the deny binding with it (W3-c, 2026-09-03).**
 * P3.214 (`97bbaccac`) added an exclusion-only `excludeTools` to the `pathGlob`
 * matcher so a `Read` ALLOW stops granting Edit/Write/MultiEdit/NotebookEdit.
 * The compensating control worked as designed: the change was expressible only
 * as an exclusion, and the DENY column below is byte-for-byte what it was. The
 * last describe carries the measured table for both columns.
 *
 * The evaluator is also the reason this is one pin and not three:
 * `evaluatePermissionDslV1` is what Pi (`pi-agent.ts`), codex (`codex-agent.ts`)
 * and `SessionManager` all ask, so the codex half below is proof of inheritance
 * rather than a second implementation.
 *
 * SAFETY: every path here is DATA handed to a matcher. Nothing in this file
 * opens, creates or deletes a file.
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test';

import { codexApprovalRuleRequests } from '../codex-agent.ts';
import { parseClaudeRuleString } from '../pi-harness/claude-permission-rules.ts';
import { compilePermissionDslV1, evaluatePermissionDslV1 } from '../pi-harness/permission-dsl.ts';

setDefaultTimeout(30_000);

const CWD = '/workspace';
const TARGET = '/workspace/secrets/a.txt';
const NOTEBOOK = '/workspace/secrets/a.ipynb';
const OUTSIDE = '/workspace/src/index.ts';

function program(rule: string, action: 'allow' | 'deny' | 'ask') {
  const parsed = parseClaudeRuleString(rule, action);
  if (!parsed.rule) throw new Error(`rule did not parse: ${rule}`);
  return compilePermissionDslV1({
    generation: 'g1',
    projectTrusted: true,
    layers: [{
      scope: 'workspace',
      sourceDigest: 'digest',
      sourceRoot: CWD,
      document: { version: 1, rules: [{ id: 'rule-under-test', ...parsed.rule }] },
    }],
  });
}

function verdict(
  compiled: ReturnType<typeof program>,
  toolName: string,
  semanticId: string,
  input: Record<string, unknown>,
): string {
  return evaluatePermissionDslV1(compiled, {
    generation: 'g1', semanticId, toolName, input, cwd: CWD,
  }).action ?? 'no-match';
}

describe('a Read deny rule blocks the Edit and Write tools on the same path', () => {
  const denyRead = program('Read(secrets/**)', 'deny');

  it('denies Read itself (positive control for the instrument)', () => {
    expect(verdict(denyRead, 'Read', 'read', { file_path: TARGET })).toBe('deny');
  });

  it('leaves a path outside the rule alone (negative control, so "deny" is not vacuous)', () => {
    expect(verdict(denyRead, 'Read', 'read', { file_path: OUTSIDE })).toBe('no-match');
    expect(verdict(denyRead, 'Edit', 'edit', { file_path: OUTSIDE })).toBe('no-match');
    expect(verdict(denyRead, 'Write', 'write', { file_path: OUTSIDE })).toBe('no-match');
  });

  it.each([
    ['Edit', 'edit'],
    ['Write', 'write'],
    ['MultiEdit', 'multi-edit'],
  ])('denies %s on the same path — the documented binding', (toolName, semanticId) => {
    expect(verdict(denyRead, toolName, semanticId, { file_path: TARGET })).toBe('deny');
  });

  it('denies a Write that would CREATE a new file there', () => {
    // "including creating a new file there" — the matcher is a path predicate,
    // so a target that does not exist is judged the same as one that does.
    expect(verdict(denyRead, 'Write', 'write', { file_path: '/workspace/secrets/new.txt' })).toBe('deny');
  });

  it('denies the Pi argument spelling as well as the Claude one', () => {
    // Pi's `read`/`edit`/`write` send `path`, not `file_path`. A binding that
    // reached only one vocabulary would look done — the drift
    // `denied-path-tool-vocabulary.test.ts` pins on the other floor.
    expect(verdict(denyRead, 'Edit', 'edit', { path: TARGET })).toBe('deny');
    expect(verdict(denyRead, 'Write', 'write', { path: TARGET })).toBe('deny');
  });

  it('reaches codex through the SAME evaluator, which is the whole point of the fix site', () => {
    // `codex-agent.ts` projects an `applyPatchApproval` onto Edit requests and
    // asks `evaluatePermissionDslV1`. If the binding lived in `pre-tool-use.ts`
    // instead, this assertion would fail while Pi's above still passed — the
    // exact asymmetry the row was opened about.
    const requests = codexApprovalRuleRequests(
      'fileChangeV1',
      { fileChanges: { [TARGET]: {} }, cwd: CWD },
      CWD,
    );
    // TWO requests per path since P6.644 (`f074ef2b7`), and that is the point
    // rather than an accident: codex's `applyPatchApproval` both CREATES and
    // MODIFIES files, the rule path used to spell it `Edit` while the floor path
    // spelled it `Write`, and `permission-dsl.ts` matches a rule against the
    // literal tool name — so a user's `Write(...)` rule reached only half the
    // gate. Both names are now projected from one constant. Read as a SET, so
    // the order of the two (`Write` first, because that is the name a refusal
    // already renders to the user) is not pinned here twice — the projection
    // itself, the shared constant and that order are owned by
    // `codex-file-change-spelling.test.ts`, which is where to go next.
    expect(requests.map(request => request.toolName).sort()).toEqual(['Edit', 'Write']);
    // The binding this file is about must hold for EVERY name the projection
    // emits — a Read deny that bound only one of them would be the same
    // half-covered gate under a different name.
    for (const request of requests) {
      expect(verdict(denyRead, request.toolName, request.semanticId, request.input)).toBe('deny');
    }
  });
});

describe('DIVERGENCES recorded rather than buried — read the note before "fixing" one', () => {
  const denyRead = program('Read(secrets/**)', 'deny');
  const allowRead = program('Read(secrets/**)', 'allow');

  it('DIVERGENCE: NotebookEdit IS covered here, and the page says it is not', () => {
    // "NotebookEdit isn't covered, so add an `Edit` deny rule for paths no tool
    // may change." Our matcher is a path predicate with no tool binding, so it
    // covers NotebookEdit too. The divergence is in the REFUSING direction —
    // we deny where the page would prompt — and closing it would REMOVE a deny
    // from a credential path. That is a widening, and a widening in this family
    // is what `40d03e4a4` had to repair. Do not "fix" this without an owner
    // call; change the assertion only together with that decision.
    expect(verdict(denyRead, 'NotebookEdit', 'notebook-edit', { notebook_path: NOTEBOOK })).toBe('deny');
  });

  /**
   * CLOSED, and this row is the record of the closure rather than of the
   * divergence — a posture change, so it is stated rather than edited quietly.
   *
   * It used to read "DIVERGENCE: a Read ALLOW also grants Edit and Write, which
   * the page does not say", and it pinned `allow` for both. **P3.214
   * (`97bbaccac`) removed that widening on purpose**: the page's binding is
   * DENY-only — "A `Read` deny rule also blocks the Edit and Write tools" —
   * and nothing in it says a Read ALLOW grants an edit. The fix is an
   * exclusion-only `excludeTools` on the `pathGlob` matcher, needed because
   * `file_path` is the parameter Read, Edit and Write all share.
   *
   * Measured at `7a8477690` (W3-c), one `Read(secrets/**)` rule per column:
   *
   *   tool          ALLOW        DENY
   *   Read          allow        deny
   *   Edit          no-match     deny
   *   Write         no-match     deny
   *   MultiEdit     no-match     deny
   *   NotebookEdit  no-match     deny
   *   Grep          allow        deny
   *   Glob          allow        deny
   *
   * Both halves are asserted below, together, because the risk in this family
   * is exactly that a tightening on one side silently takes the other with it:
   * the deny column is the documented binding this whole file exists to guard,
   * and it is unmoved. Grep and Glob keep the grant deliberately (P3.214: the
   * page's own read-family scoping), which is also what makes the four
   * `no-match` cells above a decision rather than a matcher-wide amputation.
   */
  it('a Read ALLOW no longer grants the editing tools, and the deny binding is unmoved', () => {
    for (const [toolName, semanticId, input] of [
      ['Edit', 'edit', { file_path: TARGET }],
      ['Write', 'write', { file_path: TARGET }],
      ['MultiEdit', 'multi-edit', { file_path: TARGET }],
      ['NotebookEdit', 'notebook-edit', { notebook_path: NOTEBOOK }],
    ] as const) {
      expect(verdict(allowRead, toolName, semanticId, input), `allow/${toolName}`).toBe('no-match');
      expect(verdict(denyRead, toolName, semanticId, input), `deny/${toolName}`).toBe('deny');
    }
    // The control that keeps the four `no-match` cells from being vacuous: the
    // rule DOES still match its own tool, and the read family it was scoped to.
    expect(verdict(allowRead, 'Read', 'read', { file_path: TARGET })).toBe('allow');
    expect(verdict(allowRead, 'Grep', 'grep', { path: '/workspace/secrets' })).toBe('allow');
    expect(verdict(allowRead, 'Glob', 'glob', { path: '/workspace/secrets' })).toBe('allow');
  });

  /**
   * C3.299 — **the suspicion is REFUTED, and the refutation is this pair.**
   *
   * W16-l1 noticed, while building the C3.285 classifier, that on codex
   * `file_path` is the ONLY path input the approval projection carries, and
   * proposed that a rule written about READING could therefore answer a WRITE
   * there — a rule doing something its author did not write. Measured here
   * through the real projection rather than argued: it cannot, because
   * `excludeTools` is exactly the tool-name qualifier that case needs and it is
   * applied by the shared evaluator, which is the one codex asks.
   *
   * The second arm is what keeps the first from being vacuous: an `Edit` ALLOW
   * on the same path DOES answer the same two codex requests, so the `no-match`
   * above is the exclusion working and not a projection that answers nothing.
   *
   * RESIDUE, stated rather than fixed: the exclusion is compiled for
   * `Read` + `allow` only (`claude-permission-rules.ts`, `READ_ALLOW_EXCLUDED_TOOLS`),
   * so a `Read` ASK rule still asks on a codex write. That is the same
   * wider-in-the-safe-direction divergence this file already records for the
   * deny side, and narrowing it would remove a prompt from a path the author
   * fenced.
   */
  it('C3.299 · a Read ALLOW does not answer a codex patch approval, and an Edit ALLOW does', () => {
    const requests = codexApprovalRuleRequests(
      'fileChangeV1',
      { fileChanges: { [TARGET]: {} }, cwd: CWD },
      CWD,
    );
    expect(requests.map(request => request.toolName).sort()).toEqual(['Edit', 'Write']);

    const allowEdit = program('Edit(secrets/**)', 'allow');
    for (const request of requests) {
      expect(
        verdict(allowRead, request.toolName, request.semanticId, request.input),
        `Read allow / ${request.toolName}`,
      ).toBe('no-match');
      expect(
        verdict(allowEdit, request.toolName, request.semanticId, request.input),
        `Edit allow / ${request.toolName}`,
      ).toBe('allow');
    }
  });

  it('an Edit deny still governs every file-editing tool, which the page DOES say', () => {
    // "`Edit` rules apply to all built-in tools that edit files."
    const denyEdit = program('Edit(secrets/**)', 'deny');
    for (const [toolName, semanticId] of [['Edit', 'edit'], ['Write', 'write'], ['MultiEdit', 'multi-edit']] as const) {
      expect(verdict(denyEdit, toolName, semanticId, { file_path: TARGET })).toBe('deny');
    }
  });
});
