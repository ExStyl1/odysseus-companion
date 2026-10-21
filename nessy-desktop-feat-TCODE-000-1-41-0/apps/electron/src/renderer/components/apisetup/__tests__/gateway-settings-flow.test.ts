import { describe, it, expect } from 'bun:test'
import {
  reduceGatewayAuthStatus,
  initialGatewayAuthState,
} from '@/hooks/useNessyGatewayAuth'
import { buildGatewaySetup } from '../gateway-one-click'

/**
 * AI settings surfaces the gateway entries through the SAME shared path as
 * onboarding: the "Add connection" button opens the OnboardingWizard at
 * provider-select (which renders the Nessy · Pi / Cloud / Codex / Claude Code
 * cards, each behind its own provider flag), and the cards route to
 * GatewayConnectStep → gateway-one-click. These tests pin the settings-relevant
 * behavior of that shared path.
 */

function runSequence(statuses: string[]) {
  return statuses.reduce(reduceGatewayAuthStatus, initialGatewayAuthState)
}

describe('gateway entry — silent vs interactive path', () => {
  it('silent path: valid creds resolve to done without ever showing waiting-browser', () => {
    // Facade status sequence when getValidCreds() short-circuits (warm path).
    const seen: string[] = []
    const statuses = ['checking', 'done']
    statuses.reduce((s, status) => {
      const next = reduceGatewayAuthStatus(s, status)
      seen.push(next.phase)
      return next
    }, initialGatewayAuthState)
    expect(seen).not.toContain('waiting-browser')
    expect(runSequence(statuses).phase).toBe('done')
  })

  it('interactive path: no creds surfaces the waiting-browser state', () => {
    const statuses = ['checking', 'waiting-browser', 'exchanging', 'done']
    const seen = statuses.map((_, i) => runSequence(statuses.slice(0, i + 1)).phase)
    expect(seen).toContain('waiting-browser')
  })
})

describe('gateway entry — shared connection builder', () => {
  it('settings creates the same payload the onboarding cards do', () => {
    // Same builder as GatewayConnectStep — one implementation for both surfaces.
    expect(buildGatewaySetup('pi', 'jwt').slug).toBe('pi-api-key')
    expect(buildGatewaySetup('codex', 'jwt').slug).toBe('codex-gateway')
    expect(buildGatewaySetup('claude', 'jwt').slug).toBe('claude-gateway')
    // D1.440, 2026-09-20 — these three asserted `toBe('jwt')` and are INVERTED,
    // not deleted: DA1.13 made the builder carry no credential at all (the
    // parameter is `_jwt`, kept only for its ordering, and the SETUP handler
    // refuses the write and deletes any snapshot an older install left). The
    // credential of record is the live `~/.nessy/dp_auth_creds.json`, read per
    // turn. The successor was already asserted next door in
    // `gateway-one-click.test.ts` for all three kinds, so this file was the
    // stale half of a pair — the shape AGENTS.md calls a default flip with no
    // instrument, where the OLD pin is the only thing still claiming the old
    // behaviour. Pinned here too, so a credential creeping back into the
    // settings payload fails on the settings surface as well.
    expect(buildGatewaySetup('pi', 'jwt').credential).toBeUndefined()
    expect(buildGatewaySetup('codex', 'jwt').credential).toBeUndefined()
    expect(buildGatewaySetup('claude', 'jwt').credential).toBeUndefined()
  })
})
