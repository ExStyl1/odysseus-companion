/**
 * P6.447 — nothing in the app said which base URL, credential source, provider
 * and proxy a session was actually using.
 *
 * The producer is ONE function, `describeConnectionProvenance`, because the
 * whole defect is answered twice otherwise: the settings pane translates the
 * values, the `/status` seam report renders them in English, and if the two
 * derived their own answers they would eventually disagree — which is the same
 * silent divergence the row names.
 *
 * Positive: a BYO endpoint and a verified gateway are DIFFERENT answers, and the
 * difference is the field the surface renders differently. Negative/boundary: no
 * connection at all, and no proxy at all, are each their own honest answer
 * rather than an invented one.
 *
 * Mutation probe: making `verifiedGateway` a constant turns the first block red;
 * dropping the userinfo strip turns the redaction case red.
 */

import { describe, expect, it } from 'bun:test'
import {
  describeConnectionProvenance,
  formatConnectionStatusReport,
} from '../diagnostics.ts'
import { parseSessionCommand } from '../../slash-commands/session-command.ts'

const GATEWAY = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1'

describe('describeConnectionProvenance (P6.447)', () => {
  it('distinguishes the verified gateway from a bring-your-own endpoint', () => {
    const gateway = describeConnectionProvenance({
      connection: {
        slug: 'nessy-gateway',
        name: 'Nessy Gateway',
        providerType: 'pi_compat',
        baseUrl: GATEWAY,
        authType: 'bearer_token',
      },
    })
    const byo = describeConnectionProvenance({
      connection: {
        slug: 'my-endpoint',
        name: 'My endpoint',
        providerType: 'pi_compat',
        baseUrl: 'https://example.invalid/v1',
        authType: 'api_key',
      },
    })

    expect(gateway.verifiedGateway).toBe(true)
    expect(gateway.credentialSource).toBe('stored-token')
    expect(byo.verifiedGateway).toBe(false)
    expect(byo.credentialSource).toBe('stored-api-key')
    expect(byo.baseUrl).toBe('https://example.invalid/v1')
  })

  it('answers honestly when there is no connection and no proxy', () => {
    const answer = describeConnectionProvenance({})
    expect(answer.connectionSlug).toBeNull()
    expect(answer.baseUrl).toBeNull()
    expect(answer.credentialSource).toBe('none')
    expect(answer.verifiedGateway).toBe(false)
    expect(answer.proxy).toBeNull()
  })

  it('carries the winning proxy env name and strips any userinfo from its URL', () => {
    const answer = describeConnectionProvenance({
      proxy: { name: 'HTTPS_PROXY', value: 'http://someone:hunter2@proxy.internal:3128' },
    })
    expect(answer.proxy?.name).toBe('HTTPS_PROXY')
    expect(answer.proxy?.value).toContain('proxy.internal:3128')
    expect(answer.proxy?.value).not.toContain('hunter2')
    expect(answer.proxy?.value).not.toContain('someone')
  })
})

describe('the /status seam report (P6.447)', () => {
  it('parses only the whole message, like every other seam read', () => {
    expect(parseSessionCommand('/status')?.kind).toBe('status')
    expect(parseSessionCommand('  /STATUS  ')?.kind).toBe('status')
    // Prose belongs to the model — the rule `/mcp` and `/diff` already follow.
    expect(parseSessionCommand('/status of the deploy')).toBeNull()
    expect(parseSessionCommand('what does /status show?')).toBeNull()
  })

  it('names all four facts plus the gateway/BYO distinction', () => {
    const report = formatConnectionStatusReport(describeConnectionProvenance({
      connection: {
        slug: 'my-endpoint',
        name: 'My endpoint',
        providerType: 'pi_compat',
        baseUrl: 'https://example.invalid/v1',
        authType: 'api_key',
      },
      proxy: { name: 'HTTPS_PROXY', value: 'http://proxy.internal:3128' },
    }))

    expect(report).toContain('provider:')
    expect(report).toContain('https://example.invalid/v1')
    expect(report).toContain('a stored API key')
    expect(report).toContain('HTTPS_PROXY = http://proxy.internal:3128')
    expect(report).toContain('bring-your-own endpoint')
    expect(report).not.toContain('Nestor-Token')
  })

  it('says so rather than inventing an endpoint when none is configured', () => {
    const report = formatConnectionStatusReport(describeConnectionProvenance({}))
    expect(report).toContain('none configured')
    expect(report).not.toContain('endpoint:')
  })
})
