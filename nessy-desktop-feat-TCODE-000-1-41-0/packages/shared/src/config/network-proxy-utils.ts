/**
 * Network proxy utility functions (pure — no Electron deps).
 *
 * Parses NO_PROXY rules and determines whether a given URL should bypass the proxy.
 */

import * as tls from 'node:tls';
import { rootCertificates } from 'node:tls';

/**
 * Split a comma-separated string into trimmed, non-empty entries.
 *
 * Comma ONLY — do not widen. This is shared with `parseCertStoreSources`,
 * whose documented separator (network-config.md `certStore`) is comma alone;
 * NO_PROXY values go through `splitNoProxyEntries` instead.
 */
export function splitCommaSeparated(str: string | undefined): string[] {
  if (!str) return [];
  return str.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Split a NO_PROXY value into trimmed, non-empty entries.
 *
 * network-config.md:30-33 documents TWO accepted spellings side by side —
 * `"localhost 192.168.1.1 example.com .example.com"` (space-separated) and
 * `"localhost,192.168.1.1,example.com,.example.com"` (comma-separated) — so
 * whitespace is an entry separator exactly as a comma is. The inline parser in
 * `unified-network-interceptor.ts` (preload bundle, cannot import this module)
 * is the twin of this split: change one, change both.
 */
export function splitNoProxyEntries(str: string | undefined): string[] {
  if (!str) return [];
  return str.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
}

// ============================================================================
// CA trust-store composition (network-config.md:56-76)
// ============================================================================

/**
 * A CA source in the documented sense: `bundled` is the Mozilla CA set shipped
 * with the runtime, `system` is the operating system trust store. The
 * documented default is both (`bundled,system`).
 */
export type CertStoreSource = 'bundled' | 'system';

const DEFAULT_CERT_STORE_SOURCES: CertStoreSource[] = ['bundled', 'system'];

/**
 * Parse a comma-separated cert-store source list (settings `certStore`).
 * Unknown tokens are reported in `invalid` and skipped; when nothing valid
 * remains the documented default (`bundled,system`) applies fail-safe.
 */
export function parseCertStoreSources(
  value: string | undefined,
): { sources: CertStoreSource[]; invalid: string[] } {
  const entries = splitCommaSeparated(value).map(entry => entry.toLowerCase());
  if (entries.length === 0) {
    return { sources: [...DEFAULT_CERT_STORE_SOURCES], invalid: [] };
  }

  const sources: CertStoreSource[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    if (entry === 'bundled' || entry === 'system') {
      if (!sources.includes(entry)) sources.push(entry);
    } else {
      invalid.push(entry);
    }
  }

  if (sources.length === 0) {
    return { sources: [...DEFAULT_CERT_STORE_SOURCES], invalid };
  }
  return { sources, invalid };
}

export type CaTrustComposition = {
  /**
   * The explicit CA set to hand to undici/tls, or `undefined` to leave the
   * runtime's default trust untouched (bundled Mozilla set + any
   * NODE_EXTRA_CA_CERTS the process was launched with).
   */
  ca?: string[];
  /** Human-readable degradation reports. Never contains certificate bytes. */
  warnings: string[];
};

type GetCACertificates = (type: 'bundled' | 'system' | 'extra') => string[];

/** The runtime's tls.getCACertificates, when this runtime ships it. */
export function runtimeGetCACertificates(): GetCACertificates | undefined {
  const candidate = (tls as { getCACertificates?: unknown }).getCACertificates;
  return typeof candidate === 'function' ? (candidate as GetCACertificates) : undefined;
}

/**
 * Compose the effective CA trust set from the configured sources plus the
 * app-level extra CA (custom `tlsCaPath` file or the bundled corporate CA
 * resource).
 *
 * Reading the OS store requires a runtime with `tls.getCACertificates`
 * (network-config.md:58). Where the runtime lacks it, the composition
 * degrades to bundled-plus-extra with a REPORTED warning rather than
 * throwing, which is exactly today's pre-OS-store behavior.
 */
export function composeCaTrust(options: {
  sources: CertStoreSource[];
  extraCa?: string;
  getCACertificates?: GetCACertificates;
}): CaTrustComposition {
  const { sources, extraCa, getCACertificates } = options;
  const warnings: string[] = [];

  if (!getCACertificates) {
    if (sources.includes('system')) {
      warnings.push(
        'OS certificate store requested but this runtime lacks tls.getCACertificates; '
        + 'continuing with the bundled Mozilla set only.',
      );
    }
    // Degraded runtime: today's behavior exactly. With no extra CA, leave the
    // runtime defaults alone (they already include NODE_EXTRA_CA_CERTS).
    if (!extraCa) return { warnings };
    return { ca: [...rootCertificates, extraCa], warnings };
  }

  // Fast path: bundled-only with no extra CA IS the runtime default. Passing
  // an explicit list here would silently drop a NODE_EXTRA_CA_CERTS the
  // process was launched with.
  if (sources.length === 1 && sources[0] === 'bundled' && !extraCa) {
    return { warnings };
  }

  const read = (type: 'bundled' | 'system' | 'extra', fallback?: string[]): string[] => {
    try {
      return getCACertificates(type);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Could not read the ${type} certificate store: ${message}`);
      return fallback ?? [];
    }
  };

  const ca: string[] = [];
  for (const source of sources) {
    if (source === 'bundled') ca.push(...read('bundled', [...rootCertificates]));
    else ca.push(...read('system'));
  }
  // NODE_EXTRA_CA_CERTS always augments the trust set in Node itself; an
  // explicit composition must not silently drop it (network-config.md:83).
  ca.push(...read('extra'));
  if (extraCa) ca.push(extraCa);

  return { ca, warnings };
}

export interface NoProxyRule {
  /** Exact hostname or domain suffix (without leading dot). */
  host: string;
  /** Optional port restriction. */
  port?: number;
  /** If true, matches any hostname (wildcard `*`). */
  wildcard: boolean;
}

type TlsOptions = {
  ca?: string[];
  cert?: string;
  key?: string;
  passphrase?: string;
};

/** mTLS client identity, resolved fresh from files at settings-apply time. */
export type TlsClientIdentity = {
  cert: string;
  key: string;
  passphrase?: string;
};

export type UndiciDispatcherConfig = {
  directAgentOptions?: {
    connect: TlsOptions;
  };
  proxyAgentTlsOptions?: {
    requestTls: TlsOptions;
    proxyTls: TlsOptions;
  };
};

export function buildUndiciDispatcherConfig(
  caSet?: string[],
  clientIdentity?: TlsClientIdentity,
): UndiciDispatcherConfig {
  if (!caSet && !clientIdentity) {
    return {};
  }

  // The caller hands us the COMPLETE composed trust set (composeCaTrust:
  // bundled Mozilla roots + OS store + extra CAs, per the configured source
  // list). Passing a bare `ca` to undici/tls REPLACES Node's default roots,
  // so the composition must always union in the roots it wants kept — a
  // corporate-CA-only list would fail every public-root host (remote agents,
  // github, Nestor Cloud) with UNABLE_TO_GET_ISSUER_CERT_LOCALLY.
  //
  // The client identity (mTLS) rides the same TLS options: the direct agent
  // presents it origin-to-origin, and the proxy agent presents it both to the
  // proxy itself (proxyTls) and through the CONNECT tunnel to the origin
  // (requestTls) — a server that never requests a certificate ignores it.
  const tlsOptions: TlsOptions = {
    ...(caSet ? { ca: caSet } : {}),
    ...(clientIdentity
      ? {
        cert: clientIdentity.cert,
        key: clientIdentity.key,
        ...(clientIdentity.passphrase ? { passphrase: clientIdentity.passphrase } : {}),
      }
      : {}),
  };
  return {
    directAgentOptions: { connect: tlsOptions },
    proxyAgentTlsOptions: {
      requestTls: tlsOptions,
      proxyTls: tlsOptions,
    },
  };
}

/**
 * Parse a NO_PROXY string into structured rules. Entries are separated by
 * commas OR whitespace — network-config.md:30-33 documents both spellings of
 * the same variable side by side.
 *
 * Supported formats per entry:
 *   - `*`                 → wildcard, bypass everything
 *   - `example.com`       → exact host match
 *   - `.example.com`      → suffix match (subdomain)
 *   - `example.com:8080`  → host + port
 *   - `192.168.1.1`       → exact IP literal
 *   - `[::1]`, `[::1]:80` → IPv6 literal, bracketed, optional port
 *   - `::1`, `2001:db8::1` → IPv6 literal, BARE (see the colon rule below)
 *
 * THE COLON RULE, and it is read rather than invented. A bare IPv6 literal and
 * a `host:port` pair are genuinely ambiguous in this grammar, and the page that
 * is our contract does not resolve it: `network-config.md#environment-variables`
 * enumerates only `localhost`, an IPv4 literal, `example.com`, `.example.com`
 * and `*` — no IPv6 entry and no port entry at all — while elsewhere on the
 * same page it spells the loopback address BARE: "Claude Code never sends its
 * WebSocket connections to `localhost`, `::1`, or `127.0.0.0/8` through the
 * proxy". So the disambiguation comes from the reference implementation instead:
 * Go's `golang.org/x/net/http/httpproxy` (the one behind
 * `net/http.ProxyFromEnvironment`) runs each entry through `net.SplitHostPort`,
 * which refuses an UNBRACKETED host part containing a colon of its own —
 * `tooManyColons`, `net/ipsock.go` — and then accepts what is left as an IP
 * literal. That is exactly the rule below: a colon separates host from port
 * only when nothing before it is a colon, so brackets are how an operator says
 * "and this part is a port".
 *
 * This makes us a strict SUPERSET of the three JS implementations, which is why
 * widening is safe: `proxy-from-env` 2.1.0, `undici` 7.28.0's
 * `EnvHttpProxyAgent`, and the shipped `claude` binary (which bundles
 * `proxy-from-env` verbatim — its `/^(.+):(\d+)$/` occurs twice in the 272 MB
 * `claudeCodeVersion 2.1.223` artifact) all accept ONLY the bracketed spelling,
 * because they match against a URL host with its brackets kept. We strip the
 * brackets on both sides instead, so both spellings land on one host string and
 * no entry that worked before changes meaning.
 *
 * RESIDUE, stated rather than papered over: entries are lowercased but NOT
 * canonicalised, so `2001:0db8::1` does not match the URL parser's compressed
 * `2001:db8::1`. Writing an IPv6 canonicaliser here would be a bigger change
 * than the defect it closes; an operator who copies the address out of the URL
 * bar is unaffected.
 */
export function parseNoProxyRules(noProxy: string | undefined): NoProxyRule[] {
  if (!noProxy) return [];

  return splitNoProxyEntries(noProxy)
    .map(entry => entry.toLowerCase())
    .map(entry => {
      if (entry === '*') {
        return { host: '*', wildcard: true };
      }

      // Strip leading dot (treated as suffix match — same result as without dot)
      let cleaned = entry.startsWith('.') ? entry.slice(1) : entry;

      // Handle IPv6: strip brackets, optionally extract trailing port ([::1]:8080)
      if (cleaned.startsWith('[')) {
        const closeBracket = cleaned.indexOf(']');
        if (closeBracket > 0) {
          const ipv6Host = cleaned.slice(1, closeBracket);
          const afterBracket = cleaned.slice(closeBracket + 1);
          if (afterBracket.startsWith(':')) {
            const port = parseInt(afterBracket.slice(1), 10);
            if (!isNaN(port)) {
              return { host: ipv6Host, port, wildcard: false };
            }
          }
          return { host: ipv6Host, wildcard: false };
        }
      }

      // Check for port. The guard is the colon rule above: without it a bare
      // IPv6 literal reached this branch and came out as a rule matching
      // nothing — `::1` has its last colon at index 1, so it parsed to
      // `{ host: ':', port: 1 }` and an operator who wrote `noProxy: "::1"`
      // got a silent non-bypass.
      const lastColon = cleaned.lastIndexOf(':');
      if (lastColon > 0 && !cleaned.slice(0, lastColon).includes(':')) {
        const host = cleaned.slice(0, lastColon);
        const port = parseInt(cleaned.slice(lastColon + 1), 10);
        if (!isNaN(port)) {
          return { host, port, wildcard: false };
        }
      }

      return { host: cleaned, wildcard: false };
    });
}

/**
 * The loopback spellings every proxy bypass in this repo is built from — the
 * host's own resolver here, and the `NO_PROXY` value written into every
 * subprocess env (`config/proxy-env.ts` `applyLoopbackProxyExemption`, and its
 * twin `runtime-manager.ts` `applyLoopbackNoProxy` in `codex-agent-server`,
 * which is a copy only because importing it would close a package cycle).
 *
 * ONE list, so host and child cannot drift: whatever a subprocess is told to
 * bypass is exactly what this process bypasses. The residue is stated rather
 * than papered over — `127.0.0.2` is loopback to the kernel and is NOT on this
 * list, so it is proxied by the host and by every child alike. Uniformly wrong
 * beats divergently right.
 *
 * ## WHY IPv6 LOOPBACK IS SPELLED TWICE (P2.471, measured 2026-08-31)
 *
 * `::1` and `[::1]` are BOTH here, and neither is redundant. There is no single
 * spelling that works everywhere, because the two parser families disagree in
 * opposite directions — six implementations measured, each on its own rig, each
 * with a live control:
 *
 * | implementation                                   | bare `::1` | `[::1]` |
 * | ------------------------------------------------ | ---------- | ------- |
 * | Bun 1.3.14 native `fetch` (**Pi**, and this host)| no bypass  | BYPASS  |
 * | `proxy-from-env` 2.1.0 (**the claude binary**)   | no bypass  | BYPASS  |
 * | `undici` 7.28.0 `EnvHttpProxyAgent`              | no bypass  | BYPASS  |
 * | `hyper-util` 0.1.20 / `reqwest` 0.12.28 (**codex**) | BYPASS  | no bypass |
 * | Go 1.24.3 `net/http` `ProxyFromEnvironment`      | BYPASS     | no bypass |
 * | `curl` 8.7.1                                     | BYPASS     | no bypass |
 *
 * The split is one line of code on each side. The JS family compares the entry
 * against a URL host with its brackets KEPT (`proxy-from-env`
 * `hostname = parsedUrl.host` then `.replace(/:\d*$/, '')`), so only `[::1]`
 * can ever equal it — and a bare `::1` is worse than inert there, since
 * `/^(.+):(\d+)$/` reads it as host `::` on port 1. The IP family parses the
 * ENTRY as an address (`hyper-util` `matcher.rs`: `part.parse::<IpNet>()` then
 * `part.parse::<IpAddr>()`, "otherwise, assume it is a domain") and strips the
 * brackets off the URL host instead, then looks the result up in the IP list
 * ONLY — so `[::1]` parses as neither net nor address, decays into the domain
 * list, and that list is never consulted for a host that parsed as an IP.
 *
 * Both together satisfy all six, and poison none of them: measured with the
 * full four-entry value, `127.0.0.1` and `localhost` still bypass and a remote
 * host still goes through the proxy on every one of the six.
 *
 * WHAT MADE THE PREDECESSOR ROWS WRONG, and the trap to avoid when re-measuring
 * this: P2.251 and P2.259 concluded the bare spelling was accepted, and every
 * arm of both used a `http://127.0.0.1:<port>` URL — so the `127.0.0.1` entry
 * did the bypassing and the IPv6 entry was never exercised at all. A dead arm
 * inside a green measurement. An arm that discriminates between the two
 * spellings must carry the entry under test ALONE.
 */
export const LOOPBACK_NO_PROXY_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'] as const;

/** Default ports by protocol, used when URL omits an explicit port. */
const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 };

/**
 * The loopback hosts as rules. Still built DIRECTLY rather than through
 * {@link parseNoProxyRules}, but no longer as a workaround: the parser defect
 * this comment used to describe is FIXED (see the colon rule on
 * `parseNoProxyRules`), and `parseNoProxyRules(LOOPBACK_NO_PROXY_HOSTS.join(','))`
 * now returns exactly this array — pinned by a test, so the two cannot drift.
 * The direct construction stays because this list is the host's UNCONDITIONAL
 * exemption: it should not acquire a dependency on the parser that operator
 * input flows through.
 *
 * ONE CORRECTION, measured 2026-08-31, because this comment asserted the
 * opposite and the assertion was load-bearing. It said the constant "must keep
 * the BARE spelling — that is what P2.251 and P2.259 measured the claude binary
 * and Bun's own `fetch` accepting in a `NO_PROXY` value". Neither accepts it,
 * and P2.471 has since made the constant carry BOTH spellings; the measured
 * table lives on {@link LOOPBACK_NO_PROXY_HOSTS}.
 *
 * THE BRACKETS COME OFF HERE, and only here. The constant's two IPv6 spellings
 * exist for third-party parsers reading a `NO_PROXY` string out of an
 * environment. This process is not one of them: `shouldBypassProxy` strips the
 * brackets off the URL host, so a rule whose host is the literal `[::1]` could
 * never match anything, and shipping one would be a dead rule with no reader.
 * Stripping collapses the pair onto one `::1` rule, twice — harmless, since
 * matching is a linear scan for the first hit.
 */
const LOOPBACK_RULES: NoProxyRule[] = LOOPBACK_NO_PROXY_HOSTS
  .map(host => ({ host: withoutIpv6Brackets(host), wildcard: false }));

/**
 * `[::1]` → `::1`, anything else unchanged. The one-line half of
 * `parseNoProxyRules`' bracket branch, shared with the loopback rules above so
 * the two cannot answer differently for the same entry.
 */
function withoutIpv6Brackets(entry: string): string {
  return entry.startsWith('[') && entry.endsWith(']') ? entry.slice(1, -1) : entry;
}

function matchesNoProxyRules(host: string, port: number | undefined, rules: NoProxyRule[]): boolean {
  for (const rule of rules) {
    if (rule.wildcard) return true;

    // Port-scoped rule: only match when port matches
    if (rule.port !== undefined && rule.port !== port) {
      continue;
    }

    // Exact match
    if (host === rule.host) return true;

    // Suffix match (subdomain): host ends with .rule.host
    if (host.endsWith(`.${rule.host}`)) return true;
  }

  return false;
}

/**
 * Is this URL one of THIS machine's own loopback addresses?
 *
 * Swallows a malformed URL rather than throwing, so the `rules.length === 0`
 * caller below keeps the exact throw profile it had before loopback was
 * checked first.
 */
function isLoopbackUrl(url: string | URL): boolean {
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  return matchesNoProxyRules(host, undefined, LOOPBACK_RULES);
}

/**
 * Determine whether a URL should bypass the proxy: loopback always, then the
 * configured NO_PROXY rules.
 *
 * ## Why loopback is exempt BEFORE the rules, and unconditionally (P2.263)
 *
 * MEASURED 2026-08-27 through the real `applyProcessNetworkTrustChain`: with a
 * Settings proxy enabled and no `noProxy`, the host's own fetch of
 * `http://localhost:<port>/v1/models` — the local-model card's own model list —
 * landed on the sink proxy and the local server got ZERO hits. `rules.length
 * === 0 → false` was the whole cause: with nothing configured there were no
 * rules, so nothing bypassed, so the app asked a corporate proxy to reach
 * 127.0.0.1. The user-visible symptom was a shipped card that cannot list its
 * models the moment any proxy is configured.
 *
 * THE POLICY, decided rather than queued (owner rule: where the documentation
 * is silent, be TRANSPARENT and SIMPLE):
 *
 *  - `NO_PROXY` is a BYPASS list. Its grammar has no way to say "and definitely
 *    DO proxy this one", so omitting loopback from an explicit list is the
 *    absence of an instruction, not an instruction — nothing an administrator
 *    can write today is being reversed here. What changes is a default.
 *  - `127.0.0.1` handed to a proxy means the PROXY's own loopback. There is no
 *    configuration in which forwarding it is what the operator meant.
 *  - Every subprocess this app spawns already exempts loopback unconditionally
 *    — `applyLoopbackProxyExemption` plus codex's twin; the caller list is on
 *    that function and is deliberately not restated here, because it grows (the
 *    `dp` execs joined it in DA1.59) and a count written beside a list that
 *    grows is the drift AGENTS.md records. A host that proxies loopback while
 *    its children do not is precisely the silent divergence the host exists to
 *    remove.
 *
 * Both callers are fixed by this one edit and neither had to be touched:
 * `config/network-runtime.ts` `proxyForUrl` (the Bun `fetch` wrapper) and
 * `apps/electron/src/main/network-proxy.ts` (the undici dispatcher). The OTHER
 * mechanism on this surface is not here and needed its own fix: `projectProxyEnv`
 * writes the proxy into `process.env` (delete, then assign) for the CHILDREN spawned later, which never
 * consult this function; Bun's own fetch does not see that write (F1.1155, measured) — the wrapper proxies it.
 *
 * This is an exemption, not a `no_proxy=*` opt-out: genuine non-loopback traffic
 * still goes through the proxy, which is the control the P2.251 rig measured on
 * the subprocess side.
 *
 * ## The list stays LOOPBACK-ONLY — C3.357, refused with its reason
 *
 * R2's rig measured the app wedging when its OWN auth and gateway hosts were
 * refused by a proxy: a `sessions:command` past its 30 s ceiling, and the same
 * relaunch ready in 5 s once the rig's proxy stopped denying them. The row born
 * from that reading asked for those two hosts to join this exemption. They do
 * not, and the argument is three lines above this paragraph:
 *
 *  - Loopback qualifies because *"`127.0.0.1` handed to a proxy means the
 *    PROXY's own loopback"* — forwarding it is never what the operator meant.
 *    That is a property of the ADDRESS. `code-completion-nestor.tcsbank.ru` has
 *    no such property: it is an ordinary remote host, and on a corporate
 *    network the proxy is frequently the ONLY route to it.
 *  - So the exemption would not make the app resilient, it would make it
 *    UNREACHABLE for exactly the deployment that configured a proxy because it
 *    needs one — trading a rig-shaped failure for a real one.
 *  - And the operator already has the control: `noProxy` is a bypass list they
 *    write. Exempting our own hosts unconditionally would take that decision
 *    away from them rather than give them one.
 *
 * What the rig actually measured is a LATENCY defect, not a routing one, and it
 * is not fixed here: every one of the app's own catalogue fetches is already
 * bounded (`model-fetchers/nestor.ts` and `openai-compat.ts` at 3 s and 10 s),
 * and the largest known contributor on the build R2 drove — the turn's wait on
 * the `dp` CLI session — was removed by C3.381 two builds later. The residue is
 * a proposed row, not a silent exemption here.
 */
export function shouldBypassProxy(url: string | URL, rules: NoProxyRule[]): boolean {
  if (isLoopbackUrl(url)) return true;
  if (rules.length === 0) return false;

  const parsed = typeof url === 'string' ? new URL(url) : url;
  const hostname = parsed.hostname.toLowerCase();
  // Strip brackets from IPv6
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  const port = parsed.port ? parseInt(parsed.port, 10) : DEFAULT_PORTS[parsed.protocol];

  return matchesNoProxyRules(host, port, rules);
}

// ============================================================================
// F1.498 — which proxy the HOST's own requests use
// ============================================================================

/**
 * Where a host proxy came from, highest tier first. The same ladder
 * `tls-ca-path.ts` (`resolveTlsCaPathSelection`) gives the extra CA.
 */
export type HostProxySource = 'managed' | 'settings' | 'ambient' | 'none';

export type HostProxySelection = {
  source: HostProxySource;
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
  /** The environment NAME the proxy was read from, for a log line. Never the value. */
  envName?: string;
};

/**
 * The four proxy names in the documented order —
 * `network-config.md#environment-variables`: "Claude Code uses the first one
 * that's set in the order `https_proxy`, `HTTPS_PROXY`, `http_proxy`,
 * `HTTP_PROXY`". `unified-network-interceptor.ts` (`PROXY_URL`) is the inline
 * twin; it cannot import this module (it is bundled standalone), so the next
 * change to the order touches both.
 */
export const HOST_PROXY_ENV_ORDER = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY'] as const;

/**
 * F1.498 — the proxy for THIS process's own requests, resolved from what the
 * process knows NOW.
 *
 * ## Why the host needs this at all
 *
 * A codex or claude-runtime turn reaches its model through the per-session
 * loopback adapter, which runs INSIDE the host and makes the upstream request
 * itself (`gatewaySessionFetch` over the host's global `fetch`). So the proxy
 * that governs those turns is the HOST's, not the child's. The desktop main
 * process read only Settings (`networkProxy`) and otherwise installed a direct
 * agent, and the headless server read the launch environment once, at preload.
 * Measured (WJ-ai, 2026-09-24): a launch-environment `HTTPS_PROXY` went DIRECT
 * on the desktop and through the proxy on the headless server, and a proxy a
 * managed `env` block writes after startup went DIRECT on both — while every
 * Pi turn, whose Bun child inherits the environment at spawn, obeyed all three.
 *
 * ## The ladder, and where each tier is read from rather than invented
 *
 * 1. **managed** — a proxy name this process carries BECAUSE a managed `env`
 *    block wrote it (`managedOrigin`, the registry `managed-env.ts` keeps).
 *    Managed settings outrank every other level
 *    (`server-managed-settings.md#settings-precedence`), and the documented
 *    channel for mandating a proxy is exactly that block
 *    (`network-config.md#environment-variables`: "Claude Code reads them only
 *    from managed settings and `~/.claude/settings.json`").
 * 2. **settings** — the in-app `networkProxy`, when enabled with a proxy.
 * 3. **ambient** — any proxy name in the environment: a launch export, or on
 *    macOS a login-shell export `loadShellEnv` copied into the main process.
 *    Below Settings, the precedence `buildPiSubprocessEnv` already gives the Pi
 *    child and `resolveTlsCaPathSelection` gives an operator's CA export.
 * 4. **none**.
 *
 * An environment tier yields ONE proxy for both schemes, as the documented
 * order does (and as the interceptor always has); `NO_PROXY` then `no_proxy`
 * comes from the same environment. Loopback needs no entry here: it bypasses
 * in {@link shouldBypassProxy} whatever the list says.
 *
 * Pure: the caller hands in the environment and the managed-origin oracle, so
 * both hosts (the Electron main's dispatcher, the headless server's fetch
 * wrapper) resolve through one function and cannot disagree.
 */
export function resolveHostProxySelection(
  settings: { enabled?: boolean; httpProxy?: string; httpsProxy?: string; noProxy?: string } | undefined,
  env: Readonly<Record<string, string | undefined>>,
  managedOrigin: (name: string) => boolean,
): HostProxySelection {
  const noProxy = env.NO_PROXY?.trim() || env.no_proxy?.trim() || undefined;
  const fromEnv = (accept: (name: string) => boolean): HostProxySelection | undefined => {
    for (const name of HOST_PROXY_ENV_ORDER) {
      const value = env[name]?.trim();
      if (value && accept(name)) {
        return { source: 'ambient', httpProxy: value, httpsProxy: value, ...(noProxy ? { noProxy } : {}), envName: name };
      }
    }
    return undefined;
  };

  const managed = fromEnv(managedOrigin);
  if (managed) return { ...managed, source: 'managed' };

  if (settings?.enabled && (settings.httpProxy || settings.httpsProxy)) {
    return {
      source: 'settings',
      ...(settings.httpProxy ? { httpProxy: settings.httpProxy } : {}),
      ...(settings.httpsProxy ? { httpsProxy: settings.httpsProxy } : {}),
      ...(settings.noProxy ? { noProxy: settings.noProxy } : {}),
    };
  }

  return fromEnv(() => true) ?? { source: 'none' };
}

/**
 * UA12.201 — whether THIS process's own `fetch` sends a URL through a proxy right now, for a request that has to
 * choose its path before it connects: the MCP OAuth request (`auth/oauth.ts` `fetchOAuthUrlPinned`), which pins
 * its direct connection to an already-validated address and so must know when the process would not connect
 * directly at all. Each host registers the decision its own `fetch` makes, so the two cannot disagree: the Electron
 * main's `HostProxyDispatcher` (`select` + the `NO_PROXY` rules its `ProtocolProxyDispatcher` applies) and the
 * headless fetch wrapper (`proxyForUrl`). Both resolve through {@link resolveHostProxySelection}: a managed `env`
 * block's proxy, then Settings, then the environment; loopback always bypasses. `false` when no host registered
 * (nothing applied a trust chain yet — the process's `fetch` then goes direct too).
 */
export type ProcessFetchProxyRoute = (url: string) => boolean;

let processFetchProxyRoute: ProcessFetchProxyRoute | undefined;

/** UA12.201 — register (or, with `undefined`, clear) this process's fetch proxy decision. */
export function setProcessFetchProxyRoute(route: ProcessFetchProxyRoute | undefined): void {
  processFetchProxyRoute = route;
}

/** UA12.201 — whether this process's own `fetch` would send `url` through a proxy now. */
export function processFetchUsesProxy(url: string): boolean {
  return processFetchProxyRoute?.(url) ?? false;
}
