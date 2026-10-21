import * as React from 'react'
import { beforeAll, describe, expect, test } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PermissionRequest } from '../../../../../../shared/types'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

let testI18n: I18nInstance
let WorkflowLaunchRequest: typeof import('../WorkflowLaunchRequest')['WorkflowLaunchRequest']
let StructuredInput: typeof import('../../StructuredInput')['StructuredInput']

beforeAll(async () => {
  ;({ WorkflowLaunchRequest } = await import('../WorkflowLaunchRequest'))
  ;({ StructuredInput } = await import('../../StructuredInput'))
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: {} } },
    interpolation: { escapeValue: false },
  })
}, MODULE_GRAPH_HOOK_BUDGET_MS)

function request(): PermissionRequest & { sessionId: string } {
  return {
    sessionId: 'session-a',
    requestId: 'decision-workflow-1',
    toolName: 'workflow',
    command: 'pass8-demo',
    description: 'Run the workflow "pass8-demo"? Planned phases: Audit the release. It orchestrates subagents in the background and can use substantially more tokens than one conversation.',
    type: 'workflow_launch',
  }
}

function renderCard(): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <WorkflowLaunchRequest request={request()} onRespond={() => {}} />
    </I18nextProvider>,
  )
}

describe('WorkflowLaunchRequest', () => {
  // Pass-8 live defect (a): the launch consent rendered the admin-elevation
  // template ("Admin approval required / macOS password/Touch ID").
  test('renders its own workflow template, not the admin-approval one', () => {
    const markup = renderCard()
    expect(markup).toContain('chat.workflowLaunch.title')
    expect(markup).toContain('pass8-demo')
    expect(markup).toContain('Planned phases: Audit the release')
    expect(markup).not.toContain('chat.adminApprovalRequired')
    expect(markup).not.toContain('Touch ID')
  })

  // Pass-8 live defect (c): only the generic timed remember rendered; the
  // documented control is "Yes, and don't ask again for <name> in <path>".
  test('offers Once, a durable per-project Always, and Deny', () => {
    const markup = renderCard()
    expect(markup).toContain('chat.workflowLaunch.approveOnce')
    expect(markup).toContain('chat.workflowLaunch.approveAlways')
    expect(markup).toContain('chat.workflowLaunch.deny')
    expect(markup).not.toContain('Remember for')
  })

  test('StructuredInput routes workflow_launch to the workflow card', () => {
    const markup = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <StructuredInput
          state={{ type: 'workflow_launch', data: request() }}
          onResponse={() => {}}
        />
      </I18nextProvider>,
    )
    expect(markup).toContain('chat.workflowLaunch.title')
    expect(markup).not.toContain('chat.adminApprovalRequired')
  })
})

/**
 * UB14.25 — the workflow-launch card on v0.15.1's decision anatomy, restyle only. The element tree the card
 * returns is captured inside a probe's render (the UB14.23 recipe), so the answers are its own handlers.
 * Positive: Once primary · Always secondary · spacer · Deny ghost, each sending what it sent before.
 * Negative: a workflow that declares no phases (`describeWorkflowLaunchConsent`'s "declares no phases up front"
 * line) and names no workflow still renders the refusal, and it declines exactly once.
 */
describe('UB14.25 · the workflow-launch card on the decision anatomy', () => {
  type Element = React.ReactElement<Record<string, unknown>>
  let DecisionCard: typeof import('../DecisionCard')
  let Button: typeof import('@/components/ui/button')['Button']

  beforeAll(async () => {
    DecisionCard = await import('../DecisionCard')
    ;({ Button } = await import('@/components/ui/button'))
  }, MODULE_GRAPH_HOOK_BUDGET_MS)

  const NO_PHASES: PermissionRequest & { sessionId: string } = {
    sessionId: 'session-a',
    requestId: 'decision-workflow-2',
    toolName: 'workflow',
    description: 'Run the workflow "workflow"? This workflow declares no phases up front. It orchestrates subagents in the background and can use substantially more tokens than one conversation.',
    type: 'workflow_launch',
  }

  function actionsOf(req: PermissionRequest, onRespond: (approved: boolean, always?: boolean) => void): Element[] {
    let tree: React.ReactNode = null
    function Probe() {
      tree = WorkflowLaunchRequest({ request: req, onRespond })
      return null
    }
    renderToStaticMarkup(<I18nextProvider i18n={testI18n}><Probe /></I18nextProvider>)
    const found: Element[] = []
    const walk = (node: React.ReactNode) => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (!React.isValidElement<Record<string, unknown>>(node)) return
      if (node.type === DecisionCard.DecisionActions) found.push(node)
      walk(node.props.children as React.ReactNode)
    }
    walk(tree)
    expect(found).toHaveLength(1)
    return React.Children.toArray(found[0]!.props.children as React.ReactNode) as Element[]
  }
  const shape = (row: Element[]) => row.map(el => (el.type === DecisionCard.DecisionSpacer ? 'spacer' : [el.type === Button, el.props.variant, el.props.children]))

  test('POSITIVE — Once primary · Always secondary · spacer · Deny ghost, each answer unchanged', () => {
    const calls: Array<[boolean, boolean | undefined]> = []
    const row = actionsOf(request(), (approved, always) => { calls.push([approved, always]) })
    expect(shape(row)).toEqual([
      [true, 'primary', 'chat.workflowLaunch.approveOnce'],
      [true, 'secondary', 'chat.workflowLaunch.approveAlways'],
      'spacer',
      [true, 'ghost', 'chat.workflowLaunch.deny'],
    ])
    for (const at of [0, 1, 3]) (row[at]!.props.onClick as () => void)()
    expect(calls).toEqual([[true, false], [true, true], [false, undefined]])
  })

  test('NEGATIVE — a workflow with no phases and no name still renders the refusal, and it declines once', () => {
    const calls: Array<[boolean, boolean | undefined]> = []
    const row = actionsOf(NO_PHASES, (approved, always) => { calls.push([approved, always]) })
    const deny = row.at(-1)!
    expect([deny.type === Button, deny.props.variant, deny.props.children]).toEqual([true, 'ghost', 'chat.workflowLaunch.deny'])
    ;(deny.props.onClick as () => void)()
    expect(calls).toEqual([[false, undefined]])
    const markup = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}><WorkflowLaunchRequest request={NO_PHASES} onRespond={() => {}} /></I18nextProvider>,
    )
    expect(markup).toContain('declares no phases up front')
    expect(markup).toContain('chat.workflowLaunch.deny')
  })

  test('draws the decision card: its own material standalone, none hosted, no old tinted or dashed style', () => {
    const standalone = renderCard()
    const tag = standalone.match(/<div[^>]*data-decision-tone="[^"]*"[^>]*>/)?.[0] ?? ''
    for (const part of ['data-decision-tone="info"', 'shadow-elev-2', 'ring-[color:var(--info-border)]']) expect(tag).toContain(part)
    expect(standalone).toContain('bg-info-tint text-info')
    for (const old of ['bg-info/5', 'border-info/30', 'rounded-[8px]', 'border-dashed', 'shadow-middle', 'text-muted-foreground']) {
      expect({ old, found: standalone.includes(old) }).toEqual({ old, found: false })
    }
    const hosted = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}><WorkflowLaunchRequest request={request()} onRespond={() => {}} unstyled /></I18nextProvider>,
    )
    expect(hosted).toContain('data-decision-tone="info"')
    expect(hosted).not.toContain('shadow-elev-2')
  })
})
