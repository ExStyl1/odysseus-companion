/**
 * D1.357 — the approval-posture notice says what this session's config earns.
 *
 * The defect: `formatCodexUnboundedApprovalDiagnostics` gated on the sandbox
 * master switch ALONE, so with the switch off — the shipped default — every
 * session was told it had *no OS sandbox*, while the permission profile this app
 * writes for the credential floor had bounded it all along. Measured 2026-09-18
 * at HEAD `cf47ea53e`: seven modes x {real floor, no floor} produced one line
 * each, the same line, and the config the real-floor arm wrote carried
 * `default_permissions = "nessy_runtime"` / `extends = ":workspace"` where the
 * control carried neither. On the same `writeCodexConfig` call the sibling egress
 * line already said `sandbox_mode="workspace-write" (this session's config text
 * says sandbox_mode="danger-full-access" …)` — two diagnostics of one write
 * contradicting each other.
 *
 * The behaviour behind the new wording is WI-az's drive on `rust-v0.154.0`
 * (`danger-full-access` / `on-request` throughout, one variable at a time): with
 * the profile, `touch ~/<tag>` came back `Operation not permitted`, `exitCode 1`,
 * nothing written, and an out-of-workspace `apply_patch` raised
 * `item/fileChange/requestApproval` — `decline` left the pre-image, `accept`
 * applied it; WITHOUT the profile both wrote, reproducing P2.197's row 3, with
 * `echo` returning its output as the positive control.
 *
 * ## WHAT EACH TEST KILLS
 *
 *  - "every real session gets the BOUNDED line" dies if the fix is reverted, in
 *    the state every user is in.
 *  - "no profile keeps the unbounded line" is the negative control — without it,
 *    a formatter that returned the bounded line unconditionally would pass.
 *  - "the emitted config agrees with the sentence" dies if either the profile
 *    name or the parent drifts from what the line claims; the sentence is checked
 *    against the TOML this same options object produces, never against a copy.
 *  - "the bounded line does not say `no OS sandbox`" and its mirror are the pair
 *    that stops the two wordings being merged back into one.
 *  - the gate tests keep the line off the switch-ON configurations, where the
 *    mode table is restricting and there is nothing to report.
 *  - "a policy conflict falls back" pins the `try` arm: a formatter must not be
 *    the thing that raises `codex-runtime-path-policy-conflict`.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCodexConfigToml,
  CODEX_APPROVAL_POSTURE_PREFIX,
  CODEX_BOUNDED_APPROVAL_NOTICE,
  CODEX_READ_ONLY_PROFILE_APPROVAL_NOTICE,
  CODEX_UNBOUNDED_APPROVAL_NOTICE,
  codexSandboxConfigForMode,
  formatCodexUnboundedApprovalDiagnostics,
  writeCodexConfig,
  type CodexPermissionMode,
} from '../config-writer.ts';
import { NESSY_RUNTIME_PERMISSION_PROFILE } from '../config-writer-permissions.ts';

const ALL_MODES: readonly CodexPermissionMode[] = [
  'dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions',
];

/** A codex home that is never written to; only interpolated into the TOML. */
const UNUSED_HOME = join(tmpdir(), 'nessy-d1357-unused');

const BASE = { codexHome: UNUSED_HOME, model: 'tgpt/deepseek-v4-flash-0731', adapterPort: 54321 } as const;

/**
 * What `CodexAgent` passes on EVERY real session. All four production sites that
 * build a codex config carry the credential file (`shared/agent/codex-agent.ts`:
 * `buildRuntime`, the runtime-signature seed, the re-fork override and
 * `verifyPermissionProfileAccepted`), which is what makes the profile universal.
 */
const REAL_FLOOR = {
  deniedReadPaths: ['/Users/x/.nessy-agent/credentials.enc'],
  deniedReadPatterns: ['**/.env', '~/.ssh/**'],
} as const;

describe('D1.357 — the sandbox-off notice is keyed on the profile, not on the switch alone', () => {
  test('every real session, in every mode, gets a BOUNDED line — the read-only one in plan (F1.787) and dontAsk (F1.1056)', () => {
    for (const mode of ALL_MODES) {
      // Precondition, not decoration: the config TEXT still says
      // danger-full-access, so the line is not changing because the mode did.
      expect(codexSandboxConfigForMode(mode, false).sandbox_mode).toBe('danger-full-access');
      const lines = formatCodexUnboundedApprovalDiagnostics({
        ...BASE, ...REAL_FLOOR, mode, sandboxGloballyEnabled: false,
      });
      expect(lines).toEqual([
        mode === 'plan' || mode === 'dontAsk' ? CODEX_READ_ONLY_PROFILE_APPROVAL_NOTICE : CODEX_BOUNDED_APPROVAL_NOTICE,
      ]);
    }
  });

  test('the same call with NO filesystem policy keeps the unbounded line — the negative control', () => {
    for (const mode of ALL_MODES) {
      const lines = formatCodexUnboundedApprovalDiagnostics({ ...BASE, mode, sandboxGloballyEnabled: false });
      expect(lines).toEqual([CODEX_UNBOUNDED_APPROVAL_NOTICE]);
    }
  });

  test('a session whose ONLY policy is the protected-path floor is bounded too', () => {
    // C3.343's shape: no denied read paths, no writable paths, and a profile all
    // the same. Gated on the RESOLVED policy, so this arm follows without an edit.
    const lines = formatCodexUnboundedApprovalDiagnostics({
      ...BASE, mode: 'default', sandboxGloballyEnabled: false, protectedWorkspaceSubpaths: ['.git'],
    });
    expect(lines).toEqual([CODEX_BOUNDED_APPROVAL_NOTICE]);
  });

  test('an operator-added writable root is a profile too, and the sentence names it', () => {
    // `codexAdditionalWritableRoots` feeds `writablePaths`, which become
    // `filesystem` write keys of the same profile — so a session with no denied
    // path at all is still bounded, and it is bounded WIDER than the workspace.
    // The line says so rather than promising "the workspace" flat.
    const lines = formatCodexUnboundedApprovalDiagnostics({
      ...BASE, mode: 'default', sandboxGloballyEnabled: false, writablePaths: ['/Users/x/scratch'],
    });
    expect(lines).toEqual([CODEX_BOUNDED_APPROVAL_NOTICE]);
    expect(CODEX_BOUNDED_APPROVAL_NOTICE).toContain('any directory you added');
    // The control: the same call without that root is the unbounded arm.
    expect(formatCodexUnboundedApprovalDiagnostics({ ...BASE, mode: 'default', sandboxGloballyEnabled: false }))
      .toEqual([CODEX_UNBOUNDED_APPROVAL_NOTICE]);
  });

  test('the emitted config agrees with what the bounded line claims about it', () => {
    // The sentence names a profile and a parent. Both are read back off the TOML
    // this same options object produces, so the line cannot drift from the file a
    // reader would grep — the failure mode the sibling egress line names as
    // "a reader who greps the file would conclude the diagnostic is lying".
    const opts = { ...BASE, ...REAL_FLOOR, mode: 'default' as const, sandboxGloballyEnabled: false };
    const toml = buildCodexConfigToml(opts);
    expect(toml).toContain(`default_permissions = "${NESSY_RUNTIME_PERMISSION_PROFILE}"`);
    expect(toml).toContain('extends = ":workspace"');
    expect(toml).toContain('sandbox_mode = "danger-full-access"');
    const [line] = formatCodexUnboundedApprovalDiagnostics(opts);
    expect(line).toContain(`default_permissions = "${NESSY_RUNTIME_PERMISSION_PROFILE}"`);
    expect(line).toContain('extends = ":workspace"');
    expect(line).toContain('sandbox_mode = "danger-full-access"');
    // And the control that the same options really are the no-profile arm's
    // opposite: without the floor the TOML carries neither key.
    const bare = buildCodexConfigToml({ ...BASE, mode: 'default', sandboxGloballyEnabled: false });
    expect(bare).not.toContain('default_permissions');
    expect(bare).not.toContain('extends = ":workspace"');
  });

  test('the bounded line does not repeat the claim that was false, and keeps the one that is true', () => {
    // The needle is spellable in this corpus: the unbounded constant below is the
    // positive control, asserted in the same test on the same instrument.
    expect(CODEX_BOUNDED_APPROVAL_NOTICE).not.toContain('no OS sandbox');
    expect(CODEX_UNBOUNDED_APPROVAL_NOTICE).toContain('no OS sandbox');
    // The residue P7.2 made audible survives the rewording — it is the reason a
    // line is emitted at all, and a rewrite that dropped it would be silence.
    expect(CODEX_BOUNDED_APPROVAL_NOTICE).toContain('no approval channel');
    expect(CODEX_BOUNDED_APPROVAL_NOTICE).toContain('rust-v0.150.1');
    // The two halves the drive measured, in the two directions they differ.
    expect(CODEX_BOUNDED_APPROVAL_NOTICE).toContain('raises an approval you answer');
    expect(CODEX_BOUNDED_APPROVAL_NOTICE).toContain('Operation not permitted');
    // And the residue that is stated rather than fixed, so an operator meeting a
    // write in $TMPDIR is not meeting a surprise.
    expect(CODEX_BOUNDED_APPROVAL_NOTICE).toContain('$TMPDIR');
    expect(CODEX_BOUNDED_APPROVAL_NOTICE).toContain('/tmp');
    // F1.1071 · F1.1057 took the credential floor out of the profile; what keeps a profile in every
    // session is the protected-folder floor (C3.343), so the line credits that and no credential.
    expect(CODEX_BOUNDED_APPROVAL_NOTICE).toContain('to keep .git and the other protected folders read-only');
    expect(CODEX_BOUNDED_APPROVAL_NOTICE).not.toContain('credential');
  });

  test('D1.358 · both arms carry the machine prefix the operator lift keys on', () => {
    // Without it the line reaches `debug` and nothing else, and `debug` writes
    // nothing on a packaged build. The lift itself is pinned on the agent side
    // (`codex-operator-notice-lift.test.ts`); this is the writer's half, and it
    // is structural rather than textual — both constants are BUILT from the
    // exported prefix, so a reworded sentence cannot drop it.
    expect(CODEX_BOUNDED_APPROVAL_NOTICE.startsWith(CODEX_APPROVAL_POSTURE_PREFIX)).toBe(true);
    expect(CODEX_UNBOUNDED_APPROVAL_NOTICE.startsWith(CODEX_APPROVAL_POSTURE_PREFIX)).toBe(true);
    // The prefix is a PREFIX, not the whole line, and the sentence survives it.
    expect(CODEX_BOUNDED_APPROVAL_NOTICE.slice(CODEX_APPROVAL_POSTURE_PREFIX.length))
      .toStartWith('Codex is sandboxed by its permission profile');
    expect(CODEX_UNBOUNDED_APPROVAL_NOTICE.slice(CODEX_APPROVAL_POSTURE_PREFIX.length))
      .toStartWith('Codex is running with no OS sandbox');
    // And it is one prefix for both arms, deliberately — see its docblock.
    expect(CODEX_BOUNDED_APPROVAL_NOTICE).not.toBe(CODEX_UNBOUNDED_APPROVAL_NOTICE);
  });

  test('the gate: the switch ON emits nothing, with a profile or without one', () => {
    for (const mode of ALL_MODES) {
      expect(formatCodexUnboundedApprovalDiagnostics({ ...BASE, mode, sandboxGloballyEnabled: true })).toEqual([]);
      expect(formatCodexUnboundedApprovalDiagnostics({
        ...BASE, ...REAL_FLOOR, mode, sandboxGloballyEnabled: true,
      })).toEqual([]);
    }
    // The default is ON, and a call that names no switch must not report a loss.
    expect(formatCodexUnboundedApprovalDiagnostics({ ...BASE, ...REAL_FLOOR, mode: 'default' })).toEqual([]);
  });

  test('the gate: no mode means no claim about a mode table nobody read', () => {
    expect(formatCodexUnboundedApprovalDiagnostics({ ...BASE, ...REAL_FLOOR, sandboxGloballyEnabled: false })).toEqual([]);
  });

  test('a policy conflict falls back to the unbounded line instead of throwing', () => {
    // `resolveCodexRuntimePathPolicy` throws `codex-runtime-path-policy-conflict`
    // when one path is both denied and writable; `writeCodexConfig` fails on that
    // two calls later, and a pure formatter must not be what raises it.
    const conflicted = {
      ...BASE, mode: 'default' as const, sandboxGloballyEnabled: false,
      deniedReadPaths: ['/Users/x/shared'], writablePaths: ['/Users/x/shared'],
    };
    expect(() => formatCodexUnboundedApprovalDiagnostics(conflicted)).not.toThrow();
    expect(formatCodexUnboundedApprovalDiagnostics(conflicted)).toEqual([CODEX_UNBOUNDED_APPROVAL_NOTICE]);
  });

  test('writeCodexConfig actually emits it — the sink is the whole transparency claim', () => {
    const home = mkdtempSync(join(tmpdir(), 'nessy-d1357-'));
    try {
      const real: string[] = [];
      writeCodexConfig({
        ...BASE, ...REAL_FLOOR, codexHome: home, mode: 'default',
        sandboxGloballyEnabled: false, onDiagnostic: m => real.push(m),
      });
      expect(real.filter(m => m === CODEX_BOUNDED_APPROVAL_NOTICE)).toHaveLength(1);
      expect(real.filter(m => m === CODEX_UNBOUNDED_APPROVAL_NOTICE)).toHaveLength(0);
      // D1.358 · exactly ONE line of this write is a posture line, whichever arm
      // it is. The agent lifts on the prefix, so two would be two notice slots.
      expect(real.filter(m => m.startsWith(CODEX_APPROVAL_POSTURE_PREFIX))).toHaveLength(1);

      const bare: string[] = [];
      writeCodexConfig({
        ...BASE, codexHome: home, mode: 'default',
        sandboxGloballyEnabled: false, onDiagnostic: m => bare.push(m),
      });
      expect(bare.filter(m => m === CODEX_UNBOUNDED_APPROVAL_NOTICE)).toHaveLength(1);
      expect(bare.filter(m => m === CODEX_BOUNDED_APPROVAL_NOTICE)).toHaveLength(0);
      expect(bare.filter(m => m.startsWith(CODEX_APPROVAL_POSTURE_PREFIX))).toHaveLength(1);

      const on: string[] = [];
      writeCodexConfig({
        ...BASE, ...REAL_FLOOR, codexHome: home, mode: 'default',
        sandboxGloballyEnabled: true, onDiagnostic: m => on.push(m),
      });
      expect(on.filter(m => m === CODEX_BOUNDED_APPROVAL_NOTICE || m === CODEX_UNBOUNDED_APPROVAL_NOTICE))
        .toHaveLength(0);
      // The switch-ON write emits other diagnostics — the egress line among them
      // — so this is the control that the prefix filter is reading a real list.
      expect(on.filter(m => m.startsWith(CODEX_APPROVAL_POSTURE_PREFIX))).toHaveLength(0);
      expect(on.filter(m => m.startsWith('codex-sandbox-egress-denied: '))).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
