/**
 * P6.334 — the chip's three promises, one test each.
 *
 * The row's `done_means` is a conjunction and each clause fails differently:
 * *"the agent proposes work, NOTHING runs until the user clicks, and the
 * clicked session starts isolated in its own worktree."*
 *
 * The third is the one a refactor breaks silently. `routes.action.newSession`
 * emits `worktree=true` only for the boolean `true`; a value that arrives as
 * the STRING `'true'`, or as `undefined` from an object spread, drops the
 * parameter and produces a session in the LIVE checkout with no error anywhere.
 * That outcome is precisely what the row exists to rule out, so the route is
 * asserted as an exact string rather than by rendering a chip and hoping.
 */

import * as React from 'react'
import { beforeAll, describe, expect, test } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import enMessages from '../../../../../../../packages/shared/src/i18n/locales/en.json'
import ruMessages from '../../../../../../../packages/shared/src/i18n/locales/ru.json'
import {
  DeferredSpawnChips,
  deferredSpawnRoute,
  type DeferredSpawnProposal,
} from '../deferred-spawn-chip'

const en = enMessages as Record<string, string>
const ru = ruMessages as Record<string, string>

let i18nInstances: Record<'en' | 'ru', I18nInstance>

beforeAll(async () => {
  const make = async (lng: 'en' | 'ru', resources: Record<string, string>) => {
    const instance = createInstance()
    await instance.use(initReactI18next).init({
      lng,
      fallbackLng: lng,
      resources: { [lng]: { translation: resources } },
      interpolation: { escapeValue: false },
    })
    return instance
  }
  i18nInstances = { en: await make('en', en), ru: await make('ru', ru) }
})

const PROPOSAL: DeferredSpawnProposal = {
  id: 'p1',
  name: 'Update the stale README badge',
  prompt: 'The README badge points at a job that no longer exists. Fix it.',
}

const render = (locale: 'en' | 'ru', proposals: readonly DeferredSpawnProposal[]): string =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18nInstances[locale]}>
      <DeferredSpawnChips proposals={proposals} />
    </I18nextProvider>,
  )

describe('the deferred spawn chip', () => {
  test('the accepted route asks for a WORKTREE, and carries the prompt', () => {
    const route = deferredSpawnRoute(PROPOSAL)
    expect(route).toContain('action/new-session')
    // The clause the row is about. Asserted on the literal the handler matches
    // (`parsed.params.worktree === 'true'`), not on a boolean this side.
    expect(route).toContain('worktree=true')
    expect(route).toContain('send=true')
    const params = new URLSearchParams(route.slice(route.indexOf('?') + 1))
    expect(params.get('input')).toBe(PROPOSAL.prompt)
    expect(params.get('name')).toBe(PROPOSAL.name)
    expect(params.get('worktree')).toBe('true')
  })

  test('a proposal with an empty prompt still asks for the worktree', () => {
    // The boundary: `toQueryString` drops `undefined` values, so a proposal
    // whose prompt is empty must not take `worktree` down with it.
    const route = deferredSpawnRoute({ id: 'p2', name: 'n', prompt: '' })
    expect(route).toContain('worktree=true')
  })

  test('nothing renders until there is a proposal', () => {
    // The default state of every session that has not been offered anything.
    expect(render('en', [])).toBe('')
  })

  test('a proposal renders as an OFFER, with the isolation stated on it', () => {
    const html = render('en', [PROPOSAL])
    expect(html).toContain('deferred-spawn-chip')
    expect(html).toContain(PROPOSAL.name)
    // The sentence that bounds the click is part of the affordance.
    expect(html).toContain(en['chat.spawnProposal.isolatedNote'])
    expect(html).toContain(en['chat.spawnProposal.start'])
    // And the prompt itself is NOT dumped into the chip: it is the session's
    // instruction, not a wall of text in the composer's gutter.
    expect(html).not.toContain(PROPOSAL.prompt)
  })

  test('two proposals are two independent chips', () => {
    const html = render('en', [PROPOSAL, { ...PROPOSAL, id: 'p2', name: 'Second' }])
    expect(html.split('data-testid="deferred-spawn-chip"').length - 1).toBe(2)
  })

  test('reads in Russian too', () => {
    const html = render('ru', [PROPOSAL])
    expect(html).toContain(ru['chat.spawnProposal.isolatedNote'])
    expect(html).not.toContain('chat.spawnProposal.')
    expect(html).not.toBe(render('en', [PROPOSAL]))
  })

  test('rendering starts nothing — the component has no effect on mount', () => {
    // The row's second clause. If a future edit fires `onStart` from an effect
    // or a memo, this fails; a chip that spawns on render is the exact defect
    // the row was opened for.
    let started = 0
    renderToStaticMarkup(
      <I18nextProvider i18n={i18nInstances.en}>
        <DeferredSpawnChips proposals={[PROPOSAL]} onStart={() => { started += 1 }} />
      </I18nextProvider>,
    )
    expect(started).toBe(0)
  })
})
