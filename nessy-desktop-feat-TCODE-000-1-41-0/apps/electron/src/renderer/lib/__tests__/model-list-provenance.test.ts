/**
 * C3.346 — the model list's provenance, and the one thing it must not claim.
 *
 * The FIRST case is the negative control and it is deliberate: a classifier that
 * returned `builtIn` for everything would satisfy every "no time is shown"
 * expectation below while telling the user nothing, which is exactly the state
 * R1 measured (`From gateway` → 0 occurrences across 318 renderer chunks).
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isNessyGatewayConnection, NESSY_GATEWAY_BASE_URL } from '../../components/apisetup/nessy-gateway'
import { modelListProvenance } from '../model-list-provenance'

const repoFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../../../${relative}`, import.meta.url)), 'utf8')

const GATEWAY = { providerType: 'claude-runtime', baseUrl: NESSY_GATEWAY_BASE_URL } as const

describe('modelListProvenance', () => {
  it('tells the three sources apart (the control: a classifier with one answer proves nothing)', () => {
    expect(modelListProvenance(GATEWAY, isNessyGatewayConnection).kind).toBe('gateway')
    expect(modelListProvenance(
      { providerType: 'claude-runtime', baseUrl: 'https://llm.example.com/v1' },
      isNessyGatewayConnection,
    ).kind).toBe('endpoint')
    expect(modelListProvenance(undefined, isNessyGatewayConnection).kind).toBe('builtIn')
  })

  it('names the endpoint by HOST, because the line sits under a list in a drawer', () => {
    const answer = modelListProvenance(
      { providerType: 'pi_compat', baseUrl: 'https://llm.example.com/api/v1/openai-like/v1' },
      isNessyGatewayConnection,
    )
    expect(answer).toEqual({ kind: 'endpoint', host: 'llm.example.com' })
  })

  it('shows a URL it cannot parse as the user typed it rather than dropping it', () => {
    expect(modelListProvenance(
      { providerType: 'pi_compat', baseUrl: '  not a url  ' },
      isNessyGatewayConnection,
    )).toEqual({ kind: 'endpoint', host: 'not a url' })
  })

  it('carries the sync stamp when the connection has one', () => {
    expect(modelListProvenance(
      { providerType: 'pi_compat', baseUrl: 'https://llm.example.com/v1', modelsSyncedAt: 1_700_000_000_000 },
      isNessyGatewayConnection,
    )).toEqual({ kind: 'endpoint', host: 'llm.example.com', syncedAt: 1_700_000_000_000 })
  })

  /**
   * `null` is the BYO form's "not enrolled" — `useOnboarding` writes
   * `modelsSyncedAt: null` when the sync toggle is off. Read as a number it
   * would be the epoch, and the picker would say the list was last read in 1970.
   */
  it('treats a null stamp as no stamp, never as the epoch', () => {
    expect(modelListProvenance(
      { providerType: 'pi_compat', baseUrl: 'https://llm.example.com/v1', modelsSyncedAt: null },
      isNessyGatewayConnection,
    )).toEqual({ kind: 'endpoint', host: 'llm.example.com' })
  })

  /**
   * A first-party connection (an Anthropic API key, a Pi provider) has no
   * `baseUrl`, and the picker's own fallback shows `ANTHROPIC_MODELS` for it.
   * Falling through to `endpoint` would print a sentence naming nothing.
   */
  it('calls a connection with no baseUrl built-in rather than an endpoint with an empty name', () => {
    expect(modelListProvenance({ providerType: 'anthropic' }, isNessyGatewayConnection))
      .toEqual({ kind: 'builtIn' })
  })

  /**
   * DA2.12 — the gateway's own clock, and the two arms that must not be confused.
   *
   * The positive arm is second, not first, because the CONTROL is the one with
   * teeth here: a gateway connection carrying only `modelsSyncedAt` must still
   * report NO time. If the two fields were ever collapsed, that arm goes red and
   * the one below it would stay green, so the pair is what pins the decision
   * rather than either case alone.
   */
  it('does not let the BYO enrolment marker become the gateway\'s refresh clock (the control)', () => {
    expect(modelListProvenance(
      { ...GATEWAY, modelsSyncedAt: 1_700_000_000_000 },
      isNessyGatewayConnection,
    )).toEqual({ kind: 'gateway' })
  })

  it('carries the gateway catalogue stamp when the refresh service has written one', () => {
    expect(modelListProvenance(
      { ...GATEWAY, catalogueRefreshedAt: 1_700_000_000_000 },
      isNessyGatewayConnection,
    )).toEqual({ kind: 'gateway', syncedAt: 1_700_000_000_000 })
  })

  /**
   * The same `null`-is-not-the-epoch rule the BYO stamp has above, on the new
   * field: the shape WB-c publishes is `number | null | undefined`, and read as
   * a number `null` would make the picker say the catalogue was last read in
   * 1970 — on the one surface whose whole job is saying when.
   */
  it('treats a null catalogue stamp as no stamp', () => {
    expect(modelListProvenance(
      { ...GATEWAY, catalogueRefreshedAt: null },
      isNessyGatewayConnection,
    )).toEqual({ kind: 'gateway' })
  })

  /**
   * The mirror of the control above, and the reason the endpoint arm was left
   * alone: a BYO connection reports from its OWN marker, so the catalogue stamp
   * cannot start answering a question the endpoint line already answers. One
   * sentence, one source, per path.
   */
  it('leaves the endpoint arm reading its own marker, not the catalogue stamp', () => {
    expect(modelListProvenance(
      { providerType: 'pi_compat', baseUrl: 'https://llm.example.com/v1', catalogueRefreshedAt: 1_700_000_000_000 },
      isNessyGatewayConnection,
    )).toEqual({ kind: 'endpoint', host: 'llm.example.com' })
  })

  /**
   * The boundary the gateway predicate owns, driven through THIS function so the
   * two cannot be wired together wrongly: a BYO endpoint under the gateway's own
   * prefix is NOT the gateway, which is the whole-URL rule
   * `isNessyGatewayConnection`'s docblock records.
   */
  it('does not call a BYO endpoint under the gateway prefix the gateway', () => {
    expect(modelListProvenance(
      { providerType: 'claude-runtime', baseUrl: `${NESSY_GATEWAY_BASE_URL}/something-else` },
      isNessyGatewayConnection,
    ).kind).toBe('endpoint')
  })

  /**
   * C3.346's stated residue, pinned so it cannot be closed by accident.
   *
   * The gateway refresh path replaces `connection.models` and writes no
   * timestamp, and `modelsSyncedAt` must not be borrowed for one — it is the BYO
   * metadata-sync ENROLMENT marker, and stamping it there would give one model
   * list two writers. Asserted at the WRITER rather than restated here: the one
   * `updateLlmConnection` that lands a fetched catalogue must not carry the
   * field.
   *
   * WHAT THIS CASE CANNOT DO, corrected 2026-09-17 (DA2.12, WB-d). It used to
   * say that a lane closing the residue properly would make this case FAIL and
   * be told what to read. It would not: the assertion names one field, so a
   * stamp landing here under a name of its OWN leaves this case green — which is
   * right, because the shortcut is the only thing it guards. So it is not the
   * signal DA2.12 arrives on. That row's picker half is an arm BESIDE this one,
   * feeding the new field into the `gateway` arm of `modelListProvenance`, and
   * the sentence removed here would have had its lane waiting for a red that
   * cannot come. A comment asserting the behaviour of a DIFFERENT module, with
   * nothing able to falsify it — the class AGENTS.md records.
   */
  it('pins that the gateway refresh writes no modelsSyncedAt (the residue this module declines to fake)', () => {
    const refresher = repoFile('packages/server-core/src/model-fetchers/index.ts')
    const at = refresher.lastIndexOf('updateLlmConnection(slug, {\n      models: newModels,')
    expect(at, 'the catalogue-landing updateLlmConnection moved').toBeGreaterThan(-1)
    const landing = refresher.slice(at, refresher.indexOf('})', at))
    expect(landing).not.toContain('modelsSyncedAt')
    // The positive control: the field IS written on the enrolled BYO path in the
    // same file, so the absence above is a measurement and not an unread file.
    expect(refresher).toContain('modelsSyncedAt: Date.now()')
  })
})
