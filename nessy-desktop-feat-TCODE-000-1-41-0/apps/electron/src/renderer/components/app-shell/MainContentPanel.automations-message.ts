/**
 * UB4.26 (R2-12 functional half; upstream v0.15.1 `MainContentPanel.tsx`) —
 * which message the automations fallback pane shows.
 *
 * The fallback branch of the automations navigator used to render
 * `automations.noAutomationsConfigured` unconditionally, so with a populated
 * list and no automation selected the pane claimed "No automations configured"
 * right beside the list it had just denied. Upstream v0.15.1 splits the two
 * states: a non-empty list means the user simply has not picked one yet. The
 * choice is a pure function of the list length so both arms stay testable
 * without mounting the panel (the pane's look is UB14.56's).
 */
export function automationsEmptyMessageKey(
  count: number,
): 'automations.selectAutomation' | 'automations.noAutomationsConfigured' {
  return count > 0 ? 'automations.selectAutomation' : 'automations.noAutomationsConfigured'
}
