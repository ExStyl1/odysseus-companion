/**
 * P6.532 (denominator C15, Q-den 72 = option b) — a codex connection can be
 * DECLARED as Bedrock, and an ambient AWS identity can never make that decision
 * for it.
 *
 * The three arms are the row's own `done_means`, in its order:
 *
 *  1. a declared-Bedrock codex connection routes there;
 *  2. a session pinned to the gateway stays pinned, on a machine whose shell
 *     exports a full AWS identity — **this is the arm the row turns on**, because
 *     option c (honour codex's own ambient AWS chain) was refused as exactly the
 *     reroute C5 exists to refuse, and because an ambient
 *     `AWS_BEARER_TOKEN_BEDROCK` ALREADY reaches the codex child today: every
 *     non-Claude child is built by spreading `process.env`, and the boot reset
 *     deliberately preserves that name (P3.346, `boot-auth-env-reset.test.ts`);
 *  3. the operator's off switch removes the card.
 *
 * `env` is handed in as a plain object rather than mutated on `process.env`: in
 * Bun 1.3.14 an assigned name can stay invisible to `{...process.env}`, and a
 * suite in this tree has already paid for that once.
 */
import { describe, expect, it } from 'bun:test'
import {
  CODEX_BEDROCK_CARD_ENV_VAR,
  CODEX_BEDROCK_MODEL_PROVIDER,
  isCodexBedrockCardEnabled,
  resolveCodexModelProvider,
} from '../llm-connections.ts'

/** Everything an ambient AWS identity can put in a shell, all at once. */
const AMBIENT_AWS = {
  AWS_BEARER_TOKEN_BEDROCK: 'ambient-bearer-token',
  AWS_PROFILE: 'ambient-profile',
  AWS_ACCESS_KEY_ID: 'AKIAAMBIENT',
  AWS_SECRET_ACCESS_KEY: 'ambient-secret',
  AWS_REGION: 'eu-central-1',
  CLAUDE_CODE_USE_BEDROCK: '1',
}

describe('P6.532 · a codex connection routes to Bedrock only when it says so', () => {
  it('routes a DECLARED Bedrock codex connection to codex\'s own provider', () => {
    expect(resolveCodexModelProvider(
      { providerType: 'codex-runtime', codexModelProvider: 'amazon-bedrock' },
      {},
    )).toBe(CODEX_BEDROCK_MODEL_PROVIDER)
  })

  it('leaves an undeclared codex connection on the loopback pin', () => {
    // `undefined` is the writer's instruction to keep writing what it wrote
    // before this row — byte-identical for every install that declares nothing.
    expect(resolveCodexModelProvider({ providerType: 'codex-runtime' }, {})).toBeUndefined()
  })

  it('answers undefined for a NON-codex connection carrying the field', () => {
    // The field means one thing. On a Pi connection nothing reads it, and
    // answering anything else would invent a second meaning.
    expect(resolveCodexModelProvider(
      { providerType: 'pi', codexModelProvider: 'amazon-bedrock' },
      {},
    )).toBeUndefined()
  })
})

describe('P6.532 · the ambient AWS chain never decides — the safety arm', () => {
  it('keeps a pinned-gateway codex session on the loopback pin with a FULL ambient AWS identity present', () => {
    expect(resolveCodexModelProvider(
      { providerType: 'codex-runtime' },
      { ...AMBIENT_AWS },
    )).toBeUndefined()
  })

  it('keeps a pinned Pi connection unmoved by the same environment', () => {
    expect(resolveCodexModelProvider({ providerType: 'pi' }, { ...AMBIENT_AWS })).toBeUndefined()
  })

  it('does not let the ambient environment ADD the declaration either', () => {
    // The inverse of the arm above, and the one a "detect it for them"
    // implementation would fail: a declared connection is the ONLY route in.
    for (const [name, value] of Object.entries(AMBIENT_AWS)) {
      expect(resolveCodexModelProvider({ providerType: 'codex-runtime' }, { [name]: value }))
        .toBeUndefined()
    }
  })
})

describe('P6.532 · the card is a disclosure the operator can switch off', () => {
  it('offers the card by default, because a runtime capability must not stay unavailable on one runtime of three', () => {
    expect(isCodexBedrockCardEnabled({})).toBe(true)
    expect(resolveCodexModelProvider(
      { providerType: 'codex-runtime', codexModelProvider: 'amazon-bedrock' },
      {},
    )).toBe(CODEX_BEDROCK_MODEL_PROVIDER)
  })

  it.each([['0'], ['false'], ['no'], ['off']])('withdraws the card at %s, so a declared connection falls back to the loopback pin', value => {
    const env = { [CODEX_BEDROCK_CARD_ENV_VAR]: value }
    expect(isCodexBedrockCardEnabled(env)).toBe(false)
    expect(resolveCodexModelProvider(
      { providerType: 'codex-runtime', codexModelProvider: 'amazon-bedrock' },
      env,
    )).toBeUndefined()
  })

  it('keeps the card for a value it cannot read, rather than withdrawing it on a typo', () => {
    expect(isCodexBedrockCardEnabled({ [CODEX_BEDROCK_CARD_ENV_VAR]: 'maybe' })).toBe(true)
  })
})
