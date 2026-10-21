/**
 * The refusals whose ONLY reason is the vendored bundle's VERSION, made runnable.
 *
 * A refusal that rests on a posture is stable; a refusal that rests on "the
 * bundle we ship is older than the version that added it" stops being true on a
 * day nobody plans for — and this repository has now paid for that shape twice
 * in one wave (the goal check-in variable that scored 0 at 2.1.233 and 4 at
 * 2.1.247, and every dead reading beside it). A sentence in a docblock cannot
 * notice a lift. This file can.
 *
 * ## How a trigger works, and why it is a deliberate red
 *
 * Each entry names a capability, the version the vendor added it at, and what to
 * do when the bundle reaches it. The assertion is that the vendored bundle is
 * still BELOW that version. So while the refusal's reason holds, the case passes
 * and documents it; the moment a lift crosses the threshold, this file goes red
 * with instructions, in the same commit that did the lifting, rather than a year
 * later when someone re-reads a ledger cell.
 *
 * That is the house idiom, not an invention: `claude-auto-compact-window-env.ts`
 * pins `MEASURED_CLAUDE_CODE_VERSION` for exactly this reason and P7.1 re-ran
 * its probes when it moved. The difference is only the comparison — equality
 * there, a threshold here, because these entries do not care about intermediate
 * versions.
 *
 * ## Which self-report is read
 *
 * `claudeCodeVersion` from the SDK manifest, which AGENTS.md's own rule names as
 * one of the two self-reports (the other is the native binary's `--version`);
 * both agreed at `2.1.247` on the bundle this file was written against, measured
 * 2026-09-11, at `2.1.251` after C3.380's lift, measured 2026-09-13, and at
 * `2.1.267` after F1.255's lift, measured 2026-09-24. Grepping the binary for a dotted version is explicitly NOT a
 * reading of it — the same binary spells four versions it is not, and at 2.1.251
 * one of them (`2.1.223`) answers TWO lines for ONE occurrence.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** `-1`, `0` or `1`, comparing three dotted numeric parts. */
function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let at = 0; at < Math.max(a.length, b.length); at++) {
    const difference = (a[at] ?? 0) - (b[at] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function vendoredClaudeCodeVersion(): string {
  const manifest = JSON.parse(readFileSync(
    fileURLToPath(new URL('../../../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url)),
    'utf8',
  )) as { claudeCodeVersion?: string };
  expect(manifest.claudeCodeVersion, 'the SDK manifest publishes no claudeCodeVersion').toBeDefined();
  return manifest.claudeCodeVersion!;
}

interface VersionTrigger {
  /** The ledger row this refusal is recorded on. */
  readonly row: string;
  /** The first vendored version at which the refusal's reason stops being true. */
  readonly addedAt: string;
  /** What the vendor added, in the page's own words. */
  readonly page: string;
  /** What the next lane does when this case goes red. */
  readonly onLift: string;
  /**
   * Set on the lift that CROSSED `addedAt`, and only then. It flips the entry
   * from a tripwire ("we are still below") into a record ("we crossed on this
   * date, and here is what is still owed"), because the two states need
   * different assertions and a tripwire that has fired cannot be left red.
   *
   * A fired entry is not a pass. It asserts the OPPOSITE inequality — the
   * bundle really is at or past the version this record claims — so a botched
   * downgrade reddens it, and the owed work is carried in the message where the
   * runner prints it rather than in a comment nothing reads. The entry is
   * removed only when `owed` is empty, which is what the ORIGINAL instruction
   * ("remove this entry when the work is done") meant.
   */
  readonly firedAt?: { readonly on: string; readonly at: string; readonly owed: string };
}

const TRIGGERS: readonly VersionTrigger[] = Object.freeze([
  {
    row: 'A49',
    addedAt: '2.1.251',
    // `errors.md#refusing-after-a-symlink-changed`, verbatim (fetched 2026-09-11,
    // HTTP 200): "Before v2.1.251, Claude Code re-checked a path's resolution
    // only for file writes, so a link replaced after the permission check could
    // redirect a read or search to a different location without a message. Of
    // these refusals, only the parent-directory write refusal appears on earlier
    // versions."
    page: 'the symlink re-check between the permission decision and the file operation, on the READ and SEARCH paths',
    onLift: 'C4.2 (owner answer QA9=C, 2026-09-11): the host writes no code for this — the SDK'
      + ' performs the file operation and therefore owns the re-check. Drive the swapped-link rig'
      + ' (one allowed directory holding a link to a denied path, the link replaced between the'
      + ' permission decision and the open; control = the parent-directory write refusal, which'
      + ' the page says works on earlier versions), then re-stamp ledger row A49 on the claude'
      + ' column from n/a to what the rig measured. Pi and codex stay refused: our gate hands an'
      + ' approved path to the runtime\'s own file tools, and a host-side re-check would be a'
      + ' second resolver rather than a fix.',
    firedAt: {
      on: '2026-09-13',
      at: '2.1.251',
      owed: 'The RIG measurement and the ledger cell. C3.380 lifted the bundle 0.3.247 -> 0.3.251'
        + ' (both self-reports 2.1.247 -> 2.1.251) and that is exactly the version this trigger'
        + ' names, so the refusal\'s only reason is gone. The host still writes no code (QA9=C).'
        + ' What is owed: drive the swapped-link rig described in `onLift` above against a build'
        + ' carrying 2.1.251, then re-stamp ledger row A49 on the claude column from `n/a` to'
        + ' what the rig measured. The lift lane could not drive it — a packaged build is the'
        + ' controller\'s — and it did not guess the outcome. CORROBORATION, measured on the same'
        + ' lift and worth reading beside it: the sibling clause in'
        + ' `claude-denied-path-search-results-e2e.test.ts` (P3.174, the search-results exclusion)'
        + ' went from refuted to PERFORMED across this same bump, on the same READ/SEARCH paths.'
        + ' Two independent readings that 2.1.251 is where path enforcement reached those paths.',
    },
  },
]);

describe('the vendored bundle has not yet crossed a refusal\'s version trigger', () => {
  for (const trigger of TRIGGERS.filter((entry) => entry.firedAt === undefined)) {
    it(`${trigger.row} — still below v${trigger.addedAt}, so its refusal still holds`, () => {
      const vendored = vendoredClaudeCodeVersion();
      expect(
        compareVersions(vendored, trigger.addedAt) < 0,
        `THE TRIGGER FIRED. The vendored bundle is ${vendored}, at or past v${trigger.addedAt},`
        + ` which is where the vendor added ${trigger.page}. Ledger row ${trigger.row} is refused`
        + ` ONLY because the bundle was older, so that reason no longer holds. ${trigger.onLift}`
        + ' Record the firing by giving the entry a `firedAt`, which moves it to the block below'
        + ' and carries the owed work; remove the entry only once nothing is owed — a trigger that'
        + ' has fired and been answered is not a pin, and leaving it red teaches the next lane to'
        + ' skip the file.',
      ).toBe(true);
    });
  }

  /**
   * The other half of the same instrument: an entry whose trigger HAS fired.
   *
   * It asserts the opposite inequality, so it is not a pass by omission — a
   * downgrade below the recorded threshold reddens it, and the owed work is in
   * the compared VALUE so the runner prints it to whoever meets the failure.
   */
  for (const trigger of TRIGGERS.filter((entry) => entry.firedAt !== undefined)) {
    it(`${trigger.row} — FIRED on ${trigger.firedAt!.on} at v${trigger.firedAt!.at}, and this is what is still owed`, () => {
      const vendored = vendoredClaudeCodeVersion();
      expect(
        { row: trigger.row, atOrPast: compareVersions(vendored, trigger.addedAt) >= 0, owed: trigger.firedAt!.owed },
        `THE RECORD DISAGREES WITH THE BUNDLE. This entry records that the trigger fired at`
        + ` v${trigger.firedAt!.at}, but the vendored bundle now reports ${vendored}, which is BELOW`
        + ` v${trigger.addedAt}. Either the bundle was rolled back — in which case ${trigger.row}'s`
        + ' refusal is live again and this entry loses its `firedAt` — or the self-report moved and'
        + ' the record has to be re-taken.',
      ).toEqual({ row: trigger.row, atOrPast: true, owed: trigger.firedAt!.owed });
    });
  }

  /**
   * The comparator, pinned on literals in both directions.
   *
   * Without this the suite is vacuous the day `compareVersions` returns `-1` for
   * everything: every entry above would pass, for ever, and the file would read
   * as a working instrument. It is the same discipline the classifier controls
   * in `numeric-setting.test.ts` keep.
   */
  it('compares versions numerically, not as strings — the control', () => {
    expect(compareVersions('2.1.247', '2.1.251')).toBe(-1);
    expect(compareVersions('2.1.251', '2.1.251')).toBe(0);
    expect(compareVersions('2.1.259', '2.1.251')).toBe(1);
    // The string comparison this must not be: `'2.1.9' > '2.1.10'` lexically.
    expect(compareVersions('2.1.9', '2.1.10')).toBe(-1);
    // A shorter left side is not automatically smaller.
    expect(compareVersions('3', '2.9.9')).toBe(1);
  });

  /** Every entry names a row and a page sentence, so a red is actionable. */
  it('carries no entry without its row, its version and its instructions', () => {
    expect(TRIGGERS.length).toBeGreaterThan(0);
    for (const trigger of TRIGGERS) {
      expect(trigger.row, JSON.stringify(trigger)).toMatch(/^[A-Z]\d+$/);
      expect(trigger.addedAt, trigger.row).toMatch(/^\d+\.\d+\.\d+$/);
      expect(trigger.onLift.length, trigger.row).toBeGreaterThan(80);
    }
  });
});
