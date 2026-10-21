# S2 — the packaged headless server cannot boot outside the repo

**Status:** executed — see "Close-out" at the end of this file
**Parity row:** none — our own shipping defect, found while closing S1
**Branch:** `fix/renderer`
**Base:** current HEAD
**Severity:** the shipped `nessy-server` does not start. Higher than S1, which it
was hiding behind.

## The defect, verified first-hand

`packages/shared/src/agent/backend/factory.ts:28`:

```ts
import { CodexAgent } from '../codex-agent.ts';
```

A **static** import, so it is resolved at module load whether or not the Codex
runtime is enabled — `isCodexRuntimeEnabled` is consulted later, at line 30, by
which time the import has already had to resolve. `CodexAgent` pulls
`@nessy-agent/codex-agent-server` and `@nessy-agent/codex-responses-adapter`.

`scripts/build-server.ts:486` copies exactly seven workspace packages:

```
server · server-core · shared · core · session-tools-core · session-mcp-server · codex-protocol
```

Neither Codex package is among them. So a relocated distribution dies at boot:

```
Cannot find module '@nessy-agent/codex-agent-server'
```

In the repo it survives only because Node/Bun resolution walks up into the
repository's own `node_modules`. That is why nobody has seen it: **the build is
always tested where the missing dependency happens to exist.**

Present since the 1.0.1 baseline. The S1 executor had to apply a two-package
shim to a relocated copy before the interceptor question was observable at all —
this defect was standing in front of that one.

## What this is not

Not a parity unit. Not a Codex feature request. `NESSY_FEATURE_CODEX_RUNTIME` is
off by default and stays off; this is about the distribution being able to start
at all.

Do not widen it into a general packaging review. S1 already recorded three other
findings in this area (`build-win.ps1` never builds the interceptor bundle;
`copyInterceptorBundle` has no callers; a repo-local `dist/server` breaks a
root `bun test` run) — leave all three alone.

## Tasks

### Task 1 — reproduce the boot failure, then decide the shape

First reproduce it: assemble a distribution, relocate it outside the repository,
run it, and record the failure verbatim. **Run it from a cwd outside the repo** —
S1 learned the hard way that an in-repo cwd silently rescues a broken dist, both
through `bunfig.toml` resolution and through upward `node_modules` resolution.
Neither of those may be in the picture when you claim a result.

Then choose between the two honest fixes and say why in the commit body:

- **Ship the two packages.** Smallest diff, keeps `factory.ts` untouched, and
  costs distribution size for a runtime that is off by default.
- **Make the Codex import lazy**, so the module only resolves when the runtime is
  actually enabled. Matches the flag's intent — the factory already consults
  `isCodexRuntimeEnabled` — but it is a change to a load-bearing module and the
  other three backends are imported the same way, so partial laziness is its own
  inconsistency.

I am not prejudging it. Whichever you pick, the other backends' imports must
still behave exactly as they do now, and the enabled-Codex path must still work
when the flag is on — prove that, do not assume it.

**Commit:** `fix(server): let the assembled distribution boot outside the repo`

### Task 2 — make the build prove it

S1's lesson applies verbatim: fixing the instance without asserting the property
is half a fix, and this defect survived four releases precisely because nothing
checked it.

Add a check that fails the **build** when the assembled distribution cannot
resolve its own imports. The strongest form is to actually start the thing from a
neutral cwd and require it to reach a known-good signal; a static resolution
check over the dependency graph is acceptable if you can show it would have
caught this case. Say which you built and what it would and would not catch.

Follow S1's precedent: put it in a module the test suite can drive, and include
a test that the guard is **called**, not merely that it works —
`copyInterceptorBundle` is the cautionary case in this repo, a guard with no
callers that only warns.

**Commit:** `fix(server): fail the build when the distribution cannot start`

### Task 3 — close-out

Task 1's verbatim reproduction, per-task shas, real gate numbers, which fix shape
you chose and why, and exactly what the new guard catches and misses.

**Commit:** `docs(server): close S2 with gate evidence`

## Gate

`scripts/build-server.ts`, `packages/shared/src/agent/backend/`, and the server
package during the loop, plus `typecheck:all`, `lint`, `git diff --check`.
**Build/release infrastructure and a change to backend module loading — two
listed immediate risk triggers** — so on the final diff: assemble the
distribution, relocate it, boot it from a neutral cwd, and confirm both that it
starts and that the S1 interceptor pairing still holds.

Do not touch `.gitlab-ci.yml`, `fastlane/`, `policy.yml` or the signing
configuration — AGENTS.md gives them different ownership.

Tests from the REPO ROOT. A suite run from a package directory bypasses the
config-dir isolation preload and will destroy the real
`~/.nessy-agent/config.json`; a guard fails the run, do not work around it.
Delete any repo-local `dist/server` before running the root suite — S1 found it
pollutes test collection.

## Execution constraints

One commit per task with the subjects above; no `Co-Authored-By`; no push, MR or
tag; never `reset`/`rebase`/`amend`; pathspec-limited commits; no version bump or
release notes. Never `git checkout --` or `git stash` a file you are editing.
Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`;
leave `~/.nessy-agent/skills/r17-*` and `~/.nessy-agent/mcp/elicit-server.mjs`
alone. You may edit this plan file.

Another agent is concurrently implementing session scheduling in
`packages/session-tools-core` and the session stores. Stay out of those.

Report any propagation of this gap on other paths — do not fix it.

## Close-out

| Task | Commit |
| --- | --- |
| 1 — boot outside the repo | `d804f323` `fix(server): let the assembled distribution boot outside the repo` |
| 2 — fail the build | `b2d30bc5` `fix(server): fail the build when the distribution cannot start` |
| 3 — close-out | this commit |

Everything below was produced from an assembly of this branch built in a clean
tree, relocated outside any repository, and run with `pwd` in an empty temp
directory. Nothing was claimed from an in-repo cwd.

### Task 1 — the reproduction, verbatim

Assembled distribution, moved to `…/scratchpad/relocated/nessy-server`. No
`node_modules` and no `bunfig.toml` on the path above it or above the cwd
(checked by walking to `/`).

```
$ cd …/scratchpad/neutral-cwd
$ …/relocated/nessy-server/bin/nessy-server --generate-token
error: Cannot find module '@nessy-agent/codex-agent-server' from '…/relocated/nessy-server/packages/shared/src/agent/codex-agent.ts'

Bun v1.3.9 (macOS arm64)
exit=1
```

A real start fails identically — same message, exit 1, no output at all:

```
$ NESSY_SERVER_TOKEN=… NESSY_RPC_PORT=9187 …/relocated/nessy-server/bin/nessy-server
error: Cannot find module '@nessy-agent/codex-agent-server' from '…/relocated/nessy-server/packages/shared/src/agent/codex-agent.ts'

Bun v1.3.9 (macOS arm64)
exit=1
```

**Why nobody saw it.** The *same bytes*, cloned back to `<repo>/dist/server-inrepo`
and run from the same neutral cwd, exit 0:

```
$ …/s2-tree/dist/server-inrepo/bin/nessy-server --generate-token
eaed89da70784aef2c6dd00948ea8a319d2992d9887d3c5d
exit=0
```

The rescue is the distribution's *location*, not the cwd: resolution walks up
from `<dist>/packages/shared/src/agent/codex-agent.ts` and finds the repository's
own `node_modules`. So it is not enough to run the probe from outside the repo —
the artifact itself has to be moved out.

### Task 1 — the fix shape, and why

Shipped the two packages; did not make the import lazy.

- `createBackend` is **synchronous**. Lazy means `await import()`, an async
  factory, and ~20 construction sites changed including `SessionManager`, the
  Electron IPC paths and the frozen adjacent-backend contract. `createRequire`
  is not available either — the factory also runs under Electron's Node, which
  cannot require a `.ts` module.
- The saving would be 204 KB of TypeScript on a 1423 MB distribution. Both
  packages have **zero external npm dependencies** (only workspace packages and
  `node:` builtins), so nothing else comes with them. Assembly size went
  1422 MB → 1423 MB.
- The packaged desktop app already bundles `CodexAgent` into `dist/main.cjs`
  unconditionally. Shipping the source packages makes the server distribution
  match the desktop app instead of diverging from it.
- `factory.ts` is untouched, so anthropic / pi / nestor-cloud cannot have
  changed: the diff does not reach them.

Enabled-Codex path proven, not assumed — relocated distribution, neutral cwd,
`NESSY_FEATURE_CODEX_RUNTIME=1`:

```
flag isCodexRuntimeEnabled  : true
providers                   : ["pi","nestor-cloud-agent","codex-runtime"]
codex-runtime available     : true
codex pkg symbols resolved  : function,function,function
createBackend(codex-runtime): CodexAgent
```

Default (flag off) is unchanged: `providers: ["pi","nestor-cloud-agent"]`,
`codex available: false`.

### Task 2 — what the guard catches, and what it misses

`scripts/build/distribution-boot.ts`, called from `main()` in
`scripts/build-server.ts` after every assembly step, in two layers.

**`verifyWorkspaceLinkage`** — static, cheap, runs on every build including
cross-platform ones. Every `@nessy-agent/*` specifier the shipped source
mentions must resolve to a package in the assembled tree. Run against the real
pre-fix assembly it reports exactly the two real packages and nothing else:

```
[
  { "specifier": "@nessy-agent/codex-agent-server",      "referencedBy": "packages/shared/src/agent/codex-agent.ts" },
  { "specifier": "@nessy-agent/codex-responses-adapter", "referencedBy": "packages/shared/src/agent/codex-agent.ts" }
]
```

Against the fixed assembly: `gaps: []`. Deleting the two entries from
`copyWorkspacePackages` and rebuilding now **exits 1** with that message instead
of producing an unstartable tarball.

**`verifyDistributionBoots`** — the strong form. Relocates the assembled tree to
a temp directory, asserts no `node_modules`/`bunfig.toml` sits above it, runs
`bin/nessy-server --generate-token` from an empty cwd inside it, requires exit 0
and a 48-hex token on stdout, then moves the tree back. `--generate-token` is
the probe because ESM hoists imports: reaching it proves the entire static
import graph of `packages/server/src/index.ts` evaluated, while exiting
deterministically without binding a port. Against the pre-fix assembly it fails
with Bun's own message quoted verbatim; against the fixed one it returns
`booted`; in both cases the distribution is back in place afterwards.

Catches: a workspace package on the import graph the build forgets to ship (on
every build); and — on same-platform builds — a missing/renamed npm dependency,
a broken `bin/nessy-server`, a wrong Bun runtime, an entry module that throws at
import time.

Misses, stated plainly:

- **cross-platform builds.** `server:build:linux-x64` on a Mac ships a Linux Bun
  this host cannot execute. Verified end-to-end: a `--platform=linux
  --arch=arm64` build runs the static layer, prints
  `WARNING: boot check skipped — target linux-arm64 cannot be executed on
  darwin-arm64 …`, and completes. Build on the target platform for the strong
  check.
- **anything after startup** — RPC, sessions, agent turns.
- **dynamically imported or runtime-assembled specifiers** — not on the hoisted
  graph, and invisible to a literal scan.
- **resources rather than code** — a missing binary under `resources/` fails at
  spawn time (see Propagation).
- **wrong-arch native npm packages** in a cross-built tree.

### Gate numbers

Builds (`bun run scripts/build-server.ts --skip-download`, clean tree at
`b2d30bc5`, `node_modules` symlinked from the repo):

| Build | Result |
| --- | --- |
| pre-fix baseline | assembled 1422 MB; relocated boot **exit 1** |
| with Task 1 | assembled 1423 MB; relocated boot **exit 0** |
| with Task 1 + 2 | 1:15 total, both guards green, boot verified |
| Task 1 reverted, guard kept | **exit 1** — `verifyWorkspaceLinkage` names both packages |
| `--platform=linux --arch=arm64` | 1243 MB, static layer green, boot layer skipped with the warning, exit 0 |
| current branch HEAD `39f6efb8` (101 concurrent commits later) | both guards green, boot verified — the guard does not obstruct the concurrent work, and that work has not reintroduced the gap |

Final relocated boot of the last build, `pwd` in an empty temp dir, nothing but
the distribution's own `node_modules` anywhere on the resolution path:

```
### boot probe
8d9549686e16ec4474b9ab39a534e8c223d7f14ef440313d
exit=0
### full start
2026-07-29T07:01:27.931Z INFO  [bootstrap] Config artifacts initialized
2026-07-29T07:01:27.966Z INFO  [session] Loaded 0 sessions from disk (metadata only)
2026-07-29T07:01:27.974Z INFO  Nessy Desktop server listening on ws://127.0.0.1:9191
```

Root `bun test`, run from the root of two identical clean archive trees:

| Tree | Result |
| --- | --- |
| `0af16e59` (pre-S2 baseline) | 9080 pass, 18 skip, **32 fail**, 9130 tests / 845 files, 374.37s |
| `b2d30bc5` (this work) | 9170 pass, 18 skip, **32 fail**, 9220 tests / 851 files, 380.20s |

The two failing sets are **identical** — `comm` reports nothing on either side.
This diff adds zero failures. (Some of the 32 are artifacts of the archive tree
rather than genuine repo failures: `headless server smoke test` ×3 and
`PiAgent maxAgentTurns` ×6 pass when run in the real repo, while
`ensureStorageLayoutV2` ×7 fails there too. The load-bearing figure is the delta,
which is zero.)

Focused: `interceptor-packaging-contract.test.ts` 7 pass / 0 fail;
`server-distribution-boot.test.ts` 10 pass / 0 fail; `packages/server/src/__tests__/smoke.test.ts`
4 pass / 0 fail. `bun run typecheck:all` in the repo: **exit 0, 0 errors**.
`bun run lint` exit 0 (0 errors; 122 pre-existing warnings, none in the changed
files). `git diff --check` clean. `scripts/` is outside every `typecheck` script;
the new module typechecks clean standalone, and `build-server.ts`'s one `TS2367`
at line 435 (`platform === 'win32'`) predates this work and is untouched by the
diff.

Note on method: a `typecheck` run inside an archive tree whose package-level
`node_modules` are symlinked back to the repo resolves `@nessy-agent/*` to the
**live** repo sources, so it reports the concurrent branch's in-flight state, not
the tree's. Typecheck evidence here is from the repo itself. Test evidence is
from the archive trees, where package resolution does not matter because each
suite imports by relative path.

### Propagation found (reported, not fixed)

`assembleResources` copies only *files* from `apps/electron/resources/bin`, so
the `codex/` **directory** — which holds `codex-app-server` — never reaches the
server distribution. With `NESSY_FEATURE_CODEX_RUNTIME=1` on a relocated
distribution, `resolveCodexBinaryPath` returns `undefined`, so a `codex-runtime`
session in the headless server would fail at spawn even though the module graph
now loads. Out of scope here: this is Codex feature completeness for an
off-by-default runtime, not the distribution failing to start.

### S1 interceptor pairing after the change

`verifyInterceptorPairing(outputDir)` still runs last in every build and passed
in all three assemblies (darwin fix build, darwin guard build, linux cross
build). Confirmed functionally as well, on the relocated distribution:

```
--- WITHOUT preload (control) ---  fetch source head: function fetch() {     [native code] }
--- WITH preload (bin/nessy-server) ---  fetch source head: function ProxyObject() { [native code] }
```
