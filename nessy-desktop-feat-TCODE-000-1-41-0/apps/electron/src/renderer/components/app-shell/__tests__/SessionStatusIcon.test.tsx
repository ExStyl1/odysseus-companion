/**
 * The session row's status control is not a <button> (fix, 2026-08-01).
 *
 * `SessionItem` puts `SessionStatusIcon` in `EntityRow`'s `icon` slot, and that
 * slot is rendered INSIDE the row's own `<button>`. So a `<button>` trigger here
 * is a button nested in a button: invalid HTML, logged by React on every single
 * session row (`validateDOMNesting(...): <button> cannot appear as a descendant
 * of <button>` — two of them were the ONLY console output of a whole boot), and
 * in engines that follow the parsing spec strictly the inner element is hoisted
 * out of its parent, which loses the click that was supposed to open the status
 * popover.
 *
 * The fix is the route `EntityRow` already takes for its own "…" trigger
 * (`DropdownMenuTrigger asChild` around a `<div>`): a non-button element wearing
 * `role="button"`, with tabIndex and Enter/Space put back by hand.
 *
 * Two arms, because either half alone is worthless:
 *   - the RENDERED arm proves the trigger emits no `<button>` and keeps the
 *     button role, so the markup is valid and still reachable;
 *   - the CONTAINMENT arm proves the containment that makes the first one
 *     matter — SessionItem hands this component to `icon`, and `EntityRow`
 *     renders `icon` inside its `<button>`. Read from source because
 *     `entity-row.tsx` pulls the `@nessy-agent/ui` barrel, which the bun runner
 *     cannot load (see `source-card.test.tsx` for the same measured trade).
 *
 * Mutation probe, run 2026-08-01: change the trigger's `<span role="button">`
 * back to `<button type="button">`. The rendered arm goes red; the containment
 * arm stays green (it is describing where the component is mounted, not what it
 * renders). Reported in the task.
 */

import * as React from 'react'
import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SessionStatusIcon } from '../SessionStatusIcon'
import { SessionListProvider, type SessionListContextValue } from '@/context/SessionListContext'
import type { SessionMeta } from '@/atoms/sessions'

const RENDERER_DIR = join(import.meta.dir, '..', '..', '..')

const item = { id: 's-1', sessionStatus: 'todo' } as unknown as SessionMeta

// Only the fields SessionStatusIcon reads. An empty status list makes
// getStateIcon fall back to its own glyph, which is all this test needs.
const ctx = {
  onSessionStatusChange: () => {},
  sessionStatuses: [],
  isMultiSelectActive: false,
  contentSearchResults: new Map(),
} as unknown as SessionListContextValue

function render() {
  return renderToStaticMarkup(
    <SessionListProvider value={ctx}>
      <SessionStatusIcon item={item} />
    </SessionListProvider>,
  )
}

describe('SessionStatusIcon', () => {
  it('renders no <button>, because it lives inside the row button', () => {
    const html = render()
    expect(html).not.toContain('<button')
  })

  it('keeps the button role, so the control is still announced and reachable', () => {
    const html = render()
    expect(html).toContain('role="button"')
    expect(html).toContain('tabindex="0"')
    // F1.477 (P6): the label goes through t(); since UB14.4 it is v0.15.1's key t('status.change')
    // ("Change status"; `multiSelect.changeStatus` stays MultiSelectPanel's). Rendered here with whatever
    // i18n this process has, so the English value or the bare key — never the literal.
    expect(html).toMatch(/aria-label="(Change status|status\.change)"/)
    expect(html).not.toContain('aria-label="Change todo state"')
    expect(html).toContain('aria-haspopup="menu"')
  })

  it('is mounted inside EntityRow\'s row <button> — the reason the above matters', () => {
    const sessionItem = readFileSync(join(RENDERER_DIR, 'components/app-shell/SessionItem.tsx'), 'utf8')
    const iconSlot = sessionItem.slice(sessionItem.indexOf('icon={'))
    expect(iconSlot).toContain('<SessionStatusIcon')

    const entityRow = readFileSync(join(RENDERER_DIR, 'components/ui/entity-row.tsx'), 'utf8')
    // The row's main content button, from its class marker to its close tag.
    const buttonStart = entityRow.indexOf('entity-row-btn')
    expect(buttonStart).toBeGreaterThan(-1)
    const buttonBody = entityRow.slice(buttonStart, entityRow.indexOf('</button>', buttonStart))
    expect(buttonBody).toContain('{icon}')
  })
})
