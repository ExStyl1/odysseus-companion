import type { AgentEvent } from '@nessy-agent/core/types';

export const PREFERENCES_DRIFT_MESSAGE =
  'Note: Your preferences changed since this session started. Start a new session to apply changes.';

export interface PreferencesDriftState {
  pinnedPreferencesPrompt: string | null;
  pinnedIncludeCoAuthoredBy: boolean | null;
  preferencesDriftNotified: boolean;
}

export function evaluatePreferencesDrift(
  state: PreferencesDriftState,
  currentPreferencesPrompt: string,
  currentIncludeCoAuthoredBy: boolean
): AgentEvent | null {
  if (state.pinnedPreferencesPrompt === null) {
    state.pinnedPreferencesPrompt = currentPreferencesPrompt;
    state.pinnedIncludeCoAuthoredBy = currentIncludeCoAuthoredBy;
    return null;
  }

  if (currentPreferencesPrompt !== state.pinnedPreferencesPrompt && !state.preferencesDriftNotified) {
    state.preferencesDriftNotified = true;
    return {
      type: 'info',
      message: PREFERENCES_DRIFT_MESSAGE,
    };
  }

  return null;
}

export function resetPreferencesDriftState(state: PreferencesDriftState): void {
  state.pinnedPreferencesPrompt = null;
  state.pinnedIncludeCoAuthoredBy = null;
  state.preferencesDriftNotified = false;
}
