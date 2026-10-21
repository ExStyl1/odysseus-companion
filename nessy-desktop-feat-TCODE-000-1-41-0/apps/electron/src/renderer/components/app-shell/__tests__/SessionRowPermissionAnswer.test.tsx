/**
 * P6.589 — the one-shot answer affordance on a blocked session row.
 *
 * The row's whole risk is the one assertion at the bottom: an answer given
 * without seeing the conversation must never widen the session. The rest holds
 * the two places the control must NOT appear, because a control that shows up
 * on the wrong prompt is how a question gets answered "deny" by someone who
 * only wanted to dismiss it.
 */
import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PermissionRequest } from '../../../../shared/types'
import {
  SessionRowPermissionAnswer,
  answerOnce,
  type RespondToPermission,
} from '../SessionRowPermissionAnswer'

const translations = {
  'session.answer.allowOnce': 'Allow once',
  'session.answer.defaultToNoHint': 'This request defaults to no, so the list offers Deny only. Open the session to allow it.',
  'session.answer.deny': 'Deny',
  'session.answer.hint': 'Answering from the list approves this one action only.',
  'session.answer.label': "Answer this session's request",
}

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n
    .use(initReactI18next)
    .init({
      lng: 'en',
      fallbackLng: 'en',
      resources: { en: { translation: translations } },
      interpolation: { escapeValue: false },
    })
})

const BASH_REQUEST: PermissionRequest = {
  sessionId: 'session-1',
  requestId: 'perm-1',
  toolName: 'Bash',
  description: 'Run a command',
  type: 'bash',
}

function render(props: {
  request: PermissionRequest | undefined
  onRespond?: RespondToPermission
}): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <SessionRowPermissionAnswer sessionId="session-1" {...props} />
    </I18nextProvider>
  )
}

describe('SessionRowPermissionAnswer', () => {
  it('offers approve and deny on a blocked row, and NO remember option', () => {
    const html = render({ request: BASH_REQUEST, onRespond: () => {} })

    expect(html).toContain('Allow once')
    expect(html).toContain('Deny')
    // The suppression, from the rendered output's side. Any of these words
    // appearing here would mean the chat card's third button had leaked in.
    expect(html.toLowerCase()).not.toContain('always')
    expect(html.toLowerCase()).not.toContain('remember')
    // The narrowing is STATED, because a missing button is indistinguishable
    // from an oversight.
    expect(html).toContain('approves this one action only')
  })

  // F1.1230 — the Claude Agent SDK's `defaultToNo` hint (`agent-sdk/typescript.md#canusetool`, "a single stray
  // keystroke must not approve this"): decided (owner rule 2026-10-08) that the list offers Deny only on such an ask,
  // as the SDK hint asks; allowing it takes the session's own card (F1.1219), one click away.
  it('F1.1230: offers Deny only on a defaultToNo ask, and says why', () => {
    const html = render({ request: { ...BASH_REQUEST, defaultToNo: true }, onRespond: () => {} })
    expect(html).not.toContain('Allow once')
    expect(html).toContain('Deny')
    expect(html).toContain('defaults to no')
  })

  it('renders nothing when there is no pending request', () => {
    expect(render({ request: undefined, onRespond: () => {} })).toBe('')
  })

  it('renders nothing for an ask_user prompt — a question is not a yes-or-no', () => {
    expect(render({
      request: { ...BASH_REQUEST, toolName: 'ask_user', type: 'ask_user' },
      onRespond: () => {},
    })).toBe('')
  })

  it('renders nothing when the host gave no handler', () => {
    // A button that silently does nothing is worse than no button.
    expect(render({ request: BASH_REQUEST })).toBe('')
  })
})

describe('answerOnce', () => {
  it('ALWAYS sends alwaysAllow: false, on approve and on deny alike', () => {
    // THE row. A permission answered without seeing the conversation must never
    // widen the session, so this holds for the allow arm — where the temptation
    // is — and for the deny arm, where a `true` would be just as wrong.
    const calls: unknown[][] = []
    const record: RespondToPermission = (...args) => { calls.push(args) }

    answerOnce(record, 'session-1', 'perm-1', true)
    answerOnce(record, 'session-1', 'perm-1', false)

    expect(calls).toEqual([
      ['session-1', 'perm-1', true, false],
      ['session-1', 'perm-1', false, false],
    ])
    expect(calls.every(call => call[3] === false)).toBe(true)
  })
})

/**
 * P6.589 — the MOUNT, which is what stood between the component above and the
 * feature being reachable. Every assertion in this file passed while
 * `SessionItem` rendered no control at all, so the mount needs its own pin.
 *
 * Source-level, for the reason the sibling suites give: `bun test` has no DOM
 * and `SessionItem` pulls the entity-row barrel bun cannot resolve.
 */
describe('the session row mounts it', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../SessionItem.tsx', import.meta.url)),
    'utf8',
  )

  it('renders the control with the row\'s own session, request and context handler', () => {
    expect(source).toContain('import { SessionRowPermissionAnswer }')
    expect(source).toContain('sessionId={item.id}')
    expect(source).toContain('request={pendingPermission}')
    expect(source).toContain('onRespond={onRespondToPermission}')
  })

  it('takes the handler from the AppShell context rather than a prop of its own', () => {
    expect(source).toContain('const { workspaces, isCompactMode, onRespondToPermission } = useAppShellContext()')
  })

  it('negative — no always-allow reaches the mount, in any spelling', () => {
    expect(source).not.toContain('alwaysAllow')
    expect(source).not.toContain('answerOnce')
  })

  it('sits beside the "needs you" line, where the labels give way (UB14.3, v0.15.1)', () => {
    // Before UB14.3 the control shared the badges slot with the labels and this
    // pin kept them together. v0.15.1's row hides the labels while the row needs
    // attention (one line, one subject), so the control takes that line's
    // trailing slot, and the labels keep it on every other row.
    expect(source).toContain("const subtitleTrailing = runState === 'needs-you'")
    expect(source).toContain('? answerControl ?? undefined')
    expect(source).toContain(': showLabels ? <SessionBadges item={item} /> : undefined')
  })
})

/**
 * F1.354 — the control sits in EntityRow's `subtitleTrailing` slot (its `badges`
 * slot before UB14.3), INSIDE the row's own
 * <button>, whose `onMouseDown` is SessionItem's select handler. Two real
 * <button>s nested there are invalid markup (React's validateDOMNesting warns
 * on every waiting row), and the group stopped only pointerdown and click — so
 * a mousedown on Allow bubbled to the row and OPENED the session, the second
 * action this component's header says it prevents.
 *
 * `bun test` has no DOM, so the bubbling is simulated over the REAL handlers:
 * the component's element tree is captured from a render (its hooks run inside
 * a wrapper's render), and each synthetic event walks target → group → row the
 * way React's bubbling would, stopping where a handler stops it.
 */
describe('F1.354 — answering from the row never selects the row', () => {
  type Handlers = Record<string, ((event: FakeEvent) => void) | undefined>
  interface FakeEvent { key?: string; stopped: boolean; stopPropagation(): void; preventDefault(): void }

  function capture(onRespond: RespondToPermission): React.ReactElement<Handlers & { children: React.ReactNode }> {
    let tree: unknown
    function Capture() {
      tree = SessionRowPermissionAnswer({ sessionId: 'session-1', request: BASH_REQUEST, onRespond })
      return null
    }
    renderToStaticMarkup(<I18nextProvider i18n={testI18n}><Capture /></I18nextProvider>)
    return tree as React.ReactElement<Handlers & { children: React.ReactNode }>
  }

  function fire(prop: string, path: Handlers[], key?: string): FakeEvent {
    const event: FakeEvent = {
      key,
      stopped: false,
      stopPropagation() { this.stopped = true },
      preventDefault() {},
    }
    for (const handlers of path) {
      if (event.stopped) break
      handlers[prop]?.(event)
    }
    return event
  }

  function rig() {
    const calls: unknown[][] = []
    let rowSelected = 0
    const group = capture((...args) => { calls.push(args) })
    const [allow, deny] = React.Children.toArray(group.props.children) as Array<React.ReactElement<Handlers>>
    const row: Handlers = { onMouseDown: () => { rowSelected++ }, onPointerDown: () => {}, onClick: () => { rowSelected++ } }
    const click = (target: React.ReactElement<Handlers>) => {
      for (const prop of ['onPointerDown', 'onMouseDown', 'onClick']) fire(prop, [target.props, group.props, row])
    }
    return { calls, allow: allow!, deny: deny!, group, row, click, rowSelected: () => rowSelected }
  }

  it('positive — a full click on Allow answers once (always-allow false) and the row never selects', () => {
    const { calls, allow, click, rowSelected } = rig()
    click(allow)
    expect(calls).toEqual([['session-1', 'perm-1', true, false]])
    expect(rowSelected()).toBe(0)
  })

  it('positive — Enter and Space answer from the keyboard and stop at the control', () => {
    const { calls, allow, deny, group, row } = rig()
    expect(fire('onKeyDown', [deny.props, group.props, row], 'Enter').stopped).toBe(true)
    expect(fire('onKeyDown', [allow.props, group.props, row], ' ').stopped).toBe(true)
    expect(calls).toEqual([['session-1', 'perm-1', false, false], ['session-1', 'perm-1', true, false]])
  })

  it('negative — the markup nests no <button> (the row itself is one) and the controls keep a button role', () => {
    const html = render({ request: BASH_REQUEST, onRespond: () => {} })
    expect(html).not.toContain('<button')
    expect(html.match(/role="button"/g)?.length).toBe(2)
    expect(html.match(/tabindex="0"/g)?.length).toBe(2)
  })
})
