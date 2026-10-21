/**
 * UB14.20 — `decision-tone.ts` (v0.15.1 verbatim; its risk arm landed first with UB6.10) and the
 * decision-card anatomy `DecisionCard.tsx` (v0.15.1 1:1) that now owns `DecisionTone`.
 *
 * Positive: a permission request carrying a known risk is `danger`, and the standalone card draws
 * the destructive ring. Negative (control): no risks, only unknown risks, and every one of our
 * extra structured types (`ask_user`, `workflow_launch`) and the outside-root / worktree /
 * file-write permission variants without risks are `info`; a card hosted by the composer slot
 * draws no material and no ring of its own.
 */
import * as React from 'react'
import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PermissionRisk } from '@nessy-agent/core/types'
import type { PermissionRequest } from '../../../../../../shared/types'
import type { StructuredInputState } from '../types'
import { getDecisionTone, knownPermissionRisks } from '../decision-tone'
import {
  DecisionActions,
  DecisionBody,
  DecisionCard,
  DecisionDetails,
  DecisionHeader,
  DecisionSpacer,
  decisionRingClass,
} from '../DecisionCard'

function permission(extra: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: 'req-1',
    toolName: 'Bash',
    command: 'rm -rf build/',
    description: 'Remove the build output',
    ...extra,
  } as PermissionRequest
}

const state = (type: StructuredInputState['type'], data: PermissionRequest): StructuredInputState => ({ type, data })

describe('getDecisionTone (UB14.20)', () => {
  it('positive: a permission request with a known risk is danger', () => {
    expect(getDecisionTone(state('permission', permission({ risks: ['deletes'] })))).toBe('danger')
  })

  it('negative (control): a permission request with no risks is info', () => {
    expect(getDecisionTone(state('permission', permission()))).toBe('info')
    expect(getDecisionTone(state('permission', permission({ risks: [] })))).toBe('info')
  })

  it('negative (control): only unknown risk names (a newer server) are dropped, so the tone stays info', () => {
    const request = permission({ risks: ['teleports' as PermissionRisk] })
    expect(knownPermissionRisks(request)).toEqual([])
    expect(getDecisionTone(state('permission', request))).toBe('info')
    expect(knownPermissionRisks(permission({ risks: ['teleports' as PermissionRisk, 'sends'] }))).toEqual(['sends'])
  })

  it('our extra structured types and permission variants without risks resolve to info; no prompt is null', () => {
    expect(getDecisionTone(state('ask_user', permission({ toolName: 'AskUserQuestion' })))).toBe('info')
    expect(getDecisionTone(state('workflow_launch', permission({ toolName: 'Workflow' })))).toBe('info')
    for (const type of ['outside_root', 'worktree_approval', 'worktree_setup', 'worktree_cleanup', 'file_write'] as const) {
      expect(getDecisionTone(state('permission', permission({ type }))), type).toBe('info')
    }
    // the same variant WITH a known risk is danger: the tone reads the risks, never the variant
    expect(getDecisionTone(state('permission', permission({ type: 'outside_root', risks: ['system'] })))).toBe('danger')
    expect(getDecisionTone(undefined)).toBeNull()
  })
})

describe('DecisionCard anatomy (UB14.20)', () => {
  const render = (node: React.ReactElement) => renderToStaticMarkup(node)

  it('positive: a standalone danger card draws its own material and the destructive ring', () => {
    const html = render(
      <DecisionCard tone="danger" standalone>
        <DecisionBody>
          <DecisionHeader tone="danger" icon={<svg />} title="Permission required" />
        </DecisionBody>
      </DecisionCard>,
    )
    expect(html).toContain('data-decision-tone="danger"')
    expect(html).toContain('bg-raised')
    expect(html).toContain('--destructive-border')
    expect(html).toContain('bg-destructive-tint') // the icon tile
    expect(decisionRingClass('info')).toContain('--info-border')
  })

  it('negative (control): a card hosted by the composer slot draws no material and no ring', () => {
    const html = render(
      <DecisionCard tone="info">
        <DecisionActions>
          <button type="button">Allow</button>
          <DecisionSpacer />
        </DecisionActions>
        <DecisionDetails>detail</DecisionDetails>
      </DecisionCard>,
    )
    expect(html).toContain('data-decision-tone="info"')
    expect(html).not.toContain('bg-raised')
    expect(html).not.toContain('--info-border')
    expect(html).toContain('@container/decision')
    expect(html).toContain('aria-hidden="true"') // the spacer is presentation only
  })
})
