/**
 * Spawns and tears down the bundled codex app-server subprocess.
 *
 * Transport: stdio is the default (`--listen stdio://`); the standalone
 * `codex-app-server` binary does NOT accept a `--stdio` flag (only the full
 * `codex app-server` subcommand does), so we spawn with no transport arg.
 *
 * Teardown mirrors `pi-agent.ts` killSubprocess: SIGTERM, then SIGKILL after a
 * grace window.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { verifyCodexBinary } from './manifest-verifier.ts';

/**
 * The proxy variables the bundled binary honours. Measured on
 * `darwin-arm64/codex-app-server` (rust): all six are read by
 * `codex_http_client::route_aware_client_pool`, whose `outbound_proxy_policy`
 * classifies each route and applies them per class.
 */
const PROXY_ENV_VARS = [
  'HTTP_PROXY', 'http_proxy',
  'HTTPS_PROXY', 'https_proxy',
  'ALL_PROXY', 'all_proxy',
] as const;

/**
 * Loopback spellings a NO_PROXY value must carry for the exemption to hold.
 *
 * The bare-list twin of `LOOPBACK_NO_PROXY_HOSTS` in
 * `packages/shared/src/config/network-proxy-utils.ts`, copied for the
 * package-cycle reason `applyLoopbackNoProxy` records below. The two must stay
 * identical: the shared docblock carries the measured six-implementation table,
 * and a divergence here is invisible from there.
 *
 * IPv6 LOOPBACK IS SPELLED TWICE, and for this binary only ONE of the two is
 * the working entry (P2.471, measured 2026-08-31 against the exact crate
 * versions named in the shipped artifact — `strings` on
 * `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server` reports
 * `reqwest-0.12.28`, `hyper-util-0.1.20`, `ipnet-2.11.0` and
 * `client/proxy/matcher.rs`):
 *
 * | no_proxy entry | url                | hyper-util 0.1.20 `Matcher::intercept` |
 * | -------------- | ------------------ | -------------------------------------- |
 * | `::1`          | `http://[::1]:9/`  | BYPASSED                               |
 * | `[::1]`        | `http://[::1]:9/`  | **proxied — no bypass**                |
 * | `` (control)   | `http://[::1]:9/`  | proxied, so the arm is not a dead one  |
 *
 * `NoProxy::from_string` parses each entry with `part.parse::<IpNet>()` then
 * `part.parse::<IpAddr>()` and files the failures under domains; `contains`
 * strips the brackets off the URL host, parses THAT as an address, and then
 * consults the IP list only. So `[::1]` lands in a domain list that an IP host
 * never reaches. codex needs the BARE spelling.
 *
 * The bracketed one is here anyway, and is not decoration: this env is
 * inherited by everything the sandboxed model launches, and Bun-, Node- and
 * `proxy-from-env`-based children accept only `[::1]` (the exact reverse). It
 * was measured inert for this binary rather than assumed so — with the full
 * four-entry value, `127.0.0.1`, `localhost` and `[::1]` all bypass and
 * `models.example.com` still goes through the proxy.
 */
const LOOPBACK_NO_PROXY_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'] as const;

/**
 * Exempt loopback from an inherited HTTP proxy — and ONLY when a proxy is
 * actually configured, so a session with no proxy keeps a byte-identical env.
 *
 * WHY THIS IS NOT OPTIONAL (measured 2026-08-27, three arms, same rig,
 * `packages/codex-agent-server/src/spike.ts` + a loopback sink proxy):
 *
 * | proxy env            | NO_PROXY            | outcome                      |
 * | -------------------- | ------------------- | ---------------------------- |
 * | absent               | —                   | turn/completed, 0 proxy hits |
 * | set                  | absent              | turn FAILED                  |
 * | set                  | loopback exempted   | turn/completed               |
 *
 * The middle row is the shipped default on macOS: `loadShellEnv`
 * (`apps/electron/src/main/shell-env.ts`) copies the ENTIRE login-shell
 * environment into `process.env`, skipping only `VITE_*`, and this spawn
 * spreads `process.env` — so a `HTTPS_PROXY` exported in a corporate user's
 * `.zshrc` reaches codex whether or not anything here projects it. Every URL we
 * configure codex with is loopback by construction (`base_url` = the in-process
 * responses adapter, `[mcp_servers.sources]` = `McpPoolServer` on 127.0.0.1),
 * so without this exemption codex POSTs its own model traffic AT the corporate
 * proxy and the turn dies with `stream disconnected before completion: error
 * sending request for url (http://127.0.0.1:<port>/v1/responses)`.
 *
 * THIS FUNCTION HAS A TWIN, and edits belong on both sides:
 * `applyLoopbackProxyExemption` in `packages/shared/src/config/proxy-env.ts`,
 * which carries the same rule for every spawn site inside `@nessy-agent/shared`
 * — the Claude subprocess (`agent/options.ts`, P2.251) and the Pi subprocess
 * (`agent/pi-agent.ts` `buildPiSubprocessEnv`, P2.259). That file's docblock
 * names this one; this line is the reciprocal pointer, owed since P2.251 and
 * paid by P2.259. A FOURTH caller belongs in the shared helper, not in a third
 * copy. Still unexempted, and rowed rather than fixed: the HOST's own requests,
 * routed by `network-proxy-utils.ts` `shouldBypassProxy` (`rules.length === 0 →
 * false`) from `config/network-runtime.ts` and
 * `apps/electron/src/main/network-proxy.ts`.
 *
 * Codex's own non-loopback traffic (measured: `chatgpt.com:443`,
 * `github.com:443`, `api.github.com:443`) keeps going through the proxy —
 * that is what makes this an exemption rather than a `no_proxy=*` opt-out.
 *
 * C3.253 · AND THAT LIST IS THE WHOLE INVENTORY, so it is worth saying what was
 * behind it, because ALL THREE names came from one subsystem and it is now off.
 * They are codex's plugin startup, which ran on every session start before a
 * single token: `api.github.com` and `github.com/openai/plugins.git` for the
 * curated-marketplace clone into `CODEX_HOME/.tmp/plugins-clone-*` (25 plugin
 * directories, tens of MB, into a home this product deletes at teardown),
 * `chatgpt.com/backend-api/plugins/featured` for the featured-plugin ids, and
 * `chatgpt.com/backend-api/plugins/export/curated` as the clone's fallback.
 * Every one is inside `if config.plugins_enabled {` in
 * `core-plugins/src/manager.rs`'s `maybe_start_plugin_startup_tasks_for_config`
 * (`rust-v0.150.1`), so `buildCodexConfigToml` now writes `[features] plugins =
 * false` and `config-writer-plugin-egress-live.test.ts` drives both arms against
 * the shipped binary behind a refusing loopback proxy sink.
 *
 * What remains after that key, and what an operator's proxy therefore still
 * sees from a codex child: the `[analytics]` events endpoint (already closed by
 * `enabled = false`, same writer), codex's Statsig metrics exporter (`ab.chatgpt.com`,
 * off for this binary — `main.rs` passes `false`), and anything a user's own
 * stdio MCP server or a model-issued shell command reaches. The MODEL traffic
 * is loopback by construction, which is the paragraph above. Keep this list
 * true: it is the only place in the tree that enumerates what a codex child
 * talks to.
 *
 * The `/[\s,]+/` grammar is the inline twin of `splitNoProxyEntries`
 * (`packages/shared/src/config/network-proxy-utils.ts`); it is copied rather
 * than imported because `@nessy-agent/shared` already imports THIS package
 * (`shared/src/agent/codex-agent.ts`) and the import would close a cycle. The
 * next separator change must touch both.
 */
function applyLoopbackNoProxy(env: Record<string, string | undefined>): void {
  const proxied = PROXY_ENV_VARS.some((name) => (env[name] ?? '').trim() !== '');
  if (!proxied) return;

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
  // The user's own rules first, both documented spellings, so an existing
  // NO_PROXY is EXTENDED and never replaced.
  for (const value of [env.NO_PROXY, env.no_proxy]) {
    for (const entry of (value ?? '').split(/[\s,]+/)) add(entry);
  }
  for (const host of LOOPBACK_NO_PROXY_HOSTS) add(host);

  const merged = entries.join(',');
  env.NO_PROXY = merged;
  env.no_proxy = merged;
}

/**
 * P6.255 (children arm) — the codex child's own NODE children honour the proxy
 * again on Node >= 24.
 *
 * ## The gap
 *
 * Node 24 stopped honouring `HTTP_PROXY`/`HTTPS_PROXY` in `fetch`/undici unless
 * `NODE_USE_ENV_PROXY` is set. `NODE_USE_ENV_PROXY` scored **0 files** across
 * `packages` + `apps` when P6.255 measured it (positive control
 * `NODE_EXTRA_CA_CERTS` -> 26 files; dead control `NODE_NOT_A_REAL_FLAG_XYZ` ->
 * 0), so an operator's proxy went quietly inert on every Node child this product
 * spawns.
 *
 * ## Why this file, when the codex binary is Rust
 *
 * The row named a `buildCodexSubprocessEnv` that does not exist; codex's env is
 * assembled here. And the flag is not for `codex-app-server` itself, which is
 * Rust and ignores it — it is for the NODE children codex spawns from this env:
 * `[mcp_servers.session]` is a `command`/`args` entry launching the bundled
 * `node`, and any stdio MCP server an operator configures may be one too. Those
 * inherit exactly this object.
 *
 * ## Native-first, MEASURED on the shipped binary (2026-09-07)
 *
 * codex already knows this name: `NODE_USE_ENV_PROXY` occurs **2** times in
 * `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server` (controls on
 * the same scan: `HTTPS_PROXY` 23, `CODEX_HOME` 36), both inside codex's OWN
 * network-proxy env lists — beside `ELECTRON_GET_USE_PROXY`, `YARN_HTTP_PROXY`,
 * `npm_config_http_proxy` and the rest — which codex applies to children it
 * launches under `CODEX_NETWORK_PROXY_ACTIVE`. So the mechanism exists and codex
 * uses it, for its OWN proxy. It does nothing for the host operator's proxy when
 * codex's network proxy is not active, which is the ordinary case here.
 *
 * ## Only when a proxy is actually configured, and never over an explicit value
 *
 * A machine with no proxy gets a byte-identical environment: setting the flag
 * there would change nothing and would still be a change nobody asked for. And
 * an operator who set `NODE_USE_ENV_PROXY` themselves — including to `0` —
 * decided this already, so a present value is never overwritten.
 *
 * ## Safe HERE specifically, because the loopback exemption already ran
 *
 * A Node child that starts honouring the proxy must not route the in-process
 * adapter's loopback port through it. {@link applyLoopbackNoProxy} runs FIRST
 * and has already extended both `NO_PROXY` spellings with `localhost`,
 * `127.0.0.1`, `::1` and `[::1]` — its own docblock records the three-arm
 * measurement — so the ordering of the two calls at the spawn site is
 * load-bearing rather than incidental.
 */
function applyNodeEnvProxy(env: Record<string, string | undefined>): void {
  if (env.NODE_USE_ENV_PROXY !== undefined) return;
  const configured = [
    env.HTTP_PROXY, env.http_proxy,
    env.HTTPS_PROXY, env.https_proxy,
    env.ALL_PROXY, env.all_proxy,
  ].some(value => typeof value === 'string' && value.trim().length > 0);
  if (!configured) return;
  env.NODE_USE_ENV_PROXY = '1';
}

/**
 * The ONLY two variables the binary's own trust store reads, in its own
 * precedence order. Codex-specific first, OpenSSL convention second.
 */
const CODEX_CA_CERT_ENV = 'CODEX_CA_CERTIFICATE';
const CODEX_CA_FALLBACK_ENV = 'SSL_CERT_FILE';

/**
 * Hand codex the app's extra CA file under the name its trust store actually
 * reads — the other half of the `NODE_EXTRA_CA_CERTS` bullet below, which
 * diagnosed this gap (P2.213) and left it open.
 *
 * VERIFIED AGAINST THE SOURCE AND THE SHIPPED BINARY, not the documentation
 * page — this runtime's docs have been measured contradicting its own binary
 * twice, and this path is TLS. `openai/codex`
 * `codex-rs/http-client/src/custom_ca.rs` (fetched 2026-08-28) is the whole
 * contract, and every clause below is also present in
 * `darwin-arm64/codex-app-server` as a string:
 *
 *  - NAME. `pub const CODEX_CA_CERT_ENV: &str = "CODEX_CA_CERTIFICATE";` and
 *    `pub const SSL_CERT_FILE_ENV: &str = "SSL_CERT_FILE";`. Nothing else is
 *    consulted: with neither set the module logs "using system root
 *    certificates because no CA override environment variable was selected".
 *    `NODE_EXTRA_CA_CERTS` appears in the binary only inside the env list its
 *    OWN MITM proxy injects into sandboxed children — never in `custom_ca`.
 *  - VALUE SHAPE. A filesystem PATH to a PEM file, not PEM text and not a
 *    directory: `non_empty_path()` maps the value straight to a `PathBuf`, and
 *    the binary's user-facing hint is "If you set CODEX_CA_CERTIFICATE or
 *    SSL_CERT_FILE, ensure it points to a PEM file containing one or more
 *    CERTIFICATE blocks, or unset it to use system roots." (`SSL_CERT_DIR` is
 *    in the binary, but only inside `rustls-native-certs`' platform loader —
 *    codex's own override has no directory form.)
 *  - EMPTY IS UNSET. `.filter(|value| !value.is_empty())` — so `VAR=""` is not
 *    a path lookup, and we never emit one either.
 *  - PRECEDENCE. `configured_ca_bundle()` reads `CODEX_CA_CERTIFICATE` and only
 *    `.or_else()` falls back to `SSL_CERT_FILE`; its docblock says
 *    "`CODEX_CA_CERTIFICATE` wins over `SSL_CERT_FILE` because it is the
 *    Codex-specific override."
 *  - ADDITIVE, so this cannot cost a user who is NOT behind interception
 *    anything: both builders start from the platform roots
 *    (`rustls_native_certs::load_native_certs()`, and reqwest's built-in roots)
 *    and `add_root_certificate` / `root_store.add` the bundle ON TOP.
 *
 * WHICH IS WHY THIS ONLY EVER FILLS A GAP. Codex loads exactly ONE bundle, so
 * writing `CODEX_CA_CERTIFICATE` over an operator's `SSL_CERT_FILE` would not
 * add trust — it would REPLACE that operator's bundle with ours and silently
 * drop whatever only theirs carried. So a non-empty value in EITHER variable is
 * left exactly as it stands (empty string checked the way codex checks it, no
 * trim), and we write only when codex would otherwise have had no override at
 * all. That is strictly additive to the shipped behaviour, which is to set
 * neither.
 */
function applyCodexCaCertificate(
  env: Record<string, string | undefined>,
  caCertificatePath: string | undefined,
): void {
  if (!caCertificatePath) return;
  for (const name of [CODEX_CA_CERT_ENV, CODEX_CA_FALLBACK_ENV]) {
    if ((env[name] ?? '') !== '') return;
  }
  env[CODEX_CA_CERT_ENV] = caCertificatePath;
}

/**
 * The daemon marker that starts the app-server with remote control OFF.
 *
 * Exact name and exact value, read from `openai/codex` at the tag this repo
 * pins (`rust-v0.148.0`, `packages/codex-protocol/manifest.json`), file
 * `codex-rs/app-server-transport/src/transport/remote_control/mod.rs`:
 *
 *     pub const REMOTE_CONTROL_DISABLED_ENV_VAR: &str =
 *         "CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED";
 *
 *     pub fn take_remote_control_disabled_env() -> bool {
 *         let disabled = std::env::var_os(REMOTE_CONTROL_DISABLED_ENV_VAR)
 *             .is_some_and(|value| value == "1");
 *         unsafe { std::env::remove_var(REMOTE_CONTROL_DISABLED_ENV_VAR) };
 *         disabled
 *     }
 *
 * The value must be the single character `1`: `is_some_and(|value| value ==
 * "1")` accepts nothing else, so `true`, `yes` and the empty string are all
 * "not disabled" and would leave the posture stated in this file and absent
 * from the process.
 */
const REMOTE_CONTROL_DISABLED_ENV = 'CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED';
const REMOTE_CONTROL_DISABLED_VALUE = '1';

/**
 * P2.381 — EXPLICITLY DISABLE codex's remote-control transport (owner ruling
 * 2026-09-01).
 *
 * ## What was unowned
 *
 * We ship a binary that carries a remote-control transport (pairing codes, a
 * `remote_control_url`, `remoteControl/*` requests and a
 * `remoteControl/status/changed` notification) and we neither turned it on nor
 * turned it off — so what the shipped app did was whatever the binary defaults
 * to, which nobody had measured. A default nobody chose is not a posture, and it
 * is the one option that cannot be defended to an operator.
 *
 * ## What the default actually is (measured, strong tier)
 *
 * Source at `rust-v0.148.0` — the tag `packages/codex-protocol/manifest.json`
 * pins for the binary in `apps/electron/resources/bin/codex/` — plus the string
 * in that binary (`CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED` present;
 * positive controls `CODEX_HOME` 34, `CODEX_CA_CERTIFICATE` 6; negative control
 * `nessyWorktreeCreate` 0):
 *
 *  - `codex-rs/app-server/src/main.rs` maps `(--remote-control, env)` to a
 *    startup mode: `(false, true) => DisabledEphemeral`, and with NEITHER set
 *    `(false, false) => ResolvePersisted`.
 *  - `RemoteControlPolicy` derives `#[default] Allowed`; only a managed
 *    `requirements.toml` carrying `allow_remote_control = false` yields
 *    `DisabledByRequirements`, and that file is the administrator's — we read it
 *    and never write it, so we cannot reach the policy lever without forging
 *    managed policy.
 *  - `start_remote_control` turns `ResolvePersisted` into
 *    `RemoteControlDesiredState::Unknown` and `DisabledEphemeral` into
 *    `Disabled`. Under stdio (our transport) the startup path does not resolve
 *    the persisted preference immediately, so the default is not "connected on
 *    boot" — it is "the persisted preference still governs, and the transport is
 *    live enough to be turned on".
 *
 * ## Why disabling is the parity answer, not merely the cautious one
 *
 * Pi and claude have no such transport at all. Setting the marker makes all
 * three runtimes identical, so the divergence DISAPPEARS instead of being
 * masked — the opposite of what enabling would have done, which is a feature
 * with an attack surface on exactly one runtime of three.
 *
 * ## Scope, stated so it is not read as more than it is
 *
 * The marker is a STARTUP marker: it sets the initial desired state and codex
 * `remove_var`s it before worker threads start. It is not a policy lock — the
 * hard lock is `allow_remote_control = false` in managed `requirements.toml`,
 * which is the administrator's to set and which `codex-config-requirements.ts`
 * already classifies as codex-enforced. This is the strongest lever a host can
 * pull without forging managed policy, and it is applied unconditionally rather
 * than behind a setting, because "off on every runtime" is the posture and a
 * knob would reintroduce the divergence it removes.
 *
 * ## Where an operator sees it
 *
 * `nessy-general-agent doctor` prints a "Codex remote control:" section naming
 * this variable, its value and the default it replaces
 * (`apps/cli/src/doctor.ts`); `--json` carries the same under
 * `codexRemoteControl`. A disable an operator cannot verify is indistinguishable
 * from an undocumented default, which is the class this row was opened against.
 * The name and value are spelled there a second time — `apps/cli` does not
 * depend on this package — and the two spellings are pinned together by
 * `__tests__/runtime-manager.test.ts`.
 */
function applyRemoteControlDisabled(env: Record<string, string | undefined>): void {
  // Unconditional, and it deliberately overwrites an inherited value: an
  // ambient `…_DISABLED=0` in the launching shell would otherwise re-open the
  // transport this app states is closed.
  //
  // `delete` before assign, and not as a style: assigning to a name Bun
  // pre-creates a slot for leaves it readable by property and INVISIBLE to the
  // `{...process.env}` spread this very function's env object is built from
  // (AGENTS.md, measured 2026-09-01) — the child would get nothing while the
  // parent still read the value. Applied here to a plain object for the same
  // reason it is applied to `process.env`: the rule is unconditional because a
  // name-based exemption list cannot be complete.
  delete env[REMOTE_CONTROL_DISABLED_ENV];
  env[REMOTE_CONTROL_DISABLED_ENV] = REMOTE_CONTROL_DISABLED_VALUE;
}

export interface RuntimeSpawnOptions {
  /** Absolute path to the bundled codex-app-server binary. */
  binaryPath: string;
  /** Working directory for the subprocess. */
  cwd: string;
  /** Managed CODEX_HOME (config.toml lives here). */
  codexHome: string;
  /** Extra env (e.g. the provider API key env var). */
  env?: Record<string, string>;
  /** Extra CLI args. Codex spawns with none (stdio is the default transport). */
  args?: string[];
  /**
   * Platform dir (`darwin-arm64`, …) for the pre-spawn SHA verification against
   * the codex manifest. When set, the binary is verified before spawn and a
   * mismatch aborts. Omit for test stubs that spawn a non-codex executable.
   */
  platformDir?: string;
  /**
   * The extra CA file the app hands its other subprocesses as
   * `NODE_EXTRA_CA_CERTS`, re-badged for codex as `CODEX_CA_CERTIFICATE` —
   * the one name its trust store reads. A PATH to a PEM bundle; see
   * `applyCodexCaCertificate` for the source-verified contract and for why an
   * operator's own `CODEX_CA_CERTIFICATE`/`SSL_CERT_FILE` is never displaced.
   * Omit to leave the child's trust store exactly as it is inherited.
   */
  caCertificatePath?: string;
}

/**
 * How long to wait for `exit` AFTER SIGKILL before giving up on the child.
 *
 * P3.376 — until 2026-09-04 there was no such bound: `kill()` awaited `exit`
 * forever, and SIGKILL is best-effort (a child in uninterruptible sleep, or one
 * whose parent cannot signal it, never fires the event). `cleanupRuntimeResources`
 * awaits this step with no deadline of its own, so the failure mode was a runtime
 * switch that never completed and printed nothing — strictly worse than the
 * refusal P3.341 debates, because a refusal is legible.
 *
 * Set against the measured floor rather than at zero: the SIGTERM grace is 3 s
 * and a healthy child exits in milliseconds, so 2 s past SIGKILL is orders of
 * magnitude of headroom for a process that is going to die at all. Total bound
 * is `graceMs + KILL_HARD_DEADLINE_MS`.
 */
const KILL_HARD_DEADLINE_MS = 2000;

/** The named terminal reason a bounded kill reports, so a caller can match it. */
export const CODEX_KILL_TIMEOUT_PREFIX = 'codex-runtime-kill-timeout: ';

export class CodexRuntimeManager {
  private child: ChildProcessWithoutNullStreams | null = null;

  spawn(opts: RuntimeSpawnOptions): ChildProcessWithoutNullStreams {
    if (this.child) throw new Error('codex runtime already spawned');
    // Pre-spawn SHA gate: never launch an unverified codex binary. Skipped when
    // no platformDir is given (test stubs spawn a non-codex executable).
    if (opts.platformDir) {
      verifyCodexBinary(opts.binaryPath, opts.platformDir);
    }
    // NO `getProxyEnvVars()` HERE, and that is a decision, not an omission
    // (P2.213, measured 2026-08-27 — re-read before "fixing" it):
    //
    //  - PROXY. **C3.369 (2026-09-12) discharged this bullet's own condition,
    //    and the projection now happens — one caller up.** The bullet said the
    //    projection "would add only the in-app Settings proxy — and adding it is
    //    a REGRESSION unless loopback is exempted first, which is what
    //    `applyLoopbackNoProxy` does". Loopback IS exempted first: the helper
    //    `buildShellChildNetworkEnv` exempts it inside its own result, and
    //    `applyLoopbackNoProxy` below then runs over the MERGED env, which is
    //    also what supplies the bare `::1` spelling this binary needs. So the
    //    Settings proxy is spread into `opts.env` by
    //    `packages/shared/src/agent/codex-agent.ts`'s spawn literal, for the
    //    cycle reason the `SESSION_JOB_DIR` bullet there gives: this package
    //    cannot import `@nessy-agent/shared`. Nothing moved HERE, and the
    //    three-arm measurement in `applyLoopbackNoProxy`'s docblock is why the
    //    order below is not negotiable.
    //  - NODE_EXTRA_CA_CERTS (the bundled `tinkoff-bundle.crt`). INERT here.
    //    The binary's own trust store reads exactly two variables —
    //    `CODEX_CA_CERTIFICATE` and `SSL_CERT_FILE` — and otherwise logs
    //    "using system root certificates because no CA override environment
    //    variable was selected" (`codex_http_client::custom_ca`). It does
    //    carry `NODE_EXTRA_CA_CERTS`, but only in the list its OWN MITM proxy
    //    injects into sandboxed children. So behind TLS interception codex
    //    trusts the OS store or nothing; handing it our Node-shaped variable
    //    changes nothing. That gap is real and needs `CODEX_CA_CERTIFICATE`,
    //    not this projection — which is now `opts.caCertificatePath` and
    //    `applyCodexCaCertificate` below, closing the gap this bullet named.
    //    Still not the projection: the caller reads ONE key out of it and the
    //    child is handed one re-badged path, never the proxy triple.
    //  - CLAUDE_CODE_CLIENT_CERT / _KEY / _KEY_PASSPHRASE. Zero occurrences in
    //    the binary (positive control on the same scan: `CODEX_HOME` 34,
    //    `OPENAI_API_KEY` 16). Projecting them would hand a third-party binary
    //    an mTLS key passphrase it provably never reads — secret surface for
    //    no behaviour.
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...opts.env,
      CODEX_HOME: opts.codexHome,
    };
    applyLoopbackNoProxy(env);
    // P6.255 · AFTER the loopback exemption, never before — see the docblock.
    applyNodeEnvProxy(env);
    applyCodexCaCertificate(env, opts.caCertificatePath);
    applyRemoteControlDisabled(env);
    const child = spawn(opts.binaryPath, opts.args ?? [], {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    return child;
  }

  get process(): ChildProcessWithoutNullStreams | null {
    return this.child;
  }

  /**
   * Graceful SIGTERM, then SIGKILL after `graceMs`, then GIVE UP after
   * {@link KILL_HARD_DEADLINE_MS} with a named error.
   *
   * Rejecting rather than resolving is deliberate and is not a new policy: the
   * caller (`cleanupRuntimeResources`) already wraps a failed step and refuses
   * the runtime switch through the machinery P3.341 built, so this turns an
   * unbounded HANG into the refusal that path already knows how to report. A
   * silent resolve would hide a leaked child process instead.
   *
   * ## D1.154 — this bound is also a CLI exit code, which is not obvious from here
   *
   * The headless CLI's SIGTERM handler awaits its `cleanup()` — destroy the RPC
   * client, then stop the spawned server — and only then calls
   * `process.exit(signalExitCode(signal))`, which is 143. Stopping the server
   * reaches THIS method, so on a codex session that handler is awaiting up to
   * `graceMs` + {@link KILL_HARD_DEADLINE_MS} = **5 s** of child teardown.
   *
   * Its own `client.destroy()`, on the line above, meanwhile releases
   * `sendAndStream`'s wait loop in the MAIN path, which reaches its own
   * `process.exit` in milliseconds. So the two exits race and the signal
   * handler is structurally last, by seconds rather than by a hair — which is
   * how a codex run reported an exit code that was never `signalExitCode`'s.
   * C3.103 already stopped the losing value being **0** (`sendAndStream` now
   * answers 1 for a turn that did not finish), so what survives is a run that
   * exits 1 where the CLI's own contract, and pi and claude, say 143.
   *
   * **The fix is not here.** Slowing this teardown down would be the wrong end,
   * and speeding it up would trade a correct exit code for a leaked child. The
   * CLI has to stop racing its own handler — one flag, in
   * `apps/cli/src/index.ts`, handed to that file's owner with the diff. This
   * paragraph exists so the next reader of a five-second teardown knows what
   * else is waiting on it. **Not claimed, because it was not measured: why pi
   * and claude deliver 143 on the same rig.** Their teardown is the same shape
   * (this file's header says so), so the asymmetry is a timing reading nobody
   * has taken, not a contract difference.
   */
  async kill(graceMs = 3000): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(deadline);
        resolve();
      };
      child.once('exit', done);
      const timer = setTimeout(() => {
        if (!settled && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, graceMs);
      const deadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener('exit', done);
        reject(new Error(
          `${CODEX_KILL_TIMEOUT_PREFIX}pid ${child.pid ?? 'unknown'} did not exit within `
          + `${graceMs + KILL_HARD_DEADLINE_MS}ms (SIGTERM then SIGKILL); the child is abandoned`,
        ));
      }, graceMs + KILL_HARD_DEADLINE_MS);
      child.kill('SIGTERM');
    });
  }
}
