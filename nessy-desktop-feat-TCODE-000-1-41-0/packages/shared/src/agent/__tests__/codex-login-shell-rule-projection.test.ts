/**
 * F1.814 — does a Claude-form `Bash(...)` rule bind the command codex ACTUALLY
 * sends? Codex sends its login-shell transport, not the model's command.
 *
 * ## What was measured (2026-09-25, lane WJ-crit-ll)
 *
 * The rig drove the shipped `codex-app-server` (`rust-v0.156.1`, SHA-verified by
 * `CodexRuntimeManager`) with:
 * - a `config.toml` from the product's own `writeCodexConfig` (sandbox master
 *   switch off, a real `deniedReadPaths`, so the `nessy_runtime` profile is
 *   emitted);
 * - a stub Responses upstream whose one `exec_command` call carried
 *   `cmd: 'rm -rf ~/wjcritll-x'`.
 *
 * The `item/commandExecution/requestApproval` frame codex raised carries
 * `command: "/bin/zsh -lc 'rm -rf ~/wjcritll-x'"`: the model's `cmd` wrapped in
 * the user's login shell. The unwrapped text is only in `commandActions`. The
 * frames below are those frames, field for field (only `cwd` is this suite's).
 * The frame was identical in `default` and `bypassPermissions`. A plain
 * `git status` raised no frame at all (codex runs it as known-safe), so the
 * `git status` frame below is the one codex raised for the same call with
 * `sandbox_permissions: "require_escalated"`.
 *
 * ## The verdict: the row's CRITICAL premise is REFUTED
 *
 * The row asked whether a user's Claude-form Bash DENY might never bind codex,
 * including in bypass. `permission-modes.md` promises the opposite: "Deny rules
 * block in every mode, including `bypassPermissions`." On the real frame, a
 * `Bash(rm *)` DENY refused in `default`, `bypassPermissions` and `dontAsk`,
 * naming the rule, with no card. The deny side of the Claude matcher already
 * reads a `-c` script (`splitWithSubstitutions`, P3.12). The no-rule CONTROL in
 * bypass ACCEPTS the same frame, so the refusal is the deny's and not the mode's.
 * `codex-permission-rules.test.ts` pinned the wrapped deny in `default` with a
 * hand-built frame. This file pins it on the frame the binary really raised, in
 * the modes that file does not reach.
 *
 * ## The half that missed: an ALLOW (F1.823, owner decision 2026-09-26, option A)
 *
 * A `Bash(git status)` ALLOW gave no answer to the real `git status` frame: a
 * card in `default`, and in `dontAsk` a refusal of the very command the user
 * pre-approved. That was P3.12's deliberate, fail-closed asymmetry (the allow
 * side read top-level subcommands only), and its reverse was worse: an allow
 * `Bash(/bin/zsh *)` approved EVERY codex command, `rm -rf` included.
 *
 * `permissions.md#bash-rule-limits` states the contract: "A Bash rule matches
 * the command text Claude writes, after Claude Code splits compound commands
 * and strips wrappers." On codex the text the model writes is the `cmd`
 * argument; `<shell> -lc '…'` is codex's transport, added to every command, so
 * a rule judged against it judges something nobody wrote. P3.12 kept the allow
 * off the script because "a login shell sources the user's rc files", but the
 * transport sources them for EVERY codex command, a card approved by hand
 * included, so it never told a rule's approval from a person's. The owner chose
 * option A: `codexApprovalRuleRequests` unwraps the transport exactly ONCE
 * (`loginShellScript`, the `bash|zsh|sh` + `-c|-lc` predicate `shellProgram`
 * already used, exactly one script operand, else the frame's text as before),
 * and every rule form judges the command the model wrote, as on Pi and claude.
 * Claude itself does not strip a `bash -c` the model writes (the same table
 * lists `bash -c 'rm -rf build/'` among the forms `Bash(rm *)` does not stop),
 * which is why it is one layer and no more.
 *
 * Stated consequence, both directions: a rule naming the TRANSPORT itself
 * (`Bash(/bin/zsh *)`) no longer matches codex's wrapper. As an allow that is a
 * tightening; as a deny or ask it stops catching every codex command and judges
 * an explicit `/bin/zsh` in the script, which is what it matches on Pi and
 * claude. Residue: the argv form (`commandV1`) and a login shell the model
 * wrote itself cannot be told from the transport, and a script the tokenizer
 * refuses (a newline, `$(`, a backtick) keeps the frame's text, so an allow
 * still gives a card for it (fail-closed) while a deny still reads it (P3.12).
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackendConfig, PermissionCallback } from '../backend/types.ts';
import { CodexAgent, codexApprovalRuleRequests } from '../codex-agent.ts';
import {
  collectExecpolicyAllowPrefixes,
  getWorkspacePermissionsPath,
  loadRawWorkspacePermissions,
  permissionsConfigCache,
  saveWorkspacePermissions,
} from '../permissions-config.ts';
import * as dsl from '../pi-harness/permission-dsl.ts';
import { parseClaudeRuleString } from '../pi-harness/claude-permission-rules.ts';

const WORKSPACE_ROOT = '/tmp/nessy-codex-login-shell-ws';
const PROJECT_CWD = '/tmp/nessy-codex-login-shell-project';
const EXEC_METHOD = 'item/commandExecution/requestApproval';

/** The frame the shipped binary raised for `cmd: 'rm -rf ~/wjcritll-x'`. */
const REAL_RM_FRAME = {
  kind: 'command',
  threadId: '01a0d701-6e9b-71f3-8f35-bd1fa337a82b',
  turnId: '01a0d701-6f62-7a62-a3bf-ee5bf4aac119',
  itemId: 'call_resp_1',
  startedAtMs: 1790313590763,
  environmentId: 'local',
  command: "/bin/zsh -lc 'rm -rf ~/wjcritll-x'",
  cwd: PROJECT_CWD,
  commandActions: [{ type: 'unknown', command: 'rm -rf ~/wjcritll-x' }],
  proposedExecpolicyAmendment: ['/bin/zsh', '-lc', 'rm -rf ~/wjcritll-x'],
};

/** The frame the shipped binary raised for an escalated `cmd: 'git status'`. */
const REAL_GIT_STATUS_FRAME = {
  kind: 'command',
  threadId: '01a0d701-7066-78e2-860b-aa8327e205be',
  turnId: '01a0d701-7159-7e90-b672-47e1a693abf6',
  itemId: 'call_resp_1',
  startedAtMs: 1790313591273,
  environmentId: 'local',
  reason: 'wjcritll probe',
  command: "/bin/zsh -lc 'git status'",
  cwd: PROJECT_CWD,
  commandActions: [{ type: 'unknown', command: 'git status' }],
  proposedExecpolicyAmendment: ['git', 'status'],
};

type Mode = 'default' | 'bypassPermissions' | 'dontAsk';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-login-shell',
      name: 'Login Shell Workspace',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: '/tmp/nessy-codex-login-shell-sessions/ws-login-shell',
    } as any,
    session: {
      id: 'session-login-shell',
      workspaceRootPath: WORKSPACE_ROOT,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: PROJECT_CWD,
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

function agentWith(rules: Record<string, string[]> | null, mode: Mode = 'default') {
  const agent = new CodexAgent(createConfig());
  const debug: string[] = [];
  const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
  agent.onDebug = (message) => { debug.push(message); };
  agent.onPermissionRequest = (request) => { surfaced.push(request); };
  agent.getPermissionManager().setCapabilityPermissionLayers(
    rules === null ? [] : [{ content: JSON.stringify({ permissions: rules }), scope: 'workspace' }],
    'generation-f1814',
    true,
  );
  agent.setPermissionMode(mode);
  return { agent, debug, surfaced };
}

function ask(agent: CodexAgent, params: unknown) {
  return (agent as any).handleServerRequest(EXEC_METHOD, params) as Promise<Record<string, unknown>> | Record<string, unknown>;
}

const withCommand = (frame: Record<string, unknown>, command: string) => ({ ...frame, command });

/** The rule evaluation codex's consult runs, over one compiled program, per projected request. */
function projectedVerdicts(rules: unknown[], params: unknown): Array<string | undefined> {
  const program = dsl.compilePermissionDslV1({
    generation: 'g',
    projectTrusted: true,
    layers: [{ scope: 'workspace', sourceDigest: 'ws', document: { version: 1, rules } } as any],
  });
  return codexApprovalRuleRequests('command', params, PROJECT_CWD).map(request =>
    dsl.evaluatePermissionDslV1(program, {
      generation: 'g',
      semanticId: request.semanticId,
      toolName: request.toolName,
      input: request.input,
      cwd: request.cwd,
    }).action);
}

const claudeRule = (text: string, action: 'allow' | 'deny') =>
  ({ id: `claude-${action}`, text, ...parseClaudeRuleString(text, action).rule! });

beforeEach(() => {
  permissionsConfigCache.clear();
});

describe('F1.814 — a Claude-form DENY binds the frame codex really sends, in every mode (the refutation)', () => {
  for (const mode of ['default', 'bypassPermissions', 'dontAsk'] as const) {
    it(`refuses the real login-shell rm frame in ${mode}, naming the rule, with no card`, async () => {
      const { agent, surfaced, debug } = agentWith({ deny: ['Bash(rm *)'] }, mode);
      expect(await ask(agent, REAL_RM_FRAME)).toEqual({ decision: 'decline' });
      expect(surfaced).toEqual([]);
      expect(debug.some(line => line.includes('refused by permission rule'))).toBe(true);
    });
  }

  /** CONTROL: with no rule the same frame is ACCEPTED in bypass, so the refusal above is the deny's. */
  it('accepts the same frame in bypass when no rule denies it', async () => {
    const { agent, surfaced, debug } = agentWith(null, 'bypassPermissions');
    expect(await ask(agent, REAL_RM_FRAME)).toEqual({ decision: 'accept' });
    expect(surfaced).toEqual([]);
    expect(debug.some(line => line.includes('refused by permission rule'))).toBe(false);
  });

  /** CONTROL: a deny for a program the script never runs does not refuse it. */
  it('does not refuse the real frame off a deny for another program', async () => {
    const { agent, surfaced } = agentWith({ deny: ['Bash(curl *)'] }, 'bypassPermissions');
    expect(await ask(agent, REAL_RM_FRAME)).toEqual({ decision: 'accept' });
    expect(surfaced).toEqual([]);
  });
});

describe('F1.823 — a Claude-form ALLOW answers the command the model wrote, not the transport', () => {
  /** THE DEFECT: before, a card, although the user pre-approved exactly this command. */
  it('auto-accepts the real login-shell `git status` frame in default, with no card', async () => {
    const { agent, surfaced, debug } = agentWith({ allow: ['Bash(git status)'] });
    expect(await ask(agent, REAL_GIT_STATUS_FRAME)).toEqual({ decision: 'accept' });
    expect(surfaced).toEqual([]);
    expect(debug.some(line => line.includes('auto-allowed by permission rule'))).toBe(true);
  });

  /** THE DEFECT, user-visible: before, dontAsk REFUSED the command the rule pre-approves. */
  it('lets dontAsk run the pre-approved command instead of refusing it', async () => {
    const { agent, surfaced } = agentWith({ allow: ['Bash(git status)'] }, 'dontAsk');
    expect(await ask(agent, REAL_GIT_STATUS_FRAME)).toEqual({ decision: 'accept' });
    expect(surfaced).toEqual([]);
  });

  /** CONTROL: the same rule answers the bare spelling exactly as before. */
  it('auto-accepts the bare spelling of the same command', async () => {
    const { agent, surfaced } = agentWith({ allow: ['Bash(git status)'] });
    expect(await ask(agent, { ...REAL_GIT_STATUS_FRAME, command: 'git status' })).toEqual({ decision: 'accept' });
    expect(surfaced).toEqual([]);
  });

  /** CONTROL: dontAsk still refuses a wrapped command no rule pre-approves. */
  it('still refuses in dontAsk what no rule pre-approves', async () => {
    const { agent } = agentWith({ allow: ['Bash(git status)'] }, 'dontAsk');
    expect(await ask(agent, withCommand(REAL_GIT_STATUS_FRAME, "/bin/zsh -lc 'git push'")))
      .toEqual({ decision: 'decline' });
  });

  /** CONTROL — the allow gains NO reach beyond the script: every subcommand must still match, as for Pi's bare command. */
  it('does not approve a wrapped compound whose second half the rule never named', async () => {
    const { agent, surfaced } = agentWith({ allow: ['Bash(git status)'] });
    const pending = ask(agent, withCommand(REAL_GIT_STATUS_FRAME, "/bin/zsh -lc 'git status && rm -rf ~/wjcritll-x'"));
    expect(surfaced).toHaveLength(1);
    agent.respondToPermission(surfaced[0]!.requestId, false);
    expect(await pending).toEqual({ decision: 'decline' });
  });

  /** Stated consequence: a rule naming the TRANSPORT no longer approves every codex command. */
  it('no longer lets an allow naming the transport shell approve the script inside it', async () => {
    const { agent, surfaced } = agentWith({ allow: ['Bash(/bin/zsh *)'] });
    const pending = ask(agent, REAL_RM_FRAME);
    expect(surfaced).toHaveLength(1);
    agent.respondToPermission(surfaced[0]!.requestId, false);
    expect(await pending).toEqual({ decision: 'decline' });
  });
});

describe('F1.823 — the projection: one unwrap, the structural one, and nothing wider', () => {
  it('projects the script of `<bash|zsh|sh> -c|-lc <one script>`', () => {
    expect(codexApprovalRuleRequests('command', REAL_RM_FRAME, PROJECT_CWD).map(r => r.input.command))
      .toEqual(['rm -rf ~/wjcritll-x']);
    expect(dsl.loginShellScript("/bin/zsh -lc 'git status'")).toBe('git status');
    expect(dsl.loginShellScript("bash -c 'npm test'")).toBe('npm test');
    expect(dsl.loginShellScript('/bin/sh -lc "ls -la"')).toBe('ls -la');
    // shlex's quote-escaping — the spelling codex produces for a script with a quote in it.
    expect(dsl.loginShellScript(`/bin/zsh -lc 'echo '"'"'hi'"'"''`)).toBe("echo 'hi'");
  });

  /** CONTROL — conservative: anything but exactly one script operand keeps the frame's text. */
  it('keeps the frame text for every other shape', () => {
    for (const command of [
      "/bin/zsh -lc 'git status' extra", // more than one argument after the script flag
      "/bin/zsh -x -lc 'git status'", // another option before the flag
      '/bin/zsh -lc', // no script
      "/bin/zsh -lc '   '", // a blank script
      "fish -c 'git status'", // a shell `shellProgram` does not unwrap
      "/usr/bin/python3 -c 'print(1)'",
      "/bin/zsh -lc 'echo $(id)'", // the tokenizer refuses substitution anywhere
      'git status', // an unwrapped command
    ]) {
      expect(dsl.loginShellScript(command)).toBeNull();
      expect(codexApprovalRuleRequests('command', withCommand(REAL_RM_FRAME, command), PROJECT_CWD)
        .map(r => r.input.command)).toEqual([command]);
    }
    // And the rule answer follows: an allow for the inner command answers none of them.
    expect(projectedVerdicts([claudeRule('Bash(git status)', 'allow')],
      withCommand(REAL_GIT_STATUS_FRAME, "/bin/zsh -lc 'git status' extra"))).toEqual([undefined]);
  });

  /** CONTROL — exactly ONE layer: a login shell the model wrote inside the transport stays in the script. */
  it('unwraps the transport once, never a second shell inside it', () => {
    const nested = withCommand(REAL_GIT_STATUS_FRAME, `/bin/zsh -lc 'bash -c '"'"'git status'"'"''`);
    expect(codexApprovalRuleRequests('command', nested, PROJECT_CWD).map(r => r.input.command))
      .toEqual(["bash -c 'git status'"]);
    expect(projectedVerdicts([claudeRule('Bash(git status)', 'allow')], nested)).toEqual([undefined]);
  });

  /** CONTROL — a DENY still reads a script the unwrap refuses (P3.12's arm, unchanged). */
  it('still refuses off a deny inside a script the tokenizer will not unwrap', () => {
    expect(projectedVerdicts([claudeRule('Bash(rm *)', 'deny')],
      withCommand(REAL_RM_FRAME, "/bin/zsh -lc 'echo $(date) && rm -rf ~/wjcritll-x'"))).toEqual(['deny']);
  });

  /** CONTROL — an unwrapped command is judged exactly as before. */
  it('judges a bare command exactly as before', () => {
    const bare = withCommand(REAL_GIT_STATUS_FRAME, 'git status');
    expect(projectedVerdicts([claudeRule('Bash(git status)', 'allow')], bare)).toEqual(['allow']);
    expect(projectedVerdicts([claudeRule('Bash(rm *)', 'deny')], withCommand(REAL_RM_FRAME, 'rm -rf ~/wjcritll-x')))
      .toEqual(['deny']);
  });

  /** CONTROL — a structural rule (codex's Always-allow shape) reaches the same verdicts as before. */
  it('leaves the structural bash rule unchanged', () => {
    const allowGit = [{ id: 'codex-execpolicy-git', action: 'allow', match: { kind: 'bash', executable: 'git' } }];
    const denyRm = [{ id: 'deny-rm', action: 'deny', match: { kind: 'bash', executable: 'rm' } }];
    expect(projectedVerdicts(allowGit, REAL_GIT_STATUS_FRAME)).toEqual(['allow']);
    expect(projectedVerdicts(allowGit, REAL_RM_FRAME)).toEqual([undefined]);
    expect(projectedVerdicts(denyRm, REAL_RM_FRAME)).toEqual(['deny']);
    expect(projectedVerdicts(denyRm, REAL_GIT_STATUS_FRAME)).toEqual([undefined]);
  });

  /** The Claude-form verdicts over the real frames, side by side with the structural ones above. */
  it('gives a Claude-form rule the verdict the structural rule already had', () => {
    expect(projectedVerdicts([claudeRule('Bash(git status)', 'allow')], REAL_GIT_STATUS_FRAME)).toEqual(['allow']);
    expect(projectedVerdicts([claudeRule('Bash(rm *)', 'deny')], REAL_RM_FRAME)).toEqual(['deny']);
    expect(projectedVerdicts([claudeRule('Bash(git status)', 'allow')], REAL_RM_FRAME)).toEqual([undefined]);
  });
});

/**
 * F1.824 — an Always Allow on a frame whose `proposedExecpolicyAmendment` is the
 * WRAPPED argv must answer the identical call on the host's own rule path.
 *
 * Codex keeps the amendment wrapped exactly when its own parser refuses to split
 * the script: `parse_shell_lc_plain_commands` rejects a bare word containing `~`
 * (`codex-rs/shell-command/src/bash.rs`, `rust-v0.156.1`), so for
 * `rm -rf ~/wjcritll-x` the whole `["/bin/zsh","-lc",…]` is the only prefix it
 * will stand behind. The durable rule therefore names the wrapper, while the
 * structural matcher unwraps the REQUEST before comparing — and a rule naming
 * `/bin/zsh` never met the unwrapped `rm`. The grant is not rewritten (codex's
 * projection keeps its own amendment); the matcher also reads the request
 * as written when the rule itself names the wrapper, literally.
 */
describe('F1.824 — a wrapped Always-allow answers the identical call', () => {
  function storeAgent(workspaceRootPath: string) {
    const config = createConfig();
    (config.workspace as any).rootPath = workspaceRootPath;
    (config.workspace as any).workspaceRootPath = workspaceRootPath;
    (config.session as any).workspaceRootPath = workspaceRootPath;
    const agent = new CodexAgent(config);
    const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
    agent.onPermissionRequest = (request) => { surfaced.push(request); };
    // F1.780 — while a deny entry reaches codex, Always Allow mints no durable rule
    // (`codex-sandbox-retained-approval.test.ts`). Since F1.1057 a default session denies nothing, the
    // arm that mints one; the stub only undoes this suite's `$TMPDIR` config dir (F1.664).
    (agent as never as { codexDeniedReadPaths: () => string[] }).codexDeniedReadPaths = () => [];
    repin(agent, []);
    return { agent, surfaced };
  }

  function repin(agent: CodexAgent, layers: Array<{ content: string; scope: 'workspace' }>) {
    agent.getPermissionManager().setCapabilityPermissionLayers(layers, `generation-f1824-${layers.length}`, true);
  }

  async function grantThenReplay(first: Record<string, unknown>, replay: Record<string, unknown>) {
    const ws = mkdtempSync(join(tmpdir(), 'f1824-ws-'));
    try {
      const { agent, surfaced } = storeAgent(ws);
      const pending = ask(agent, first);
      expect(surfaced).toHaveLength(1);
      agent.respondToPermission(surfaced[0]!.requestId, true, true);
      expect(await pending).toEqual({ decision: 'acceptForSession' });
      const minted = collectExecpolicyAllowPrefixes(loadRawWorkspacePermissions(ws));
      // The rule consult reads the PINNED capability snapshot, whose workspace
      // layer is this same `permissions.json` (`native-sources.ts`); re-pin it
      // as the next snapshot would, so the replay meets the durable grant.
      repin(agent, [{ content: readFileSync(getWorkspacePermissionsPath(ws), 'utf8'), scope: 'workspace' }]);
      const second = ask(agent, replay);
      const cards = surfaced.length - 1;
      if (cards > 0) agent.respondToPermission(surfaced[1]!.requestId, false);
      return { minted, answer: await second, cards };
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }

  it('answers the identical wrapped rm call from the grant it minted, with no card', async () => {
    const { minted, answer, cards } = await grantThenReplay(REAL_RM_FRAME, REAL_RM_FRAME);
    // The grant is codex's own amendment, unchanged: the projection stays native.
    expect(minted).toEqual([['/bin/zsh', '-lc', 'rm -rf ~/wjcritll-x']]);
    expect(cards).toBe(0);
    expect(answer).toEqual({ decision: 'accept' });
  });

  /** CONTROL: the escalated `git status` grant, already unwrapped by codex, answered before this row. */
  it('answers the identical call from an unwrapped grant too', async () => {
    const { minted, answer, cards } = await grantThenReplay(REAL_GIT_STATUS_FRAME, REAL_GIT_STATUS_FRAME);
    expect(minted).toEqual([['git', 'status']]);
    expect(cards).toBe(0);
    expect(answer).toEqual({ decision: 'accept' });
  });

  /** BOUNDARY: the wrapped grant is the exact invocation — another script in the same wrapper still asks. */
  it('does not answer a different script in the same wrapper', async () => {
    const other = {
      ...REAL_RM_FRAME,
      command: "/bin/zsh -lc 'rm -rf ~/wjcritll-y'",
      commandActions: [{ type: 'unknown', command: 'rm -rf ~/wjcritll-y' }],
      proposedExecpolicyAmendment: ['/bin/zsh', '-lc', 'rm -rf ~/wjcritll-y'],
    };
    const { answer, cards } = await grantThenReplay(REAL_RM_FRAME, other);
    expect(cards).toBe(1);
    expect(answer).toEqual({ decision: 'decline' });
  });

  /** BOUNDARY: the wrapper arm is literal — a hand-written `/bin/zsh -lc *` allow approves nothing through it. */
  it('does not let a wildcard wrapper rule approve every codex command', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'f1824-ws-'));
    try {
      saveWorkspacePermissions(ws, {
        permissionDsl: {
          version: 1,
          rules: [{ id: 'f1824-wild', action: 'allow', match: { kind: 'bash', executable: '/bin/zsh', args: ['-lc', '*'] } }],
        },
      } as never);
      const { agent, surfaced } = storeAgent(ws);
      repin(agent, [{ content: readFileSync(getWorkspacePermissionsPath(ws), 'utf8'), scope: 'workspace' }]);
      const pending = ask(agent, REAL_RM_FRAME);
      expect(surfaced).toHaveLength(1);
      agent.respondToPermission(surfaced[0]!.requestId, false);
      expect(await pending).toEqual({ decision: 'decline' });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
