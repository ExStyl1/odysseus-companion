/**
 * The composer's default rotating placeholders, as KEYS (UB14.32).
 *
 * Source: v0.15.1:apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx `defaultPlaceholders`
 * (changed in v0.15.0, "A new look"; Apache-2.0). Taken: the compact (touch) layout leaves the four keyboard tips
 * out of the default rotation, where they are noise — dropped by KEY, so the rule holds in every locale.
 *
 * NOT taken: v0.15.0's `placeholderOptions`, which also filters a CALLER's list in compact mode by English
 * substrings (`'shift + tab'`, `'toggle the sidebar'`, `'focus mode'`, …). That is the filter F1.93 / D1.400 measured
 * as locale-inert and deleted; our rule stands — a compact embedding names its own placeholder (the `/btw` panel's
 * `SIDE_QUESTION_PLACEHOLDER_KEYS`). Pinned by `__tests__/compact-placeholder.test.ts`.
 *
 * Keys rather than strings so the rule is a pure function a test can drive without i18n (the `/btw` panel's own
 * shape); `FreeFormInput` maps them through `t` with the platform's modifier key for the two tips that name it.
 */

/**
 * The default rotation in upstream's order. Compact drops the four tips that name a key or chord (`shiftTab`,
 * `newLine`, `sidebar`, `focusMode`) and keeps the three that name none.
 */
export function defaultComposerPlaceholderKeys(compactMode: boolean): string[] {
  return [
    'chatInput.placeholder.workOn',
    ...(compactMode ? [] : ['chatInput.placeholder.shiftTab']),
    'chatInput.placeholder.mention',
    'chatInput.placeholder.labels',
    ...(compactMode ? [] : [
      'chatInput.placeholder.newLine',
      'chatInput.placeholder.sidebar',
      'chatInput.placeholder.focusMode',
    ]),
  ]
}
