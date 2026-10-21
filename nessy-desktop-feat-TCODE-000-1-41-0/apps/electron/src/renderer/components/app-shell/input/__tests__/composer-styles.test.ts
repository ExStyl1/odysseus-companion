/**
 * UB14.20 — the composer materials (`composer-styles.ts`, v0.15.1, re-keyed to OUR six modes) and
 * the composer keycaps (`action-hotkey.ts`, v0.15.1 1:1).
 *
 * Positive: every `PERMISSION_MODE_ORDER` member has a chip tone and an icon tone, each mode keeps
 * the tone family our selector gives it today, and `composerSendKeys('cmd-enter').send` is
 * [mod, ↵]. Negative (control): a mode this build does not know (upstream's `guarded`, `ask`)
 * resolves to `default`, and no tone falls back to a palette colour or an opacity shade.
 */
import { describe, expect, it } from 'bun:test'
import { PERMISSION_MODE_ORDER, type PermissionMode } from '@nessy-agent/shared/agent/modes'
import { isMac } from '@/lib/platform'
import { COMPOSER_CHIP, COMPOSER_META_CHIP, COMPOSER_STATIC_META_CHIP, MODE_CHIP_TONE, MODE_ICON_TONE, knownMode } from '../composer-styles'
import { actionHotkeyKeys, composerSendKeys } from '../action-hotkey'

const MOD = isMac ? '⌘' : 'Ctrl'
const SHIFT = isMac ? '⇧' : 'Shift'

describe('composer-styles (UB14.20)', () => {
  it('positive: every PERMISSION_MODE_ORDER member has a chip tone and an icon tone, and nothing else is keyed', () => {
    for (const mode of PERMISSION_MODE_ORDER) {
      expect(MODE_CHIP_TONE[mode], mode).toMatch(/\S/)
      expect(MODE_ICON_TONE[mode], mode).toMatch(/\S/)
    }
    expect(Object.keys(MODE_CHIP_TONE).sort()).toEqual([...PERMISSION_MODE_ORDER].sort())
    expect(Object.keys(MODE_ICON_TONE).sort()).toEqual([...PERMISSION_MODE_ORDER].sort())
  })

  it("positive: each mode keeps today's tone family (dontAsk neutral, plan/bypass accent, default/auto info, acceptEdits success)", () => {
    const family: Record<PermissionMode, string> = {
      dontAsk: 'secondary',
      plan: 'accent',
      default: 'info',
      acceptEdits: 'success',
      auto: 'info',
      bypassPermissions: 'accent',
    }
    for (const mode of PERMISSION_MODE_ORDER) {
      expect(MODE_ICON_TONE[mode], mode).toBe(`text-${family[mode]}`)
      expect(MODE_CHIP_TONE[mode], mode).toContain(`text-${family[mode]}`)
    }
    expect(MODE_CHIP_TONE.dontAsk).toContain('bg-fill-hover')
    expect(MODE_CHIP_TONE.acceptEdits).toContain('bg-success-tint')
  })

  it('negative (control): an unknown mode resolves to default; a known one is kept', () => {
    expect(knownMode('guarded' as unknown as PermissionMode)).toBe('default')
    expect(knownMode('ask' as unknown as PermissionMode)).toBe('default') // upstream's fallback name is not ours
    expect(knownMode('toString' as unknown as PermissionMode)).toBe('default') // own keys only, never the prototype
    expect(knownMode('auto')).toBe('auto')
    expect(knownMode('dontAsk')).toBe('dontAsk')
  })

  it('UB14.55: the static meta chip is the meta chip minus its press, hover and open state — nothing else differs', () => {
    const meta = COMPOSER_META_CHIP.split(' ')
    const staticChip = COMPOSER_STATIC_META_CHIP.split(' ')
    const pressOnly = ['motion-press', 'state-overlay', 'data-[state=open]:text-foreground']
    expect(staticChip.filter(cls => !meta.includes(cls))).toEqual([])
    expect(meta.filter(cls => !staticChip.includes(cls))).toEqual(pressOnly)
  })

  it('negative (control): role utilities only — no palette colour and no opacity shade in any material', () => {
    const all = [COMPOSER_CHIP, COMPOSER_META_CHIP, COMPOSER_STATIC_META_CHIP, ...Object.values(MODE_CHIP_TONE), ...Object.values(MODE_ICON_TONE)]
    for (const cls of all) {
      expect(cls).not.toMatch(/\b(?:bg|text|ring)-(?:red|green|blue|amber|yellow|purple|cyan|gray|zinc|slate)-\d/)
      expect(cls).not.toMatch(/\b(?:bg|text)-[a-z-]+\/\d+/) // today's MODE_STYLES shape (`bg-info/10`) is gone
    }
  })
})

describe('action-hotkey (UB14.20)', () => {
  it("positive: composerSendKeys('cmd-enter') sends on [mod, ↵] and breaks a line on ↵", () => {
    expect(composerSendKeys('cmd-enter')).toEqual({ send: [MOD, '↵'], newLine: ['↵'] })
  })

  it("boundary: composerSendKeys('enter') sends on ↵ alone and breaks a line on [shift, ↵]", () => {
    expect(composerSendKeys('enter')).toEqual({ send: ['↵'], newLine: [SHIFT, '↵'] })
  })

  it('positive: actionHotkeyKeys reads the action registry (⇧Tab cycles the permission mode)', () => {
    expect(actionHotkeyKeys('chat.cyclePermissionMode')).toEqual([SHIFT, 'Tab'])
    expect(actionHotkeyKeys('app.newChat')).toEqual([MOD, 'N'])
  })
})
