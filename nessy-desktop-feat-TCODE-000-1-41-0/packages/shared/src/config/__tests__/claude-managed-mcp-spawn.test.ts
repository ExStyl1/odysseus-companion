/**
 * P6.72, claude arm — a managed MCP denial DOES stop the spawn, on every entry
 * point the child has.
 *
 * ## The result, measured 2026-09-05 on the vendored 2.1.233 / agent-sdk 0.3.233
 *
 * Seven arms, each a real child against a stub upstream, each with the child's
 * own `user-agent` checked against the vendored `package.json` before any
 * verdict was believed. The observable is a marker file the MCP fixture writes
 * the instant it starts — host-side execution, not a server map.
 *
 * | arm | marker | what it settles |
 * | --- | --- | --- |
 * | `programmatic-no-policy` | **yes** | POSITIVE CONTROL — the rig can spawn |
 * | `programmatic-denied-by-name` | no | a `serverName` denial stops the spawn |
 * | `programmatic-denied-by-command` | no | so does a denial by exact spawn argv |
 * | `programmatic-denied-elsewhere` | **yes** | NEGATIVE CONTROL — a denial aimed elsewhere does not |
 * | `programmatic-allow-managed-only` | no | **F69.1 answered** |
 * | `discovered-no-policy` | **yes** | the `.mcp.json` channel works at all |
 * | `discovered-denied-by-name` | no | done_means control (b) |
 *
 * **F69.1 is answered in the affirmative**: `allowManagedMcpServersOnly: true`
 * with an `allowedMcpServers` list that does not name the server withholds a
 * server supplied through the SDK's own programmatic `mcpServers` option. That
 * disambiguates the type-surface sentence beside it (`sdk.d.ts:5716`, *"Users
 * can still add their own MCP servers, but only the admin-defined allowlist
 * applies"*) — you may add one; it does not run.
 *
 * ## Why the policy is delivered as `Options.managedSettings`
 *
 * Because that is the channel this product uses, and because the other one is
 * dead: P6.73 measured `CLAUDE_CODE_MANAGED_SETTINGS_PATH` inert on an
 * SDK-spawned child under both spellings. A rig delivering the policy that way
 * would have measured the channel rather than the gate, and would have recorded
 * "no spawn" for the wrong reason on every arm — including the controls.
 *
 * ## What this does NOT claim
 *
 * Nothing here is about our own host gate. `applyManagedMcpPolicy` decides which
 * servers we HAND a runtime; this is about what the vendored child does with one
 * it has already been handed. The two are independent and both are needed — the
 * codex half of this row is pinned in
 * `mcp/__tests__/managed-denied-builtin-mcp-spawn.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  runManagedMcpArm,
  vendoredClaudeBinary,
  vendoredVersions,
} from './fixtures/claude-managed-mcp-spawn-probe.ts';

const BINARY = vendoredClaudeBinary();
const VERSIONS = vendoredVersions();

const repoFile = (relative: string): string =>
  fileURLToPath(new URL(`../../../../../${relative}`, import.meta.url));

describe('P6.72 · the projection this rig measures is the one we ship', () => {
  it('our managed floor reaches the SDK as `managedSettings`, with `deniedMcpServers` copied verbatim', () => {
    const managed = readFileSync(repoFile('packages/shared/src/agent/claude-managed-settings.ts'), 'utf8');
    // The channel.
    expect(managed).toContain('managedSettings');
    // The key, and the fact that it is a COPY: a translation here would make
    // the probe a statement about our mapper rather than about the child.
    expect(managed).toContain('settings.deniedMcpServers = policy.deniedMcpServers.map');
    // ZERO CONTROL on the identical instrument.
    expect(managed).not.toContain('zzNotAManagedKeyP6072');
  }, 60_000);

  it('the SDK declares both keys, so the arms below aim at a real surface', () => {
    const dts = readFileSync(
      repoFile('node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts'),
      'utf8',
    );
    expect(dts).toContain('managedSettings?: Settings;');
    expect(dts).toContain('deniedMcpServers?: {');
    expect(dts).toContain('allowManagedMcpServersOnly?: boolean;');
    // NEGATIVE CONTROL on the identical instrument.
    expect(dts).not.toContain('zzNotAnSdkSettingP6072');
  }, 60_000);
});

/**
 * The RUN half — a recorded local run rather than a CI gate, the same posture as
 * the sibling `claude-*` e2e suites, so it is opt-in through
 * `NESSY_CLAUDE_SDK_E2E=1`.
 */
const E2E = process.env.NESSY_CLAUDE_SDK_E2E === '1' && BINARY !== null && existsSync(BINARY)
  && VERSIONS !== null;

describe('P6.72 · a managed denial stops the SPAWN inside the claude child', () => {
  it.skipIf(!E2E)(
    'POSITIVE CONTROL: with no policy tier the programmatic server RUNS',
    async () => {
      const outcome = await runManagedMcpArm('programmatic-no-policy');
      expect(outcome.markerWritten).toBe(true);
      // Provenance before anything else is believed: a sibling rig in this tree
      // once measured an SDK version this repo does not ship.
      expect(outcome.userAgent).toContain(`claude-cli/${VERSIONS!.cli}`);
      expect(outcome.userAgent).toContain(`agent-sdk/${VERSIONS!.sdk}`);
      // The turn really ran, so "no marker" in a later arm is about the server.
      expect(outcome.requests).toBe(1);
    },
    240_000,
  );

  it.skipIf(!E2E)(
    'a `serverName` denial withholds a server supplied through the programmatic option',
    async () => {
      const outcome = await runManagedMcpArm('programmatic-denied-by-name');
      expect(outcome.markerWritten).toBe(false);
      // The turn still completed — the denial is not a turn failure, which is
      // the same posture our own host gate takes.
      expect(outcome.requests).toBe(1);
      expect(outcome.detail).toContain('"is_error":false');
    },
    240_000,
  );

  it.skipIf(!E2E)(
    'so does a denial written as the exact spawn argv',
    async () => {
      const outcome = await runManagedMcpArm('programmatic-denied-by-command');
      expect(outcome.markerWritten).toBe(false);
      expect(outcome.requests).toBe(1);
    },
    240_000,
  );

  it.skipIf(!E2E)(
    'NEGATIVE CONTROL: a denial aimed at a different server leaves this one running',
    async () => {
      const outcome = await runManagedMcpArm('programmatic-denied-elsewhere');
      // Same policy SHAPE, different subject. Without this arm, "no marker"
      // could mean the child refuses every server once a policy tier exists.
      expect(outcome.markerWritten).toBe(true);
      expect(outcome.requests).toBe(1);
    },
    240_000,
  );

  it.skipIf(!E2E)(
    'F69.1 — allowManagedMcpServersOnly DOES govern a programmatically-supplied server',
    async () => {
      const outcome = await runManagedMcpArm('programmatic-allow-managed-only');
      // No denylist entry names it at all: the allowlist alone withholds it.
      expect(outcome.markerWritten).toBe(false);
      expect(outcome.requests).toBe(1);
    },
    240_000,
  );

  it.skipIf(!E2E)(
    'the discovery channel works, and the same denial withholds a discovered server too',
    async () => {
      // done_means control (b), with its own positive control first: a project
      // `.mcp.json` under `settingSources: ['project']` spawns when nothing
      // denies it, and does not when the same managed entry does.
      const control = await runManagedMcpArm('discovered-no-policy');
      expect(control.markerWritten).toBe(true);
      const denied = await runManagedMcpArm('discovered-denied-by-name');
      expect(denied.markerWritten).toBe(false);
      expect(denied.requests).toBe(1);
    },
    360_000,
  );
});
