# S1 — the packaged headless server ships without the network interceptor

**Status:** DONE — corrected 2026-07-30. The header said "ready for execution" for work
that had already shipped: `scripts/build/interceptor-pairing.ts` exists and
`scripts/build-server.ts:949` calls `verifyInterceptorPairing` at the end of every
server build. A stale status line is worse than a missing plan — the next reader
starts executing what is already done. **The Electron half is still open** and is
tracked as parity row L4: the desktop build has no equivalent assertion.
**Parity row:** none — this is our own shipping defect, found while closing R26b
**Branch:** `fix/renderer`
**Base:** current HEAD

## The defect, verified first-hand

`bunfig.toml:1`:

```toml
preload = ["./packages/shared/src/unified-network-interceptor.ts", "./apps/electron/testing/electron-mock-preload.ts"]
```

`scripts/build-server.ts` contains **zero** occurrences of `bunfig`, `preload`
or `interceptor` — checked by grep, not inferred. So the assembled server
distribution has no `bunfig.toml` and no interceptor bundle, and the shipped
`nessy-server` runs without it while every `bun run` in the repo runs with it.

That is a dev-only feature masquerading as a shipped one. AGENTS.md describes
what the interceptor carries, and the first item is not cosmetic:

> The OpenAI Chat Completions strip stream
> (`unified-network-interceptor.ts:createOpenAiSseStrippingStream`) emits **one
> consolidated SSE event per logical tool call** … Some downstream SDKs (Pi SDK)
> treat args-only deltas as new tool_calls instead of merging by index, which
> produces duplicate empty-id entries on parallel-tool turns from DeepSeek and
> other relays.

Plus the Nestor gateway request rewriting, rich tool intent, the fast-mode
override and `MalformedBodyError` validation.

So a headless deployment against the gateway can produce duplicate tool calls on
a parallel-tool turn where the desktop app, or a developer running from source,
cannot. The failure is silent, model-visible, and impossible to reproduce in dev
— the worst combination available.

## What this is not

Not a parity unit. Nothing in Claude's documentation is involved. This is a
regression in our own packaging that the R26b executor surfaced and carried out
rather than absorbing, and I verified before planning it.

Do not widen it into a general packaging review.

## Tasks

### Task 1 — establish exactly what the shipped server does today

Before changing the build, prove the gap at runtime rather than by reading the
script. Assemble a server distribution, start it, and show that the interceptor
is absent — a log line it emits on load, a behaviour it changes, or its absence
from the process's module set. Record the command and the observation.

Do the same for the packaged Electron app's Pi subprocess, which
`agent/backend/internal/runtime-resolver.ts:resolveInterceptorBundlePath` handles
through `apps/electron/dist/interceptor.cjs`. Say whether that path is healthy;
if it is, it is also the model to follow.

This task may end with **no code change** — its deliverable is the evidence.
Commit it as documentation if so.

**Commit:** `docs(server): record the interceptor gap in the packaged server`

#### Task 1 evidence — runtime, on the assembled distribution

Assembled with the real build script, nothing patched:

```
$ bun run scripts/build-server.ts --output=dist/server
...
  Assembly complete: 1422 MB
  Build completed successfully!
```

Static shape of the assembled tree, before any runtime claim:

```
$ cd dist/server && find . -maxdepth 3 -name bunfig.toml ; find . -name interceptor.cjs
(no output — neither exists)
$ ls packages/shared/src/unified-network-interceptor.ts
-rw-r--r--  86435  packages/shared/src/unified-network-interceptor.ts   # source ships, nothing loads it
```

**Two harness corrections were needed before the runtime observation was honest.**
Both are the reason a casual check would have called this fixed:

1. `bun run` resolves `bunfig.toml` from the **cwd**, not from the script path.
   The first run of `dist/server/bin/nessy-server` was launched while sitting in
   the repo, and it silently picked up the repo's `bunfig.toml` — the interceptor
   installed, and the defect looked absent. The distribution must be run from a
   cwd outside the repo to be observed at all.
2. The as-built distribution **cannot boot outside the repo at all** (separate
   defect, recorded below). A minimal shim — a copy of the two missing workspace
   packages — was applied to the relocated copy so the process could reach the
   point where the interceptor would install. Nothing else was changed.

A/B on the **same entry file**, both with `NESSY_DEBUG=1` and a private
`NESSY_CONFIG_DIR` seeded by a first boot (the interceptor's install line is
dropped when no `config.json` exists yet), second boot recorded:

```
### A. repo run — cwd=<repo>, bunfig.toml preload applies
listening on ws://127.0.0.1:9161
$ cat <cfg-repo>/logs/interceptor.log
2026-07-28T21:56:12.041Z [interceptor] Unified fetch interceptor installed

### B. dist run — dist relocated to <scratch>/nessy-server-dist, cwd=<scratch>/neutral-cwd
listening on ws://127.0.0.1:9152
$ ls <cfg-dist>
config-defaults.json  config.json  config.json.bak-2026-07-29  docs
plugins  sessions  tool-icons  workspaces
$ cat <cfg-dist>/logs/interceptor.log
cat: .../logs/interceptor.log: No such file or directory
```

The packaged server boots, serves, and writes a complete config tree — and never
creates the interceptor log, because the interceptor module is never loaded. Same
entry file, same debug flag, opposite result.

The Pi subprocess half, resolved by the **production resolver running inside the
distribution** (`resolveBackendRuntimePaths`, the function whose result becomes
`--require` in `pi-agent.ts:1254`):

```
relocated dist (isPackaged=true) : interceptorBundlePath = undefined
in-repo dist   (isPackaged=true) : interceptorBundlePath = <repo>/apps/electron/dist/interceptor.cjs
repo dev       (isPackaged=false): interceptorBundlePath = <repo>/packages/shared/src/unified-network-interceptor.ts
```

`undefined` means `pi-agent.ts` never unshifts `--require`, so the Pi subprocess a
packaged server spawns is unpatched too. The middle line is the trap: a dist built
and tested in-repo walks up and finds the *repo's* Electron bundle.

#### Electron side — the precedent is healthy on mac/linux, holed on Windows

Healthy: `scripts/electron-build-main.ts:138` esbuilds
`packages/shared/src/unified-network-interceptor.ts` into
`apps/electron/dist/interceptor.cjs` and **exits non-zero** if the output is
missing. It runs from root `electron:build` → `electron:build:main`, which both
`build-dmg.sh:277` and `build-linux.sh:208` invoke. `electron-builder.yml` ships
`dist/**/*` with `asar: false`, so the packaged app root holds a real
`dist/interceptor.cjs` — the resolver's first packaged candidate.

Report-only, not in scope for this plan:

- **`apps/electron/scripts/build-win.ps1` never builds the bundle.** Its only
  `bun run` calls are `electron:build:preload` (line 329) and
  `stage-electron-servers.ts` (line 365); the main process is built by a direct
  `npx esbuild` (line 319). `apps/electron/package.json` has a `build:win` script
  that *does* include `build:interceptor`, but the release script does not use it.
  On a clean checkout the Windows artifact ships without `dist/interceptor.cjs` —
  the same hole as the server, on the Electron surface.
- **The server distribution cannot start outside the repo.**
  `packages/shared/src/agent/backend/factory.ts:28` statically imports `CodexAgent`
  → `@nessy-agent/codex-agent-server` and `@nessy-agent/codex-responses-adapter`;
  `scripts/build-server.ts:449` copies seven workspace packages and neither of
  those is among them. Relocated, the dist dies at boot with
  `Cannot find module '@nessy-agent/codex-agent-server'`. In-repo it survives only
  by resolving up into the repo's `node_modules`. Present since the 1.0.1 baseline.
- **`copyInterceptorBundle` (`scripts/build/common.ts:475`) has no callers** and
  only `console.warn`s when the bundle is missing.

### Task 2 — ship the interceptor with the server distribution

Make the packaged `nessy-server` load it. The mechanism is yours to choose, but
name the alternatives you rejected and why:

- a `bunfig.toml` written into the dist with a `preload` pointing at a bundled
  interceptor, or
- a built `interceptor.cjs` alongside the server, following the Electron
  precedent, or
- an explicit import at the server entry point, if the interceptor's side effects
  are import-time and ordering permits it.

The ordering constraint is real: the interceptor patches network primitives, so
it must load **before** anything issues a request. If you choose the import
route, prove the ordering rather than assuming it.

Whatever you pick, add a check that fails the build — or a test that fails the
suite — when the distribution is assembled without it. The defect existed because
nothing asserted the pairing; fixing the instance without fixing that is half a
fix.

**Commit:** `fix(server): ship the network interceptor with the server bundle`

### Task 3 — close-out

Append the Task 1 evidence, per-task shas, real gate numbers, the mechanism you
chose with the rejected alternatives, and how the build now fails if the pairing
is broken again.

**Commit:** `docs(server): close S1 with gate evidence`

## Gate

`scripts/build-server.ts` and the server package during the loop, plus
`typecheck:all`, `lint`, `git diff --check`. **This is build/release
infrastructure — a listed immediate risk trigger** — so assemble the
distribution once on the final diff and confirm it starts.

`.gitlab-ci.yml`, `fastlane/`, `policy.yml` and the signing configuration have
different ownership boundaries per AGENTS.md: do not touch them.

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

Two related findings were carried out of R26b and are NOT in scope — report if
you touch their neighbourhood, do not fix: `apps/cli/src/index.ts:2064` assigns
`NODE_EXTRA_CA_CERTS` at runtime, which is inert under Bun; and
`docs-site/.../network-proxy.md:49-51` now lists the proxied Electron sessions
incompletely.

## Close-out

**Status:** done. Executed on `fix/renderer`, one commit per task.

| Task | Sha | Subject |
| --- | --- | --- |
| 1 | `3dcc451d` | `docs(server): record the interceptor gap in the packaged server` |
| 2 | `3e39712c` | `fix(server): ship the network interceptor with the server bundle` |
| 3 | this commit | `docs(server): close S1 with gate evidence` |

The premise held. The grep-based conclusion was right about *what* was missing,
and the runtime check added the part reading the script could not: two separate
ways a casual verification would have called it fine (repo-adjacent cwd, and a
`resolveUpwards` walk into the repo's Electron bundle). Both are recorded under
Task 1 above.

### Mechanism chosen

One artifact, two consumers, no runtime-code change:

- `scripts/build-server.ts` step 5 esbuilds
  `packages/shared/src/unified-network-interceptor.ts` into
  `<dist>/dist/interceptor.cjs` — the **identical invocation** to
  `apps/electron/package.json:build:interceptor`, so the server ships the artifact
  whose behaviour the packaged desktop app's Pi subprocess already proves.
- `bin/nessy-server` execs
  `bun run --preload "$ROOT/dist/interceptor.cjs" "$ROOT/packages/server/src/index.ts" "$@"`.
  `$ROOT` is derived at runtime from the script location, so the distribution
  stays relocatable — a tarball extracted to `/opt`, a Docker `COPY . .`, and an
  in-repo build all resolve their own copy.
- The `<dist>/dist/interceptor.cjs` layout is not arbitrary: it is the packaged
  Electron app's layout (app root + `dist/interceptor.cjs`), which is what
  `resolveInterceptorBundlePath` probes in packaged mode. So the **Pi subprocess
  half fixes itself** — `resolveBackendRuntimePaths` now returns the bundle and
  `pi-agent.ts:1254` unshifts `--require` — without touching the resolver, which
  is shared with Electron.

Flag placement was verified, not assumed: `bun --preload <file> run <entry>` is
rejected by the CLI ("No package.json found"); `bun run --preload <file> <entry>`
is the working form.

### Alternatives rejected

- **A `bunfig.toml` written into the dist.** Closest to dev, and the first thing
  to try — but bunfig is resolved from the **CWD**, not from the script path.
  This is not a footnote: it is the exact mechanism that produced the bug, and it
  produced a false negative during Task 1 when the dist was run from the repo.
  A dist-root bunfig would work under systemd (`WorkingDirectory=$DIR`) and Docker
  (`WORKDIR /app`) and silently do nothing for an operator running `./start.sh`
  from home. `bun --config=<path>` exists, but then preload paths are resolved
  relative to a project root the flag itself redefines — trading a known-fragile
  mechanism for an under-specified one.
- **An explicit import at the server entry point.** Ordering is defensible (first
  import in source order runs first), but it makes the load-bearing side effect
  invisible at the call site, and it risks a **second module instance** in dev,
  where the file is already preloaded by path while the entry would import it by
  package specifier. A second instance captures the already-patched `fetch` as its
  `originalFetch` and double-wraps the stream — metadata injected twice, SSE
  stripped twice. `--preload` is one instance by construction, matches what dev
  does, and keeps the mechanism where an operator can see it.
- **Preloading the `.ts` source from the dist** (the sources do ship). Works, and
  avoids a build step — but the Pi subprocess needs a bundle at a resolver-known
  path anyway, and the packaged resolver deliberately refuses `.ts`. Two
  mechanisms where one does both.
- **Shipping the bundle without preloading it into the server process.** Fixes
  the Pi subprocess and leaves the server's own outbound calls — model fetchers,
  credential refresh, source calls — unpatched. Half.

### How the build now fails if the pairing breaks again

`scripts/build/interceptor-pairing.ts:verifyInterceptorPairing(outputDir)` runs
against the **assembled tree** at the end of every server build and throws when:

1. `<dist>/dist/interceptor.cjs` is absent,
2. it exists but does not contain the interceptor (marker
   `Unified fetch interceptor installed`) — catches a bundle step that produced
   the wrong file rather than no file,
3. `bin/nessy-server` does not carry the preload fragment — catches "ships but
   never loads",
4. the generated `Dockerfile` ENTRYPOINT stops routing through `bin/nessy-server`
   — catches a container deployment silently bypassing the preload.

The shell fragment is derived from the same constant the bundle is written to, so
the two halves cannot drift apart.

It is a module rather than a private function so the suite can prove it fails.
`packages/shared/src/__tests__/interceptor-packaging-contract.test.ts` — the
existing home of this contract — assembles fixture distributions and asserts each
of the four rejections plus the accepting case, and one further test asserts the
guard is actually *called* by `build-server.ts`. That last one exists because this
repo already contains the cautionary case: `copyInterceptorBundle`
(`scripts/build/common.ts:475`) is a packaging check with no callers that only
`console.warn`s.

Proven by mutation, not by assertion count: deleting the preload from
`build-server.ts`'s entry-script template turned the suite red
(`6 pass, 1 fail` — "is wired into the server build rather than left orphaned"),
and the file was restored from a copy afterwards.

### Gate

Build, on the final diff:

```
$ bun run scripts/build-server.ts --output=dist/server     # EXIT=0, 1m15s
[5/9] Building network interceptor...
  Interceptor bundle: 65 KB
[9/9] Creating entry scripts...
  Interceptor pairing verified (bundle + preload + container entry)
  Assembly complete: 1422 MB
  Build completed successfully!
```

Runtime, relocated outside the repo, neutral cwd (same harness that produced the
Task 1 negative, same shim for the unrelated missing-package defect):

```
listening on ws://127.0.0.1:9171
$ head -1 <cfg>/logs/interceptor.log
2026-07-28T22:13:48.189Z [interceptor] Unified fetch interceptor installed

# Pi subprocess half — production resolver, inside the relocated dist
relocated FIXED dist (isPackaged=true): interceptorBundlePath =
  <dist>/dist/interceptor.cjs            # was: undefined

# ordering — the entry module's FIRST request, through the shipped bundle
entry issued first request -> 200
intercepted responses logged: 1
← RESPONSE 200 OK (262ms)
  URL: http://127.0.0.1:64379/ordering-probe

# argument passthrough survives the inserted flags
$ bin/nessy-server --generate-token
bb51f946f8d3b27a33183fa8d911cf84fb13d5bfa98c3c9c
```

Suites and checks:

| Command | Result |
| --- | --- |
| `bun test .../interceptor-packaging-contract.test.ts .../runtime-resolver.test.ts` | 21 pass, 0 fail, 27 expect() |
| same, with the preload mutated out of `build-server.ts` | 6 pass, **1 fail** (guard works), restored after |
| `bun run typecheck:all` | clean |
| `bun run lint` | 0 errors, 4 warnings (pre-existing, untouched files) |
| `git diff --check` | clean |

Not run, and why: no runtime code in any package changed — the diff is a build
script, a new build-side module, one test file and one AGENTS.md paragraph — so
the adjacent-backend aggregates and packaging suites prove nothing about it. The
build/release risk trigger was discharged by assembling the distribution once on
the final diff and starting it, per AGENTS.md.

### Propagation found — reported, not fixed

1. **`apps/electron/scripts/build-win.ps1` never builds `dist/interceptor.cjs`.**
   Mac and Linux get it from root `electron:build` → `electron:build:main`
   (`scripts/electron-build-main.ts:138`, which exits non-zero if the output is
   missing). The Windows release script builds main with a direct `npx esbuild`
   and its only `bun run` calls are `electron:build:preload` and
   `stage-electron-servers.ts`. `apps/electron/package.json:build:win` *does*
   include `build:interceptor`, but the release script does not use it. On a clean
   checkout the Windows artifact ships without the bundle — the same defect class,
   on the Electron surface.
2. **The server distribution cannot start outside the repo.**
   `packages/shared/src/agent/backend/factory.ts:28` statically imports
   `CodexAgent` → `@nessy-agent/codex-agent-server` and
   `@nessy-agent/codex-responses-adapter`; `scripts/build-server.ts:449` copies
   seven workspace packages, neither of them included. Relocated, the dist dies at
   boot with `Cannot find module '@nessy-agent/codex-agent-server'`; in-repo it
   survives only by resolving up into the repo's `node_modules`. Present since the
   1.0.1 baseline. Both Task 1 and the close-out gate shimmed it to observe the
   interceptor at all.
3. **`copyInterceptorBundle` (`scripts/build/common.ts:475`) has no callers** and
   only warns.
4. **A repo-local `dist/server` build breaks `bun test` from the repo root.** The
   distribution ships `packages/shared/src/__tests__/`, so the root run collects
   the dist's copies too and the packaging-contract test fails there on a path it
   cannot resolve. `dist/` is gitignored, so CI is unaffected — but delete
   `dist/` before running the suite locally.
