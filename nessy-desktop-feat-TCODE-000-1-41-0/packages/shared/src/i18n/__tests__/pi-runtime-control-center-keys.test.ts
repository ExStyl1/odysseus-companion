/**
 * The `chat.piRuntime.*` and `chat.piAgentView.*` namespaces are GONE, and must
 * stay gone (P2.364, then P2.478 — and P4.7 is why the second one could go).
 *
 * `PiRuntimeControlCenter.tsx` was a right-sidebar section that rendered the
 * whole Pi runtime snapshot — manifest hash, permission mode, `security.risk`,
 * isolation profiles, filesystem scope, receipts, checkpoints — labelled by 48
 * `chat.piRuntime.*` keys. `de5481f9` removed its only mount (SessionFilesSection's
 * Info popover) once the unified MCP panel replaced its surfaces, and `79eb19879`
 * (2026-07-31, *"chore(cleanup): drop the unmounted PiAgentView and
 * PiRuntimeControlCenter"*) deleted the component.
 *
 * The keys were not deleted with it. They sat in both locales for a month,
 * translated, parity-checked and **shipped in the renderer bundle** — 96 string
 * literals (48 keys × 2 locales) reaching every user for a surface that no
 * longer existed. P2.364 removed them. This is the gate that makes the removal
 * hold, because neither i18n gate can see it: `lint:i18n:parity` and
 * `lint:i18n:sorted` compare the locales to each other, and two files that are
 * equally wrong are in parity — the same hole `mcp-servers-panel-keys.test.ts`
 * documents from the other direction.
 *
 * ## The second namespace, and the owner ruling that released it (P2.478 / P4.7)
 *
 * The SAME 2026-07-31 commit deleted `PiAgentView` and left 15
 * `chat.piAgentView.*` keys behind, in both locales, with zero consumers.
 * P2.364 deliberately left them alone, and the reason is the thing to read
 * before touching this file: an unstarted plan row (P4.7) described building a
 * **Pi runtime inspector** that would CONSUME those keys, so deleting them and
 * re-authoring them later was the worst available move.
 *
 * **OWNER RULING 2026-09-01 — the inspector will NOT be built, and the posture
 * is DECLINED rather than missing.** The two are different states and only one
 * of them invites a future lane to build it. The reasoning, kept here because
 * this file is where a reader who wants to re-add one of these keys lands:
 * the inspector was specified as **Pi-only by construction** — its runtime
 * snapshot answers *provider-not-pi* for the other two runtimes — so shipping it
 * would have manufactured a NEW divergence inside the wave whose whole purpose
 * is closing them. A panel present on one runtime of three reads to a user as
 * *claude is worse*. The owner chose an honest zero over a Pi-only one, and
 * P2.478 then deleted the 15 keys by the same measured method that removed the
 * other 48.
 *
 * So: reviving either panel is a product decision that now has an owner ruling
 * against it, not a translation. If someone takes that decision anyway, this
 * file is where they will land, and the history above is what they need before
 * re-adding a key.
 *
 * ## What is NOT dead, and the trap that makes this deletion class go wrong
 *
 * The WIRE block those keys described is a separate question and is NOT dead —
 * see the note on `PiHarnessSecuritySummaryV1` in
 * `packages/core/src/types/pi-harness-runtime.ts`: `security.pendingPermissions`
 * is the live-test rig's pending-request detector. The same split holds for the
 * second namespace, and it is the *identically-named symbol in a sibling
 * subsystem* trap: `PiAgentViewEntryV1`, `PiAgentViewPageV1`,
 * `controlPiAgentView`, `projectPiAgentViewEntry` and the `piAgentViewOutcome`
 * stamp are all LIVE session-layer code, and none of them is a consumer of a
 * `chat.piAgentView.*` LOCALE key. Display died; the data did not. A sweep that
 * greps `piAgentView` and stops finds six files and concludes the keys are used.
 *
 * Mutation probe: put one `"chat.piRuntime.title"` (or
 * `"chat.piAgentView.title"`) back into en.json and ru.json → `no locale
 * carries a key for a deleted panel` goes red while both lint gates stay green.
 * Re-add a `t('chat.piRuntime.title')` call in the renderer → `the renderer
 * references no key for a deleted panel` goes red.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCALE_REGISTRY } from '../registry';

const RENDERER = join(import.meta.dir, '../../../../../apps/electron/src/renderer');

/**
 * Both deleted panels' namespaces. Extending this list is the one-line change
 * P2.364 designed the file for — the two halves below iterate it rather than
 * naming a prefix, so a third deleted panel costs one entry and no new test.
 */
const DEAD_PREFIXES = ['chat.piRuntime.', 'chat.piAgentView.'] as const;

const isDead = (key: string): boolean => DEAD_PREFIXES.some(prefix => key.startsWith(prefix));

/**
 * One rig for both halves: every QUOTED `chat.*` literal in the renderer, tests
 * included. Scanning the whole `chat.` namespace rather than just the dead ones
 * is what makes the absence claim checkable — the same scan that must find
 * nothing under the dead prefixes has to find the live keys, or it proves
 * nothing. The closing quote is required so a prose mention of a key inside a
 * longer dotted path cannot manufacture a match (`mcp-servers-panel-keys.test.ts`
 * paid for that lesson).
 */
const chatKeysInRenderer = [...new Set(
  // `scanSync` yields an IterableIterator with no `flatMap` — spread first.
  [...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: RENDERER, absolute: true })]
    .flatMap((file: string) => readFileSync(file, 'utf-8').match(/['"`]chat\.[A-Za-z0-9_.]+['"`]/g) ?? [])
    .map((quoted: string) => quoted.slice(1, -1)),
)].sort();

const localeEntries = Object.entries(LOCALE_REGISTRY) as [string, { messages: Record<string, string> }][];

describe('the deleted PiRuntimeControlCenter and PiAgentView leave no keys behind', () => {
  it('scans the renderer at all (the gate is not vacuous)', () => {
    // The positive control for the absence claim below: this scan, this regex,
    // this glob, finding a key that IS live in the renderer today.
    expect(chatKeysInRenderer).toContain('chat.attachFiles');
    expect(chatKeysInRenderer.length).toBeGreaterThan(20);
  });

  it('the renderer references no key for a deleted panel', () => {
    expect(chatKeysInRenderer.filter(isDead)).toEqual([]);
  });

  it('reads every registered locale (the gate is not vacuous)', () => {
    expect(localeEntries.length).toBeGreaterThan(1);
    for (const [lang, entry] of localeEntries) {
      // Same positive control on the locale rig: a live `chat.` key is present,
      // so the prefix filter below is being applied to a populated key set.
      expect(entry.messages['chat.attachFiles'], `chat.attachFiles missing from ${lang}`).toBeTruthy();
    }
  });

  it('no locale carries a key for a deleted panel', () => {
    for (const [lang, entry] of localeEntries) {
      const dead = Object.keys(entry.messages).filter(isDead);
      expect(dead, `${lang} still carries keys for a deleted panel`).toEqual([]);
    }
  });

  it('covers BOTH namespaces, so extending the list cannot silently cover one', () => {
    // Without this the file would pass identically with `chat.piAgentView.`
    // dropped from `DEAD_PREFIXES` — the deletion P2.478 performed would then
    // be ungated, which is exactly the state the 48 keys were in for a month.
    expect([...DEAD_PREFIXES]).toEqual(['chat.piRuntime.', 'chat.piAgentView.']);
    expect(isDead('chat.piAgentView.title')).toBe(true);
    expect(isDead('chat.piRuntime.title')).toBe(true);
    // …and it does not over-reach onto a live sibling.
    expect(isDead('chat.attachFiles')).toBe(false);
  });
});
