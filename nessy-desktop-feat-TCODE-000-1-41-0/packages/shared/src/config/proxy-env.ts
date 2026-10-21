import { expandPath } from '../utils/paths.ts';
// DA1.72 — the LEAF, not `storage.ts`. This module wants exactly one value,
// and reaching it through `storage.ts` pulled `credentials/index.ts`,
// `sessions/index.ts` and `docs/index.ts` into every process that asked a
// proxy question. Measured: 161 transitive runtime imports before, and the
// census in `config/__tests__/stored-config-load-leaf.test.ts` keeps it so.
import { getNetworkProxySettings } from './stored-config-load.ts';
import { findRefusedProxyUrl } from './proxy-url-validation.ts';
import { LOOPBACK_NO_PROXY_HOSTS, splitNoProxyEntries } from './network-proxy-utils.ts';
import { resolveTlsCaPathSelection } from './tls-ca-path.ts';
import type { NetworkProxySettings } from './types.ts';

/**
 * Convert stored network settings into environment variables for
 * subprocesses, so every child process verifies against the SAME trust chain
 * as the main process (network-config.md:78, :92-98). Without this, a Pi
 * subprocess or a stdio MCP server talking to a TLS-inspected endpoint fails
 * where the app succeeds — which reads as an unrelated bug.
 *
 * - Proxy: HTTP_PROXY / HTTPS_PROXY / NO_PROXY (only while the proxy is
 *   enabled).
 * - Extra CA: NODE_EXTRA_CA_CERTS — honored natively by Node and Bun, so
 *   anything Node-based picks it up without our help. Emitted regardless of
 *   proxy enablement, mirroring the main process (the CA applies to direct
 *   connections too).
 * - mTLS client identity: CLAUDE_CODE_CLIENT_CERT / CLAUDE_CODE_CLIENT_KEY /
 *   CLAUDE_CODE_CLIENT_KEY_PASSPHRASE — the documented spellings, honored by
 *   the Claude Code subprocess directly and by our own Pi interceptor.
 *
 * SECURITY: values here may include the client-key passphrase. Never log the
 * returned record.
 */
export function buildNetworkEnvVars(
  settings: NetworkProxySettings | undefined,
  options: {
    /**
     * Ambient environment consulted for precedence: an operator-provided
     * NODE_EXTRA_CA_CERTS wins over the app-default bundled CA resource
     * (emitting nothing lets the inherited value through at the spawn site),
     * while a user-configured custom `tlsCaPath` wins over the operator's — and
     * a MANAGED NODE_EXTRA_CA_CERTS wins over both.
     */
    processEnv?: Record<string, string | undefined>;
    /** Test seam for the bundled corporate CA resource path. */
    bundledCaPath?: string;
    /**
     * Which ambient variables came from a managed `env` block. Defaults to the
     * real registry in `managed-env.ts`; a test passes its own so the ladder can
     * be exercised without mutating the process environment.
     */
    managedEnvOrigin?: (name: string) => boolean;
    /**
     * Withhold the client identity (paths + passphrase) while keeping proxy
     * and CA. Used for supervised plugin processes, which deliberately run
     * with an explicit non-secret env baseline — the mTLS credential must not
     * cross that boundary.
     */
    excludeClientIdentity?: boolean;
  } = {},
): Record<string, string> {
  const processEnv = options.processEnv ?? process.env;
  const env: Record<string, string> = {};

  // A SOCKS URL is refused at the settings write path; a hand-edited config
  // is refused again here so subprocesses are never pointed at a proxy the
  // main process refused to use (the refusal is reported by the apply path).
  if (settings?.enabled && !findRefusedProxyUrl(settings)) {
    if (settings.httpProxy) {
      env.HTTP_PROXY = settings.httpProxy;
      env.http_proxy = settings.httpProxy;
    }
    if (settings.httpsProxy) {
      env.HTTPS_PROXY = settings.httpsProxy;
      env.https_proxy = settings.httpsProxy;
    }
    if (settings.noProxy) {
      // Canonical comma-joined form: our own parsers accept both documented
      // NO_PROXY spellings (network-config.md:30-33), but this env is spread
      // into subprocesses (Pi, Claude SDK, stdio MCP servers) whose third-party
      // parsers are comma-only — a space-form setting passed through raw would
      // keep failing everywhere except our two patched parsers.
      const canonicalNoProxy = splitNoProxyEntries(settings.noProxy).join(',');
      if (canonicalNoProxy) {
        env.NO_PROXY = canonicalNoProxy;
        env.no_proxy = canonicalNoProxy;
      }
    }
  }

  const caSelection = resolveTlsCaPathSelection(settings, {
    ...('bundledCaPath' in options ? { bundledCaPath: options.bundledCaPath } : {}),
    processEnv,
    ...(options.managedEnvOrigin ? { managedOrigin: options.managedEnvOrigin } : {}),
  });
  if (caSelection.path) {
    const operatorProvided = !!processEnv.NODE_EXTRA_CA_CERTS;
    // Precedence: MANAGED env block > explicit user config (custom) > operator
    // shell env > app-default bundled resource. Callers spread process.env
    // before this projection, so omitting the key preserves the operator's
    // value.
    //
    // The managed tier used to be missing entirely, and its absence INVERTED
    // the top of the ladder: an admin's org CA delivered through a managed
    // `env` block lost to a user's `tlsCaPath`, because `tls-ca-path.ts` tagged
    // user config `custom` and nothing here could tell a managed
    // `NODE_EXTRA_CA_CERTS` from an operator's shell export.
    // `server-managed-settings.md#settings-precedence` forbids exactly that:
    // "No other settings level can override them, including command line
    // arguments, apart from the exceptions to managed settings precedence."
    if (caSelection.source !== 'bundled' || !operatorProvided) {
      env.NODE_EXTRA_CA_CERTS = caSelection.path;
    }
  }

  if (!options.excludeClientIdentity && settings?.clientCertPath && settings.clientKeyPath && !managedClientIdentityNamed(processEnv, options.managedEnvOrigin)) {
    env.CLAUDE_CODE_CLIENT_CERT = expandPath(settings.clientCertPath);
    env.CLAUDE_CODE_CLIENT_KEY = expandPath(settings.clientKeyPath);
    if (settings.clientKeyPassphrase) {
      env.CLAUDE_CODE_CLIENT_KEY_PASSPHRASE = settings.clientKeyPassphrase;
    }
  }

  return env;
}

/**
 * Network env projection for subprocesses the app trusts with its own
 * network identity: the Pi subprocess, the Claude Code subprocess, native
 * stdio MCP servers, and the headless server's children.
 *
 * The codex app-server is DELIBERATELY not on that list, and the reason is
 * written at its spawn site (`packages/codex-agent-server/src/runtime-manager.ts`,
 * P2.213): all three components of this projection were measured against the
 * bundled binary and are respectively already-inherited, inert, or a secret it
 * never reads. The list was silent about codex until 2026-08-27, which is why
 * the absence read as an oversight.
 *
 * CODEX IS NOT A SPREAD CONSUMER, BUT IT IS NO LONGER A CONSUMER OF NOTHING
 * (P3.40, correcting this docblock after `687ecff05`). `resolveCodexCaCertificatePath`
 * (`agent/codex-agent.ts`) reads exactly ONE key out of the record returned
 * here — `NODE_EXTRA_CA_CERTS`, for the already-resolved managed > custom >
 * operator > bundled answer — and hands the child that PATH re-badged as
 * `CODEX_CA_CERTIFICATE`, the one name codex's trust store reads. Nothing is
 * spread and the proxy triple and the mTLS trio still never cross. This line
 * exists because P2.251 and P2.259 both consulted this docblock BEFORE
 * measuring, so a stale sentence here is a wrong premise handed to the next
 * lane rather than a cosmetic drift.
 *
 * DO NOT ADD A THIRD CA VARIABLE FOR CODEX, and `SSL_CERT_DIR` is the one that
 * will tempt you (P3.39). Codex's own override path reads exactly two names, in
 * order — `CODEX_CA_CERTIFICATE` then `SSL_CERT_FILE` — source-verified by P3.30
 * against `openai/codex`'s `codex-rs/http-client/src/custom_ca.rs`, and the
 * value is a PATH TO A PEM FILE with no directory form at all.
 *
 * The trap is that grepping the shipped binary suggests otherwise, and it
 * suggests MORE than three. Measured in
 * `resources/bin/codex/darwin-arm64/codex-app-server` (2026-08-29):
 * `SSL_CERT_DIR` occurs twice, and NEITHER is an override. One sits in the
 * platform trust loader beside "failed to load user/admin/system trust
 * settings". The other sits in codex's own managed-MITM-proxy env list —
 * TWELVE CA names it injects into sandboxed children, `CODEX_CA_CERTIFICATE`,
 * `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`,
 * `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`, `CARGO_HTTP_CAINFO`, `PIP_CERT`,
 * `BUNDLE_SSL_CA_CERT`, `npm_config_cafile`, `NPM_CONFIG_CAFILE`,
 * `SSL_CERT_DIR`. That list is also where `NODE_EXTRA_CA_CERTS` appears, which
 * is why the "inert for codex" verdict beside it is about the TRUST STORE and
 * not about the string being absent. Counts on the same scan, controls
 * included: `SSL_CERT_FILE` 7, `CODEX_CA_CERTIFICATE` 6, `SSL_CERT_DIR` 2, a
 * made-up name 0 — and `rustls-native-certs` 0, so the attribution of the
 * loader hit rests on P3.30's source read, not on this scan.
 *
 * A spawn site that points its child at a LOOPBACK URL must additionally call
 * `applyLoopbackProxyExemption` on the merged env — this projection cannot do it
 * for them, and without it the child POSTs its own loopback address at the
 * proxy. See that function for the measurement.
 */
export function getProxyEnvVars(): Record<string, string> {
  return buildNetworkEnvVars(getNetworkProxySettings());
}

/**
 * Every proxy variable a subprocess might be routed by — both documented
 * spellings of all three. `buildNetworkEnvVars` only ever EMITS
 * `HTTP_PROXY`/`HTTPS_PROXY`, but the merged env a spawn site hands a child also
 * carries whatever the host inherited, and on macOS packaged builds that is the
 * user's entire login shell (`apps/electron/src/main/shell-env.ts`
 * `loadShellEnv`). `ALL_PROXY` is in the list because it is a route the app
 * never sets and the shell often does.
 */
const PROXY_ENV_VARS = [
  'HTTP_PROXY', 'http_proxy',
  'HTTPS_PROXY', 'https_proxy',
  'ALL_PROXY', 'all_proxy',
] as const;

/**
 * Exempt loopback from an HTTP proxy in a subprocess env — and ONLY when a
 * proxy is actually set, so a session with no proxy keeps a byte-identical env.
 *
 * WHY THIS IS NOT OPTIONAL, and why it is a MUTATOR OVER THE MERGED ENV rather
 * than another key in `buildNetworkEnvVars` (P2.251, measured 2026-08-27 against
 * the real `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` binary behind a
 * loopback sink proxy — four arms, one rig):
 *
 * | HTTP(S)_PROXY | NO_PROXY          | ANTHROPIC_BASE_URL | outcome                        |
 * | ------------- | ----------------- | ------------------ | ------------------------------ |
 * | absent        | —                 | 127.0.0.1:<port>   | turn ok, 0 proxy hits          |
 * | sink proxy    | absent            | 127.0.0.1:<port>   | turn FAILED, adapter got 0 hits|
 * | sink proxy    | loopback exempted | 127.0.0.1:<port>   | turn ok, 0 proxy hits          |
 * | sink proxy    | loopback exempted | api.…invalid       | proxy got the POST (still on)  |
 *
 * Row 2 is the shipped default for a corporate-proxy user: `ANTHROPIC_BASE_URL`
 * on a `claude-runtime` session is `http://127.0.0.1:<port>` — the per-session
 * gateway adapter (`ClaudeAgent.startLocalAdapter`) — and the child POSTs that
 * loopback URL AT the proxy, which cannot reach it. Row 4 is what makes this an
 * exemption and not a `no_proxy=*` opt-out: genuine non-loopback traffic still
 * goes through the proxy.
 *
 * The merged env is the only place this can be decided. `getProxyEnvVars()` sees
 * the in-app Settings proxy alone, so a projection-time rule would miss exactly
 * the failing case — a `HTTPS_PROXY` exported in the user's `.zshrc` with no
 * Settings proxy configured at all.
 *
 * `packages/codex-agent-server/src/runtime-manager.ts` `applyLoopbackNoProxy` is
 * this function's twin, measured first (P2.213) on the codex binary. It is a
 * copy rather than an import because `@nessy-agent/shared` already imports that
 * package (`shared/src/agent/codex-agent.ts`) and the import would close a
 * cycle — the two must change together, and since P2.259 that file points back
 * here. Any FOURTH caller belongs here, not in a third copy.
 *
 * Its callers, each measured end to end on its own child — the list is written
 * without a count because it grows, and a stale number beside it is the drift
 * AGENTS.md §Traps records: `agent/options.ts` `buildClaudeSubprocessEnv`
 * (P2.251), `agent/pi-agent.ts` `buildPiSubprocessEnv` (P2.259),
 * {@link buildShellChildNetworkEnv} (C3.382) and `auth/dp/internal.ts`
 * `dpExecEnv` (DA1.59), beside the codex twin named above. The Pi one is the
 * runtime whose failing state is a shipped DEFAULT: the local-model card's
 * endpoint placeholder is `http://localhost:11434`. The dp one is the child
 * that reaches the app's OWN auth host, and it is on this list for uniformity
 * rather than for a measured loopback destination — `dp` is pointed at
 * `as.tbank.ru`, never at a loopback URL, so the exemption is inert for it
 * today and stays true if that ever changes.
 *
 * WHY BOTH SPELLINGS OF THE VARIABLE NAME, now measured on two independent
 * readers rather than one: the claude binary reads `env.no_proxy ||
 * env.NO_PROXY` (P2.251), and Bun's native `fetch` — which routes the Pi
 * subprocess and reads the variables at launch — gives the same
 * lowercase-first precedence (P2.259: lower=loopback with
 * upper=`example.invalid` goes DIRECT, upper=loopback with
 * lower=`example.invalid` gets PROXIED). Writing only `NO_PROXY` is silently
 * overridden by any shell that exports the lowercase one.
 *
 * WHY BOTH SPELLINGS OF IPv6 LOOPBACK, which is a different axis and a
 * different measurement (P2.471, 2026-08-31): the three environments this
 * function and its codex twin write are parsed by TWO FAMILIES that disagree in
 * opposite directions, so the value carries `::1` AND `[::1]`. Per runtime, and
 * this is the whole reason the constant is a list rather than a preference:
 *
 * | subprocess | the parser that actually decides       | needs   |
 * | ---------- | ------------------------------------- | ------- |
 * | Pi         | Bun 1.3.14 native `fetch`             | `[::1]` |
 * | claude     | `proxy-from-env` 2.1.0, in the binary | `[::1]` |
 * | codex      | `hyper-util` 0.1.20 (`reqwest` 0.12.28) | `::1`  |
 *
 * The full six-implementation table, the one line of code on each side that
 * causes the split, and the dead-arm trap that made the predecessor rows
 * conclude the opposite are all on {@link LOOPBACK_NO_PROXY_HOSTS}. Nothing in
 * THIS function needed to change for it — it unions whatever that list holds,
 * which is exactly why the list is the only place the answer is written down.
 *
 * Blast radius, stated rather than papered over: this env is the child's, and is
 * inherited by everything the model launches through `Bash`, so a loopback
 * exemption propagates down that process tree. That is the same direction as the
 * rule itself — nothing in this repo wants a loopback destination proxied —
 * and `network-proxy-utils.ts` `shouldBypassProxy` still governs the host's own
 * requests, which this does not touch — and which exempts loopback nowhere
 * either. Measured (P2.259, not fixed here): with a Settings proxy enabled and
 * no `noProxy`, the host's own fetch of the local-model card's
 * `http://localhost:<port>/v1/models` lands on the proxy and the local server
 * gets nothing. That surface has two mechanisms (this resolver plus the
 * `process.env` projection in `network-runtime.ts`) and a blast radius covering
 * the app's whole egress, so it is a row of its own, not a line here.
 */
export function applyLoopbackProxyExemption(env: Record<string, string | undefined>): void {
  const proxied = PROXY_ENV_VARS.some((name) => (env[name] ?? '').trim() !== '');
  if (!proxied) return;

  const merged = extendNoProxyWithLoopback([env.NO_PROXY, env.no_proxy]);
  env.NO_PROXY = merged;
  env.no_proxy = merged;
}

/**
 * P6.255, the CHILDREN arm — an operator's proxy reaches the NODE processes a
 * subprocess env is handed to, on Node >= 24.
 *
 * ## The gap
 *
 * Node 24 stopped honouring `HTTP_PROXY`/`HTTPS_PROXY` in `fetch`/undici unless
 * `NODE_USE_ENV_PROXY` is set. The name scored **0 files** across `packages` +
 * `apps` when P6.255 measured it (positive control `NODE_EXTRA_CA_CERTS` -> 26
 * files; dead control `NODE_NOT_A_REAL_FLAG_XYZ` -> 0), so an administrator's
 * mandated proxy went quietly inert on every Node process this product's
 * children run.
 *
 * ## Which children, per runtime — and the Pi answer is NOT the codex one
 *
 * On codex the flag is not for `codex-app-server` itself (Rust, ignores it) but
 * for the Node children it launches from that env; that arm lives in
 * `packages/codex-agent-server/src/runtime-manager.ts` `applyNodeEnvProxy`,
 * which is a copy for the package-cycle reason
 * {@link applyLoopbackProxyExemption}'s docblock records.
 *
 * On **Pi the subprocess itself is BUN, not Node** — `resolveBundledRuntimeFile`
 * (`agent/backend/internal/runtime-resolver.ts`) resolves
 * `<resources>/vendor/bun/bun`, and the field is called `nodeRuntimePath` only
 * for historical reasons. Bun honours the proxy variables natively and reads
 * them at launch, which is the measurement `buildPiSubprocessEnv`'s own
 * docblock already carries. So the flag changes nothing for the Pi child, and
 * that is a fact worth stating rather than a reason to skip it: the env travels
 * on to every process the child spawns — every `Bash` tool command the model
 * runs, and any Node program among them — and those are the ones Node 24
 * silently un-proxied.
 *
 * On **`dp` the flag is inert, and that is MEASURED rather than assumed**
 * (DA1.59): the 1.39.0 release sitting's RS-43 B2 arm exported the proxy into
 * the app's environment with no `NODE_USE_ENV_PROXY` anywhere, and the child
 * was refused three times in 121 ms — so whatever `dp` is built from, it
 * honours `HTTP(S)_PROXY` without this flag. `auth/dp/internal.ts` `dpExecEnv`
 * calls it anyway, for the reason the Pi paragraph above gives: the cost is one
 * bounded line and the alternative is a child that diverges from every sibling
 * for no stated reason.
 *
 * ## Two bounds, so this is never a change nobody asked for
 *
 * Set ONLY when a proxy is actually configured, so a machine with no proxy gets
 * a byte-identical environment; and NEVER over a value that is already present,
 * so an operator who set `NODE_USE_ENV_PROXY` themselves — including to `0` —
 * keeps their decision.
 *
 * ## Order: after the loopback exemption, never before
 *
 * A Node child that starts honouring the proxy must not route a loopback
 * address through it. Every caller runs {@link applyLoopbackProxyExemption}
 * first, which has already extended both `NO_PROXY` spellings; the ordering at
 * the call sites is load-bearing rather than incidental.
 */
export function applyNodeEnvProxy(env: Record<string, string | undefined>): void {
  if (env.NODE_USE_ENV_PROXY !== undefined) return;
  const proxied = PROXY_ENV_VARS.some((name) => (env[name] ?? '').trim() !== '');
  if (!proxied) return;
  env.NODE_USE_ENV_PROXY = '1';
}

/**
 * Union any number of NO_PROXY values with the loopback hosts, in canonical
 * comma-joined form — the one merge every caller shares.
 *
 * EXTENDS, never replaces: whatever the inputs already carried comes first and
 * in order, de-duplicated case-insensitively, and the loopback hosts are
 * appended after. Extracted by P2.263 because a THIRD caller arrived
 * (`network-runtime.ts` `projectProxyEnv`, the host's own `process.env`), and
 * the P2.251 review had already flagged a third inline copy of this grammar as
 * the thing about to go wrong. `codex-agent-server`'s twin still carries its own
 * copy for the package-cycle reason its docblock records; these three do not.
 */
export function extendNoProxyWithLoopback(values: readonly (string | undefined)[]): string {
  const seen = new Set<string>();
  const entries: string[] = [];
  const add = (raw: string): void => {
    const entry = raw.trim();
    if (!entry) return;
    const key = entry.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  };
  for (const value of values) {
    for (const entry of splitNoProxyEntries(value)) add(entry);
  }
  for (const host of LOOPBACK_NO_PROXY_HOSTS) add(host);
  return entries.join(',');
}

/**
 * Network env projection for supervised plugin processes: proxy and CA only.
 * The mTLS client identity (cert/key paths and passphrase) deliberately does
 * NOT cross the plugin boundary — plugin processes run with an explicit
 * non-secret env baseline, and handing them the app's TLS identity would
 * let untrusted plugin code authenticate as the app.
 */
export function getPluginNetworkEnvVars(): Record<string, string> {
  return buildNetworkEnvVars(getNetworkProxySettings(), { excludeClientIdentity: true });
}

/**
 * Network env for a SUPERVISED SHELL CHILD — the process a Pi `bash` tool call
 * becomes, and every other child `handleProcessStartRequest` starts.
 *
 * C3.382, 2026-09-12. R7 measured the defect on the packaged 1.37.0 build
 * (RS-33 runs B and D): with the app's `networkProxy` enabled against a proxy
 * refusing everything, a Pi `Bash` call printed `curl_code=200` and
 * `node_out=NODE_REACHED 200` for a public host with ZERO lines for that host in
 * the proxy's own log, while the claude child in the SAME run was refused twice.
 *
 * THE CAUSE IS NOT THE ONE THE FINDING NAMED, and the difference is what decides
 * where the fix goes. The Pi SUBPROCESS already receives the whole projection —
 * `agent/pi-agent.ts` `buildPiSubprocessEnv` spreads `getProxyEnvVars()` and then
 * runs {@link applyLoopbackProxyExemption} and {@link applyNodeEnvProxy}. What
 * strips the names is one layer FURTHER DOWN, and it belongs to the host: a Pi
 * `bash` tool call is a host-run supervised process, and
 * `packages/server-core/src/pi-harness/process-supervisor.ts`
 * `isRestrictedHostEnvironmentKey` answers FALSE for every proxy and CA name
 * under the shipped default `restricted` profile — measured 2026-09-12, all
 * eight proxy spellings plus `NODE_USE_ENV_PROXY` and `NODE_EXTRA_CA_CERTS`
 * false, with `PATH` / `HOME` / `LC_ALL` / `NESSY_UV` true as the positive
 * controls and a made-up name false as the negative. So the ALLOWLIST, not the
 * Pi spawn env, is why the shell saw nothing — which is also why claude was
 * unaffected in the same run: its Bash child is spawned by the vendored binary
 * out of the claude child's own environment and never comes back to this host.
 *
 * WHY THE START REQUEST AND NOT THE ALLOWLIST. The supervisor merges a start
 * request's `env` OVER the selected host environment, so a name delivered here
 * arrives whatever the profile. An allowlist entry could not do the same job
 * twice over: it would forward the HOST process's value and so miss the in-app
 * Settings proxy entirely, and `hostEnvironment` reads
 * `Object.entries(process.env)` — the one read a runtime-ASSIGNED proxy name is
 * invisible to under Bun (AGENTS.md §Traps, the pre-created-slot family, which
 * is exactly these names). Everything below is read BY PROPERTY or resolved from
 * the stored settings, so neither miss is reachable from here.
 *
 * WHAT CROSSES, and what deliberately does not:
 * - the proxy names in both spellings, ambient AND Settings, with Settings
 *   winning — the same precedence `buildPiSubprocessEnv` gives them;
 * - `NODE_EXTRA_CA_CERTS`, because a TLS-INSPECTING proxy without the trust
 *   chain turns this fix into a certificate error on every `curl` the model
 *   runs. The operator's own ambient value is carried too: {@link
 *   buildNetworkEnvVars} omits that one on purpose so an INHERITED value passes
 *   through, and a supervised child inherits nothing;
 * - `NODE_USE_ENV_PROXY`, after the loopback exemption and never before, for the
 *   reasons those two functions' own docblocks give — including an operator's
 *   ambient `0`, carried so {@link applyNodeEnvProxy} still declines to overwrite
 *   a decision the operator made;
 * - NOT the mTLS client identity. `excludeClientIdentity` is passed for the
 *   reason {@link getPluginNetworkEnvVars} passes it, only more so: the command
 *   running in this child is written by the MODEL, and the app's TLS identity —
 *   with its key passphrase — must not be readable from inside it.
 *
 * BOUND: with no proxy in effect this returns `{}` and the child's environment
 * is byte-identical to today's, the same bound {@link applyLoopbackProxyExemption}
 * sets, so no machine without a proxy changes in any way.
 *
 * STATED RESIDUE (C3.382, deliberately not fixed here): that bound also means a
 * corporate CA with NO proxy configured still does not reach a shell child,
 * though {@link buildNetworkEnvVars} emits it for the app's other children. That
 * is a row of its own rather than a line here, because lifting the bound would
 * change every shell child on every machine that ships a bundled CA, which is a
 * far wider blast radius than the finding this function closes.
 */
export function buildShellChildNetworkEnv(options: {
  processEnv?: Record<string, string | undefined>;
  /** Test seam; defaults to the stored settings, like {@link getProxyEnvVars}. */
  settings?: NetworkProxySettings | undefined;
} = {}): Record<string, string> {
  const processEnv = options.processEnv ?? process.env;
  const settings = 'settings' in options ? options.settings : getNetworkProxySettings();

  const env: Record<string, string> = {};
  // BY PROPERTY, never a spread and never `in`: both lie for exactly these names
  // under Bun when the host itself assigned one (AGENTS.md §Traps).
  const carry = (name: string): void => {
    const value = processEnv[name];
    if (value !== undefined && value.trim() !== '') env[name] = value;
  };
  for (const name of PROXY_ENV_VARS) carry(name);
  carry('NO_PROXY');
  carry('no_proxy');
  carry('NODE_EXTRA_CA_CERTS');
  carry('NODE_USE_ENV_PROXY');

  Object.assign(env, buildNetworkEnvVars(settings, { processEnv, excludeClientIdentity: true }));

  if (!PROXY_ENV_VARS.some((name) => (env[name] ?? '').trim() !== '')) return {};

  applyLoopbackProxyExemption(env);
  applyNodeEnvProxy(env);
  return env;
}

// F1.563 (P-WJax-1) — the managed tier of the client identity: when a managed
// `env` block names it, `buildNetworkEnvVars` projects NO identity, so the
// inherited (managed) values reach the child, as they reach the host hop on both
// hosts (`network-mtls.ts` holds the one rule). Imported down here, not at the
// top, so the ledger-cited lines above keep their numbers; an ES import is
// hoisted wherever it is written.
import { managedClientIdentityNamed } from './network-mtls.ts';
