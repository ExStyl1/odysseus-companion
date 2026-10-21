/**
 * DA1.40 (REVIEW R-i0) — the two questions one predicate used to answer.
 *
 * `isNestorGatewayCredentialUrl` answers *"may the dp JWT ride on THIS REQUEST
 * URL"*, and its third arm accepts anything under the chat base because a chat
 * request really is a path under it. That arm is right for a request and wrong
 * for a CONNECTION: a BYO `pi_compat` card whose endpoint sits under the chat
 * base passed it, so the shared dp JWT OVERRODE the user's own key on a
 * connection that is not the gateway.
 *
 * These cases pin the split from both sides — the connection side now takes the
 * normalised whole-URL rule, and the REQUEST side is unchanged, which is the
 * control that shows the row narrowed one question and not both.
 *
 * No credential file is read: `resolveNestorGatewayJwtForPi` takes its reader as
 * a parameter and the fixture JWT is a fabricated three-segment string.
 */
import { describe, expect, it } from 'bun:test'
import {
  isUsablePiStoredCredential,
  resolveNestorGatewayJwtForPi,
} from '../pi-agent.ts'
import { isNestorGatewayCredentialUrl, NESTOR_GATEWAY_CHAT_BASE_URL } from '../../auth/nestor.ts'
import { makeTestJwt } from '../../auth/dp/__tests__/test-jwt.ts'

// DA1.50 · `getValidCreds` gates on `isUsableJwt`, so a credential fixture
// must DECODE. `makeTestJwt` is the existing maker; the value is fabricated and
// carries no real token.
const FIXTURE_JWT = makeTestJwt({ preferred_username: 'tester', sub: 'user-42' })
const readCreds = () => ({ jwt: FIXTURE_JWT })

/** The shape the review measured: a BYO endpoint UNDER the gateway's chat base. */
const BYO_UNDER_CHAT_BASE = `${NESTOR_GATEWAY_CHAT_BASE_URL}/pi_compat`
/** Under the CLI prefix but outside the chat base — BYO before this row too. */
const BYO_UNDER_CLI_PREFIX = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/byo-proxy/v1'

function pi(baseUrl?: string) {
  return { providerType: 'pi_compat' as const, ...(baseUrl === undefined ? {} : { runtime: { baseUrl } }) }
}

describe('the gateway CONNECTION rule for Pi (DA1.40)', () => {
  it('the one-click card is the gateway, with or without a trailing slash', () => {
    expect(resolveNestorGatewayJwtForPi(pi(NESTOR_GATEWAY_CHAT_BASE_URL), readCreds)).toBe(FIXTURE_JWT)
    expect(resolveNestorGatewayJwtForPi(pi(`${NESTOR_GATEWAY_CHAT_BASE_URL}/`), readCreds)).toBe(FIXTURE_JWT)
    // And the same connection refuses a stored credential, which is the other
    // half DA1.2 requires the two readers to agree on.
    expect(isUsablePiStoredCredential(pi(NESTOR_GATEWAY_CHAT_BASE_URL), 'user-own-key')).toBe(false)
  })

  it('a BYO endpoint UNDER the chat base keeps its own key and gets no dp JWT', () => {
    // THE DEFECT. Before this row `isNestorGatewayCredentialUrl`'s startsWith
    // arm made this "the gateway", so the dp JWT was attached instead of the
    // user's key — on a connection nobody signed in for.
    expect(resolveNestorGatewayJwtForPi(pi(BYO_UNDER_CHAT_BASE), readCreds)).toBeNull()
    expect(isUsablePiStoredCredential(pi(BYO_UNDER_CHAT_BASE), 'user-own-key')).toBe(true)
  })

  it('a BYO endpoint elsewhere under the CLI prefix is unchanged', () => {
    expect(resolveNestorGatewayJwtForPi(pi(BYO_UNDER_CLI_PREFIX), readCreds)).toBeNull()
    expect(isUsablePiStoredCredential(pi(BYO_UNDER_CLI_PREFIX), 'user-own-key')).toBe(true)
  })

  it('no endpoint, and an unrelated host, are not the gateway', () => {
    expect(resolveNestorGatewayJwtForPi(pi(), readCreds)).toBeNull()
    expect(resolveNestorGatewayJwtForPi(pi('https://llm-proxy.t-tech.team'), readCreds)).toBeNull()
  })
})

describe('the REQUEST-url rule is deliberately NOT narrowed (DA1.40 control)', () => {
  it('a chat request under the chat base may still carry Nestor-Token', () => {
    // `unified-network-interceptor.ts` symbol `rewriteNestorAuthHeaders` reads
    // this one. Narrowing it would stop rewriting the very chat requests the
    // gateway card makes — so the row splits the two questions rather than
    // moving both.
    expect(isNestorGatewayCredentialUrl(`${NESTOR_GATEWAY_CHAT_BASE_URL}/chat/completions`)).toBe(true)
    expect(isNestorGatewayCredentialUrl(BYO_UNDER_CHAT_BASE)).toBe(true)
    // And it still refuses everything outside the two named endpoints.
    expect(isNestorGatewayCredentialUrl(BYO_UNDER_CLI_PREFIX)).toBe(false)
  })
})
