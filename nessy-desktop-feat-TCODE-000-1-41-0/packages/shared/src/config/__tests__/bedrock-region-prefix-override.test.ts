/**
 * P6.375 (denominator K28) — the operator's Bedrock inference-profile prefix.
 *
 * `amazon-bedrock.md#cross-region-inference-profile-prefixes`, whole sentence:
 * "Set `ANTHROPIC_BEDROCK_REGION_PREFIX` to choose the prefix Claude Code tries
 * first; when Claude Code can check profile availability and finds no matching
 * profile for a model, it falls back as described in the resolution order below.
 * Valid values are `us`, `eu`, `apac`, `jp`, `au`, and `global`. For example,
 * set it to `global` when your account has `global.` profiles enabled but Claude
 * Code would derive a geography-specific one from your AWS region."
 *
 * The row's `done_means` for this half is one sentence — "setting the prefix to
 * `global`/`jp`/`au` changes the resolved profile ids" — so the assertions below
 * are on the RESOLVED ID, not on the prefix helper's return value: a change that
 * moved the prefix and stopped threading it to `toBedrockNativeId` would pass a
 * helper-level test and ship the same silence this row exists to close.
 *
 * Env is passed as an object everywhere except the one `process.env` test, which
 * is deliberate: this is a read, not a spread, so the Bun env-slot hazard does
 * not apply — but a suite that mutates the ambient environment for every case
 * would be measuring itself.
 */
import { describe, it, expect } from 'bun:test'
import {
  BEDROCK_REGION_PREFIX_ENV_VAR,
  BEDROCK_REGION_PREFIX_OVERRIDE_VALUES,
  BEDROCK_REGION_PREFIXES,
  deriveBedrockRegionPrefix,
  readBedrockRegionPrefixOverride,
} from '../bedrock-model-ids.ts'
import { toBedrockNativeId } from '../llm-connections.ts'

const BARE = 'claude-opus-5'
const at = (env: Record<string, string | undefined>, awsRegion?: string) =>
  toBedrockNativeId(BARE, deriveBedrockRegionPrefix(awsRegion, env))

describe('P6.375 · ANTHROPIC_BEDROCK_REGION_PREFIX overrides the region-derived prefix', () => {
  it("the page's own worked example: `global` wins over a geography the region would derive", () => {
    // Control first — without the override this region derives `eu`, which is
    // the whole premise of the page's example.
    expect(at({}, 'eu-west-1')).toBe('eu.anthropic.claude-opus-5')
    expect(at({ [BEDROCK_REGION_PREFIX_ENV_VAR]: 'global' }, 'eu-west-1'))
      .toBe('global.anthropic.claude-opus-5')
  })

  it('`jp` and `au` are reachable ONLY through the override, and now they are', () => {
    // The region table has no row for either — that absence is stated in
    // `BEDROCK_REGION_PREFIX_RULES`' own header — so before this row no input
    // at all produced one of these ids. The loop is the control: every AWS
    // region shape the table classifies, and none of them lands on jp/au.
    for (const region of ['us-east-1', 'us-gov-west-1', 'eu-west-1', 'ap-northeast-1', 'sa-east-1', undefined]) {
      const derived = at({}, region)
      expect(derived, region ?? '(no region)').not.toContain('jp.')
      expect(derived, region ?? '(no region)').not.toContain('au.')
    }
    expect(at({ [BEDROCK_REGION_PREFIX_ENV_VAR]: 'jp' }, 'us-east-1'))
      .toBe('jp.anthropic.claude-opus-5')
    expect(at({ [BEDROCK_REGION_PREFIX_ENV_VAR]: 'au' }, 'us-east-1'))
      .toBe('au.anthropic.claude-opus-5')
  })

  it('every documented value resolves to its own id, and the list is the page it came from', () => {
    expect([...BEDROCK_REGION_PREFIX_OVERRIDE_VALUES])
      .toEqual(['us', 'eu', 'apac', 'jp', 'au', 'global'])
    for (const prefix of BEDROCK_REGION_PREFIX_OVERRIDE_VALUES) {
      expect(at({ [BEDROCK_REGION_PREFIX_ENV_VAR]: prefix }, 'us-east-1'), prefix)
        .toBe(`${prefix}.anthropic.claude-opus-5`)
    }
  })

  it('a value outside the list is REJECTED by name and falls back to the region table', () => {
    // The boundary. Falling through is the safe direction — the operator gets
    // the id they would have had — but it must be reportable, or the setting
    // looks applied and is not.
    const env = { [BEDROCK_REGION_PREFIX_ENV_VAR]: 'eu-west-1' }
    expect(readBedrockRegionPrefixOverride(env)).toEqual({ kind: 'rejected', value: 'eu-west-1' })
    expect(at(env, 'us-east-1')).toBe('us.anthropic.claude-opus-5')
  })

  it('`us-gov` is deliberately NOT an override value, and GovCloud still derives it', () => {
    // The documented list omits `us-gov` while the same page says GovCloud uses
    // the `us-gov.` prefix. Read-don't-invent: the enumeration is the contract,
    // so the key refuses it — and the region table hands it over anyway, which
    // is why refusing costs a GovCloud operator nothing.
    expect(BEDROCK_REGION_PREFIXES).toContain('us-gov')
    expect(BEDROCK_REGION_PREFIX_OVERRIDE_VALUES).not.toContain('us-gov')
    expect(readBedrockRegionPrefixOverride({ [BEDROCK_REGION_PREFIX_ENV_VAR]: 'us-gov' }))
      .toEqual({ kind: 'rejected', value: 'us-gov' })
    expect(at({}, 'us-gov-west-1')).toBe('us-gov.anthropic.claude-opus-5')
  })

  it('whitespace and case are tolerated; empty and unset both read as unset', () => {
    expect(readBedrockRegionPrefixOverride({ [BEDROCK_REGION_PREFIX_ENV_VAR]: '  GLOBAL  ' }))
      .toEqual({ kind: 'accepted', prefix: 'global' })
    expect(readBedrockRegionPrefixOverride({ [BEDROCK_REGION_PREFIX_ENV_VAR]: '   ' }))
      .toEqual({ kind: 'unset' })
    expect(readBedrockRegionPrefixOverride({})).toEqual({ kind: 'unset' })
  })

  it('production reads the ambient environment when no env object is passed', () => {
    // The one case that touches `process.env`: without it, every assertion above
    // would hold against a function no production caller can reach, because both
    // production call sites pass nothing.
    const saved = process.env[BEDROCK_REGION_PREFIX_ENV_VAR]
    try {
      delete process.env[BEDROCK_REGION_PREFIX_ENV_VAR]
      expect(deriveBedrockRegionPrefix('eu-west-1')).toBe('eu')
      process.env[BEDROCK_REGION_PREFIX_ENV_VAR] = 'global'
      expect(deriveBedrockRegionPrefix('eu-west-1')).toBe('global')
      expect(toBedrockNativeId(BARE, deriveBedrockRegionPrefix('eu-west-1')))
        .toBe('global.anthropic.claude-opus-5')
    } finally {
      delete process.env[BEDROCK_REGION_PREFIX_ENV_VAR]
      if (saved !== undefined) process.env[BEDROCK_REGION_PREFIX_ENV_VAR] = saved
    }
  })
})
