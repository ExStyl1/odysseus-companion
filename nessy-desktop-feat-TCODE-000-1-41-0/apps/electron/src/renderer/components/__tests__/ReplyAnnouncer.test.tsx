/**
 * P6.48 · the live region itself, which is the half no unit test of the
 * decision logic can reach.
 *
 * `stepReplyAnnouncer` decides WHEN to speak; this file proves there is
 * something for a screen reader to speak THROUGH, and that it is shaped the way
 * assistive technology requires. Three properties, each of which silently
 * disables the feature if it is wrong, and none of which a screenshot would
 * catch — the element renders nothing visible by design:
 *
 *   - the region exists on the very first render, EMPTY. A live region mounted
 *     at the same moment it gains text is routinely missed, because the
 *     observer attaches after the mutation it was supposed to see. This is why
 *     the component renders the element unconditionally instead of returning
 *     null until it has something to say.
 *   - `aria-live="polite"`, not `assertive`. Per
 *     `vs-code.md#use-a-screen-reader` the reply is announced alongside a
 *     transcript "readable at your own pace" — an assertive region would cut
 *     off whatever the user was reading mid-word.
 *   - `aria-atomic="true"`, so the reply is read as one utterance rather than
 *     as whatever subtree happened to change.
 *
 * The mount is verified from source rather than by rendering `App`: `App.tsx`
 * pulls the entire renderer graph, which the bun runner cannot load — the same
 * measured trade `SessionStatusIcon.test.tsx` documents. A perfectly-shaped
 * region that nothing mounts is exactly the defect this row is closing, so the
 * containment arm is not optional.
 */
import * as React from 'react'
import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Provider, createStore } from 'jotai'
import { ReplyAnnouncer } from '../ReplyAnnouncer'

const RENDERER_DIR = join(import.meta.dir, '..', '..')

function render() {
  return renderToStaticMarkup(
    <Provider store={createStore()}>
      <ReplyAnnouncer />
    </Provider>,
  )
}

describe('ReplyAnnouncer — the live region', () => {
  it('renders the region on the first pass, before it has anything to say', () => {
    const html = render()
    expect(html).toContain('aria-live')
    // Empty on arrival: the region must pre-exist its own first update.
    expect(html).toContain('></div>')
  })

  it('is polite, not assertive — it must not interrupt the transcript', () => {
    expect(render()).toContain('aria-live="polite"')
    expect(render()).not.toContain('aria-live="assertive"')
  })

  it('is atomic, so the reply is read as one utterance', () => {
    expect(render()).toContain('aria-atomic="true"')
  })

  it('carries role="status", so it is announced without being focusable', () => {
    expect(render()).toContain('role="status"')
  })

  it('renders nothing visible', () => {
    // `sr-only` is the project's existing visually-hidden class.
    expect(render()).toContain('sr-only')
  })
})

describe('ReplyAnnouncer — containment', () => {
  it('is mounted once at the app root, so the region outlives every session switch', () => {
    const app = readFileSync(join(RENDERER_DIR, 'App.tsx'), 'utf8')
    expect(app).toContain("import { ReplyAnnouncer } from '@/components/ReplyAnnouncer'")
    expect(app).toContain('<ReplyAnnouncer />')
    // Exactly one mount: two regions would double every announcement.
    expect(app.split('<ReplyAnnouncer />').length - 1).toBe(1)
  })
})
