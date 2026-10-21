import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_NOTIFICATION_TIMING,
  NOTIFICATION_TIMINGS,
  isNotificationTiming,
  notificationSettingsFromLegacyEnabled,
  shouldNotifyAtTiming,
  shouldShowNotification,
  type NotificationSettings,
} from '../notification-timing.ts'

/**
 * `learn.chatgpt.com/docs/notifications.md#configure-desktop-notifications` —
 * "Open [**Settings**](codex://settings) to choose whether turn-completion
 * alerts appear never, only while ChatGPT is in the background, or always.
 * Separate controls let you turn permission and question notifications on or
 * off."
 *
 * The whole point of these cases is the position the replaced boolean could not
 * reach: `always` while the window is focused.
 */
describe('notification timing — the page\'s three positions', () => {
  it('carries exactly the three the page names', () => {
    expect(NOTIFICATION_TIMINGS).toEqual(['never', 'background', 'always'])
  })

  it.each([
    ['never', true, false],
    ['never', false, false],
    ['background', true, false],
    ['background', false, true],
    ['always', true, true],
    ['always', false, true],
  ] as const)('%s with focused=%p resolves to %p', (timing, focused, expected) => {
    expect(shouldNotifyAtTiming(timing, focused)).toBe(expected)
  })

  it('is the only position that ignores focus in the affirmative', () => {
    // The boolean could express the other two rows of this table and not this
    // one — a focused window always meant silence.
    expect(shouldNotifyAtTiming('always', true)).toBe(true)
    expect(shouldNotifyAtTiming('background', true)).toBe(false)
  })

  it('rejects a value that is not one of the three', () => {
    expect(isNotificationTiming('background')).toBe(true)
    expect(isNotificationTiming('backgrounded')).toBe(false)
    expect(isNotificationTiming(true)).toBe(false)
    expect(isNotificationTiming(undefined)).toBe(false)
  })
})

describe('the boolean migration', () => {
  it('sends true to the position that was hard-coded, not to always', () => {
    // "always" was unreachable, so nobody chose it, so nobody may be migrated
    // into it.
    expect(notificationSettingsFromLegacyEnabled(true)).toEqual({
      timing: 'background',
      permissionAlerts: true,
      questionAlerts: true,
    })
    expect(DEFAULT_NOTIFICATION_TIMING).toBe('background')
  })

  it('sends false to silence across all three classes', () => {
    expect(notificationSettingsFromLegacyEnabled(false)).toEqual({
      timing: 'never',
      permissionAlerts: false,
      questionAlerts: false,
    })
  })

  it('reports an unwritten boolean rather than inventing an intent', () => {
    expect(notificationSettingsFromLegacyEnabled(undefined)).toBeUndefined()
  })
})

describe('the two separate alert controls', () => {
  const base: NotificationSettings = { timing: 'never', permissionAlerts: true, questionAlerts: true }

  it('does not silence permission or question alerts when timing is never', () => {
    // The page scopes the three positions to turn-completion alerts and gives
    // the other two their own controls; collapsing them back onto the timing is
    // the defect this row exists for.
    expect(shouldShowNotification('turn-completion', base, false)).toBe(false)
    expect(shouldShowNotification('permission', base, false)).toBe(true)
    expect(shouldShowNotification('question', base, false)).toBe(true)
  })

  it('turns each class off independently', () => {
    expect(shouldShowNotification('permission', { ...base, permissionAlerts: false }, false)).toBe(false)
    expect(shouldShowNotification('question', { ...base, permissionAlerts: false }, false)).toBe(true)
    expect(shouldShowNotification('question', { ...base, questionAlerts: false }, false)).toBe(false)
    expect(shouldShowNotification('permission', { ...base, questionAlerts: false }, false)).toBe(true)
  })

  it('keeps permission and question alerts background-only even at always', () => {
    // Undocumented and decided here: "always" is a statement about turn
    // completion, not a licence to interrupt about a prompt already on screen.
    const always: NotificationSettings = { ...base, timing: 'always' }
    expect(shouldShowNotification('turn-completion', always, true)).toBe(true)
    expect(shouldShowNotification('permission', always, true)).toBe(false)
    expect(shouldShowNotification('question', always, true)).toBe(false)
  })

  it('defaults both controls on', () => {
    expect(DEFAULT_NOTIFICATION_SETTINGS).toEqual({
      timing: 'background',
      permissionAlerts: true,
      questionAlerts: true,
    })
  })
})
