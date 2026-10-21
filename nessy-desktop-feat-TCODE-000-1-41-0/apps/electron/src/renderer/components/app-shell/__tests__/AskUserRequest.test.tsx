import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PermissionRequest } from '../../../../shared/types'
import { Button } from '@/components/ui/button'
import { AskUserRequest } from '../input/structured/AskUserRequest'
import { DecisionActions, DecisionSpacer } from '../input/structured/DecisionCard'

const translations = {
  'chat.askUser.cancel': 'Cancel',
  'chat.askUser.freeTextLabel': 'Custom answer',
  'chat.askUser.freeTextPlaceholder': 'Type a custom answer',
  'chat.askUser.otherLabel': 'Other',
  'chat.askUser.otherPlaceholder': 'Type your own answer',
  'chat.askUser.responseLabel': 'Reply without answering',
  'chat.askUser.responsePlaceholder': 'Type a general reply instead',
  'chat.askUser.send': 'Send answer',
  'chat.askUser.submit': 'Submit answers',
  'chat.askUser.title': 'Question from agent',
  'chat.askUser.urlConsent.domainLabel': 'You will be sent to',
  'chat.askUser.urlConsent.fullUrlLabel': 'Full address',
  'chat.askUser.urlConsent.warning.embedded-credentials': 'This address hides a username before the site name.',
  'chat.askUser.urlConsent.warning.lookalike-suffix': 'This address puts a full domain name in front of the real one.',
  'chat.askUser.urlConsent.warning.mixed-script': 'This address mixes letters from different alphabets.',
  'chat.askUser.urlConsent.warning.punycode': 'This address is written in Punycode. It renders as:',
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

function renderAskUser(request: PermissionRequest): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <AskUserRequest request={request} onResponse={() => {}} />
    </I18nextProvider>
  )
}

describe('AskUserRequest', () => {
  it('renders option buttons for an ask_user permission request', () => {
    const html = renderAskUser({
      sessionId: 'session-1',
      requestId: 'ask-1',
      toolName: 'ask_user',
      description: 'Choose a path',
      type: 'ask_user',
      askUser: {
        question: 'Which path should I take?',
        options: ['Ship it', 'Stop'],
        allowFreeText: false,
      },
    })

    expect(html).toContain('Question from agent')
    expect(html).toContain('Which path should I take?')
    expect(html).toContain('Ship it')
    expect(html).toContain('Stop')
    expect(html).toContain('Cancel')
    expect(html).not.toContain('Type a custom answer')
  })

  it('renders the optional free-text input', () => {
    const html = renderAskUser({
      sessionId: 'session-1',
      requestId: 'ask-1',
      toolName: 'ask_user',
      description: 'Choose a path',
      type: 'ask_user',
      askUser: {
        question: 'Which path should I take?',
        options: ['Ship it', 'Stop'],
        allowFreeText: true,
      },
    })

    expect(html).toContain('Type a custom answer')
    expect(html).toContain('Custom answer')
    expect(html).toContain('Send answer')
  })

  it('renders a batched two-question card with headers, options, and a submit action', () => {
    const html = renderAskUser({
      sessionId: 'session-1',
      requestId: 'ask-batched',
      toolName: 'ask_user',
      description: 'Clarifying questions',
      type: 'ask_user',
      askUser: {
        question: 'How should I format the output?',
        options: ['Summary', 'Detailed'],
        allowFreeText: true,
        questions: [
          {
            question: 'How should I format the output?',
            header: 'Format',
            options: [
              { label: 'Summary', description: 'Brief overview' },
              { label: 'Detailed', description: 'Full explanation' },
            ],
            multiSelect: false,
          },
          {
            question: 'Which sections should I include?',
            header: 'Sections',
            options: [
              { label: 'Introduction', description: 'Opening context' },
              { label: 'Conclusion', description: 'Final summary' },
            ],
            multiSelect: true,
          },
        ],
      },
    })

    expect(html).toContain('Format')
    expect(html).toContain('Sections')
    expect(html).toContain('How should I format the output?')
    expect(html).toContain('Which sections should I include?')
    expect(html).toContain('Summary')
    expect(html).toContain('Introduction')
    expect(html).toContain('Submit answers')
    expect(html).toContain('Cancel')
  })

  /**
   * P6.471 — `option.preview` has been on the wire and produced by Pi's
   * `ask_user` since the tool shipped, and this component rendered `label` and
   * `description` only. The SDK documents the `'markdown'` format as
   * "Markdown/ASCII content (CLI default, rendered in a monospace box)", so what
   * is asserted is the box and the text SURVIVING VERBATIM — an ASCII preview
   * whose alignment carries its meaning must not be reflowed.
   */
  it('renders an option preview verbatim in a monospace box, and draws nothing when there is none', () => {
    const html = renderAskUser({
      sessionId: 'session-1',
      requestId: 'ask-preview',
      toolName: 'ask_user',
      description: 'Clarifying questions',
      type: 'ask_user',
      askUser: {
        question: 'How should I format the output?',
        options: ['Summary', 'Detailed'],
        allowFreeText: false,
        questions: [
          {
            question: 'How should I format the output?',
            header: 'Format',
            options: [
              { label: 'Summary', description: 'Brief overview', preview: '| col |\n|-----|\n| two-line |' },
              { label: 'Detailed', description: 'Full explanation' },
            ],
            multiSelect: false,
          },
        ],
      },
    })

    // The box, and the ASCII surviving character for character — a renderer that
    // reflowed it would drop the pipes that make the preview a table.
    expect(html).toContain('<pre')
    expect(html).toContain('| two-line |')
    expect(html).toContain('|-----|')
    // CONTROL — the option carrying no preview draws exactly one <pre>, so the
    // surface cannot start showing an empty box.
    expect(html.match(/<pre/g) ?? []).toHaveLength(1)
  })
})

/**
 * `elicitation.md:726` (full URL), `:729` (highlight the domain) and `:730`
 * (warn about ambiguous/suspicious URIs) — all three on the card that takes the
 * consent, not a later one.
 */
describe('AskUserRequest — URL-mode elicitation consent', () => {
  const urlRequest = (
    urlConsent: NonNullable<NonNullable<PermissionRequest['askUser']>['urlConsent']>,
  ): PermissionRequest => ({
    sessionId: 'session-1',
    requestId: 'ask-url',
    toolName: 'ask_user',
    description: 'MCP elicitation',
    type: 'ask_user',
    askUser: {
      question: `Authorize the app\n\n${urlConsent.url}`,
      options: ['Open separately', 'Cancel'],
      allowFreeText: false,
      urlConsent,
    },
  })

  it('highlights the registrable domain and shows the full URL with no warning', () => {
    const html = renderAskUser(urlRequest({
      url: 'https://corp.example.com/x',
      host: 'corp.example.com',
      registrableDomain: 'example.com',
      warnings: [],
    }))

    expect(html).toContain('You will be sent to')
    expect(html).toContain('example.com')
    expect(html).toContain('https://corp.example.com/x')
    expect(html).not.toContain('role="alert"')
    // The consent buttons are still on the same card.
    expect(html).toContain('Open separately')
  })

  it('warns about a Punycode host, shows the decoded form, and keeps the full URL', () => {
    const html = renderAskUser(urlRequest({
      url: 'https://xn--pple-43d.com/authorize',
      host: 'xn--pple-43d.com',
      registrableDomain: 'xn--pple-43d.com',
      decodedHost: 'аpple.com',
      warnings: [{ kind: 'punycode' }, { kind: 'mixed-script', detail: 'Latin + Cyrillic' }],
    }))

    expect(html).toContain('This address is written in Punycode. It renders as:')
    expect(html).toContain('аpple.com')
    expect(html).toContain('This address mixes letters from different alphabets.')
    expect(html).toContain('Latin + Cyrillic')
    expect(html).toContain('https://xn--pple-43d.com/authorize')
    // The warning is announced and has no dismiss control of its own.
    expect(html).toContain('role="alert"')
    expect(html).not.toContain('data-dismiss')
  })

  it('flags a subdomain-suffix lookalike and names the real registrable domain', () => {
    const html = renderAskUser(urlRequest({
      url: 'https://accounts.example.com.attacker.net/oauth/authorize',
      host: 'accounts.example.com.attacker.net',
      registrableDomain: 'attacker.net',
      warnings: [{ kind: 'lookalike-suffix' }],
    }))

    expect(html).toContain('attacker.net')
    expect(html).toContain('This address puts a full domain name in front of the real one.')
    expect(html).toContain('https://accounts.example.com.attacker.net/oauth/authorize')
  })

  it('does not print the URL twice when the panel already owns it', async () => {
    const { askUserMessageText } = await import('../input/structured/AskUserRequest')
    const consent = {
      url: 'https://corp.example.com/x',
      host: 'corp.example.com',
      registrableDomain: 'example.com',
      warnings: [],
    }

    expect(askUserMessageText(`Authorize the app\n\n${consent.url}`, consent)).toBe('Authorize the app')
    // Without the panel the message keeps the URL — the MUST has nowhere else to live.
    expect(askUserMessageText(`Authorize the app\n\n${consent.url}`, undefined))
      .toBe(`Authorize the app\n\n${consent.url}`)
  })
})

describe('buildBatchedAskUserAnswer', () => {
  it('produces the documented envelope: labels, multi-select arrays, Other free text, and response', async () => {
    const { buildBatchedAskUserAnswer } = await import('../input/structured/AskUserRequest')
    const questions = [
      { question: 'Q1?', header: 'One', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false },
      { question: 'Q2?', header: 'Two', options: [{ label: 'C' }, { label: 'D' }], multiSelect: true },
    ]

    expect(buildBatchedAskUserAnswer(questions, {
      'Q1?': { selected: ['A'] },
      'Q2?': { selected: ['C', 'D'] },
    })).toEqual({
      type: 'batched',
      answers: { 'Q1?': 'A', 'Q2?': ['C', 'D'] },
    })

    // Other free text becomes the answer value for that question
    expect(buildBatchedAskUserAnswer(questions, {
      'Q1?': { selected: [], other: 'my own answer' },
    })).toEqual({
      type: 'batched',
      answers: { 'Q1?': 'my own answer' },
    })

    // A general response replaces the per-question answers
    expect(buildBatchedAskUserAnswer(questions, {}, 'wait until Friday')).toEqual({
      type: 'batched',
      answers: {},
      response: 'wait until Friday',
    })
  })
})

describe('askUserAutoContinueCountdown', () => {
  it('surfaces a 20 s on-screen countdown only when a timeout is configured', async () => {
    const { askUserAutoContinueCountdown } = await import('../input/structured/AskUserRequest')
    // Default never: no timeout, no countdown, ever.
    expect(askUserAutoContinueCountdown(undefined, 10_000_000)).toBeNull()
    // Countdown hidden until the last 20 seconds before auto-continue.
    expect(askUserAutoContinueCountdown(60_000, 0)).toBeNull()
    expect(askUserAutoContinueCountdown(60_000, 39_000)).toBeNull()
    expect(askUserAutoContinueCountdown(60_000, 40_000)).toBe(20)
    expect(askUserAutoContinueCountdown(60_000, 55_000)).toBe(5)
    expect(askUserAutoContinueCountdown(60_000, 60_000)).toBe(0)
    expect(askUserAutoContinueCountdown(60_000, 65_000)).toBe(0)
  })
})

/**
 * UB14.25 — the ask-user card on v0.15.1's decision anatomy (`structured/DecisionCard.tsx`), restyle only.
 *
 * Instruments, both without a DOM (this repo ships none):
 * - `renderToStaticMarkup` for what the card draws;
 * - the ELEMENT TREE a component returns, captured by calling it inside a probe component's render (its hooks
 *   run as the probe's — the UB14.28 / UB14.23 recipe), so the handlers it wires are its own functions. A
 *   click that sets state during that render is a RENDER-PHASE update of the probe, which React's server
 *   renderer applies by rendering the probe again — so "pick, then submit" runs on the real state, two passes.
 *
 * Positive: a card with two questions submits BOTH answers (a single-select label and a multi-select array)
 * through the one primary Submit inside `DecisionActions`. Negative (boundary): with nothing picked Submit is
 * disabled and its handler sends nothing; Cancel is the ghost after the spacer and answers `allowed:false` once.
 */
describe('UB14.25 · the ask-user card on the decision anatomy', () => {
  type Element = React.ReactElement<Record<string, unknown>>
  type Answer = Parameters<React.ComponentProps<typeof AskUserRequest>['onResponse']>[0]

  const findAll = (node: React.ReactNode, match: (el: Element) => boolean, out: Element[] = []): Element[] => {
    if (Array.isArray(node)) {
      for (const child of node) findAll(child, match, out)
      return out
    }
    if (!React.isValidElement<Record<string, unknown>>(node)) return out
    if (match(node)) out.push(node)
    findAll(node.props.children as React.ReactNode, match, out)
    return out
  }
  const only = (node: React.ReactNode, match: (el: Element) => boolean): Element => {
    const found = findAll(node, match)
    expect(found).toHaveLength(1)
    return found[0]!
  }
  const textOf = (node: React.ReactNode): string => {
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join('')
    if (!React.isValidElement<Record<string, unknown>>(node)) return ''
    return textOf(node.props.children as React.ReactNode)
  }

  const TWO_QUESTIONS: PermissionRequest = {
    sessionId: 'session-1',
    requestId: 'ask-ub14-25',
    toolName: 'AskUserQuestion',
    description: 'Clarifying questions',
    type: 'ask_user',
    askUser: {
      question: 'How should I format the output?',
      options: ['Summary', 'Detailed'],
      allowFreeText: true,
      questions: [
        { question: 'How should I format the output?', header: 'Format', options: [{ label: 'Summary' }, { label: 'Detailed' }], multiSelect: false },
        { question: 'Which sections should I include?', header: 'Sections', options: [{ label: 'Introduction' }, { label: 'Conclusion' }], multiSelect: true },
      ],
    },
  }
  const LEGACY: PermissionRequest = {
    sessionId: 'session-1',
    requestId: 'ask-legacy',
    toolName: 'ask_user',
    description: 'Choose a path',
    type: 'ask_user',
    askUser: { question: 'Which path should I take?', options: ['Ship it', 'Stop'], allowFreeText: true },
  }

  /** The element tree `AskUserRequest` returns (its hooks run inside the probe's render). */
  function treeOf(request: PermissionRequest, onResponse: (answer: Answer) => void): React.ReactNode {
    let tree: React.ReactNode = null
    function Probe() {
      tree = AskUserRequest({ request, onResponse })
      return null
    }
    renderToStaticMarkup(<I18nextProvider i18n={testI18n}><Probe /></I18nextProvider>)
    return tree
  }

  /**
   * Drive the batched card: `steps[n]` runs against the tree of render pass n. A step that sets state makes
   * React render the probe again (a render-phase update), so the next step sees the updated card.
   */
  function driveBatched(request: PermissionRequest, steps: Array<(tree: React.ReactNode) => void>) {
    const calls: Answer[] = []
    const outer = treeOf(request, answer => { calls.push(answer) })
    const batched = only(outer, el => typeof el.type === 'function' && Array.isArray(el.props.questions))
    const Batched = batched.type as (props: Record<string, unknown>) => React.ReactNode
    let passes = 0
    function Probe() {
      const tree = Batched(batched.props)
      steps[passes++]?.(tree)
      return null
    }
    renderToStaticMarkup(<I18nextProvider i18n={testI18n}><Probe /></I18nextProvider>)
    return { calls, passes }
  }

  const click = (tree: React.ReactNode, label: string) => {
    const option = only(tree, el => el.type === Button && el.props['aria-pressed'] !== undefined && textOf(el) === label)
    ;(option.props.onClick as () => void)()
  }
  const submitOf = (tree: React.ReactNode): Element =>
    only(only(tree, el => el.type === DecisionActions), el => el.type === Button && el.props.variant === 'primary')

  it('POSITIVE — a card with two questions submits both answers through the primary Submit', () => {
    const { calls, passes } = driveBatched(TWO_QUESTIONS, [
      tree => {
        expect(submitOf(tree).props.disabled).toBe(true) // nothing picked yet
        click(tree, 'Summary')
        click(tree, 'Introduction')
        click(tree, 'Conclusion')
      },
      tree => {
        const submit = submitOf(tree)
        expect(textOf(submit)).toBe('Submit answers')
        expect(submit.props.disabled).toBe(false)
        ;(submit.props.onClick as () => void)()
      },
    ])
    expect(passes).toBe(2)
    expect(calls).toEqual([{
      type: 'permission',
      allowed: true,
      alwaysAllow: false,
      options: {
        askUserAnswer: {
          type: 'batched',
          answers: {
            'How should I format the output?': 'Summary',
            'Which sections should I include?': ['Introduction', 'Conclusion'],
          },
        },
      },
    }])
  })

  it('NEGATIVE (boundary) — with nothing picked Submit is disabled and sends nothing; Cancel is the ghost after the spacer', () => {
    const { calls, passes } = driveBatched(TWO_QUESTIONS, [
      tree => {
        const submit = submitOf(tree)
        expect(submit.props.disabled).toBe(true)
        ;(submit.props.onClick as () => void)() // the guard, not only the attribute
      },
    ])
    expect(passes).toBe(1)
    expect(calls).toEqual([])

    const cancelled: Answer[] = []
    const outer = treeOf(TWO_QUESTIONS, answer => { cancelled.push(answer) })
    const batched = only(outer, el => typeof el.type === 'function' && Array.isArray(el.props.questions))
    let row: React.ReactNode[] = []
    function Probe() {
      const tree = (batched.type as (props: Record<string, unknown>) => React.ReactNode)(batched.props)
      row = React.Children.toArray(only(tree, el => el.type === DecisionActions).props.children as React.ReactNode)
      return null
    }
    renderToStaticMarkup(<I18nextProvider i18n={testI18n}><Probe /></I18nextProvider>)
    expect(row.map(el => (React.isValidElement<Record<string, unknown>>(el) ? (el.type === DecisionSpacer ? 'spacer' : el.props.variant) : null)))
      .toEqual(['primary', 'spacer', 'ghost'])
    const cancel = row[2] as Element
    expect(textOf(cancel)).toBe('Cancel')
    ;(cancel.props.onClick as () => void)()
    expect(cancelled).toEqual([{ type: 'permission', allowed: false, alwaysAllow: false }])
  })

  it('the single-question card: its options are raised answers in the one grid the CDP harness reads, Send the primary, Cancel the ghost', () => {
    const calls: Answer[] = []
    const tree = treeOf(LEGACY, answer => { calls.push(answer) })
    const grid = only(tree, el => el.type === 'div' && String(el.props.className).split(' ').includes('grid') && String(el.props.className).split(' ').includes('gap-2'))
    const options = React.Children.toArray(grid.props.children as React.ReactNode) as Element[]
    expect(options.map(el => [el.type === Button, el.props.variant, textOf(el)])).toEqual([[true, 'secondary', 'Ship it'], [true, 'secondary', 'Stop']])
    ;(options[1]!.props.onClick as () => void)()
    expect(calls).toEqual([{ type: 'permission', allowed: true, alwaysAllow: false, options: { askUserAnswer: { type: 'option', value: 'Stop', optionIndex: 1 } } }])
    const send = only(tree, el => el.type === Button && el.props['aria-label'] === 'Send answer')
    expect(send.props.variant).toBe('primary')
    expect(send.props.disabled).toBe(true) // nothing typed
    const actions = React.Children.toArray(only(tree, el => el.type === DecisionActions).props.children as React.ReactNode) as Element[]
    expect(actions.map(el => (el.type === DecisionSpacer ? 'spacer' : el.props.variant))).toEqual(['spacer', 'ghost'])
  })

  it('draws the decision card: info tone and the tutorial hook, its own material standalone and none hosted, no old tinted or dashed style', () => {
    for (const request of [TWO_QUESTIONS, LEGACY]) {
      const standalone = renderAskUser(request)
      const tag = standalone.match(/<div[^>]*data-decision-tone="[^"]*"[^>]*>/)?.[0] ?? ''
      for (const part of ['data-decision-tone="info"', 'data-tutorial="ask-user-banner"', 'shadow-elev-2', 'ring-[color:var(--info-border)]']) {
        expect({ requestId: request.requestId, part, found: tag.includes(part) }).toEqual({ requestId: request.requestId, part, found: true })
      }
      expect(standalone).toContain('bg-info-tint text-info') // the 28px tile
      for (const old of ['bg-info/5', 'border-info/30', 'rounded-[8px]', 'border-dashed', 'shadow-middle', 'text-muted-foreground']) {
        expect({ requestId: request.requestId, old, found: standalone.includes(old) }).toEqual({ requestId: request.requestId, old, found: false })
      }
      const hosted = renderToStaticMarkup(
        <I18nextProvider i18n={testI18n}><AskUserRequest request={request} onResponse={() => {}} unstyled /></I18nextProvider>,
      )
      expect(hosted).not.toContain('shadow-elev-2')
      expect(hosted).toContain('data-tutorial="ask-user-banner"')
    }
  })
})
