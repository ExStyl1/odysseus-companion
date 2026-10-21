/**
 * Desktop-notification policy: when turn-completion alerts appear, and whether
 * the two alert classes beside them fire at all.
 *
 * `learn.chatgpt.com/docs/notifications.md#configure-desktop-notifications` —
 * "Open [**Settings**](codex://settings) to choose whether turn-completion
 * alerts appear never, only while ChatGPT is in the background, or always.
 * Separate controls let you turn permission and question notifications on or
 * off."
 *
 * We shipped ONE boolean where that sentence names three positions, and the
 * middle one was hard-coded: the renderer's notification path returned early on
 * `isWindowFocused` with no way to say otherwise, so the boolean could express
 * "never" and "only while in the background" and could not express "always"
 * at all.
 *
 * Pure on purpose. The main process (`apps/electron/src/main/notifications.ts`)
 * and the renderer (`hooks/useNotifications.ts`) both decide whether an alert
 * is shown, and a policy written twice is a policy that drifts.
 */

/** The page's three positions, in its own order. */
export type NotificationTiming = 'never' | 'background' | 'always'

export const NOTIFICATION_TIMINGS: readonly NotificationTiming[] = ['never', 'background', 'always']

/**
 * Position two. The behaviour the hard-coded focus check already gave everyone,
 * so it is also what the replaced boolean's `true` migrates to — never
 * "always", which nobody could have chosen and therefore nobody did.
 */
export const DEFAULT_NOTIFICATION_TIMING: NotificationTiming = 'background'

export function isNotificationTiming(value: unknown): value is NotificationTiming {
  return value === 'never' || value === 'background' || value === 'always'
}

/**
 * The three alert classes. `question` is the page's word for a prompt that asks
 * the user something rather than for permission — our `ask_user` request type;
 * `permission` is every other pending request.
 */
export type NotificationAlertKind = 'turn-completion' | 'permission' | 'question'

export interface NotificationSettings {
  /** Governs turn-completion alerts only — that is what the page's sentence scopes it to. */
  timing: NotificationTiming
  /** The page's separate control for permission notifications. */
  permissionAlerts: boolean
  /** The page's separate control for question notifications. */
  questionAlerts: boolean
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  timing: DEFAULT_NOTIFICATION_TIMING,
  permissionAlerts: true,
  questionAlerts: true,
}

/**
 * Resolve one of the three positions against window focus.
 *
 * `background` is the only position that consults focus at all, which is what
 * makes it the position the old boolean was stuck in.
 */
export function shouldNotifyAtTiming(timing: NotificationTiming, windowFocused: boolean): boolean {
  if (timing === 'never') return false
  if (timing === 'always') return true
  return !windowFocused
}

/**
 * What the replaced boolean meant, expressed in the new shape.
 *
 * `false` migrates to silence across all three classes rather than to
 * `timing: 'never'` alone: the boolean was the only switch a user had, so
 * turning it off was the only way to say "no desktop notifications", and
 * splitting it into three controls must not resurrect two of them.
 *
 * Returns `undefined` when the boolean was never written, so the caller falls
 * through to its own defaults instead of inventing an intent.
 */
export function notificationSettingsFromLegacyEnabled(
  enabled: boolean | undefined,
): NotificationSettings | undefined {
  if (enabled === undefined) return undefined
  return enabled
    ? { timing: DEFAULT_NOTIFICATION_TIMING, permissionAlerts: true, questionAlerts: true }
    : { timing: 'never', permissionAlerts: false, questionAlerts: false }
}

/**
 * Whether one alert of `kind` may be shown.
 *
 * The page gives the three positions to turn-completion alerts and says nothing
 * about WHEN permission and question alerts appear — only that they can be
 * turned on or off. Undocumented, so decided here and written down: the other
 * two keep the background-only rule they already had. A user who moves turn
 * completion to "always" is asking to be told when a turn ends, not to be
 * interrupted about a prompt already visible in the window they are looking at.
 */
export function shouldShowNotification(
  kind: NotificationAlertKind,
  settings: NotificationSettings,
  windowFocused: boolean,
): boolean {
  if (kind === 'turn-completion') return shouldNotifyAtTiming(settings.timing, windowFocused)
  const enabled = kind === 'permission' ? settings.permissionAlerts : settings.questionAlerts
  return enabled && !windowFocused
}
