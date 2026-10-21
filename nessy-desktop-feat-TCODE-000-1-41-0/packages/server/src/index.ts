#!/usr/bin/env bun
/**
 * @nessy-agent/server — standalone headless Nessy Desktop server.
 *
 * Usage:
 *   NESSY_SERVER_TOKEN=<secret> bun run packages/server/src/index.ts
 *
 * Environment:
 *   NESSY_SERVER_TOKEN         — required bearer token for client auth
 *   NESSY_RPC_HOST             — bind address (default: 127.0.0.1)
 *   NESSY_RPC_PORT             — bind port (default: 9100)
 *   NESSY_RPC_TLS_CERT         — path to PEM certificate file (enables TLS/wss)
 *   NESSY_RPC_TLS_KEY          — path to PEM private key file (required with cert)
 *   NESSY_RPC_TLS_CA           — path to PEM CA chain file (optional)
 *   NESSY_APP_ROOT             — app root path (default: cwd)
 *   NESSY_RESOURCES_PATH       — resources path (default: cwd/resources)
 *   NESSY_IS_PACKAGED          — 'true' for production (default: false)
 *   NESSY_VERSION              — app version (default: 0.0.0-dev)
 *   NESSY_DEBUG                — 'true' for debug logging
 *   NESSY_WEBUI_DIR            — path to built web UI assets (enables web UI on RPC port)
 *   NESSY_WEBUI_PASSWORD       — optional shorter password for web login (falls back to NESSY_SERVER_TOKEN)
 *   NESSY_WEBUI_SECURE_COOKIE  — optional true/false override for the session cookie Secure flag
 *   NESSY_WEBUI_WS_URL         — optional browser-facing ws:// or wss:// URL returned by /api/config
 *   NESSY_HEALTH_PORT          — optional HTTP health port; see the health item in the audit below
 *
 * ## AUTH POSTURE — audited item by item, 2026-09-17 (DA3.4)
 *
 * The donor CLI publishes a fail-closed checklist for its own daemon
 * (`nessy-cli` `docs/developers/daemon/12-auth-security.md`). It is EVIDENCE,
 * not authority: that daemon is HTTP/Express with an OPTIONAL token whose
 * middleware is a no-op when none is configured, while this one is a WebSocket
 * JSON-RPC server whose token is MANDATORY. Three of its items therefore have
 * no counterpart here, and saying so is part of the verdict. Every reading below
 * was taken at `080b545cb`; a count names its instrument, and each absence
 * carries a positive control taken on the same rig.
 *
 * 1. REFUSE TO BOOT ON A NON-LOOPBACK BIND WITH NO BEARER TOKEN — SATISFIED,
 *    and more strictly than the donor. `@nessy-agent/server-core`
 *    `bootstrap/headless-start.ts` symbol `bootstrapServer` throws
 *    "Server token is required" before anything binds, on EVERY bind including
 *    loopback, and `validateTokenEntropy` additionally refuses a token under 16
 *    characters or built from one repeated character. There is no
 *    no-token developer mode to fall into.
 * 2. REFUSE A REQUIRE-AUTH FLAG WITH NO TOKEN — NOT APPLICABLE. No such flag
 *    exists: over `packages/server` + `packages/server-core` the literal
 *    `require-auth` scores 0 occurrences (`git grep -aoI | wc -l`, 2026-09-17)
 *    against 11 for the internal option name `requireAuth`, which is the
 *    positive control and which `bootstrapServer` hard-codes to `true`.
 * 3. REFUSE A WILDCARD ALLOWED-ORIGIN WITH NO TOKEN — NOT APPLICABLE. There is
 *    no allow-origin surface to misconfigure: `allow-origin` and `allowOrigin`
 *    both score 0 occurrences over the same two packages, where
 *    `allow-insecure-bind` scores 5 as the control.
 * 4. CONSTANT-TIME BEARER COMPARE WITH HAND-ROLLED SCHEME PARSING — SATISFIED
 *    since DA3.10 (2026-09-17). It was ABSENT when this list was written:
 *    `headless-start.ts` compared with a short-circuiting string equality, whose
 *    timing is a function of how many leading bytes a guess got right. It now
 *    validates through `headless-start.ts` symbol `tokensMatch`, which hashes
 *    BOTH sides with SHA-256 and compares the digests with `timingSafeEqual` —
 *    hashing both is what keeps a wrong-LENGTH guess a `false` rather than a
 *    throw, and keeps the length out of the channel. There is still no scheme to
 *    parse on this path: the RPC token is a field of the JSON handshake envelope,
 *    not an `Authorization` header. The one header this server does parse is the
 *    health probe's, added by DA3.11 (`bearerCredential`).
 * 5. PORT-KEYED LOOPBACK HOST ALLOWLIST AGAINST DNS REBINDING — ABSENT. The
 *    `Host` header is read 0 times in `transport/server.ts` and once in
 *    `webui/http-server.ts`, and that one read is the
 *    `x-forwarded-host ?? host` pair that INFERS the Secure-cookie flag, not an
 *    allowlist. Positive control on the same two files and the same probe
 *    (`grep -aoi | wc -l`, 2026-09-17): `cookie` scores 1 and 3.
 * 6. DENY BROWSER ORIGINS BY DEFAULT — ABSENT AS A CONTROL, and the exposure it
 *    would cover is closed by two other mechanisms. `origin` scores 0 reads in
 *    both files above, under the same positive control. What stops a page on an
 *    attacker origin: the handshake needs the bearer token INSIDE the first
 *    message, which such a page cannot read; and the cookie alternative is
 *    issued `HttpOnly; SameSite=Strict` (`webui/auth.ts`), so a cross-site
 *    upgrade carries no cookie either. The control is missing; the door is not
 *    open.
 *
 *    **"Adding an Origin deny is cheap" is REFUTED, measured 2026-09-17 (DA3.10).**
 *    A blanket *"reject any upgrade carrying an Origin header"* would refuse this
 *    product's own browser clients, because it is the same `WsRpcServer` class in
 *    every deployment. Two of them: the desktop's preload client
 *    (`apps/electron/src/preload/bootstrap.ts` → `transport/client.ts` symbol
 *    `createWebSocket`, which falls through to the GLOBAL `WebSocket` constructor
 *    for every `ws://` url — in a preload that is Chromium's, and a browser
 *    always sends `Origin`); and the webui, which THIS FILE mounts on the same
 *    server through `httpHandler` whenever `NESSY_WEBUI_DIR` is set, and which is
 *    a browser page by construction. The positive half of the measurement, on the
 *    two clients that are NOT browsers: over a real `Bun.serve` upgrade,
 *    `origin` is absent for both Bun's global `WebSocket` (what `apps/cli` uses)
 *    and the `ws` package, while `host`, `upgrade` and the three
 *    `sec-websocket-*` headers are present — so the probe can see headers and the
 *    absence is the clients'. An Origin deny therefore needs a SCOPE (which bind)
 *    or an allowlist (which origins), which is a sub-decision, not a cheap fix.
 *    Left unbuilt with this reading rather than shipped and reverted.
 * 7. A HEALTH ROUTE EXEMPT ON LOOPBACK ONLY — SATISFIED since DA3.11
 *    (2026-09-17). It was ABSENT and INVERTED when this list was written:
 *    `startHealthHttpServer` called `Bun.serve` with a port and no hostname, so
 *    the health port bound every interface and `/health` was unauthenticated on
 *    all of them, its own log line printing the `0.0.0.0` form. It now binds the
 *    hostname the RPC server bound and, when that bind is not loopback, puts
 *    `/health` behind the same bearer through the item-4 comparison. The two
 *    things that bounded the exposure are unchanged and still worth knowing: the
 *    server exists only when `NESSY_HEALTH_PORT` is set, and `getHealthCheck`
 *    discloses a workspace COUNT and a heap size — no names, no paths, no tokens.
 * 8. A DISTINCT TOKEN-REQUIRED CODE RATHER THAN A GENERIC 401 — PARTIAL.
 *    `transport/server.ts` sends `AUTH_FAILED` with the reason "Token required"
 *    or "Invalid token": the SENTENCE distinguishes the two, the CODE does not.
 *    Read the donor before copying, because it does the opposite on purpose —
 *    its bearer failures are deliberately UNIFORM so probing cannot tell them
 *    apart, and the distinct code lives on a per-route mutation gate we have no
 *    equivalent of.
 * 9. THE DONOR'S OWN DECLARED WEAKNESS — NOT IMPORTED, and its twin is covered.
 *    Their client identifier is format-validated with no proof-of-possession,
 *    so an observer can re-register it and impersonate that originator. Our
 *    nearest shape is the reconnect path, which matches `workspaceId` and
 *    `webContentsId`, both client-supplied — but it is reached only AFTER the
 *    bearer check in the same handler, so an unauthenticated caller never gets
 *    there.
 * 10. ONE CONTROL OF OURS THAT THEIR CHECKLIST DOES NOT LIST: this server
 *    refuses a non-loopback bind without TLS, generates a self-signed
 *    certificate rather than dead-ending, prints its fingerprint for the human
 *    to compare, and takes `--allow-insecure-bind` as the explicit override.
 *
 * ## The dp device flow — a READING, not a build (DA3.4b)
 *
 * An RFC 8628 device flow for DP Auth EXISTS in the donor: `nessy-cli`
 * `packages/core/src/qwen/qwenOAuth2.ts` declares the device-code and token
 * endpoint PATHS, a client id, a scope and the device-code grant type. ONE
 * CORRECTION to the row that asked for this probe: at nessy-cli `9d94ec5d4` the
 * base URL those paths hang off is REDACTED to a placeholder, so the host
 * cannot be read out of that checkout and a build would have to get it
 * elsewhere. Ours is absent, and `@nessy-agent/shared` `auth/dp/session-broker.ts`
 * symbol `startRun` raises the interactive-login-unavailable error when
 * non-interactive, so the env token is the only headless route today. A device
 * flow SHOWS a code rather than opening a browser, so it does not conflict with
 * Target scheme clause 2 — but it is a product posture and needs an owner
 * answer. Nothing here is authorised to build it.
 */

import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { version as packageVersion } from '../package.json'
import { enableDebug } from '@nessy-agent/shared/utils/debug'
import { i18n, setupI18n } from '@nessy-agent/shared/i18n'
import { getPersistedUiLanguage, loadStoredConfig } from '@nessy-agent/shared/config'
import { ensureBundledSkills } from '@nessy-agent/shared/skills'
import { ensureDefaultPermissions } from '@nessy-agent/shared/agent'
import {
  bootstrapServer,
  createStorageRuntime,
  generateServerToken,
  HeadlessStorageReadinessError,
  isLoopbackBindHost,
  startHealthHttpServer,
  type StorageRuntime,
} from '@nessy-agent/server-core/bootstrap'
import { validateSession, createWebuiHandler, nodeHttpAdapter } from '@nessy-agent/server-core/webui'
import type { WebuiHandler } from '@nessy-agent/server-core/webui'
import { getCredentialManager } from '@nessy-agent/shared/credentials'
import {
  applyProcessNetworkTrustChain,
  watchNetworkTrustChain,
} from '@nessy-agent/shared/config/network-runtime'
import { dpSessionBroker } from '@nessy-agent/shared/auth/dp'
import { advertisedHost, ensureSelfSignedCertificate } from '@nessy-agent/server-core/transport'
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
import { buildPairingURL } from '@nessy-agent/shared/pairing/pairing-url'

/**
 * Loopback binds stay plain `ws`: nothing leaves the machine.
 *
 * DA3.11 moved the three values into `@nessy-agent/server-core/bootstrap` symbol
 * `isLoopbackBindHost` and left this alias, because the health probe now asks the
 * SAME question to decide whether it may stay unauthenticated. Two copies could
 * have answered differently, and the build where they did would serve an open
 * probe on an interface it had already judged public enough to demand TLS for.
 */
const isLoopbackHost = isLoopbackBindHost
import { resolvePluginNodeRuntime, resolveWindowsSandboxRuntime } from '@nessy-agent/shared/agent/backend'

// --generate-token: print a crypto-random token and exit
if (process.argv.includes('--generate-token')) {
  console.log(generateServerToken())
  process.exit(0)
}
import type { WsRpcTlsOptions } from '@nessy-agent/server-core/transport'
import { registerCoreRpcHandlers, cleanupSessionFileWatchForClient } from '@nessy-agent/server-core/handlers/rpc'
import { SessionManager, setSessionPlatform, setSessionRuntimeHooks } from '@nessy-agent/server-core/sessions'
import { initModelRefreshService, setFetcherPlatform } from '@nessy-agent/server-core/model-fetchers'
import { setSearchPlatform, setImageProcessor } from '@nessy-agent/server-core/services'
import type { HandlerDeps } from '@nessy-agent/server-core/handlers'

process.env.NESSY_IS_PACKAGED ??= 'false'

// Prevent unhandled rejections from crashing the server.
// SDK subprocess abort can reject promises that propagate up unhandled;
// Bun (unlike Node) terminates the process on unhandled rejections by default.
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  console.error(`[server] Unhandled rejection (caught, not crashing): ${msg}`)
})

if (process.env.NESSY_DEBUG === 'true' || process.env.NESSY_DEBUG === '1') {
  enableDebug()
}

// P2.196 — the headless server renders localized strings too, through the SAME
// i18next singleton the desktop uses, and it never initialized it.
//
// MEASURED 2026-08-26 (`p2184-i18n-probe.ts`): an i18next instance nobody
// initialized returns `undefined` from `t()` — NOT the key. So the failure does
// not degrade to a visible identifier a reader would notice and report; it
// renders EMPTY, or worse, interpolates as the literal word "undefined". What
// was actually shipping: `auth:showLogoutConfirmation` sent the client a dialog
// whose title, message, detail and BOTH buttons were empty strings, the six
// `/advisor` status lines yielded an `info` event with no message, and Pi's
// Guardian marker appended "— undefined" to a permission prompt's reason.
//
// Initialization belongs HERE, at the entry, not in each caller: P2.130 had to
// self-initialize inside `base-agent.ts` to keep one budget notice from
// rendering blank, and that fix is right for one string and wrong as a pattern
// — every other localized string on this path stayed empty.
//
// Idempotent (`setupI18n` has its own `initialized` guard) and synchronous
// (`initImmediate: false`), so it cannot race or override a language chosen
// later. `fallbackLng: 'en'` means the worst case is English, never blank.
setupI18n()

// Apply the configured proxy / CA / mTLS to this process's OWN outbound calls
// before anything makes one. Subprocesses already get the trust chain through
// the env projection at their spawn sites; the server's own requests — model
// fetchers, credential refresh, source calls — were running direct, so a
// headless deployment behind a TLS-inspecting proxy failed where the desktop
// app worked. Re-applied on config.json changes: the headless server has no
// settings RPC (settings:setNetworkProxy is LOCAL_ONLY), so editing the file is
// how an operator rotates a proxy or an mTLS credential.
applyProcessNetworkTrustChain()
const networkTrustWatcher = watchNetworkTrustChain()

function parseOptionalBooleanEnv(name: string, value: string | undefined): boolean | undefined {
  if (value == null || value.trim() === '') return undefined

  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false

  console.error(`Invalid ${name}: expected one of true/false/1/0/yes/no/on/off.`)
  process.exit(1)
}

function parseOptionalWebSocketUrl(name: string, value: string | undefined): string | undefined {
  if (value == null || value.trim() === '') return undefined

  try {
    const url = new URL(value)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      throw new Error('must use ws:// or wss://')
    }
    return value
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Invalid ${name}: ${message}`)
    process.exit(1)
  }
}

// In dev (monorepo), bundled assets root is the repo root (4 levels up from this file).
// In packaged mode, use NESSY_BUNDLED_ASSETS_ROOT env or cwd.
const bundledAssetsRoot = process.env.NESSY_BUNDLED_ASSETS_ROOT
  ?? join(import.meta.dir, '..', '..', '..', '..')

// TLS configuration — when cert + key paths are provided, server listens on wss://
let tls: WsRpcTlsOptions | undefined
/** Printed after listen so the user can compare it with what the phone shows. */
let selfSignedFingerprint: string | undefined
const tlsCertPath = process.env.NESSY_RPC_TLS_CERT
const tlsKeyPath = process.env.NESSY_RPC_TLS_KEY
if (tlsCertPath || tlsKeyPath) {
  if (!tlsCertPath || !tlsKeyPath) {
    console.error('TLS requires both NESSY_RPC_TLS_CERT and NESSY_RPC_TLS_KEY.')
    process.exit(1)
  }
  tls = {
    cert: readFileSync(tlsCertPath),
    key: readFileSync(tlsKeyPath),
    ...(process.env.NESSY_RPC_TLS_CA ? { ca: readFileSync(process.env.NESSY_RPC_TLS_CA) } : {}),
  }
} else if (
  !isLoopbackHost(process.env.NESSY_RPC_HOST ?? '127.0.0.1') &&
  // `--allow-insecure-bind` is an explicit request for plaintext on the
  // network. Auto-generating a certificate anyway would make the flag
  // unreachable — found by trying to use it.
  !process.argv.includes('--allow-insecure-bind')
) {
  // F1: a network bind without TLS is refused further down, and telling the
  // user to go find a certificate turns that refusal into a dead end. Generate
  // a self-signed one and make the human the trust anchor: the fingerprint is
  // printed here and shown again on the phone at first pairing.
  //
  // Loopback deliberately stays plain `ws` — nothing leaves the machine, and
  // requiring a certificate there would break every local tool we ship.
  try {
    const generated = ensureSelfSignedCertificate(CONFIG_DIR)
    tls = { cert: generated.cert, key: generated.key }
    selfSignedFingerprint = generated.fingerprint
  } catch (error) {
    console.error(
      '\n❌  Could not generate a TLS certificate for the network bind.\n' +
      `   ${error instanceof Error ? error.message : String(error)}\n` +
      '   Install openssl, or set NESSY_RPC_TLS_CERT / NESSY_RPC_TLS_KEY yourself.\n'
    )
    process.exit(1)
  }
}

// Web UI configuration
const webuiDir = process.env.NESSY_WEBUI_DIR || undefined
const webuiEnabled = webuiDir && existsSync(webuiDir)
const webuiSecureCookies = parseOptionalBooleanEnv('NESSY_WEBUI_SECURE_COOKIE', process.env.NESSY_WEBUI_SECURE_COOKIE)
const webuiWsUrl = parseOptionalWebSocketUrl('NESSY_WEBUI_WS_URL', process.env.NESSY_WEBUI_WS_URL)
const serverToken = process.env.NESSY_SERVER_TOKEN

// ---------------------------------------------------------------------------
// Create WebUI handler early so it can be embedded in the WsRpcServer.
// The handler is a pure function — it doesn't need the session manager yet
// because health checks are injected lazily via getHealthCheck().
// ---------------------------------------------------------------------------

let webuiHandler: WebuiHandler | null = null
let webuiNodeHandler: ReturnType<typeof nodeHttpAdapter> | undefined
/**
 * DA1.73 — the authorities the webui itself publishes, seeded into DA3.14's
 * Host allowlist. Empty unless this deployment set `NESSY_WEBUI_WS_URL`, which
 * is the only way the browser is handed a name other than the page's own.
 */
const webuiUpgradeAuthorities: string[] = []

// Health check is injected lazily — the session manager isn't ready until
// after bootstrap completes, but the handler captures the closure.
let healthCheckFn: (() => { status: string }) | null = null

if (webuiEnabled && serverToken) {
  const rpcPort = parseInt(process.env.NESSY_RPC_PORT ?? '9100', 10)
  const rpcProtocol = tls ? 'wss' as const : 'ws' as const

  webuiHandler = createWebuiHandler({
    webuiDir: webuiDir!,
    secret: serverToken,
    password: process.env.NESSY_WEBUI_PASSWORD || undefined,
    secureCookies: webuiSecureCookies,
    publicWsUrl: webuiWsUrl,
    wsProtocol: rpcProtocol,
    // WebUI is served on the same port as WS — wsPort matches the RPC port
    wsPort: rpcPort,
    getHealthCheck: () => healthCheckFn?.() ?? { status: 'starting' },
    logger: { info: console.log, warn: console.warn, error: console.error } as any,
  })

  webuiNodeHandler = nodeHttpAdapter(webuiHandler.fetch)
  // DA1.73 — the authority this process is about to HAND the browser, declared
  // to the transport that will be asked to accept it.
  //
  // `webui/http-server.ts`'s `resolveWebSocketUrl` answers `/api/config` with
  // `publicWsUrl` when it is set, so behind a reverse proxy on a loopback bind
  // the browser is told to connect to a public name BY THIS PROCESS and is then
  // refused by DA3.14's Host allowlist when it presents it — whether the refusal
  // happens at all depends on the proxy's own config (nginx's `$proxy_host`
  // default passes; the widely copied `proxy_set_header Host $host` does not).
  // An operator who declared the public authority once should not have to
  // declare it a second time in `NESSY_RPC_ALLOWED_UPGRADE_HOSTS`, a variable
  // they have to know exists.
  //
  // The AUTHORITY, not the URL: `URL.host` carries the port when the operator
  // wrote one and omits it when they did not, which is exactly the shape
  // `isAllowedUpgradeHost` compares against. Parsed rather than pattern-matched,
  // and `parseOptionalWebSocketUrl` has already `exit(1)`ed on anything that is
  // not a `ws:`/`wss:` URL, so this cannot throw here.
  if (webuiWsUrl) webuiUpgradeAuthorities.push(new URL(webuiWsUrl).host)
}

/**
 * P3.206 — seed the bundled host assets a HEADLESS deployment was never given.
 *
 * Six seeders run in `apps/electron/src/main/index.ts`'s ready handler
 * (`initializeDocs`, `ensureToolIcons`, `ensurePresetThemes`,
 * `initializeReleaseNotes`, `ensureDefaultPermissions`, `ensureBundledSkills`).
 * Measured 2026-09-03, `nessy-server` reached only the first two, and by
 * accident rather than design: `ensureConfigDir()` calls `initializeDocs()` and
 * `ensureToolIcons()` itself, so they ride into both hosts through
 * `bootstrapConfigArtifacts`. The other four had exactly one production call
 * site each, and it was the desktop shell's.
 *
 * Two of those four are wired here, and each is here for a reason that survives
 * the scope filter:
 *
 * - `ensureBundledSkills` (P3.206): a headless deployment shipped **zero**
 *   bundled skills, on every runtime — not a stale copy, none. The receipt
 *   P2.281 added is what makes the absence legible (a headless profile has no
 *   `.bundled-skill-seed.json`).
 * - `ensureDefaultPermissions`: `permissions/default.json` was never written, so
 *   `PermissionsConfigCache.getDefaultConfig()` resolved `null` and the global
 *   layer never merged. **Measured rather than assumed, and the alarming
 *   reading is wrong:** the file's 19 `deniedPaths` are byte-identical to the
 *   in-code floor in `agent/mode-types.ts`, so the credential floor was never at
 *   risk. What a headless run actually lost is the file's 202
 *   `allowedBashPatterns`, 15 `allowedMcpPatterns` and 7 `blockedCommandHints` —
 *   so an Explore-mode command auto-allowed on the desktop asked for permission
 *   headless, and the escape hints a refusal renders were absent.
 *
 * The other two are deliberately NOT here: `ensurePresetThemes` self-heals (it
 * is called from its own readers in `config/storage.ts`), and
 * `initializeReleaseNotes` is a display surface with no bearing on a tool call —
 * recorded in the out-of-scope register instead.
 *
 * WHY THIS SITE. `applyPlatformToSubsystems` is invoked by `bootstrapServer`
 * immediately after its own `setBundledAssetsRoot(...)` and before
 * `bootstrapConfigArtifacts` / `createSessionManager`, which is the same
 * ordering the desktop states at its own call site: *"Runs before
 * createStorageRuntime (below) so seeded skills are in the managed skills root
 * before the first capability inventory."* Putting the calls inside
 * `bootstrapServer` instead would have been the smaller diff and the wrong one —
 * the desktop goes through `bootstrapServer` too, so both would then run twice.
 *
 * Where the bundle does not resolve (`getBundledAssetsDir` finds no
 * `resources/<kind>`, which is the ordinary case for a dev checkout run from the
 * repo root) each seeder is a documented no-op, exactly as `initializeDocs`
 * already is on that path.
 */
function seedBundledHostAssets(): void {
  // `settings-reference.md#disablebundledskills` — with the switch on nothing is
  // seeded; the check lives inside `ensureBundledSkills` so every entry point is
  // covered.
  ensureBundledSkills({ storedConfig: loadStoredConfig() })
  ensureDefaultPermissions()
}

const instance = await (async () => {
  try {
    let runtime!: StorageRuntime
    let pluginNodeRuntime: ReturnType<typeof resolvePluginNodeRuntime>
    let windowsSandboxRuntime: ReturnType<typeof resolveWindowsSandboxRuntime>
    return await bootstrapServer<SessionManager, HandlerDeps>({
      bundledAssetsRoot,
      serverVersion: process.env.NESSY_VERSION ?? packageVersion,
      tls,
      // When web UI is enabled, accept JWT session cookies on WebSocket upgrade
      validateSessionCookie: webuiEnabled && serverToken
        ? async (cookieHeader) => {
            const session = await validateSession(cookieHeader, serverToken)
            return session !== null
          }
        : undefined,
      // Embed the WebUI HTTP handler on the WS server's port
      httpHandler: webuiNodeHandler,
      // DA1.73 — see `webuiUpgradeAuthorities`: the public name this process
      // hands the browser is accepted by the transport that receives it.
      extraAllowedUpgradeHosts: webuiUpgradeAuthorities,
      applyPlatformToSubsystems: (platform) => {
        pluginNodeRuntime = resolvePluginNodeRuntime({
          appRootPath: platform.appRootPath,
          resourcesPath: platform.resourcesPath,
          isPackaged: platform.isPackaged,
        })
        windowsSandboxRuntime = resolveWindowsSandboxRuntime({
          appRootPath: platform.appRootPath,
          resourcesPath: platform.resourcesPath,
          isPackaged: platform.isPackaged,
        })
        setFetcherPlatform(platform)
        setSessionPlatform(platform)
        setSessionRuntimeHooks({
          updateBadgeCount: () => {},
          captureException: (error) => {
            const err = error instanceof Error ? error : new Error(String(error))
            platform.captureError?.(err)
          },
        })
        setSearchPlatform(platform)
        setImageProcessor(platform.imageProcessor)
        seedBundledHostAssets()
      },
      initModelRefreshService: () => initModelRefreshService(async (slug: string) => {
        const manager = getCredentialManager()
        const [apiKey, oauth] = await Promise.all([
          manager.getLlmApiKey(slug).catch(() => null),
          manager.getLlmOAuth(slug).catch(() => null),
        ])
        return {
          apiKey: apiKey ?? undefined,
          oauthAccessToken: oauth?.accessToken,
          oauthRefreshToken: oauth?.refreshToken,
          oauthIdToken: oauth?.idToken,
        }
      }),
      createSessionManager: async (layout) => {
        runtime = await createStorageRuntime(layout, { dpSessionBroker })
        return new SessionManager(runtime.sessionStore, {
          resolver: runtime.capabilityResolver,
          workspaceService: runtime.workspaceService,
          projectHandleService: runtime.projectHandleService,
          recentProjectStore: runtime.recentProjectStore,
          workspaceQuiescence: runtime.workspaceQuiescence,
          resolveCredential: runtime.resolveRuntimeCredential,
          dpSessionBroker: runtime.dpSessionBroker,
          managedPiPolicy: runtime.managedPiPolicy,
          // D4: the boot snapshot is the seed, not the last word.
          resolveManagedPiPolicy: runtime.resolveManagedPiPolicy,
          subscribeManagedPolicyChange: runtime.subscribeManagedPolicyChange,
          piTelemetry: runtime.piTelemetry,
          usageMetrics: runtime.usageMetrics,
          pluginNodeRuntime,
          windowsSandboxRuntime,
          subscribeInvalidation: runtime.onCapabilityInvalidation,
          pluginManagementTools: {
            pluginManagement: runtime.pluginManagement,
            marketplaceService: runtime.marketplaceService,
            marketplaceProposalRegistry: runtime.marketplaceProposalRegistry,
            // R88b: cached-only catalog read, so `plugin_manage: update` fetches
            // the newer version instead of re-installing the installed one.
            marketplaceCatalogReader: runtime.marketplaceRegistrySource,
          },
        })
      },
      bindRpcServer: (sm, server) => sm.setRpcServer(server),
      createHandlerDeps: ({ sessionManager, platform, oauthFlowStore }) => ({
        sessionManager,
        platform,
        oauthFlowStore,
        workspaceService: runtime.workspaceService,
        pluginManagement: runtime.pluginManagement,
        pluginStore: runtime.pluginStore,
        capabilityPolicyStore: runtime.capabilityPolicyStore,
        // R88b: without this the headless RPC Update refuses with
        // `no-catalog-row` even against a warm catalog, while the agent's own
        // `plugin_manage` update — wired just above — resolves correctly. The
        // electron host passes it in BOTH places; headless passed it in only
        // one, so the two headless surfaces disagreed about the same plugin.
        marketplaceRegistrySource: runtime.marketplaceRegistrySource,
        capabilityTrustStore: runtime.capabilityTrustStore,
        isolationCapabilities: runtime.isolationCapabilities,
      }),
      registerAllRpcHandlers: registerCoreRpcHandlers,
      setSessionEventSink: (sessionManager, sink) => sessionManager.setEventSink(sink),
      initializeSessionManager: async (sessionManager) => {
        await sessionManager.initialize()
      },
      cleanupSessionManager: async (sessionManager) => {
        try {
          await sessionManager.flushAllSessions()
        } finally {
          await sessionManager.cleanup()
          runtime.dispose()
        }
      },
      cleanupClientResources: cleanupSessionFileWatchForClient,
    })
  } catch (error) {
    if (error instanceof HeadlessStorageReadinessError) {
      console.error(`[storage-readiness] code=${error.code}${error.diagnosticPath ? ` diagnostic=${error.diagnosticPath}` : ''}`)
    } else {
      console.error(error instanceof Error ? error.message : String(error))
    }
    process.exit(1)
  }
})()

// The language the desktop persisted, applied the way `electron/src/main/index.ts`
// applies it — and AFTER bootstrap for its stated reason: `preferences.json` is
// user-owned config and may be read only once storage readiness has passed. A
// headless deployment and the desktop share one config directory, so a user who
// picked Russian in Appearance gets Russian from both. No preference means the
// `fallbackLng: 'en'` chosen above stands.
const persistedUiLanguage = getPersistedUiLanguage()
if (persistedUiLanguage) await i18n.changeLanguage(persistedUiLanguage)

// Wire up the lazy health check now that the session manager is ready
if (webuiHandler) {
  const { getHealthCheck } = await import('@nessy-agent/server-core/handlers/rpc/server')
  const depsLike = { sessionManager: instance.sessionManager } as any
  healthCheckFn = () => getHealthCheck(depsLike)

  // Wire up OAuth callback deps so /api/oauth/callback works
  const { getSourceCredentialManager } = await import('@nessy-agent/shared/sources')
  const { emitCapabilityCatalogInvalidation } = await import('@nessy-agent/shared/capabilities/invalidation')
  const { pushTyped } = await import('@nessy-agent/server-core/transport')
  const { RPC_CHANNELS } = await import('@nessy-agent/shared/protocol')

  webuiHandler.setOAuthCallbackDeps({
    flowStore: instance.oauthFlowStore,
    credManager: getSourceCredentialManager(),
    sessionManager: instance.sessionManager,
    pushSourcesChanged: (workspaceId: string) => {
      emitCapabilityCatalogInvalidation({
        scope: { kind: 'workspace', workspaceId },
        reason: 'source-credential-ready',
        effect: 'refresh-before-next-turn',
      })
      pushTyped(
        instance.wsServer,
        RPC_CHANNELS.capabilities.CHANGED,
        { to: 'workspace', workspaceId },
        {
          workspaceId,
          generation: '',
          reasonCode: 'source-credential-ready',
          effect: 'refresh-before-next-turn',
        },
      )
    },
  })
}

// Start HTTP health endpoint if NESSY_HEALTH_PORT is set
const healthPort = parseInt(process.env.NESSY_HEALTH_PORT ?? '0', 10)
const healthServer = await startHealthHttpServer({
  port: healthPort,
  // DA3.11 — the probe binds where the RPC server bound, and off loopback it is
  // behind the same bearer. Item 7 of the audit above was the reading that this
  // closes; the item's own text is corrected there.
  hostname: instance.host,
  token: instance.token,
  deps: { sessionManager: instance.sessionManager },
  wsServer: instance.wsServer,
  platform: instance.platform,
})

const serverProto = instance.protocol === 'wss' ? 'https' : 'http'
console.log(`NESSY_SERVER_URL=${instance.protocol}://${instance.host}:${instance.port}`)
console.log(`NESSY_SERVER_TOKEN=${instance.token}`)
if (selfSignedFingerprint) {
  console.log(
    '\n🔒  This server uses a self-signed certificate.\n' +
    `   Fingerprint (SHA-256): ${selfSignedFingerprint}\n` +
    '   The phone shows this same value when you pair. Confirm they match —\n' +
    '   that comparison is what makes the connection trustworthy.\n'
  )
}
// F5: everything the phone needs, in one string. The desktop's Server settings
// render this same payload as a QR; here it is a link the user can send to
// their own device. It carries the fingerprint, so scanning replaces the manual
// comparison above rather than adding to it.
if (!isLoopbackHost(instance.host)) {
  console.log(
    'NESSY_PAIRING_URL=' +
    buildPairingURL({
      url: `${instance.protocol}://${advertisedHost(instance.host)}:${instance.port}`,
      token: instance.token,
      ...(selfSignedFingerprint ? { fingerprint: selfSignedFingerprint } : {}),
    })
  )
}
if (webuiHandler) {
  console.log(`NESSY_WEBUI_URL=${serverProto}://0.0.0.0:${instance.port}`)
}

// Block binding to a non-localhost address without TLS — tokens would be sent in cleartext.
// Override with --allow-insecure-bind for explicitly trusted networks.
const isLocalBind = isLoopbackHost(instance.host)
if (!isLocalBind && instance.protocol === 'ws') {
  if (process.argv.includes('--allow-insecure-bind')) {
    console.warn(
      '\n⚠️  WARNING: Server is listening on a network address without TLS.\n' +
      '   Authentication tokens will be sent in cleartext.\n' +
      '   Set NESSY_RPC_TLS_CERT and NESSY_RPC_TLS_KEY to enable wss://.\n'
    )
  } else {
    console.error(
      '\n❌  Refusing to bind to a network address without TLS.\n' +
      '   Authentication tokens would be sent in cleartext.\n\n' +
      '   Options:\n' +
      '     1. Set NESSY_RPC_TLS_CERT and NESSY_RPC_TLS_KEY to enable wss://\n' +
      '     2. Pass --allow-insecure-bind to override (NOT recommended for production)\n'
    )
    await instance.stop()
    dpSessionBroker.dispose()
    process.exit(1)
  }
}

const shutdown = async () => {
  networkTrustWatcher.dispose()
  webuiHandler?.dispose()
  healthServer?.stop()
  await instance.stop()
  dpSessionBroker.dispose()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
