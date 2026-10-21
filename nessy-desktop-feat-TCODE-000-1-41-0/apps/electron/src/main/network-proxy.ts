/**
 * Network proxy manager — configures both Node.js (undici) and Electron session proxies.
 *
 * - Node side: replaces the global undici dispatcher with a ProtocolProxyDispatcher
 *   that routes HTTP/HTTPS through different ProxyAgent instances and respects NO_PROXY.
 * - Electron side: calls session.setProxy() on every partition listed in
 *   session-partitions.ts (default, browser pane, update feed).
 */

import { readFileSync } from 'node:fs';
import { app, session } from 'electron';
import { Agent, Dispatcher, ProxyAgent, setGlobalDispatcher } from 'undici';
import {
  buildUndiciDispatcherConfig,
  composeCaTrust,
  parseCertStoreSources,
  parseNoProxyRules,
  resolveHostProxySelection,
  runtimeGetCACertificates,
  shouldBypassProxy, setProcessFetchProxyRoute,
  splitNoProxyEntries,
  type NoProxyRule,
  type TlsClientIdentity,
} from '@nessy-agent/shared/config/network-proxy-utils';
import { isManagedOriginEnvVar } from '@nessy-agent/shared/config/managed-env';
import { getNetworkProxySettings, setNetworkProxySettings } from '@nessy-agent/shared/config/storage';
import { findRefusedProxyUrl } from '@nessy-agent/shared/config/proxy-url-validation';
import type { NetworkProxySettings } from '@nessy-agent/shared/config/types';
import { MANAGED_SESSION_PARTITIONS } from './session-partitions';
import log from './logger';
import { managedClientIdentityKey, resolveClientIdentityRuntime, resolveManagedClientIdentity, setProcessClientIdentityProvider } from '@nessy-agent/shared/config/network-mtls';
import { resolveTlsCaRuntime, setProcessCaTrustProvider } from '@nessy-agent/shared/config/network-tls-ca';

// Track the current dispatcher so we can close it when reconfiguring
let currentProxyDispatcher: Dispatcher | null = null;

/**
 * Custom undici Dispatcher that routes requests through proxy agents based on protocol,
 * bypasses proxied destinations listed in NO_PROXY rules, and falls back to a direct Agent.
 */
class ProtocolProxyDispatcher extends Dispatcher {
  private httpProxy: ProxyAgent | null;
  private httpsProxy: ProxyAgent | null;
  private direct: Agent;
  private rules: NoProxyRule[];

  constructor(opts: {
    httpProxy?: string;
    httpsProxy?: string;
    noProxy?: string;
    caSet?: string[];
    clientIdentity?: import('@nessy-agent/shared/config/network-proxy-utils').TlsClientIdentity;
  }) {
    super();
    const dispatcherConfig = buildUndiciDispatcherConfig(opts.caSet, opts.clientIdentity);
    this.httpProxy = opts.httpProxy
      ? new ProxyAgent({
        uri: opts.httpProxy,
        ...(dispatcherConfig.proxyAgentTlsOptions ?? {}),
      })
      : null;
    this.httpsProxy = opts.httpsProxy
      ? new ProxyAgent({
        uri: opts.httpsProxy,
        ...(dispatcherConfig.proxyAgentTlsOptions ?? {}),
      })
      : null;
    this.direct = dispatcherConfig.directAgentOptions
      ? new Agent(dispatcherConfig.directAgentOptions)
      : new Agent();
    this.rules = parseNoProxyRules(opts.noProxy);
  }

  dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const url = typeof opts.origin === 'string' ? opts.origin : opts.origin?.toString();

    // If URL matches bypass rules, go direct
    if (url && shouldBypassProxy(url, this.rules)) {
      return this.direct.dispatch(opts, handler);
    }

    // Route based on protocol
    const isHttps = url?.startsWith('https:');
    const proxy = isHttps ? (this.httpsProxy ?? this.httpProxy) : this.httpProxy;

    if (proxy) {
      return proxy.dispatch(opts, handler);
    }

    return this.direct.dispatch(opts, handler);
  }

  async close(): Promise<void> {
    await Promise.all([
      this.httpProxy?.close(),
      this.httpsProxy?.close(),
      this.direct.close(),
    ]);
  }

  async destroy(): Promise<void> {
    await Promise.all([
      this.httpProxy?.destroy(),
      this.httpsProxy?.destroy(),
      this.direct.destroy(),
    ]);
  }
}

/**
 * Configure the Node.js global undici dispatcher for proxy routing.
 */
function configureNodeProxy(settings: NetworkProxySettings | undefined): void {
  // Close previous dispatcher (proxy or direct — both are tracked)
  if (currentProxyDispatcher) {
    currentProxyDispatcher.close().catch(() => {});
    currentProxyDispatcher = null;
  }

  const tlsCa = resolveTlsCaRuntime(settings);
  if (tlsCa.warning) {
    log.warn('[proxy] TLS CA was not applied:', tlsCa.warning);
  }

  // Compose the trust set from the configured sources (default: the bundled
  // Mozilla set AND the OS certificate store, network-config.md:58-60) plus
  // the extra corporate/custom CA resolved above. The Electron/Chromium
  // session side needs no equivalent: Chromium always verifies against the
  // platform store natively.
  const certStore = parseCertStoreSources(settings?.certStore);
  for (const invalid of certStore.invalid) {
    log.warn(`[proxy] Ignoring unknown certStore source '${invalid}' (recognized: bundled, system)`);
  }
  // F1.498 — plus a NODE_EXTRA_CA_CERTS that reached process.env after Node's
  // own startup read (see readAmbientExtraCa below).
  const extraCa = [tlsCa.ca, readAmbientExtraCa()].filter((pem): pem is string => !!pem).join('\n') || undefined;
  const trust = composeCaTrust({
    sources: certStore.sources,
    extraCa,
    getCACertificates: runtimeGetCACertificates(),
  });
  for (const warning of trust.warnings) {
    log.warn('[proxy] CA trust composition degraded:', warning);
  }

  // mTLS client identity — resolved FRESH on every settings application, so
  // replacing the cert/key files at the same paths rotates the credential
  // without a restart (network-config.md:101). A missing or unreadable file
  // is a reported error and the identity is NOT applied — the affected hosts
  // then fail their TLS handshake visibly instead of silently authenticating
  // as nobody.
  const clientIdentity = resolveHostClientIdentity(settings); // F1.563: managed, then Settings, then the environment
  if (clientIdentity.error) {
    log.error('[proxy] mTLS client certificate was NOT applied:', clientIdentity.error);
  }

  // F1.498 — ONE dispatcher whatever Settings say, choosing its proxy per
  // request: a managed env block, then Settings, then the environment. This
  // fork used to install a plain direct Agent whenever Settings named no proxy,
  // which is how a proxy every Pi turn obeyed never reached a codex or claude
  // turn's upstream request (made HERE, by the loopback adapter). See
  // HostProxyDispatcher below.
  const dispatcher = new HostProxyDispatcher(settings, trust.ca, clientIdentity.identity);
  setGlobalDispatcher(dispatcher);
  currentProxyDispatcher = dispatcher;
}

/**
 * Configure the proxy on EVERY Electron session partition this process uses
 * (session-partitions.ts is the registry). Chromium proxy rules are per-session,
 * so a partition missing from that list egresses direct — which is how the
 * update feed came to bypass a corporate proxy the rest of the app honored.
 *
 * Requires app to be ready.
 */
export async function configureElectronProxy(settings: NetworkProxySettings | undefined): Promise<void> {
  if (!app.isReady()) return;

  const selection = resolveHostProxySelection(settings, process.env, isManagedOriginEnvVar); // F1.519 item 4
  chromiumSelectionKey = hostProxySelectionKey(selection);
  const proxyConfig = chromiumProxyConfig(selection);

  const sessions = MANAGED_SESSION_PARTITIONS.map(managed => (
    managed.partition === null
      ? session.defaultSession
      // Options apply only on creation. Passing the owner's own options keeps
      // "we configured it first" from changing the session the owner gets.
      : session.fromPartition(managed.partition, managed.options)
  ));

  await Promise.all(sessions.map(ses => ses.setProxy(proxyConfig)));
}

function buildElectronProxyConfig(settings: NetworkProxySettings): Electron.ProxyConfig {
  const rules: string[] = [];

  if (settings.httpsProxy) {
    rules.push(`https=${settings.httpsProxy}`);
  }
  if (settings.httpProxy) {
    rules.push(`http=${settings.httpProxy}`);
  }

  if (rules.length === 0) {
    return { mode: 'direct' };
  }

  return {
    mode: 'fixed_servers',
    proxyRules: rules.join(';'),
    // Pre-split accepts both documented NO_PROXY spellings (comma- and
    // whitespace-separated, network-config.md:30-33); the JOIN stays comma —
    // Chromium's bypass-rule parser is the consumer and comma is a separator
    // it accepts.
    proxyBypassRules: settings.noProxy
      ? splitNoProxyEntries(settings.noProxy).join(',')
      : undefined,
  };
}

/**
 * Read persisted proxy settings and apply to both Node and Electron.
 * Safe to call before app.whenReady() — Electron session setup is skipped until ready.
 */
export async function applyConfiguredProxySettings(): Promise<void> {
  let settings = getNetworkProxySettings();

  // The settings write path already refuses SOCKS; a hand-edited config file
  // is refused again here with a clear reported message rather than being
  // handed to undici's ProxyAgent (which would treat it as an HTTP CONNECT
  // proxy and fail confusingly). CA/mTLS settings still apply.
  const refused = findRefusedProxyUrl(settings);
  if (refused) {
    log.error(`[proxy] Proxy configuration NOT applied: ${refused.message}`);
    settings = settings
      ? { ...settings, httpProxy: undefined, httpsProxy: undefined, enabled: false }
      : settings;
  }

  const hasHttpProxy = !!settings?.httpProxy;
  const hasNoProxy = !!settings?.noProxy;
  // Booleans only: proxy URLs can carry credentials and the client key has a
  // passphrase — none of these values belong in a log line.
  log.info('[proxy] Applying proxy settings:', {
    enabled: settings?.enabled ?? false,
    hasHttpProxy,
    hasHttpsProxy: !!settings?.httpsProxy,
    hasNoProxy,
    hasClientCert: !!(settings?.clientCertPath || settings?.clientKeyPath),
  });

  configureNodeProxy(settings);
  await configureElectronProxy(settings);
}

/**
 * Persist new proxy settings and apply immediately.
 */
export async function updateConfiguredProxySettings(settings: NetworkProxySettings): Promise<void> {
  setNetworkProxySettings(settings);
  await applyConfiguredProxySettings();
}

/**
 * F1.498 — the main process's global dispatcher, resolving its proxy PER REQUEST
 * through `resolveHostProxySelection` (managed env > Settings > ambient env).
 *
 * ## Why per request, not per settings apply
 *
 * The request it exists for is the codex / claude-runtime turn's UPSTREAM hop:
 * the loopback adapter runs in this process and calls the global `fetch`
 * through `gatewaySessionFetch`, so this dispatcher is the only proxy decision
 * those turns ever meet. Two of the three places a proxy can come from are
 * written to `process.env` at times this module does not control:
 *
 * - `loadShellEnv` copies a macOS login-shell `export HTTPS_PROXY=…` in before
 *   anything runs — early enough for an apply-time read, but
 * - a managed `env` block is written by `bootstrapServer`, AFTER
 *   `applyConfiguredProxySettings` built the dispatcher, and a server-delivered
 *   one can land later still, when its confirming fetch succeeds.
 *
 * Reading the environment when a request is dispatched covers every arrival
 * order without a hook into either writer. The cost is a handful of property
 * reads per request; the dispatcher for a given proxy is built once and kept.
 *
 * ## What it deliberately does not change
 *
 * - The Settings path is byte-identical in effect: with a Settings proxy and no
 *   managed one, the same `ProtocolProxyDispatcher` is built with the same
 *   arguments, once.
 * - The CA set and the client identity are the ones `configureNodeProxy`
 *   resolved; they reach every tier alike.
 * - A proxy URL the Settings path refuses (SOCKS) is refused here too, with the
 *   same reported message, and the request goes direct — what a refused
 *   Settings proxy has always done.
 * - The Chromium half (`configureElectronProxy`) follows the SAME selection since
 *   F1.519 item 4, and `select` below re-applies it when the selection moves —
 *   see `reconcileChromiumProxy`.
 *
 * Log lines name the SOURCE and the environment NAME, never a proxy URL — a
 * proxy URL can carry credentials (this file's own rule).
 */
class HostProxyDispatcher extends Dispatcher {
  private readonly settings: NetworkProxySettings | undefined;
  private readonly caSet: string[] | undefined;
  private readonly clientIdentity: TlsClientIdentity | undefined;
  private readonly direct: Agent;
  private readonly proxied = new Map<string, ProtocolProxyDispatcher>();
  private readonly refused = new Set<string>();
  /** The managed `NODE_EXTRA_CA_CERTS` and (F1.563) client identity this was composed with. */
  private readonly composedForManagedTrust = managedTrustKey();

  constructor(
    settings: NetworkProxySettings | undefined,
    caSet: string[] | undefined,
    clientIdentity: TlsClientIdentity | undefined,
  ) {
    super();
    this.settings = settings;
    this.caSet = caSet;
    this.clientIdentity = clientIdentity;
    const dispatcherConfig = buildUndiciDispatcherConfig(caSet, clientIdentity);
    this.direct = dispatcherConfig.directAgentOptions
      ? new Agent(dispatcherConfig.directAgentOptions)
      : new Agent();
  }

  private select(): Dispatcher {
    const selection = resolveHostProxySelection(this.settings, process.env, isManagedOriginEnvVar);
    // F1.519 item 4 — a proxy that arrived after the apply (a managed env block
    // is written by `bootstrapServer`, always later) moves the Chromium half too.
    if (chromiumSelectionKey !== undefined && hostProxySelectionKey(selection) !== chromiumSelectionKey) {
      void reconcileChromiumProxy(this.settings);
    }
    if (selection.source === 'none') return this.direct;

    const key = `${selection.httpProxy ?? ''}\n${selection.httpsProxy ?? ''}\n${selection.noProxy ?? ''}`;
    const existing = this.proxied.get(key);
    if (existing) return existing;
    if (this.refused.has(key)) return this.direct;

    const origin = selection.envName ? `${selection.source} environment (${selection.envName})` : 'Settings';
    const refusal = findRefusedProxyUrl({ httpProxy: selection.httpProxy, httpsProxy: selection.httpsProxy });
    if (refusal) {
      this.refused.add(key);
      log.error(`[proxy] Proxy from the ${origin} NOT applied: ${refusal.message}`);
      return this.direct;
    }

    const dispatcher = new ProtocolProxyDispatcher({
      httpProxy: selection.httpProxy,
      httpsProxy: selection.httpsProxy,
      noProxy: selection.noProxy,
      caSet: this.caSet,
      clientIdentity: this.clientIdentity,
    });
    this.proxied.set(key, dispatcher);
    if (selection.source !== 'settings') {
      log.info(`[proxy] This process's own requests (codex and claude-runtime model turns among them) now go through the proxy from the ${origin}.`);
    }
    return dispatcher;
  }

  dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    // The CA half of the same arrival-order problem. `resolveTlsCaPathSelection`
    // already ranks a MANAGED `NODE_EXTRA_CA_CERTS` above every other CA, but the
    // set is composed when Settings are applied, which is before `bootstrapServer`
    // writes the managed block — so that tier never answered at startup, and a
    // managed proxy that now carries the hop would meet a TLS-inspecting proxy
    // whose root this process does not trust. When the managed value moves, the
    // whole chain is rebuilt through the one path that builds it, and this
    // request goes to the new dispatcher. F1.563: a managed client identity
    // (`CLAUDE_CODE_CLIENT_CERT` / `_KEY`) arrives the same way and moves the
    // same key, since `resolveHostClientIdentity` ranks it first.
    if (managedTrustKey() !== this.composedForManagedTrust && currentProxyDispatcher === this) {
      log.info('[proxy] A managed env block changed NODE_EXTRA_CA_CERTS or the client identity; re-resolving this process\'s trust chain.');
      configureNodeProxy(this.settings);
      const next = currentProxyDispatcher as Dispatcher | null;
      if (next && next !== this) return next.dispatch(opts, handler);
    }
    return this.select().dispatch(opts, handler);
  }

  /**
   * UA12.185 — the composed CA set this dispatcher verifies against, for a request that cannot go through it (the
   * MCP OAuth pinned request, `processCaTrust`). The same managed-arrival rebuild as `dispatch` above, through the
   * one path that builds the chain, so the set handed out is the one the next dispatch would use.
   */
  caTrust(): string[] | undefined {
    return this.composedNow().caSet;
  }

  /** UA12.200 — the client identity this dispatcher presents, for the same request (`processClientIdentity`). */
  clientTlsIdentity(): TlsClientIdentity | undefined {
    return this.composedNow().clientIdentity;
  }

  /**
   * UA12.201 — whether the next dispatch of `url` goes through a proxy (`processFetchUsesProxy`, the MCP OAuth
   * request): the selection and refusal `select` applies, then the `NO_PROXY` rules and per-scheme choice
   * `ProtocolProxyDispatcher.dispatch` applies.
   */
  usesProxyFor(url: string): boolean {
    const current = this.composedNow();
    if (!(current.select() instanceof ProtocolProxyDispatcher)) return false;
    const selection = resolveHostProxySelection(current.settings, process.env, isManagedOriginEnvVar);
    if (shouldBypassProxy(url, parseNoProxyRules(selection.noProxy))) return false;
    return !!(url.startsWith('https:') ? (selection.httpsProxy ?? selection.httpProxy) : selection.httpProxy);
  }

  /** UA12.185 / UA12.200 — the dispatcher the next dispatch would use: this one, or its managed-arrival rebuild. */
  private composedNow(): HostProxyDispatcher {
    if (managedTrustKey() !== this.composedForManagedTrust && currentProxyDispatcher === this) {
      log.info('[proxy] A managed env block changed NODE_EXTRA_CA_CERTS or the client identity; re-resolving this process\'s trust chain.');
      configureNodeProxy(this.settings);
      const next = currentProxyDispatcher as Dispatcher | null;
      if (next instanceof HostProxyDispatcher && next !== this) return next;
    }
    return this;
  }

  async close(): Promise<void> {
    await Promise.all([this.direct.close(), ...[...this.proxied.values()].map(d => d.close())]);
  }

  async destroy(): Promise<void> {
    await Promise.all([this.direct.destroy(), ...[...this.proxied.values()].map(d => d.destroy())]);
  }
}

/**
 * F1.498 — the managed `NODE_EXTRA_CA_CERTS`, or '' when the variable is absent
 * or did not come from a managed `env` block. The same condition
 * `resolveTlsCaPathSelection`'s managed tier tests, read per request.
 */
function managedCaKey(): string {
  return isManagedOriginEnvVar('NODE_EXTRA_CA_CERTS') ? (process.env.NODE_EXTRA_CA_CERTS ?? '') : '';
}

/**
 * F1.563 — everything a managed `env` block contributes to the composed chain,
 * as one comparable key: the managed CA above and the managed client identity's
 * paths (`managedClientIdentityKey`). The headless twin is `network-runtime.ts`'s
 * `managedTrustKey`.
 */
function managedTrustKey(): string {
  return `${managedCaKey()}\n${managedClientIdentityKey()}`;
}

/**
 * F1.498 — the extra CA a `NODE_EXTRA_CA_CERTS` in `process.env` names NOW,
 * when it is not the managed tier's (that one is `resolveTlsCaRuntime`'s).
 *
 * Node reads the variable once, at startup, and `composeCaTrust` keeps what it
 * read (`getCACertificates('extra')`). On a packaged macOS build the variable
 * usually arrives LATER: `loadShellEnv` copies the login shell's exports into
 * `process.env` at the top of `main/index.ts`, after Node's read. Measured
 * (WJ-ai, 2026-09-24): with the shell's `HTTPS_PROXY` honoured by the host hop
 * and its CA not, a codex / claude turn through a TLS-inspecting proxy failed
 * its handshake — while every Pi turn, whose child reads both at its own
 * startup, completed. Reading the file here gives the host what the child gets.
 *
 * It AUGMENTS, as Node's own reading does; it selects nothing. A duplicate of a
 * startup-read certificate is harmless in a CA list.
 */
function readAmbientExtraCa(): string | undefined {
  const path = process.env.NODE_EXTRA_CA_CERTS?.trim();
  if (!path || isManagedOriginEnvVar('NODE_EXTRA_CA_CERTS')) return undefined;
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    log.warn('[proxy] NODE_EXTRA_CA_CERTS from the environment was not applied:', error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/**
 * F1.519 item 4 (P-WJai-4, DECIDED 2026-09-24 under the TRANSPARENT and SIMPLE
 * rule) — the Chromium half (every partition `session-partitions.ts` lists: the
 * default session the sign-in windows use, the browser pane, the update feed)
 * takes the host hop's selection: a managed `env` block's proxy, then Settings,
 * then the environment (`resolveHostProxySelection`). It followed Settings only
 * and was forced `direct` with Settings off, so a proxy-only network that names
 * its proxy in the environment reached every model turn and no update download.
 * A proxy the host hop refuses (SOCKS) sends Chromium direct too, as the hop
 * does. With nothing selected the partitions stay `direct` — this fork's
 * baseline, kept.
 *
 * Chromium's rules are per-session state, not per request, so the half is
 * re-applied at every Settings apply and by {@link reconcileChromiumProxy}
 * whenever the host hop sees the selection move. Log lines name the source and
 * the environment NAME, never a proxy URL.
 */
let chromiumSelectionKey: string | undefined;

function hostProxySelectionKey(selection: ReturnType<typeof resolveHostProxySelection>): string {
  if (selection.source === 'none') return 'none';
  return [selection.source, selection.httpProxy ?? '', selection.httpsProxy ?? '', selection.noProxy ?? ''].join('\n');
}

function chromiumProxyConfig(selection: ReturnType<typeof resolveHostProxySelection>): Electron.ProxyConfig {
  if (selection.source === 'none') return { mode: 'direct' };
  const origin = selection.envName ? `${selection.source} environment (${selection.envName})` : 'Settings';
  const refusal = findRefusedProxyUrl({ httpProxy: selection.httpProxy, httpsProxy: selection.httpsProxy });
  if (refusal) {
    log.error(`[proxy] Proxy from the ${origin} NOT applied to the browser pane, update feed and sign-in windows: ${refusal.message}`);
    return { mode: 'direct' };
  }
  if (selection.source !== 'settings') {
    log.info(`[proxy] The browser pane, update feed and sign-in windows go through the proxy from the ${origin}.`);
  }
  return buildElectronProxyConfig({
    enabled: true,
    httpProxy: selection.httpProxy,
    httpsProxy: selection.httpsProxy,
    noProxy: selection.noProxy,
  });
}

/** F1.519 item 4 — re-apply the Chromium half when the host hop's selection is no longer the one it was given. */
export async function reconcileChromiumProxy(settings: NetworkProxySettings | undefined): Promise<void> {
  const key = hostProxySelectionKey(resolveHostProxySelection(settings, process.env, isManagedOriginEnvVar));
  if (key === chromiumSelectionKey) return;
  try {
    await configureElectronProxy(settings);
  } catch (error) {
    log.warn('[proxy] Re-applying the proxy to the browser pane, update feed and sign-in windows failed:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * F1.519 item 3 (P-WJai-3, DECIDED 2026-09-24 with the headless half in the
 * interceptor's `composedRequestTls`) — the client identity this host hop
 * presents: the stored Settings one when Settings name one (the product
 * channel), else the one the ENVIRONMENT names — `CLAUDE_CODE_CLIENT_CERT` /
 * `_KEY` / `_KEY_PASSPHRASE`, the spellings the parent projects to every child
 * (`proxy-env.ts`) and the claude binary reads natively. Before, the environment
 * reached every Pi turn, the claude child and the HEADLESS host hop, and not
 * this one — a macOS login-shell export `loadShellEnv` copied in included. Read
 * at every apply, like the stored one, so rotation needs no restart.
 *
 * F1.563 (P-WJax-1, DECIDED by the controller 2026-09-24) — a MANAGED `env`
 * block that names the identity is the TOP tier, above Settings, as the managed
 * proxy and CA are (F1.498): `resolveManagedClientIdentity` (`network-mtls.ts`),
 * the one rule the headless hop and the child projection read too. The block is
 * written after startup, so `HostProxyDispatcher` re-applies when
 * `managedTrustKey` moves. A half-named or unreadable managed identity is a
 * reported error and presents nothing; it does not fall back to Settings.
 */
function resolveHostClientIdentity(settings: NetworkProxySettings | undefined): ReturnType<typeof resolveClientIdentityRuntime> {
  const managed = resolveManagedClientIdentity();
  if (managed) return managed;
  if (settings?.clientCertPath || settings?.clientKeyPath) return resolveClientIdentityRuntime(settings);
  const certPath = process.env.CLAUDE_CODE_CLIENT_CERT?.trim() || undefined;
  const keyPath = process.env.CLAUDE_CODE_CLIENT_KEY?.trim() || undefined;
  if (!certPath && !keyPath) return {};
  const resolved = resolveClientIdentityRuntime({
    enabled: false,
    clientCertPath: certPath,
    clientKeyPath: keyPath,
    clientKeyPassphrase: process.env.CLAUDE_CODE_CLIENT_KEY_PASSPHRASE || undefined,
  });
  return resolved.error
    ? { error: `${resolved.error} (read from CLAUDE_CODE_CLIENT_CERT / CLAUDE_CODE_CLIENT_KEY in the environment)` }
    : resolved;
}

/**
 * UA12.185 — this process's composed CA trust, for the requests the global dispatcher cannot reach (the MCP OAuth
 * pinned request, `node:https` to an already-validated address). It is the set `configureNodeProxy` composed — the
 * bundled Mozilla set and the OS store as `certStore` says, plus the managed / Custom CA setting / bundled
 * corporate CA file — never a second store. Before the first apply there is no dispatcher, and the request keeps
 * the runtime's default trust.
 */
setProcessCaTrustProvider(() => (
  currentProxyDispatcher instanceof HostProxyDispatcher ? currentProxyDispatcher.caTrust() : undefined
));

/**
 * UA12.200 — the client identity `configureNodeProxy` resolved (`resolveHostClientIdentity`: managed, then Settings,
 * then the environment), for the same pinned request; every dispatched request already presents it. Before the
 * first apply there is no dispatcher, and the request presents none.
 */
setProcessClientIdentityProvider(() => (
  currentProxyDispatcher instanceof HostProxyDispatcher ? currentProxyDispatcher.clientTlsIdentity() : undefined
));

/**
 * UA12.201 — the proxy decision the global dispatcher makes for a URL, for the MCP OAuth request: when it says
 * "proxied", that request goes through `fetch` (and so through this dispatcher) by host name instead of pinning a
 * direct connection. Before the first apply there is no dispatcher and `fetch` goes direct, so the answer is no.
 */
setProcessFetchProxyRoute(url => (
  currentProxyDispatcher instanceof HostProxyDispatcher ? currentProxyDispatcher.usesProxyFor(url) : false
));
