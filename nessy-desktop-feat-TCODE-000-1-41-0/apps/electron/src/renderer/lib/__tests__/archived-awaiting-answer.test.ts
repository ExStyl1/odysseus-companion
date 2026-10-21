/**
 * P6.546 — the archived chat that still owes the user an answer.
 *
 * `offerWorktreeCleanupOnClose` posts the keep-or-remove card into the session
 * being archived and does not await it; `41000700a` made the card return when
 * that chat is REOPENED. This is the half for the user who never reopens it, and
 * the three rules below are the whole of the decision, so each has a case and
 * each case moves exactly one of them.
 *
 * The containment arm is the trade `agent-tier.test.ts` and `skill-tier.test.ts`
 * both record: the renderer component graph cannot be loaded by the bun runner,
 * so `App.tsx` is read as SOURCE. Without it a perfectly tested predicate could
 * sit beside a component that never calls it — which is the state this row found
 * on the other side of the same feature.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { reconcileArchivedAwaitingNotices } from '../archived-awaiting-answer'

const archived = { id: 's1', name: 'Refactor the parser', isArchived: true }
const live = { id: 's2', name: 'Live chat', isArchived: false }
const waiting = new Map<string, readonly unknown[]>([['s1', [{}]], ['s2', [{}]]])
const none = new Map<string, readonly unknown[]>()

describe('reconcileArchivedAwaitingNotices — which archived chats owe a notice', () => {
  it('announces an archived chat holding an unanswered card', () => {
    const result = reconcileArchivedAwaitingNotices([archived], waiting, new Set())
    expect(result.announce.map(s => s.id)).toEqual(['s1'])
    expect([...result.retained]).toEqual(['s1'])
  })

  it('says nothing about a LIVE chat, however many cards it holds', () => {
    // The negative control that matters most: the ordinary permission prompt is
    // already on screen in the chat the user is in. A toast for it would double
    // every approval in the product.
    const result = reconcileArchivedAwaitingNotices([live], waiting, new Set())
    expect(result.announce).toEqual([])
    expect([...result.retained]).toEqual([])
  })

  it('says nothing about an archived chat that is waiting for nothing', () => {
    const result = reconcileArchivedAwaitingNotices([archived], none, new Set())
    expect(result.announce).toEqual([])
    expect([...result.retained]).toEqual([])
  })

  it('excludes the chat on screen, and announces it once the user leaves', () => {
    const viewing = reconcileArchivedAwaitingNotices([archived], waiting, new Set(), { viewingSessionId: 's1' })
    expect(viewing.announce).toEqual([])
    // And it is not RETAINED either, which is what makes the second half work:
    // walking away with the card unanswered is the moment the offer becomes
    // invisible again, so it is announced then rather than swallowed.
    expect([...viewing.retained]).toEqual([])
    const away = reconcileArchivedAwaitingNotices([archived], waiting, viewing.retained)
    expect(away.announce.map(s => s.id)).toEqual(['s1'])
  })

  it('announces once, not on every re-render', () => {
    const first = reconcileArchivedAwaitingNotices([archived], waiting, new Set())
    const second = reconcileArchivedAwaitingNotices([archived], waiting, first.retained)
    expect(second.announce).toEqual([])
    expect([...second.retained]).toEqual(['s1'])
  })

  it('forgets an answered chat, so a later card is announced again', () => {
    const first = reconcileArchivedAwaitingNotices([archived], waiting, new Set())
    const answered = reconcileArchivedAwaitingNotices([archived], none, first.retained)
    expect([...answered.retained]).toEqual([])
    const later = reconcileArchivedAwaitingNotices([archived], waiting, answered.retained)
    expect(later.announce.map(s => s.id)).toEqual(['s1'])
  })

  /**
   * P6.763 — the per-window map alone made the notice invisible to exactly the
   * user it was written for: one who archives, quits, and comes back. The card
   * is raised on the SERVER and this window never heard about it, so its
   * `pendingPermissions` is empty and always will be for that session.
   */
  it('announces on the server count alone, with this window holding no card', () => {
    const restarted = { ...archived, awaitingApprovalCount: 1 }
    const result = reconcileArchivedAwaitingNotices([restarted], none, new Set())
    expect(result.announce.map(s => s.id)).toEqual(['s1'])
    expect([...result.retained]).toEqual(['s1'])
  })

  it('is a UNION: the local card still announces while the server count reads zero', () => {
    // P6.757's measured reason for the union rather than a fallback — nothing
    // emits a Session DTO when a prompt is raised, so a meta in hand can say 0
    // while this window is holding a live card. Treating the count as
    // authoritative would silence exactly the case the original row closed.
    const stale = { ...archived, awaitingApprovalCount: 0 }
    const result = reconcileArchivedAwaitingNotices([stale], waiting, new Set())
    expect(result.announce.map(s => s.id)).toEqual(['s1'])
  })

  it('says nothing when BOTH halves of the union are empty', () => {
    // The boundary: a zero count is not a signal, and neither is an absent one.
    // Without this the previous case would pass on a predicate that ignored its
    // arguments entirely.
    for (const session of [{ ...archived, awaitingApprovalCount: 0 }, archived]) {
      const result = reconcileArchivedAwaitingNotices([session], none, new Set())
      expect(result.announce).toEqual([])
      expect([...result.retained]).toEqual([])
    }
  })

  it('still says nothing about a LIVE chat the server reports as waiting', () => {
    const result = reconcileArchivedAwaitingNotices([{ ...live, awaitingApprovalCount: 3 }], none, new Set())
    expect(result.announce).toEqual([])
  })
})

describe('containment — the root component actually announces it', () => {
  const app = readFileSync(join(import.meta.dir, '..', '..', 'App.tsx'), 'utf8')
  const locales = join(import.meta.dir, '..', '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')
  const en = JSON.parse(readFileSync(join(locales, 'en.json'), 'utf8')) as Record<string, string>
  const ru = JSON.parse(readFileSync(join(locales, 'ru.json'), 'utf8')) as Record<string, string>

  it('App.tsx calls this module and shows a toast for what it returns', () => {
    expect(app).toContain('reconcileArchivedAwaitingNotices(')
    expect(app).toContain("toast.info(t('toast.archivedChatAwaitingAnswer'")
  })

  /**
   * All THREE deps, because each covers a different way the card becomes
   * invisible and the effect is silent for that one if the dep is dropped:
   * `pendingPermissions` for archive-then-card, the selection for
   * card-then-walk-away, and `sessionsLoaded` for the card raised before this
   * app was running at all (P6.763).
   */
  it('re-runs on a new prompt AND on leaving the chat AND once the metas arrive', () => {
    const effect = app.slice(app.indexOf('reconcileArchivedAwaitingNotices('))
    const deps = effect.slice(0, effect.indexOf('])') + 2)
    expect(deps).toContain('pendingPermissions')
    expect(deps).toContain('sessionSelection.selected')
    // P6.763: without this one the server count is read once, at mount, when the
    // meta map is still empty — so the restart case the union exists for would
    // be fixed in the predicate and silent in the product.
    expect(deps).toContain('sessionsLoaded')
  })

  it('the three strings it shows exist in both locales', () => {
    for (const key of [
      'toast.archivedChatAwaitingAnswer',
      'toast.archivedChatAwaitingAnswerDesc',
      'toast.archivedChatAwaitingAnswerAction',
    ]) {
      expect(en[key], `en is missing ${key}`).toBeDefined()
      expect(ru[key], `ru is missing ${key}`).toBeDefined()
    }
  })
})
