import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import enMessages from '../../../../../../../../../packages/shared/src/i18n/locales/en.json'
import ruMessages from '../../../../../../../../../packages/shared/src/i18n/locales/ru.json'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import type { PermissionRequest } from '../../../../../../shared/types'
import { AdminApprovalRequest, adminApprovalCardData, type AdminApprovalRequestData } from '../AdminApprovalRequest'
import { DecisionActions, DecisionBody, DecisionPreview } from '../DecisionCard'

/**
 * F1.554 (origin WJ-ay proposed row 1, 2026-09-24) — the admin-approval card's
 * visible text goes through `t()`. F1.477 (P6) translated the card's switch
 * `aria-label`, and F1.441's census catches ATTRIBUTE literals only, so the JSX
 * TEXT beside it stayed English in every locale: "Cancel" and
 * "Remember for {n} min" (the row), and — the same shape in the same file, fixed
 * in place — "Approve", the install sentence, the macOS prompt sentence, "Why:"
 * and "Impact:".
 *
 * Rendered with the REAL locale bundles, so an assertion reads what a user of
 * that language sees, not a key contract.
 */

async function i18nFor(lng: 'en' | 'ru'): Promise<I18nInstance> {
  const instance = createInstance()
  await instance.use(initReactI18next).init({
    lng,
    fallbackLng: 'en',
    resources: { en: { translation: enMessages }, ru: { translation: ruMessages } },
    interpolation: { escapeValue: false },
  })
  return instance
}

const REQUEST: AdminApprovalRequestData = {
  appName: 'Homebrew',
  reason: 'the formula writes to /usr/local',
  command: 'sudo installer -pkg Homebrew.pkg -target /',
  impact: 'a system-wide package',
  requiresSystemPrompt: true,
  rememberForMinutes: 10,
}

async function render(lng: 'en' | 'ru', request: AdminApprovalRequestData = REQUEST): Promise<string> {
  const i18n = await i18nFor(lng)
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <AdminApprovalRequest request={request} onApprove={() => {}} onCancel={() => {}} />
    </I18nextProvider>,
  )
}

/** The markup's visible text: tags dropped, entities for the two characters the copy uses decoded. */
function visibleText(markup: string): string {
  return markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
}

describe('F1.554 · the admin-approval card speaks the UI language', () => {
  test('ru: no English JSX text is left on the card', async () => {
    const text = visibleText(await render('ru'))
    for (const english of ['Cancel', 'Remember for', 'Approve', 'Installing', 'needs your Mac admin approval', 'Touch ID prompt', 'Why:', 'Impact:']) {
      expect({ english, found: text.includes(english) }).toEqual({ english, found: false })
    }
    expect(text).toContain(ruMessages['common.cancel'])
    expect(text).toContain('Запомнить на 10 мин')
    // The request's own values are shown as given — they are data, not copy.
    expect(text).toContain('Homebrew')
    expect(text).toContain(REQUEST.reason)
    expect(text).toContain(REQUEST.impact!)
  })

  test('CONTROL en: the same card reads as it always did', async () => {
    const text = visibleText(await render('en'))
    expect(text).toContain('Installing Homebrew needs your Mac admin approval.')
    expect(text).toContain("You’ll see your regular macOS password/Touch ID prompt.")
    expect(text).toContain(`Why: ${REQUEST.reason}`)
    expect(text).toContain(`Impact: ${REQUEST.impact}`)
    expect(text).toContain('Approve')
    expect(text).toContain('Cancel')
    expect(text).toContain('Remember for 10 min')
  })

  test('an app name carrying markup is shown as text, never parsed as the sentence\'s own tags', async () => {
    // The request's app name is data. Interpolated INTO a `Trans` string it would be parsed with the
    // sentence (measured on a probe: `<app>y</app>` inside the name became a second emphasised span
    // and `<1>z</1>` lost its tags); as the self-closing `<app/>` component's own child it is not.
    const appName = 'Evil <b>x</b> <app>y</app> <1>z</1>'
    for (const lng of ['en', 'ru'] as const) {
      const markup = await render(lng, { ...REQUEST, appName })
      const shown = '<span class="font-medium text-foreground">Evil &lt;b&gt;x&lt;/b&gt; &lt;app&gt;y&lt;/app&gt; &lt;1&gt;z&lt;/1&gt;</span>'
      expect({ lng, verbatim: markup.includes(shown) }).toEqual({ lng, verbatim: true })
    }
  })

  test('the app name keeps its emphasis inside the translated sentence', async () => {
    for (const lng of ['en', 'ru'] as const) {
      const markup = await render(lng)
      expect({ lng, emphasised: markup.includes('<span class="font-medium text-foreground">Homebrew</span>') }).toEqual({ lng, emphasised: true })
    }
  })
})

/**
 * F1.885 (origin WJ-crit-xx P-1, 2026-09-25) — F1.842's twin on the admin card.
 *
 * Under a readable ASK rule the admin card (`brew install --cask`, `brew upgrade --cask`,
 * `installer -pkg … -target /`) arrives as `claudeReadablePermissionAskCheckResult` (and Pi's
 * `piReadableAskOverModePrompt`) shape it: the rule sentence in `description`, the classifier's own
 * `reason` kept, NO `rememberForMinutes`, and `noAlwaysAllow` (F1.842). The card rendered `reason` and a
 * remember checkbox whatever came in — ChatDisplay defaulted the window to 10 — so the user saw a
 * "Remember for 10 min" switch the host no longer honours (F1.869) and never saw the rule that asks.
 *
 * Driven through `adminApprovalCardData`, the mapping ChatDisplay renders the card from, so the wire
 * shape is what is asserted, not a hand-built card.
 */
const RULE_SENTENCE = 'Bash requires approval by readable permission policy rule `ask-brew` (workspace scope).'

/** The request `ClaudeAgent`'s PreToolUse hook sends for `brew install --cask docker` under rule `ask-brew`. */
const ASK_RULE_WIRE = {
  requestId: 'req-ask',
  sessionId: 'session-1',
  toolName: 'Bash',
  type: 'admin_approval',
  description: RULE_SENTENCE,
  command: 'brew install --cask docker',
  appName: 'Docker',
  reason: 'Homebrew needs admin access to complete post-install steps.',
  impact: 'May install files in /Applications and system-managed directories.',
  requiresSystemPrompt: true,
  approvalTtlSeconds: 120,
  noAlwaysAllow: true,
} as PermissionRequest

/** CONTROL — the same install with no rule: `classifyAdminApproval`'s own card, lifetime named. */
const NO_RULE_WIRE = {
  ...ASK_RULE_WIRE,
  requestId: 'req-plain',
  description: 'Admin approval required for cask install: docker',
  noAlwaysAllow: undefined,
  rememberForMinutes: 10,
  commandHash: 'a'.repeat(64),
} as PermissionRequest

describe('F1.885 · the admin card under an ask rule', () => {
  test('offers no remember switch and names the rule', async () => {
    for (const lng of ['en', 'ru'] as const) {
      const markup = await render(lng, adminApprovalCardData(ASK_RULE_WIRE))
      const text = visibleText(markup)
      expect({ lng, switch: markup.includes('role="switch"') }).toEqual({ lng, switch: false })
      expect({ lng, remember: text.includes(lng === 'en' ? 'Remember for' : 'Запомнить на') }).toEqual({ lng, remember: false })
      expect({ lng, rule: text.includes(RULE_SENTENCE) }).toEqual({ lng, rule: true })
      // The classifier's own reason still reads as the card's "why".
      expect({ lng, reason: text.includes(ASK_RULE_WIRE.reason!) }).toEqual({ lng, reason: true })
    }
  })

  test('the flag alone hides the switch, even beside a named lifetime', async () => {
    const markup = await render('en', adminApprovalCardData({ ...ASK_RULE_WIRE, rememberForMinutes: 10 } as PermissionRequest))
    expect(markup.includes('role="switch"')).toBe(false)
  })

  test('a card that names no lifetime offers no switch — the host stores no window for it (F1.869)', async () => {
    const markup = await render('en', adminApprovalCardData({ ...NO_RULE_WIRE, rememberForMinutes: undefined } as PermissionRequest))
    expect(markup.includes('role="switch"')).toBe(false)
  })

  test('CONTROL: a no-rule admin card keeps its remember switch and shows no rule line', async () => {
    const markup = await render('en', adminApprovalCardData(NO_RULE_WIRE))
    const text = visibleText(markup)
    expect(markup.includes('role="switch"')).toBe(true)
    expect(text).toContain('Remember for 10 min')
    expect(text).not.toContain(NO_RULE_WIRE.description)
    expect(text).toContain(`Why: ${NO_RULE_WIRE.reason}`)
  })

  test('a card with no reason of its own shows its description once, as the "why"', async () => {
    // Pi's gate-card forwarding carries no `reason`, so the description is already the "why" line.
    const text = visibleText(await render('en', adminApprovalCardData({ ...ASK_RULE_WIRE, reason: undefined } as PermissionRequest)))
    expect(text).toContain(`Why: ${RULE_SENTENCE}`)
    expect(text.split(RULE_SENTENCE).length - 1).toBe(1)
  })
})

/**
 * UB14.23 — the admin card on v0.15.1's decision anatomy, with F1.554 / F1.869 / F1.885 re-applied.
 *
 * The ELEMENT TREE the component returns is captured by calling it inside a probe's render (its hooks run
 * as the probe's), so "the switch lives inside DecisionActions" and "Approve answers no window" are read
 * off the real elements and handlers — no DOM in this repo (the UB14.28 recipe).
 */
describe('UB14.23 · the admin card on the decision anatomy', () => {
  type Element = React.ReactElement<Record<string, unknown>>
  type Approve = { rememberForMinutes?: number }

  function findAll(node: React.ReactNode, match: (el: Element) => boolean, out: Element[] = []): Element[] {
    if (Array.isArray(node)) {
      for (const child of node) findAll(child, match, out)
      return out
    }
    if (!React.isValidElement<Record<string, unknown>>(node)) return out
    if (match(node)) out.push(node)
    findAll(node.props.children as React.ReactNode, match, out)
    return out
  }

  async function treeOf(request: AdminApprovalRequestData, onApprove: (options: Approve) => void = () => {}): Promise<React.ReactNode> {
    const i18n = await i18nFor('en')
    let tree: React.ReactNode = null
    function Probe() {
      tree = AdminApprovalRequest({ request, onApprove, onCancel: () => {} })
      return null
    }
    renderToStaticMarkup(<I18nextProvider i18n={i18n}><Probe /></I18nextProvider>)
    return tree
  }

  const actionsOf = (tree: React.ReactNode): Element => {
    const actions = findAll(tree, el => el.type === DecisionActions)
    expect(actions).toHaveLength(1)
    return actions[0]!
  }

  test('POSITIVE — a card naming its lifetime shows the remember switch INSIDE DecisionActions, after Approve (primary) and Cancel (ghost)', async () => {
    const tree = await treeOf(adminApprovalCardData(NO_RULE_WIRE))
    const actions = actionsOf(tree)
    expect(findAll(actions, el => el.type === Switch)).toHaveLength(1)
    expect(findAll(tree, el => el.type === Switch)).toHaveLength(1) // and nowhere else
    expect(findAll(actions, el => el.type === Button).map(el => el.props.variant)).toEqual(['primary', 'ghost'])
    // The command sits in the sunken mono well inside the body, not in the old bg-foreground/5 block.
    const preview = findAll(findAll(tree, el => el.type === DecisionBody)[0], el => el.type === DecisionPreview)
    expect(preview.map(el => el.props.children)).toEqual([NO_RULE_WIRE.command])
  })

  test('POSITIVE — the rendered card wears the anatomy (info tile, its own ring standalone) and none of the old material', async () => {
    const markup = await render('en', adminApprovalCardData(NO_RULE_WIRE))
    expect(markup).toContain('data-decision-tone="info"')
    expect(markup).toContain('bg-info-tint text-info')
    expect(markup).toContain('ring-[color:var(--info-border)]')
    expect(markup).toContain('bg-sunken')
    for (const old of ['bg-info/5', 'border-info/30', 'shadow-middle', 'border-dashed']) expect({ old, found: markup.includes(old) }).toEqual({ old, found: false })
  })

  test('NEGATIVE (control) — a noAlwaysAllow card draws no switch anywhere, and Approve answers no window even beside a named lifetime', async () => {
    const answers: Approve[] = []
    const tree = await treeOf(
      adminApprovalCardData({ ...ASK_RULE_WIRE, rememberForMinutes: 10 } as PermissionRequest),
      options => { answers.push(options) },
    )
    expect(findAll(tree, el => el.type === Switch)).toEqual([])
    const approve = findAll(actionsOf(tree), el => el.type === Button)[0]!
    ;(approve.props.onClick as () => void)()
    expect(answers).toEqual([{ rememberForMinutes: undefined }])
  })
})
