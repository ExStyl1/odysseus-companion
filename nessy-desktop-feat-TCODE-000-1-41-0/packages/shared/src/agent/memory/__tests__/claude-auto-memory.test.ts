/**
 * C3.181 — the claude runtime's auto-memory disposition, in all three arms.
 *
 * WHAT EACH CASE KILLS
 *
 *  - "reports the runtime default" dies if the ON arm ever starts claiming we
 *    enabled something. We enable nothing: the sentence has to say the runtime's
 *    own resolution decides, and it has to name the directory, because naming it
 *    is the whole reason the module exists.
 *  - "names the per-workspace config dir" dies if the root stops following
 *    `CLAUDE_CONFIG_DIR`, which is what makes the tree per-Workspace rather than
 *    per-machine.
 *  - "the host off switch still stops it" is the control the row asks for: with
 *    the variable set, the sentence must say memory is OFF and must not claim
 *    files are being written.
 *  - "`0` is the force-on arm" pins the direction this app never writes — a
 *    classifier that folded `'0'` into "off" would describe an operator's forced
 *    memory as closed.
 *  - "agrees with the env fragment the host actually writes" dies the day
 *    `buildClaudeSessionMemoryEnv` is renamed or re-spelled and this reader is
 *    left describing a switch nobody flips.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_AUTO_MEMORY_ENV_VAR,
  CLAUDE_AUTO_MEMORY_PROJECTS_DIR_NAME,
  describeClaudeAutoMemory,
  resolveClaudeAutoMemoryDisposition,
} from '../claude-auto-memory.ts';
import { buildClaudeSessionMemoryEnv, SESSION_MEMORY_SCOPE_NONE } from '../session-memory-scope.ts';

const WORKSPACE_CONFIG_DIR = '/tmp/nessy-w15e/workspace-7/claude-config';

describe('the claude runtime auto-memory disposition', () => {
  test('reports the runtime default, and names where the files land', () => {
    const d = resolveClaudeAutoMemoryDisposition({ CLAUDE_CONFIG_DIR: WORKSPACE_CONFIG_DIR });
    expect(d.state).toBe('runtime-default');
    expect(d.sentence).toContain('ON unless your own Claude settings turn it off');
    expect(d.sentence).toContain('MEMORY.md');
    expect(d.sentence).toContain(join(WORKSPACE_CONFIG_DIR, 'projects'));
    expect(d.sentence).toContain('/<project>/memory/');
    // The claim we must never make: that this app switched it on.
    expect(d.sentence).not.toContain('this app enables');
  });

  test('names the per-workspace config dir, and falls back to the runtime home', () => {
    const scoped = resolveClaudeAutoMemoryDisposition({ CLAUDE_CONFIG_DIR: WORKSPACE_CONFIG_DIR });
    expect(scoped.fromConfigDir).toBe(true);
    expect(scoped.projectsRoot).toBe(join(WORKSPACE_CONFIG_DIR, 'projects'));

    const bare = resolveClaudeAutoMemoryDisposition({});
    expect(bare.fromConfigDir).toBe(false);
    expect(bare.projectsRoot).toBe(join(homedir(), '.claude', 'projects'));
  });

  test('the host off switch still stops it, and the sentence says so', () => {
    const env = { CLAUDE_CONFIG_DIR: WORKSPACE_CONFIG_DIR, ...buildClaudeSessionMemoryEnv(SESSION_MEMORY_SCOPE_NONE) };
    const d = resolveClaudeAutoMemoryDisposition(env);
    expect(d.state).toBe('off-by-host');
    expect(d.sentence).toContain('OFF for this session');
    expect(d.sentence).toContain('neither creates nor loads');
    expect(d.sentence).not.toContain('ON unless');
  });

  test('a `0` in the environment is the force-on arm, which this app never writes', () => {
    const d = resolveClaudeAutoMemoryDisposition({
      CLAUDE_CONFIG_DIR: WORKSPACE_CONFIG_DIR,
      [CLAUDE_AUTO_MEMORY_ENV_VAR]: '0',
    });
    expect(d.state).toBe('forced-on');
    expect(d.sentence).toContain('FORCED ON');
    expect(d.sentence).toContain('never writes that value');
    // An empty value is not a decision: it reads as unset, not as "off".
    expect(resolveClaudeAutoMemoryDisposition({ [CLAUDE_AUTO_MEMORY_ENV_VAR]: '' }).state)
      .toBe('runtime-default');
  });

  test('agrees with the env fragment the host actually writes', () => {
    const written = buildClaudeSessionMemoryEnv(SESSION_MEMORY_SCOPE_NONE);
    expect(Object.keys(written)).toEqual([CLAUDE_AUTO_MEMORY_ENV_VAR]);
    expect(describeClaudeAutoMemory(written)).toContain('OFF for this session');
  });
});

/**
 * C3.255 — `CLAUDE_CODE_PROJECT_DIR_NAME`, pinned against the vendored bundle.
 *
 * WHY A BUNDLE READ AND NOT A UNIT ARM. This module STATES where the claude
 * runtime's auto memory lands and computes almost none of it: the sentence rests
 * on the SDK's own project-dir naming — `<config dir>/projects/`, with
 * `CLAUDE_CODE_PROJECT_DIR_NAME` standing in for the derived `<project>` leaf and
 * honoured ONLY when `CLAUDE_CONFIG_DIR` is set. Nothing else in this repo fails
 * when the vendor changes that, so the sentence could go on describing a tree
 * that no longer exists. These two cases are that alarm.
 *
 * Read out of `sdk.mjs` rather than the 233 MB native binary: the naming is in
 * BOTH — `CLAUDE_CODE_PROJECT_DIR_NAME` scores 3 occurrences in `sdk.mjs` and 6
 * in the binary (`grep -ao <name> <file> | wc -l`, OCCURRENCES and not matching
 * lines; standing control `nessyNotARealSdkKey` → 0 in each, measured
 * 2026-09-12 at `0.3.247` / `2.1.247`) — and a text artefact is what a test can
 * read whole.
 *
 * BY CONTENT, NEVER BY SYMBOL (P3.309): the bundle's bindings are minified and a
 * lift renames them, so every assertion below matches the vendor's own env-var
 * names, its own literals and the SHAPE around them, never a minified
 * identifier.
 *
 * WHAT EACH CASE KILLS
 *
 *  - "the SDK still reads the name, and still only beside `CLAUDE_CONFIG_DIR`"
 *    dies the day the vendor drops the variable, stops gating it on the config
 *    dir, or moves the tree off `<config dir>/projects/` — each of which makes
 *    this module's sentence wrong in a way no other test can see.
 *  - "the leaf is the runtime's, and this module does not pretend otherwise" is
 *    the boundary: the vendor validates the name (1–64 of `[A-Za-z0-9_-]`, and
 *    Windows device names refused), and setting it must NOT move what this
 *    module reports, because the module deliberately names the PARENT and leaves
 *    `<project>` a placeholder. A future edit that "helpfully" appended the
 *    pinned name would start printing a directory the runtime may not use.
 */
describe('C3.255 — the SDK project-dir naming this module depends on', () => {
  /** The vendored bundle; a text artefact, small enough to read whole. */
  const sdkBundle = (): string => {
    const entry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
    const path = `${entry.slice(0, entry.lastIndexOf('/'))}/sdk.mjs`;
    if (!existsSync(path)) throw new Error(`vendored sdk.mjs missing at ${path}`);
    return readFileSync(path, 'utf8');
  };

  test('the SDK still reads the name, and still only beside `CLAUDE_CONFIG_DIR`', () => {
    const bundle = sdkBundle();
    expect(bundle.length).toBeGreaterThan(1_000_000);
    // The probe reads the file: one control that must be there, one that must not.
    expect(bundle).toContain(CLAUDE_AUTO_MEMORY_ENV_VAR);
    expect(bundle).not.toContain('nessyNotARealSdkKey');

    // The reader itself.
    expect(bundle).toContain('return process.env.CLAUDE_CODE_PROJECT_DIR_NAME');
    // And the gate: the name is consulted only when CLAUDE_CONFIG_DIR is set.
    // The validator between them is a minified binding, so it is matched as a
    // shape rather than by name.
    expect(bundle).toMatch(
      /CLAUDE_CONFIG_DIR\?[A-Za-z_$][\w$]*\(t\.CLAUDE_CODE_PROJECT_DIR_NAME\)/,
    );

    // The tree this module prints: <CLAUDE_CONFIG_DIR, else ~/.claude>/projects/
    expect(bundle).toContain(`.claude"),"${CLAUDE_AUTO_MEMORY_PROJECTS_DIR_NAME}")`);
  });

  test('the leaf is the runtime\'s, and this module does not pretend otherwise', () => {
    const bundle = sdkBundle();
    // The vendor validates the pinned name; that validation is the reason the
    // leaf is not ours to reproduce.
    expect(bundle).toContain('/^[A-Za-z0-9_-]{1,64}$/');
    expect(bundle).toContain('/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i');

    // The boundary: a pinned name in the child env must not move what we report.
    const withPin = resolveClaudeAutoMemoryDisposition({
      CLAUDE_CONFIG_DIR: WORKSPACE_CONFIG_DIR,
      CLAUDE_CODE_PROJECT_DIR_NAME: 'work',
    });
    expect(withPin.projectsRoot).toBe(join(WORKSPACE_CONFIG_DIR, CLAUDE_AUTO_MEMORY_PROJECTS_DIR_NAME));
    expect(withPin.sentence).toContain('/<project>/memory/');
    expect(withPin.sentence).not.toContain('/work/');
  });
});

/**
 * C3.349 — a project-less session, and the clause this module used to drop.
 *
 * R3's C5.27 drove it live on the packaged 1.37.0 build: a second session on the
 * SAME working directory reads the first one's auto memory back, while on a
 * working directory of the session's own the next session answers `NONE` — five
 * of six leaves on that profile were empty. The module's sentence said only
 * *"derived by the runtime from the git repository, so every worktree of one
 * repository shares one directory"*, which is the FIRST clause of
 * `memory.md#storage-location` and reads as a promise of stability; the page's
 * second clause — *"Outside a git repo, the project root is used instead."* — is
 * the one that governs a session with no project, and it was missing.
 *
 * WHAT EACH CASE KILLS
 *
 *  - "carries BOTH arms" dies the day someone shortens the sentence back to the
 *    repository half. It is asserted as two positive `toContain`s rather than as
 *    the absence of the old wording, so it cannot be satisfied by deleting both.
 *  - "the OFF arm stays silent about the leaf" is the boundary: with memory off
 *    nothing is being written anywhere, so a sentence explaining which directory
 *    would have been chosen is noise, and a future edit that folds the leaf into
 *    every arm would add it.
 *
 * The pin arm of this rule is NOT retested here — C3.255's second case already
 * owns it, and the decision this row records is that we do not set
 * `CLAUDE_CODE_PROJECT_DIR_NAME` at all (see the module docblock for the page
 * clause that makes a pin a regression in this app's per-Workspace shape).
 */
describe('C3.349 — the <project> leaf rule, both of its arms', () => {
  test('the ON sentence carries the outside-a-repository arm, and what it costs', () => {
    const d = resolveClaudeAutoMemoryDisposition({ CLAUDE_CONFIG_DIR: WORKSPACE_CONFIG_DIR });
    expect(d.state).toBe('runtime-default');
    // The arm that was always here.
    expect(d.sentence).toContain('every worktree of one repository shares one directory');
    // The arm C5.27 measured and this module used to omit.
    expect(d.sentence).toContain('outside one the project root is used instead');
    expect(d.sentence).toContain('the next session started elsewhere reads none of it');
    // Still the PARENT, never a leaf we derived.
    expect(d.sentence).toContain('/<project>/memory/');

    // The forced-on arm shares the same clause, because the rule is the
    // runtime's and does not depend on who asked for memory.
    const forced = resolveClaudeAutoMemoryDisposition({
      CLAUDE_CONFIG_DIR: WORKSPACE_CONFIG_DIR,
      [CLAUDE_AUTO_MEMORY_ENV_VAR]: '0',
    });
    expect(forced.sentence).toContain('outside one the project root is used instead');
  });

  test('the OFF arm stays silent about the leaf, because nothing is being written', () => {
    const off = resolveClaudeAutoMemoryDisposition({
      CLAUDE_CONFIG_DIR: WORKSPACE_CONFIG_DIR,
      ...buildClaudeSessionMemoryEnv(SESSION_MEMORY_SCOPE_NONE),
    });
    expect(off.state).toBe('off-by-host');
    expect(off.sentence).not.toContain('outside one the project root is used instead');
    // It still says where an EARLIER session's files are, which is the one
    // thing a user needs from the off arm.
    expect(off.sentence).toContain('/<project>/memory/');
  });
});
