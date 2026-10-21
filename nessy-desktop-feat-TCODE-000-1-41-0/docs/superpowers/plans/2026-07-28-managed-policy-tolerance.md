# R25a — tolerant managed-policy parsing and drop-in fragments

**Status:** ready for execution
**Parity row:** R25 (Ord 9), first of two slices — see "Why this is split"
**Branch:** `fix/renderer`
**Base:** `8083bc54`

## Contract source — quoted from raw markdown, with line cites

Fetched with `curl -sL https://code.claude.com/docs/en/settings.md`. **Fetch it
yourself before you implement; do not trust this transcription.** A prior unit in
this series shipped a wrong wire contract because a plan quoted a summarizer
instead of the page.

`settings.md:185`:

> Managed settings parse tolerantly. When a managed configuration contains an
> entry that fails schema validation, Claude Code strips that entry, records a
> warning, and enforces every remaining valid policy. A single typo cannot
> disable the rest of your organization's policy.

`:189` — "Security-enforcement fields are handled per field instead of being
stripped wholesale when they are present but invalid", with this table
(`:191`–`:199`):

| Field | Behaviour when present but invalid |
| --- | --- |
| `allowedMcpServers` | "Enforced as an empty allowlist, so no MCP servers are admitted until the value is fixed. An individual invalid entry is stripped and the valid subset is enforced." |
| `allowManagedMcpServersOnly` | "Treated as `true`." |
| `availableModels` | "Enforced as an empty allowlist… An individual non-string entry is stripped and the valid subset is enforced." |
| `enforceAvailableModels` | "Treated as `true`." |
| `forceLoginOrgUUID` | "No organization is permitted to log in until the value is fixed." |
| `deniedMcpServers` | "An individual invalid entry is stripped and the valid subset is enforced. A wholly invalid value is dropped with a warning, since denying every server would block servers the policy never named." |
| `sandbox.credentials` | "An individual invalid entry in `files` or `envVars` is stripped with a warning and the valid subset is enforced. A wholly invalid `credentials` value is dropped with a warning while the rest of `sandbox` still applies." |

`:201`: "`requiredMinimumVersion` and `requiredMaximumVersion` fail open by
design: an invalid value is stripped rather than enforced, so a bad policy push
cannot prevent Claude Code from starting."

`:203`–`:207` — validation errors surface in three places: an interactive
startup dialog listing the invalid entries, a stderr summary on headless `-p`
runs, and a `doctor` listing with source and field.

`:211` — **the boundary**: "This tolerance applies only to managed settings.
User, project, and local settings files remain strict: a file that fails
validation is rejected as a whole and reported."

`:113`–`:115` — the drop-in directory:

> File-based managed settings also support a drop-in directory at
> `managed-settings.d/` in the same system directory alongside
> `managed-settings.json`. This lets separate teams deploy independent policy
> fragments without coordinating edits to a single file.

> Following the systemd convention, `managed-settings.json` is merged first as
> the base, then all `*.json` files in the drop-in directory are sorted
> alphabetically and merged on top. Later files override earlier ones for scalar
> values, arrays are concatenated and de-duplicated, and objects are
> deep-merged. Hidden files starting with `.` are ignored.

## The divergence, verified on HEAD

`packages/shared/src/agent/pi-harness/managed-policy.ts` is **fail-closed on
everything**. `:205` throws `invalid managed Pi policy` if the object carries any
key outside the allowed set; `:213`, `:239`, `:281`, `:295`, `:368`, `:370`,
`:389`, `:406`, `:409` throw on individual malformed values. The abort reaches
startup.

That was a deliberate choice, recorded at `:69-74`: "FAIL-CLOSED: an entry that
parses to an inert form or cannot be enforced aborts startup exactly like every
other malformed key — an admin's rule that silently does nothing is worse than a
crash."

The documented contract is the opposite, and for a stated reason: one typo in a
fleet-wide policy push currently bricks every client at startup, which is a worse
outcome than the one the comment is defending against. **Change our behaviour to
match the documentation.** Keep the fail-closed *spirit* where the doc keeps it —
the table above tightens rather than drops for every security-enforcement field.

Do not touch user/project/local parsing (`:211`). Those stay strict. If a shared
helper serves both tiers, the tolerance must be a parameter of the managed call
site, not a change to the helper's default.

## Why this is split

R25's other half — remote delivery at sign-in, the fetch/cache lifecycle,
`forceRemoteSettingsRefresh`, and the withheld-env hardening — is deferred to
**R25b, which must come after R26**. The withheld-env rule
(`server-managed-settings.md:161-167`) is defined over proxy/TLS
(`NODE_EXTRA_CA_CERTS`, mTLS client cert/key), API routing, and credential
variables. R26 is the unit that gives us those variables. Writing the withholding
rule first would mean withholding a set that does not exist.

## Tasks

### Task 1 — a tolerant parse that reports what it dropped

`parseManagedPiPolicy` gains a tolerant mode used by the managed tier. It must
return the salvaged policy **plus a structured list of what was stripped**: the
field path, the reason, and the source file. Callers that abort today stop
aborting; a policy with one bad key now applies every other key.

The diagnostics record is the deliverable, not a log line — `:203-207` has three
consumers (startup dialog, headless stderr, `doctor`) and R30's `/doctor` slice
will read it. Shape it for that, and say in the commit body where it is exposed
today.

Unknown keys are the common case (`:205`'s allowed-set check): an unknown key is
stripped with a warning, never fatal. A policy written for a newer client must
still load.

**Commit:** `feat(policy): parse managed policy tolerantly and report drops`

### Task 2 — the per-field security table

Implement the `:191`–`:199` table against the keys we actually have. Mapping,
which you must verify rather than assume:

- `allowedMcpServers` — invalid whole value → **empty allowlist** (admit
  nothing). Invalid individual entry → strip it, enforce the valid subset.
- `deniedMcpServers` — invalid individual entry → strip. Invalid whole value →
  **drop the field**, because denying everything would block servers the policy
  never named. Note this is deliberately the opposite of `allowedMcpServers`;
  implementing them the same way is the likely mistake.
- `sandbox` credentials — invalid entry in the file/env lists → strip it; wholly
  invalid credentials block → drop that block, **rest of `sandbox` still
  applies**.
- Any boolean lock we own that corresponds to `allowManagedMcpServersOnly` /
  `enforceAvailableModels` (we have `allowManagedPermissionRulesOnly` and
  friends from P10) — invalid → **treated as `true`**, the tighter reading.
- If we have no analogue of `availableModels` / `forceLoginOrgUUID`, say so in
  the close-out rather than inventing the key here.

Our `claudeRules` compilation (`managed-policy.ts:281-298`) currently aborts on
an unparseable rule. Under the new posture an individual bad rule is stripped
with a warning and the rest compile. Keep the existing `no settings-source root`
check as a *strip* reason, not an abort.

**Commit:** `feat(policy): per-field handling for security-enforcement keys`

### Task 3 — version gates fail open

Whatever minimum/maximum version gate we carry (or none): an invalid value is
**stripped, not enforced**, so a bad push cannot stop the app from starting
(`:201`). If we carry no such gate, implement nothing and record that in the
close-out — do not add the keys speculatively.

**Commit:** `fix(policy): version gates fail open on an invalid value`

### Task 4 — the `managed-settings.d/` drop-in directory

Merge order and semantics exactly as `:115` states: base file first, then
`*.json` sorted **alphabetically**, later files win for scalars, **arrays
concatenate and de-duplicate**, objects deep-merge, and files whose name starts
with `.` are ignored.

Array concatenation is the part that will be got wrong — the natural
implementation replaces. It must union. Pin it with a test where two fragments
each contribute one deny rule and both survive.

A fragment that fails validation is subject to Task 1's tolerance, not to a
whole-directory abort.

**Commit:** `feat(policy): merge managed-settings.d drop-in fragments`

### Task 5 — close-out

Append per-task shas, real gate numbers, the key-mapping answers from Task 2, the
Task 3 answer, and where the Task 1 diagnostics record surfaces today.

**Commit:** `docs(plans): close R25a with gate evidence`

## Tests that must exist

- A policy with one unknown key applies every known key (the headline property).
- A policy with one unparseable `claudeRules` entry compiles the rest.
- `allowedMcpServers` invalid → nothing admitted; `deniedMcpServers` invalid →
  field dropped. The same fixture through both keys, asserting they differ.
- `sandbox` with a wholly invalid credentials block still applies the rest of
  `sandbox`.
- A user/project settings file with the same defect is still rejected whole
  (`:211` — the boundary must be pinned, or the tolerance will leak).
- Two drop-in fragments each adding one array entry → both present, deduped;
  `.hidden.json` ignored; alphabetical order decides a scalar conflict.

## Gate

Affected packages during the loop: the managed-policy suites, the permission/mode
suites that consume the policy, `storage-runtime`, plus `typecheck:all`, `lint`,
`git diff --check`. **This is a permission-decision and policy-enforcement
change — a listed immediate risk trigger.** Run the permission, sandbox and
policy aggregates once on the final diff.

Tests from the REPO ROOT. Running a suite from a package directory bypasses the
config-dir isolation preload and will destroy the real
`~/.nessy-agent/config.json`; a guard fails the run, do not work around it.

## Live cases for the planner (do not run these yourself)

1. Drop a policy file with one misspelled key: the app starts and the remaining
   policy is enforced (today it will not start).
2. The same file's stripped entry is reported to the user, not only to a log.
3. Two `managed-settings.d/` fragments each adding a deny rule: both enforced.

## Execution constraints

One commit per task with the subjects above; no `Co-Authored-By`; no push, MR or
tag; never `reset`/`rebase`/`amend`; pathspec-limited commits; no version bump or
release notes. Never `git checkout --` or `git stash` a file you are editing.
Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`.
You may edit this plan file.

Report any propagation of these gaps on other paths — do not fix it.

---

## Close-out

**Status:** executed on `fix/renderer`. Base at execution time was `e37592d9`,
not the `8083bc54` recorded above — HEAD moved during the session.

### Contract verification

`curl -sL https://code.claude.com/docs/en/settings.md` fetched and read at
`:113-115` and `:183-211`. **Every transcription in this plan is exact.** Three
omissions, none of them errors:

- `:185` continues past the quoted sentence with "Run `/doctor` to list stripped
  entries with their source file and field."
- `:187` (not quoted here) adds that the behaviour "is consistent across all
  three delivery mechanisms" and "Requires Claude Code v2.1.169 or later".
- The table's `availableModels`/`enforceAvailableModels` rows are gated
  `v2.1.175 and later`, and `sandbox.credentials` `v2.1.191 and later`.
- `:117` (not quoted here) adds "Use numeric prefixes to control merge order,
  for example `10-telemetry.json` and `20-security.json`" — implemented.

### Commits

| Task | SHA | Subject |
| --- | --- | --- |
| 1 | `6073c54a` | `feat(policy): parse managed policy tolerantly and report drops` |
| 2 | `f681708d` | `feat(policy): per-field handling for security-enforcement keys` |
| 3 | `e1f6921b` | `fix(policy): version gates fail open on an invalid value` |
| 4 | `a31562bd` | `feat(policy): merge managed-settings.d drop-in fragments` |
| 5 | this commit | `docs(plans): close R25a with gate evidence` |

7 files, +1255 / -123.

### Answer 1 — how our key set maps onto the documented table

The doc's table is three rules, not one, and our keys are classified by which
rule they are, not by name.

| Documented row | Our analogue | Behaviour when present but invalid |
| --- | --- | --- |
| `allowedMcpServers` | `allowedMcpServers` | empty allowlist (`emptied`) |
| — | `allowedPluginKeys`, `allowedChannelServers`, `allowedHttpHookUrls`, `httpHookAllowedEnvVars`, `sandbox.network.allowedDomains`, `sandbox.excludedCommands`, `sandbox.additionalWritableRoots` | empty allowlist — same grant rule |
| `deniedMcpServers` | `deniedMcpServers` | field dropped (`stripped`) |
| — | `deniedPluginKeys`, `disabledPermissionModes`, `sandbox.deniedReadRoots`, `sandbox.network.deniedDomains` | field dropped — same restrict rule |
| `allowManagedMcpServersOnly` (→ `true`) | `sandbox.network.allowManagedDomainsOnly` | `true` (`tightened`) — same polarity as the doc |
| `allowManagedMcpServersOnly` / `enforceAvailableModels` (→ `true`) | `allowPluginHooks`, `channelsEnabled`, `sandbox.allowUnsandboxedCommands` | **`false`** (`tightened`) |
| `sandbox.credentials` | `sandbox.network`, and `permissionDsl` / `claudeRules` as nested documents | invalid entry stripped; wholly invalid block dropped, rest of the parent still applies |
| `availableModels` | **none** | — |
| `enforceAvailableModels` | **none** | — |
| `forceLoginOrgUUID` | **none** | — |

Two things the plan asked to verify rather than assume:

- **The `useBundledCa`-style booleans are NOT in this tier.** `useBundledCa`
  lives on `networkProxy` in the USER `config.json`
  (`shared/src/config/types.ts:23`, written by the Appearance/Network settings
  page). It never reaches the managed policy, so the table does not touch it.
  The managed policy's own booleans are `allowPluginHooks`, `channelsEnabled`,
  `autoCompactEnabled`, `sandbox.allowUnsandboxedCommands` and
  `sandbox.network.allowManagedDomainsOnly`.
- **`allowManagedPermissionRulesOnly` does not exist.** The plan's Task 2 says
  "we have `allowManagedPermissionRulesOnly` and friends from P10". Searched the
  whole repo: no such key, and no P10 boolean of that shape. The switches listed
  above are what we actually carry.

The polarity point is the substance of the mapping. `settings.md:194`/`:196`
say "Treated as `true`" because both keys are phrased so `true` ENFORCES. Ours
are phrased the other way: `allowPluginHooks: false` denies, `channelsEnabled:
false` is terminal, `allowUnsandboxedCommands: false` locks strict sandbox mode.
Copying the constant would have LOOSENED all three. The implemented rule is the
enforcing pole, which is `false` for those and `true` for
`allowManagedDomainsOnly`.

`sandbox.excludedCommands` and `sandbox.additionalWritableRoots` are classified
as GRANTS even though `[]` looks like a no-op, because `resolveSandboxSettings`
treats a floor that names either key as the COMPLETE list — `[]` therefore caps
every later layer at nothing, which is the tighter reading.

`cleanupPeriodDays` and `autoCompactEnabled` are NOT security-enforcement
fields, so they are stripped rather than reinterpreted. There is no tighter
reading of a retention window that does not delete sessions nobody asked to
delete.

### Answer 2 — version gates

**We carry none.** No `requiredMinimumVersion`, `requiredMaximumVersion`,
`minimumVersion` or any admin-pushed value anywhere in the repo that refuses to
start the app on a version comparison. The nearest match,
`shared/src/agent/core/rtk-detector.ts:meetsMinVersion`, checks the version of an
external `rtk` binary found on PATH and disables that one integration; it is not
policy-delivered and does not gate startup. The planner's own audit
(`specs/2026-07-26-r-queue-doc-verification.md:697`) already lists both keys
among the admin keys our entry omits. **Neither key was added.**

What Task 3 did implement is `:201`'s rule applied to the only version-shaped
value the managed policy carries: a `schemaVersion` we cannot read is STRIPPED —
the document is dropped and the built-in policy is used — never enforced as a
refusal to start. Pinned for a newer schema, a stringified version, a fractional
one, `null` and absent, and pinned again at the loader, which is where the throw
used to escape into bootstrap.

### Answer 3 — where the diagnostics record surfaces today

**Nowhere user-visible. It is returned to the caller.** None of
`settings.md:203-207`'s three consumers exists here: there is no startup dialog
listing invalid entries, no headless `-p` stderr summary, and no `/doctor`.

Concretely: `loadManagedPiPolicyWithDiagnostics` returns `{ policy, drops }`,
and `createStorageRuntime` puts the list on
`StorageRuntime.managedPiPolicyDrops` so bootstrap holds it. Nothing reads that
field yet. R30's `/doctor` slice is the intended first reader, which is why the
record is per-entry with `{ source, field, reason, disposition }` rather than a
formatted string — `:207` wants source and field per entry, and with drop-in
fragments in play "which file" is the question an admin actually asks.
`loadManagedPiPolicy` is kept as a policy-only wrapper that discards drops, so
the two enforcement call sites did not churn.

### Decisions the plan did not make

1. **File-level defects stay fail-closed for the BASE file.** `:185`'s tolerance
   is about schema validation of entries. A file that is not JSON, is a symlink,
   is oversized, or is not exclusively host-owned has no entries to salvage, so
   `managed-pi-policy-invalid` still aborts there. Only schema-invalid entries
   became tolerant.
2. **Fragments are skipped, not fatal.** An unreadable or non-host-owned
   fragment, and a drop-in path that is not a host-owned directory, are recorded
   as drops and skipped. Aborting would reintroduce exactly the DoS this slice
   removes; skipping silently would be the other half of the bug.
3. **A wrong `schemaVersion` drops the whole document** instead of salvaging
   keys out of it. Reinterpreting a v2 document with a v1 parser would invent a
   policy nobody wrote.
4. **The merge runs on raw JSON, before parsing.** Merging parsed policies would
   concat one fragment's valid list onto another's enforced-empty `[]` and
   silently undo the allowlist emptying. Provenance is tracked through the merge
   so per-entry source attribution survives it.
5. **A stripped `claudeRules` string is removed from the reported
   `claudeRules`**, while generated rule ids stay keyed to the entry's ORIGINAL
   index so stripping one rule does not renumber the receipts around it.
6. **The drop sink moved to `shared/src/config/managed-drops.ts`** so
   `sandbox-settings.ts` can accept one without importing back from
   `agent/pi-harness/`.

### Boundary

`settings.md:211` is pinned by a test that runs the same defect through the
tolerant managed parse and through `parseManagedPiPolicyV1`, asserting the
second still throws, and through `parseWorkflowSettingsV1` — the one helper the
managed policy shares with the USER `config.json` layer
(`storage.ts:getUserWorkflowSettings`) — asserting it still rejects the layer
whole. `parseManagedSandboxSettingsV1` keeps a STRICT overload as its default
and only tolerates when the managed call site passes a sink.

### Gate evidence

All commands from the REPO ROOT.

| Check | Result |
| --- | --- |
| Baseline before any change (4 policy suites) | 57 pass / 0 fail / 242 expect |
| Focused policy suites on the final diff | **98 pass / 0 fail / 331 expect**, 4 files |
| Permission + sandbox + policy aggregates (`shared/src/agent`, `shared/src/config`, `server-core/src/{pi-harness,sessions,bootstrap}`) | **2717 pass / 3 skip / 2 fail / 8977 expect**, 282 files |
| `bun run typecheck:all` | clean, 0 errors |
| `bun run lint` | **0 errors** (122 warnings, all pre-existing, none in changed files) |
| `git diff --check` | clean |

The 2 failures are **pre-existing and unrelated**: `config path default-root
classification > treats an empty override as the default root`
(`shared/src/config/__tests__/paths-default-root.test.ts`) spawns a child with
`NESSY_CONFIG_DIR=''`, which trips the config-dir isolation guard. Reproduced
0 pass / 2 fail in a clean `git worktree` at `e37592d9` with no part of this
diff present.

### Propagation of the same gap elsewhere — reported, NOT fixed

1. **`server-core/src/bootstrap/headless-start.ts:347`** wraps
   `loadManagedPiPolicy().cleanupPeriodDays` in `try/catch { return undefined }`
   with a comment saying `createStorageRuntime` "loads it again and fails closed
   for real". That second half is now false: the runtime load no longer fails
   closed on a schema-invalid entry. The catch is harmless but the comment is
   stale, and the retention provider silently drops the managed value in cases
   that no longer abort.
2. **User-tier settings parses swallow their diagnostic.**
   `shared/src/config/storage.ts:getUserWorkflowSettings`,
   `getUserWorktreeSettings` and `getUserSandboxSettings` `catch { return {} }`
   — correctly strict per `:211` ("rejected as a whole") but NOT "and reported":
   nothing surfaces to the user. `getUserSessionMirrorSettings` does it right,
   logging to console. The drop record built here is the shape those three could
   reuse.
3. **`packages/shared/src/plugins/`** parses plugin manifests with the same
   all-or-nothing posture. Out of scope for R25a and not in `settings.md:185`'s
   managed-settings scope, but it is the same failure shape.
