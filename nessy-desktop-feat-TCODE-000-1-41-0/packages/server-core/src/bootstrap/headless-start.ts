import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
import { uptime as osUptime } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  isLockFromForeignProcess,
  isProcessAlive,
  parseLockContent,
  type LockPayload,
} from './server-lock-identity'
import { OAuthFlowStore } from '@nessy-agent/shared/auth'
import { ensureConfigDir, getLlmConnections, loadStoredConfig } from '@nessy-agent/shared/config'
import { isGatewayBackedConnection } from '@nessy-agent/shared/agent/backend'
import { getCredentialManager } from '@nessy-agent/shared/credentials'
import {
  registerEnforcedManagedModelPricing,
  registerEnforcedManagedNonGatewayConnections,
  registerEnforcedManagedPolicyProvider,
  registerEnforcedManagedRetentionProvider,
  registerEnforcedManagedSandboxEnabledProvider,
} from './managed-policy-resolution'
import { getValidCreds } from '@nessy-agent/shared/auth/dp'
import { resolveManagedApproval } from '@nessy-agent/shared/config/managed-approval'
import {
  initializeManagedDeliveryFromCache,
  setManagedDeliveryApproval,
  setManagedDeliveryEnabled,
  startManagedDeliveryEnvApplication,
  startManagedDeliveryPolling,
} from '@nessy-agent/shared/config/managed-delivery'
import type {
  ManagedDeliveryApprovalV1,
  ManagedDeliveryStateV1,
} from '@nessy-agent/shared/config/managed-delivery'
import { enforceForceRemoteSettingsRefresh } from '@nessy-agent/shared/config/managed-refresh-gate'
import { enforceManagedVersionGate } from '@nessy-agent/shared/config/managed-version-gate'
import {
  DEFAULT_MANAGED_PI_POLICY,
  type ManagedPiPolicyV1,
} from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { loadManagedPiPolicy } from '../pi-harness/managed-policy-loader'
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
import { setBundledAssetsRoot } from '@nessy-agent/shared/utils'
import {
  ensureStorageLayoutV2,
  type StorageHostLease,
  type StorageReadinessBlockedCode,
  type StorageReadinessResult,
  type VerifiedStorageLayoutV2,
} from '@nessy-agent/shared/workspaces'
import { WsRpcServer, type WsRpcServerOptions, type WsRpcTlsOptions } from '../transport/server'
import type { EventSink, RpcServer } from '../transport/types'
import { createHeadlessPlatform } from '../runtime/platform-headless'
import type { PlatformServices } from '../runtime/platform'

interface ModelRefreshServiceLike {
  startAll(): void
  stopAll?(): void
}

export interface HeadlessStorageBootstrap {
  acquireHostLease(logger: PlatformServices['logger']): StorageHostLease
  releaseHostLease(hostLease: StorageHostLease): void
  ensureStorageLayout(hostLease: StorageHostLease): Promise<StorageReadinessResult>
}

export class HeadlessStorageReadinessError extends Error {
  readonly name = 'HeadlessStorageReadinessError'

  constructor(
    readonly code: StorageReadinessBlockedCode,
    readonly diagnosticPath?: string,
  ) {
    super(`Storage readiness blocked: ${code}`)
  }
}

/**
 * `server-managed-settings.md#enforce-fail-closed-startup` — "When this setting
 * is active in a session that fetches server-managed settings, the CLI blocks at
 * startup until remote settings are freshly fetched. If the fetch fails, the CLI
 * exits rather than proceeding without the policy."
 *
 * Thrown out of `bootstrapServer`, which is how this host exits: the entry
 * point prints the message and exits non-zero. The message is the RECOVERY
 * text, because that is what the operator needs; the underlying reason is
 * logged separately and is already scrubbed of the request URL by the fetch
 * layer — a proxied URL can carry credentials.
 */
export class ManagedSettingsStartupError extends Error {
  readonly name = 'ManagedSettingsStartupError'

  constructor(readonly reason: string, recovery: string) {
    super(recovery)
  }
}

/**
 * Server-delivered managed settings for the HEADLESS hosts.
 *
 * This lifecycle used to exist only in the desktop shell. The consequence was
 * worse than an unwired gate: delivery is off by default in the library
 * (`setManagedDeliveryEnabled`), so `nessy-server` — and the CLI, which spawns
 * exactly this server as a child process — never fetched, never cached, and
 * never applied a delivered `env` block. `forceRemoteSettingsRefresh` could not
 * have been satisfied there even if the gate had been wired, because there was
 * no cache for it to read.
 *
 * The four startup steps are the desktop host's, in the same order and for the
 * same documented reasons (`:157` cache applies immediately, `:161` transport,
 * routing and credential variables stay withheld until a fetch confirms,
 * `:167` the confirming fetch releases them without a restart, `:147` the
 * hourly poll).
 *
 * The approval gate differs, and only in its mode. A headless run cannot put a
 * modal in front of a person, which is `:221`: the payload "applies for that
 * run only: it doesn't record them as approved or write them to the local
 * cache", so the next interactive session still shows the dialog.
 * `resolveManagedApproval` owns that combination — apply, do not persist, do
 * not stamp — because it is the one a caller gets wrong.
 *
 * Returns the teardown for the timers this installs.
 */
/**
 * `settings-reference.md#requiredminimumversion` and `#requiredmaximumversion` —
 * the admin version floor and ceiling. Out of range, "Claude Code exits at
 * startup and tells the user to update through your organization's approved
 * method".
 *
 * Reuses {@link ManagedSettingsStartupError} because the refusal is the same
 * one: bootstrap throws, the entry point prints the recovery text and exits
 * non-zero. Fail-open is enforced by the parser (an invalid bound is stripped)
 * and again by the gate (an unparseable running version is allowed), so this
 * call can only refuse on a comparison an admin actually wrote.
 */
export function assertManagedVersionAllowed(
  policy: ManagedPiPolicyV1,
  version: string | undefined,
): void {
  if (!version) return
  const decision = enforceManagedVersionGate({
    version,
    ...(policy.requiredMinimumVersion === undefined
      ? {}
      : { requiredMinimumVersion: policy.requiredMinimumVersion }),
    ...(policy.requiredMaximumVersion === undefined
      ? {}
      : { requiredMaximumVersion: policy.requiredMaximumVersion }),
  })
  if (decision.outcome === 'allowed') return
  throw new ManagedSettingsStartupError(decision.reason ?? decision.outcome, decision.recovery ?? '')
}

export interface ManagedSettingsDeliverySeams {
  /**
   * The security approval gate, when the HOST owns one.
   *
   * A host with a user in front of it must supply its own: the gate installed
   * below is `non-interactive` by construction, and installing it over a
   * host's interactive gate is what P3.289 measured on the desktop — the
   * fail-closed refresh at the end of this function then resolved a delivered
   * payload with no prompt, so `server-managed-settings.md#security-approval-dialogs`'s
   * "If a user rejects the settings, Claude Code exits" branch could not fire
   * for it. The desktop shell passes its interactive gate through
   * {@link ServerBootstrapOptions.managedDeliveryApproval}; a genuinely
   * headless host omits this and gets the `non-interactive` resolution
   * `#approval-memory` prescribes.
   */
  approval?: ManagedDeliveryApprovalV1
  /** The gateway JWT. Defaults to the shared dp credential store. */
  jwt?: () => string | null
  /** The host-owned policy file. Defaults to `loadManagedPiPolicy()`. */
  managedFilePolicy?: () => ManagedPiPolicyV1
  /** The fail-closed gate's fetch. Defaults to a real refresh. */
  refresh?: (jwt: string) => Promise<ManagedDeliveryStateV1>
  cachePath?: string
}

export async function startManagedSettingsDelivery(
  platform: PlatformServices,
  seams: ManagedSettingsDeliverySeams = {},
): Promise<() => void> {
  const readJwt = seams.jwt ?? (() => getValidCreds()?.jwt ?? null)
  setManagedDeliveryEnabled(true)
  // Installed BEFORE anything can fetch, so no delivered payload is ever
  // applied without passing through `:207`-`:222`'s classification. A host
  // that supplied its own gate keeps it — see {@link
  // ManagedSettingsDeliverySeams.approval}.
  setManagedDeliveryApproval(seams.approval ?? (async (salvage, context) => {
    const resolution = await resolveManagedApproval({
      policy: salvage.policy,
      payload: salvage.payload,
      mode: 'non-interactive',
      ...(context.approvedDigest === undefined ? {} : { approvedDigest: context.approvedDigest }),
    })
    return {
      apply: resolution.apply,
      persist: resolution.persist,
      approvedDigest: resolution.approvedDigest,
    }
  }))
  initializeManagedDeliveryFromCache(seams.cachePath)
  const stopEnv = startManagedDeliveryEnvApplication()
  const stopPoll = startManagedDeliveryPolling({
    jwt: readJwt,
    ...(seams.cachePath === undefined ? {} : { cachePath: seams.cachePath }),
  })

  try {
    const gate = await enforceForceRemoteSettingsRefresh({
      managedFilePolicy: (seams.managedFilePolicy ?? loadManagedPiPolicy)(),
      jwt: readJwt(),
      ...(seams.refresh === undefined ? {} : { refresh: seams.refresh }),
      ...(seams.cachePath === undefined ? {} : { cachePath: seams.cachePath }),
    })
    if (gate.outcome === 'blocked') {
      stopEnv()
      stopPoll()
      throw new ManagedSettingsStartupError(gate.reason ?? 'managed settings refresh failed', gate.recovery ?? '')
    }
    if (gate.outcome === 'needs-authentication') {
      // Never an exit. This host has no separate `auth` binary for `:205` to
      // exempt, so exiting on absent credentials is what would make an expired
      // credential unrecoverable — see `managed-refresh-gate.ts`.
      platform.logger.warn('[managed-settings] fail-closed startup awaiting gateway sign-in')
    }
  } catch (error) {
    if (error instanceof ManagedSettingsStartupError) throw error
    platform.logger.warn('[managed-settings] fail-closed startup check error:', error)
  }

  return () => {
    stopEnv()
    stopPoll()
  }
}

export interface ServerBootstrapOptions<TSessionManager, THandlerDeps> {
  serverToken?: string
  rpcHost?: string
  rpcPort?: number
  bundledAssetsRoot?: string
  platformFactory?: () => PlatformServices
  applyPlatformToSubsystems?: (platform: PlatformServices) => void
  storageBootstrap?: HeadlessStorageBootstrap
  verifiedStorageLayout?: VerifiedStorageLayoutV2
  configArtifactsInitializer?: (platform: PlatformServices) => void
  globalConfigInitializer?: (platform: PlatformServices) => void
  rpcServerFactory?: (options: WsRpcServerOptions) => WsRpcServer
  createSessionManager: (storageLayout: VerifiedStorageLayoutV2) => TSessionManager | Promise<TSessionManager>
  createHandlerDeps: (ctx: {
    sessionManager: TSessionManager
    platform: PlatformServices
    oauthFlowStore: OAuthFlowStore
    storageLayout: VerifiedStorageLayoutV2
  }) => THandlerDeps
  registerAllRpcHandlers: (server: RpcServer, deps: THandlerDeps, serverCtx: ServerHandlerContext) => void
  initializeSessionManager: (sessionManager: TSessionManager) => Promise<void>
  setSessionEventSink: (sessionManager: TSessionManager, sink: EventSink) => void
  /**
   * Optional hook called after the WS RPC server is created and before it listens. Use
   * this to plumb the server into the SessionManager (e.g. `sm.setRpcServer(server)`)
   * so the remote-bridge code path for `client:browser:invoke` activates.
   */
  bindRpcServer?: (sessionManager: TSessionManager, server: RpcServer) => void
  initModelRefreshService: () => ModelRefreshServiceLike
  cleanupSessionManager?: (sessionManager: TSessionManager) => Promise<void> | void
  cleanupClientResources?: (clientId: string) => void
  onClientConnected?: (info: { clientId: string; webContentsId: number | null; workspaceId: string | null; capabilities: string[] }) => void
  serverId?: string
  /** App version string, included in handshake_ack for client compatibility checks. */
  serverVersion?: string
  /**
   * The host's security approval gate for server-delivered managed settings,
   * passed to {@link startManagedSettingsDelivery}. Supply it whenever this
   * host can put a modal in front of a person; omitting it accepts the
   * `non-interactive` resolution, which applies a payload without asking
   * (correct for a headless embedder, a defect in a windowed one — P3.289).
   */
  managedDeliveryApproval?: ManagedDeliveryApprovalV1
  /** TLS configuration. When provided, the server listens on wss:// instead of ws://. */
  tls?: WsRpcTlsOptions
  /** Cookie-based session validator for web UI auth on WebSocket upgrade. */
  validateSessionCookie?: (cookieHeader: string | null) => Promise<boolean>
  /**
   * Optional HTTP request handler for non-WebSocket requests on the RPC port.
   * When provided, the WsRpcServer serves HTTP (e.g. WebUI) on the same port.
   */
  httpHandler?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void
  /**
   * DA1.73 — authorities this deployment has ALREADY declared somewhere else,
   * unioned with `NESSY_RPC_ALLOWED_UPGRADE_HOSTS` for DA3.14's Host allowlist.
   *
   * The one caller today is `packages/server/src/index.ts`, which owns both the
   * webui's `publicWsUrl` and this call: `webui/http-server.ts`'s
   * `resolveWebSocketUrl` answers `/api/config` with that URL, so behind a
   * reverse proxy on a loopback bind the browser is HANDED a public name by this
   * same process and then refused when it presents it. An operator who declared
   * the public authority once should not have to declare it again in a second
   * variable they have to know exists — which is what DA3.14's escape hatch is
   * without this.
   *
   * It only ever ADDS a name the operator wrote down. The env variable stays the
   * general escape (a proxy whose authority differs from the webui's), and the
   * union is deduplicated so one name declared twice is one entry.
   */
  extraAllowedUpgradeHosts?: readonly string[]
}

export interface ServerHandlerContext {
  getConnectedClientCount: () => number
  serverId: string
  startedAt: number
}

export interface ServerInstance<TSessionManager> {
  platform: PlatformServices
  sessionManager: TSessionManager
  wsServer: WsRpcServer
  oauthFlowStore: OAuthFlowStore
  host: string
  port: number
  protocol: 'ws' | 'wss'
  token: string
  /** Context for server-level RPC handlers (status, health, active sessions). */
  serverHandlerContext: ServerHandlerContext
  stop: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Token entropy validation
// ---------------------------------------------------------------------------

const MIN_TOKEN_LENGTH = 16

/**
 * Reject tokens that are trivially weak. Runs at startup before the server
 * accepts connections so a bad token never reaches the wire.
 */
function validateTokenEntropy(token: string): { ok: boolean; warning?: string; error?: string } {
  if (token.length < MIN_TOKEN_LENGTH) {
    return { ok: false, error: `Token too short (${token.length} chars, minimum ${MIN_TOKEN_LENGTH}). Use a cryptographically random value.` }
  }

  // Reject single-character repeats ("aaaaaaaaaaaaaaaa")
  if (new Set(token).size === 1) {
    return { ok: false, error: 'Token has zero entropy (single repeated character).' }
  }

  // Warn (but allow) low-uniqueness tokens — fewer than 8 unique characters
  // in a 16+ char token suggests a pattern like "abcabcabc..."
  const uniqueChars = new Set(token).size
  if (uniqueChars < 8) {
    return { ok: true, warning: `Token has low entropy (${uniqueChars} unique characters). Consider using a stronger token.` }
  }

  return { ok: true }
}

/**
 * Generate a cryptographically random token suitable for server auth.
 * Returns a 48-character hex string (192 bits of entropy).
 */
export function generateServerToken(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------
// Startup lock file
// ---------------------------------------------------------------------------

const STORAGE_ROOT = resolve(CONFIG_DIR)
const LOCK_FILE = join(dirname(STORAGE_ROOT), `.${basename(STORAGE_ROOT).replace(/^\./, '')}.server.lock`)

/**
 * Returns true if the lock's `startedAt` timestamp predates the most recent
 * system boot. This means the lock was written in a previous boot cycle and
 * the PID has been reused by an unrelated process.
 */
function isLockFromPreviousBoot(startedAt: number): boolean {
  if (startedAt <= 0) return false // legacy lock without timestamp — can't tell
  const bootTime = Date.now() - osUptime() * 1000
  return startedAt < bootTime
}

class ServerLockHeldError extends Error {}

class ServerStorageHostLease implements StorageHostLease {
  private released = false
  private readonly releaseOnExit = (): void => this.release()

  constructor(private readonly payload: Required<LockPayload>) {
    process.once('exit', this.releaseOnExit)
  }

  assertHeld(): void {
    if (this.released || !existsSync(LOCK_FILE)) {
      throw new Error('Server storage host lease is not held')
    }
    const current = parseLockContent(readFileSync(LOCK_FILE, 'utf-8'))
    if (
      !current
      || current.pid !== this.payload.pid
      || current.startedAt !== this.payload.startedAt
      || current.leaseId !== this.payload.leaseId
    ) {
      throw new Error('Server storage host lease ownership changed')
    }
  }

  release(): void {
    if (this.released) return
    this.released = true
    process.off('exit', this.releaseOnExit)
    try {
      const current = existsSync(LOCK_FILE)
        ? parseLockContent(readFileSync(LOCK_FILE, 'utf-8'))
        : null
      if (
        current?.pid === this.payload.pid
        && current.startedAt === this.payload.startedAt
        && current.leaseId === this.payload.leaseId
      ) {
        unlinkSync(LOCK_FILE)
      }
    } catch {
      // Best-effort cleanup.
    }
    if (activeServerLease === this) activeServerLease = null
  }
}

let activeServerLease: ServerStorageHostLease | null = null

function acquireServerLock(logger: PlatformServices['logger']): StorageHostLease {
  if (existsSync(LOCK_FILE)) {
    try {
      const content = readFileSync(LOCK_FILE, 'utf-8')
      const lock = parseLockContent(content)

      if (lock) {
        // In Docker, PID 1 is reused across container restarts.
        // If the lock holds our own PID, it's stale from a previous run.
        if (lock.pid === process.pid) {
          if (activeServerLease) {
            throw new ServerLockHeldError('This process already holds the server storage host lease')
          }
          logger.warn(`[bootstrap] Lock file holds current PID ${lock.pid} (stale from previous container lifecycle), overwriting`)
        } else if (isProcessAlive(lock.pid)) {
          // PID is alive — but is it actually from a previous boot?
          // If the lock was written before the current boot, the OS has
          // recycled the PID and the process is unrelated.
          if (isLockFromPreviousBoot(lock.startedAt)) {
            logger.warn(`[bootstrap] Lock PID ${lock.pid} is alive but lock predates current boot (stale due to PID reuse), overwriting`)
          } else if (isLockFromForeignProcess(lock)) {
            logger.warn(`[bootstrap] Lock PID ${lock.pid} is alive but belongs to a different executable than the one that wrote the lock (PID reused within this boot), overwriting`)
          } else {
            throw new ServerLockHeldError(
              `Another server instance is already running (PID ${lock.pid}). ` +
              `If this is stale, delete ${LOCK_FILE} and retry. ` +
              `To run a parallel instance (e.g. for dev), set NESSY_CONFIG_DIR to a different path.`
            )
          }
        } else {
          logger.warn(`[bootstrap] Stale lock file found (PID ${lock.pid}), overwriting`)
        }
      } else {
        logger.warn('[bootstrap] Could not parse lock file, overwriting')
      }
    } catch (err) {
      if (err instanceof ServerLockHeldError) throw err
      logger.warn('[bootstrap] Could not read lock file, overwriting')
    }
    unlinkSync(LOCK_FILE)
  }

  const payload: Required<LockPayload> = {
    pid: process.pid,
    startedAt: Date.now(),
    leaseId: randomUUID(),
    executable: process.execPath,
  }
  try {
    writeFileSync(LOCK_FILE, JSON.stringify(payload), { encoding: 'utf-8', flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
      throw new ServerLockHeldError('Another server instance acquired the storage host lease')
    }
    throw error
  }
  const lease = new ServerStorageHostLease(payload)
  lease.assertHeld()
  activeServerLease = lease
  return lease
}

/**
 * Remove the lock file if it belongs to the current process.
 * Exported so consumers (e.g. the Electron before-quit handler) can call it
 * directly without going through `instance.stop()`.
 */
export function releaseServerLock(): void {
  activeServerLease?.release()
}

const DEFAULT_STORAGE_BOOTSTRAP: HeadlessStorageBootstrap = {
  acquireHostLease: acquireServerLock,
  releaseHostLease: (hostLease) => {
    if (hostLease instanceof ServerStorageHostLease) hostLease.release()
  },
  ensureStorageLayout: ensureStorageLayoutV2,
}

// ---------------------------------------------------------------------------
// Config artifacts
// ---------------------------------------------------------------------------

function bootstrapConfigArtifacts(platform: PlatformServices): void {
  // MUST precede ensureConfigDir(): the startup retention sweep runs inside it,
  // and the managed `cleanupPeriodDays` is both the top-precedence retention
  // value and the only thing that overrides the unreadable-settings pause. The
  // provider reads the ENFORCED composition — delivered payload and host file —
  // so a delivered-only retention value reaches the sweep (R25). A policy that
  // cannot be loaded here yields no managed value, which leaves the sweep on
  // the conservative path; createStorageRuntime resolves the same composition
  // again and fails closed for real.
  registerEnforcedManagedRetentionProvider()
  // Same reasoning, for the T1 `sandbox.enabled` master switch: registered
  // before anything can read `getMacosSeatbeltBashSandboxEnabled()` (contour
  // b) or `CodexAgent.sandboxGloballyEnabled()` (contour e), so a managed
  // floor reaches both, not only the `ProcessSupervisor` wrap (contour a),
  // which reads the same composition straight from the policy object.
  registerEnforcedManagedSandboxEnabledProvider()
  // P2.7 — the whole composed policy, for the shared-package readers that need
  // the document rather than one key: the Claude spawn projects it onto the
  // SDK's own policy tier (`Options.managedSettings`). Registered here and not
  // only in the desktop shell because the Claude runtime runs headless too, and
  // a floor that reaches one host and not the other is the "declared on one
  // path, enforced on another" defect this series keeps finding.
  //
  // `registerEnforcedManagedInAppUpdatesProvider` is deliberately NOT here: the
  // in-app updater is the electron shell's, and this host has none.
  registerEnforcedManagedPolicyProvider()
  // P6.537 — the operator's model price table, on BOTH hosts for the reason the
  // paragraph above gives about the composed policy: the cost readout and the
  // USD budget cap are the same code on the headless server, and a table that
  // priced a desktop session and not a headless one would be the same
  // one-path defect. The registration PUSHES rather than exposing a provider,
  // because the parse also returns rejections that have to reach a channel.
  registerEnforcedManagedModelPricing()
  // P6.498 — on BOTH hosts: this server serves the clients that do have cards.
  registerEnforcedManagedNonGatewayConnections()
  restoreCodexManagedApprovalsReviewers() // F1.514, then F1.101: what a codex probe last ANSWERED, before any runtime or scheduler
  restoreCodexLocalAutomationRequirement()
  ensureConfigDir()
  platform.logger.info('[bootstrap] Config artifacts initialized')
}

function ensureGlobalConfigExists(platform: PlatformServices): void {
  const config = loadStoredConfig()
  if (!config) {
    throw new HeadlessStorageReadinessError('corrupt-v2')
  }
  platform.logger.info('[bootstrap] Global config found')
}

/**
 * DA1.33 — the one-shot sweep for the credential snapshot DA1.13 stopped
 * writing.
 *
 * DA1.13 made a gateway card keep NO stored credential: the cards stopped
 * sending one, the setup RPC refuses the write and deletes any it is handed,
 * and `isUsablePiStoredCredential` refuses to read one. The delete-on-upsert is
 * the migration for anyone who re-runs their card — but a user who never does
 * keeps the keychain entry forever. It is INERT (nothing reads it, and the
 * presence check no longer consults it), so this is tidiness rather than
 * safety, and it is written to be the smallest thing that can be true.
 *
 * ONE SITE, NOT TWO. The row asked for a sweep "in BOTH bootstraps (electron
 * main + headless `nessy-server`)", which is the two-resolver shape DA1.3 warns
 * about. Measured 2026-09-17: both hosts reach model-refresh initialization
 * through THIS function — `apps/electron/src/main/index.ts` and
 * `packages/server/src/index.ts` each pass their own `initModelRefreshService`
 * into `bootstrapServer`, and `packages/server/src/index.ts` says so at its own
 * `seedBundledHostAssets` call site ("the desktop goes through `bootstrapServer`
 * too, so both would then run twice"). So the sweep sits beside that call and
 * serves both arms, with no second copy to drift.
 *
 * THE "HAS THIS RUN" MARKER IS A PROCESS FLAG, NOT A PERSISTED ONE, and that is
 * a decision rather than an omission. A persisted marker would suppress the
 * sweep for a profile that later gains an old snapshot again — a restored
 * backup, a copied config directory — and it would be a new stored key to keep
 * in the strict envelope. The delete is already idempotent across restarts
 * (`deleteLlmApiKey` answers false when there is nothing to delete) and costs
 * one keychain read per gateway card, so a boot after the first sweeps nothing
 * and logs nothing. The flag exists only so a second `bootstrapServer` call in
 * ONE process (a test, a restart-in-place) does not repeat the work.
 *
 * Scoped by `isGatewayBackedConnection`, the STRICT whole-URL predicate and the
 * same one the setup RPC uses, so a BYO endpoint that merely lives on the
 * gateway host keeps its own key. A COUNT is logged and nothing else: never a
 * slug's credential, never a length, never a value.
 *
 * Never throws. A keychain that cannot be read is not a reason to refuse to
 * boot, and the entry it would have removed is inert either way.
 */
let gatewayCredentialSweepDone = false

export async function sweepOrphanedGatewayCredentialSnapshots(
  logger: { info: (message: string) => void; warn: (message: string) => void },
  /**
   * The two reads, injectable — so a test drives both arms without a keychain
   * and without an on-disk config. The once-per-process flag lives at the CALL
   * SITE rather than in here, which is what keeps this function free of a
   * test-only `force` knob.
   */
  deps: {
    connections?: () => ReadonlyArray<{ slug: string; providerType?: string | null; baseUrl?: string | null }>
    deleteApiKey?: (slug: string) => Promise<boolean>
  } = {},
): Promise<number> {
  try {
    const readConnections = deps.connections ?? getLlmConnections
    const deleteApiKey = deps.deleteApiKey
      ?? ((slug: string) => getCredentialManager().deleteLlmApiKey(slug))
    let discarded = 0
    for (const connection of readConnections()) {
      if (!isGatewayBackedConnection(connection)) continue
      if (await deleteApiKey(connection.slug).catch(() => false)) discarded += 1
    }
    if (discarded > 0) {
      logger.info(
        `[bootstrap] Discarded ${discarded} orphaned gateway credential snapshot(s)`
        + ' — the Nessy Gateway credential of record is the live dp sign-in (DA1.13)',
      )
    }
    return discarded
  } catch (error) {
    logger.warn(
      '[bootstrap] Orphaned gateway credential sweep failed: '
      + (error instanceof Error ? error.message : String(error)),
    )
    return 0
  }
}

export async function bootstrapServer<TSessionManager, THandlerDeps>(
  options: ServerBootstrapOptions<TSessionManager, THandlerDeps>,
): Promise<ServerInstance<TSessionManager>> {
  const serverToken = options.serverToken ?? process.env.NESSY_SERVER_TOKEN
  if (!serverToken) {
    throw new Error('Server token is required. Pass options.serverToken or set NESSY_SERVER_TOKEN.')
  }

  const entropy = validateTokenEntropy(serverToken)
  if (!entropy.ok) {
    throw new Error(`Weak server token: ${entropy.error}`)
  }

  const platform = options.platformFactory?.() ?? createHeadlessPlatform({ appVersion: options.serverVersion })
  if (entropy.warning) {
    platform.logger.warn(`[bootstrap] ${entropy.warning}`)
  }

  const storageBootstrap = options.storageBootstrap ?? DEFAULT_STORAGE_BOOTSTRAP
  let hostLease: StorageHostLease | null = null
  let storageLayout = options.verifiedStorageLayout
  if (!storageLayout) {
    hostLease = storageBootstrap.acquireHostLease(platform.logger)
    try {
      const readiness = await storageBootstrap.ensureStorageLayout(hostLease)
      if (readiness.status === 'blocked') {
        throw new HeadlessStorageReadinessError(readiness.code, readiness.diagnosticPath)
      }
      storageLayout = readiness.layout
      hostLease.assertHeld()
    } catch (error) {
      storageBootstrap.releaseHostLease(hostLease)
      throw error
    }
  }

  let modelRefreshService: ModelRefreshServiceLike | null = null
  let sessionManager: TSessionManager | null = null
  let wsServer: WsRpcServer | null = null
  let oauthFlowStore: OAuthFlowStore | null = null
  let stopManagedSettingsDelivery: (() => void) | null = null

  const cleanupCreatedResources = async (): Promise<void> => {
    const stopDelivery = stopManagedSettingsDelivery
    stopManagedSettingsDelivery = null
    if (stopDelivery) {
      try {
        stopDelivery()
      } catch (error) {
        platform.logger.error('[bootstrap] Failed to stop managed settings delivery:', error)
      }
    }

    const modelRefresh = modelRefreshService
    modelRefreshService = null
    if (modelRefresh) {
      try {
        modelRefresh.stopAll?.()
      } catch (error) {
        platform.logger.error('[bootstrap] Failed to stop model refresh service:', error)
      }
    }

    const sessions = sessionManager
    sessionManager = null
    if (sessions) {
      try {
        await options.cleanupSessionManager?.(sessions)
      } catch (error) {
        platform.logger.error('[bootstrap] Failed to clean up session manager:', error)
      }
    }

    const rpc = wsServer
    wsServer = null
    if (rpc) {
      try {
        rpc.close()
      } catch (error) {
        platform.logger.error('[bootstrap] Failed to close WS server:', error)
      }
    }

    const oauth = oauthFlowStore
    oauthFlowStore = null
    if (oauth) {
      try {
        oauth.dispose()
      } catch (error) {
        platform.logger.error('[bootstrap] Failed to dispose OAuth flow store:', error)
      }
    }

    const lease = hostLease
    hostLease = null
    if (lease) {
      try {
        storageBootstrap.releaseHostLease(lease)
      } catch (error) {
        platform.logger.error('[bootstrap] Failed to release storage host lease:', error)
      }
    }
  }

  try {
    const bundledAssetsRoot = options.bundledAssetsRoot
      ?? process.env.NESSY_BUNDLED_ASSETS_ROOT
      ?? process.cwd()
    setBundledAssetsRoot(bundledAssetsRoot)

    options.applyPlatformToSubsystems?.(platform)

    const initializeConfigArtifacts = options.configArtifactsInitializer ?? bootstrapConfigArtifacts
    const initializeGlobalConfig = options.globalConfigInitializer ?? ensureGlobalConfigExists
    initializeConfigArtifacts(platform)
    initializeGlobalConfig(platform)

    // `settings-reference.md#requiredminimumversion` — "Unlike `minimumVersion`,
    // which only prevents downgrades, this key blocks startup" — so it runs
    // before anything is created. It reads the host-owned policy FILE only: an admin
    // who can pin a version can deploy that file, and reading the server cache
    // here would let a poisoned cache refuse to start the app.
    //
    // A policy file that cannot be LOADED is not this gate's business — the
    // same reasoning `bootstrapConfigArtifacts` uses for the retention
    // provider. `createStorageRuntime` re-loads it and fails closed for real,
    // so swallowing here loses nothing and keeps a file-level defect from
    // surfacing as a version refusal.
    assertManagedVersionAllowed(
      (() => {
        try {
          return loadManagedPiPolicy()
        } catch {
          return DEFAULT_MANAGED_PI_POLICY
        }
      })(),
      options.serverVersion,
    )

    // Before the session manager, so the delivered `env` block and the
    // fail-closed gate both settle while there is still nothing running that
    // could act under an unenforced policy. `:189`'s "blocks at startup" has to
    // mean this side of the RPC listener, not after it.
    stopManagedSettingsDelivery = await startManagedSettingsDelivery(
      platform,
      options.managedDeliveryApproval === undefined
        ? {}
        : { approval: options.managedDeliveryApproval },
    )

    const createdModelRefreshService = options.initModelRefreshService()
    modelRefreshService = createdModelRefreshService
    if (!gatewayCredentialSweepDone) {
      gatewayCredentialSweepDone = true
      await sweepOrphanedGatewayCredentialSnapshots(platform.logger)
    }
    const createdSessionManager = await options.createSessionManager(storageLayout)
    sessionManager = createdSessionManager

    const rpcHost = options.rpcHost ?? process.env.NESSY_RPC_HOST ?? '127.0.0.1'
    const rpcPortRaw = options.rpcPort ?? parseInt(process.env.NESSY_RPC_PORT ?? '9100', 10)
    if (!Number.isFinite(rpcPortRaw) || rpcPortRaw < 0 || rpcPortRaw > 65535) {
      throw new Error(`Invalid RPC port: ${rpcPortRaw}`)
    }
    const rpcPort = Math.trunc(rpcPortRaw)
    // DA3.14 — the one escape from the Host allowlist below, and the only
    // legitimate way to meet its refusal: a reverse proxy in front of a
    // loopback bind that forwards the PUBLIC name (nginx's widely copied
    // `proxy_set_header Host $host`) rather than the upstream's. Comma
    // separated, each entry an authority as the proxy will present it
    // (`agent.corp.example` or `agent.corp.example:443`). Empty entries are
    // dropped so a trailing comma cannot smuggle in the empty string, which
    // `isAllowedUpgradeHost` would otherwise never be asked about but a future
    // reader would have to reason about.
    const allowedUpgradeHosts = [...new Set([
      ...(process.env.NESSY_RPC_ALLOWED_UPGRADE_HOSTS ?? '')
        .split(',')
        .map(entry => entry.trim())
        .filter(entry => entry.length > 0),
      // DA1.73 — and the authority this deployment already handed the browser.
      // Same filtering as the env list: a caller passing an empty string must
      // not widen the allowlist by a name nobody can present.
      ...(options.extraAllowedUpgradeHosts ?? []).map(entry => entry.trim()).filter(entry => entry.length > 0),
    ])]

    const createdWsServer = (options.rpcServerFactory ?? ((serverOptions) => new WsRpcServer(serverOptions)))({
      host: rpcHost,
      port: rpcPort,
      requireAuth: true,
      // DA3.10 — constant time, not `t === serverToken`. See {@link tokensMatch}.
      validateToken: async (t) => tokensMatch(t, serverToken),
      validateSessionCookie: options.validateSessionCookie,
      serverId: options.serverId ?? 'headless',
      serverVersion: options.serverVersion,
      tls: options.tls,
      httpHandler: options.httpHandler,
      // DA3.14 — the port-keyed loopback Host allowlist, ON for a loopback bind
      // and silent everywhere else. The predicate is {@link isLoopbackBindHost},
      // the one DA3.11 left in this file: a LAN or remote bind is a deployment
      // where a browser legitimately names a public host, and this decision
      // must not be able to disagree with the TLS gate about what "loopback"
      // means. The measurement that lets it default on — what the three shipped
      // clients put in `Host` — is in the option's own docblock.
      allowLoopbackHostsOnly: isLoopbackBindHost(rpcHost),
      extraAllowedUpgradeHosts: allowedUpgradeHosts,
      onClientConnected: options.onClientConnected,
      onClientDisconnected: (clientId) => {
        options.cleanupClientResources?.(clientId)
        // Best-effort: notify SM so it can drop browser-host pins for this client.
        // Duck-typed because TSessionManager is generic at the bootstrap layer.
        const smWithDisconnect = createdSessionManager as unknown as { onClientDisconnected?: (id: string) => void }
        if (typeof smWithDisconnect.onClientDisconnected === 'function') {
          try {
            smWithDisconnect.onClientDisconnected(clientId)
          } catch {
            // Cleanup hook failures must not break the transport.
          }
        }
      },
    })
    wsServer = createdWsServer

    const createdOAuthFlowStore = new OAuthFlowStore()
    oauthFlowStore = createdOAuthFlowStore

    options.bindRpcServer?.(createdSessionManager, createdWsServer)

    const deps = options.createHandlerDeps({
      sessionManager: createdSessionManager,
      platform,
      oauthFlowStore: createdOAuthFlowStore,
      storageLayout,
    })

    const startedAt = Date.now()
    const serverHandlerContext: ServerHandlerContext = {
      getConnectedClientCount: () => createdWsServer.getConnectedClientCount(),
      serverId: options.serverId ?? 'headless',
      startedAt,
    }

    options.registerAllRpcHandlers(createdWsServer, deps, serverHandlerContext)

    options.setSessionEventSink(createdSessionManager, createdWsServer.push.bind(createdWsServer))

    await options.initializeSessionManager(createdSessionManager)

    createdModelRefreshService.startAll()

    await createdWsServer.listen()

    platform.logger.info(`Nessy Desktop server listening on ${createdWsServer.protocol}://${rpcHost}:${createdWsServer.port}`)

    // D1.231 — A SECOND CALLER MUST AWAIT THE FIRST STOP, NOT WALK PAST IT.
    //
    // This guard used to be `let stopped = false; if (stopped) return`, which
    // returns an ALREADY-RESOLVED promise to the second caller while the first
    // call is still inside the 2 000 ms notification window below. Every caller
    // in both hosts does the same thing next — `packages/server/src/index.ts`'s
    // `shutdown` is `await instance.stop(); process.exit(0)` — so the second
    // call reached `process.exit` INSIDE the first one's drain window, and
    // `cleanupCreatedResources()`, the only path to `cleanupSessionManager` and
    // therefore to the supervisor's background-shell drain, never ran.
    //
    // MEASURED 2026-09-17 (D1.231), two arms differing only in how many signals
    // were delivered, on a child carrying this exact shape:
    //
    //   one SIGTERM   shutdown → stop → drain 2 000 ms → DRAIN COMPLETE → exit 0
    //   two SIGTERMs  shutdown → stop → (2nd shutdown → stop returns) → exit 0
    //                 … and DRAIN COMPLETE never printed
    //
    // That is exactly the reading D1.211 took on the real server — the last
    // line a signalled run prints is `Shutting down...` and
    // `Cleaning up resources...` never follows — and it explains the row's
    // discriminator, signal versus no signal: at `e8204347e` a SIGNALLED CLI run
    // ran `cleanup()` twice (the signal handler's and the main path's, ~100 ms
    // apart, both reaching `proc.kill('SIGTERM')`) where an un-signalled one ran
    // it once. D1.154 has since stopped the CLI's second call, but that is the
    // CLI's accident and not this contract: a supervisor sending SIGTERM twice,
    // or SIGINT then SIGTERM, reproduces it with no CLI involved, which is why
    // the guard belongs here.
    //
    // NOTHING ON THE CANCEL PATH MOVES. `sessions:cancel` touches no supervised
    // process (verified at HEAD by D1.211), and a reap on cancel would destroy
    // work the user asked for — a `run_in_background` shell is meant to outlive
    // a turn. This only makes a stop that has started finishable.
    let stopping: Promise<void> | null = null
    const stop = async (): Promise<void> => {
      if (stopping) return stopping

      stopping = (async () => {
        platform.logger.info('Shutting down...')

        // Notify connected clients before closing connections
        try {
          createdWsServer.push('server:shuttingDown', { to: 'all' }, {
            reason: 'shutdown',
            graceMs: 2000,
            timestamp: Date.now(),
          })
          // Brief drain period so clients receive the notification
          await new Promise(resolve => setTimeout(resolve, 2000))
        } catch (error) {
          platform.logger.error('[bootstrap] Failed to send shutdown notification:', error)
        }

        await cleanupCreatedResources()
      })()

      return stopping
    }

    return {
      platform,
      sessionManager: createdSessionManager,
      wsServer: createdWsServer,
      oauthFlowStore: createdOAuthFlowStore,
      host: rpcHost,
      port: createdWsServer.port,
      protocol: createdWsServer.protocol,
      token: serverToken,
      serverHandlerContext,
      stop,
    }
  } catch (error) {
    await cleanupCreatedResources()
    throw error
  }
}

// ---------------------------------------------------------------------------
// Request-layer controls (DA3.10, DA3.11)
// ---------------------------------------------------------------------------

/**
 * DA3.11 — is this bind host one that never leaves the machine?
 *
 * ONE spelling, two readers, and they are coupled rather than merely similar:
 * `packages/server/src/index.ts` asks it to decide whether a bind may stay plain
 * `ws` without TLS, and {@link startHealthHttpServer} asks it to decide whether
 * the health probe may stay unauthenticated. A build where those two disagreed
 * would serve an open probe on an interface it had already judged public enough
 * to demand TLS for. That is why this moved here rather than being copied.
 *
 * The three values are exactly the ones `packages/server/src/index.ts` has always
 * used, so no bind changes meaning in the commit that moves it. RESIDUE, stated:
 * the bracketed IPv6 form `[::1]` is NOT in the set. It is loopback, so it will
 * take TLS it does not need and a bearer it does not need — both fail-closed —
 * and widening the set would change the TLS gate, which is not this row.
 */
export function isLoopbackBindHost(host?: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

/**
 * DA3.10 — compare a presented token with the server's in constant time.
 *
 * `bootstrapServer` used to validate the handshake with `t === serverToken`, a
 * short-circuiting string equality: it returns as soon as two bytes differ, so
 * the time it takes is a function of how many leading bytes the guess got right.
 * The channel is real and narrow — one WebSocket handshake per guess against a
 * 192-bit hex token from `generateServerToken` — and closing it costs one hash.
 *
 * BOTH SIDES ARE HASHED, which is what makes this safe to call at all:
 * `timingSafeEqual` THROWS on a length mismatch, so comparing raw tokens would
 * turn a wrong-length guess into an exception rather than a `false`, and would
 * leak the length besides. Two SHA-256 digests are always 32 bytes.
 */
export function tokensMatch(candidate: string | null | undefined, expected: string): boolean {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false
  const presented = createHash('sha256').update(candidate, 'utf8').digest()
  const known = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(presented, known)
}

/**
 * The credential out of an `Authorization: Bearer <credential>` header, or `null`.
 *
 * Deliberately minimal — RFC 7235's scheme token is case-insensitive and is
 * separated from the credential by spaces — because this is the FIRST place in
 * this server that parses such a header at all: the RPC token is a field of the
 * JSON handshake envelope, not a header (the DA3.4 audit's item 4 says so).
 */
export function bearerCredential(header: string | null | undefined): string | null {
  if (!header) return null
  const match = /^\s*Bearer\s+(\S.*?)\s*$/i.exec(header)
  return match ? match[1]! : null
}

// ---------------------------------------------------------------------------
// HTTP Health Endpoint (opt-in, for load balancers / k8s probes)
// ---------------------------------------------------------------------------

export interface HealthHttpServerOptions {
  port: number
  /**
   * DA3.11 — the interface to bind, which must be the RPC bind. Optional only so
   * an existing caller cannot silently lose its probe; omitting it keeps the old
   * every-interface bind AND then requires the bearer, because a caller that did
   * not say where it is binding has not said it is on loopback.
   */
  hostname?: string
  /** The server's bearer token — the same value the RPC handshake validates. */
  token?: string
  deps: { sessionManager: { getWorkspaces(): unknown[] } }
  wsServer: WsRpcServer
  platform: PlatformServices
}

/**
 * Start a minimal HTTP server for health/status probes.
 * Only starts if port > 0. Returns a cleanup function.
 *
 * ## DA3.11 — where this probe can be reached from, and by whom
 *
 * Until this row it called `Bun.serve` with a port and NO hostname, so the health
 * port bound every interface and `/health` was unauthenticated on all of them —
 * and its own log line said `0.0.0.0`, which is the one part that was honest. The
 * donor this server's auth posture is audited against exempts `/health` from
 * bearer auth **on loopback only** (`packages/server/src/index.ts`, the DA3.4
 * audit docblock, item 7).
 *
 * Two changes, and they are one rule: the server binds the hostname the RPC
 * server bound, and off loopback the probe is behind the same bearer the RPC
 * handshake validates — constant-time, through {@link tokensMatch}. A probe on
 * loopback is unchanged, which is the deployment shape that exists today.
 *
 * Bounded before and after: this server exists only when `NESSY_HEALTH_PORT` is
 * set, and `getHealthCheck` discloses a workspace COUNT and a heap size — no
 * names, no paths, no tokens. The change is about where it can be reached, which
 * is an operator contract, not about what it says.
 */
export async function startHealthHttpServer(
  options: HealthHttpServerOptions,
): Promise<{ stop: () => void; hostname: string; port: number } | null> {
  if (options.port <= 0) return null

  // Dynamic import — getHealthCheck uses HandlerDeps shape
  const { getHealthCheck } = await import('../handlers/rpc/server')

  const depsLike = { sessionManager: options.deps.sessionManager } as any

  // FAIL CLOSED on both unknowns: an omitted hostname is not loopback, and a
  // bearer gate with no token to compare against would let everything through.
  const requireBearer = !isLoopbackBindHost(options.hostname)
  const token = options.token ?? ''

  // Use Bun.serve if available, otherwise skip (Node.js/Electron doesn't need HTTP health)
  if (typeof globalThis.Bun !== 'undefined') {
    const server = Bun.serve({
      port: options.port,
      ...(options.hostname ? { hostname: options.hostname } : {}),
      fetch(req: Request) {
        const path = new URL(req.url).pathname
        if (path !== '/health') return new Response('Not Found', { status: 404 })
        // The 404 stays FIRST so a bind that was reachable before answers
        // unknown paths exactly as it did; the gate is about `/health` itself.
        if (requireBearer && !tokensMatch(bearerCredential(req.headers.get('authorization')), token)) {
          return new Response('Unauthorized', { status: 401 })
        }
        const health = getHealthCheck(depsLike)
        return Response.json(health, {
          status: health.status === 'ok' ? 200 : 503,
        })
      },
    })

    // The log line now names the interface it really bound, and says whether the
    // probe is open — an operator reading it can tell the two deployments apart.
    options.platform.logger.info(
      `[bootstrap] Health endpoint listening on http://${server.hostname}:${server.port}/health`
      + (requireBearer ? ' (bearer required — not a loopback bind)' : ' (loopback, no bearer)'),
    )

    return {
      stop: () => server.stop(),
      hostname: String(server.hostname),
      // Bun types `Server.port` as `number | undefined` (a unix-socket server has
      // none); this server was given a numeric port, so the requested one is the
      // honest fallback rather than a cast.
      port: server.port ?? options.port,
    }
  }

  return null
}

// F1.101 + F1.514 — the restores called in `bootstrapConfigArtifacts`; imported at the end so no
// cited line of this file moves.
import { restoreCodexLocalAutomationRequirement, restoreCodexManagedApprovalsReviewers } from '@nessy-agent/shared/config/codex-managed-requirement-cache'
