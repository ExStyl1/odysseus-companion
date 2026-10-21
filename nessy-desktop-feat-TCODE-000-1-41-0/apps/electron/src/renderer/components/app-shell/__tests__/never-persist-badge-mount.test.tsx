/**
 * P6.502 — NEVER-PERSIST IS VISIBLE FOR THE LIFE OF THE SESSION.
 *
 * The host half (`7f564181d`) says what the mode costs when it is entered, as a
 * line in the transcript. The row asks for more than that: *"the mode is visible
 * for the life of the session rather than only at entry"* — and a transcript
 * line scrolls away. This pins the badge that does not.
 *
 * THE MOUNT IS PINNED BY SOURCE, for the reason `session-goal-mount.test.tsx`
 * measures in its own header and re-measured at HEAD 2026-09-08: importing
 * `ActiveOptionBadges.tsx` in a bare bun process throws `TypeError:
 * import.meta.glob is not a function` from `ThemeContext.tsx`, a Vite-only API.
 * No ordering of suites can make that component importable here, so the mount is
 * asserted against its source and the CHIP itself is RENDERED — `SessionFactChip`
 * (UB14.55: the quiet static chip of the one row above the composer; it was a
 * `MetadataBadge`) imports nothing Vite-only, so the label and the cost sentence
 * are proved to be real text rather than prop names.
 */

import * as React from 'react'
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { SessionFactChip } from '../SessionFactChip'

/** Comment-stripped source: this file's comments quote the very strings it pins. */
const badges = readFileSync(new URL('../ActiveOptionBadges.tsx', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')

/** The two hops between the session DTO and the chip, same comment-stripped read. */
function stripped(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function locale(name: 'en' | 'ru'): Record<string, string> {
  return JSON.parse(readFileSync(
    new URL(`../../../../../../../packages/shared/src/i18n/locales/${name}.json`, import.meta.url),
    'utf8',
  )) as Record<string, string>
}

describe('the never-persist badge is mounted (P6.502)', () => {
  it('renders from the session flag, with the cost as its title', () => {
    // POSITIVE: the chip exists, is driven by the prop, and carries both keys.
    expect(badges).toContain('{neverPersist && (')
    expect(badges).toContain("label={t('session.neverPersistBadge')}")
    expect(badges).toContain("title={t('session.neverPersistBadgeTitle')}")
    expect(badges).toContain('data-testid="never-persist-badge"')
    // The chip row renders for a never-persist session even when it has nothing
    // else in it — otherwise the badge would be invisible exactly where it
    // matters most, in a brand-new chat. UB14.55: the row's own condition.
    const at = badges.indexOf('const showChipRow =')
    expect(at).toBeGreaterThan(-1)
    expect(badges.slice(at, badges.indexOf('\n', at))).toMatch(/\|\| neverPersist \|\|/)
    expect(badges).toContain('{showChipRow && (')
  })

  it('the label and the whole cost sentence reach the markup', () => {
    const en = locale('en')
    const html = renderToStaticMarkup(
      <SessionFactChip
        label={en['session.neverPersistBadge']!}
        title={en['session.neverPersistBadgeTitle']!}
        data-testid="never-persist-badge"
      />,
    )
    expect(html).toContain(en['session.neverPersistBadge'])
    expect(html).toContain('title="')
    expect(html).toContain('data-testid="never-persist-badge"')
    // UB14.55 — the quiet static chip of the row above the composer, not the 30px badge it was.
    expect(html).toContain('h-control-sm')
    expect(html).not.toContain('h-[30px]')
    // The three losses are named, because each is one a user reaches for by
    // reflex. Asserted on the STRING rather than on the markup, which escapes.
    for (const loss of ['resumed', 'rewound', 'search']) {
      expect(en['session.neverPersistBadgeTitle']).toContain(loss)
    }
    // Both locales carry both keys, non-empty.
    for (const name of ['en', 'ru'] as const) {
      const table = locale(name)
      expect(table['session.neverPersistBadge']?.length ?? 0).toBeGreaterThan(0)
      expect(table['session.neverPersistBadgeTitle']?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('offers no control, and changes nothing for a session that is saved', () => {
    // NEGATIVE, the control: nothing can turn persistence back on for a session
    // already running, so a clickable chip would offer something that does not
    // exist. The block carries no handler, no interactive styling, no chevron,
    // and the chip it mounts is not a button (UB14.55: a `note`, no press).
    const start = badges.indexOf('{neverPersist && (')
    const end = badges.indexOf('{sessionAgent && (', start)
    expect(end).toBeGreaterThan(start)
    const block = badges.slice(start, end)
    expect(block).toContain('<SessionFactChip')
    expect(block).not.toContain('onClick')
    expect(block).not.toContain('interactive')
    expect(block).not.toContain('showChevron')
    const chip = renderToStaticMarkup(<SessionFactChip label="Not saved" title="cost" />)
    expect(chip).not.toContain('<button')
    expect(chip).not.toContain('motion-press')
    expect(chip).toContain('role="note"')
    // NEGATIVE, the default: every existing caller — the playground included —
    // renders exactly what it rendered before.
    expect(badges).toContain('neverPersist = false,')
    // And the FLAG is named in exactly four places — the prop type, the
    // destructure, the chip row's condition and the chip — so it decides nothing
    // else. Matched on a word boundary, because the two locale keys begin with
    // the same eleven characters and a substring count reads 7 for the same
    // file.
    expect(badges.match(/\bneverPersist\b/g)?.length).toBe(4)
  })

  it('P6.502: the chip is actually FED — the session DTO reaches it in two hops', () => {
    // POSITIVE. A mounted chip whose prop no production caller supplies renders
    // for nobody, which is what this file could not see on its own: it reads
    // `ActiveOptionBadges.tsx` alone, and both hops are in other files.
    const zone = stripped('../input/ChatInputZone.tsx')
    expect(zone).toContain('neverPersist?: boolean')
    expect(zone).toContain('neverPersist = false,')
    expect(zone).toContain('neverPersist={neverPersist}')
    const display = stripped('../ChatDisplay.tsx')
    // Straight off the DTO, and compared to `true`: `undefined` from an older
    // server must read as "saved normally", never as a missing answer.
    expect(display).toContain('neverPersist={session.ephemeral === true}')

    // NEGATIVE, and it is the measurement the badge's visibility depends on:
    // the strip sits behind `showOptionBadges ?? !compactMode`, so a compact
    // surface hides the chip.
    //
    // D1.375 FLIPPED THE REASON THIS CASE USED TO GIVE, and the old reason was
    // ALREADY wrong when it was written. It said the only production caller
    // passing `compactMode` also hid the composer, so the false arm of the gate
    // was playground-only — but `EditPopover`'s inline chat (the agent-driven
    // add-source / add-skill popover) and `ChatPage`'s auto-compact / mobile
    // branch both pass `compactMode` and never passed anything to hide the
    // input, so the false arm was live in two places already. The `/btw` panel
    // is now the third: the owner ruled a side question must be typed into, the
    // prop that hid its composer is gone from `ChatDisplay` entirely, and the
    // panel mounts a real `ChatInputZone`.
    //
    // The BADGE's own posture is unchanged and is what this case still pins:
    // every compact embedding hides the option strip, which is right — the
    // never-persist fact belongs to the real session, and every one of those
    // three surfaces renders over a session that is not it (a hidden edit
    // session, a mobile view of the real one, a synthetic side-question id).
    expect(zone).toContain('const shouldShowOptionBadges = showOptionBadges ?? !compactMode')
    expect(display).not.toContain('hideInput')
    const overlay = stripped('../SideQuestionOverlay.tsx')
    expect(overlay).toContain('compactMode')
    expect(overlay).not.toContain('hideInput')
    // POSITIVE, so the pair cannot be satisfied by deleting both sides: the
    // panel really does mount the composer it used to hide.
    expect(overlay).toContain('onSendMessage={onAsk}')
  })
})
