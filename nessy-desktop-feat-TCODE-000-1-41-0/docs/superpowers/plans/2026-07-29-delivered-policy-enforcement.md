# R25c — the delivered managed policy is never enforced

**Status:** ready for execution
**Parity row:** R25 — **reopens it.** I closed R25 as done; this shows the
delivery half shipped a payload that is largely inert.
**Branch:** `fix/renderer`
**Base:** current HEAD
**Severity:** highest open item. An organisation's delivered policy silently
does nothing.

## The defect, verified first-hand

Found by the Unit 4 executor and carried out rather than absorbed. I verified
both halves before writing this:

- `packages/server-core/src/bootstrap/storage-runtime.ts:193` —
  `const { policy: managedPiPolicy, drops } = loadManagedPiPolicyWithDiagnostics()`.
  That is the **host-owned file** loader.
- `rg 'managedDelivery|deliveredPolicy|refreshManagedDelivery' packages/server-core --type ts`
  → **nothing.** The delivery module is not referenced anywhere in the package
  that builds the enforced policy.

R25b built the whole lifecycle: fetch at sign-in, salvage, 0600 atomic cache,
approval classification with a digest, and the withheld-env hardening. Two things
consume its output — the `env` block and the `forceRemoteSettingsRefresh` flag.
**Everything else in a delivered payload is parsed, salvaged, approved, cached
and then dropped on the floor**: `permissionDsl`, `claudeRules`,
`allowedMcpServers`/`deniedMcpServers`, `allowedPluginKeys`/`deniedPluginKeys`,
`sandbox`, `workflow`, `channelsEnabled`, `allowedHttpHookUrls`,
`httpHookAllowedEnvVars`, `autoMode`, `cleanupPeriodDays`, `autoCompactEnabled`.

An admin who deploys a deny rule through the server sees it accepted, cached and
reported as applied. It denies nothing.

This is the series' recurring defect — declared on one path, enforced on another
— at the largest scale it has appeared: an entire subsystem on the declaring
side.

## Contract

`curl -sL https://code.claude.com/docs/en/server-managed-settings.md`. **The
quoted sentence is the identifier, not the line number** — the Unit 4 executor
found this neighbourhood's cites drifted *non-uniformly* (some one too high,
some one too low, because the page lost a line before the section and gained two
inside it), so a blind offset corrupts them. Re-derive every line and report what
you find.

Two sentences govern the composition:

> Server-managed settings and endpoint-managed settings both occupy the highest
> tier in the Claude Code settings hierarchy. No other settings level can
> override them, including command line arguments.

> A small set of cross-source lock keys … is honored when any admin-controlled
> managed source sets them.

So the two managed sources are **peers**, and a lock set by *either* holds. That
is the composition rule to implement, and it is not "last one wins".

## Tasks

### Task 1 — reproduce, then decide the composition

First prove it: deliver a payload carrying a `deniedMcpServers` entry (or a
`permissionDsl` deny rule), show it reaching the cache, and show the enforced
policy without it. Record the observation verbatim. **If the premise turns out
false, say so and stop** — a plan built on a wrong premise is worth killing
early, and I would rather hear that.

Then decide and state, in the commit body, how a delivered policy composes with
a file policy when both exist. The contract says peers, and that locks are
honoured when *any* admin source sets them. Concretely you must answer:

- A deny list in one and not the other → union, surely. Say it.
- An allow list in one and not the other → is the absent one "no constraint" or
  "empty"? Getting this backwards either opens a lock or bricks a fleet. R25a
  already settled the analogous question *within* one document (invalid allowlist
  → admit nothing; invalid denylist → drop the field); reuse that reasoning, do
  not invent a second algebra.
- A boolean lock set `false` in one and absent in the other → the enforcing pole
  wins, per R25a's polarity finding.
- `cleanupPeriodDays` and other scalars → which one, and why.

**Commit:** `feat(managed): compose the delivered policy with the file policy`

### Task 2 — enforce it at the one seam

`createStorageRuntime` is where the enforced policy is built and where every
consumer reads it from. The delivered policy has to arrive there.

The ordering problem is real and is the reason this was skipped once already:
delivery is asynchronous and hangs off sign-in, while `createStorageRuntime`
runs at boot. Say in the commit body how you resolved it — the honest options
are the cached payload at boot (which the withheld-env rule already models as
"cache applies immediately, minus the withheld categories") and a refresh that
re-composes when a fetch lands. **Do not let a delivered policy apply before it
would have been approved**: `classifyManagedApproval` exists and the cache
carries `approvedDigest` precisely so an unapproved payload cannot take effect.

**Commit:** `feat(managed): enforce the delivered policy at the storage runtime`

### Task 3 — a test that fails if this regresses

The defect survived because nothing asserted that a delivered key reaches
enforcement. One test per enforcement family is too many; one test that walks a
delivered payload through to an enforcement decision is right — a delivered deny
rule denying, a delivered `deniedMcpServers` entry excluding a server.

Better still if you can pin the *general* property: every field of
`ManagedPiPolicyV1` that the file path enforces is also reachable from the
delivered path. That shape would have caught this on day one.

**Commit:** `test(managed): pin that a delivered policy reaches enforcement`

### Task 4 — close-out

Task 1's verbatim reproduction, per-task shas, real gate numbers, the composition
rules you chose with their reasoning, how you resolved the boot-ordering problem,
and whether my premise held.

**Commit:** `docs(plans): close R25c with gate evidence`

## The deviation rule applies

Read it at the top of
`docs/superpowers/specs/2026-07-25-nessy-claude-parity-audit.md`. Record every
outcome with one of its three category strings verbatim.

## Gate

Affected packages during the loop: policy, config, `server-core` bootstrap, plus
`typecheck:all`, `lint`, `git diff --check`. **This is policy enforcement and a
startup path — two listed immediate risk triggers** — so run the policy, config,
credentials and bootstrap aggregates once on the final diff.

Tests from the REPO ROOT. A suite run from a package directory bypasses the
config-dir isolation preload and will destroy the real
`~/.nessy-agent/config.json`; a guard fails the run, do not work around it.

Never log a delivered payload, a token, or a credentialed proxy URL.

## Execution constraints

One commit per task with the subjects above; no `Co-Authored-By`; no push, MR or
tag; never `reset`/`rebase`/`amend`; pathspec-limited commits; no version bump or
release notes. Never `git checkout --` or `git stash` a file you are editing.
Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`;
leave `~/.nessy-agent/skills/r17-*` and `~/.nessy-agent/mcp/elicit-server.mjs`
alone. You may edit this plan file.

Other agents may be in `scripts/build-server.ts`, the server package, and the
agent-definition files. Stay out of those. If `typecheck:all` fails on files you
did not touch, run it in a detached `git worktree` at your own HEAD and say so.

Report any propagation of this gap on other paths — do not fix it.

---

# Close-out — R25c

**Status:** complete. Branch `fix/renderer`, base `0dc9207b`.

| Task | Commit | Subject |
| --- | --- | --- |
| 1 | `3c259f1f` | `feat(managed): compose the delivered policy with the file policy` |
| 2 | `65a159d8` | `feat(managed): enforce the delivered policy at the storage runtime` |
| 3 | `69b26caf` | `test(managed): pin that a delivered policy reaches enforcement` |
| 4 | this commit | `docs(plans): close R25c with gate evidence` |

## The premise held

Reproduced before any code was written, with a payload carrying both a
`deniedMcpServers` entry and a `permissionDsl` deny rule. Verbatim:

```
[1] delivery outcome        source = server | confirmed = true
[1] delivered policy carries deniedMcpServers = ["forbidden-mcp"]
[1] delivered policy carries permissionDsl rule ids = ["org-deny-bash"]
[2] cache file              <config-dir>/managed-delivery.json
[2] cache payload.deniedMcpServers = ["forbidden-mcp"]
[2] cache payload.permissionDsl rule ids = ["org-deny-bash"]
[3] startup cache read      source = cache | deniedMcpServers = ["forbidden-mcp"]
[4] ENFORCED policy keys    = ["schemaVersion","disabledPermissionModes"]
[4] ENFORCED deniedMcpServers = undefined
[4] ENFORCED permissionDsl    = undefined
[5] isManagedMcpServerAllowed(enforced, "forbidden-mcp") = true
[5] isManagedMcpServerAllowed(delivered, "forbidden-mcp") = false
[5] enforced policy has a Bash deny rule = false
```

Steps 1–3 are the delivery lifecycle working exactly as R25b built it. Step 4
is `storage-runtime.ts:193` — the enforced policy carries two keys, both of
them the schema's mandatory pair. Step 5 is the consequence: the same call
that returns `false` against the delivered policy returns `true` against the
one the app enforces.

After the fix, same script, same fixture:

```
[4] ENFORCED policy keys    = ["schemaVersion","disabledPermissionModes",
                               "permissionDsl","deniedMcpServers"]
[4] ENFORCED deniedMcpServers = ["forbidden-mcp"]
[5] isManagedMcpServerAllowed(enforced, "forbidden-mcp") = false
[5] enforced policy has a Bash deny rule = true
```

## The composition rules, and why the plan's premise was wrong

The plan quotes `server-managed-settings.md:135` and `:141` and concludes the
two managed sources are peers whose deny lists union. It skips the two
paragraphs between them, which say the opposite:

- `:137` — a configured `policyHelper` preempts every other managed source.
- `:139` — "Otherwise, Claude Code uses the first source that delivers a
  non-empty configuration. Server-managed settings are checked first, then
  endpoint-managed settings. **Sources don't merge**: if server-managed
  settings deliver any keys at all, other endpoint-managed settings are
  ignored."

`settings.md:663` says the same from the settings side and orders the whole
tier: `policyHelper` > remote > MDM > file-based > HKCU, "only one source is
used and the others are ignored rather than merged".

So the rule is **winner-takes-all**, not union, and `:135` is about the tier's
relationship to everything below it. Per the deviation rule the documentation
wins and the plan is corrected. `managed-refresh-gate.ts:54` already had the
correct reading in a comment — "Normally server-managed settings win wholesale
and endpoint-managed settings are ignored (`:139`)" — so the code was one
module ahead of the plan.

| Question | Answer | Why |
| --- | --- | --- |
| Deny lists in both | **Not a union.** The winner's list is enforced, the loser's is ignored. | `:139`, `settings.md:663`. Both sources are one administrator's; unioning them makes it impossible to RELAX anything from the console, because every stale deny rule on a disk image outlives the policy that replaced it. |
| An allow list in one, absent in the other | Only the winner is read, so this reduces to what ABSENT means there: **no constraint**, never empty. | R25a's rule unchanged, not a second algebra. `parsePolicy` classifies a list as grant or restriction only when `root[field] !== undefined`; an INVALID allowlist is enforced empty (admit nothing), an ABSENT one narrows nothing. Present-but-broken and never-written are different states and only the first fails closed. |
| A boolean lock `false` in one, absent in the other | For the documented cross-source keys, **the enforcing pole wins**. For every other boolean, the winner's value. | `settings.md:669` — "honored when any admin-controlled managed source sets them". Our poles are not always Claude's (`allowPluginHooks`, `channelsEnabled`, `sandbox.allowUnsandboxedCommands` all enforce at `false`), but none of those three is in the documented cross-source set, so they follow `:139`. |
| `cleanupPeriodDays` and other scalars | **The winner's value.** Not the smaller, not the larger. | `:663` uses one source. A retention window is not a boundary with a safe direction to guess — the field's own comment already refuses to invent one because it "would delete sessions no admin asked to delete". |

Cross-source set implemented: `forceRemoteSettingsRefresh` (`settings.md:673`,
named as a `:139` exception by `server-managed-settings.md:199`) and
`sandbox.network.allowManagedDomainsOnly` with its associated allowlist
`sandbox.network.allowedDomains` (`settings.md:670`) — the lock travels with
its list, since honouring a lock while reading only the other source's
allowlist denies traffic no administrator denied. `allowAllClaudeAiMcps`,
`sandbox.filesystem.allowManagedReadPathsOnly`, `sandbox.bwrapPath` and
`sandbox.socatPath` have no counterpart in our schema. `policyHelper` is out of
scope by `:129`, which says server-managed settings do not honour it at all.

## Boot ordering

Delivery is asynchronous and hangs off sign-in; `createStorageRuntime` runs at
boot. The two hosts do not agree on the order — `startManagedSettingsDelivery`
completes before the headless session manager exists, while in the desktop
shell `createStorageRuntime` runs several hundred lines BEFORE
`initializeManagedDeliveryFromCache()`. So no ordering assumption is made.

Waiting for a fetch was never available: `:151` fetches asynchronously and
`:152` continues without managed settings when it fails. The input is the
**cache**, which is what `:157` prescribes — "Cached settings apply immediately
at startup" — the same model the withheld-`env` rule already runs on.
`getDeliveredManagedPolicy` reads the live session state first only because it
can be fresher (a `:221` non-interactive run applies a payload it deliberately
never wrote to disk), never because it must be populated.

**An unapproved payload cannot take effect.** The session holds one behind
`awaitingApproval` rather than publishing it, and `loadCachedManagedDelivery`
re-checks `classifyManagedApproval` against the recorded `approvedDigest` on
every read (`:218`, `:254`). A test pins it.

## Task 3: the general property, and yes it came out general

`EVERY_KEY` sets every key the schema accepts. Two assertions make it a
property rather than a snapshot: the fixture's key set must equal
`MANAGED_PI_POLICY_KEYS` (a new schema field fails here), and the document
parsed through the FILE path must deep-equal the result of the DELIVERED path
— salvage, 0600 cache write, startup read, composition. `expect(drops)
.toEqual([])` keeps the fixture from silently degrading to whichever keys still
validate.

Mutation-checked, not assumed: injecting `cleanupPeriodDays: undefined` into
the composed policy turns it red with
`- "cleanupPeriodDays": 30 / + "cleanupPeriodDays": undefined`.

## Contract line audit

`server-managed-settings.md` is **274 lines** as fetched today. Every cite in
the touched neighbourhood was re-derived by its sentence, not by offset. All
of `:9 :102 :129 :135 :141 :143 :147 :151 :152 :153 :157 :159 :161 :165 :167
:171 :175 :179 :185 :187 :189 :199 :201 :203 :205 :207 :216 :218 :221 :240
:254 :255` resolve to the sentence the code claims. `settings.md` is **1205
lines**; `:185 :186 :192-:200 :202 :204 :207 :208 :212 :241 :275 :311 :312` all
resolve correctly, as do `:663` and `:669`-`:673`, which this unit derived.

**One drift found.** `managed-delivery.ts:17` and `applyDeliveredDocument` cite
`:181` for "when no field can be salvaged, the last-accepted cache is KEPT and
a fatal error is recorded". That sentence is line **180** today; `:181` is the
adjacent "the security approval dialog evaluates the salvaged payload", which
the same file also cites as `:181` — correctly. Two different sentences carry
one label and one of them is now one too high. Reported, not fixed.

Two paragraphs the code never cited at all until this unit: `:137` and `:139`.
`:139` is the one that decides the composition.

## Deviations

| Item | Category |
| --- | --- |
| Delivered policy composed with the file policy under `:139`/`settings.md:663` | `documented, implemented` |
| Cross-source lock keys honoured from either admin source (`settings.md:669`) | `documented, implemented` |
| Cached payload applies at boot (`:157`), unapproved payloads held back (`:218`) | `documented, implemented` |
| Re-composing the enforced policy mid-session when a later fetch lands (`:171`) | `documented, not implemented — SessionManager captures the policy once at construction and every subsystem built from it inherits that capture; making it live is its own unit. The `env` block and `forceRemoteSettingsRefresh` already re-apply on their own change listeners.` |

## Propagation found (reported, not fixed)

The same defect this unit fixed — declared on one path, enforced on another —
appears four more times in the same neighbourhood. All are the ENFORCEMENT
half this time, and each is a grep away, which is the sweep the audit's phase 5
calls for.

1. **`isManagedModelAllowed` and `resolveManagedDefaultModel` have no
   production caller.** `availableModels` and `enforceAvailableModels` are
   parsed, validated at the documented poles (`settings.md:196`/`:197`),
   composed, and now delivered — and the only callers of the two helpers that
   would enforce them are in `managed-policy.test.ts`. A managed model
   allowlist is never consulted when a model is selected.
2. **`isManagedChannelServerAllowed` has no production caller.**
   `resolveManagedChannelPolicy` IS called (`SessionManager.ts:2274`), so
   `channelsEnabled` and `allowedChannelServers` do reach the pool gate through
   that path; the per-source helper beside it does not.
3. **`ManagedDeliveryStateV1.fatalError` is written and never read.** `:181`
   requires that an unsalvageable payload "records a fatal error";
   `managed-delivery.ts:442` records it onto a state object no production code
   inspects.
4. **Delivered drops are never reported.** Every delivery path populates
   `ManagedDeliveryStateV1.drops`, and `reportManagedPolicyDrops` is called on
   the FILE drops only (`storage-runtime.ts:199`). An admin whose delivered
   payload had an entry stripped sees nothing on `settings.md:207`'s headless
   stderr summary. Deliberately not folded into this unit: the desktop shell
   builds the storage runtime before delivery is initialised, so reading the
   session's drops there would report them in the headless host and silently
   not in the desktop one — worse than reporting neither.

Low confidence, adjacent: `managed-policy.ts:792`'s comment cites
`settings.md:198` for a restricting-list rule, but `:198` is the
`forceLoginOrgUUID` row. Possibly meant `:199`.

## Gates

| Gate | Result |
| --- | --- |
| `bun test packages/shared/src/config/__tests__/managed-composition.test.ts` | 8 pass, 0 fail |
| `bun test` delivery + approval + env + managed-policy suites | 118 pass, 0 fail |
| `bun test packages/server-core/src/bootstrap/__tests__/` | 29 pass, 0 fail (4 new) |
| Policy + config + bootstrap aggregate (598 tests, 52 files) | 596 pass, 2 fail |
| Credentials aggregate | 20 pass, 0 fail |
| `bun run typecheck:all` | clean |
| `bun run lint` | 0 errors (122 pre-existing warnings, none in touched files) |
| `git diff --check` | clean |

The 2 failures are the known pre-existing `paths-default-root` case ("treats an
empty override as the default root"), which exercises `config/paths.ts` — not
in this diff. Every test was run from the repo root so the config-dir isolation
preload applied; no run touched the real `~/.nessy-agent`.
