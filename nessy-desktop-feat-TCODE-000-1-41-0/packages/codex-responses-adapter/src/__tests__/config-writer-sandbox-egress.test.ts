/**
 * P2.384 — the sandboxed-codex egress diagnostic, and the tripwire on the two
 * native switches this row measured and refused.
 *
 * The row it closes asked whether codex's own network-approval path is a
 * mechanism we merely never enabled. Measured at `rust-v0.148.0` (the tag
 * shipped when this was read) and confirmed by string probe against the bundled
 * `darwin-arm64/codex-app-server`, the answer is no in both directions, and the
 * reasoning lives in {@link formatCodexSandboxEgressDiagnostics}'s docblock:
 *
 *  - `[features] network_proxy` only RESTRICTS a session that already has
 *    network, so it is inert in the sandboxed state and a regression in the
 *    unsandboxed one;
 *  - `[features] request_permissions_tool` — the tool codex would use to ASK,
 *    whose approval this repo's bridge already answers — is
 *    `Stage::UnderDevelopment`, default off, and taxes every session with a
 *    warning notification nothing here consumes.
 *
 * So nothing is flipped, one diagnostic names the state, and THESE TESTS are
 * what stops a later lane flipping either key without meeting the measurement.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCodexConfigToml,
  codexSandboxConfigForMode,
  formatCodexSandboxEgressDiagnostics,
  writeCodexConfig,
  type CodexPermissionMode,
} from '../config-writer.ts';

const ALL_MODES: readonly CodexPermissionMode[] = [
  'dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions',
];

/** A codex home that is never written to; only interpolated into the TOML. */
const UNUSED_HOME = join(tmpdir(), 'nessy-p2384-unused');

const BASE = { codexHome: UNUSED_HOME, model: 'tgpt/qwen35-397b-a17b-fp8', adapterPort: 54321 } as const;

describe('formatCodexSandboxEgressDiagnostics — the state that misreads as DNS', () => {
  test('every mode with the sandbox switch ON gets exactly one line naming its sandbox_mode', () => {
    for (const mode of ALL_MODES) {
      const { sandbox_mode } = codexSandboxConfigForMode(mode, true);
      // Precondition, not decoration: the switch-ON column is entirely
      // restricting, so a future table edit that introduced a
      // `danger-full-access` row would otherwise silently drop this line.
      expect(sandbox_mode).not.toBe('danger-full-access');

      const lines = formatCodexSandboxEgressDiagnostics({ mode, sandboxGloballyEnabled: true });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toStartWith('codex-sandbox-egress-denied: ');
      expect(lines[0]).toContain(`sandbox_mode="${sandbox_mode}"`);
    }
  });

  test('the line names the resolver misread and both refused switches, so the reader is not sent hunting', () => {
    const [line] = formatCodexSandboxEgressDiagnostics({ mode: 'default', sandboxGloballyEnabled: true });
    expect(line).toContain('*:53');
    expect(line).toContain('name-resolution');
    expect(line).toContain('network_proxy');
    expect(line).toContain('request_permissions_tool');
    // The load-bearing halves of each refusal: one is inert because the gate
    // reads a policy that is Restricted here, the other is not shipped-ready.
    expect(line).toContain('network_sandbox_policy().is_enabled()');
    expect(line).toContain('Stage::UnderDevelopment');
  });

  test('danger-full-access with NO profile emits nothing — nothing supersedes it', () => {
    // The switch-OFF mapping, with no filesystem policy at all: the shell really
    // does have network like any process, so silence is correct. This is also
    // the NEGATIVE CONTROL for the P6.149 block below — without it, "the line
    // fires off the switch" would be equally satisfied by a formatter that
    // ignores the mode entirely.
    for (const mode of ALL_MODES) {
      expect(codexSandboxConfigForMode(mode, false).sandbox_mode).toBe('danger-full-access');
      expect(formatCodexSandboxEgressDiagnostics({ mode, sandboxGloballyEnabled: false })).toEqual([]);
    }
    expect(formatCodexSandboxEgressDiagnostics({ sandboxMode: 'danger-full-access' })).toEqual([]);
  });

  test('an explicit sandboxMode with no mode is read, and a bare call falls back to workspace-write', () => {
    expect(formatCodexSandboxEgressDiagnostics({ sandboxMode: 'read-only' })[0])
      .toContain('sandbox_mode="read-only"');
    // No mode and no sandboxMode: the writer's own default, which IS restricting,
    // so the absence of a knob must not be read as the absence of the problem.
    expect(formatCodexSandboxEgressDiagnostics({})[0]).toContain('sandbox_mode="workspace-write"');
  });

  test('writeCodexConfig actually emits it — the sink wiring is the whole transparency claim', () => {
    const home = mkdtempSync(join(tmpdir(), 'nessy-p2384-'));
    try {
      const seen: string[] = [];
      writeCodexConfig({ ...BASE, codexHome: home, mode: 'default', sandboxGloballyEnabled: true, onDiagnostic: m => seen.push(m) });
      expect(seen.filter(m => m.startsWith('codex-sandbox-egress-denied: '))).toHaveLength(1);

      const off: string[] = [];
      writeCodexConfig({ ...BASE, codexHome: home, mode: 'default', sandboxGloballyEnabled: false, onDiagnostic: m => off.push(m) });
      expect(off.filter(m => m.startsWith('codex-sandbox-egress-denied: '))).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * The tripwire. All four keys are VALID under the pinned `config-schema.json`
 * (`[features]` is `additionalProperties: false` and carries `network_proxy` and
 * `request_permissions_tool`; `suppress_unstable_features_warning` and
 * `sandbox_workspace_write.network_access` are top-level), so the schema guard
 * cannot catch a lane that adds one. Only this can.
 */
describe('P2.384 tripwire — the four page-shaped fixes stay unwritten', () => {
  const FORBIDDEN = [
    // The widening this row exists to refuse: it opens egress for every
    // sandboxed session on a runtime whose sandbox an operator turned ON.
    'network_access',
    // Inert where it is needed (its gate wants a network policy that is
    // Restricted here) and a narrowing regression where it would run.
    'network_proxy',
    // The right mechanism, but Stage::UnderDevelopment and default off; its
    // under-development warning arrives on a notification we consume nowhere.
    'request_permissions_tool',
    // Would silence that warning — and every other unstable-feature warning
    // with it — which is how an under-development feature becomes invisible.
    'suppress_unstable_features_warning',
  ] as const;

  /**
   * Positive controls on the same rig, for the same reason every absence claim
   * in this tree carries one: these two ARE emitted under `[features]`, so a
   * substring search that scored 0 for all six would be an instrument failure
   * rather than a finding.
   */
  const CONTROLS = ['multi_agent = true', 'view_image = true'] as const;

  test('no mode in either switch position emits any of them', () => {
    for (const sandboxGloballyEnabled of [true, false]) {
      for (const mode of ALL_MODES) {
        const toml = buildCodexConfigToml({ ...BASE, mode, sandboxGloballyEnabled });
        for (const control of CONTROLS) expect(toml).toContain(control);
        for (const key of FORBIDDEN) expect(toml).not.toContain(key);
      }
    }
  });
});

/**
 * P6.149 — the diagnostic was DEAD in the shipped configuration, and it is keyed
 * on the resolved policy now rather than on the mode we wrote.
 *
 * ## What was wrong
 *
 * `formatCodexSandboxEgressDiagnostics` returned `[]` for `danger-full-access`,
 * and with the sandbox master switch OFF — the shipped default since 2026-08-12
 * — `codexSandboxConfigForMode` returns exactly that for every mode. So the one
 * line that names this state was silent in the only state users are actually
 * in: the state P2.323 drove `curl: (7)` in, with loopback and
 * `https://1.1.1.1/` refused and `dscacheutil` exiting 0 empty, against a
 * 200/301/resolves control.
 *
 * ## Why the mode we write is not the policy that runs
 *
 * P3.315/P3.327, re-read rather than re-derived: with the real credential floor
 * (19 `deniedPaths` entries) `resolveCodexRuntimePathPolicy` yields 10
 * filesystem keys and 9 workspace globs, so `hasCodexFilesystemPolicy` is TRUE
 * and a `[permissions.<profile>]` block is emitted for EVERY real session — and
 * codex then resolves `workspaceWrite`, not `dangerFullAccess`. That is the
 * restricted state.
 *
 * ## WHAT EACH TEST KILLS
 *
 *  - "fires with the switch off once a profile is emitted" dies if the fix is
 *    reverted — it is the shipped state's own silence.
 *  - "names the supersession" dies if the line reports
 *    `sandbox_mode="workspace-write"` about a config whose text says
 *    `danger-full-access`: a reader who greps the file would conclude the
 *    diagnostic is lying.
 *  - "still says nothing with no profile" is the negative control, and it lives
 *    in the block above as the switch-OFF case.
 *  - "reaches the sink" dies if the emission is keyed correctly and
 *    `writeCodexConfig` drops it — the transparency claim is the sink, not the
 *    formatter.
 *  - "a profile does not resurrect it with the switch ON" guards the direction
 *    nobody would notice: the switch-ON modes are already restricting, so the
 *    profile must not make the line fire TWICE or change its subject.
 */
describe('P6.149 — the egress line is keyed on the resolved policy', () => {
  /** The shape a real session has: a credential floor to mirror. */
  const WITH_FLOOR = {
    deniedReadPaths: ['/Users/x/.nessy-agent/credentials.enc'],
    deniedReadPatterns: ['**/.env', '~/.ssh/**'],
  } as const;

  test('fires with the switch OFF once a profile is emitted', () => {
    for (const mode of ALL_MODES) {
      // Precondition: the config TEXT still says danger-full-access. The line is
      // not firing because the mode changed.
      expect(codexSandboxConfigForMode(mode, false).sandbox_mode).toBe('danger-full-access');
      const lines = formatCodexSandboxEgressDiagnostics({
        mode, sandboxGloballyEnabled: false, ...WITH_FLOOR,
      });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toStartWith('codex-sandbox-egress-denied: ');
    }
  });

  test('names the supersession, so the line does not contradict the file', () => {
    const [line] = formatCodexSandboxEgressDiagnostics({
      mode: 'default', sandboxGloballyEnabled: false, ...WITH_FLOOR,
    });
    // What runs...
    expect(line).toContain('sandbox_mode="workspace-write"');
    // ...and what the file says, with the reason the two differ.
    expect(line).toContain('config text says sandbox_mode="danger-full-access"');
    expect(line).toContain('[permissions] profile');
    expect(line).toContain('workspaceWrite');
    // And the per-session run-time half a reader should look for.
    expect(line).toContain('noteResolvedSandboxPolicy');
  });

  test('a profile does not change the line with the switch ON', () => {
    // The switch-ON modes are already restricting, so the supersession clause
    // must NOT appear: there is nothing being superseded.
    const [line] = formatCodexSandboxEgressDiagnostics({
      mode: 'default', sandboxGloballyEnabled: true, ...WITH_FLOOR,
    });
    expect(line).toContain('sandbox_mode="workspace-write"');
    expect(line).not.toContain('config text says');
  });

  test('reaches the sink in the sandbox-OFF configuration', () => {
    const home = mkdtempSync(join(tmpdir(), 'nessy-p6149-'));
    try {
      const seen: string[] = [];
      writeCodexConfig({
        ...BASE, ...WITH_FLOOR, codexHome: home, mode: 'default',
        sandboxGloballyEnabled: false, onDiagnostic: m => seen.push(m),
      });
      expect(seen.filter(m => m.startsWith('codex-sandbox-egress-denied: '))).toHaveLength(1);
      // POSITIVE CONTROL that this really is the switch-OFF configuration: the
      // config the same call wrote carries the unrestricted mode in its text.
      expect(buildCodexConfigToml({ ...BASE, ...WITH_FLOOR, mode: 'default', sandboxGloballyEnabled: false }))
        .toContain('sandbox_mode = "danger-full-access"');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
