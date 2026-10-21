# R26b — the two outbound paths the trust chain misses

**Status:** closed — see Close-out
**Parity row:** R26 (carried out of its close-out, verified first-hand)
**Branch:** `fix/renderer`
**Base:** current HEAD

## Why this exists

R26 landed the composed CA store, mTLS, and projection into subprocesses, and
its close-out carried two paths it does **not** cover. I verified both myself
rather than taking the report at face value, and in doing so found the report's
characterisation of the first one was wrong in a way that changes the fix.

### Path 1 — the update feed

The close-out said `electron-updater` "uses `node:https` and bypasses undici".
The bypass conclusion is right; the mechanism is not. From the installed
package:

- `electron-updater/out/AppUpdater.js:206` constructs an `ElectronHttpExecutor`.
- `electron-updater/out/electronHttpExecutor.js:54` issues
  `require("electron").net.request({ ...options, session: this.cachedSession })`.
- `:7`–`:11` — that session is
  `session.fromPartition("electron-updater", { cache: false })`.

So the update feed runs on **Chromium's network stack, in its own named
partition** — not Node's, and not the default Electron session. Three
consequences, and they differ per mechanism:

| Trust input | Reaches the updater today? |
| --- | --- |
| OS trust store | **Yes, natively.** Chromium reads it without our help. |
| `certStore`/`tlsCaPath` custom PEM | **No.** Ours is composed for undici. |
| mTLS client certificate | **No.** |
| Proxy settings | **No** — `network-proxy.ts:184` configures `session.defaultSession` and the browser-pane partition only; the `electron-updater` partition is neither. |

The proxy gap is the sharpest: a corporate deployment where all egress must
traverse a proxy has a working app and a silently failing updater.

### Path 2 — the headless server's own outbound calls

`applyConfiguredProxySettings` is imported once, by
`apps/electron/src/main/index.ts:187`. `packages/server` (the `nessy-server`
binary) never calls it, so nothing installs the undici dispatcher there. Its own
requests — model fetchers reached through `packages/server-core/src/handlers/rpc/
llm-connections.ts` and `SessionManager.ts` — run on the default global
dispatcher with no proxy, no composed CA and no client certificate.

Its *children* are fine: R26's projection puts the variables in subprocess env.
It is the server's own process that is unconfigured. So a headless deployment
behind a TLS-inspecting proxy fails at exactly the point a user cannot see.

## Tasks

### Task 1 — configure the updater's session partition

Apply the same settings to `session.fromPartition("electron-updater")` that
`configureElectronProxy` already applies to the default and browser-pane
sessions: proxy via `setProxy`, the custom CA via `setCertificateVerifyProc`, and
the client certificate via the `select-client-certificate` path.

Take the partition name from `electron-updater`'s own export rather than
hardcoding the string, so a package upgrade that renames it fails loudly instead
of silently reverting to an unconfigured session. If the export is not reachable,
say so and pin the literal with a test that reads it back from the package.

Order matters: the session must be configured **before** the first update check
fires. Say in the commit body where you hooked it relative to
`applyConfiguredProxySettings` and the updater's own initialisation.

Do not touch the OS-store path — Chromium already handles it, and reimplementing
it would be strictly worse.

**Commit:** `fix(network): apply proxy and TLS settings to the updater session`

### Task 2 — install the dispatcher in the headless server

The headless server needs the same undici configuration the Electron main
process installs. The proxy/CA/mTLS resolution itself is already shared code
(`packages/shared/src/config/`); what is missing is the call.

`configureNodeProxy` currently lives in `apps/electron/src/main/network-proxy.ts`
and is Electron-coupled only by its neighbours, not by its body — check that,
and if the undici half is portable, move it to shared rather than writing a
second copy. If it genuinely cannot move, say why in the commit body.

Re-apply on settings change, matching the Electron path's behaviour, so mTLS
rotation works in the headless server too.

**Commit:** `fix(network): configure the trust chain in the headless server`

### Task 3 — close-out

Append per-task shas, real gate numbers, whether the partition name was taken
from the package export, and whether `configureNodeProxy` moved or was
duplicated with a reason.

**Commit:** `docs(plans): close R26b with gate evidence`

## Tests that must exist

- The updater session is configured with the same proxy the default session
  gets; a test that fails if a new session partition is added without being
  configured would be better than one that names the two.
- The headless server installs a dispatcher at startup and re-installs on
  settings change.
- Neither path logs a credentialed proxy URL, a key path, or a passphrase.

## Gate

Affected packages during the loop: `apps/electron` main, `packages/server`,
`packages/shared/src/config`, plus `typecheck:all`, `lint`, `git diff --check`.
This is a trust-chain change — a listed immediate risk trigger — so run the
config, credentials and electron-main aggregates once on the final diff.

Tests from the REPO ROOT. A suite run from a package directory bypasses the
config-dir isolation preload and will destroy the real
`~/.nessy-agent/config.json`; a guard fails the run, do not work around it.

## Execution constraints

One commit per task with the subjects above; no `Co-Authored-By`; no push, MR or
tag; never `reset`/`rebase`/`amend`; pathspec-limited commits; no version bump or
release notes. Never `git checkout --` or `git stash` a file you are editing.
Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`;
leave `~/.nessy-agent/skills/r17-*` and `~/.nessy-agent/mcp/elicit-server.mjs`
alone. You may edit this plan file.

Report any propagation of these gaps on other paths — do not fix it.

## Close-out

| Task | Commit |
| --- | --- |
| 1 — updater session partition | `d6f313a8` |
| 2 — headless server trust chain | `bcb72155` |
| 2 — follow-up (see below) | `627393a7` |
| 3 — close-out | this commit |

The follow-up is a deviation from "one commit per task": reviewing the
committed Task 2 diff turned up two defects in it — the settings watcher was
bound to `config.json`'s inode, which `saveConfig`'s atomic rename kills after
the first change, and the env projection deleted an operator's launch-time
`HTTP_PROXY` on disable instead of restoring it. Amending is out of bounds
here, so they landed as a separate commit rather than being buried in the docs
commit.

### Was the partition name taken from the package export?

Yes. `session-partitions.ts` imports `NET_SESSION_NAME` from
`electron-updater/out/electronHttpExecutor` — the module that defines it and
uses it (`:6`, `:7`–`:11`). `electron-updater@6.8.9` publishes no `exports`
map, so the deep subpath is importable, and the module's top level pulls in
`builder-util-runtime` only (the `require("electron")` sits inside
`getNetSession()`), so importing it outside Electron is safe. The test reads
`NET_SESSION_NAME` back from the installed package and asserts equality, so a
rename in a future release fails the suite instead of silently reverting the
update feed to an unconfigured session.

One thing the plan did not call out and the implementation had to honour:
`getNetSession()` creates the session with `{ cache: false }`, and Electron
applies `fromPartition` options only on the call that CREATES the session.
Configuring it first without those options would have handed the updater a
*cached* session. The registry therefore carries the creation options
alongside the name.

### Where was it hooked?

Inside `configureElectronProxy`, which `applyConfiguredProxySettings` calls —
so the updater partition is configured by the same call that configures the
default and browser-pane sessions, and cannot drift from them.
`applyConfiguredProxySettings` has exactly one caller,
`apps/electron/src/main/index.ts:405`, inside `app.whenReady()`. The first
update check is `checkForUpdatesOnLaunch()` at `index.ts:1212`, later in the
same `whenReady` chain; every other check (`menu.ts:75`, `menu.ts:200`,
`handlers/system.ts:274`) is user-driven and therefore later still. Importing
`auto-update.ts` at `index.ts:80` only sets `autoUpdater` flags — the session
is created lazily by `ElectronHttpExecutor` on its first request. Configured
before the first check, with margin.

### Did `configureNodeProxy` move?

No — it stayed in `apps/electron/src/main/network-proxy.ts`, and it was not
duplicated either. Its body is portable in shape, but moving it would have
shipped a placebo:

- `bin/nessy-server` execs `vendor/bun/bun run packages/server/src/index.ts`
  (`scripts/build-server.ts:591`), and Bun's native `fetch` does not consult
  undici's global dispatcher. Measured on bun 1.3.14: a `Dispatcher` subclass
  installed with `setGlobalDispatcher` and then exercised with `fetch()`
  receives **zero** dispatches.
- Bun's built-in `undici` shim exposes `Agent` without `close()`, so
  `configureNodeProxy`'s "close the previous dispatcher" step throws on the
  second application — the re-apply the plan asks for would break the server.
- `undici` is declared only by `apps/electron`; moving the function to shared
  would have added a dependency and a lockfile change for a no-op.

What did move is the half both processes genuinely share — the resolution,
which the plan assumed was already in `packages/shared/src/config/` and was
only half there. `network-proxy-utils.ts`, `network-tls-ca.ts` and
`network-mtls.ts` are pure `node:fs`/`node:tls` and now live in
`packages/shared/src/config/`, with their four suites; the Electron main
imports them from there and keeps its dispatcher. The headless server gets
`network-runtime.ts`, which applies the same resolved material through the
mechanisms Bun does honour.

### What the headless server actually applies

Measured against bun 1.3.14 before choosing:

| Mechanism | Honoured by Bun's fetch? |
| --- | --- |
| undici global dispatcher | No — 0 dispatches |
| per-request `proxy` option | Yes |
| per-request `tls.ca` | Yes (augments, does not replace) |
| per-request `tls.cert`/`key` | Yes — handshake succeeds against a `requestCert: true, rejectUnauthorized: true` server only when supplied |
| `HTTP_PROXY`/`NO_PROXY` env | Yes, re-read per request (so a runtime change takes effect) |
| `NODE_EXTRA_CA_CERTS` env | **Only from the launch environment.** Setting it in-process has no effect even as the first statement — Bun reads it before any JavaScript runs |

So `network-runtime.ts` uses the per-request `proxy`/`tls` options — the same
options `unified-network-interceptor.ts` already uses for subprocesses — and
additionally mirrors the proxy into `process.env`, which covers callers that
captured `fetch` before the wrapper installed. `NODE_EXTRA_CA_CERTS` is
deliberately not projected; the extra CA rides `tls.ca` instead.

### What is still not covered, and why

Task 1 closed the proxy gap on the updater session. The composed custom CA and
the mTLS identity still do not reach it, and neither is reachable the way the
plan's one-line sketch implies:

- **Custom CA.** Chromium exposes no "trust this extra root" API. The only
  hook is `session.setCertificateVerifyProc`, which would mean hand-rolling
  chain verification (walk `issuerCert`, verify signatures and validity, check
  hostname) and returning `0` to override Chromium's verdict. That is a
  security-sensitive reimplementation whose failure mode is *accepting* a bad
  certificate, and it buys little: Chromium reads the OS trust store natively,
  which is where a corporate root normally lives. Left undone deliberately.
- **mTLS.** `app.on('select-client-certificate')` can only CHOOSE from the
  `certificateList` Chromium offers, which comes from the platform identity
  store. There is no way to hand a Chromium session a PEM cert/key pair from
  file paths, which is the shape our setting has. Not implementable as
  specified.

### Gate

Run from the repo root.

| Check | Result |
| --- | --- |
| `bun run typecheck:all` | clean |
| `bun run lint` | 0 errors (118 + 4 pre-existing warnings) |
| `git diff --check` | clean |
| `bun run electron:build:main` | built and verified |
| `session-partitions.test.ts` | 3 pass |
| `session-partitions-proxy.isolated.ts` | 2 pass |
| `network-runtime.test.ts` | 15 pass (stable over 3 consecutive runs) |
| `packages/server/src/__tests__/` (incl. spawning smoke) | 7 pass |
| config aggregate — `packages/shared/src/config/` | 471 pass, 2 fail (pre-existing) |
| credentials aggregate — `packages/shared/src/credentials/` | 20 pass |
| electron-main aggregate — `apps/electron/src/main/` | 316 pass |
| electron-main `.isolated.ts` files | 9 pass, 3 fail (pre-existing) |
| `bun test` (whole repo) | 9094 pass, 18 skip, 12 fail — 11 pre-existing, 1 flake |

Pre-existing failures, each reproduced on a clean worktree at `b295b652` with
the repo's `node_modules`:

- `config path default-root classification` (2) —
  `packages/shared/src/config/__tests__/paths-default-root.test.ts`, fails 2/2.
- `ensureStorageLayoutV2` (7) —
  `packages/shared/src/workspaces/__tests__/storage-readiness.test.ts`, fails
  7/9.
- `managed paths with NESSY_CONFIG_DIR` (1) —
  `packages/shared/src/workspaces/__tests__/paths-env.isolated.ts`, fails 1/2.
  This one, `paths-default-root` and `storage-readiness` are the same family:
  all three assert behaviour for an UNSET `NESSY_CONFIG_DIR`, which the
  config-dir isolation preload necessarily sets.
- `session branch rollback on preflight failure` (3) —
  `apps/electron/src/main/__tests__/session-branch-rollback.isolated.ts`, fails
  3/4.
- `Pi harness R0 baseline > executes golden foreground and background process
  contracts` — carried from an earlier deliberate `isolationProfile` change.

The twelfth whole-repo failure is a rotating flake among the real-subprocess
Pi tests, not a regression. Two whole-repo runs failed a DIFFERENT one each
time — `bash auto-background real server e2e > transitions on timeout…`
(`packages/pi-agent-server/src/tools/bash-auto-background-real-server.test.ts`)
in the first, `Pi runtime cwd transaction > keeps PREPARE private…`
(`packages/pi-agent-server/src/__tests__/pi-runtime-cwd-transaction.test.ts`)
in the second. Each passes in isolation on this branch (the latter 3/3) and on
clean HEAD; both assert against wall-clock-ordered marker logs from a real
child process.

### Propagation found elsewhere (not fixed)

- **The packaged headless server never loads the unified network interceptor.**
  The root `bunfig.toml` preloads it for `bun run`, but
  `scripts/build-server.ts` writes no `bunfig.toml` into the server dist, so
  the mechanism that carries proxy/mTLS for Pi subprocesses is absent from the
  packaged `nessy-server`. The trust chain added here does not depend on it,
  but any other behaviour that assumes the interceptor is loaded (adapter
  metadata, SSE stripping, Nestor header rewriting) is dev-only in that binary.
- **`apps/cli` maps `--tls-ca`/`NESSY_TLS_CA` onto `NODE_EXTRA_CA_CERTS` at
  `apps/cli/src/index.ts:2064`** — assigned to `process.env` at runtime, which
  the measurements above show is a no-op under Bun.
- **Stale comment at `apps/electron/src/main/index.ts:404`**: "first call
  before app.whenReady only configured Node-level proxy". There is no earlier
  call; `applyConfiguredProxySettings` has exactly one call site.
- `docs-site/content/reference/config/network-proxy.md:49-51` enumerates the
  Electron sessions the proxy reaches as "the browser pane and OAuth browser".
  Not wrong, now incomplete — the update feed is a third. Left alone: this plan
  excludes the version bump that the docs-site update procedure hangs off.
