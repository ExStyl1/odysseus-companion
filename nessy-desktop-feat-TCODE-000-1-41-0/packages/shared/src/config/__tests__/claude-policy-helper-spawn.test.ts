/**
 * P6.73 — does the vendored SDK SPAWN an administrator-placed `policyHelper`?
 *
 * **The answer this row can honestly give is: not measurable by this route, and
 * the reason is measured rather than guessed.** The full table, the arms and the
 * two controls that settle it live in
 * `fixtures/claude-policy-helper-probe.ts`; this file pins the two halves that
 * outlast the run — that the key is REAL in the artefacts we ship, and that the
 * delivery channel the row's rig depends on is DEAD.
 *
 * Recording *"no helper spawned"* would have been a false negative. The row's own
 * control (d) — *"FIRST a positive control that a plain managed key delivered
 * through the env var applies at all, since a directory-vs-file mismatch would
 * otherwise read as 'not spawned'"* — is exactly what caught it, and it caught it
 * twice over: with the managed `env` block as the ONLY source of
 * `ANTHROPIC_BASE_URL` the child reached no stub at all and asked for a login,
 * under BOTH spellings and with `settingSources` empty and loaded; and a
 * managed-settings document that is not JSON produced no diagnostic, although
 * `managed-settings.md#invalid-entries-in-managed-settings` documents that Claude
 * Code reports invalid entries.
 *
 * What that leaves standing, and it is the part worth keeping: on an SDK-spawned
 * child, a `managed-settings.json` reached through
 * `CLAUDE_CODE_MANAGED_SETTINGS_PATH` has NO effect — neither a helper nor a
 * plain key. Whether the binary reads its real administrator locations is a
 * different question on a different rig; those are system paths and this probe
 * deliberately does not write them.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  runPolicyHelperArm,
  vendoredClaudeBinary,
  vendoredVersions,
} from './fixtures/claude-policy-helper-probe.ts';

const BINARY = vendoredClaudeBinary();
const VERSIONS = vendoredVersions();

const inBinary = (needle: string): boolean =>
  Bun.spawnSync(['grep', '-a', '-q', '-F', '-e', needle, BINARY!]).exitCode === 0;

const repoFile = (relative: string): string =>
  fileURLToPath(new URL(`../../../../../${relative}`, import.meta.url));

describe('P6.73 · the key is real in both artefacts we ship', () => {
  it('the vendored sdk.mjs declares policyHelper, with the describe that scopes it', () => {
    const sdk = readFileSync(
      repoFile('node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'),
      'utf8',
    );
    expect(sdk).toContain('policyHelper=');
    // The scope sentence is the reason this is an ADMINISTRATOR question and not
    // a configuration one: nothing we pass programmatically can reach it.
    expect(sdk).toContain(
      'Executable that computes managed settings at startup. Honored only from admin-controlled policy sources.',
    );
  }, 60_000);

  it.skipIf(BINARY === null || !existsSync(BINARY))(
    'the native binary carries the key, the filename, the two admin roots and the env var',
    () => {
      for (const marker of [
        'policyHelper',
        'managed-settings.json',
        '/Library/Application Support/ClaudeCode',
        '/etc/claude-code',
        'CLAUDE_CODE_MANAGED_SETTINGS_PATH',
      ]) {
        expect(inBinary(marker), `${marker} missing from the vendored binary`).toBe(true);
      }
      // ZERO CONTROL on the identical instrument.
      expect(inBinary('zzNotAPolicyKeyP6073')).toBe(false);
    },
    180_000,
  );

  it('we neither configure the helper nor suppress it', () => {
    const managed = readFileSync(repoFile('packages/shared/src/agent/claude-managed-settings.ts'), 'utf8');
    // If a lane ever starts setting it, this fails and the decision has to be
    // recorded rather than slipped in — the shape P3.352 uses for
    // `skipWebFetchPreflight`.
    expect(/policyHelper\s*:/.test(managed)).toBe(false);
    // POSITIVE CONTROL on the same read: this IS the file that builds our floor.
    expect(managed).toContain('managedSettings');
  }, 60_000);
});

/**
 * The RUN half. A recorded local run, not a CI gate — the same posture as the
 * sibling `claude-*-e2e` suites — so it is opt-in through `NESSY_CLAUDE_SDK_E2E=1`.
 */
const E2E = process.env.NESSY_CLAUDE_SDK_E2E === '1' && BINARY !== null && VERSIONS !== null;

describe('P6.73 · the delivery channel this rig depends on is dead', () => {
  it.skipIf(!E2E)(
    'a managed env block that is the ONLY source of the base URL never arrives',
    async () => {
      const outcome = await runPolicyHelperArm('managed-supplies-baseurl');
      // Neither stub was reached at all: the child fell through to real auth.
      expect(outcome.requestsA).toBe(0);
      expect(outcome.requestsB).toBe(0);
      expect(outcome.detail).toContain('Not logged in');
    },
    240_000,
  );

  it.skipIf(!E2E)(
    'and the same is true when the env var names the FILE rather than its directory',
    async () => {
      const outcome = await runPolicyHelperArm('managed-supplies-baseurl-file');
      expect(outcome.requestsA).toBe(0);
      expect(outcome.detail).toContain('Not logged in');
    },
    240_000,
  );

  it.skipIf(!E2E)(
    'a managed document that is not JSON draws no complaint, so the path is never opened',
    async () => {
      const outcome = await runPolicyHelperArm('managed-unparseable');
      // The SECOND independent control. Identical to the baseline in every
      // respect — a file the child had read and rejected would not be.
      expect(outcome.requestsA).toBe(1);
      expect(outcome.detail).toContain('"is_error":false');
      expect(outcome.userAgent).toContain(`claude-cli/${VERSIONS!.cli}`);
    },
    240_000,
  );

  it.skipIf(!E2E)(
    'so the helper marker being absent proves nothing, and is recorded as such',
    async () => {
      const outcome = await runPolicyHelperArm('helper');
      // The observation itself: no marker, and the turn behaved exactly as the
      // baseline did. Asserted so the run is on the record — NOT as evidence
      // that the SDK declines to spawn an administrator's helper, which the two
      // controls above forbid concluding.
      expect(outcome.markerWritten).toBe(false);
      expect(outcome.requestsA).toBe(1);
      expect(outcome.requestsB).toBe(0);
    },
    240_000,
  );
});
