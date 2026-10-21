/**
 * Config File Watcher
 *
 * Watches configuration files for changes and triggers callbacks.
 * Uses recursive directory watching for simplicity and reliability.
 *
 * Watched paths:
 * - <CONFIG_DIR>/config.json - Main app configuration
 * - <CONFIG_DIR>/preferences.json - User preferences
 * - <CONFIG_DIR>/hooks.json - User/global lifecycle hooks
 * - <CONFIG_DIR>/theme.json - App-level theme overrides
 * - <CONFIG_DIR>/themes/*.json - Preset theme files (app-level)
 * - <CONFIG_DIR>/workspaces/{workspaceId}/ - Workspace directory (recursive)
 *   - sources/{slug}/config.json, guide.md, permissions.json
 *   - skills/{slug}/SKILL.md, icon.*
 *   - permissions.json
 *   - automations.json, hooks.json, config.json hooks
 * - <CONFIG_DIR>/sessions/{workspaceId}/{sessionId}/ - Session metadata partition
 */

import { watch, existsSync, readdirSync, statSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname, basename, relative } from 'path';
import { platform } from 'os';
import type { FSWatcher } from 'fs';
import { CONFIG_DIR } from './paths.ts';
import { debug } from '../utils/debug.ts';
import { expandPath } from '../utils/paths.ts';
import { readJsonFileSync } from '../utils/files.ts';
import { perf } from '../utils/perf.ts';
import { loadStoredConfig, type StoredConfig } from './storage.ts';
import {
  validateConfig,
  validatePreferences,
  validateSource,
  type ValidationResult,
} from './validators.ts';
import type { LoadedSource, SourceGuide } from '../sources/types.ts';
import {
  loadSource,
  loadWorkspaceSources,
  loadSourceGuide,
  sourceNeedsIconDownload,
  downloadSourceIcon,
} from '../sources/storage.ts';
import { permissionsConfigCache, getAppPermissionsDir } from '../agent/permissions-config.ts';
import { getWorkspacePath, getWorkspaceSourcesPath, getWorkspaceSkillsPath } from '../workspaces/storage.ts';
import { getWorkspaceSessionRootPath, getSessionStoragePath } from '../workspaces/paths.ts';
import { emitNativeSourceInvalidation } from '../capabilities/invalidation.ts';
import type { NativeCapabilityKind } from '../capabilities/types.ts';
import type { LoadedSkill } from '../skills/types.ts';
import { loadSkill, loadAllSkills, invalidateSkillsCache, skillNeedsIconDownload, downloadSkillIcon } from '../skills/storage.ts';
import {
  loadStatusConfig,
  statusNeedsIconDownload,
  downloadStatusIcon,
} from '../statuses/storage.ts';
import { readSessionHeader } from '../sessions/jsonl.ts';
import type { SessionHeader } from '../sessions/types.ts';
import { AUTOMATIONS_CONFIG_FILE } from '../automations/constants.ts';
import { HOOKS_CONFIG_FILE } from '../automations/hooks-config.ts';
import type { HookConfigChangeSource } from '../automations/types.ts';
import { loadAppTheme, loadPresetThemes, loadPresetTheme, getAppThemesDir } from './storage.ts';
import type { ThemeOverrides, PresetTheme } from './theme.ts';

// ============================================================
// Active Watcher Registry (duplicate detection)
// ============================================================

/**
 * Tracks active ConfigWatcher instances by workspace directory.
 * Used to detect duplicate recursive watchers on the same directory tree,
 * which can wedge Bun's event loop on Linux.
 */
const activeWatchers = new Map<string, string>(); // workspaceDir → creator workspaceId

/** Exported for testing only */
export function _getActiveWatchers(): ReadonlyMap<string, string> {
  return activeWatchers;
}

// ============================================================
// Constants
// ============================================================

const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const PREFERENCES_FILE = join(CONFIG_DIR, 'preferences.json');
/**
 * `<CONFIG_DIR>/agents` — the user scope `loadAgentDefinitions` reads (and
 * `markdownAgentRecords(join(configDir, 'agents'), globalScope)` behind the
 * capability resolver's cached snapshot, which is what a mid-session edit has
 * to invalidate).
 */
const USER_AGENTS_DIR = 'agents';

// Debounce delay in milliseconds
const DEBOUNCE_MS = 100;

// Longer debounce for session metadata on Windows where fs.watch() fires
// aggressively for atomic writes (unlink + rename = 2+ events)
const SESSION_META_DEBOUNCE_MS = platform() === 'win32' ? 300 : DEBOUNCE_MS;

// ============================================================
// Types
// ============================================================

/**
 * User preferences structure (mirrors UserPreferencesSchema)
 */
export interface UserPreferences {
  name?: string;
  timezone?: string;
  location?: {
    city?: string;
    region?: string;
    country?: string;
  };
  notes?: string;
  /** Internal: mirrors Appearance → Language. Maintained by the main-process i18n IPC handler. */
  uiLanguage?: string;
  updatedAt?: number;
}

/**
 * Callbacks for config changes
 */
export interface ConfigWatcherCallbacks {
  /** Called when config.json changes */
  onConfigChange?: (config: StoredConfig) => void;
  /** Called when preferences.json changes */
  onPreferencesChange?: (prefs: UserPreferences) => void;
  /** Called when LLM connections array changes (add/remove/update connections) */
  onLlmConnectionsChange?: (connections: import('./storage.ts').LlmConnection[]) => void;

  // Source callbacks
  /** Called when a specific source config changes (null if deleted) */
  onSourceChange?: (slug: string, source: LoadedSource | null) => void;
  /** Called when a source's guide.md changes */
  onSourceGuideChange?: (slug: string, guide: SourceGuide) => void;
  /** Called when the sources list changes (add/remove folders) */
  onSourcesListChange?: (sources: LoadedSource[]) => void;

  // Skill callbacks
  /** Called when a specific skill changes (null if deleted) */
  onSkillChange?: (slug: string, skill: LoadedSkill | null) => void;
  /** Called when the skills list changes (add/remove folders) */
  onSkillsListChange?: (skills: LoadedSkill[]) => void;

  // Permissions callbacks
  /** Called when app-level default permissions change (~/.nessy-agent/permissions/default.json) */
  onDefaultPermissionsChange?: () => void;
  /** Called when workspace permissions.json changes */
  onWorkspacePermissionsChange?: (workspaceId: string) => void;
  /** Called when a source's permissions.json changes */
  onSourcePermissionsChange?: (sourceSlug: string) => void;

  // Status callbacks
  /** Called when statuses config.json changes */
  onStatusConfigChange?: (workspaceId: string) => void;
  /** Called when a status icon file changes */
  onStatusIconChange?: (workspaceId: string, iconFilename: string) => void;

  // Label callbacks
  /** Called when labels config.json changes */
  onLabelConfigChange?: (workspaceId: string) => void;

  // Automations callbacks
  /** Called when automations.json, hooks.json, or workspace config.json hooks change */
  onAutomationsConfigChange?: (workspaceId: string) => void;
  /** Called when user/global ~/.nessy-agent/hooks.json changes */
  onUserGlobalHooksConfigChange?: () => void;

  /**
   * R73 · the `ConfigChange` hook's producer seam.
   *
   * hooks.md#configchange: "Runs when a configuration file changes during a
   * session […] ConfigChange hooks fire for changes to settings files, managed
   * policy settings, and skill files", filtered by a `source` matcher over
   * `HOOK_CONFIG_CHANGE_SOURCES` and carrying the changed `file_path`.
   *
   * ONE callback rather than a `source` argument bolted onto the five existing
   * reload callbacks: those already run reload/invalidate work, and a per-file
   * save reaches more than one of them, so hanging the emission off each would
   * double-fire a single save.
   *
   * It is a GATE, not a notification: hooks.md#configchange gives the event a
   * real block ("ConfigChange hooks can block configuration changes from taking
   * effect […] When blocked, the new settings are not applied to the running
   * session"), so the reload callback for the same file runs only when this
   * resolves truthy. Return `true` synchronously — as the no-callback path does
   * — to keep the reload on its original synchronous tick.
   *
   * `filePath` is ABSOLUTE. `policy_settings` and `local_settings` are never
   * produced here; see `HOOK_CONFIG_CHANGE_SOURCES` for why.
   */
  onSettingsSourceChange?: (
    source: HookConfigChangeSource,
    filePath: string,
  ) => Promise<boolean> | boolean;

  // Session callbacks
  /** Called when a session's JSONL header is modified externally (labels, name, flags, etc.) */
  onSessionMetadataChange?: (sessionId: string, header: SessionHeader) => void;

  // Theme callbacks (app-level only)
  /** Called when app-level theme.json changes */
  onAppThemeChange?: (theme: ThemeOverrides | null) => void;
  /** Called when a preset theme file changes (null if deleted) */
  onPresetThemeChange?: (themeId: string, theme: PresetTheme | null) => void;
  /** Called when the preset themes list changes (add/remove files) */
  onPresetThemesListChange?: (themes: PresetTheme[]) => void;

  // Error callbacks
  /** Called when a validation error occurs */
  onValidationError?: (file: string, result: ValidationResult) => void;
  /** Called when an error occurs reading/parsing a file */
  onError?: (file: string, error: Error) => void;
}

// ============================================================
// Preferences Loading
// ============================================================

/**
 * Load preferences from file
 */
export function loadPreferences(): UserPreferences | null {
  if (!existsSync(PREFERENCES_FILE)) {
    return null;
  }

  try {
    return readJsonFileSync<UserPreferences>(PREFERENCES_FILE);
  } catch (error) {
    debug('[ConfigWatcher] Error loading preferences', error);
    return null;
  }
}

// ============================================================
// ConfigWatcher Class
// ============================================================

/**
 * Watches config files and triggers callbacks on changes.
 * Uses recursive directory watching for workspace files.
 */
export class ConfigWatcher {
  private workspaceId: string;
  private callbacks: ConfigWatcherCallbacks;
  private watchers: FSWatcher[] = [];
  /**
   * C3.121 — the one watcher that may be attached LATE (when
   * `<CONFIG_DIR>/agents` is created mid-session), held separately only so the
   * attach is idempotent. It is in {@link watchers} too, so `stop()` closes it.
   */
  private appAgentsWatcher?: FSWatcher;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private isRunning = false;

  // Track known items for detecting adds/removes
  private knownSources: Set<string> = new Set();
  private knownSkills: Set<string> = new Set();
  private knownThemes: Set<string> = new Set();

  // Track LLM connections for change detection (JSON string for deep comparison)
  private lastLlmConnectionsHash: string = '';

  // Computed paths
  private workspaceDir: string;
  private sourcesDir: string;
  private skillsDir: string;

  constructor(workspaceIdOrPath: string, callbacks: ConfigWatcherCallbacks, explicitWorkspaceId?: string) {
    this.callbacks = callbacks;
    // Support both workspace ID and workspace root path
    // Paths contain '/' or '\\' (Windows) while IDs don't
    const isPath = workspaceIdOrPath.includes('/') || workspaceIdOrPath.includes('\\');
    if (isPath) {
      this.workspaceDir = expandPath(workspaceIdOrPath);
      // Prefer the explicit immutable workspace ID (W6 Step 7). The basename
      // fallback only holds while managed roots are WORKSPACES_DIR/<id> — it is
      // a derivation, not a contract, and breaks for any other layout.
      this.workspaceId = explicitWorkspaceId
        ?? (workspaceIdOrPath.split(/[/\\]/).pop() || workspaceIdOrPath);
    } else {
      this.workspaceId = explicitWorkspaceId ?? workspaceIdOrPath;
      this.workspaceDir = getWorkspacePath(workspaceIdOrPath);
    }
    this.sourcesDir = getWorkspaceSourcesPath(this.workspaceDir);
    this.skillsDir = getWorkspaceSkillsPath(this.workspaceDir);
  }

  /**
   * Get the workspace slug this watcher is scoped to
   */
  getWorkspaceSlug(): string {
    return this.workspaceId;
  }

  /**
   * Emit a typed native-source invalidation scoped to this watcher's workspace
   * (W6 Step 7). W8's unified resolver subscribes to this bus; the existing
   * per-feature callbacks stay untouched.
   */
  private emitWorkspaceInvalidation(kind: NativeCapabilityKind): void {
    emitNativeSourceInvalidation({
      kind,
      scope: { kind: 'workspace', workspaceId: this.workspaceId },
    });
  }

  /**
   * Start watching config files
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    if (!existsSync(this.workspaceDir) || !statSync(this.workspaceDir).isDirectory()) {
      throw new Error('workspace-root-unavailable');
    }

    const span = perf.span('configWatcher.start', { workspaceId: this.workspaceId });

    this.isRunning = true;

    // Detect duplicate recursive watchers on the same directory tree
    const existingOwner = activeWatchers.get(this.workspaceDir);
    if (existingOwner) {
      debug(`[ConfigWatcher] WARNING: duplicate watcher for ${this.workspaceDir} (already owned by: ${existingOwner}, new: ${this.workspaceId})`);
    }
    activeWatchers.set(this.workspaceDir, this.workspaceId);

    debug('[ConfigWatcher] Starting for workspace:', this.workspaceId);

    // Watch global config files
    this.watchGlobalConfigs();
    span.mark('watchGlobalConfigs');

    // Watch workspace directory recursively
    this.watchWorkspaceDir();
    span.mark('watchWorkspaceDir');

    // Watch this workspace's session-metadata partition (global sessions root).
    // Sessions live at SESSIONS_DIR/<workspaceId>/<sessionId>, OUTSIDE the
    // managed workspace dir, so the recursive workspace watch never sees them.
    this.watchSessionMetadataDir();
    span.mark('watchSessionMetadataDir');

    // Watch app-level themes directory
    this.watchAppThemesDir();
    span.mark('watchAppThemesDir');

    // Watch the user-scope agents directory when it already exists; the global
    // config dispatcher attaches it later if it is created mid-session.
    this.watchAppAgentsDir();
    span.mark('watchAppAgentsDir');

    // Watch app-level permissions directory
    this.watchAppPermissionsDir();
    span.mark('watchAppPermissionsDir');

    // Initial scan to populate known sources, skills, and themes
    this.scanSources();
    span.mark('scanSources');

    this.scanSkills();
    span.mark('scanSkills');

    this.scanAppThemes();
    span.mark('scanAppThemes');

    // Initialize LLM connections hash for change detection
    this.initLlmConnectionsHash();
    span.mark('initLlmConnectionsHash');

    debug('[ConfigWatcher] Started watching files');
    span.end();
  }

  /**
   * Initialize LLM connections hash for change detection
   */
  private initLlmConnectionsHash(): void {
    const config = loadStoredConfig();
    if (config) {
      const connections = config.llmConnections || [];
      this.lastLlmConnectionsHash = JSON.stringify(connections);
    }
  }

  /**
   * Manually notify the watcher of a file change.
   * Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
   * files in directories created after the watcher started.
   * See: https://github.com/oven-sh/bun/issues/15939
   * See: https://github.com/oven-sh/bun/issues/15085
   * When these are fixed, this method and its call sites can be removed.
   */
  notifyFileChange(relativePath: string): void {
    if (!this.isRunning) return;
    this.handleWorkspaceFileChange(relativePath, 'change');
  }

  /**
   * Manually notify the watcher of an app-level config file change.
   * Test/support counterpart to notifyFileChange(), which is workspace-scoped.
   */
  notifyGlobalConfigFileChange(filename: string): void {
    if (!this.isRunning) return;
    this.handleGlobalConfigFileChange(filename);
  }

  /**
   * Test/support counterpart for a change under the global session partition
   * (`<sessionId>/session.jsonl`), mirroring the session-metadata watcher.
   */
  notifySessionPartitionFileChange(relativePath: string): void {
    if (!this.isRunning) return;
    this.handleSessionPartitionFileChange(relativePath.replace(/\\/g, '/'));
  }

  /**
   * Stop watching all files
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    activeWatchers.delete(this.workspaceDir);

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Close all watchers
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];

    this.appAgentsWatcher = undefined;
    this.knownSources.clear();
    this.knownSkills.clear();
    this.knownThemes.clear();

    debug('[ConfigWatcher] Stopped');
  }

  /**
   * Watch global config files (config.json, preferences.json)
   */
  private watchGlobalConfigs(): void {
    // Ensure config directory exists
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }

    try {
      // Watch the config directory for changes to app-level config files.
      const watcher = watch(CONFIG_DIR, (eventType, filename) => {
        if (!filename) return;
        this.handleGlobalConfigFileChange(String(filename));
      });

      this.watchers.push(watcher);
      debug('[ConfigWatcher] Watching global configs:', CONFIG_DIR);
    } catch (error) {
      debug('[ConfigWatcher] Error watching global configs:', error);
    }
  }

  private handleGlobalConfigFileChange(filename: string): void {
    if (filename === 'config.json') {
      // R73 · `user_settings` — hooks.md#configchange maps that matcher to
      // "`~/.claude/settings.json` changes"; `<CONFIG_DIR>/config.json` is
      // Nessy's counterpart. `preferences.json` and `theme.json` deliberately
      // stay ungated: they are appearance/UI state, not settings a policy hook
      // is documented to audit or veto.
      this.debounce('config.json', () => this.applySettingsChange(
        'user_settings', join(CONFIG_DIR, 'config.json'), () => this.handleConfigChange(),
      ));
    } else if (filename === 'preferences.json') {
      this.debounce('preferences.json', () => this.handlePreferencesChange());
    } else if (filename === 'theme.json') {
      this.debounce('app-theme', () => this.handleAppThemeChange());
    } else if (filename === HOOKS_CONFIG_FILE) {
      this.debounce('user-global-hooks', () => this.applySettingsChange(
        'user_settings', join(CONFIG_DIR, HOOKS_CONFIG_FILE), () => this.handleUserGlobalHooksConfigChange(),
      ));
    } else if (filename === USER_AGENTS_DIR || filename.startsWith(`${USER_AGENTS_DIR}/`)) {
      // C3.121 (QH12 = A, owner 2026-09-11) — the user scope of the agent
      // definitions, which had no arm here at all while the project scope was
      // already served by `project-capability-watcher.ts`'s `WATCHED_PROJECT_DIRS`.
      //
      // MEASURED on this rig (macOS, bun 1.3.14) before it was written, because
      // the obvious assumption is wrong in both directions: a non-recursive
      // `watch(CONFIG_DIR)` over a directory created and then filled reports
      // exactly ONE event, `rename:agents`, and NOTHING for a file created or
      // modified inside it. So this arm alone cannot see an edit under an
      // existing `agents/`, and the directory watcher below is the half that
      // can — this arm's job is to ATTACH it the moment the directory appears
      // mid-session, which is the case the row names. The `agents/<file>`
      // spelling is accepted too: `notifyGlobalConfigFileChange` is the seam
      // that stands in for the platforms which do report a nested path.
      //
      // Deliberately NOT gated through `applySettingsChange`: hooks.md#configchange
      // scopes the event to "settings files, managed policy settings, and skill
      // files", and an agent definition is none of the three — the same reason
      // `preferences.json` and `theme.json` stay ungated two arms up.
      this.watchAppAgentsDir();
      this.debounce('user-agents', () => this.handleUserAgentsChange());
    }
  }

  /**
   * Watch workspace directory recursively
   */
  private watchWorkspaceDir(): void {
    debug('[ConfigWatcher] Setting up workspace watcher for:', this.workspaceDir);
    try {
      const watcher = watch(this.workspaceDir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;

        // Normalize path separators
        const normalizedPath = filename.replace(/\\/g, '/');
        this.handleWorkspaceFileChange(normalizedPath, eventType);
      });

      this.watchers.push(watcher);
      debug('[ConfigWatcher] Watching workspace recursively:', this.workspaceDir);
    } catch (error) {
      debug('[ConfigWatcher] Error watching workspace directory:', error);
    }
  }

  /**
   * Handle a file change within the workspace directory
   */
  private handleWorkspaceFileChange(relativePath: string, eventType: string): void {
    const parts = relativePath.split('/');

    // Workspace-level permissions.json
    if (relativePath === 'permissions.json') {
      // R73 · `project_settings` — hooks.md#configchange maps that matcher to
      // "`.claude/settings.json` changes", i.e. the workspace-scoped settings
      // layer. Nessy splits that layer across four files; all four report the
      // same documented source and are told apart by `file_path`.
      this.debounce('workspace-permissions', () => this.applySettingsChange(
        'project_settings', join(this.workspaceDir, 'permissions.json'),
        () => this.handleWorkspacePermissionsChange(),
      ));
      return;
    }

    // Workspace-level automations and lifecycle hook config files
    if (relativePath === AUTOMATIONS_CONFIG_FILE || relativePath === HOOKS_CONFIG_FILE || relativePath === 'config.json') {
      debug('[ConfigWatcher] automations/hooks config change detected:', relativePath);
      // The debounce key is shared across the three files on purpose (one
      // reload covers all of them), so the LAST file touched inside the window
      // is the one reported on `file_path` — the same coalescing the reload
      // itself has always done, not a new approximation.
      const changedPath = join(this.workspaceDir, relativePath);
      this.debounce('automations-config', () => this.applySettingsChange(
        'project_settings', changedPath, () => this.handleAutomationsConfigChange(),
      ));
      return;
    }

    // Sources changes: sources/{slug}/...
    if (parts[0] === 'sources' && parts.length >= 2) {
      const slug = parts[1]!;  // Safe: checked parts.length >= 2
      const file = parts[2];

      // Directory-level changes (new/removed source folders)
      if (parts.length === 2) {
        this.debounce('sources-dir', () => this.handleSourcesDirChange());
        return;
      }

      // File-level changes
      if (file === 'config.json') {
        this.debounce(`source-config:${slug}`, () => this.handleSourceConfigChange(slug));
      } else if (file === 'guide.md') {
        this.debounce(`source-guide:${slug}`, () => this.handleSourceGuideChange(slug));
      } else if (file === 'permissions.json') {
        this.debounce(`source-permissions:${slug}`, () => this.handleSourcePermissionsChange(slug));
      }
      return;
    }

    // Skills changes: skills/{slug}/...
    if (parts[0] === 'skills' && parts.length >= 2) {
      const slug = parts[1]!;  // Safe: checked parts.length >= 2
      const file = parts[2];

      // Directory-level changes (new/removed skill folders)
      if (parts.length === 2) {
        this.debounce('skills-dir', () => this.handleSkillsDirChange());
        return;
      }

      // File-level changes
      if (file === 'SKILL.md') {
        // R73 · `skills` — hooks.md#configchange: "A skill file in
        // `.claude/skills/` changes". Only `SKILL.md`, not the sibling icon: an
        // icon is a media asset, and gating it would let a ConfigChange block
        // freeze an unrelated avatar refresh.
        this.debounce(`skill:${slug}`, () => this.applySettingsChange(
          'skills', join(this.skillsDir, slug, 'SKILL.md'), () => this.handleSkillChange(slug),
        ));
      } else if (file && /^icon\.(svg|png|jpg|jpeg)$/i.test(file)) {
        // Icon file changes also trigger a skill change (to update iconPath)
        this.debounce(`skill-icon:${slug}`, () => this.handleSkillChange(slug));
      }
      return;
    }
    if (parts[0] === 'pages' && parts.length >= 2) return this.handlePagesPathChange(parts); // UA6.2 — see handlePagesPathChange
    // NOTE: Session metadata (sessions/{id}/session.jsonl) is NO LONGER detected
    // here. Sessions moved to the global SESSIONS_DIR/<workspaceId> partition
    // (W5), outside the managed workspace dir, so they are watched separately by
    // watchSessionMetadataDir() / handleSessionMetadataChange().

    // Statuses changes: statuses/...
    if (parts[0] === 'statuses' && parts.length >= 2) {
      const file = parts[1];

      // config.json change
      if (file === 'config.json') {
        this.debounce('statuses-config', () => this.handleStatusConfigChange());
        return;
      }

      // Icon file changes: statuses/icons/*.svg, *.png, etc.
      if (file === 'icons' && parts.length >= 3) {
        const iconFilename = parts[2];
        if (iconFilename) {
          this.debounce(`statuses-icon:${iconFilename}`, () => {
            this.handleStatusIconChange(iconFilename);
          });
        }
        return;
      }
    }

    // Labels changes: labels/...
    if (parts[0] === 'labels' && parts.length >= 2) {
      const file = parts[1];

      // config.json change
      if (file === 'config.json') {
        this.debounce('labels-config', () => this.handleLabelConfigChange());
        return;
      }

    }
  }

  /**
   * R73 · run the `ConfigChange` gate for one settings file, then apply the
   * reload only if it was not blocked.
   *
   * Three deliberate properties:
   *
   * 1. NO GATE INSTALLED ⇒ BYTE-IDENTICAL BEHAVIOUR. `apply()` runs on the same
   *    synchronous tick it ran on before, so an embedder that never wires the
   *    callback (and every existing test) is unaffected — no microtask hop.
   * 2. FAIL OPEN. A throwing or rejecting gate applies the change. A hook that
   *    crashes must not be able to freeze a user's settings, and hooks.md's
   *    block is an explicit `decision`, never an accident.
   * 3. THE GATE RUNS ONCE PER SAVE, INSIDE THE DEBOUNCE. It is called from the
   *    debounced handler, not from the raw `fs.watch` callback, so an editor's
   *    atomic-rename save (write temp → rename over) coalesces into one hook
   *    run exactly as it already coalesces into one reload.
   */
  private applySettingsChange(source: HookConfigChangeSource, filePath: string, apply: () => void): void {
    const gate = this.callbacks.onSettingsSourceChange;
    if (!gate) {
      apply();
      return;
    }
    const blocked = () => debug('[ConfigWatcher] ConfigChange hook blocked', source, filePath);
    let outcome: Promise<boolean> | boolean;
    try {
      outcome = gate(source, filePath);
    } catch (error) {
      debug('[ConfigWatcher] ConfigChange gate threw, applying change:', error);
      apply();
      return;
    }
    if (outcome === true) { apply(); return; }
    if (outcome === false) { blocked(); return; }
    void Promise.resolve(outcome).then(
      allowed => { if (allowed) apply(); else blocked(); },
      error => {
        debug('[ConfigWatcher] ConfigChange gate rejected, applying change:', error);
        apply();
      },
    );
  }

  /**
   * Debounce a handler by key
   */
  private debounce(key: string, handler: () => void, delayMs: number = DEBOUNCE_MS): void {
    const existing = this.debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      handler();
    }, delayMs);

    this.debounceTimers.set(key, timer);
  }

  // ============================================================
  // Sources Handlers
  // ============================================================

  /**
   * Scan sources directory to populate known sources
   */
  private scanSources(): void {
    if (!existsSync(this.sourcesDir)) {
      mkdirSync(this.sourcesDir, { recursive: true });
      return;
    }

    try {
      const entries = readdirSync(this.sourcesDir);

      for (const entry of entries) {
        const entryPath = join(this.sourcesDir, entry);
        if (statSync(entryPath).isDirectory()) {
          this.knownSources.add(entry);
        }
      }

      debug('[ConfigWatcher] Known sources:', Array.from(this.knownSources));
    } catch (error) {
      debug('[ConfigWatcher] Error scanning sources:', error);
    }
  }

  /**
   * Handle sources directory change (add/remove folders)
   */
  private handleSourcesDirChange(): void {
    debug('[ConfigWatcher] Sources directory changed');
    this.emitWorkspaceInvalidation('source');

    if (!existsSync(this.sourcesDir)) {
      // Directory was deleted
      const removed = Array.from(this.knownSources);
      this.knownSources.clear();

      for (const slug of removed) {
        permissionsConfigCache.invalidateSource(this.workspaceDir, slug);
        this.callbacks.onSourceChange?.(slug, null);
      }

      this.callbacks.onSourcesListChange?.([]);
      return;
    }

    try {
      const entries = readdirSync(this.sourcesDir);
      const currentFolders = new Set<string>();

      for (const entry of entries) {
        const entryPath = join(this.sourcesDir, entry);
        if (statSync(entryPath).isDirectory()) {
          currentFolders.add(entry);
        }
      }

      // Find added folders
      for (const folder of currentFolders) {
        if (!this.knownSources.has(folder)) {
          debug('[ConfigWatcher] New source folder:', folder);
          this.knownSources.add(folder);
          // P2.200 — the EAGER half of the source add/remove invalidation.
          //
          // Correctness does not depend on this and must not be described as if
          // it did: since `dbfb36347` the merged entry validates the source files
          // it consumed (`ino`/`size`/`mtimeMs`), so a slug that was deleted and
          // re-added is detected on read even with no invalidation at all. What
          // the eager call buys is the stat, at the one point the system already
          // KNOWS the answer. Measured 2026-08-26 on this tree: the validation
          // costs 2.9 µs per declared slug on a warm hit (0.76 µs with none,
          // 3.68 µs with one, 15.17 µs with five) and zero for a pinned context,
          // which returns before the per-slug loop and stats nothing. So this is
          // an optimization, priced accordingly — two lines using a cache handle
          // this file already holds, and no new import edge.
          permissionsConfigCache.invalidateSource(this.workspaceDir, folder);

          const source = loadSource(this.workspaceDir, folder);
          if (source) {
            this.callbacks.onSourceChange?.(folder, source);
          }
        }
      }

      // Find removed folders
      for (const folder of this.knownSources) {
        if (!currentFolders.has(folder)) {
          debug('[ConfigWatcher] Removed source folder:', folder);
          this.knownSources.delete(folder);
          permissionsConfigCache.invalidateSource(this.workspaceDir, folder);
          this.callbacks.onSourceChange?.(folder, null);
        }
      }

      // Notify list change
      const allSources = loadWorkspaceSources(this.workspaceDir);
      this.callbacks.onSourcesListChange?.(allSources);
    } catch (error) {
      debug('[ConfigWatcher] Error handling sources dir change:', error);
      this.callbacks.onError?.('sources/', error as Error);
    }
  }

  /**
   * Handle source config.json change
   * Downloads icon if URL specified and no local icon exists
   */
  private handleSourceConfigChange(slug: string): void {
    debug('[ConfigWatcher] Source config changed:', slug);
    this.emitWorkspaceInvalidation('source');

    const validation = validateSource(this.workspaceDir, slug);
    if (!validation.valid) {
      debug('[ConfigWatcher] Source validation failed:', slug, validation.errors);
      this.callbacks.onValidationError?.(`sources/${slug}/config.json`, validation);
      return;
    }

    const source = loadSource(this.workspaceDir, slug);

    // Check if icon needs to be downloaded (URL in config, no local file)
    if (source && sourceNeedsIconDownload(this.workspaceDir, slug, source.config)) {
      debug('[ConfigWatcher] Downloading source icon:', slug);
      downloadSourceIcon(this.workspaceDir, slug, source.config.icon!)
        .then((iconPath) => {
          if (iconPath) {
            debug('[ConfigWatcher] Source icon downloaded:', slug, iconPath);
            // Re-emit source change with updated icon path
            const updatedSource = loadSource(this.workspaceDir, slug);
            this.callbacks.onSourceChange?.(slug, updatedSource);
          }
        })
        .catch((err) => {
          debug('[ConfigWatcher] Source icon download failed:', slug, err);
        });
    }

    this.callbacks.onSourceChange?.(slug, source);
  }

  /**
   * Handle source guide.md change
   */
  private handleSourceGuideChange(slug: string): void {
    debug('[ConfigWatcher] Source guide changed:', slug);

    const guide = loadSourceGuide(this.workspaceDir, slug);
    if (guide) {
      this.callbacks.onSourceGuideChange?.(slug, guide);
    }

    // Also emit full source change
    const source = loadSource(this.workspaceDir, slug);
    if (source) {
      this.callbacks.onSourceChange?.(slug, source);
    }
  }

  /**
   * Handle source permissions.json change
   */
  private handleSourcePermissionsChange(slug: string): void {
    debug('[ConfigWatcher] Source permissions.json changed:', slug);

    // Invalidate cache
    permissionsConfigCache.invalidateSource(this.workspaceDir, slug);

    // Notify callback
    this.callbacks.onSourcePermissionsChange?.(slug);
  }

  // ============================================================
  // Skills Handlers
  // ============================================================

  /**
   * Scan skills directory to populate known skills
   */
  private scanSkills(): void {
    if (!existsSync(this.skillsDir)) {
      mkdirSync(this.skillsDir, { recursive: true });
      return;
    }

    try {
      const entries = readdirSync(this.skillsDir);

      for (const entry of entries) {
        const entryPath = join(this.skillsDir, entry);
        if (statSync(entryPath).isDirectory()) {
          this.knownSkills.add(entry);
        }
      }

      debug('[ConfigWatcher] Known skills:', Array.from(this.knownSkills));
    } catch (error) {
      debug('[ConfigWatcher] Error scanning skills:', error);
    }
  }

  /**
   * Handle skills directory change (add/remove folders)
   */
  private handleSkillsDirChange(): void {
    debug('[ConfigWatcher] Skills directory changed');
    this.emitWorkspaceInvalidation('skill');

    if (!existsSync(this.skillsDir)) {
      // Directory was deleted
      const removed = Array.from(this.knownSkills);
      this.knownSkills.clear();

      for (const slug of removed) {
        this.callbacks.onSkillChange?.(slug, null);
      }

      this.callbacks.onSkillsListChange?.([]);
      return;
    }

    try {
      const entries = readdirSync(this.skillsDir);
      const currentFolders = new Set<string>();

      for (const entry of entries) {
        const entryPath = join(this.skillsDir, entry);
        if (statSync(entryPath).isDirectory()) {
          currentFolders.add(entry);
        }
      }

      // Find added folders
      for (const folder of currentFolders) {
        if (!this.knownSkills.has(folder)) {
          debug('[ConfigWatcher] New skill folder:', folder);
          this.knownSkills.add(folder);

          const skill = loadSkill(this.workspaceDir, folder);
          if (skill) {
            this.callbacks.onSkillChange?.(folder, skill);
          }
        }
      }

      // Find removed folders
      for (const folder of this.knownSkills) {
        if (!currentFolders.has(folder)) {
          debug('[ConfigWatcher] Removed skill folder:', folder);
          this.knownSkills.delete(folder);
          this.callbacks.onSkillChange?.(folder, null);
        }
      }

      // Invalidate cache before reloading so we get fresh results
      invalidateSkillsCache();
      const allSkills = loadAllSkills(this.workspaceDir);
      this.callbacks.onSkillsListChange?.(allSkills);
    } catch (error) {
      debug('[ConfigWatcher] Error handling skills dir change:', error);
      this.callbacks.onError?.('skills/', error as Error);
    }
  }

  /**
   * Handle skill SKILL.md or icon change.
   * If the skill has an icon URL in metadata but no local icon file,
   * downloads the icon and emits another change event after completion.
   */
  private handleSkillChange(slug: string): void {
    debug('[ConfigWatcher] Skill changed:', slug);
    this.emitWorkspaceInvalidation('skill');

    const skill = loadSkill(this.workspaceDir, slug);
    this.callbacks.onSkillChange?.(slug, skill);

    // Check if we need to download an icon from URL
    // This happens when SKILL.md has icon: "https://..." but no local icon.* file exists
    if (skill && skillNeedsIconDownload(skill)) {
      debug('[ConfigWatcher] Skill needs icon download:', slug, skill.metadata.icon);

      // Download asynchronously - don't block the watcher
      downloadSkillIcon(skill.path, skill.metadata.icon!)
        .then((iconPath) => {
          if (iconPath) {
            // Reload the skill with the new icon and emit another change
            const updatedSkill = loadSkill(this.workspaceDir, slug);
            debug('[ConfigWatcher] Icon downloaded, emitting updated skill:', slug);
            this.callbacks.onSkillChange?.(slug, updatedSkill);
          }
        })
        .catch((error) => {
          debug('[ConfigWatcher] Icon download failed for skill:', slug, error);
        });
    }
  }

  // ============================================================
  // Safe Mode & Config Handlers
  // ============================================================

  /**
   * Handle workspace permissions.json change
   */
  private handleWorkspacePermissionsChange(): void {
    debug('[ConfigWatcher] Workspace permissions.json changed:', this.workspaceId);
    this.emitWorkspaceInvalidation('permission');

    // Invalidate cache
    permissionsConfigCache.invalidateWorkspace(this.workspaceDir);

    // Notify callback
    this.callbacks.onWorkspacePermissionsChange?.(this.workspaceId);
  }

  /**
   * Handle config.json change
   */
  private handleConfigChange(): void {
    debug('[ConfigWatcher] config.json changed');

    const validation = validateConfig();
    if (!validation.valid) {
      debug('[ConfigWatcher] Config validation failed:', validation.errors);
      this.callbacks.onValidationError?.('config.json', validation);
      return;
    }

    this.reloadStoredConfig();
  }

  /**
   * Load the (already-validated) config and dispatch change callbacks.
   *
   * validateConfig() and loadStoredConfig() each read config.json
   * independently, so the file can turn legacy/corrupt between the two reads
   * (external edit or downgrade). loadStoredConfig() fails closed on such a
   * file by throwing UnsupportedStorageLayoutError — correct at startup, but
   * this method runs inside a debounce setTimeout (see debounce()), where an
   * uncaught throw escapes the event loop and kills processes without a
   * global exception handler (the headless server registers only
   * unhandledRejection). Catch it, report through the watcher's own error
   * callback, and keep the last-known-good state. Never write config.json
   * here — rewriting on failure is exactly the destructive path the
   * fail-closed guard exists to prevent.
   */
  private reloadStoredConfig(): void {
    let config: StoredConfig | null;
    try {
      config = loadStoredConfig();
    } catch (error) {
      debug('[ConfigWatcher] config.json reload failed:', error instanceof Error ? error.message : error);
      this.callbacks.onError?.('config.json', error instanceof Error ? error : new Error(String(error)));
      return;
    }

    if (config) {
      this.callbacks.onConfigChange?.(config);

      // Check for LLM connections changes
      // Use JSON hash comparison for deep equality check
      const connections = config.llmConnections || [];
      const currentHash = JSON.stringify(connections);
      if (currentHash !== this.lastLlmConnectionsHash) {
        debug('[ConfigWatcher] LLM connections changed');
        this.lastLlmConnectionsHash = currentHash;
        this.callbacks.onLlmConnectionsChange?.(connections);
      }
    } else {
      this.callbacks.onError?.('config.json', new Error('Failed to load config'));
    }
  }

  /**
   * Handle preferences.json change
   */
  private handlePreferencesChange(): void {
    debug('[ConfigWatcher] preferences.json changed');

    const validation = validatePreferences();
    if (!validation.valid) {
      debug('[ConfigWatcher] Preferences validation failed:', validation.errors);
      this.callbacks.onValidationError?.('preferences.json', validation);
      return;
    }

    const prefs = loadPreferences();
    if (prefs) {
      this.callbacks.onPreferencesChange?.(prefs);
    }
  }

  // ============================================================
  // Statuses Handlers
  // ============================================================

  /**
   * Handle statuses config.json change
   * Downloads icons for any status with URL icon and no local file
   */
  private handleStatusConfigChange(): void {
    debug('[ConfigWatcher] Statuses config.json changed:', this.workspaceId);

    // Load config and check for icons that need downloading
    const config = loadStatusConfig(this.workspaceDir);
    for (const status of config.statuses) {
      if (statusNeedsIconDownload(this.workspaceDir, status)) {
        debug('[ConfigWatcher] Downloading status icon:', status.id);
        downloadStatusIcon(this.workspaceDir, status.id, status.icon!)
          .then((iconPath) => {
            if (iconPath) {
              debug('[ConfigWatcher] Status icon downloaded:', status.id, iconPath);
              // Re-emit config change to update UI with new icon
              this.callbacks.onStatusConfigChange?.(this.workspaceId);
            }
          })
          .catch((err) => {
            debug('[ConfigWatcher] Status icon download failed:', status.id, err);
          });
      }
    }

    this.callbacks.onStatusConfigChange?.(this.workspaceId);
  }

  /**
   * Handle status icon file change
   */
  private handleStatusIconChange(iconFilename: string): void {
    debug('[ConfigWatcher] Status icon changed:', this.workspaceId, iconFilename);
    this.callbacks.onStatusIconChange?.(this.workspaceId, iconFilename);
  }

  // ============================================================
  // Labels Handlers
  // ============================================================

  /**
   * Handle labels config.json change.
   */
  private handleLabelConfigChange(): void {
    debug('[ConfigWatcher] Labels config.json changed:', this.workspaceId);
    this.callbacks.onLabelConfigChange?.(this.workspaceId);
  }

  /**
   * Handle automations config change.
   */
  private handleAutomationsConfigChange(): void {
    debug('[ConfigWatcher] automations config changed:', this.workspaceId);
    // The debounced trigger covers automations.json, workspace hooks.json and
    // config.json — both the automation and hook layers may have changed.
    this.emitWorkspaceInvalidation('automation');
    this.emitWorkspaceInvalidation('hook');
    this.callbacks.onAutomationsConfigChange?.(this.workspaceId);
  }

  /**
   * Handle user/global lifecycle hook config change.
   */
  private handleUserGlobalHooksConfigChange(): void {
    debug('[ConfigWatcher] user/global hooks config changed');
    emitNativeSourceInvalidation({ kind: 'hook', scope: { kind: 'global' } });
    this.callbacks.onUserGlobalHooksConfigChange?.();
  }

  /**
   * C3.121 — a user-scope agent definition changed.
   *
   * One coarse global invalidation and no callback of its own: the capability
   * resolver's snapshot is what makes the definition stale, and
   * `loadAgentDefinitions` re-reads the directory on every call once the
   * snapshot is dropped, so there is nothing else to reload.
   */
  private handleUserAgentsChange(): void {
    debug('[ConfigWatcher] user/global agents directory changed');
    emitNativeSourceInvalidation({ kind: 'agent', scope: { kind: 'global' } });
  }

  // ============================================================
  // Session Metadata Handlers
  // ============================================================

  /**
   * Handle session.jsonl change — reads only line 1 (header) and emits if valid.
   * This enables detection of external metadata changes (labels, name, flags)
   * made by other instances, scripts, or manual edits.
   */
  private handleSessionMetadataChange(sessionId: string): void {
    let sessionFile: string;
    try {
      // Sessions live in the global partition SESSIONS_DIR/<workspaceId>/<sessionId>.
      sessionFile = join(getSessionStoragePath(this.workspaceId, sessionId), 'session.jsonl');
    } catch {
      // Invalid session id (e.g. a stray directory) — ignore.
      return;
    }

    if (!existsSync(sessionFile)) {
      return;
    }

    const header = readSessionHeader(sessionFile);
    if (header) {
      this.callbacks.onSessionMetadataChange?.(sessionId, header);
    }
  }

  /**
   * Watch this workspace's session-metadata partition for external edits to
   * `<sessionId>/session.jsonl`. Self-writes are still filtered downstream by
   * the consumer's write-guard/signature check (see SessionManager
   * onSessionMetadataChange); this only re-enables detection of edits made by
   * other instances/scripts, which broke when sessions moved out of the managed
   * workspace dir (W5).
   */
  private watchSessionMetadataDir(): void {
    let sessionRoot: string;
    try {
      sessionRoot = getWorkspaceSessionRootPath(this.workspaceId);
    } catch {
      return;
    }
    if (!existsSync(sessionRoot)) {
      try {
        mkdirSync(sessionRoot, { recursive: true });
      } catch {
        return;
      }
    }
    try {
      const watcher = watch(sessionRoot, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        this.handleSessionPartitionFileChange(filename.replace(/\\/g, '/'));
      });
      this.watchers.push(watcher);
      debug('[ConfigWatcher] Watching session metadata dir:', sessionRoot);
    } catch (error) {
      debug('[ConfigWatcher] Error watching session metadata dir:', error);
    }
  }

  /** Route a change under the session partition (`<sessionId>/session.jsonl`). */
  private handleSessionPartitionFileChange(relativePath: string): void {
    const parts = relativePath.split('/');
    if (parts.length < 2) return;
    if (parts[parts.length - 1] !== 'session.jsonl') return;
    const sessionId = parts[0]!;
    if (!sessionId) return;
    this.debounce(`session-meta:${sessionId}`, () => this.handleSessionMetadataChange(sessionId), SESSION_META_DEBOUNCE_MS);
  }

  // ============================================================
  // Theme Handlers (App-Level)
  // ============================================================

  /**
   * Handle app-level theme.json change
   */
  private handleAppThemeChange(): void {
    debug('[ConfigWatcher] App theme.json changed');
    const theme = loadAppTheme();
    this.callbacks.onAppThemeChange?.(theme);
  }

  /**
   * C3.121 — watch `<CONFIG_DIR>/agents` itself, because the directory watch on
   * `CONFIG_DIR` cannot see inside it (measured; see the dispatcher arm).
   *
   * Idempotent and called from two places: once at start, and again from the
   * dispatcher when the directory first appears mid-session. Unlike the themes
   * directory beside it, this one is never CREATED here — a config directory
   * should not sprout an empty folder the user did not ask for, and the
   * dispatcher arm is what makes the lazy attach reliable.
   */
  private watchAppAgentsDir(): void {
    if (this.appAgentsWatcher) return;
    const agentsDir = join(CONFIG_DIR, USER_AGENTS_DIR);
    if (!existsSync(agentsDir)) return;

    try {
      const watcher = watch(agentsDir, (_eventType, filename) => {
        if (!filename) return;
        // The same filter the capability reader applies, so a stray icon or a
        // swap file does not drop the snapshot.
        if (!String(filename).toLowerCase().endsWith('.md')) return;
        this.debounce('user-agents', () => this.handleUserAgentsChange());
      });

      this.appAgentsWatcher = watcher;
      this.watchers.push(watcher);
      debug('[ConfigWatcher] Watching user agents directory:', agentsDir);
    } catch (error) {
      debug('[ConfigWatcher] Error watching user agents directory:', error);
    }
  }

  /**
   * Watch app-level themes directory (~/.nessy-agent/themes/)
   */
  private watchAppThemesDir(): void {
    const themesDir = getAppThemesDir();

    // Create themes directory if it doesn't exist
    if (!existsSync(themesDir)) {
      mkdirSync(themesDir, { recursive: true });
    }

    try {
      const watcher = watch(themesDir, (eventType, filename) => {
        if (!filename) return;

        // Only handle .json files
        if (filename.endsWith('.json')) {
          const themeId = filename.replace('.json', '');
          this.debounce(`preset-theme:${themeId}`, () => this.handlePresetThemeChange(themeId));
        }
      });

      this.watchers.push(watcher);
      debug('[ConfigWatcher] Watching app themes directory:', themesDir);
    } catch (error) {
      debug('[ConfigWatcher] Error watching app themes directory:', error);
    }
  }

  /**
   * Watch app-level permissions directory (~/.nessy-agent/permissions/)
   * Watches for changes to default.json which contains the default read-only patterns
   */
  private watchAppPermissionsDir(): void {
    const permissionsDir = getAppPermissionsDir();

    // Create permissions directory if it doesn't exist
    if (!existsSync(permissionsDir)) {
      mkdirSync(permissionsDir, { recursive: true });
    }

    try {
      const watcher = watch(permissionsDir, (eventType, filename) => {
        if (!filename) return;

        // Only watch default.json - this is where the default patterns live
        if (filename === 'default.json') {
          this.debounce('default-permissions', () => this.handleDefaultPermissionsChange());
        }
      });

      this.watchers.push(watcher);
      debug('[ConfigWatcher] Watching app permissions directory:', permissionsDir);
    } catch (error) {
      debug('[ConfigWatcher] Error watching app permissions directory:', error);
    }
  }

  /**
   * Handle default.json permissions change (app-level)
   */
  private handleDefaultPermissionsChange(): void {
    debug('[ConfigWatcher] Default permissions changed');

    // Invalidate the cache so next getMergedConfig() reloads from file
    permissionsConfigCache.invalidateDefaults();

    // Notify callback
    this.callbacks.onDefaultPermissionsChange?.();
  }

  /**
   * Scan app-level themes directory to populate known themes
   */
  private scanAppThemes(): void {
    const themesDir = getAppThemesDir();

    if (!existsSync(themesDir)) {
      return;
    }

    try {
      const files = readdirSync(themesDir).filter(f => f.endsWith('.json'));

      for (const file of files) {
        const themeId = file.replace('.json', '');
        this.knownThemes.add(themeId);
      }

      debug('[ConfigWatcher] Known themes:', Array.from(this.knownThemes));
    } catch (error) {
      debug('[ConfigWatcher] Error scanning themes:', error);
    }
  }

  /**
   * Handle preset theme file change (app-level)
   */
  private handlePresetThemeChange(themeId: string): void {
    debug('[ConfigWatcher] Preset theme changed:', themeId);

    const themesDir = getAppThemesDir();
    const themePath = join(themesDir, `${themeId}.json`);

    if (!existsSync(themePath)) {
      // Theme was deleted
      if (this.knownThemes.has(themeId)) {
        this.knownThemes.delete(themeId);
        this.callbacks.onPresetThemeChange?.(themeId, null);

        // Also notify list change
        const allThemes = loadPresetThemes();
        this.callbacks.onPresetThemesListChange?.(allThemes);
      }
      return;
    }

    // Theme was added or modified
    if (!this.knownThemes.has(themeId)) {
      this.knownThemes.add(themeId);
    }

    const theme = loadPresetTheme(themeId);
    this.callbacks.onPresetThemeChange?.(themeId, theme);

    // Also notify list change in case name changed (affects sorting)
    const allThemes = loadPresetThemes();
    this.callbacks.onPresetThemesListChange?.(allThemes);
  }

  // ============================================================
  // Page Handlers (UA6.2 — v0.13.4:packages/shared/src/config/watcher.ts L484–L493 and L971–L988, Apache-2.0)
  // ============================================================

  /**
   * Route a change under `pages/`: `pages/{slug}/page.json` is the ONLY file trigger — a refresh run's last write is
   * page.json, so reacting to it (and nothing else) means observers never see a half-written `data/` directory.
   * Slug-dir add/remove also fires (page created/deleted externally). The branch sits in
   * {@link handleWorkspaceFileChange} as one line, so the docs-cited lines below it keep their numbers.
   * UA8.2 — the host-written refresh script `pages/{slug}/refresh.ts` fires too: an edit of it (by any writer) must
   * drop the page's refresh matcher at once (its approval no longer matches) and re-ask in PageView. It is never
   * written by a refresh run, so this adds no half-written-data reading.
   */
  private handlePagesPathChange(parts: string[]): void {
    const file = parts[2];
    if (parts.length === 2 || file === 'page.json' || (parts.length === 3 && file === 'refresh.ts')) {
      this.debounce('pages-dir', () => this.handlePagesChange());
    }
  }

  /**
   * Handle a pages change (any page.json touched, or a page folder
   * added/removed). Coarse by design: reload the full list once per
   * debounce window.
   */
  private handlePagesChange(): void {
    if (!this.callbacks.onPagesListChange) return;
    try {
      const pages = loadWorkspacePages(this.workspaceDir);
      debug('[ConfigWatcher] pages changed:', this.workspaceId, `(${pages.length} pages)`);
      this.callbacks.onPagesListChange(pages);
    } catch (error) {
      debug('[ConfigWatcher] Failed to reload pages:', error);
    }
  }
}

// ============================================================
// Factory Function
// ============================================================

/**
 * Create and start a config watcher for a specific workspace.
 * Returns the watcher instance for later cleanup.
 */
export function createConfigWatcher(
  workspaceIdOrPath: string,
  callbacks: ConfigWatcherCallbacks,
  explicitWorkspaceId?: string
): ConfigWatcher {
  const watcher = new ConfigWatcher(workspaceIdOrPath, callbacks, explicitWorkspaceId);
  watcher.start();
  return watcher;
}

// ============================================================
// Pages (UA6.2) — declared at the file end so no docs-cited line above moves
// ============================================================

// Interface merging adds the pages callback to ConfigWatcherCallbacks (v0.13.4 L157–L163).
export interface ConfigWatcherCallbacks {
  /**
   * Called when any pages/{slug}/page.json changes (create/delete/refresh
   * completion). page.json is the completion marker of a refresh run, so
   * data/ churn (sqlite, snapshot tmp files) is deliberately NOT watched.
   */
  onPagesListChange?: (pages: LoadedPage[]) => void;
}

// Hoisted like every import; kept at the end for the same line-number reason.
import { loadWorkspacePages } from '../pages/storage.ts';
import type { LoadedPage } from '../pages/types.ts';
