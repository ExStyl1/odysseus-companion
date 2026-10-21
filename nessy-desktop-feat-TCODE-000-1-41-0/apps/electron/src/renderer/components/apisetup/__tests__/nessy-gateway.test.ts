import { describe, it, expect } from 'bun:test'
import { canEditLlmConnection, isNessyGatewayConnection, NESSY_GATEWAY_BASE_URL } from '../nessy-gateway'

// Guards the corp-connection detector that hides credential-revealing UI
// (the settings Edit form shows the stored Nestor JWT + gateway URL).
describe('isNessyGatewayConnection', () => {
  it('matches the one-click Pi gateway connection', () => {
    expect(isNessyGatewayConnection({ providerType: 'pi_compat', baseUrl: NESSY_GATEWAY_BASE_URL })).toBe(true)
  })

  it('matches the one-click Codex gateway connection', () => {
    expect(isNessyGatewayConnection({ providerType: 'codex-runtime', baseUrl: NESSY_GATEWAY_BASE_URL })).toBe(true)
  })

  it('matches the one-click Claude Code gateway connection', () => {
    expect(isNessyGatewayConnection({ providerType: 'claude-runtime', baseUrl: NESSY_GATEWAY_BASE_URL })).toBe(true)
  })

  it('rejects a claude-runtime connection on a BYO endpoint (the user owns that form)', () => {
    expect(isNessyGatewayConnection({ providerType: 'claude-runtime', baseUrl: 'https://byo.example.test/v1' })).toBe(false)
  })

  it('rejects a pi_compat connection on a different endpoint', () => {
    expect(isNessyGatewayConnection({ providerType: 'pi_compat', baseUrl: 'https://api.example.com/v1' })).toBe(false)
  })

  it('rejects other provider types even on the gateway URL', () => {
    expect(isNessyGatewayConnection({ providerType: 'anthropic', baseUrl: NESSY_GATEWAY_BASE_URL })).toBe(false)
    expect(isNessyGatewayConnection({ providerType: 'pi', baseUrl: NESSY_GATEWAY_BASE_URL })).toBe(false)
  })

  it('rejects connections without a baseUrl', () => {
    expect(isNessyGatewayConnection({ providerType: 'pi_compat' })).toBe(false)
    expect(isNessyGatewayConnection({ providerType: 'pi_compat', baseUrl: '  ' })).toBe(false)
  })

  // C3: the renderer twin must classify exactly the way the transport does
  // (`drivers/upstream-target.ts:isNessyGatewayBaseUrl` — WHOLE-URL, normalized
  // for trailing slashes). A prefix match locks the Edit form on connections the
  // adapter treats as BYO, which is the same prefix-vs-whole-URL disagreement C2
  // fixed on the model-refresh path.
  it('matches the gateway URL with a trailing slash (normalized, same as the adapter)', () => {
    expect(isNessyGatewayConnection({
      providerType: 'codex-runtime',
      baseUrl: `${NESSY_GATEWAY_BASE_URL}/`,
    })).toBe(true)
  })

  it('does NOT match a longer URL that merely starts with the gateway URL', () => {
    expect(isNessyGatewayConnection({
      providerType: 'codex-runtime',
      baseUrl: `${NESSY_GATEWAY_BASE_URL}/proxy`,
    })).toBe(false)
    expect(isNessyGatewayConnection({
      providerType: 'claude-runtime',
      baseUrl: `${NESSY_GATEWAY_BASE_URL}1`,
    })).toBe(false)
  })

  it('leaves such a connection editable, because the adapter routes it as BYO', () => {
    expect(canEditLlmConnection({
      providerType: 'codex-runtime',
      baseUrl: `${NESSY_GATEWAY_BASE_URL}/proxy`,
    })).toBe(true)
  })

  it('marks managed cloud and corp gateway connections as non-editable', () => {
    expect(canEditLlmConnection({ providerType: 'nestor-cloud-agent' })).toBe(false)
    expect(canEditLlmConnection({ providerType: 'pi_compat', baseUrl: NESSY_GATEWAY_BASE_URL })).toBe(false)
    expect(canEditLlmConnection({ providerType: 'claude-runtime', baseUrl: NESSY_GATEWAY_BASE_URL })).toBe(false)
    expect(canEditLlmConnection({ providerType: 'pi_compat', baseUrl: 'https://api.example.com/v1' })).toBe(true)
    // BYO claude-runtime: the user supplied the endpoint and key, so the edit
    // form reveals nothing they did not type.
    expect(canEditLlmConnection({ providerType: 'claude-runtime', baseUrl: 'https://byo.example.test/v1' })).toBe(true)
  })
})
