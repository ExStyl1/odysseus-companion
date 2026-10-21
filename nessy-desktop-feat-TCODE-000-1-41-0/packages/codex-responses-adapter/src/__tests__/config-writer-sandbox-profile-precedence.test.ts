/**
 * C3.10 (ledger A20) — the permission PROFILE wins in BOTH master-switch
 * positions, so turning the host sandbox off does not turn codex's sandbox off.
 *
 * ## The fact this pins, and why it needed its own file
 *
 * `resolve_permission_config_syntax` (`core/src/config/mod.rs`, `rust-v0.148.0`,
 * re-shipped at `rust-v0.150.1`) sets `Legacy` from `sandbox_mode` and then
 * sets `Profiles` from `default_permissions` UNCONDITIONALLY, so inside one
 * config layer the profile wins and `sandbox_mode` is read in no branch the
 * `Profiles` arm can reach. P3.315 drove that on the bundled binary with two
 * controls (`ThreadStartResponse.sandbox`: our shipped `danger-full-access` +
 * profile shape resolves `workspaceWrite`; the same mode ALONE resolves
 * `dangerFullAccess`).
 *
 * What no test pinned is the HOST half that makes the supersession
 * unconditional: this writer emits the profile in BOTH positions of the sandbox
 * master switch, because the credential-deny floor lives in it. So a user who
 * turns process isolation off still gets a `workspaceWrite` sandbox on codex —
 * and sees it named at that control (`settings.permissions.isolationDisabled`)
 * and, per session, through `CodexAgent.noteResolvedSandboxPolicy`.
 *
 * ## The half this file MEASURED rather than restated (C3.10, 2026-09-11)
 *
 * The row was written expecting the emitted profile to be byte-identical in
 * both switch positions. It is not, for three of the seven modes, and the
 * difference runs the surprising way: the profile's parent is derived from the
 * RESOLVED sandbox mode, and off the switch that mode is `danger-full-access`
 * for every mode — so `dontAsk`, `explore` and `plan` moved from a `:read-only`
 * parent to a `:workspace` one. Turning host isolation off therefore did not
 * take codex's sandbox away in those three modes; it WIDENED it from read-only
 * to workspace-write. Pinned below with the other four modes as the control.
 *
 * F1.787 (owner decision 2026-09-26, option B) reversed that for `explore` and
 * `plan`: they keep the `:read-only` parent in both switch positions, so the
 * widening now applies to `dontAsk` alone.
 *
 * `config-writer.test.ts` §"the T1 sandboxGloballyEnabled master switch" pins
 * what the switch DOES change (`sandbox_mode`, `approval_policy`). This file
 * pins what it does NOT, which is the half the user was never told about.
 *
 * ## The control that makes it a reading
 *
 * With no denied path, no denied pattern and no writable path there is no
 * filesystem policy, `hasCodexFilesystemPolicy` is false, and NO profile is
 * emitted in either position. Without that arm every assertion below would also
 * pass against a writer that emitted the profile unconditionally for reasons
 * having nothing to do with the floor.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildCodexConfigToml,
  buildCodexRuntimeConfigOverride,
  CODEX_BOUNDED_APPROVAL_NOTICE,
  CODEX_READ_ONLY_PROFILE_APPROVAL_NOTICE,
  codexSandboxConfigForMode,
  formatCodexSandboxEgressDiagnostics,
  formatCodexUnboundedApprovalDiagnostics,
  type CodexPermissionMode,
} from '../config-writer.ts';

const ALL_MODES: CodexPermissionMode[] = [
  'dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions',
];

const BASE = {
  codexHome: '/tmp/w16g-codex-home',
  model: 'tgpt/qwen35-397b-a17b-fp8',
  adapterPort: 54321,
} as const;

/** The shipped shape: the credential floor is what makes a profile unconditional. */
const WITH_FLOOR = { ...BASE, deniedReadPaths: ['/private/nessy/credentials.enc'] } as const;

describe('C3.10 — the permission profile supersedes the sandbox master switch', () => {
  test('every mode emits the profile with the switch ON and with the switch OFF', () => {
    for (const mode of ALL_MODES) {
      for (const sandboxGloballyEnabled of [true, false]) {
        const toml = buildCodexConfigToml({ ...WITH_FLOOR, mode, sandboxGloballyEnabled });
        expect(toml).toContain('default_permissions = "nessy_runtime"');
        expect(toml).toContain('[permissions.nessy_runtime]');
        expect(toml).toContain('"/private/nessy/credentials.enc" = "deny"');
      }
    }
  });

  test('with the switch OFF the two keys DISAGREE in EVERY mode, and the profile is the one that binds', () => {
    for (const mode of ALL_MODES) {
      const off = buildCodexConfigToml({ ...WITH_FLOOR, mode, sandboxGloballyEnabled: false });
      // The text the user's switch produced...
      expect(off).toContain('sandbox_mode = "danger-full-access"');
      expect(codexSandboxConfigForMode(mode, false).sandbox_mode).toBe('danger-full-access');
      // ...beside the profile that supersedes it. Off the switch the parent is
      // `:workspace` for the four writing modes — derived from the resolved
      // sandbox mode, which off the switch is `danger-full-access` for every one
      // of them — and `:read-only` for `plan` (F1.787) and `dontAsk` (F1.1056).
      // Either parent is what makes the resolved policy a sandbox rather than `dangerFullAccess`.
      expect(off).toContain('default_permissions = "nessy_runtime"');
      expect(off).toContain(mode === 'plan' || mode === 'dontAsk' ? 'extends = ":read-only"' : 'extends = ":workspace"');
    }
  });

  test('F1.787: plan keeps the :read-only parent with the switch OFF, and keeps every other key', () => {
    const opts = {
      ...WITH_FLOOR,
      writablePaths: ['/Users/x/added-root'],
      deniedReadPatterns: ['~/.ssh/**'],
      protectedWorkspaceSubpaths: ['.git'],
    };
    for (const mode of ['plan'] as CodexPermissionMode[]) {
      const off = buildCodexConfigToml({ ...opts, mode, sandboxGloballyEnabled: false });
      const on = buildCodexConfigToml({ ...opts, mode, sandboxGloballyEnabled: true });
      expect(off).toContain('sandbox_mode = "danger-full-access"');
      expect(off).toContain('extends = ":read-only"');
      expect(off).not.toContain('extends = ":workspace"');
      // The grant, the floor and the scoped table ride on the new parent: the
      // profile is byte-identical to the switch-ON one.
      const profileOf = (toml: string): string => toml.slice(toml.indexOf('[permissions.nessy_runtime]'));
      expect(profileOf(off)).toContain('"/Users/x/added-root" = "write"');
      expect(profileOf(off)).toEqual(profileOf(on));
      // And the per-thread override a mid-chat mode switch re-forks on says the same.
      const override = buildCodexRuntimeConfigOverride({ ...opts, mode, sandboxGloballyEnabled: false }) as {
        permissions?: Record<string, { extends?: string }>;
      };
      expect(override.permissions?.nessy_runtime?.extends).toBe(':read-only');
    }
  });

  test('F1.787 / F1.1056 boundary: the four writing modes keep :workspace with the switch OFF', () => {
    for (const mode of ['default', 'acceptEdits', 'auto', 'bypassPermissions'] as CodexPermissionMode[]) {
      const off = buildCodexConfigToml({ ...WITH_FLOOR, mode, sandboxGloballyEnabled: false });
      expect(off).toContain('extends = ":workspace"');
      expect(off).not.toContain('extends = ":read-only"');
      const override = buildCodexRuntimeConfigOverride({ ...WITH_FLOOR, mode, sandboxGloballyEnabled: false }) as {
        permissions?: Record<string, { extends?: string }>;
      };
      expect(override.permissions?.nessy_runtime?.extends).toBe(':workspace');
    }
    // No mode at all (an explicit sandboxMode caller) is unchanged too.
    expect(buildCodexConfigToml({ ...WITH_FLOOR, sandboxMode: 'danger-full-access' })).toContain('extends = ":workspace"');
  });

  test('F1.1056: dontAsk keeps the :read-only parent in BOTH switch positions — the C3.10 widening is closed', () => {
    // C3.10 (W16-g) recorded the finer fact a user would least expect: with the
    // switch ON `dontAsk` emits a profile extending `:read-only`; with it OFF it
    // extended `:workspace`, so turning host process isolation off moved the
    // mode that denies whatever would prompt onto a workspace-write sandbox, and
    // an in-workspace write landed with no approval. F1.787 closed the same
    // widening for `plan`; F1.1056 closes it for `dontAsk` with the same mechanism.
    for (const sandboxGloballyEnabled of [true, false]) {
      const toml = buildCodexConfigToml({ ...WITH_FLOOR, mode: 'dontAsk', sandboxGloballyEnabled });
      expect(toml).toContain('extends = ":read-only"');
      expect(toml).not.toContain('extends = ":workspace"');
      const override = buildCodexRuntimeConfigOverride({ ...WITH_FLOOR, mode: 'dontAsk', sandboxGloballyEnabled }) as {
        permissions?: Record<string, { extends?: string }>;
      };
      expect(override.permissions?.nessy_runtime?.extends).toBe(':read-only');
    }
    const offOpts = { ...WITH_FLOOR, mode: 'dontAsk' as const, sandboxGloballyEnabled: false };
    expect(formatCodexUnboundedApprovalDiagnostics(offOpts)).toEqual([CODEX_READ_ONLY_PROFILE_APPROVAL_NOTICE]);
    expect(formatCodexSandboxEgressDiagnostics(offOpts)[0]).toContain('codex resolves readOnly');
    // CONTROL: for all six the emitted profile is now byte-identical in both
    // switch positions — the property C3.10 found missing for dontAsk alone.
    for (const mode of ALL_MODES) {
      const profileOf = (toml: string): string => toml.slice(toml.indexOf('[permissions.nessy_runtime]'));
      expect(profileOf(buildCodexConfigToml({ ...WITH_FLOOR, mode, sandboxGloballyEnabled: false })))
        .toEqual(profileOf(buildCodexConfigToml({ ...WITH_FLOOR, mode, sandboxGloballyEnabled: true })));
    }
  });

  test('F1.787: the posture and egress lines name the read-only parent in plan, the workspace one otherwise', () => {
    for (const mode of ['plan'] as CodexPermissionMode[]) {
      const opts = { ...WITH_FLOOR, mode, sandboxGloballyEnabled: false };
      expect(formatCodexUnboundedApprovalDiagnostics(opts)).toEqual([CODEX_READ_ONLY_PROFILE_APPROVAL_NOTICE]);
      const [egress] = formatCodexSandboxEgressDiagnostics(opts);
      expect(egress).toContain('sandbox_mode="read-only"');
      expect(egress).toContain('codex resolves readOnly');
    }
    expect(CODEX_READ_ONLY_PROFILE_APPROVAL_NOTICE).toContain('extends = ":read-only"');
    expect(CODEX_READ_ONLY_PROFILE_APPROVAL_NOTICE).not.toContain(':workspace');
    // F1.1179 · F1.1003 gives this session's plans and data folders `write` keys in Plan only
    // (`codexModeWritablePaths`; Don't ask gets the added roots alone), so the lifted line names
    // them and scopes them to Plan, while a project write is still refused.
    expect(CODEX_READ_ONLY_PROFILE_APPROVAL_NOTICE).toContain("in Plan so do this session's plans and data folders");
    expect(CODEX_READ_ONLY_PROFILE_APPROVAL_NOTICE).toContain('a shell command that writes a file is refused by the OS');
    // CONTROL: a writing mode keeps the workspace line on the same instrument.
    const opts = { ...WITH_FLOOR, mode: 'default' as const, sandboxGloballyEnabled: false };
    expect(formatCodexUnboundedApprovalDiagnostics(opts)).toEqual([CODEX_BOUNDED_APPROVAL_NOTICE]);
    expect(formatCodexSandboxEgressDiagnostics(opts)[0]).toContain('codex resolves workspaceWrite');
  });

  test('CONTROL: with no filesystem policy at all, NO profile is emitted in either position', () => {
    // Kills the tautology reading of every case above: the profile is emitted
    // because the floor puts something in it, not unconditionally by construction.
    for (const mode of ALL_MODES) {
      for (const sandboxGloballyEnabled of [true, false]) {
        const toml = buildCodexConfigToml({ ...BASE, mode, sandboxGloballyEnabled });
        expect(toml).not.toContain('default_permissions =');
        expect(toml).not.toContain('[permissions.nessy_runtime]');
      }
    }
  });
});
