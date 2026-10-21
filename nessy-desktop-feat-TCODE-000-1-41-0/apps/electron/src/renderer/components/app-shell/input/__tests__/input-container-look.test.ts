/**
 * UB14.27 — InputContainer is ONE raised card (v0.15.1) and decision prompts draw their ring on it.
 *
 * Instrument, and why it is source-level (R4-07 names this file so): `InputContainer` imports
 * `FreeFormInput`, whose module graph reaches `ThemeContext`'s Vite-only `import.meta.glob` — measured
 * 2026-10-16 under the lock, a static import of `../InputContainer` here threw `import.meta.glob is not a
 * function` after 111.8 s in the hook. So this file pairs the REAL tone and ring functions with the
 * container's wiring read from source; the real render of every state (freeform, permission, risky
 * permission, dark) is the playground sweep's arm in `playground/__tests__/registry-render.test.ts`.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PermissionRequest } from '../../../../../shared/types'
import type { StructuredInputState } from '../structured/types'
import { decisionRingClass } from '../structured/DecisionCard'
import { getDecisionTone } from '../structured/decision-tone'

const INPUT_DIR = join(import.meta.dir, '..')
/** Code only: block, JSX and line comments removed, so a docblock naming a retired class cannot pass or fail an arm. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const read = (rel: string) => code(readFileSync(join(INPUT_DIR, rel), 'utf8'))
const src = read('InputContainer.tsx')
/** The retired glass class, built from parts so this file is not itself a hit of the row's Done-means `rg`. */
const GLASS_SURFACE = ['composer', 'surface'].join('-')

/** The visible card's `cn(...)` call: from the `input-container` class to the closing `)}` of the call. */
function cardClassCall(source: string): string {
  const at = source.indexOf('"input-container ')
  expect(at).toBeGreaterThan(-1)
  const end = source.indexOf(')}', at)
  expect(end).toBeGreaterThan(at)
  return source.slice(at, end)
}

function permission(overrides: Partial<PermissionRequest> = {}): StructuredInputState {
  return {
    type: 'permission',
    data: {
      sessionId: 'session-a',
      requestId: 'perm-1',
      toolName: 'Bash',
      type: 'bash',
      command: 'npm run build',
      description: 'Run the build',
      ...overrides,
    },
  }
}

describe('UB14.27 — the composer card and its decision ring', () => {
  const card = cardClassCall(src)

  it('POSITIVE — a permission prompt resolves to the info ring, and the card swaps it in for the focus ring', () => {
    const tone = getDecisionTone(permission())
    expect(tone).toBe('info')
    expect(decisionRingClass(tone!)).toBe('ring-1 ring-[color:var(--info-border)]')
    // The container computes the tone from the structured state (null for freeform) …
    expect(src).toContain("const decisionTone = mode === 'freeform' ? null : getDecisionTone(structuredInput)")
    // … and the card wears the decision ring INSTEAD of the focus ring when there is one.
    expect(card).toContain('decisionTone\n            ? decisionRingClass(decisionTone)\n            : "focus-within:ring-1 focus-within:ring-focus/55"')
    // The raised card itself (v0.15.1): radius 16, raised material, elev-1 / hairline elev-0.
    expect(card).toContain('"input-container relative overflow-hidden rounded-xl bg-raised"')
    expect(card).toContain('isFocusedPanel ? "shadow-elev-1" : "shadow-elev-0"')
    // `peer/composer` on the wrapper, for the hint line under the card (UB14.33).
    expect(src).toContain('<div className="peer/composer relative">')
  })

  it('POSITIVE — a risky call (a decision-model badge) resolves to the destructive ring', () => {
    const tone = getDecisionTone(permission({ risks: ['deletes'] }))
    expect(tone).toBe('danger')
    expect(decisionRingClass(tone!)).toBe('ring-1 ring-[color:var(--destructive-border)]')
  })

  it('NEGATIVE (control) — freeform has no decision tone, so the card carries the focus ring and no decision ring', () => {
    expect(getDecisionTone(undefined)).toBeNull()
    // The freeform arm is the only place the focus ring is spelled, and no ring class is hard-coded on the card.
    expect(card.match(/focus-within:ring-focus\/55/g)).toHaveLength(1)
    expect(card).not.toContain('--info-border')
    expect(card).not.toContain('--destructive-border')
  })

  it('NEGATIVE — the glass composer is gone (Done means: the glass surface class has no reader in components)', () => {
    for (const glass of [GLASS_SURFACE, 'backdrop-blur-lg', 'bg-background/95', 'shadow-minimal', 'rounded-[8px]']) {
      expect({ glass, inContainer: src.includes(glass) }).toEqual({ glass, inContainer: false })
    }
    // FreeFormInput's standalone (non-InputContainer) surface takes v0.15.1's card too.
    const freeform = read('FreeFormInput.tsx')
    expect(freeform).not.toContain(GLASS_SURFACE)
    expect(freeform).toContain("!unstyled && 'rounded-xl bg-raised shadow-elev-2'")
  })
})

describe('UB14.27 — Keep: what the merge must not lose', () => {
  it('the workflow_launch fallback height and OUR structured-height clamp stay; composer-height is not taken', () => {
    expect(src).toContain('workflow_launch: 200,')
    expect(src).toContain('getStructuredInputMaxHeight(viewportHeight)')
    expect(src).not.toContain('composer-height')
    expect(src).not.toContain('useInputAvailableHeight')
  })

  it('reduced motion lands the height at once; the motion tokens time the swap', () => {
    expect(src).toContain("import { DURATION, EASE, prefersReducedMotion } from '@nessy-agent/ui/motion'")
    expect(src).toContain('duration: prefersReducedMotion() ? 0 : TRANSITION_DURATION')
    expect(src).toContain('const TRANSITION_DURATION = DURATION.base')
    expect(src).toContain('const TRANSITION_EASE = EASE.standard')
  })

  it('P6.208 forwarding and the no-exit-animation rule for a leaving structured layer stay', () => {
    expect(src).toContain('permissionMode={freeFormProps.permissionMode}')
    expect(src).toContain('onPermissionModeChange={forMeasuring ? undefined : freeFormProps.onPermissionModeChange}')
    expect(src).toContain("{...(mode === 'freeform' ? { exit: { opacity: 0 } } : {})}")
  })
})
