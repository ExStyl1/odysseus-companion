/**
 * QK5 (C3.163, and the VISIBLE half of C3.165) — the per-session ultracode
 * toggle beside the effort control.
 *
 * Two instruments, because the row has two halves:
 *
 * 1. The VERDICT the control draws is unit-tested against the shared resolver in
 *    the composer's own vocabulary — the `ComposerCapabilities.ultracode` block
 *    the server sends — with one positive and one negative per runtime arm.
 * 2. The WIRING is asserted at source level, the instrument
 *    `learn-image-refusal-wiring.test.ts` and `BranchSwitcher.test.tsx` already
 *    use here and for the reason they record: `bun test` has no DOM and
 *    importing the component pulls a UI barrel bun cannot resolve. The
 *    assertions are about the ARGUMENTS and the gates, never about a line.
 *
 * `docs/superpowers/plans/2026-09-11-coverage-95-parity.md`, C3.163 · C3.165.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import { ultracodeControlAvailability } from '@nessy-agent/shared/agent/ultracode-mode'

const selectorSource = readFileSync(
  fileURLToPath(new URL('../CompactModelSelector.tsx', import.meta.url)),
  'utf8',
)
const composerSource = readFileSync(
  fileURLToPath(new URL('../FreeFormInput.tsx', import.meta.url)),
  'utf8',
)
const appSource = readFileSync(
  fileURLToPath(new URL('../../../../App.tsx', import.meta.url)),
  'utf8',
)

describe('what the control draws, per runtime arm', () => {
  it('claude on an xhigh-capable model: live', () => {
    expect(ultracodeControlAvailability({ mechanism: 'native-setting', modelCapable: true }))
      .toEqual({ available: true, mechanism: 'native-setting' })
  })

  it('Pi: live, and never refused for the model — the toggle buys orchestration', () => {
    expect(ultracodeControlAvailability({ mechanism: 'workflow-keyword', modelCapable: true }))
      .toEqual({ available: true, mechanism: 'workflow-keyword' })
    expect(ultracodeControlAvailability({ mechanism: 'workflow-keyword', modelCapable: false }))
      .toEqual({ available: true, mechanism: 'workflow-keyword' })
  })

  it('codex: refused, and the reason is the RUNTIME (C3.165)', () => {
    expect(ultracodeControlAvailability({ mechanism: 'unsupported', modelCapable: true }))
      .toEqual({ available: false, reason: 'runtime' })
  })

  it('claude on a model that cannot run xhigh: refused with the MODEL reason', () => {
    expect(ultracodeControlAvailability({ mechanism: 'native-setting', modelCapable: false }))
      .toEqual({ available: false, reason: 'model' })
  })
})

describe('the control itself', () => {
  it('draws NOTHING when the server sent no answer — absence is not "unsupported"', () => {
    expect(selectorSource).toContain('if (!capability) return null')
    expect(selectorSource).toContain('{ultracodeState && (')
  })

  it('is disabled and states the reason where it cannot be used', () => {
    const row = selectorSource.slice(selectorSource.indexOf("data-testid=\"ultracode-toggle\"")).slice(0, 1_600)
    expect(row).toContain('disabled={!ultracodeState.available}')
    expect(row).toContain('t(ULTRACODE_UNAVAILABLE_REASON_KEYS[ultracodeState.reason])')
    // The click is refused too, not merely greyed: a disabled attribute alone is
    // a styling claim, and the handler is what would actually write.
    expect(row).toContain('if (!ultracodeState.available) return')
  })

  it('takes its verdict from the shared resolver rather than re-spelling the ordering in TSX', () => {
    expect(selectorSource).toContain('ultracodeControlAvailability(capability)')
    // A local copy of the rule is exactly what would let the codex row start
    // saying "turn workflows on".
    expect(selectorSource).not.toContain("reason: 'runtime'")
    expect(selectorSource).not.toContain("mechanism === 'unsupported'")
  })

  it('is NOT a sixth effort level — the level vocabulary is untouched', () => {
    // UB14.30 — the rows map the levels the runtime honours (`offeredThinkingLevels`), not the global list. The
    // anchor is asserted first: an absent needle would make the slice below the last character and pass vacuously.
    const at = selectorSource.indexOf('offeredLevels.map(')
    expect(at).toBeGreaterThan(-1)
    const thinkingRows = selectorSource.slice(at)
    expect(thinkingRows.slice(0, 400)).not.toContain('ultracode')
  })
})

describe('the wiring', () => {
  it('the composer reads and writes the per-session option by this session id', () => {
    const read = composerSource.slice(composerSource.indexOf('const ultracodeEnabled = sessionId')).slice(0, 600)
    expect(read).toContain("appShellCtx?.sessionOptions.get(sessionId)?.ultracode ?? false")
    expect(read).toContain('onSessionOptionsChange(sessionId, { ultracode: next })')
    // Both props reach the control, or the row is inert in one direction.
    expect(composerSource).toContain('ultracode={ultracodeEnabled}')
    expect(composerSource).toContain('onUltracodeChange={handleUltracodeChange}')
  })

  it('App dispatches the session command and syncs the value back from the session record', () => {
    expect(appSource).toContain("{ type: 'setUltracode', enabled: updates.ultracode }")
    // Both sync paths: the per-session refresh AND the cold-start map. Missing
    // either one is the "control shows OFF while the session is ON" divergence.
    expect(appSource).toContain('ultracode: session.ultracode === true')
    expect(appSource).toContain('ultracode: s.ultracode === true')
  })
})
