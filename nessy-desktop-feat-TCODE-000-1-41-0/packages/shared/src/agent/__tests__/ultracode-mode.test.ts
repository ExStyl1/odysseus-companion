/**
 * QK5 (C3.162 / C3.164 / C3.165) — the ONE host resolver behind the composer's
 * ultracode toggle, and its three runtime arms.
 *
 * One POSITIVE case per arm and one NEGATIVE (toggle off → no key, no path
 * change, nothing written), plus the two structural properties that make the
 * resolver honest rather than merely present: the mechanism table is TOTAL over
 * the runtime vocabulary, and the keyword arm is DERIVED from
 * `WORKFLOW_KEYWORD_DISPATCH_RUNTIMES` so the two tables cannot drift.
 *
 * `docs/superpowers/plans/2026-09-11-coverage-95-parity.md`, C3.162–C3.165.
 */
import { describe, expect, test } from 'bun:test'
import {
  ULTRACODE_NATIVE_SETTING_RUNTIMES,
  ULTRACODE_UNAVAILABLE_REASON_KEYS,
  buildClaudeUltracodeSettings,
  modelSupportsUltracodeEffort,
  resolveUltracodeAvailability,
  ultracodeMechanism,
  ultracodeTriggersWorkflowKeywordPath,
  type UltracodeUnavailableReason,
} from '../ultracode-mode.ts'
import { WORKFLOW_KEYWORD_DISPATCH_RUNTIMES } from '../../workflows/workflow-keyword.ts'
import type { AgentProvider } from '../backend/types.ts'
import enLocale from '../../i18n/locales/en.json'
import ruLocale from '../../i18n/locales/ru.json'

const PROVIDERS: readonly AgentProvider[] = ['pi', 'anthropic', 'codex-runtime', 'nestor-cloud-agent']

/** An xhigh-capable model id. `clampThinkingLevelToModel` narrows Opus 4.6 and Sonnet 4.6 only. */
const XHIGH_MODEL = 'claude-opus-4-7'
/** The one family the page's per-model table narrows away from `xhigh`. */
const NO_XHIGH_MODEL = 'claude-opus-4-6'

describe('the mechanism table', () => {
  test('is TOTAL over the runtime vocabulary — every provider has an answer', () => {
    for (const provider of PROVIDERS) {
      expect(ULTRACODE_NATIVE_SETTING_RUNTIMES[provider]).toBeBoolean()
      expect(['native-setting', 'workflow-keyword', 'unsupported']).toContain(ultracodeMechanism(provider))
    }
    // The record's own key set, so a provider added to `AgentProvider` and to
    // the constant but forgotten here still fails.
    expect(Object.keys(ULTRACODE_NATIVE_SETTING_RUNTIMES).sort()).toEqual([...PROVIDERS].sort())
  })

  test('the keyword arm is DERIVED from the workflow dispatch table, not restated', () => {
    for (const provider of PROVIDERS) {
      if (ULTRACODE_NATIVE_SETTING_RUNTIMES[provider]) continue
      const expected = WORKFLOW_KEYWORD_DISPATCH_RUNTIMES[provider] === true ? 'workflow-keyword' : 'unsupported'
      expect(ultracodeMechanism(provider)).toBe(expected)
    }
  })
})

describe('claude — the vendored `ultracode` settings key (C3.162)', () => {
  test('POSITIVE: toggle ON, workflows enabled, xhigh-capable model → `ultracode: true`', () => {
    expect(resolveUltracodeAvailability({
      provider: 'anthropic',
      workflowsDisabled: false,
      model: XHIGH_MODEL,
    })).toEqual({ available: true, mechanism: 'native-setting' })
    expect(buildClaudeUltracodeSettings({ requested: true, model: XHIGH_MODEL }))
      .toEqual({ ultracode: true })
  })

  test('NEGATIVE: toggle OFF contributes NOTHING — an untouched install spawns byte-identically', () => {
    const off = buildClaudeUltracodeSettings({ requested: false, model: XHIGH_MODEL })
    expect(off).toEqual({})
    // Not `{ ultracode: false }`: `settings-reference.md#ultracode` says
    // "Default: unset, so ultracode is off", so writing `false` would overwrite
    // a `true` the user put in their own settings file.
    expect(Object.hasOwn(off, 'ultracode')).toBe(false)
  })

  test('a model that cannot run `xhigh` is refused at the last moment too', () => {
    expect(modelSupportsUltracodeEffort(NO_XHIGH_MODEL)).toBe(false)
    expect(modelSupportsUltracodeEffort(XHIGH_MODEL)).toBe(true)
    // An unknown model is not a narrow one — the same convention
    // `clampThinkingLevelToModel`'s deliberately partial table follows.
    expect(modelSupportsUltracodeEffort('pi/tgpt/deepseek-v4-flash-0731')).toBe(true)
    expect(modelSupportsUltracodeEffort(undefined)).toBe(true)

    expect(buildClaudeUltracodeSettings({ requested: true, model: NO_XHIGH_MODEL })).toEqual({})
    expect(resolveUltracodeAvailability({
      provider: 'anthropic',
      workflowsDisabled: false,
      model: NO_XHIGH_MODEL,
    })).toEqual({ available: false, reason: 'model' })
  })

  test('workflows off refuses the claude arm with the workflows reason, not the model one', () => {
    expect(resolveUltracodeAvailability({
      provider: 'anthropic',
      workflowsDisabled: true,
      model: XHIGH_MODEL,
    })).toEqual({ available: false, reason: 'workflows-off' })
  })
})

describe('Pi — the workflow keyword path that already exists (C3.164)', () => {
  test('POSITIVE: toggle ON takes the keyword path without the user typing the word', () => {
    expect(resolveUltracodeAvailability({ provider: 'pi', workflowsDisabled: false }))
      .toEqual({ available: true, mechanism: 'workflow-keyword' })
    expect(ultracodeTriggersWorkflowKeywordPath({
      provider: 'pi',
      requested: true,
      workflowsDisabled: false,
    })).toBe(true)
  })

  test('NEGATIVE: toggle OFF leaves the turn exactly as it was', () => {
    expect(ultracodeTriggersWorkflowKeywordPath({
      provider: 'pi',
      requested: false,
      workflowsDisabled: false,
    })).toBe(false)
  })

  test('workflows off closes the Pi arm too — one gate, both mechanisms', () => {
    expect(ultracodeTriggersWorkflowKeywordPath({
      provider: 'pi',
      requested: true,
      workflowsDisabled: true,
    })).toBe(false)
    expect(resolveUltracodeAvailability({ provider: 'pi', workflowsDisabled: true }))
      .toEqual({ available: false, reason: 'workflows-off' })
  })

  test('the Pi arm is NOT gated on `xhigh`: the toggle buys orchestration, not a seventh effort level', () => {
    // Nessy has no `ultracode` EFFORT level by three recorded decisions, so
    // refusing Pi on a non-xhigh model would refuse a capability it has.
    expect(resolveUltracodeAvailability({
      provider: 'pi',
      workflowsDisabled: false,
      model: NO_XHIGH_MODEL,
    })).toEqual({ available: true, mechanism: 'workflow-keyword' })
  })
})

describe('codex — honestly unavailable, never silently accepted (C3.165)', () => {
  test('POSITIVE for the honest answer: the reason is `runtime`, and it does not depend on workflows', () => {
    for (const workflowsDisabled of [false, true]) {
      expect(resolveUltracodeAvailability({ provider: 'codex-runtime', workflowsDisabled, model: XHIGH_MODEL }))
        .toEqual({ available: false, reason: 'runtime' })
    }
    // A codex session must never read "turn workflows on" — that switch changes
    // nothing there, so the reason order is load-bearing for the copy.
    expect(ULTRACODE_UNAVAILABLE_REASON_KEYS.runtime).toBe('chat.ultracode.unavailableRuntime')
  })

  test('NEGATIVE: nothing is written for codex on either arm, toggle ON or OFF', () => {
    expect(ultracodeTriggersWorkflowKeywordPath({
      provider: 'codex-runtime',
      requested: true,
      workflowsDisabled: false,
    })).toBe(false)
    expect(ultracodeMechanism('codex-runtime')).toBe('unsupported')
  })

  test('the remote agent answers the same way', () => {
    expect(ultracodeMechanism('nestor-cloud-agent')).toBe('unsupported')
    expect(resolveUltracodeAvailability({ provider: 'nestor-cloud-agent', workflowsDisabled: false }))
      .toEqual({ available: false, reason: 'runtime' })
  })
})

describe('the copy', () => {
  test('every unavailable reason has a key, and every key exists in BOTH locales', () => {
    const reasons: readonly UltracodeUnavailableReason[] = ['runtime', 'workflows-off', 'model']
    const en = enLocale as unknown as Record<string, string>
    const ru = ruLocale as unknown as Record<string, string>
    for (const reason of reasons) {
      const key = ULTRACODE_UNAVAILABLE_REASON_KEYS[reason]
      expect(typeof key).toBe('string')
      expect(en[key]).toBeString()
      expect(ru[key]).toBeString()
    }
    for (const key of ['chat.ultracode.label', 'chat.ultracode.description']) {
      expect(en[key]).toBeString()
      expect(ru[key]).toBeString()
    }
  })
})
