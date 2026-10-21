/**
 * Claude Context Factory
 *
 * Creates a SessionToolContext implementation for Claude with full access
 * to Electron internals, credential managers, MCP validation, etc.
 *
 * This enables the shared handlers in session-tools-core to work with
 * Claude's full feature set.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { CONFIG_DIR } from '../config/paths.ts';
import type {
  SessionToolContext,
  SessionToolCallbacks,
  AutomationManagerInterface,
  FileSystemInterface,
  CredentialManagerInterface,
  ValidatorInterface,
  LoadedSource,
  StdioMcpConfig,
  StdioValidationResult,
  HttpMcpConfig,
  McpValidationResult,
  ApiTestResult,
  SourceConfig,
  DeveloperFeedback,
  ToolResult,
} from '@nessy-agent/session-tools-core';
import {
  validateConfig,
  validateSource,
  validateAllSources,
  validateStatuses,
  validatePreferences,
  validateAll,
  validateSkill,
  validateWorkspacePermissions,
  validateSourcePermissions,
  validateAllPermissions,
  validateToolIcons,
} from '../config/validators.ts';
import {
  createAutomationEntry,
  listAutomationEntries,
  updateAutomationEntry,
  validateAutomationConfigFile,
  validateAutomations, formatAutomationListText,
} from '../automations/index.ts';
import { atomicWriteFileSync } from '../utils/files.ts';
import {
  validateMcpConnection as validateMcpConnectionImpl,
  validateStdioMcpConnection as validateStdioMcpConnectionImpl,
} from '../mcp/validation.ts';
import {
  loadSourceConfig as loadSourceConfigImpl,
  saveSourceConfig as saveSourceConfigImpl,
  getSourcePath,
} from '../sources/storage.ts';
import type { FolderSourceConfig, LoadedSource as SharedLoadedSource } from '../sources/types.ts';
import { getSourceCredentialManager } from '../sources/index.ts';
import {
  inferGoogleServiceFromUrl,
  type GoogleService,
} from '../sources/types.ts';
import { isGoogleOAuthConfigured as isGoogleOAuthConfiguredImpl } from '../auth/google-oauth.ts';
import { discoverOAuthMetadata } from '../auth/oauth.ts';
import { debug } from '../utils/debug.ts';
import { getMemoryEnabled } from '../config/storage.ts';
import {
  resolveSessionMemoryScope,
  type SessionMemoryScopeOverride,
} from './memory/session-memory-scope.ts';
import { updatePreferences as updatePreferencesImpl } from '../config/preferences.ts';
import { getUserMemoryFilePath } from './memory/memory-store.ts';
import { getSessionScopedToolCallbacks } from './session-scoped-tool-callback-registry.ts';

// Re-export types that may be needed by consumers
export type { SessionToolContext, SessionToolCallbacks } from '@nessy-agent/session-tools-core';

/**
 * Options for creating a Claude context
 */
export interface ClaudeContextOptions {
  sessionId: string;
  workspacePath: string;
  workspaceId: string;
  /**
   * Already-derived session storage directory (`.../<sessionId>`). The caller (agent boundary)
   * derives it once; this factory never recomputes it from `workspacePath + sessionId`. Plans and
   * data directories are derived as subdirectories of this path.
   */
  sessionPath: string;
  workingDirectory?: string;
  onPlanSubmitted: (planPath: string) => void;
  onAuthRequest: (request: unknown) => void;
  /**
   * Host-bound source removal for `source_manage: remove` — the three-op
   * cleanup the Sources DELETE channel runs. Omitted (a host that has not
   * wired it) leaves the tool refusing that action honestly.
   */
  onRemoveSource?: (sourceSlug: string) => Promise<void>;
  /**
   * P6.795 — this chat's own memory override, read as an ACCESSOR rather than
   * taken as a value.
   *
   * The distinction is the whole row. The tools this context feeds are CACHED
   * per session (`session-scoped-tools.ts`'s `sessionToolsCache`), so an
   * override captured at construction would freeze at the first build and a
   * user who closed this chat's memory mid-conversation would keep writing
   * memories until the cache happened to be dropped. An accessor is read at the
   * moment `remember` runs, so there is nothing to invalidate — which is why
   * this row adds no invalidation hook and touches no cache.
   *
   * Omitted (a caller that holds no session record) leaves the app-wide switch
   * as the only input, byte-identical to the behaviour before this row.
   */
  getMemoryScopeOverride?: () => SessionMemoryScopeOverride | undefined;
}

/**
 * Create a SessionToolContext for Claude with full capabilities.
 *
 * This provides:
 * - Full file system access
 * - Full Zod validators
 * - Credential manager with keychain access
 * - MCP connection validation
 * - Icon management
 */
export function createClaudeContext(options: ClaudeContextOptions): SessionToolContext {
  const { sessionId, workspacePath, workspaceId, sessionPath, workingDirectory, onPlanSubmitted, onAuthRequest, onRemoveSource, getMemoryScopeOverride } = options;
  /**
   * P6.795 — the memory site P6.772 found and named here rather than fix.
   *
   * That walk established the rest of the map and it still holds:
   * `claude-agent.ts` carries no `getMemoryEnabled()` at all, `options.ts`'s
   * single site already resolves through `resolveSessionMemoryScope`
   * (`applyAutoMemoryOffSwitch`), and the READ axis is already scoped
   * (`memory/agent-memory.ts` takes `options.memoryScope`). This was the one
   * site left reading the app-wide answer alone — and it feeds
   * `SessionToolContext.memoryEnabled`, the WRITE axis
   * (`session-tools-core/src/handlers/remember.ts`, its only reader), so a chat
   * that closed its own memory for writing could still write one through the
   * tool.
   *
   * TWO things make this a resolver call rather than one more boolean:
   *
   *   - it is the same resolver every other memory seam already uses
   *     (`SessionManager.resolveSessionMemoryScopeFor`, `codex-agent.ts`,
   *     `applyAutoMemoryOffSwitch`), so the tool and the runtime cannot answer
   *     differently about the same chat; and
   *   - the per-chat override wins over the app-wide switch IN EITHER
   *     DIRECTION, which the resolver is where that precedence lives —
   *     `settings-reference.md#automemoryenabled`: the per-session override
   *     *"takes precedence over this key for one session, in either
   *     direction"*.
   *
   * AND IT IS A GETTER, which is the row's second clause discharged rather than
   * skipped. P6.772's reason for leaving it was that the tools are cached per
   * session, so an override threaded in at construction would freeze at the
   * first build. Resolving on READ removes the staleness instead of chasing it:
   * there is no cached copy to invalidate, no new hook, and a mid-session change
   * is picked up by the tools already built. `getSessionScopedTools`'s
   * `sessionToolsCache` and `invalidateAllSessionToolsCaches` are deliberately
   * untouched.
   *
   * With no accessor wired the answer is exactly `getMemoryEnabled()`, as
   * before — `resolveSessionMemoryScope` with no override returns the global
   * value on both axes.
   */
  const resolveMemoryWriteAxis = (): boolean => {
    const override = getMemoryScopeOverride?.();
    let globalEnabled: boolean;
    try {
      globalEnabled = getMemoryEnabled();
    } catch {
      // Unchanged: an unreadable app-wide switch reads as ON, so a broken
      // config does not silently disable a feature the user never turned off.
      // The chat's own override still applies on top of it.
      globalEnabled = true;
    }
    return resolveSessionMemoryScope({ globalEnabled, ...(override ? { override } : {}) }).write;
  };

  // File system implementation
  const fs: FileSystemInterface = {
    exists: (path: string) => existsSync(path),
    readFile: (path: string) => readFileSync(path, 'utf-8'),
    readFileBuffer: (path: string) => readFileSync(path),
    writeFile: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
    atomicWriteFile: (path: string, content: string) => atomicWriteFileSync(path, content),
    isDirectory: (path: string) => existsSync(path) && statSync(path).isDirectory(),
    readdir: (path: string) => readdirSync(path),
    stat: (path: string) => {
      const stats = statSync(path);
      return {
        size: stats.size,
        isDirectory: () => stats.isDirectory(),
      };
    },
  };

  // Callbacks implementation
  const callbacks: SessionToolCallbacks = {
    onPlanSubmitted,
    onAuthRequest: (request) => onAuthRequest(request),
  };

  // Validators implementation
  const validators: ValidatorInterface = {
    validateConfig: () => validateConfig(),
    validateSource: (wsPath: string, slug: string) => validateSource(wsPath, slug),
    validateAllSources: (wsPath: string) => validateAllSources(wsPath),
    validateStatuses: (wsPath: string) => validateStatuses(wsPath),
    validatePreferences: () => validatePreferences(),
    validatePermissions: (wsPath: string, sourceSlug?: string) => {
      if (sourceSlug) {
        return validateSourcePermissions(wsPath, sourceSlug);
      }
      return validateAllPermissions(wsPath);
    },
    validateAutomations: (wsPath: string) => validateAutomations(wsPath),
    validateToolIcons: () => validateToolIcons(),
    validateAll: (wsPath: string) => validateAll(wsPath),
    validateSkill: (wsPath: string, slug: string) => validateSkill(wsPath, slug),
  };

  // Credential manager adapter
  const credentialManager: CredentialManagerInterface = {
    hasValidCredentials: async (source: LoadedSource): Promise<boolean> => {
      const mgr = getSourceCredentialManager();
      // Convert to shared type (guide not needed for credential operations)
      const sharedSource: SharedLoadedSource = {
        config: source.config as unknown as FolderSourceConfig,
        guide: null,
        folderPath: source.folderPath,
        workspaceRootPath: source.workspaceRootPath,
        workspaceId: source.workspaceId,
      };
      const token = await mgr.getToken(sharedSource);
      return !!token;
    },
    getToken: async (source: LoadedSource): Promise<string | null> => {
      const mgr = getSourceCredentialManager();
      const sharedSource: SharedLoadedSource = {
        config: source.config as unknown as FolderSourceConfig,
        guide: null,
        folderPath: source.folderPath,
        workspaceRootPath: source.workspaceRootPath,
        workspaceId: source.workspaceId,
      };
      return mgr.getToken(sharedSource);
    },
    refresh: async (source: LoadedSource): Promise<string | null> => {
      const mgr = getSourceCredentialManager();
      const sharedSource: SharedLoadedSource = {
        config: source.config as unknown as FolderSourceConfig,
        guide: null,
        folderPath: source.folderPath,
        workspaceRootPath: source.workspaceRootPath,
        workspaceId: source.workspaceId,
      };
      return mgr.refresh(sharedSource);
    },
  };

  // MCP validation
  const validateStdioMcpConnection = async (config: StdioMcpConfig): Promise<StdioValidationResult> => {
    try {
      const result = await validateStdioMcpConnectionImpl(config);
      return {
        success: result.success,
        error: result.error,
        toolCount: result.tools?.length,
        toolNames: result.tools,
        serverName: result.serverInfo?.name,
        serverVersion: result.serverInfo?.version,
        warning: result.warning,
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Validation failed' };
    }
  };

  const validateMcpConnection = async (config: HttpMcpConfig): Promise<McpValidationResult> => {
    try {
      const result = await validateMcpConnectionImpl({
        mcpUrl: config.url,
        mcpTransport: config.transport,
        mcpHeaders: config.headers,
        mcpAccessToken: config.accessToken,
      });
      return {
        success: result.success,
        error: result.error,
        needsAuth: result.errorType === 'needs-auth',
        toolCount: result.tools?.length,
        toolNames: result.tools,
        warning: result.warning,
        serverName: result.serverInfo?.name,
        serverVersion: result.serverInfo?.version,
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Validation failed' };
    }
  };

  // Build context
  const context: SessionToolContext = {
    configRoot: CONFIG_DIR,
    sessionId,
    workspacePath,
    get sourcesPath() { return join(workspacePath, 'sources'); },
    get skillsPath() { return join(workspacePath, 'skills'); },
    plansFolderPath: join(sessionPath, 'plans'),
    workingDirectory,
    sessionPath,
    dataPath: join(sessionPath, 'data'),
    // F1.104 (origin D1.427) - through the resolver, never `join(CONFIG_DIR, ...)`.
    // `getUserMemoryFilePath` is the one answer to where this app keeps the
    // user-scope index (`getAutoMemoryDirectory() ?? CONFIG_DIR`, P6.390(2)), and
    // the loader, the cleanup pass and the memory RPC all read it; joining the
    // config root here gave an operator who moved their memory directory a
    // SECOND, invisible index - `remember` wrote one file while everything that
    // loads memories read another. A GETTER for `memoryEnabled`'s reason two
    // lines below: the tools built around this context are cached per session,
    // so a path captured here would freeze for the life of the chat.
    get userMemoryPath() { return getUserMemoryFilePath(); },
    get memoryEnabled() { return resolveMemoryWriteAxis(); },
    callbacks,
    fs,
    validators,
    automationManager: createAutomationManager(workspacePath),
    credentialManager,
    updatePreferences: (updates: Record<string, unknown>) => {
      updatePreferencesImpl(updates as any);
    },
    submitFeedback: (feedback: DeveloperFeedback) => {
      const feedbackDir = join(CONFIG_DIR, 'feedback');
      mkdirSync(feedbackDir, { recursive: true });
      const filePath = join(feedbackDir, `${feedback.id}.json`);
      writeFileSync(filePath, JSON.stringify(feedback, null, 2), 'utf-8');
      debug('claude-context', `Developer feedback written to ${filePath}`);
    },
    // Source management
    loadSourceConfig: (sourceSlug: string): SourceConfig | null => {
      const config = loadSourceConfigImpl(workspacePath, sourceSlug);
      return config as unknown as SourceConfig | null;
    },
    saveSourceConfig: (source: SourceConfig) => {
      saveSourceConfigImpl(workspacePath, source as unknown as FolderSourceConfig);
    },
    ...(onRemoveSource ? { removeSource: onRemoveSource } : {}),

    // Service inference
    inferGoogleService: (url?: string): GoogleService | undefined => {
      return inferGoogleServiceFromUrl(url);
    },

    // Capability-path plugin sign-in: the model-facing half of
    // `source_oauth_trigger`. Resolved fresh from the session-scoped callback
    // registry on every access — NEVER memoized — so the answer comes from the
    // turn's current enabled server set rather than from whatever was live when
    // this context was built (it is built once per session and cached).
    // `undefined` while no backend has published the authority, which is what
    // makes the trigger refuse the plugin target instead of fabricating a flow.
    get resolvePluginMcpServer() {
      return getSessionScopedToolCallbacks({ workspaceId, sessionId })?.resolvePluginMcpServerFn;
    },

    // OAuth config check
    isGoogleOAuthConfigured: (clientId?: string, clientSecret?: string): boolean => {
      return isGoogleOAuthConfiguredImpl(clientId, clientSecret);
    },

    // MCP validation
    validateStdioMcpConnection,
    validateMcpConnection,
    discoverMcpOAuth: async (url: string) => Boolean(await discoverOAuthMetadata(url)),

    // Icon helpers (simplified - full implementation would use logo.ts)
    isIconUrl: (value: string): boolean => {
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    },

    deriveServiceUrl: (source: SourceConfig): string | null => {
      if (source.type === 'api' && source.api?.baseUrl) {
        try {
          const url = new URL(source.api.baseUrl);
          return `${url.protocol}//${url.hostname}`;
        } catch {
          return null;
        }
      }
      if (source.type === 'mcp' && source.mcp?.url) {
        try {
          const url = new URL(source.mcp.url);
          return `${url.protocol}//${url.hostname}`;
        } catch {
          return null;
        }
      }
      return null;
    },

    // Session self-management bindings are attached externally via
    // attachSessionSelfManagementBindings() — not part of the factory.
  };

  // F1.107 (origin `D1.432`) — assigned here rather than inside the object
  // literal above so that no line-numbered citation into this file moves. An
  // accessor, not a value: the tools built around this context are cached per
  // session, so a read policy captured at construction would freeze for the
  // life of the chat — `memoryEnabled`'s reason, one screen up.
  context.sandboxReadFloor = () => resolveSessionToolSandboxReadFloor(workspacePath);
  // F1.191 (origin WJ-k P-WJk-1) — that floor's CREDENTIAL roots (`~/.nessy`,
  // `~/.ssh`, …) anchor on the LATCHED home, the one the credential store and
  // every other floor use. `script_sandbox` used to read the live `homedir()`,
  // which follows a confirmed managed `HOME` on Node and Electron, so the
  // profile then denied `<managed home>/.nessy` while the real JWT stayed
  // readable. An accessor for the same reason as the line above.
  context.credentialHomeDir = latchedHomeDir;

  return context;
}

/**
 * P3.154. Both arguments used to arrive as `Record<string, unknown>` and be
 * re-asserted into the shared writer's input with `as unknown as
 * Parameters<...>[1]` — a DOUBLE cast, which is the spelling TypeScript
 * requires precisely when the two types have nothing in common as far as it can
 * tell. It could not be wrong out loud: a bag with no `kind`/`actions` would
 * reach `buildMatcher` and write a malformed matcher to disk, and any drift
 * between the tool schema and `AutomationCreateInput` was absorbed in silence.
 *
 * `AutomationManagerInterface` now names the parsed shapes its only caller
 * already established, so the assignment below IS the check the cast replaced:
 * schema-vs-writer drift is a compile error here. No runtime work was added —
 * `handleAutomationCreate` parses one frame earlier, so a re-`parse` (the shape
 * P3.130 needed while the port was still erased) would be pure duplication.
 */
function createAutomationManager(workspacePath: string): AutomationManagerInterface {
  return {
    list: async (args) => {
      const entries = await listAutomationEntries(workspacePath);
      const automations = args.includeDisabled ? entries : entries.filter((entry) => entry.enabled);
      return automationToolResult(formatAutomationListText(automations), { automations }); // F1.1265
    },
    create: async (args) => {
      const result = await createAutomationEntry(workspacePath, args);
      return automationToolResult(`Created automation ${result.automationId} under ${result.event}[${result.matcherIndex}].`, { ...result });
    },
    update: async (args) => {
      const result = await updateAutomationEntry(workspacePath, args);
      return automationToolResult(`Updated automation ${result.automationId} under ${result.event}[${result.matcherIndex}].`, { ...result });
    },
    validate: async () => {
      const result = await validateAutomationConfigFile(workspacePath);
      return automationToolResult(result.message, { ...result });
    },
  };
}

/**
 * `structuredContent` is `Record<string, unknown>` on `ToolResult`, and an
 * `interface` gets no implicit index signature, so the writers' result
 * interfaces are not assignable to it even though every value is JSON. Callers
 * spread rather than cast — the same resolution P3.130 reached in the sibling
 * implementation, and the reason this parameter is no longer `unknown`.
 */
function automationToolResult(text: string, structuredContent: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
    isError: false,
  };
}

// F1.107 / F1.191 — the two imports the bindings at the bottom of
// `createClaudeContext` read, placed HERE rather than with the others at the
// top: `docs/**` cites this file by line, and an import added up there moves
// every citation below it (F1.107's first placement moved them by three —
// restored by F1.191). Import declarations are hoisted, so where they sit in
// the module changes nothing at run time.
import { resolveSessionToolSandboxReadFloor } from './pi-harness/session-tool-sandbox-read-floor.ts';
import { latchedHomeDir } from '../config/home-latch.ts';
