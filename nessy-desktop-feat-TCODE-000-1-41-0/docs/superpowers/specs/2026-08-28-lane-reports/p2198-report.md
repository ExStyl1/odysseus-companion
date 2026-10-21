# P2.198 — an empty workspace id silently selects the global bucket

## The answer, first line

**UNREACHABLE.** No caller can put `''` into `resolvePluginDataPath` today. All four
production call sites are covered, and every one of them is behind either
`assertStorageId` or a non-empty-string ingress check. The row's *premise* is confirmed
(`if (!context.workspaceId)` really did conflate empty with absent, and `assertStorageId`
really never saw the value); the row's *consequence* — "a workspace reading and writing
the global store" — **does not occur in this codebase today**.

I therefore did not manufacture a fix for a live defect. I made the boundary honest
(`undefined` instead of truthiness) and pinned it with tests that record the reachability
finding in the repo, so the next caller cannot silently acquire the widening.

## Documentation classification

**Category (a) — our own implementation.** `resolvePluginDataPath` and `assertStorageId`
are Nessy's own storage layer: the bucket layout (`plugins/data/<enc-key>/global`,
`…/workspaces/<id>`, `…/workspaces/<id>/projects/<key>`) is a Nessy invention, and the
Workspace-id storage grammar is ours. No upstream Claude/Codex/Pi page governs it. Per the
lane rule I say so explicitly and did not go looking.

(The *env contract* further down the same file — `CLAUDE_PLUGIN_ROOT` / `PLUGIN_ROOT` etc.
— IS upstream-governed, but it is not in this row's zone and I did not touch it.)

## Premise check, before changing anything

Confirmed exactly as written, at `packages/shared/src/plugins/data-paths.ts:47`:

```ts
  if (context.projectKey && !context.workspaceId) {
    throw new Error('A project-scoped plugin data path requires a Workspace ID');
  }

  if (!context.workspaceId) {
    return resolveContainedPath(root, 'global');
  }

  assertStorageId('workspace', context.workspaceId);
```

`''` is falsy, so it took the second branch and returned the **global** bucket — the one
directory every Workspace shares — and `assertStorageId` on the next line never ran. No
correction to the row's description of the site is needed.

## Reachability trace — how I know

Method: I enumerated the call sites, then followed each one **backwards to its
callers**, rather than reasoning from the shape of the code. Where a producer was a
type, I traced the actual `resolve()` call sites too, not only the annotations.

### Step 1 — every production call site of `resolvePluginDataPath`

Four, and no more (`/usr/bin/grep -arn` over `packages/*/src` + `apps/*/src`, tests excluded):

| # | Site | Guard between the caller and the path resolver |
| --- | --- | --- |
| 1 | `packages/shared/src/plugins/management-service-v2.ts:467` (`resolvePluginUserConfig`) | private; reached only from `configurationStatus` (`:333`), `configure` (`:361`), `clearConfiguration` (`:427`) |
| 2 | `packages/shared/src/plugins/management-service-v2.ts:501` (`resolvePluginSettings`) | same three entry points (`:336`, `:364`, `:430`) |
| 3 | `packages/server-core/src/bootstrap/storage-runtime.ts:975` → `readPluginOptionEnvironment` → `packages/shared/src/plugins/plugin-settings.ts:215` | inside `buildCapabilityResolutionInputsV2` |
| 4 | `packages/server-core/src/bootstrap/storage-runtime.ts:1144` (`pluginRuntimeContextFor`) | inside `buildCapabilityResolutionInputsV2` |

Sites 1 and 2 are closed outright: each of the three entry points runs
`assertStorageId('workspace', workspaceId)` **on the line above** the helper call, so `''`
throws `Invalid workspace storage ID` before the path resolver is reached.

### Step 2 — sites 3 and 4 reduce to one question

Both live inside `buildCapabilityResolutionInputsV2` (`storage-runtime.ts:667`–`1155`,
extent verified by listing the top-level declarations in that range). Its only production
caller is `createCapabilityResolutionInputProviderV2` (`:1212`–`1217`), which is the
`inputs` callback handed to `createCapabilityResolver`. So the id is always a
`CapabilityContext.workspaceId`, and the question becomes:

> Can `CapabilityContext.workspaceId` be `''`?

`CapabilityContext.workspaceId` is typed `string` (required, `capabilities/resolver.ts:99`),
so TypeScript excludes `undefined` but not `''`.

### Step 3 — every `resolve()` call site, and where its context comes from

Ten in non-test code (`/usr/bin/grep -arn`, see the tooling note below for why the `-a`
matters):

| Call site | Context origin | Why `''` cannot arrive |
| --- | --- | --- |
| `capabilities.ts:154,159,218,224,260,271,328,338,358,380` (via `withCapabilitySnapshot`) | `contextFor(ctx, ref)` → `resolveCapabilityContext` | **two** gates: `isSafeCapabilityContextRef` rejects a falsy `workspaceId` (`protocol/capabilities.ts:1052`, `isNonEmptyString` = `typeof === 'string' && length > 0`), and `contextFor` then throws `CapabilityContextScopeError` on `!ctx.workspaceId` |
| `settings.ts:102` | `resolveCapabilityContext({ workspaceId }, …)` | caller is guarded: `settings.ts:160` is `workspaceId ? await pluginOutputStylesFor(...) : []` |
| `SessionManager.ts:5465` (`resolveWorkspacePendingAuth`) | `workspaceId` parameter | only caller `getWorkspacePendingAuth` opens with `if (!this.resolveWorkspace(workspaceId)) return empty`, and `resolveWorkspace` returns `null` when `assertStorageId` throws |
| `SessionManager.ts:5539` (`resolveMcpBindingFromContext`) | two callers: the `:5377` literal, and `resolveMcpSourceBinding` → `buildSlashCommandCapabilityContext(managed)` | the `:5377` literal is reached only from `listMcpToolsForCapability`, whose sole production caller is the `LIST_MCP_TOOLS` handler **after** `contextFor`; the other reads `managed.workspace.id` |
| `SessionManager.ts:5678` (`createCapabilityTurn`) | `:5633` literal → `managed.workspace.id` | see step 4 |
| `SessionManager.ts:9482` (`prewarmCapabilitySnapshot`) | `:9456` literal → `managed.workspace.id` | see step 4 |
| `SessionManager.ts:21246`, `:21395` | `buildSlashCommandCapabilityContext` → `:21096` literal → `managed.workspace.id` | see step 4 |
| `workspace-mcp-pool-registry.ts:357`, `:454` | `buildResolveContext(context: WorkspacePoolResolveContext)` | `workspaceId` comes from the four `workspaceMcpPools.lease(...)` sites — `:5392` (validated RPC context), `:5470` (behind the `resolveWorkspace` guard), `:11808` and `:15338` (`managed.workspace.id`) |
| `resolver.ts:3323` | `withCapabilitySnapshot(resolver, context: CapabilityContext, …)` | pure pass-through; its callers are the rows above |

### Step 4 — `managed.workspace.id` is `assertStorageId`-validated by construction

`ManagedSession.workspace` is typed `RuntimeWorkspace` (`SessionManager.ts:1504`).
`RuntimeWorkspace` values are produced in exactly two places — `resolveWorkspace` (`:5605`)
and `listRuntimeWorkspaces` (`:5612`) — both `toRuntimeWorkspace(...)` over
`WorkspaceService.resolve` / `listResolved`. `WorkspaceService.resolve` opens with
`assertStorageId('workspace', workspaceId)` (`workspaces/service.ts:452`), and the registry
reader re-asserts **every stored id** and throws `Workspace registry is corrupt` otherwise
(`service.ts:956`). `ManagedSession.workspace` is assigned in exactly one place
(`SessionManager.ts:2065`, from a `workspace: RuntimeWorkspace` parameter at `:2033`); there
are no `.workspace = …` mutations.

So `managed.workspace.id` cannot be `''` — and note `resolveWorkspace` *catches* and returns
`null`, so an empty id yields no session at all rather than a session with an empty id.

### Step 5 — no other ingress

- No env/argv route: `NESSY_WORKSPACE_ID` is only ever **written** from
  `managed.workspace.id` (`SessionManager.ts:15412`, `:25204`); nothing reads a workspace id
  for the resolver out of the environment.
- `packages/server`, `apps/cli` and `apps/electron/src/main` construct no `CapabilityContext`
  at all; the renderer only ever sends a `SafeCapabilityContextRef` across RPC, which is
  validated at ingress.
- `readPluginOptionEnvironment` is exported from `plugins/index.ts:35`, but `storage-runtime.ts:975`
  is its only caller.

**Conclusion: unreachable.** The empty-string widening is real in the function's own text
and dead in the product.

## Tooling correction (this changed how much I trust my own sweep)

Midway through, the wrapped `grep` — a shell function delegating to
`ugrep -G --ignore-files -I` — returned **zero** hits for `withCapabilitySnapshot(` in
`handlers/rpc/capabilities.ts`, a file where I had already read the string with `sed`.
Positive control with `/usr/bin/grep` printed `10` and `Binary file … matches`: the file
carries a NUL byte, and `-I` had silently skipped it. This is exactly the repo's documented
trap, and it was live in my own toolchain, not a hypothetical.

I re-ran **every** enumeration in this report with `/usr/bin/grep -a`. The conclusion did not
change (the ten `capabilities.ts` sites it had hidden all sit behind `contextFor`), but
before the re-run I had an absence claim resting on a sweep that was silently skipping files.

Two other real tooling facts worth passing on:
- `xargs rg` fails with `rg: No such file or directory` — `rg` here is a shell function, not a binary.
- zsh does **not** word-split unquoted parameters, so `grep … $DIRS` searched nothing and exited 1.
  That is indistinguishable from "no hits" if you are not looking for it.

None of these were the Xcode outage; all were re-measured after the toolchain was restored.

## The change

Minimal, and deliberately not more. `packages/shared/src/plugins/data-paths.ts`:

- `context.workspaceId` is destructured once and tested with `=== undefined` instead of
  truthiness, in **both** places that previously used `!context.workspaceId`.
- `''` therefore falls through to `assertStorageId('workspace', '')`, which throws
  `Invalid workspace storage ID` — the row's "make `assertStorageId` actually see the value".
- An omitted `workspaceId` still resolves to `global`, unchanged.
- Docblocks on `PluginDataContext.workspaceId` and on the function record the distinction and
  the reachability finding, including "this is the boundary made honest, not a live defect
  fixed — keep it that way by not reintroducing a truthiness test here."

### The family rule, applied

P2.185/P2.190 settled it: *a value the author WROTE is the empty set; a field they OMITTED is
not a value; the empty value never falls back to the absent-field default, because that
default is WIDER. Where the reader can represent the empty set it takes it literally; where
it cannot, it fails closed.*

Here the reader **cannot** represent an empty Workspace id as a directory, so it fails closed.
The distinction this instance adds, as the row asked: the previous four widened a permission
**SET**; this one widens a storage **SCOPE** — from one Workspace's bucket to the `global`
bucket that every Workspace shares. Same rule, different quantity.

One behaviour change beyond the headline, recorded because it is a change:
`{ workspaceId: '', projectKey: <valid> }` used to throw `A project-scoped plugin data path
requires a Workspace ID` (because `''` is falsy) and now throws `Invalid workspace storage ID`.
Both refuse; the new message names the right proposition — the Workspace id is *bad*, not *absent*.

## Tests

`packages/shared/src/plugins/__tests__/data-paths.test.ts`, one new case with four assertions.
It exercises the **real** `resolvePluginDataPath` against a real temp data dir — no double, so
there is no argument-dropping blind spot.

1. **negative** — `{ workspaceId: '' }` throws `Invalid workspace storage ID` (asserted on the
   message, so another layer refusing for another reason cannot satisfy it).
2. **boundary / discriminator** — `{ workspaceId: '', projectKey }` also throws
   `Invalid workspace storage ID`. This is the assertion that discriminates against the
   truthiness test: under a revert this input still throws, but with the *wrong* message.
3. **positive control** — `{}` still resolves to `<root>/global`, asserted on identity. A guard
   that refused both empty and absent would fail here; this is what makes the case about a
   *distinction* rather than a blanket refusal.
4. **control** — `{ projectKey }` with no Workspace keeps its own message, so the two refusals
   stay about different things.

The docblock on the case carries the reachability trace, so the finding lives in the repo and
not only in this report.

## Gate

Commit **`32b2402b3`** on `feat/TCODE-000`, exactly two files
(`git show --stat --oneline HEAD`: `data-paths.ts` +45/−8, `__tests__/data-paths.test.ts`
+69). Committed by explicit pathspec with `--only`; the committed blob was re-read and
carries `workspaceId === undefined` at both sites (not a mutant), and its md5 matches the
worktree.

Each command with the contract it proves:

| Command | Contract | Result |
| --- | --- | --- |
| `bun test` (mutex) on `data-paths.test.ts` | the empty-id refusal, and that an omitted id still resolves to `global` | **13 pass / 0 fail**, 45 expects |
| `bun test` (mutex) on `management-service-v2.test.ts` | call sites 1–2 still behave — the two `resolvePluginDataPath` consumers behind `assertStorageId` | **50 pass / 0 fail** |
| `bun test` (mutex) on `workspaces/__tests__/paths.test.ts` | `assertStorageId`'s own grammar is unchanged (I changed who calls it, not what it accepts) | **7 pass / 0 fail** |
| `bun run typecheck:shared` | the destructured `string \| undefined` narrows to `string` for `assertStorageId`/`resolveContainedPath` | clean, no diagnostics |
| `bunx eslint` (from `packages/shared`) on both changed files | lint | exit 0, no output |
| `git diff --check` on both changed files | whitespace | clean |

**No full repo suite** — implementation-first budget, and this row changes one pure function
in one package.

### Attribution of the one failure I saw

The first combined run reported `1 fail`: `management-service-v2.test.ts` →
`applies and persists external catalog auth timing for mixed app connectors`, *"timed out
after 5000ms"* at 5338 ms. It is **not** in
`docs/superpowers/specs/2026-07-29-known-failing-tests.md`, so I did not assume load — I
measured. Re-run **alone, with my change present**: `50 pass / 0 fail`, and the file takes
**120.16 s** on its own. A 5 s per-test budget in a file that needs two minutes, while four
other lanes were contending for the machine, is a load artefact; and the positive control is
that the same test passes with the same change on disk. Not mine, and nothing for the
register (another lane owns that file).

### Re-break — three mutants, three kills, each on a different assertion

Applied by `perl -0pi`, one part each, with `diff` printed and md5 checked before and after;
every revert returned `data-paths.ts` to its baseline md5 `c03d87fde8de8cf192e45afbff1aecea`.

| Mutant | Which line reverted to truthiness | Result |
| --- | --- | --- |
| B | both | **12 pass / 1 fail** — dies at assertion 1, `Received value: …/global` (the widening, printed) |
| D | only the global-bucket site | **12 pass / 1 fail** — dies at assertion 1 (line 159), again receiving `…/global` |
| E | only the `projectKey` site | **12 pass / 1 fail** — dies at assertion 2 (line 167): `Received message: "A project-scoped plugin data path requires a Workspace ID"` |

D and E are the point: **both changed lines are independently load-bearing**, and the
"discriminator" assertion is not decorative — mutant E is invisible to every other assertion
in the file and only assertion 2 kills it. Restored tree: 13/13 green.

### One correction I made to my own test, mid-gate

My first draft of the control assertion was
`expect(global).toBe(join(root, 'global'))` where `root` was computed by slicing `/global`
back off `global` — a tautology that holds for any return value. I caught it before the
final run and replaced it with `startsWith(dir)` + `endsWith('/global')`, which is checked
against the data root and the literal bucket name rather than against the string under test.
Gate 1 ran on the tautological version, gate 2 on the corrected one; the numbers above are
gate 2's.

## Concerns

1. **The headline is a negative, and negatives rot.** "Unreachable" is true of *today's*
   callers. The trace's load-bearing links are `isSafeCapabilityContextRef`'s
   `isNonEmptyString` and `WorkspaceService.resolve`'s `assertStorageId`; if either is
   relaxed, or a new `CapabilityContext` producer appears that reads a workspace id from
   somewhere else, the widening becomes live. The committed guard is what makes that safe,
   which is the argument for having landed it despite the row being unreachable.
2. **`data-paths.ts:356` is the same shape and I deliberately did not touch it.**
   `createPluginDataCleanupParticipant.commit` does `const workspaceId = staged.get(...); if
   (!workspaceId) return;`. It is provably benign — `stage()` runs `assertStorageId` before
   storing, so a stored value is never `''`, and the `Map.get` genuinely returns `undefined`
   for a missing key. I am flagging it so a future family sweep does not re-report it as a
   sixth instance.
3. **A tooling hazard the next lane will hit.** The wrapped `grep` in this environment is
   `ugrep -G --ignore-files -I`, and `-I` makes it return **zero** on NUL-carrying source
   files — `handlers/rpc/capabilities.ts` is one, and it hid ten `withCapabilitySnapshot`
   call sites from me. Any absence claim in this tree needs `/usr/bin/grep -a`. Related:
   `xargs rg` fails because `rg` is a shell function, and zsh does not word-split `$DIRS`, so
   `grep … $DIRS` silently searches nothing and exits 1 — which reads exactly like "no hits".
4. **Mutex contention was the wall-clock cost of this row**, not the work. Waits of 9–13
   minutes per acquisition (`P2.85-consumers`, `P2.85-attrib`, `P2.270-naive`, `P2.212-repro`,
   `P2.202` all queued). I consolidated attribution + all mutants into two locked scripts
   rather than seven acquisitions; a later lane may want the same trick.
5. **One deliberate behaviour change beyond the headline**, recorded in the commit body:
   `{ workspaceId: '', projectKey }` now throws `Invalid workspace storage ID` instead of
   `A project-scoped plugin data path requires a Workspace ID`. Both refuse, so nothing
   widens, but a caller matching on the old message string would see the new one. I found no
   such matcher; the only assertions on that message are in this file's own tests.
6. **Not done, out of zone:** I did not touch the plan tracker (controller pins rows), the
   known-failing register (another lane owns it), or `SessionManager.ts` / `pi-agent.ts` /
   `codex-agent.ts` / `permission-dsl.ts`. Nothing I found needed them.
