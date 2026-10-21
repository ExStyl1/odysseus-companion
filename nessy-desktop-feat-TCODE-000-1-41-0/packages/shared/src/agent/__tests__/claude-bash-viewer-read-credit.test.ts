/**
 * F1.96 (origin D1.410, the F1.12 review's finding #9) — on claude a Bash file
 * viewer must credit the read-before-write ledger only once it has actually RUN
 * and succeeded, the way Pi and codex already do.
 *
 * ## The defect
 *
 * The credit lived inside `applyReadBeforeWriteRule`, which runs from the
 * PreToolUse hook — before the gate has decided and before the child executes —
 * and its condition was `existsSync(path)` alone. So a viewer the user DENIED,
 * or one that exited non-zero (`bat` not installed, exit 127), still marked the
 * file as seen, and the next `Write` to that file was no longer refused: an
 * overwrite of a file nobody looked at, unlocked by a read that never happened.
 * Pi credits a viewer AFTER the command on exit code 0; codex credits from the
 * item it gets back, on a non-error return. Claude was the outlier, which is
 * exactly the cross-runtime divergence D1.332 exists to remove, in the direction
 * that weakens a gate.
 *
 * ## Native-first
 *
 * `hooks.md`'s event table reads *"`PostToolUse` | After a tool call succeeds"*
 * with *"`PostToolUseFailure` | After a tool call fails"* on the line below, so
 * the runtime's OWN event carries the success gate and nothing new is invented
 * to express it. A denied call reaches neither event.
 *
 * ## What this suite drives
 *
 * The agent's real `applyReadBeforeWriteRule` and its real `creditBashViewerRead`
 * over a real `SessionFileReadLedger` and a real file on disk — the refusal
 * string is the observable, because that is what the model is handed. The hooks
 * themselves are closures inside the SDK query options and cannot be reached
 * without a running child, so that the two seams CALL these methods is a
 * source-text arm at the bottom, each bounded by `bracedRegion` with a control
 * declared below its anchor.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

import { ClaudeAgent } from '../claude-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import { bracedRegion } from '../../testing/source-regions.ts';
import { bareFileViewerOperand, readCreditingToolResultSucceeded } from '../core/read-before-write.ts';

// Importing `claude-agent.ts` is this file's whole wall-clock cost; the cases
// themselves are milliseconds. Sized against the FILE, not against a case.
setDefaultTimeout(120_000);

interface Internals {
  applyReadBeforeWriteRule: (toolName: string, input: Record<string, unknown>) => Promise<string | undefined>;
  creditBashViewerRead: (toolName: string, toolInput: unknown, toolResponse: unknown) => void;
  declineBashViewerCredit: (toolName: string, toolInput: unknown, error: unknown) => void;
}

const agents: ClaudeAgent[] = [];
afterEach(() => { for (const agent of agents.splice(0)) agent.destroy(); });

/** A real agent over a real workspace holding one real, unread file. */
function rig() {
  const root = mkdtempSync(join(tmpdir(), 'f196-ws-'));
  const seeded = join(root, 'notes.md');
  writeFileSync(seeded, 'content the conversation has never seen\n');
  const agent = new ClaudeAgent({
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-f196', name: 'F196', rootPath: root,
      workspaceRootPath: root, sessionRootPath: join(root, 'sessions'),
    } as never,
    session: { id: 'sess-f196', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: root } as never,
  } as BackendConfig);
  agents.push(agent);
  // The fixture's runtime is asserted rather than assumed (the 2026-09-20 trap).
  expect(agent).toBeInstanceOf(ClaudeAgent);
  // And the file really is there, which is what made the old `existsSync`
  // condition look sufficient.
  expect(existsSync(seeded)).toBe(true);

  const internals = agent as unknown as Internals;
  return {
    agent,
    root,
    seeded,
    view: (response: unknown) => internals.creditBashViewerRead('Bash', { command: `cat ${seeded}` }, response),
    preHook: (toolName: string, input: Record<string, unknown>) =>
      internals.applyReadBeforeWriteRule(toolName, input),
    writeVerdict: () => internals.applyReadBeforeWriteRule('Write', { file_path: seeded }),
  };
}

/**
 * The credit as `applyReadBeforeWriteRule` had it before F1.96, verbatim in
 * behaviour: operand, resolve, `existsSync`. Kept as a PERMANENT negative
 * control — the arms below assert that this shape credits where the shipped one
 * refuses, so no later refactor can satisfy this suite by moving the credit back
 * in front of the gate.
 */
const PRE_F1_96_CREDIT = (command: string, root: string): string | undefined => {
  const viewed = bareFileViewerOperand(command);
  if (!viewed) return undefined;
  const path = resolve(root, viewed);
  return existsSync(path) ? path : undefined;
};

describe('F1.96 — the viewer credit follows the command, not the intent', () => {
  it('(a) the PreToolUse seam credits nothing for a viewer: an unread file is still refused', async () => {
    const r = rig();

    // This is what the SDK hook calls before the gate decides.
    expect(await r.preHook('Bash', { command: `cat ${r.seeded}` })).toBeUndefined();

    const refusal = await r.writeVerdict();
    expect(refusal).toBeDefined();
    expect(refusal).toContain('has not been read in this session');
    // And the BEFORE-state would have credited it — the whole row, in one line.
    expect(PRE_F1_96_CREDIT(`cat ${r.seeded}`, r.root)).toBe(r.seeded);
  });

  it('(b) a viewer that SUCCEEDED credits, so the next write is allowed', async () => {
    const r = rig();
    r.view({ stdout: 'content the conversation has never seen\n', interrupted: false });

    expect(await r.writeVerdict()).toBeUndefined();
  });

  it('(c) a viewer that FAILED credits nothing — `bat` absent, exit 127', async () => {
    const r = rig();
    r.view({ is_error: true, stdout: '', stderr: 'command not found: bat' });

    expect(await r.writeVerdict()).toContain('has not been read in this session');
  });

  it('(d) an INTERRUPTED viewer credits nothing — the user stopped it mid-read', async () => {
    const r = rig();
    r.view({ stdout: '', interrupted: true });

    expect(await r.writeVerdict()).toContain('has not been read in this session');
  });

  it('(e) a DENIED viewer credits nothing, because neither post-event ever fires', async () => {
    const r = rig();
    // A denial is expressed the only way it can be here: the pre-hook ran (the
    // gate saw the call) and the post-hook never did.
    expect(await r.preHook('Bash', { command: `cat ${r.seeded}` })).toBeUndefined();

    expect(await r.writeVerdict()).toContain('has not been read in this session');
  });

  it('control — `Read` still credits from the PreToolUse seam, unchanged', async () => {
    const r = rig();
    expect(await r.preHook('Read', { file_path: r.seeded })).toBeUndefined();

    expect(await r.writeVerdict()).toBeUndefined();
  });

  it('control — a Bash command that is not a bare viewer credits nothing', async () => {
    const r = rig();
    const internals = r.agent as unknown as Internals;
    internals.creditBashViewerRead('Bash', { command: `grep needle ${r.seeded}` }, { stdout: 'x' });

    expect(await r.writeVerdict()).toContain('has not been read in this session');
  });

  it('control — the success predicate reads three fields and treats anything else as success', () => {
    expect(readCreditingToolResultSucceeded({ stdout: 'x' })).toBe(true);
    expect(readCreditingToolResultSucceeded('a bare string result')).toBe(true);
    expect(readCreditingToolResultSucceeded(undefined)).toBe(true);
    expect(readCreditingToolResultSucceeded({ is_error: true })).toBe(false);
    expect(readCreditingToolResultSucceeded({ isError: true })).toBe(false);
    expect(readCreditingToolResultSucceeded({ interrupted: true })).toBe(false);
  });
});

/**
 * F1.187 (origin WJ-h P-WJ-h-2) — the FAILING twin, wired.
 *
 * `claude-post-tool-use-failure-e2e.test.ts` measured on the vendored binary
 * that every non-zero viewer (`cat` of a missing file, `false`, an absent
 * binary, an absent `bat`) fires `PostToolUseFailure` and never `PostToolUse`.
 * These arms pin what this fork does with that event: credit nothing, and say
 * so on the debug channel with the payload's `error` first line.
 */
describe('F1.187 — a viewer that arrives on PostToolUseFailure earns nothing', () => {
  it('the failing twin leaves the file unread and names the event on the debug channel', async () => {
    const r = rig();
    const lines: string[] = [];
    r.agent.onDebug = (message: string) => { lines.push(message); };
    const internals = r.agent as unknown as Internals;

    internals.declineBashViewerCredit(
      'Bash',
      { command: `cat ${r.seeded}` },
      `Exit code 1\ncat: ${r.seeded}: Permission denied`,
    );

    expect(await r.writeVerdict()).toContain('has not been read in this session');
    const said = lines.filter(line => line.startsWith('[read-before-write] no credit for'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('PostToolUseFailure: Exit code 1');
    expect(said[0]).toContain(r.seeded);
  });

  it('control — a failing command that is not a viewer is none of this rule\'s business: no line', () => {
    const r = rig();
    const lines: string[] = [];
    r.agent.onDebug = (message: string) => { lines.push(message); };
    const internals = r.agent as unknown as Internals;

    internals.declineBashViewerCredit('Bash', { command: 'false' }, 'Exit code 1');
    internals.declineBashViewerCredit('Read', { file_path: r.seeded }, 'File does not exist.');

    expect(lines.filter(line => line.startsWith('[read-before-write]'))).toEqual([]);
  });

  it('control — the same viewer on the SUCCESS twin still credits, so the arm above is the event and not the rig', async () => {
    const r = rig();
    r.view({ stdout: 'content the conversation has never seen\n', stderr: '', interrupted: false });

    expect(await r.writeVerdict()).toBeUndefined();
  });
});

describe('F1.96 — the two seams that call it', () => {
  const source = () => readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');

  it('the PreToolUse revalidate no longer credits a viewer', () => {
    const src = source();
    const anchor = src.indexOf('revalidate: async hookResolvedInput => {');
    expect(anchor).toBeGreaterThan(0);
    const region = bracedRegion(src, anchor);

    expect(region).toContain('applyReadBeforeWriteRule(');
    // The claim AND the boundary control in one: `creditBashViewerRead` is
    // declared far BELOW this region (its method sits past `chatImpl`), so a
    // brace scan that ran away would pick it up.
    expect(region).not.toContain('this.creditBashViewerRead(');
  });

  it('F1.187 — the PostToolUseFailure hook declines, and never reaches the credit', () => {
    const src = source();
    const anchor = src.indexOf('PostToolUseFailure: [{');
    expect(anchor).toBeGreaterThan(0);
    const region = bracedRegion(src, anchor);

    expect(region).toContain("input.hook_event_name !== 'PostToolUseFailure'");
    expect(region).toContain('this.declineBashViewerCredit(');
    // The claim, and a control at once: both methods are declared far BELOW
    // this region, so a brace scan that ran away would contain the credit's
    // name and the later method's.
    expect(region).not.toContain('creditBashViewerRead');
    expect(region).not.toContain('private wrapUserText(');
  });

  it('the PostToolUse hook does', () => {
    const src = source();
    const anchor = src.indexOf('PostToolUse: [{');
    expect(anchor).toBeGreaterThan(0);
    const region = bracedRegion(src, anchor);

    expect(region).toContain('this.creditBashViewerRead(');
    // Boundary control, declared BELOW this region: `private wrapUserText(` is a
    // later method of the same class and must sit outside these braces.
    expect(region).not.toContain('private wrapUserText(');
  });
});
