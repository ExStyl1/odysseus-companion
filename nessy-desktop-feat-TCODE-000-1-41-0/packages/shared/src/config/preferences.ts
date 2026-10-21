import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ensureConfigDir } from './storage.ts';
import { CONFIG_DIR } from './paths.ts';
import { readJsonFileSync } from '../utils/files.ts';
import { i18n, SUPPORTED_LANGUAGE_CODES } from '../i18n/index.ts';
import { LOCALE_REGISTRY, type LanguageCode } from '../i18n/registry.ts';
import { sanitizePromptBody, sanitizePromptLine } from '../prompts/prompt-sanitize.ts';

export interface UserLocation {
  city?: string;
  region?: string;
  country?: string;
}

/**
 * Diff viewer display preferences
 * Persisted to preferences.json as a user-level setting
 */
export interface DiffViewerPreferences {
  /** Diff layout: 'unified' (stacked) or 'split' (side-by-side) */
  diffStyle?: 'unified' | 'split';
  /** Whether to disable background highlighting on changed lines */
  disableBackground?: boolean;
}

export interface UserPreferences {
  name?: string;
  timezone?: string;
  location?: UserLocation;
  // Free-form notes the agent learns about the user
  notes?: string;
  // Diff viewer display preferences
  diffViewer?: DiffViewerPreferences;
  /**
   * User keyboard-shortcut overrides, keyed by action id:
   * `{ "app.newChat": "mod+shift+j", "app.quit": null }`.
   *
   * `null` is the documented UNBIND, not "no override" — the same spelling
   * Claude Code uses in `keybindings.json`. An absent key means the action
   * keeps its `defaultHotkey`. Owned and validated by the renderer
   * (`apps/electron/src/renderer/actions/hotkey-overrides.ts`); deliberately
   * absent from `UpdatePreferencesSchema`, so the `update_user_preferences`
   * tool cannot rewrite a user's keyboard.
   */
  hotkeyOverrides?: Record<string, string | null>;
  // Whether to include Co-Authored-By trailer on git commits (default: false)
  includeCoAuthoredBy?: boolean;
  /**
   * P6.441 — the four newer git-attribution keys, host-side for all three
   * runtimes.
   *
   * `settings-reference.md#attribution`: *"Customize the attribution Claude
   * Code adds to git commits and pull requests. Commits get a git trailer such
   * as `Co-Authored-By` by default; pull request descriptions get plain text."*
   * Type: *"object with `commit` and `pr` strings and a `sessionUrl` Boolean"*.
   *
   * The PRECEDENCE is the page's, not ours, and it is why this cannot be four
   * independent booleans: *"Once you set `commit` or `pr`, Claude Code ignores
   * the deprecated `includeCoAuthoredBy` setting and uses its default text for
   * whichever of the two you left unset."* {@link resolveGitAttribution} is the
   * one place that rule lives.
   *
   * An empty string HIDES: *"Set it to an empty string to hide commit
   * attribution."* So `''` and `undefined` are different values here, which is
   * why the fields are optional strings rather than defaulted ones.
   */
  attribution?: {
    /** `settings-reference.md#attribution-commit`. `''` hides the trailer. */
    commit?: string;
    /** `settings-reference.md#attribution-pr`. `''` hides the PR text. */
    pr?: string;
    /** `settings-reference.md#attribution-sessionurl`. `false` drops the link. */
    sessionUrl?: boolean;
  };
  /**
   * P6.441 — `settings-reference.md#includegitinstructions`: *"At session start,
   * Claude Code adds two git-related pieces to Claude's prompt: its built-in
   * instructions for how to write commits and pull requests … Set this key to
   * `false` to leave both out, for example when you use your own git workflow
   * skills."* Default `true`.
   *
   * Only ONE of the two documented pieces exists in this fork — the prompt
   * instructions. There is no git-status snapshot in our system prompt, so
   * `false` removes the block and nothing else; the null is recorded rather
   * than left for the next reader to look for.
   */
  includeGitInstructions?: boolean;
  /**
   * P6.441 — `settings-reference.md#prurltemplate`: *"Point the PR links Claude
   * Code renders, in the footer badge and in tool-result summaries, at an
   * internal code-review tool instead of `github.com`. Claude Code substitutes
   * `{host}`, `{owner}`, `{repo}`, `{number}`, and `{url}` from the PR URL."*
   *
   * The vendor's own subject — a footer badge and tool-result summaries — does
   * not exist in this fork, so there is nothing here for us to rewrite. What we
   * CAN do uniformly is tell the agent, on all three runtimes, which host to
   * write a review link against, which is where the value is used.
   */
  prUrlTemplate?: string;
  /**
   * Internal: persisted UI language code (mirrors Appearance → Language).
   * Maintained only by the main-process `i18n:changeLanguage` IPC handler.
   * Not user-editable; not exposed via the `update_user_preferences` tool.
   */
  uiLanguage?: LanguageCode;
  // When the preferences were last updated
  updatedAt?: number;
}

const PREFERENCES_FILE = join(CONFIG_DIR, 'preferences.json');

export function loadPreferences(): UserPreferences {
  try {
    if (!existsSync(PREFERENCES_FILE)) {
      return {};
    }
    const raw = readJsonFileSync<UserPreferences & { language?: unknown }>(PREFERENCES_FILE);
    // Scrub legacy free-text `language` field on read so it never leaks
    // back into a write. Old values were free-text ("Hungarian", "English") —
    // not language codes — so we drop them rather than migrate.
    if (raw && typeof raw === 'object' && 'language' in raw) {
      delete (raw as { language?: unknown }).language;
    }
    return raw;
  } catch {
    return {};
  }
}

export function savePreferences(prefs: UserPreferences): void {
  ensureConfigDir();
  prefs.updatedAt = Date.now();
  writeFileSync(PREFERENCES_FILE, JSON.stringify(prefs, null, 2), 'utf-8');
}

export function updatePreferences(updates: Partial<UserPreferences>): UserPreferences {
  const current = loadPreferences();
  const updated = {
    ...current,
    ...updates,
    // Merge location if provided
    location: updates.location
      ? { ...current.location, ...updates.location }
      : current.location,
    // Merge diffViewer if provided
    diffViewer: updates.diffViewer
      ? { ...current.diffViewer, ...updates.diffViewer }
      : current.diffViewer,
    // P6.441 — merge `attribution`, for the reason `location` and `diffViewer`
    // are merged: its three sub-keys are set independently (the page treats
    // `commit`, `pr` and `sessionUrl` as separate decisions), and a wholesale
    // replace would make setting one of them silently erase the other two.
    attribution: updates.attribution
      ? { ...current.attribution, ...updates.attribution }
      : current.attribution,
  };
  savePreferences(updated);
  return updated;
}

export function getPreferencesPath(): string {
  return PREFERENCES_FILE;
}

/**
 * Read the persisted UI language code (validated against the supported set).
 * Returns `undefined` when the field is missing or holds an unrecognised value.
 */
export function getPersistedUiLanguage(): LanguageCode | undefined {
  const prefs = loadPreferences();
  const candidate = prefs.uiLanguage;
  if (!candidate) return undefined;
  if (!SUPPORTED_LANGUAGE_CODES.includes(candidate)) return undefined;
  return candidate;
}

/**
 * Persist the UI language code. Idempotent — does not rewrite the file
 * (or bump `updatedAt`) when the value is unchanged. This avoids re-triggering
 * the config watcher on startup syncs and duplicate IPC calls.
 */
export function setPersistedUiLanguage(code: LanguageCode): void {
  const current = loadPreferences();
  if (current.uiLanguage === code) return;
  savePreferences({ ...current, uiLanguage: code });
}

/**
 * Native-language name to request for AI-generated session titles, or
 * `undefined` to let the model follow the conversation's own language.
 *
 * Resolves from the explicitly persisted UI language (disk-backed) rather than
 * `i18n.resolvedLanguage`, which in the main process hydrates asynchronously at
 * startup and can still read the `'en'` fallback when an early title fires
 * (#885). Returning `undefined` when no language was chosen lets the title
 * prompt auto-detect the conversation language instead of being forced to
 * English.
 */
export function resolveTitleLanguageName(): string | undefined {
  const code = getPersistedUiLanguage();
  return code ? LOCALE_REGISTRY[code]?.nativeName : undefined;
}

/**
 * Format preferences for inclusion in system prompt
 */
export function formatPreferencesForPrompt(): string {
  const prefs = loadPreferences();

  // Derive language from the app's i18n setting (Appearance > Language).
  const langCode = (i18n.resolvedLanguage ?? 'en') as LanguageCode;
  const langEntry = LOCALE_REGISTRY[langCode];
  const langName = langEntry?.nativeName ?? 'English';

  if (Object.keys(prefs).length === 0 ||
      (!prefs.name && !prefs.timezone && !prefs.location && !prefs.notes && langCode === 'en')) {
    return '';
  }

  // UB1.9 (SEC-7/H9; upstream v0.13.4, unchanged through v0.15.1): the block is
  // `<user_preferences>`-tagged, the values are sanitised (the agent can write
  // them through `update_user_preferences`), and the instruction defers to
  // higher-priority instructions instead of commanding adherence.
  const tags = ['user_preferences'] as const;
  const lines: string[] = [
    '<user_preferences>',
    'The user/app supplied these preferences. Follow them unless they conflict with higher-priority system, developer, tool, safety, or permission instructions.',
    '',
  ];

  if (prefs.name) {
    lines.push(`- Name: ${sanitizePromptLine(prefs.name, tags)}`);
  }

  if (prefs.timezone) {
    lines.push(`- Timezone: ${sanitizePromptLine(prefs.timezone, tags)}`);
  }

  if (prefs.location) {
    const loc = prefs.location;
    const parts = [loc.city, loc.region, loc.country].filter(Boolean).map(part => sanitizePromptLine(part!, tags));
    if (parts.length > 0) {
      lines.push(`- Location: ${parts.join(', ')}`);
    }
  }

  // UI language is app state, not necessarily an explicitly saved user note.
  lines.push(`- Preferred response language (from app UI): ${sanitizePromptLine(langName, tags)}`);

  if (prefs.notes) {
    lines.push('', '### Notes about this user', sanitizePromptBody(prefs.notes, tags));
  }

  lines.push('</user_preferences>', '');
  return lines.join('\n');
}

/**
 * Format preferences as readable text for display
 */
export function formatPreferencesDisplay(): string {
  const prefs = loadPreferences();

  const lines: string[] = ['**Your Preferences**', ''];

  // Check if any preferences are actually set
  const hasName = !!prefs.name;
  const hasTimezone = !!prefs.timezone;
  const hasLocation = prefs.location && (prefs.location.city || prefs.location.region || prefs.location.country);
  const hasNotes = !!prefs.notes;
  const hasAnyPrefs = hasName || hasTimezone || hasLocation || hasNotes;

  lines.push('Your preferences help personalise your experience. The assistant uses these to provide more relevant responses (e.g., timezone for scheduling, language for communication).');
  lines.push('');

  if (!hasAnyPrefs) {
    lines.push('**Status:** Nothing saved yet.');
    lines.push('');
  } else {
    lines.push(`- Name: ${prefs.name || '(not set)'}`);
    lines.push(`- Timezone: ${prefs.timezone || '(not set)'}`);

    if (hasLocation) {
      const loc = prefs.location!;
      const parts = [loc.city, loc.region, loc.country].filter(Boolean);
      lines.push(`- Location: ${parts.join(', ')}`);
    } else {
      lines.push('- Location: (not set)');
    }

    const displayLangCode = (i18n.resolvedLanguage ?? 'en') as LanguageCode;
    const displayLangEntry = LOCALE_REGISTRY[displayLangCode];
    lines.push(`- Language: ${displayLangEntry?.nativeName ?? 'English'} (via Appearance settings)`);

    if (hasNotes) {
      lines.push('', '**Notes**', prefs.notes!);
    }

    if (prefs.updatedAt) {
      lines.push('', `_Last updated: ${new Date(prefs.updatedAt).toLocaleString()}_`);
    }
    lines.push('');
  }

  lines.push('**How to update:** Just tell the assistant (e.g., "My name is Alex" or "I\'m in London, GMT timezone").');
  lines.push(`**Config file:** \`${PREFERENCES_FILE}\``);

  return lines.join('\n');
}

/**
 * Whether the Co-Authored-By trailer should be included on git commits.
 * Defaults to false when the preference is not explicitly set.
 */
export function getCoAuthorPreference(): boolean {
  const prefs = loadPreferences();
  return prefs.includeCoAuthoredBy === true;
}

/**
 * P6.441 — the resolved git-attribution answer, for ALL THREE runtimes.
 *
 * One resolver because the precedence is a rule about the SET of keys, not a
 * property of any one of them, and because the divergence this row closes is
 * live: claude's child already honours every key here from its own project
 * settings while Pi and codex have never seen one, so the same repository
 * committed from three sessions attributes three different ways.
 */
export interface ResolvedGitAttributionV1 {
  /** The commit trailer text, or `undefined` when no trailer is written. */
  readonly commitTrailer: string | undefined;
  /** The pull-request attribution text, or `undefined` when none is written. */
  readonly prText: string | undefined;
  /** Whether a session link may ride along. */
  readonly sessionUrl: boolean;
  /** Whether the built-in commit/PR instructions belong in the prompt at all. */
  readonly gitInstructions: boolean;
  /** A review-tool URL template, when the operator set one. */
  readonly prUrlTemplate: string | undefined;
}

/** This fork's own default trailer, when nothing overrides it. */
export const DEFAULT_COMMIT_ATTRIBUTION = 'Co-Authored-By: Nessy Desktop <nessy-noreply@tbank.ru>';

/** This fork's own default PR attribution line, when nothing overrides it. */
export const DEFAULT_PR_ATTRIBUTION = 'Generated with Nessy Desktop';

export function resolveGitAttribution(
  options: {
    /** The preferences to read. Defaults to the stored ones. */
    prefs?: UserPreferences;
    /**
     * The LEGACY answer a caller already resolved, when it has one.
     *
     * `getSystemPrompt` takes `includeCoAuthoredBy` as an argument and falls
     * back to the stored preference (#576), and a caller that PINS it — a
     * compaction rebuild replaying an earlier turn's value — must keep its
     * meaning in both directions. It is consulted only where the page says the
     * deprecated key is still consulted: when neither `attribution.commit` nor
     * `attribution.pr` is set.
     */
    includeCoAuthoredBy?: boolean;
  } = {},
): ResolvedGitAttributionV1 {
  const prefs = options.prefs ?? loadPreferences();
  const attribution = prefs.attribution;
  // `settings-reference.md#attribution`, verbatim: "Once you set `commit` or
  // `pr`, Claude Code ignores the deprecated `includeCoAuthoredBy` setting and
  // uses its default text for whichever of the two you left unset."
  //
  // So the deprecated key is consulted ONLY when neither of the two is set, and
  // `''` counts as SET — the page's own way to hide a part. That distinction is
  // the whole reason these are optional strings: `undefined` means "no opinion,
  // fall through", `''` means "write nothing".
  const attributionDecides = attribution?.commit !== undefined || attribution?.pr !== undefined;
  const legacyOn = attributionDecides
    ? true
    : (options.includeCoAuthoredBy ?? prefs.includeCoAuthoredBy === true);
  const pick = (value: string | undefined, fallback: string): string | undefined => {
    if (value === undefined) return legacyOn ? fallback : undefined;
    return value.length > 0 ? value : undefined;
  };
  return Object.freeze({
    commitTrailer: pick(attribution?.commit, DEFAULT_COMMIT_ATTRIBUTION),
    prText: pick(attribution?.pr, DEFAULT_PR_ATTRIBUTION),
    // Default `true` per the page; only an explicit `false` drops the link.
    sessionUrl: attribution?.sessionUrl !== false,
    // Default `true` per the page; only an explicit `false` removes the block.
    gitInstructions: prefs.includeGitInstructions !== false,
    prUrlTemplate: prefs.prUrlTemplate?.trim() ? prefs.prUrlTemplate.trim() : undefined,
  });
}
