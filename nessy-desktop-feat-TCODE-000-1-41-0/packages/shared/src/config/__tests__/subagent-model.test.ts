import { describe, expect, it } from 'bun:test'
import {
  SUBAGENT_MODEL_COMPAT_ENV_VAR,
  SUBAGENT_MODEL_ENV_VAR,
  SUBAGENT_MODEL_FORCE_ENV_VAR,
  isSubagentModelOverrideForced,
  resolveSubagentModelOverride,
} from '../subagent-model.ts'

describe('resolveSubagentModelOverride', () => {
  it('is absent when unset', () => {
    expect(resolveSubagentModelOverride({})).toBeUndefined()
  })

  it('reads an alias or a full model name under either spelling', () => {
    expect(resolveSubagentModelOverride({ [SUBAGENT_MODEL_ENV_VAR]: ' haiku ' })).toBe('haiku')
    expect(resolveSubagentModelOverride({ [SUBAGENT_MODEL_COMPAT_ENV_VAR]: 'claude-opus-4-8' }))
      .toBe('claude-opus-4-8')
  })

  it('treats `inherit` as no override', () => {
    expect(resolveSubagentModelOverride({ [SUBAGENT_MODEL_ENV_VAR]: 'inherit' })).toBeUndefined()
    expect(resolveSubagentModelOverride({ [SUBAGENT_MODEL_COMPAT_ENV_VAR]: 'inherit' })).toBeUndefined()
  })

  it('treats a blank value as no override', () => {
    expect(resolveSubagentModelOverride({ [SUBAGENT_MODEL_ENV_VAR]: '   ' })).toBeUndefined()
  })

  it('lets the Nessy name win when both are set', () => {
    expect(resolveSubagentModelOverride({
      [SUBAGENT_MODEL_ENV_VAR]: 'nessy-model',
      [SUBAGENT_MODEL_COMPAT_ENV_VAR]: 'claude-model',
    })).toBe('nessy-model')
    // Including when the Nessy name is the escape hatch.
    expect(resolveSubagentModelOverride({
      [SUBAGENT_MODEL_ENV_VAR]: 'inherit',
      [SUBAGENT_MODEL_COMPAT_ENV_VAR]: 'claude-model',
    })).toBeUndefined()
  })
})

describe('isSubagentModelOverrideForced', () => {
  it('is off when unset', () => {
    expect(isSubagentModelOverrideForced({})).toBe(false)
  })

  it('reads the documented `1` and the usual truthy spellings', () => {
    for (const raw of ['1', 'true', 'YES', ' on ']) {
      expect(isSubagentModelOverrideForced({ [SUBAGENT_MODEL_FORCE_ENV_VAR]: raw }), raw).toBe(true)
    }
  })

  it('is off for a falsy or unrecognised value', () => {
    for (const raw of ['0', 'false', '', 'maybe']) {
      expect(isSubagentModelOverrideForced({ [SUBAGENT_MODEL_FORCE_ENV_VAR]: raw }), raw).toBe(false)
    }
  })

  // "If you set only `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, subagents run on the
  // main conversation's model" — so FORCE never invents a value; it only
  // decides the order, and the value stays whatever the pair resolves to.
  it('names no model of its own', () => {
    expect(resolveSubagentModelOverride({ [SUBAGENT_MODEL_FORCE_ENV_VAR]: '1' })).toBeUndefined()
  })

  // There is deliberately no Nessy spelling of the FORCE knob.
  it('has no Nessy alias', () => {
    expect(isSubagentModelOverrideForced({ NESSY_SUBAGENT_MODEL_FORCE: '1' })).toBe(false)
  })
})
