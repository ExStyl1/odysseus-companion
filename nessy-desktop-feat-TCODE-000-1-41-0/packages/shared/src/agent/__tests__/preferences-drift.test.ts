import { describe, expect, it } from 'bun:test';
import {
  evaluatePreferencesDrift,
  PREFERENCES_DRIFT_MESSAGE,
  resetPreferencesDriftState,
  type PreferencesDriftState,
} from '../preferences-drift.ts';

function makeState(): PreferencesDriftState {
  return {
    pinnedPreferencesPrompt: null,
    pinnedIncludeCoAuthoredBy: null,
    preferencesDriftNotified: false,
  };
}

describe('preferences drift notification', () => {
  it('pins initial preferences without emitting an event', () => {
    const state = makeState();

    expect(evaluatePreferencesDrift(state, 'initial preferences', false)).toBeNull();

    expect(state.pinnedPreferencesPrompt).toBe('initial preferences');
    expect(state.pinnedIncludeCoAuthoredBy).toBe(false);
    expect(state.preferencesDriftNotified).toBe(false);
  });

  it('emits one info event when preferences drift', () => {
    const state = makeState();
    expect(evaluatePreferencesDrift(state, 'initial preferences', false)).toBeNull();

    expect(evaluatePreferencesDrift(state, 'updated preferences', false)).toEqual({
      type: 'info',
      message: PREFERENCES_DRIFT_MESSAGE,
    });
    expect(evaluatePreferencesDrift(state, 'updated again', false)).toBeNull();

    expect(state.pinnedPreferencesPrompt).toBe('initial preferences');
    expect(state.preferencesDriftNotified).toBe(true);
  });

  it('does not emit when preferences are unchanged', () => {
    const state = makeState();
    expect(evaluatePreferencesDrift(state, 'same preferences', true)).toBeNull();
    expect(evaluatePreferencesDrift(state, 'same preferences', false)).toBeNull();
  });

  it('resets pinned state for a new session history', () => {
    const state = makeState();
    expect(evaluatePreferencesDrift(state, 'initial preferences', true)).toBeNull();

    resetPreferencesDriftState(state);

    expect(state).toEqual({
      pinnedPreferencesPrompt: null,
      pinnedIncludeCoAuthoredBy: null,
      preferencesDriftNotified: false,
    });
  });
});
