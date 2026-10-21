/**
 * The configured trust chain applied to THIS process's own outbound requests.
 *
 * The Electron main process gets this from `network-proxy.ts`, which installs a
 * global undici dispatcher. That mechanism does not transfer: the headless
 * `nessy-server` binary runs on Bun (`bin/nessy-server` execs
 * `vendor/bun/bun run packages/server/src/index.ts`), and Bun's native `fetch`
 * ignores undici's `setGlobalDispatcher` entirely — a dispatcher installed
 * there receives zero dispatches, and Bun's `undici` shim has no
 * `Agent.close()`, so re-applying would throw. Installing one in the server
 * would be a placebo.
 *
 * What Bun does honour, and what this module uses:
 *
 * - per-request `proxy` and `tls` fetch options (Bun-specific; Node ignores
 *   unknown init keys, so the wrapper is inert rather than harmful there);
 * - `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` — from the LAUNCH environment
 *   only (F1.498, measured on 1.3.14: a value assigned later is never read).
 *
 * Both mechanisms exempt LOOPBACK, and they had to be fixed separately (P2.263):
 * `shouldBypassProxy` governs the wrapper, and the environment projection
 * governs everything that re-reads the variables instead of calling it. Fixing
 * only one leaves the other sending this app's own `http://localhost:<port>`
 * requests to the operator's proxy.
 *
 * `NODE_EXTRA_CA_CERTS` is deliberately NOT projected: Bun reads it once at
 * process start, before any JavaScript runs, so setting it from inside the
 * process has no effect (measured). The extra CA reaches requests through the
 * `tls.ca` option instead.
 *
 * SECURITY: a proxy URL can carry credentials, and the client key has a
 * passphrase. Nothing here logs a proxy URL, a file path from the client
 * identity, or the passphrase — only booleans.
 */
import { watch, type FSWatcher } from 'node:fs';
import { CONFIG_DIR } from './paths.ts';
import { getNetworkProxySettings } from './storage.ts';
import { findRefusedProxyUrl } from './proxy-url-validation.ts';
import { managedClientIdentityKey, resolveClientIdentityRuntime, resolveManagedClientIdentity, setProcessClientIdentityProvider, type ClientIdentity } from './network-mtls.ts';
import { resolveTlsCaRuntime, setProcessCaTrustProvider } from './network-tls-ca.ts';
import {
  LOOPBACK_NO_PROXY_HOSTS,
  composeCaTrust,
  parseCertStoreSources,
  parseNoProxyRules, resolveHostProxySelection, splitNoProxyEntries,
  runtimeGetCACertificates,
  shouldBypassProxy, setProcessFetchProxyRoute, type NoProxyRule, type TlsClientIdentity,
} from './network-proxy-utils.ts';
import { isManagedOriginEnvVar } from './managed-env.ts';
import { extendNoProxyWithLoopback } from './proxy-env.ts';
import type { NetworkProxySettings } from './types.ts';

export type NetworkTrustLogger = {
  info: (message: string, detail?: unknown) => void;
  warn: (message: string, detail?: unknown) => void;
  error: (message: string, detail?: unknown) => void;
};

const consoleLogger: NetworkTrustLogger = {
  info: (message, detail) => (detail === undefined ? console.log(message) : console.log(message, detail)),
  warn: (message, detail) => (detail === undefined ? console.warn(message) : console.warn(message, detail)),
  error: (message, detail) => (detail === undefined ? console.error(message) : console.error(message, detail)),
};

/** Bun's per-request TLS options. `ca` is the COMPLETE composed trust set. */
type FetchTlsOptions = {
  ca?: string[];
  cert?: string;
  key?: string;
  passphrase?: string;
};

type ResolvedTrust = {
  httpProxy?: string;
  httpsProxy?: string;
  noProxyRules: NoProxyRule[];
  tls?: FetchTlsOptions;
};

/** What the wrapper reads. Re-applying swaps this, so rotation needs no re-wrap. */
let currentTrust: ResolvedTrust = { noProxyRules: [] };
let wrapperInstalled = false;

/**
 * Proxy env keys THIS module set, mapped to whatever the launch environment
 * had there. A later disable restores the operator's value rather than
 * deleting it.
 */
let projectedEnv = new Map<string, string | undefined>();

export type AppliedNetworkTrust = {
  proxy: boolean;
  customCa: boolean;
  clientIdentity: boolean;
};

/**
 * Resolve the configured trust chain and apply it to this process's `fetch`.
 *
 * Idempotent and safe to call repeatedly: the fetch wrapper is installed once,
 * and every call re-resolves the CA and the client identity FROM DISK, so
 * replacing the cert/key files at the same paths rotates the credential the way
 * the Electron path does.
 */
export function applyProcessNetworkTrustChain(options: {
  settings?: NetworkProxySettings;
  log?: NetworkTrustLogger;
} = {}): AppliedNetworkTrust {
  const log = noteLaunchLoopbackProxyOnce(options.log ?? consoleLogger);
  let settings = 'settings' in options ? options.settings : getNetworkProxySettings();

  // A hand-edited config can still name a SOCKS proxy the write path refuses.
  // Report it and drop the proxy rather than silently mis-routing; CA and mTLS
  // still apply. Mirrors applyConfiguredProxySettings in the Electron main.
  const refused = findRefusedProxyUrl(settings);
  if (refused) {
    log.error(`[proxy] Proxy configuration NOT applied: ${refused.message}`);
    settings = settings
      ? { ...settings, httpProxy: undefined, httpsProxy: undefined, enabled: false }
      : settings;
  }

  const tlsCa = resolveTlsCaRuntime(settings);
  if (tlsCa.warning) {
    log.warn(`[proxy] TLS CA was not applied: ${tlsCa.warning}`);
  }

  // Compose an explicit trust set ONLY when the operator asked for something
  // other than the runtime default. Handing Bun the full platform store on
  // every request when nothing is configured would be cost without effect.
  const certStore = parseCertStoreSources(settings?.certStore);
  for (const invalid of certStore.invalid) {
    log.warn(`[proxy] Ignoring unknown certStore source '${invalid}' (recognized: bundled, system)`);
  }
  let ca: string[] | undefined;
  if (tlsCa.ca || settings?.certStore) {
    const trust = composeCaTrust({
      sources: certStore.sources,
      extraCa: tlsCa.ca,
      getCACertificates: runtimeGetCACertificates(),
    });
    for (const warning of trust.warnings) {
      log.warn(`[proxy] CA trust composition degraded: ${warning}`);
    }
    ca = trust.ca;
  }

  // Re-read on every application: a missing or unreadable file is REPORTED and
  // no identity is applied, so the affected hosts fail their handshake visibly
  // instead of silently authenticating as nobody.
  const identity = resolveManagedClientIdentity() ?? resolveClientIdentityRuntime(settings); // F1.563: managed first
  if (identity.error) {
    log.error(`[proxy] mTLS client certificate was NOT applied: ${identity.error}`);
  }

  const proxyEnabled = !!settings?.enabled && !!(settings.httpProxy || settings.httpsProxy);
  const tls = buildTlsOptions(ca, identity.identity);
  currentTrust = {
    ...(proxyEnabled ? { httpProxy: settings!.httpProxy, httpsProxy: settings!.httpsProxy } : {}),
    noProxyRules: proxyEnabled ? parseNoProxyRules(settings!.noProxy) : [],
    ...(tls ? { tls } : {}),
  };

  projectProxyEnv(proxyEnabled ? settings : undefined);
  installFetchTrustChain();
  // F1.498 — what the wrapper re-applies with if a managed CA arrives later.
  lastApplied = { settings, log };
  composedManagedTrustKey = managedTrustKey();

  const applied: AppliedNetworkTrust = {
    proxy: proxyEnabled,
    customCa: !!ca,
    clientIdentity: !!identity.identity,
  };
  // Booleans only — see the SECURITY note at the top of this file.
  log.info('[proxy] Applying trust chain to this process:', applied);
  if (proxyEnabled) {
    // The exemption is a DEFAULT this process applies on the operator's behalf,
    // so it is said out loud rather than left to be discovered (P2.263). Host
    // names only, never a proxy URL.
    log.info(
      `[proxy] Loopback (${LOOPBACK_NO_PROXY_HOSTS.join(', ')}) bypasses the proxy for this `
      + 'process and for every subprocess it spawns; all other destinations still go through it.',
    );
  }
  return applied;
}

function buildTlsOptions(
  ca: string[] | undefined,
  identity: TlsClientIdentity | undefined,
): FetchTlsOptions | undefined {
  if (!ca && !identity) return undefined;
  return {
    ...(ca ? { ca } : {}),
    ...(identity
      ? {
        cert: identity.cert,
        key: identity.key,
        ...(identity.passphrase ? { passphrase: identity.passphrase } : {}),
      }
      : {}),
  };
}

/**
 * Mirror the proxy into this process's environment, for the CHILDREN that
 * spread it. Not for this process: Bun 1.3.14's `fetch` reads these names at
 * launch only (F1.498, measured introducing AND overwriting one), so a caller
 * that bypasses the wrapper below goes without the projected proxy.
 *
 * Only the keys THIS function set are touched on a later disable, and each is
 * restored to whatever the launch environment had — an operator-provided proxy
 * must survive the stored settings being turned off.
 */
function projectProxyEnv(settings: NetworkProxySettings | undefined): void {
  for (const [key, original] of projectedEnv) {
    // DELETE FIRST, ALWAYS — including on the restore path. See the P2.261 note
    // on `assign` below: re-assigning a proxy variable is what makes it
    // invisible, and restoring an operator's value is an assignment like any
    // other.
    delete process.env[key];
    if (original !== undefined) process.env[key] = original;
  }
  projectedEnv = new Map();
  if (!settings) return;

  /**
   * DELETE BEFORE ASSIGN, and it is not a tidiness habit — P2.261, MEASURED on
   * Bun 1.3.14 in this repo, premises corrected by P2.498:
   *
   * | what                                       | property read | `Object.keys` | `{...process.env}` |
   * | ------------------------------------------ | ------------- | ------------- | ------------------ |
   * | `env.HTTPS_PROXY = …`, UNSET at launch     | the value     | **absent**    | **absent**         |
   * | the same, INHERITED at launch              | the value     | present       | present            |
   * | an ARBITRARY variable, same shape          | the value     | present       | present            |
   * | `delete` first, then assign                | the value     | present       | present            |
   *
   * TWO conditions, and BOTH are needed — the second is why this reads as
   * machine-dependent, and why a reader who tests by OVERWRITING an inherited
   * proxy concludes there is no bug:
   *
   *  - The name is one Bun pre-creates a slot for, and that is NOT "the proxy
   *    names". `ALL_PROXY`/`all_proxy` are proxy names and are NOT in the set,
   *    while `NODE_TLS_REJECT_UNAUTHORIZED` (not a proxy at all), `TZ` and
   *    `BUN_CONFIG_VERBOSE_FETCH` are. AGENTS.md carries the one-line command
   *    that ENUMERATES the set in a fresh process, so no count is repeated here.
   *  - The name is ABSENT from the launch environment. INTRODUCING a proxy is
   *    the invisible case; overwriting an operator's was always visible. Which
   *    is exactly why the `delete` on the restore path above is load-bearing in
   *    the other direction: once this function has assigned over an inherited
   *    value, putting it back is another assignment into the same slot.
   *
   * A RUNTIME assignment lands in that pre-existing slot, which enumeration does
   * not see. Every subprocess env in this repo is
   * built by spreading `process.env` (`buildPiSubprocessEnv`,
   * `buildClaudeSubprocessEnv`, `CodexRuntimeManager.spawn`), so without the
   * delete this projection reaches Bun's own `fetch` — which reads by property —
   * and NOTHING ELSE. The failure direction is a pass: the variable is there
   * when you look for it and gone when a child needs it.
   */
  const assign = (keys: string[], value: string | undefined) => {
    if (!value) return;
    for (const key of keys) {
      projectedEnv.set(key, process.env[key]);
      delete process.env[key];
      process.env[key] = value;
    }
  };
  assign(['HTTP_PROXY', 'http_proxy'], settings.httpProxy);
  assign(['HTTPS_PROXY', 'https_proxy'], settings.httpsProxy);
  // Canonical comma-joined form, mirroring `proxy-env.ts`: whatever re-reads
  // this env (a child inheriting process.env; this process's own fetch goes
  // through the wrapper, F1.1155) may be a third-party comma-only parser, while
  // the stored setting accepts both documented spellings (network-config.md:30-33).
  //
  // ALWAYS WRITTEN while a proxy is projected, and EXTENDED rather than
  // replaced (P2.263). Two separate defects lived in the one line this
  // replaced:
  //
  //  - with no `noProxy` configured it wrote nothing: every child got the bare
  //    proxy, and so did the host's own local-model list fetch
  //    (`http://localhost:<port>/v1/models`), by TWO paths — `shouldBypassProxy`'s
  //    empty-rules branch (the wrapper, Electron's dispatcher) AND this env, then a
  //    PLAIN assignment Bun's fetch reads; since P2.261's delete only children do (F1.1155).
  //  - with a `noProxy` configured it REPLACED whatever the launch environment
  //    had, so an operator's `no_proxy=internal.corp` vanished for as long as
  //    the in-app proxy stayed on.
  //
  // The loopback hosts come from the same list every child is handed, so the
  // host and its subprocesses bypass exactly the same set.
  assign(
    ['NO_PROXY', 'no_proxy'],
    extendNoProxyWithLoopback([process.env.NO_PROXY, process.env.no_proxy, settings.noProxy]),
  );
}

/**
 * The proxy for one request URL, or undefined to go direct.
 *
 * F1.498 — resolved PER REQUEST through `resolveHostProxySelection`: a managed
 * `env` block's proxy, then the stored Settings one (`currentTrust`, unchanged),
 * then the environment. Measured (WJ-ai, 2026-09-24): a proxy a managed `env`
 * block wrote after startup reached every Pi turn (a child inheriting it) and
 * NO codex or claude-runtime turn, whose upstream request this process makes —
 * Bun 1.3.14's `fetch` does not re-read a proxy name assigned at runtime, and
 * the interceptor's copy was frozen at preload. The Electron main resolves
 * through the same function (`HostProxyDispatcher`), so the two hosts agree.
 * An environment proxy the Settings path would refuse (SOCKS) is refused here
 * too, once, with the same message.
 */
function proxyForUrl(url: string): string | undefined {
  const { httpProxy, httpsProxy, noProxyRules } = currentTrust;
  const selection = resolveHostProxySelection({ enabled: true, httpProxy, httpsProxy }, process.env, isManagedOriginEnvVar);
  if (selection.source === 'none') return undefined;
  const rules = selection.source === 'settings' ? noProxyRules : environmentNoProxyRules(selection.noProxy);
  if (shouldBypassProxy(url, rules)) return undefined;
  const proxy = url.startsWith('https:') ? (selection.httpsProxy ?? selection.httpProxy) : selection.httpProxy;
  if (!proxy || selection.source === 'settings') return proxy;
  const refusal = findRefusedProxyUrl({ httpProxy: proxy });
  if (!refusal) return proxy;
  if (!refusedEnvironmentProxies.has(proxy)) {
    refusedEnvironmentProxies.add(proxy);
    // The environment NAME, never the value — a proxy URL can carry credentials.
    console.error(`[proxy] Proxy from the ${selection.source} environment (${selection.envName}) NOT applied: ${refusal.message}`);
  }
  return undefined;
}

/** Parsed once per distinct environment `NO_PROXY` value, not per request. */
let environmentNoProxy: { raw: string | undefined; rules: NoProxyRule[] } = { raw: undefined, rules: [] };
function environmentNoProxyRules(raw: string | undefined): NoProxyRule[] {
  if (environmentNoProxy.raw !== raw) environmentNoProxy = { raw, rules: parseNoProxyRules(raw) };
  return environmentNoProxy.rules;
}
const refusedEnvironmentProxies = new Set<string>();

/** The last `applyProcessNetworkTrustChain` input, and the managed trust it composed with. */
let lastApplied: { settings: NetworkProxySettings | undefined; log: NetworkTrustLogger } | undefined;
let composedManagedTrustKey = '';

/**
 * What a managed `env` block contributes to the composed chain, as one
 * comparable key: the managed `NODE_EXTRA_CA_CERTS` ('' when absent or not from
 * a managed block — the condition `resolveTlsCaPathSelection`'s managed tier
 * tests) and, since F1.563, the managed client identity's paths
 * (`managedClientIdentityKey`). The block is written by `bootstrapServer` AFTER
 * the chain is composed, so the wrapper re-composes when this key moves. The
 * Electron main carries the same key (`network-proxy.ts`).
 */
function managedTrustKey(): string {
  const ca = isManagedOriginEnvVar('NODE_EXTRA_CA_CERTS') ? (process.env.NODE_EXTRA_CA_CERTS ?? '') : '';
  return `${ca}\n${managedClientIdentityKey()}`;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Wrap `globalThis.fetch` once so every request carries the configured proxy
 * and TLS material. A caller that passes its own `proxy`/`tls` wins — this
 * fills in a default, it does not override an explicit decision.
 */
function installFetchTrustChain(): void {
  if (wrapperInstalled) return;
  wrapperInstalled = true;
  setProcessCaTrustProvider(composedProcessCaTrust); // UA12.185
  setProcessClientIdentityProvider(composedProcessClientIdentity); // UA12.200
  setProcessFetchProxyRoute(url => !!proxyForUrl(url)); // UA12.201: the wrapper's own decision

  const inner = globalThis.fetch;
  const wrapped = async (
    input: string | URL | Request,
    init?: RequestInit & { proxy?: string; tls?: FetchTlsOptions },
  ): Promise<Response> => {
    const url = requestUrl(input);
    // F1.498 — `resolveTlsCaPathSelection` ranks a MANAGED `NODE_EXTRA_CA_CERTS`
    // first, but the chain is composed before `bootstrapServer` writes the
    // managed block, so that tier never answered here. When the managed value
    // moves, the chain is re-composed through the one path that composes it.
    // F1.563: a managed client identity is the same tier and moves the same key.
    if (lastApplied && managedTrustKey() !== composedManagedTrustKey) applyProcessNetworkTrustChain(lastApplied);
    const proxy = init?.proxy ?? proxyForUrl(url);
    const tls = init?.tls ?? (url.startsWith('https:') ? currentTrust.tls : undefined);
    if (!proxy && !tls) return inner(input as Parameters<typeof fetch>[0], init);
    return inner(input as Parameters<typeof fetch>[0], {
      ...init,
      ...(proxy ? { proxy } : {}),
      ...(tls ? { tls } : {}),
    } as RequestInit);
  };

  // Preserve static properties (Bun exposes fetch.preconnect).
  globalThis.fetch = new Proxy(wrapped, {
    apply: (target, thisArg, args) => Reflect.apply(target, thisArg, args),
    get: (target, prop, receiver) => (
      prop in inner
        ? (inner as unknown as Record<string | symbol, unknown>)[prop]
        : Reflect.get(target, prop, receiver)
    ),
  }) as unknown as typeof fetch;
}

/**
 * Re-apply the trust chain whenever the stored settings change.
 *
 * The headless server has no settings RPC — `settings:setNetworkProxy` is a
 * LOCAL_ONLY channel handled by the Electron main — so an operator changes the
 * proxy, the CA or the mTLS paths by editing `config.json`. Watching it gives
 * the headless server the same re-apply the Electron path gets from its own
 * write path, which is also what makes credential rotation take effect without
 * a restart.
 */
export function watchNetworkTrustChain(options: {
  log?: NetworkTrustLogger;
  /** Test seam: the directory holding config.json. Defaults to CONFIG_DIR. */
  configDir?: string;
  /** Coalesce the burst of events an atomic rewrite produces. */
  debounceMs?: number;
} = {}): { dispose: () => void } {
  const log = options.log ?? consoleLogger;
  const configDir = options.configDir ?? CONFIG_DIR;
  const debounceMs = options.debounceMs ?? 150;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher;
  try {
    // The DIRECTORY, not the file: saveConfig writes through a temp file and a
    // rename, and a watch bound to the old inode goes deaf after the first
    // change. This is why the shared ConfigWatcher watches directories too.
    //
    // And no filename filter: on macOS that atomic rewrite surfaces as a single
    // `rename:config.json.tmp` event, so filtering on `config.json` would miss
    // the very change we exist to catch. Re-applying is idempotent and cheap —
    // a JSON read plus two small PEM reads — so a neighbouring file's write
    // costing one extra pass is the right trade.
    watcher = watch(configDir, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        try {
          applyProcessNetworkTrustChain({ log });
        } catch (error) {
          log.error(`[proxy] Re-applying the trust chain failed: ${errorText(error)}`);
        }
      }, debounceMs);
    });
  } catch (error) {
    // A missing config dir is normal on a fresh install; the startup apply
    // already ran with defaults and a later write is picked up on restart.
    log.warn(`[proxy] Not watching network settings for changes: ${errorText(error)}`);
    return { dispose: () => {} };
  }

  return {
    dispose: () => {
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Test-only: forget the installed wrapper so a suite can re-install it. */
export function __resetProcessNetworkTrustChainForTest(): void {
  currentTrust = { noProxyRules: [] };
  wrapperInstalled = false;
  lastApplied = undefined;
  composedManagedTrustKey = '';
  launchLoopbackNoticeChecked = false;
  projectProxyEnv(undefined);
}

/**
 * F1.525 (origin WJ-ao P-WJao-1, DECIDED 2026-09-24 under the TRANSPARENT and
 * SIMPLE rule) — the half of F1.518 this process cannot fix for itself.
 *
 * Bun 1.3.14 reads `HTTP(S)_PROXY` / `NO_PROXY` at LAUNCH only and has no
 * per-request way to go direct, so a server started with a proxy and without
 * the loopback hosts in `NO_PROXY` sends its OWN loopback requests (a local
 * model, a loopback BYO endpoint) to that proxy; the wrapper above cannot help,
 * because leaving `proxy` unset hands the request to that same launch-time
 * reader. `bin/nessy-server` — and so the Docker and systemd starts — exports
 * the hosts before its `exec` (`launcherLoopbackNoProxyFragment`, F1.518). The
 * in-repo `bun run packages/server/src/index.ts` (`server:start`, `server:dev`)
 * has no launcher, and is NOT given one: that means a self-re-exec with signal
 * forwarding, or a shell wrapper in every root script that starts the server.
 * The server SAYS so instead, once, at the first application — while
 * `process.env` is still the launch environment Bun read: the proxy variable
 * NAMES (never a value — a proxy URL can carry credentials), the loopback hosts
 * `NO_PROXY` lacks, and the two remedies. A `*` entry exempts every host.
 */
export function launchLoopbackProxyNotice(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const names = LAUNCH_PROXY_ENV_NAMES.filter(name => !!env[name]?.trim());
  if (names.length === 0) return undefined;
  const entries = new Set(splitNoProxyEntries([env.NO_PROXY, env.no_proxy].filter(Boolean).join(',')).map(entry => entry.toLowerCase()));
  if (entries.has('*')) return undefined;
  const missing = LOOPBACK_NO_PROXY_HOSTS.filter(host => !entries.has(host));
  if (missing.length === 0) return undefined;
  return `[proxy] This server was launched with ${names.join(', ')} set and its NO_PROXY lacks ${missing.join(', ')}, `
    + 'so its own requests to this machine (a local model, a loopback endpoint) go through that proxy: Bun reads '
    + 'these names only at launch. Start it through bin/nessy-server, which adds them, or export '
    + `NO_PROXY=${LOOPBACK_NO_PROXY_HOSTS.join(',')} (with your own entries) before launching.`;
}

const LAUNCH_PROXY_ENV_NAMES = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy'] as const;
let launchLoopbackNoticeChecked = false;

/** F1.525 — {@link launchLoopbackProxyNotice} over `process.env`, at the FIRST application only; returns `log`. */
function noteLaunchLoopbackProxyOnce(log: NetworkTrustLogger): NetworkTrustLogger {
  if (launchLoopbackNoticeChecked) return log;
  launchLoopbackNoticeChecked = true;
  const notice = launchLoopbackProxyNotice(process.env);
  if (notice) log.warn(notice);
  return log;
}

/**
 * UA12.185 — the CA set the wrapper above hands every `https:` request (`currentTrust.tls.ca`), for the requests
 * that cannot go through `fetch` (the MCP OAuth pinned request, `node:https` to an already-validated address).
 * The same managed-arrival re-composition as the wrapper, through the one path that composes. `undefined` when
 * nothing beyond the runtime default was configured — the wrapper passes no `ca` then either.
 */
function composedProcessCaTrust(): string[] | undefined {
  if (lastApplied && managedTrustKey() !== composedManagedTrustKey) applyProcessNetworkTrustChain(lastApplied);
  return currentTrust.tls?.ca;
}

/**
 * UA12.200 — the client identity the wrapper above hands every `https:` request (`currentTrust.tls`), for the same
 * requests `composedProcessCaTrust` serves (the MCP OAuth pinned request), through the same managed-arrival
 * re-composition. `undefined` when no identity was applied (none configured, or a reported misconfiguration).
 */
function composedProcessClientIdentity(): ClientIdentity | undefined {
  if (lastApplied && managedTrustKey() !== composedManagedTrustKey) applyProcessNetworkTrustChain(lastApplied);
  const tls = currentTrust.tls;
  if (!tls?.cert || !tls.key) return undefined;
  return { cert: tls.cert, key: tls.key, ...(tls.passphrase ? { passphrase: tls.passphrase } : {}) };
}
