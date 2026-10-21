import { rmSync } from 'node:fs';

import {
  VERSION,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSession,
  type CreateAgentSessionOptions,
  type CreateModelRuntimeOptions,
  type ExtensionFactory,
  type ResourceLoader,
  type CacheWarmingMode,
  type RetrySettings,
} from '@earendil-works/pi-coding-agent';
import { resolveNessyAgentDir } from '../agent-dir.ts';
import { InMemoryCredentialStore, type CredentialStore } from '@earendil-works/pi-ai';
import type { PiExecutionManifestV2 } from '../../../shared/src/agent/pi-harness/harness-manifest.ts';
import { normalizePiSdkToolCallRecordsV1 } from './pi-legacy-ingress.ts';
import {
  PINNED_NESSY_FACTORIES,
  PINNED_NESSY_RESOURCES,
  composeCuratedPiExtensionFactories,
} from '../extensions/registry.ts';
import { createCuratedResourceOverrides } from '../extensions/resource-loader.ts';
import type { VerifiedSignedBundleRootCapability } from '../extensions/descriptor.ts';
import type { ToolExecutor } from '../../../shared/src/agent/pi-harness/tool-executor.ts';
import type { AgentEvent, SdkAutomationInput } from '../../../shared/src/automations/types.ts';
import type { PiContextResourceDescriptor } from '../../../shared/src/agent/pi-harness/context-resource.ts';
import { createPiLifecycleExtension } from '../extensions/lifecycle-bridge.ts';

/**
 * I2.31 + I2.32 — what this host reads of the surface Pi 0.84.4 added, and what
 * it deliberately does not. One verdict per name, measured 2026-09-17 against
 * the installed package rather than against the rows, which were written at
 * 0.84.3.
 *
 * ## The fact underneath most of them: thirteen of these names are UNREACHABLE
 *
 * The package publishes four exports entries at 0.87.1 — the root, `./rpc-entry`, and source-only
 * `./client` and `./experimental/plugin`, which resolve nowhere — and its root re-exports none below.
 * Measured with Bun from this package: a deep specifier ending in
 * `dist/core/session-export.js` and a bare `core/session-export` subpath are
 * BOTH refused, while the bare package name resolves to `dist/index.js` (the
 * control that proves the probe can see). So for these the choice is not
 * "adopt or decline" — adopting would not compile. `pi-new-surface-verdicts.test.ts`
 * pins that, so the day upstream widens the map this paragraph goes red instead
 * of quietly staying in force. Each verdict below therefore records what the
 * host would do if it COULD, which is the half that survives a wider map.
 *
 * ## I2.31 — the four new modules
 *
 *  - `core/session-export` (`exportSessionToJsonl`). Keep our own: a session's
 *    durable form and its export belong to the host's storage layer, not to the
 *    Pi process, which holds one session at a time and no history.
 *  - `core/settings-diagnostics` (`collectSettingsDiagnostics`,
 *    `deduplicateDiagnostics`). Inapplicable rather than declined: it reports
 *    problems in a settings FILE, and every session here is built on
 *    `SettingsManager.inMemory` from host config, so it could only ever report
 *    on a document this host just wrote.
 *  - `modes/interactive/session-share` (`exportSessionForShare`,
 *    `shareSession`). NEVER, and this one is a safety verdict rather than a
 *    preference: it uploads the current branch to Radius or to a gist. An
 *    internal corporate session must not gain a one-call egress path to a
 *    third-party service; sharing is the desktop's own surface, under its own
 *    consent.
 *  - `utils/text` (`splitBom`, `stripBom`). We have our own (`stripBom` in
 *    `packages/shared/src/utils/files.ts`, plus two private copies in
 *    session-tools-core). W10-g recorded `stripBom` LEAVING `core/tools/edit-diff`
 *    as a removed public export; measured here it is not on the root surface at
 *    0.84.4 either, and all three host readers are our own helper, so the
 *    removal costs nothing.
 *
 * ## I2.32 — the nine smaller names
 *
 *  1. `findNodePackageDir()` — the one already adopted, as an OBSERVED
 *     behaviour: it is the resolver whose dist-parent rule the host answers by
 *     setting `PI_PACKAGE_DIR` at the spawn site, and
 *     `pi-bundle-package-identity.test.ts` drives the shipped resolver rather
 *     than copying it. Nothing to change.
 *  2. `normalizeSessionName()` — a CLI-argument concern; the host names its own
 *     sessions. Unread.
 *  3. `createSessionManager()` — the CLI's composition root, taking `Args`. The
 *     host composes through this adapter deliberately, and
 *     `pi-runtime-h1-real-server.test.ts` already asserts the spawner names
 *     neither it nor `createAgentSession`. Declined, and guarded.
 *  4. `cleanupManagedInstall()` — Pi's package manager installs nothing here:
 *     extensions are curated and pinned and the resource loader is built with
 *     no extensions, no skills and no themes. Unread.
 *  5. `loadAllHighlightLanguages()` — TUI syntax highlighting; the renderer
 *     highlights host-side. Unread.
 *  6. `fetchWithRetry`'s `attemptTimeoutMs`, with `timeoutMs` re-specified as
 *     the OVERALL budget. No host caller, and the helper's own docblock scopes
 *     it to management HTTP: *"It must not be used for agent/model
 *     operations"*. So the re-specification has no consequence here. Its two
 *     apparent host hits are chat FIXTURE TEXT in a playground registry and in
 *     `runtime-handoff-context.test.ts`, not the API — the same-named-symbol
 *     trap, recorded so the next census does not read them as callers.
 *  7. `compact(..., sessionId?)` — the only one of the nine that is reachable
 *     AND called (`compactPiSession` in `index.ts`). `sessionId` stays
 *     unpassed: absent, `completeSummarization` substitutes a fresh `uuidv7()`
 *     and forces `cacheRetention: "none"`, which is the behaviour we want, and
 *     presenting our own session id as a routing key to the gateway is a wire
 *     change nothing has measured. Reading that signature is what surfaced the
 *     missing `retry` argument this wave fixed at the call site — see the
 *     comment there.
 *  8. `SettingsError.path?` — reachable as a type, unread: `drainErrors()` on an
 *     in-memory settings manager can only report on a document the host itself
 *     just built.
 *  9. `compat.supportsFinishReason` in the `model-config` schema — the host
 *     writes THREE `compat` fields: F1.243's `supportsStore: false` on every
 *     openai-completions custom-endpoint model, and F1.1263's `maxTokensField:
 *     'max_tokens'` + `supportsUsageInStreaming: false` on a BYO one (not the
 *     gateway, not api.openai.com) — all in `buildCustomEndpointModelDef`. The
 *     other siblings, this one included, are unwritten, so one more optional
 *     field changes nothing. A future compat row starts from that builder.
 *
 * (I2.30, the `powershell` builtin, is DECIDED elsewhere: declined until the
 * Windows channel. It is not on this list.)
 */
export const SUPPORTED_PI_RUNTIME_VERSION = '0.87.1';

/**
 * Pi 0.84 replaced the `AuthStorage` + `ModelRegistry.inMemory(authStorage)`
 * pair with one async `ModelRuntime`, and `ModelRuntime.create()` reaches for
 * ambient state we deliberately do not give it:
 *
 * - `modelsPath` defaults to the GLOBAL `~/.pi/agent/models.json`, and
 *   `modelsStorePath` to `models-store.json` beside it. `modelsPath: null` turns
 *   both off — `model-runtime.js` swaps in an in-memory models store when the
 *   path is absent.
 * - `credentials` defaults to `AuthStorage.create(authPath)`, i.e. the global
 *   `~/.pi/agent/auth.json`. We always pass a process-local store, so `authPath`
 *   is never consulted.
 * - every built-in provider is wrapped in a `pi.dev` catalog fetcher. It only
 *   fetches when `allowNetwork` is true; `create()` computes that as
 *   `modelNetworkEnabled && options.allowModelNetwork === true`, so leaving
 *   `allowModelNetwork` at its documented default of `false` closes the
 *   construction-time fetch. It does NOT close later ones:
 *   `ModelRuntime.refresh()` defaults `allowNetwork` to the runtime's own
 *   `modelNetworkEnabled`, which is `process.env.PI_OFFLINE === undefined` — so
 *   an extension calling `modelRegistry.refresh()` with no argument would reach
 *   pi.dev. `PI_OFFLINE` is therefore set before the first `create()` (see
 *   `createOfflineModelRuntime`) and is the durable half of the opt-out.
 *
 * Nessy composes the Pi runtime closed. Both halves are required; neither alone
 * is sufficient.
 */
const OFFLINE_MODEL_RUNTIME_OPTIONS: CreateModelRuntimeOptions = Object.freeze({
  modelsPath: null,
  allowModelNetwork: false,
});

async function createOfflineModelRuntime(
  create: (options?: CreateModelRuntimeOptions) => Promise<ModelRuntime>,
  credentials: CredentialStore,
): Promise<ModelRuntime> {
  // Set before the first `create()` so the constructed runtime records
  // `modelNetworkEnabled === false`; every later `refresh()` that omits
  // `allowNetwork` then inherits offline instead of pi.dev.
  process.env.PI_OFFLINE ??= '1';
  const runtime = await create({ ...OFFLINE_MODEL_RUNTIME_OPTIONS, credentials });
  // Asserted, not assumed: `allowModelNetwork` is documented as defaulting to
  // false and the flag lives on a private field, so the reachable proof that the
  // opt-out took is the env the runtime read.
  if (process.env.PI_OFFLINE === undefined) {
    throw new Error('Unsupported Pi runtime shape: PI_OFFLINE was cleared before model-runtime construction');
  }
  return runtime;
}

export interface PiRuntimeBindings {
  version: string;
  credentialStoreInMemory(): CredentialStore;
  createModelRuntime(credentials: CredentialStore): Promise<ModelRuntime>;
  modelRegistryFromRuntime(modelRuntime: ModelRuntime): ModelRegistry;
  sessionManager: {
    inMemory(cwd?: string): SessionManager; create(cwd: string, sessionDir: string): SessionManager; // UA12.217
    continueRecent(cwd: string, sessionDir: string): SessionManager;
    open(parentFile: string, cwd: string): SessionManager;
    forkFrom(parentFile: string, cwd: string, sessionDir: string): SessionManager;
  };
  settingsManagerInMemory(settings?: Parameters<typeof SettingsManager.inMemory>[0]): SettingsManager;
  createResourceLoader(options: ConstructorParameters<typeof DefaultResourceLoader>[0]): ResourceLoader;
  createAgentSession(options: CreateAgentSessionOptions): Promise<{ session: AgentSession }>;
}

export interface PiRuntimePublicSurface {
  VERSION: string;
  InMemoryCredentialStore: new () => CredentialStore;
  ModelRuntime: Pick<typeof ModelRuntime, 'create'>;
  ModelRegistry: new (modelRuntime: ModelRuntime) => ModelRegistry;
  SessionManager: Pick<typeof SessionManager, 'inMemory' | 'create' | 'continueRecent' | 'open' | 'forkFrom'>; // UA12.217 adds create
  SettingsManager: Pick<typeof SettingsManager, 'inMemory'>;
  DefaultResourceLoader: typeof DefaultResourceLoader;
  createAgentSession: typeof createAgentSession;
}

export interface PiRuntimeRegistry {
  /**
   * Process-local credential store. Pi 0.84 dropped `AuthStorage` from the
   * package's public export path; `CredentialStore.modify()` is now the only
   * write path, and it is async.
   */
  credentials: CredentialStore;
  /** Canonical model/auth runtime handed to `createAgentSession`. */
  modelRuntime: ModelRuntime;
  /** Synchronous compatibility facade over `modelRuntime`, for our call sites. */
  modelRegistry: ModelRegistry;
}

export type PiRuntimeSessionStrategy =
  | { kind: 'memory' }
  | { kind: 'continue'; sessionDir: string } | { kind: 'fresh'; sessionDir: string } // UA12.217 — a NEW persisted session in the dir (post-/clear), via Pi's own SessionManager.create
  | { kind: 'reopen'; sessionFile: string }
  | {
      kind: 'fork';
      sessionDir: string;
      parentSessionFile: string;
      anchorEntryId?: string;
    };

export interface CreatePiRuntimeSessionOptions {
  cwd: string;
  agentDir?: string;
  registry: PiRuntimeRegistry;
  strategy: PiRuntimeSessionStrategy;
  systemPrompt?: string;
  executionManifest?: PiExecutionManifestV2;
  toolExecutor?: ToolExecutor;
  responseEpoch?: number;
  compaction?: {
    enabled: boolean;
    reserveTokens?: number;
  };
  /** UB7.16 — the session's cache-warming mode; absent keeps Pi's `streaming` default. */
  cacheWarming?: CacheWarmingMode;
  /**
   * UB2.15 — pi-ai's provider-level retry block, seeded at CREATION because the
   * `Agent` snapshots its `maxRetryDelayMs` cap there (see
   * `PI_UTILITY_PROVIDER_RETRY_SETTINGS` in `gateway-retry-settings.ts`). Absent
   * keeps Pi's own creation-time cap (60 s), which is the main sessions' cap.
   */
  providerRetry?: NonNullable<RetrySettings['provider']>;
  lifecycleEventSink?: (event: AgentEvent, input: SdkAutomationInput) => Promise<void> | void;
  autoCompactionExtension?: ExtensionFactory;
  transformToolResult?: (input: {
    toolName: string;
    toolInput: Record<string, unknown>;
    toolResponse: string;
    isError: boolean;
  }) => Promise<{ updatedToolOutput?: string } | void> | { updatedToolOutput?: string } | void;
  /** R73 · awaited `PreCompact` decision; see `PiLifecycleBridgeOptions`. */
  requestCompactionDecision?: (input: {
    trigger: 'manual' | 'auto';
    source: string;
    /** D1.115 — `null` on `auto`, and on a `manual` the user passed nothing to. */
    customInstructions: string | null;
  }) => Promise<{ block?: boolean; reason?: string } | void> | { block?: boolean; reason?: string } | void;
  getOriginalUserPrompt?: () => string | null;
  deferredMcpExtension?: ExtensionFactory;
  contextResources?: readonly PiContextResourceDescriptor[];
  sessionOptions: Omit<
    CreateAgentSessionOptions,
    'cwd' | 'agentDir' | 'modelRuntime' | 'resourceLoader' | 'sessionManager' | 'settingsManager'
  >;
}

export interface PiRuntimeSessionHandle {
  session: AgentSession;
  sessionFile?: string;
  setSystemPrompt(prompt: string): void; // the next request's before_agent_start override, and (F1.838) the running request's next model call
  compact(instructions?: string): ReturnType<AgentSession['compact']>;
  dispose(): void;
}

export interface PiRuntimeAdapter {
  /**
   * Async since Pi 0.84 — `ModelRuntime.create()` loads the model config and
   * runs an (offline) catalog refresh before the runtime exists, and the
   * synchronous `ModelRegistry` facade cannot be built without it. The
   * alternative considered was hiding the await behind a lazily-resolved
   * runtime so this stayed synchronous; that was rejected because every
   * consumer of `modelRegistry` reads it synchronously, so the laziness would
   * only have moved the await to a less visible place. Callers that must not
   * yield in a critical window (the cwd transaction's generation reservation)
   * take this await ahead of that window instead.
   */
  createRegistry(existingCredentials?: CredentialStore): Promise<PiRuntimeRegistry>;
  createSession(options: CreatePiRuntimeSessionOptions): Promise<PiRuntimeSessionHandle>;
}

export interface PiRuntimeAdapterConstructionOptions {
  verifiedSignedBundleRoot?: VerifiedSignedBundleRootCapability;
}

const defaultPublicSurface: PiRuntimePublicSurface = {
  VERSION,
  InMemoryCredentialStore,
  ModelRuntime,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  createAgentSession,
};

function assertFunction(owner: unknown, key: string, label = key): void {
  if (!owner || typeof owner !== 'object' && typeof owner !== 'function'
    || typeof (owner as Record<string, unknown>)[key] !== 'function') {
    throw new Error(`Unsupported Pi runtime shape: missing ${label}`);
  }
}

function assertConstructor(value: unknown, label: string): void {
  if (typeof value !== 'function') {
    throw new Error(`Unsupported Pi runtime shape: missing ${label}`);
  }
}

function validatePublicSurface(surface: PiRuntimePublicSurface): void {
  if (surface.VERSION !== SUPPORTED_PI_RUNTIME_VERSION) {
    throw new Error(
      `Unsupported Pi runtime ${surface.VERSION}; expected ${SUPPORTED_PI_RUNTIME_VERSION}`,
    );
  }
  assertConstructor(surface.InMemoryCredentialStore, 'InMemoryCredentialStore');
  // `modify` is the only write path in 0.84's `CredentialStore` and the one we
  // rotate the gateway JWT through, so it is validated by name rather than
  // trusted to exist.
  assertFunction(
    surface.InMemoryCredentialStore.prototype,
    'modify',
    'InMemoryCredentialStore.prototype.modify',
  );
  assertFunction(
    surface.InMemoryCredentialStore.prototype,
    'read',
    'InMemoryCredentialStore.prototype.read',
  );
  assertFunction(surface.ModelRuntime, 'create', 'ModelRuntime.create');
  assertConstructor(surface.ModelRegistry, 'ModelRegistry');
  for (const method of ['find', 'registerProvider', 'getApiKeyAndHeaders'] as const) {
    assertFunction(surface.ModelRegistry.prototype, method, `ModelRegistry.prototype.${method}`);
  }
  assertFunction(surface.SessionManager, 'inMemory', 'SessionManager.inMemory');
  assertFunction(surface.SessionManager, 'continueRecent', 'SessionManager.continueRecent');
  assertFunction(surface.SessionManager, 'open', 'SessionManager.open'); assertFunction(surface.SessionManager, 'create', 'SessionManager.create'); // UA12.217
  assertFunction(surface.SessionManager, 'forkFrom', 'SessionManager.forkFrom');
  assertFunction(surface.SettingsManager, 'inMemory', 'SettingsManager.inMemory');
  if (typeof surface.DefaultResourceLoader !== 'function') {
    throw new Error('Unsupported Pi runtime shape: missing DefaultResourceLoader');
  }
  assertFunction(
    surface.DefaultResourceLoader.prototype,
    'reload',
    'DefaultResourceLoader.prototype.reload',
  );
  assertFunction(surface, 'createAgentSession');
}

function bindingsFromPublicSurface(surface: PiRuntimePublicSurface): PiRuntimeBindings {
  return {
    version: surface.VERSION,
    credentialStoreInMemory: () => new surface.InMemoryCredentialStore(),
    createModelRuntime: credentials => createOfflineModelRuntime(
      options => surface.ModelRuntime.create(options),
      credentials,
    ),
    modelRegistryFromRuntime: modelRuntime => new surface.ModelRegistry(modelRuntime),
    sessionManager: {
      inMemory: cwd => surface.SessionManager.inMemory(cwd),
      continueRecent: (cwd, sessionDir) => surface.SessionManager.continueRecent(cwd, sessionDir),
      open: (parentFile, cwd) => surface.SessionManager.open(parentFile, undefined, cwd), create: (cwd, sessionDir) => surface.SessionManager.create(cwd, sessionDir), // UA12.217
      forkFrom: (parentFile, cwd, sessionDir) => surface.SessionManager.forkFrom(parentFile, cwd, sessionDir),
    },
    settingsManagerInMemory: settings => surface.SettingsManager.inMemory(settings ?? {}, { projectTrusted: false }),
    createResourceLoader: options => new surface.DefaultResourceLoader(options),
    createAgentSession: surface.createAgentSession,
  };
}

function validateBindings(bindings: PiRuntimeBindings): void {
  if (bindings.version !== SUPPORTED_PI_RUNTIME_VERSION) {
    throw new Error(
      `Unsupported Pi runtime ${bindings.version}; expected ${SUPPORTED_PI_RUNTIME_VERSION}`,
    );
  }
  assertFunction(bindings, 'credentialStoreInMemory');
  assertFunction(bindings, 'createModelRuntime');
  assertFunction(bindings, 'modelRegistryFromRuntime');
  if (!bindings.sessionManager || typeof bindings.sessionManager !== 'object') {
    throw new Error('Unsupported Pi runtime shape: missing sessionManager');
  }
  assertFunction(bindings.sessionManager, 'inMemory', 'sessionManager.inMemory');
  assertFunction(bindings.sessionManager, 'continueRecent', 'sessionManager.continueRecent');
  assertFunction(bindings.sessionManager, 'open', 'sessionManager.open');
  assertFunction(bindings.sessionManager, 'forkFrom', 'sessionManager.forkFrom'); assertFunction(bindings.sessionManager, 'create', 'sessionManager.create'); // UA12.217
  assertFunction(bindings, 'settingsManagerInMemory');
  assertFunction(bindings, 'createResourceLoader');
  assertFunction(bindings, 'createAgentSession');
}

function validateSession(session: AgentSession): void {
  for (const method of [
    'prompt',
    'subscribe',
    'compact',
    'abort',
    'dispose',
    'setModel',
    'setThinkingLevel',
    'steer',
    'setAutoCompactionEnabled',
  ] as const) {
    if (typeof session?.[method] !== 'function') {
      throw new Error(`Unsupported Pi session shape: missing ${method}`);
    }
  }
  if (typeof session.sessionId !== 'string') {
    throw new Error('Unsupported Pi session shape: missing sessionId');
  }
  if (!session.sessionManager || typeof session.sessionManager.getLeafId !== 'function') {
    throw new Error('Unsupported Pi session shape: missing sessionManager.getLeafId');
  }
  if (typeof session.autoCompactionEnabled !== 'boolean') {
    throw new Error('Unsupported Pi session shape: missing autoCompactionEnabled');
  }
  if (typeof session.isCompacting !== 'boolean') {
    throw new Error('Unsupported Pi session shape: missing isCompacting');
  }
  if (!Array.isArray(session.messages)) {
    throw new Error('Unsupported Pi session shape: missing messages');
  }
  if (!session.agent || typeof session.agent !== 'object') {
    throw new Error('Unsupported Pi session shape: missing agent');
  }
  const toolExecution = (session.agent as { toolExecution?: unknown }).toolExecution;
  if (toolExecution !== 'parallel' && toolExecution !== 'sequential') {
    throw new Error('Unsupported Pi session shape: missing or invalid agent.toolExecution');
  }
}

export function createPiRuntimeAdapter(
  bindings?: PiRuntimeBindings,
  publicSurface: PiRuntimePublicSurface = defaultPublicSurface,
  constructionOptions: PiRuntimeAdapterConstructionOptions = {},
): PiRuntimeAdapter {
  if (!bindings) {
    validatePublicSurface(publicSurface);
    bindings = bindingsFromPublicSurface(publicSurface);
  }
  validateBindings(bindings);

  return {
    async createRegistry(existingCredentials) {
      const credentials = existingCredentials ?? bindings.credentialStoreInMemory();
      const modelRuntime = await bindings.createModelRuntime(credentials);
      return {
        credentials,
        modelRuntime,
        modelRegistry: bindings.modelRegistryFromRuntime(modelRuntime),
      };
    },

    async createSession(options) {
      const { cwd, agentDir, registry, strategy, sessionOptions } = options;
      const settingsManager = bindings.settingsManagerInMemory({
        ...(options.compaction ? { compaction: options.compaction } : {}),
        // UB7.16 — the cache-warming pin travels with the session. Absent keeps
        // the settings empty, which is Pi's own `streaming` default (kept and
        // stated for main chats); utility sessions pass 'off' through
        // `cacheWarmingForSession('ephemeral')` so a one-shot query never pays
        // for a warm request with no follow-up to save.
        ...(options.cacheWarming ? { cacheWarming: options.cacheWarming } : {}),
        // UB2.15 — the provider block's cap binds only if it is here before
        // `createAgentSession` runs; a copy, so the frozen profile never enters
        // Pi's settings object.
        ...(options.providerRetry ? { retry: { provider: { ...options.providerRetry } } } : {}),
      });

      let systemPrompt = options.systemPrompt;
      let promptCwd = cwd; // F1.907: the cwd Pi last handed `before_agent_start` — see {@link withPiWorkingDirectoryLine}
      // 0.87: an ExtensionFactory must return void — the `pi.on` disposer is dropped on purpose (the extension lives for the whole session). The loop no longer reads `context.systemPrompt` and Pi's forced projection re-reads `_runSystemPromptOptions`, which Pi REBUILDS per turn — so F1.838's mid-request setSystemPrompt re-renders the projected head in the `transformContext` wrapper below instead.
      const promptExtension: ExtensionFactory = pi => {
        pi.on('before_agent_start', event => { promptCwd = event.systemPromptOptions?.cwd ?? cwd; return systemPrompt === undefined ? undefined : { systemPrompt: withPiWorkingDirectoryLine(systemPrompt, promptCwd) }; });
      };
      const lifecycleExtension = createPiLifecycleExtension({
        // Same base Pi resolves a relative tool path against — the value handed
        // to `createExecutor`/`createResourceLoader` below.
        cwd,
        emit: options.lifecycleEventSink ?? (() => undefined),
        getOriginalUserPrompt: options.getOriginalUserPrompt ?? (() => null),
        ...(options.transformToolResult ? { transformToolResult: options.transformToolResult } : {}),
        // R73. The lifecycle extension is registered BEFORE
        // `autoCompactionExtension` below, and `runner.emit` short-circuits on
        // the first handler that returns `cancel` — so a bridge cancel wins over
        // the auto-compaction handler's own `{ compaction }`. Reversing that
        // order would silently overwrite a hook's block.
        ...(options.requestCompactionDecision ? { requestCompactionDecision: options.requestCompactionDecision } : {}),
      });
      const extensionFactories = [
        ...composeCuratedPiExtensionFactories(
          promptExtension,
          lifecycleExtension,
          options.deferredMcpExtension,
          PINNED_NESSY_FACTORIES,
          options.executionManifest,
          options.toolExecutor,
          options.responseEpoch,
        ),
        ...(options.autoCompactionExtension ? [options.autoCompactionExtension] : []),
      ];
      const resourceLoader = bindings.createResourceLoader({
        cwd,
        // UB1.19 (B2-07 residue 1): a session-less agent's agentDir is a per-process
        // scratch dir, never the cwd — `cwd` here let Pi's discovery read
        // `<cwd>/SYSTEM.md` and `<cwd>/APPEND_SYSTEM.md` as "global" (upstream v0.15.0).
        agentDir: resolveNessyAgentDir({ agentDir }),
        settingsManager,
        extensionFactories: [...extensionFactories],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        ...createCuratedResourceOverrides(
          [
            ...PINNED_NESSY_RESOURCES,
            ...(options.contextResources ?? []).map(resource => ({
              id: resource.id,
              kind: resource.kind,
              relativePath: `runtime/${resource.id.replace(/[^A-Za-z0-9._-]/g, '_')}.json`,
              sha256: resource.sha256,
              provenance: resource.provenance,
              bundledContent: resource.content,
            })),
          ],
          constructionOptions.verifiedSignedBundleRoot,
        ),
      });
      await resourceLoader.reload();

      let forkArtifactPath: string | undefined;
      let sessionFile: string | undefined;
      let result: { session: AgentSession } | undefined;
      try {
        let sessionManager: SessionManager;
        if (strategy.kind === 'memory') {
          sessionManager = bindings.sessionManager.inMemory(cwd);
        } else if (strategy.kind === 'continue') {
          sessionManager = bindings.sessionManager.continueRecent(cwd, strategy.sessionDir);
        } else if (strategy.kind === 'fresh') {
          // UA12.217 — a NEW persisted session in the session dir (Pi's own constructor for
          // "create, don't resume"): the post-/clear conversation keeps crashing/resuming
          // like any other, while the pre-clear sidecar stays untouched for /resume.
          sessionManager = bindings.sessionManager.create(cwd, strategy.sessionDir);
        } else if (strategy.kind === 'reopen') {
          sessionManager = bindings.sessionManager.open(strategy.sessionFile, cwd);
        } else {
          const parentSession = bindings.sessionManager.open(strategy.parentSessionFile, cwd);
          if (strategy.anchorEntryId && !parentSession.getEntry(strategy.anchorEntryId)) {
            throw new Error(`Pi branch preflight failed: branch anchor not found: ${strategy.anchorEntryId}`);
          }
          sessionManager = bindings.sessionManager.forkFrom(
            strategy.parentSessionFile,
            cwd,
            strategy.sessionDir,
          );
          forkArtifactPath = sessionManager.getSessionFile();
          if (strategy.anchorEntryId) {
            sessionManager.branch(strategy.anchorEntryId);
          }
        }
        sessionFile = strategy.kind === 'reopen'
          ? strategy.sessionFile
          : sessionManager.getSessionFile?.();

        result = await bindings.createAgentSession({
          ...sessionOptions,
          cwd,
          ...(agentDir ? { agentDir } : {}),
          modelRuntime: registry.modelRuntime,
          settingsManager,
          resourceLoader,
          sessionManager,
        });
        validateSession(result.session);
        result.session.agent.toolExecution = 'parallel';
        if (result.session.agent.toolExecution !== 'parallel') {
          throw new Error('Unsupported Pi session shape: parallel tool execution assignment did not stick');
        }
        const agent = result.session.agent;
        const previousPrepareNextTurnWithContext = agent.prepareNextTurnWithContext
          ?? (agent.prepareNextTurn
            ? async (_turn, signal) => agent.prepareNextTurn?.(signal)
            : undefined);
        agent.prepareNextTurnWithContext = async (turn, signal) => {
          const previous = await previousPrepareNextTurnWithContext?.call(agent, turn, signal);
          if (!Array.isArray(agent.state.tools)) {
            throw new Error('Unsupported Pi session shape: missing agent.state.tools');
          }
          return {
            ...previous,
            context: {
              ...(previous?.context ?? turn.context),
              tools: agent.state.tools.slice(),
            },
          };
        };
        // F1.838 on 0.87 — the loop no longer reads `context.systemPrompt`, and Pi's own forced
        // projection re-renders the head from `_runSystemPromptOptions`, which Pi REBUILDS per
        // turn, so a mid-request `setSystemPrompt` cannot ride that field past the first turn.
        // Re-render the CURRENT override onto the projected head instead — the same seam and the
        // same one-head contract Pi's projection keeps (head text replaced, head tools kept).
        const previousTransformContext = agent.transformContext;
        agent.transformContext = async (messages, signal) => {
          const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
          if (systemPrompt === undefined) return transformed;
          const head = transformed[0] as { role?: string } | undefined;
          if (!head || head.role !== 'system') return transformed;
          transformed[0] = { ...head, role: 'system', content: withPiWorkingDirectoryLine(systemPrompt, promptCwd) } as (typeof transformed)[number];
          return transformed;
        };
        const normalizedMessages = normalizePiSdkToolCallRecordsV1(result.session.messages);
        result.session.messages.splice(0, result.session.messages.length, ...normalizedMessages);
      } catch (error) {
        try {
          result?.session?.dispose?.();
        } catch {
          // Preserve the construction/shape error; fork cleanup still must run.
        }
        if (forkArtifactPath) {
          try {
            rmSync(forkArtifactPath, { force: true });
          } catch {
            // Preserve the original construction/shape error.
          }
        }
        throw error;
      }

      if (!result) throw new Error('Pi runtime session construction returned no result');

      let disposed = false;
      return {
        session: result.session,
        sessionFile,
        setSystemPrompt(prompt) {
          systemPrompt = prompt;
          // F1.838 on 0.87: the transformContext wrapper below re-renders the projected head on the next model call.
        },
        compact: instructions => result.session.compact(instructions),
        dispose() {
          if (disposed) return;
          result.session.dispose();
          disposed = true;
        },
      };
    },
  };
}

/**
 * F1.907 — Pi's own working-directory line, put back after the host replaced
 * Pi's prompt.
 *
 * Pi ends every system prompt it builds with `Current working directory: <cwd>`,
 * the folder its tools resolve paths against, in both branches of
 * `buildSystemPrompt` (`dist/core/system-prompt.js`, `@earendil-works/pi-coding-agent`
 * 0.85.1). This is that function's `customPrompt`-branch spelling, backslashes
 * turned to `/` as Pi turns them. The host replaces the prompt whole in
 * `before_agent_start`, which dropped the line, so a no-project session was told
 * only the host's own block, the session folder the file floor refuses, while
 * Pi ran in the workspace root.
 *
 * The folder is the one Pi hands the handler, `event.systemPromptOptions.cwd`
 * (the package's `docs/extensions.md`, `before_agent_start`: ".cwd - working
 * directory"), so the line follows Pi's own notion of its folder. The adapter's
 * `cwd`, the value Pi was constructed with, stands in only for an event that
 * carries no options (test doubles; the real event always does). Pi's native
 * path for a custom prompt, `DefaultResourceLoader({ systemPromptOverride })`,
 * would append the line itself, but the loader reads the override once, at
 * `reload()`, and the host prompt changes every turn.
 */
export function withPiWorkingDirectoryLine(systemPrompt: string, cwd: string): string {
  return `${systemPrompt}\nCurrent working directory: ${cwd.replace(/\\/g, '/')}\n`;
}
