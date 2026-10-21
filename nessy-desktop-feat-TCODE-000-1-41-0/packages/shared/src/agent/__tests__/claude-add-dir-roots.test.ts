/**
 * P6.34 — the configured additional roots reach the Claude subprocess.
 *
 * Until this row `additionalDirectories` was read by the permission gate and by
 * NOTHING else, so the runtime could touch an added root and never load from it.
 * `permissions.md` §"Additional directories grant file access, not
 * configuration" is the contract that omission broke, and it is unusually
 * specific about the seam: *"The SDK passes each entry to Claude Code as
 * `--add-dir`, so those directories behave like flag-added directories."*
 *
 * Three claims are pinned here, because each fails in a different direction:
 *  - the OPTION is built (and absent when unconfigured),
 *  - it is WIRED into the one options literal that constructs the child,
 *  - it is a CONSTRUCTION option, so a drift must respawn rather than vanish.
 *
 * The fourth — that the SDK still spends the option on `--add-dir` — is measured
 * against the shipped bundle rather than quoted from the page, because that is
 * the half a version bump can take away silently.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildClaudeAdditionalDirectoriesOptions } from '../claude-agent.ts';
import { claudeLiveSessionSignature } from '../backend/claude/live-session.ts';

/** Fixture roots. Never a real home or repository root — these are data, not paths anyone reads. */
const ROOT_A = '/fixture/add-dir/apps';
const ROOT_B = '/fixture/add-dir/lib';

function signatureOf(fields: Record<string, unknown>): string {
  return claudeLiveSessionSignature(
    { cwd: '/fixture/ws', ...fields } as unknown as Parameters<typeof claudeLiveSessionSignature>[0],
  );
}

function sdkBundleSource(): string {
  return readFileSync(require.resolve('@anthropic-ai/claude-agent-sdk'), 'utf8');
}

describe('P6.34 — configured additional directories become --add-dir roots', () => {
  it('emits the option, preserving order, as a copy', () => {
    const roots = [ROOT_A, ROOT_B];
    const options = buildClaudeAdditionalDirectoriesOptions(roots);
    expect(options).toEqual({ additionalDirectories: [ROOT_A, ROOT_B] });
    // A copy, not an alias: the resolver memoizes its array, and handing that
    // same instance to the SDK would let a later mutation reach a spawned child.
    expect((options as { additionalDirectories: string[] }).additionalDirectories).not.toBe(roots);
  });

  it('BOUNDARY — nothing configured leaves the option absent, not empty', () => {
    // `{ additionalDirectories: [] }` would be a behavioural change for every
    // install that has never touched the setting: the key would start appearing
    // in the live-session signature and in anything that diffs the option set.
    // Absent means an unconfigured install spawns exactly as it did.
    const options = buildClaudeAdditionalDirectoriesOptions([]);
    expect(options).toEqual({});
    expect('additionalDirectories' in options).toBe(false);
  });

  it('is wired into the constructed child, from the shared resolver', () => {
    // The defect this row fixes was a builder with no caller, so the wiring is
    // the load-bearing half. It must read the ONE resolver the permission gate
    // reads (`additional-directories.ts`) — a second config read here would let
    // the gate and the child disagree about which roots are granted.
    const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    expect(source).toMatch(
      /\.\.\.buildClaudeAdditionalDirectoriesOptions\(getConfiguredAdditionalDirectories\(\)\)/,
    );
  });

  it('is a CONSTRUCTION option — a changed or reordered root list respawns', () => {
    // `Query` has setters for the model, the permission mode and the MCP server
    // set, and nothing that moves a directory root (asserted mechanically
    // below). So an edit to the setting can only reach the child by respawning,
    // and a signature blind to it would leave the running child serving the old
    // roots with nothing in the log to say so.
    const base = signatureOf({});
    expect(signatureOf({ additionalDirectories: [ROOT_A] })).not.toBe(base);
    expect(signatureOf({ additionalDirectories: [ROOT_A, ROOT_B] }))
      .not.toBe(signatureOf({ additionalDirectories: [ROOT_A] }));
    // ORDER IS A DRIFT, unlike the tool lists a few keys away, which are sorted
    // because they are sets. Two added roots defining the same command name are
    // resolved by order, so a reorder changes what the child would load.
    expect(signatureOf({ additionalDirectories: [ROOT_B, ROOT_A] }))
      .not.toBe(signatureOf({ additionalDirectories: [ROOT_A, ROOT_B] }));
    // And an unchanged list is not a drift — otherwise every turn respawns.
    expect(signatureOf({ additionalDirectories: [ROOT_A, ROOT_B] }))
      .toBe(signatureOf({ additionalDirectories: [ROOT_A, ROOT_B] }));
  });

  it('THE NATIVE MECHANISM, measured on the shipped bundle rather than quoted', () => {
    // If a version bump ever stops spending this option on `--add-dir`, every
    // assertion above still passes and the feature is silently gone. The bundle
    // is the denominator for what the runtime can already do (AGENTS.md), so the
    // pin reads the argv builder itself.
    const bundle = sdkBundleSource();
    expect(bundle).toContain('--add-dir');
    expect(bundle).toContain('additionalDirectories');
    // POSITIVE CONTROL for the absence claim in the next assertion: the three
    // setters that DO exist are found by the same scan.
    for (const setter of ['setModel', 'setPermissionMode', 'setMcpServers']) {
      expect(bundle).toContain(setter);
    }
    // No live setter for a directory root, which is what makes it a
    // construction option in the signature above.
    expect(bundle).not.toContain('setAdditionalDirectories');
  });
});
