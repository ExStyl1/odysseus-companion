/**
 * QK5 (C3.164 / C3.165) — the toggle is bound to the mechanisms that already
 * exist, and to NOTHING on the runtime that has none.
 *
 * The behaviour itself is unit-tested where the decision is made
 * (`packages/shared/src/agent/__tests__/ultracode-mode.test.ts`: one positive and
 * one negative per runtime arm). What cannot be tested there is the WIRING —
 * that the Pi arm re-uses the keyword path instead of growing a second
 * mechanism beside it, that the claude arm reaches `ChatOptions` only behind the
 * host verdict, and that codex is left alone. Those are cross-file invariants,
 * so they are read out of the sources the same way
 * `workflows/workflow-keyword.test.ts` reads the backends it makes a claim
 * about.
 *
 * `docs/superpowers/plans/2026-09-11-coverage-95-parity.md`, C3.164 · C3.165.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const sessionManagerSource = readFileSync(
  fileURLToPath(new URL('../SessionManager.ts', import.meta.url)),
  'utf8',
)

describe('Pi — one mechanism, not two (C3.164)', () => {
  test('the toggle rides the SAME expression that appends the keyword directive', () => {
    // Positive control first: the keyword path this claim is about is present.
    expect(sessionManagerSource).toContain('detectWorkflowKeywordTrigger(message, {')
    // The toggle is ORed into that same conditional, so both opt-ins append one
    // directive through one seam. A second `WORKFLOW_KEYWORD_TRIGGER_DIRECTIVE`
    // append would be the "second mechanism beside it" the owner's answer
    // refuses.
    expect(sessionManagerSource).toContain('ultracodeKeywordPath || detectWorkflowKeywordTrigger(message, {')
    const appends = sessionManagerSource.split('\n')
      .filter(line => line.includes('${WORKFLOW_KEYWORD_TRIGGER_DIRECTIVE}'))
    expect(appends).toHaveLength(1)
  })

  test('the toggle answer comes from the ONE resolver, with the workflows layer the host holds', () => {
    expect(sessionManagerSource).toContain('ultracodeTriggersWorkflowKeywordPath({')
    expect(sessionManagerSource).toContain('workflowsDisabled: this.workflowSettings.disableWorkflows')
    // NOT a fourth gate inside `detectWorkflowKeywordTrigger`: that function's
    // origin gate protects untrusted prompt TEXT, and a toggle inspects none.
    expect(sessionManagerSource).not.toContain('ultracode: managed.ultracode,\n      origin:')
  })

  test('the value is never written to disk — the vendor calls the setting session-scoped', () => {
    const setter = sessionManagerSource.slice(
      sessionManagerSource.indexOf('setSessionUltracode(sessionId: string'),
    ).slice(0, 2_000)
    expect(setter).toContain('delete managed.ultracode')
    expect(setter).not.toContain('persistSession')
  })
})

describe('claude — the native key rides ChatOptions behind the host verdict (C3.162/C3.164)', () => {
  test('`ultracode: true` is added to chatOptions only when the verdict says `native-setting`', () => {
    expect(sessionManagerSource).toContain('const ultracodeVerdict = resolveUltracodeAvailability({')
    expect(sessionManagerSource).toContain("ultracodeVerdict.mechanism === 'native-setting'")
    expect(sessionManagerSource).toContain('...(ultracodeNative ? { ultracode: true as const } : {})')
  })

  test('an untouched session still builds the pre-existing chatOptions shape', () => {
    // `undefined` when none of the three contributors has anything to say —
    // which is the byte-identical promise the row makes.
    expect(sessionManagerSource).toContain(
      'const chatOptions = workflowInvocation || options?.outputSchema || ultracodeNative',
    )
  })
})

describe('codex — nothing is written that the runtime would ignore (C3.165)', () => {
  /**
   * The ABSENCE claim, with a positive control on the same read so an empty or
   * mis-pathed file cannot pass as agreement.
   *
   * `grep -a`-equivalent: `readFileSync(..., 'utf8')` reads every byte, so a NUL
   * byte cannot silently shorten this the way a plain `grep` would.
   */
  const codexWriters = [
    '../../../../codex-responses-adapter/src/config-writer.ts',
  ] as const

  test('no codex config writer mentions ultracode, and the control proves the file was read', () => {
    for (const relative of codexWriters) {
      const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
      // Positive control: the codex fan-out key K18 names IS in this file.
      expect(source).toContain('multi_agent')
      expect(source.toLowerCase()).not.toContain('ultracode')
    }
  })
})
