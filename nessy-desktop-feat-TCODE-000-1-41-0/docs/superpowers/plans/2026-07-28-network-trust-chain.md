# R26 — the harness's own network trust chain

**Status:** EXECUTED — close-out below (2026-07-28)
**Parity row:** R26 (Ord 9); blocks R25b
**Branch:** `fix/renderer`
**Base:** `6b5b0bd5`

## Contract source — quoted from raw markdown, with line cites

`curl -sL https://code.claude.com/docs/en/network-config.md` (177 lines).
**Fetch it yourself and re-read every line I cite.** This series shipped a wire
contract with three of four field names wrong because a plan and then an executor
each trusted a `WebFetch` summary instead of the page; that tool reconstructs
"verbatim" text rather than returning it.

`:56` — the CA store, and the sentence that matters most for a bank fork:

> By default, Claude Code trusts both its bundled Mozilla CA certificates and
> your operating system's certificate store. … Enterprise TLS-inspection proxies
> such as CrowdStrike Falcon and Zscaler work without additional configuration
> when their root certificate is installed in the OS trust store and the runtime
> can read it.

> `CLAUDE_CODE_CERT_STORE` accepts a comma-separated list of sources. Recognized
> values are `bundled` for the Mozilla CA set shipped with Claude Code and
> `system` for the operating system trust store. The default is `bundled,system`.

Reading the OS store needs a runtime with `tls.getCACertificates`.

`:78` — a custom CA is `NODE_EXTRA_CA_CERTS=/path/to/ca-cert.pem`.

`:86` — mTLS:

> `CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY`, and optional
> `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE`

> Claude Code reads the certificate and key files at startup and **re-reads them
> each time it applies settings, including when settings change during a
> session. To rotate the certificate and key, replace the files at the same
> paths.**

`:114` — **the scope rule, which is a security property, not a convenience.** In
sessions where the app manages the provider connection, the proxy and TLS
variables are read only from managed settings and the user's own settings file:

> it ignores them in a repository's own settings files, so a checked-out
> repository can't redirect the TLS or proxy path of a session whose credentials
> come from the app.

`:37` — "Claude Code does not support SOCKS proxies." `:120` — network variables
belong in the settings `env` block rather than a shell export, because a
background supervisor inherits whichever shell happened to start it first.

## Verified state on HEAD — the row understates what we have

The audit row says "Nothing in the audit mentions CA bundles or mTLS". Half
right. Before planning anything, read these:

- `packages/shared/src/config/types.ts:17` — `NetworkProxySettings` already
  carries `httpProxy`, `httpsProxy`, `noProxy`, **`tlsCaPath`** and
  **`useBundledCa`**.
- `apps/electron/src/main/network-proxy.ts` — a real `ProtocolProxyDispatcher`
  over undici with `setGlobalDispatcher`, per-protocol `ProxyAgent`s, `NO_PROXY`
  bypass, **and** the resolved CA passed as `ca:` (`:123`); plus the Electron
  session proxy for the browser pane.
- `apps/electron/src/main/network-tls-ca.ts` — `resolveTlsCaRuntime` reads a CA
  file and reports a warning when it cannot.
- `packages/shared/src/config/proxy-env.ts` — projects **only** the three proxy
  variables into subprocess env; no CA, no client certificate.
- `packages/shared/src/unified-network-interceptor.ts:61` — the Pi subprocess
  re-derives the proxy from `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` env.

So proxying is real and CA is partly real. The gaps below are what is left.

## Tasks

### Task 1 — trust the OS certificate store, and make the source list explicit

Today the CA runtime resolves a *file*. Nothing reads the operating system trust
store, so a corporate TLS-inspecting proxy whose root is installed in the OS
store — the normal enterprise deployment, and the case `:56` calls out by name as
needing no configuration — is not trusted unless someone exports a PEM by hand.

Implement the documented composition: sources `bundled` and `system`, default
**both**. Read the OS store through `tls.getCACertificates` where the runtime has
it, and degrade to bundled-plus-custom with a *reported* warning where it does
not (Electron's bundled Node version decides this — check it, do not assume).

Keep the existing settings working: `useBundledCa` and `tlsCaPath` must keep
their current meaning, and a config that sets neither must behave the same as
today plus the OS store. Say in the commit body how the boolean maps onto the
two-source list, and whether you added a settings key for the list or derived it.

**Commit:** `feat(network): trust the OS certificate store alongside the bundled set`

### Task 2 — mTLS client certificates

Client certificate, private key, optional passphrase. Applied to the same undici
dispatcher the proxy already configures **and** to the Electron session, so the
app's own outbound calls — gateway, model APIs, update feed, marketplace, MCP
HTTP transports — all present the certificate.

`:96` is a hard requirement, not a nicety: the files are **re-read every time
settings are applied**, so replacing the files at the same paths rotates the
credential without a restart. An implementation that reads once at startup fails
the documented rotation contract; pin the re-read with a test.

A missing or unreadable cert/key must be a reported, actionable error, not a
silent fall-through to an unauthenticated connection — a silent downgrade here is
the worst outcome available.

**Commit:** `feat(network): mutual TLS client certificate authentication`

### Task 3 — the trust chain must reach subprocesses

`proxy-env.ts` projects three proxy variables and nothing else, so a Pi
subprocess or a stdio MCP server talking to the same TLS-inspected endpoint has
a different trust chain from the main process: the app succeeds and the
subprocess fails, which reads as an unrelated bug.

Project the CA path and the client certificate the same way, under the documented
spellings (`NODE_EXTRA_CA_CERTS` and the client-cert variables) so anything
Node-based picks them up without our help. Check the interceptor
(`unified-network-interceptor.ts:61`) — if it needs the CA to build its own
agent, wire it; if it inherits correctly, say so.

Name in the commit body every process class you verified: Pi subprocess, stdio
MCP servers, HTTP MCP transports, plugin processes, and the headless server.

**Commit:** `fix(network): carry the CA and client certificate into subprocesses`

### Task 4 — a repository must not be able to redirect our TLS path

`:114`. We are exactly the case that rule is written for: a desktop app that
manages the provider connection, with project-scoped settings and project-scoped
plugins.

Establish and **pin with a test** that the proxy, CA and mTLS values can only
come from the user-level config and the managed policy — never from a project's
own settings, a plugin manifest, a workspace file, or anything else a
`git clone` can carry. If that is already true (the settings live in
`loadStoredConfig()`, which is the global config), the deliverable is the test
and a comment naming the threat; if any path can influence them, close it.

Also confirm the documented non-support of SOCKS is our behaviour too, and that a
SOCKS URL is refused with a clear message rather than silently ignored.

**Commit:** `fix(network): confine proxy and TLS settings to admin-owned scopes`

### Task 5 — close-out

Append per-task shas, real gate numbers, the Task 1 mapping answer, the Task 3
process-class list, and the Task 4 finding (already-safe vs closed-a-hole).

**Commit:** `docs(plans): close R26 with gate evidence`

## Tests that must exist

- Default configuration composes bundled + OS store; `bundled`-only and
  `system`-only each produce the expected set; a runtime without
  `tls.getCACertificates` degrades with a warning rather than throwing.
- A custom `tlsCaPath` still applies, and still warns when unreadable.
- mTLS: cert+key applied to the dispatcher; replacing the files and re-applying
  settings picks up the new bytes **without a restart**; a missing key is a
  reported error and never a silent unauthenticated connection.
- `proxy-env.ts` emits the CA and client-cert variables under the documented
  names when configured, and nothing when not.
- A project-scoped settings file carrying a proxy or CA value does not change the
  resolved network configuration (the `:114` threat, pinned).

## Gate

Affected packages during the loop: the network/proxy suites in `apps/electron`
and `packages/shared/src/config`, plus `typecheck:all`, `lint`,
`git diff --check`. **This is credential handling and a trust-chain change — a
listed immediate risk trigger.** Run the config, credentials and electron-main
aggregates once on the final diff, and state whether a packaged build is affected
(the bundled CA set ships as a resource).

Tests from the REPO ROOT. Running a suite from a package directory bypasses the
config-dir isolation preload and will destroy the real
`~/.nessy-agent/config.json`; a guard fails the run, do not work around it.

## Out of scope

The settings UI for these fields. If a value has no UI today, wire the runtime
and say so in the close-out — a Settings surface is its own task, and R25b will
want to deliver several of these from the managed tier anyway.

## Live cases for the planner (do not run these yourself)

1. With a self-signed root installed in the OS keychain only (no `tlsCaPath`), an
   HTTPS call through a TLS-inspecting proxy succeeds.
2. Rotating the client cert files at the same paths and re-applying settings uses
   the new certificate without restarting the app.
3. A project settings file setting `httpsProxy` changes nothing.

## Execution constraints

One commit per task with the subjects above; no `Co-Authored-By`; no push, MR or
tag; never `reset`/`rebase`/`amend`; pathspec-limited commits; no version bump or
release notes. Never `git checkout --` or `git stash` a file you are editing.
Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`.
You may edit this plan file.

Never print a private key, passphrase, or proxy URL containing credentials into a
log, an error message, or a test fixture. `:50` warns about credentials in proxy
URLs; our own logs must redact them.

Report any propagation of these gaps on other paths — do not fix it.

## Close-out (2026-07-28)

Executed on HEAD `cd5789a1` (plan base `6b5b0bd5` was stale; the intervening
commits were docs/policy only, none touching network files). Contract re-read
from the raw page (`curl -sL …/network-config.md`, 177 lines); every cited line
confirmed against the fetched markdown before implementation.

### Per-task commits

| Task | Commit | Subject |
| --- | --- | --- |
| 1 | `013107b9` | feat(network): trust the OS certificate store alongside the bundled set |
| 2 | `e9eabaca` | feat(network): mutual TLS client certificate authentication |
| 3 | `c3c484e7` | fix(network): carry the CA and client certificate into subprocesses |
| 4 | `ba4e0e00` | fix(network): confine proxy and TLS settings to admin-owned scopes |
| 5 | this commit | docs(plans): close R26 with gate evidence |

This commit also removes one unused `eslint-disable no-console` directive the
Task 3 commit introduced in `unified-network-interceptor.ts` (the shared lint
config has no `no-console` rule; the reported-error `console.error` stays).

### Task 1 mapping answer

`useBundledCa`/`tlsCaPath` do NOT map onto the `bundled`/`system` source list —
they are a different axis. They select the app-level EXTRA CA (custom PEM file,
or the corporate `tinkoff-bundle.crt` resource): the settings analog of
`NODE_EXTRA_CA_CERTS` (`:78`). The doc's `bundled` source is the runtime's
Mozilla set (`tls.rootCertificates`), already implicitly trusted; `system` is
the new OS-store source. The source list is a NEW optional settings key,
`certStore` (comma list, `bundled`/`system`, mirroring `CLAUDE_CODE_CERT_STORE`
semantics, `:60`); unset derives the documented default `bundled,system`. Both
existing settings keep their exact prior meaning; the composed set appends the
extra CA last. A config setting neither behaves as today plus the OS store.

`tls.getCACertificates`: PRESENT in Electron's bundled Node — checked live,
Electron 39.8.10 ships Node 22.22.1 (`getCACertificates('system')` returned 29
certs on this machine; Bun 1.3.14, the test runtime, has it too). The degrade
path (bundled-plus-extra with a reported warning, never a throw) is implemented
and pinned by test regardless, via an injectable reader.

### Task 3 process-class list

- **Pi subprocess** — spawn env spreads `getProxyEnvVars()`; inherits all new
  vars. Its interceptor inherits the CA natively (proven live: Bun fetch
  rejects a self-signed probe server without `NODE_EXTRA_CA_CERTS`, 200 with
  it) and needed wiring only for mTLS: it now presents the identity via Bun's
  per-request `tls` fetch option (proven live against a `requestCert` Node
  server), re-reading the files on mtime change; unreadable files report to
  stderr once per failure state, path + errno only.
- **Claude Code subprocess** — `buildClaudeSubprocessEnv` spreads the
  projection; the binary honors the documented vars natively. No change beyond
  the extended projection.
- **Native stdio MCP servers** — needed a change: `StdioClientTransport` env
  now includes the full projection (server-specific `config.env` still wins).
- **HTTP MCP transports** — inherited correctly: they run on main-process
  fetch under the undici dispatcher (CA + mTLS from Tasks 1–2). No change.
- **Plugin processes** — needed changes: supervised plugin MCP servers and the
  plugin dependency installer get proxy + CA via `getPluginNetworkEnvVars()`;
  the bunx runtime binding consults the settings-derived CA before ambient
  env. The mTLS identity deliberately does NOT cross the plugin boundary.
- **Headless server** — children inherited correctly (same shared spawn
  paths); the server's own process trust remains the documented shell-env
  contract.
- **Codex runtime** (feature-gated off) — verified not applicable: model
  traffic terminates at the loopback Responses adapter; real gateway calls
  happen main-process side under the dispatcher. No projection added
  (proxy env into a loopback-only child could misroute 127.0.0.1).

### Task 4 finding

Safe by construction on the settings path, plus ONE closed hole:

- Settings: `networkProxy` reads exclusively from `loadStoredConfig()` (the
  user-level config); single write path (settings UI → `SET_NETWORK_PROXY`
  RPC → `setNetworkProxySettings`). No project settings file, plugin
  manifest, workspace default, or `.claude/settings.json` env block merges
  into it. Pinned behaviorally by
  `packages/shared/src/config/__tests__/network-trust-scope.test.ts` (runs
  resolution from INSIDE a poisoned checkout); threat named at the type.
- **Closed hole:** the bundled corporate CA resolved through
  `getBundledAssetsDir`'s cwd fallbacks, so a rootless process (CLI, headless
  server, dev shell) with cwd inside a checkout would trust
  `<repo>/resources/certs/tinkoff-bundle.crt` — a git clone redirecting the
  TLS path. Proven reachable empirically pre-fix; `resolveBundledCaPath` now
  resolves only from the app-owned assets root registered at startup.
- SOCKS (`:37`): refused with a clear field-and-scheme message (never the
  URL, which may carry credentials) at the write path (throw → settings UI),
  the apply path (reported `log.error`, proxy not applied, CA/mTLS still
  applied), and the subprocess projection.

### Gate evidence (final diff, all from repo root)

- `bun test packages/shared/src/config/` — **348 pass / 2 fail**; both
  failures are `paths-default-root.test.ts` and reproduce IDENTICALLY on a
  clean worktree at pre-series `cd5789a1` (node_modules linked): pre-existing,
  unrelated, not fixed per scope rules.
- `bun test packages/shared/src/credentials/` — **20 pass / 0 fail**.
- `bun test apps/electron/src/main/__tests__/` — **312 pass / 0 fail**.
- `bun run test:shared:all` — **20 + 5 + 66 + 48 pass / 0 fail**.
- `bun test packages/shared/src/mcp/` — **203 pass / 0 fail** (stdio env
  change).
- Focused loop suites: network-cert-store + network-proxy + network-tls-ca +
  network-mtls — **43 pass**; proxy-env + proxy-url-validation +
  network-trust-scope + network-proxy-settings — **24 pass**;
  plugin-node-runtime + server-core installer + interceptor nestor-auth —
  **39 pass**.
- `bun run typecheck:all` — clean. `bun run lint` — exit 0, **0 errors**
  (118 electron + 4 shared warnings, all pre-existing, none in touched
  files). `git diff --check` — clean.

### Packaged build

Packaging inputs are UNAFFECTED: no new resources, no electron-builder or
build-script changes. The bundled CA continues to ship as
`resources/certs/tinkoff-bundle.crt`, and the packaged resolution path
(`<assetsRoot>/resources/certs/…`) is byte-identical to the previous first
candidate, so the packaged app resolves the same file as before. The packaged
interceptor bundle picks up the mTLS wiring through the existing
`build:interceptor` step. Runtime behavior in the packaged app changes as
designed: OS store trusted by default, mTLS presented, subprocess projection.

### Decisions the plan left open (decided and reported)

- `certStore` is a settings key (not an env var): the app has no env-block
  mechanism of its own; the key mirrors `CLAUDE_CODE_CERT_STORE` semantics.
- The mTLS passphrase is stored in the same user-level `networkProxy` block
  as the paths (the documented contract itself delivers it via settings/env);
  normalized verbatim, never trimmed, never logged.
- The client identity is presented to both the proxy (`proxyTls`) and the
  origin through the tunnel (`requestTls`) — servers that do not request a
  certificate ignore it.
- Chromium/Electron session mTLS: Chromium cannot take a PEM identity
  programmatically; the platform-keychain flow remains the native path for
  browser-pane requests. Stated in the Task 2 commit.
- Plugin boundary: proxy + CA cross it, the mTLS identity does not.
- A half-configured identity (one of cert/key) is never projected to
  subprocesses; the misconfiguration is reported by the apply path.
- An explicit CA composition always carries Node's `extra` store so a
  shell-provided `NODE_EXTRA_CA_CERTS` is not silently dropped; bundled-only
  with no extra CA passes no explicit `ca` at all for the same reason.

### Propagation found elsewhere (reported, NOT fixed)

1. **electron-updater (update feed) rides node:https, not undici** — the
   dispatcher's CA/mTLS never reaches it, and this was already true for the
   pre-existing `tlsCaPath`. It would pick up a CA only from a process-level
   `NODE_EXTRA_CA_CERTS`; it has no client-cert support at all without a
   custom httpExecutor. Task 2's stated coverage ("update feed") is therefore
   NOT satisfied on this path — needs its own task (custom transport or
   process-env application in main before first TLS use).
2. **The headless server's own outbound calls** (e.g. model fetchers over
   main fetch in `nessy-server`) run on undici defaults — nothing applies
   the stored CA/mTLS/proxy settings to the server's own dispatcher
   (`applyConfiguredProxySettings` is Electron-main only). Children are
   covered by the projection; the server process itself relies on shell env.
3. **`getBundledAssetsDir`'s cwd fallbacks remain for non-trust assets**
   (docs, themes, icons, permissions). Not trust material, so left as-is,
   but the same cwd-influence pattern exists there for content.
4. **The Electron session (Chromium) proxy config ignores per-scheme
   nuances** of credentialed proxy URLs (pre-existing; Chromium prompts for
   proxy auth itself). Unchanged.

### Out-of-scope confirmations

- No Settings UI was added for `certStore` or the mTLS fields — runtime only,
  as the plan directs; R25b can deliver them from the managed tier.
- The managed policy has no network fields today; when R25b adds them, the
  scope pin (user-level + managed only) already states the intended sources.
- The plan's "Live cases for the planner" were not run, per instruction.
