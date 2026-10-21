# Deviation Unit 4 — managed policy diagnostics and delivery lifecycle

**Status:** closed
**Source:** `docs/superpowers/specs/2026-07-29-deviation-worklist.md` § 3, Unit 4
**Branch:** `fix/renderer`
**Base:** `cf9f6b97` (Unit 2 close-out)

Eight rows, split at the diagnostics/delivery seam the worklist named. One
commit per row, except the missing-keys row, which is split because it carries
two independent features and one recorded deviation.

## Contract source — re-fetched raw

```
curl -sL https://code.claude.com/docs/en/settings.md                 # 1205 lines
curl -sL https://code.claude.com/docs/en/server-managed-settings.md  #  274 lines
curl -sL https://code.claude.com/docs/en/auto-mode-config.md
```

Load-bearing lines, quoted from the fetched files:

`settings.md:186` — the tolerance rule and the `/doctor` listing:

> Managed settings parse tolerantly. When a managed configuration contains an
> entry that fails schema validation, Claude Code strips that entry, records a
> warning, and enforces every remaining valid policy. A single typo cannot
> disable the rest of your organization's policy. Run `/doctor` to list stripped
> entries with their source file and field.

`settings.md:192`–`:200` — the security-enforcement per-field table, including
`availableModels` (`:196`, empty allowlist) and `enforceAvailableModels`
(`:197`, treated as `true`).

`settings.md:202` — the fail-open rule:

> `requiredMinimumVersion` and `requiredMaximumVersion` fail open by design: an
> invalid value is stripped rather than enforced, so a bad policy push cannot
> prevent Claude Code from starting.

`settings.md:204`–`:208` — the three reader surfaces: an interactive startup
dialog, `-p` headless stderr, and `claude doctor` "lists each invalid entry with
its source and field".

`settings.md:212` — the strict tier:

> This tolerance applies only to managed settings. User, project, and local
> settings files remain strict: a file that fails validation is rejected as a
> whole and reported.

`settings.md:241`, `:275`, `:286`, `:311`, `:312` — `availableModels`,
`enforceAvailableModels`, `forceLoginOrgUUID`, `requiredMaximumVersion`,
`requiredMinimumVersion`.

`server-managed-settings.md:135` — the precedence rule:

> Server-managed settings and endpoint-managed settings both occupy the highest
> tier in the Claude Code settings hierarchy. No other settings level can
> override them, including command line arguments.

`server-managed-settings.md:147` — "fetches settings … at startup and polls for
updates hourly during active sessions"; `:189` fail-closed startup; `:205` the
`claude auth` exemption; `:221` the non-interactive approval combination; `:240`
"the hourly background refresh is fail-open on both channels".

`auto-mode-config.md:226` — `classifyAllShell`; `:241` — what a client that
predates the key does: "Earlier versions ignore the key and continue to carry
narrow shell allow rules into auto mode."

### Cite drift found in the existing corpus

**Every pre-existing `settings.md:NNN` cite in this neighbourhood was wrong**,
and not by a constant. The fetched page has shifted since they were written:

| Region | Recorded | Actual |
| --- | --- | --- |
| drop-in directory / systemd merge / numeric prefixes | `:113`, `:115`, `:117` | `:112`, `:114`, `:116` |
| tolerance sentence | `:185` | `:186` |
| security-enforcement table | `:191-199` | `:192-200` |
| `allowedMcpServers` / `allowManagedMcpServersOnly` | `:193` / `:194` | `:194` / `:195` |
| `deniedMcpServers` / `sandbox.credentials` | `:198` / `:199` | `:199` / `:200` |
| version fail-open | `:201` | `:202` |
| the three reader surfaces | `:203-207` | `:204-208` |
| strict user/project/local tier | `:211` | `:212` |

So cites at or below `:117` were one too HIGH and cites at or above `:185` were
one too LOW — the page lost a line before the managed-settings section and
gained two inside it. A blind `+1` would have corrupted the first group.

`server-managed-settings.md` cites were checked line by line and are all exact;
none were changed.

The final commit resyncs every stale cite in the four files this unit owns
(`managed-policy.ts`, `managed-drops.ts`, `sandbox-settings.ts`,
`managed-policy-loader.ts`) plus their tests, each one verified against the
fetched page rather than shifted by a rule. Cites in files outside this unit
(`validators.ts`, `pre-tool-use.ts`, `auth/dp/index.ts`,
`managed-approval.ts`, `managed-refresh-gate.ts`, `apps/electron/src/main/`)
carry the same drift and are left for their owning units.

## The rows, in commit order

### Diagnostics

**`c11c70af` — `feat(managed): give the managed drop list a reader`**

`managedPiPolicyDrops` had three hits and zero consumers. `settings.md:204`–`:208`
names three surfaces and we had none. `createStorageRuntime` now prints the
summary at load — one site, so no host can forget it — which covers `:207` for
the headless server and gives the desktop shell a startup line.
`formatManagedPolicyDrop` is the named seam for `:208`'s `/doctor` listing;
R30b consumes it unchanged. Rendering strips the C0/C1/DEL/line-separator class
and caps length, because a drop's `field` is an arbitrary document key and its
`reason` can quote a 2048-character rule string, both on a path ending at a
terminal. Dispositions render as their effect, not their enum name: `emptied`
and `tightened` come from the `:192`–`:200` table where the entry is
reinterpreted, and "ignored" would tell an admin the opposite of what is
enforced.

**`e80fbcfc` — `fix(managed): a wrong schema stamp costs that entry, not the document`**

`schemaVersion !== 1` returned `DEFAULT_MANAGED_PI_POLICY`. `settings.md:186`
rules that out. Nothing is reinterpreted by continuing — every key is still read
by the same strict v1 parser — so what the old reading bought was exactly the
failure `:186` forbids. `settings.md:202` is the same rule from the other side.
Strict entry point unchanged (`:212`).

**`3fe51add` — `fix(config): report a rejected user settings layer instead of swallowing it`**

`settings.md:212` requires a rejected user/project/local file to be *reported*.
`getUserWorktreeSettings` and `getUserWorkflowSettings` were bare
`catch { return {} }`. `getUserSandboxSettings` was a different defect in the
same family: no try/catch and no validation, so the throw surfaced from
`resolveSandboxSettings` inside session construction. Tolerance is unchanged —
this tier stays strict; only the silence is gone.

**`f98127b7` — `feat(managed): accept autoMode.classifyAllShell and stop losing the block`**

Two defects at one entry point. The documented fifth field was refused, and
under tolerance the refusal cost the whole `autoMode` block. The key is now
parsed and carried; the block is parsed entry by entry.

### Delivery

**`36dcf25a` — `feat(managed): poll for delivered settings on the documented hourly cadence`**

`server-managed-settings.md:147`. No timer existed; the constant was a
rate-limit floor and the sign-in hook was the only producer. Fail-open (`:240`),
unref'd, idempotent, JWT read per tick.

**`a13bc633` — `feat(managed): run the delivery lifecycle in the headless hosts`**

`forceRemoteSettingsRefresh` was Electron-only, and worse: delivery is off by
default and the desktop shell held the only opt-in, so `nessy-server` had no
cache the gate could ever be satisfied by. The CLI inherits both halves because
`apps/cli/src/server-spawner.ts` spawns this server as a child, so one site in
`bootstrapServer` covers both hosts. Non-interactive approval per `:221`;
`blocked` throws and exits non-zero, `needs-authentication` warns and proceeds.

**`c6a7fade` — `fix(network): a managed extra CA outranks a user tlsCaPath`**

Measured inversion, `server-managed-settings.md:135`. A managed-origin registry
in `managed-env.ts` records by NAME which variables of this process came from a
managed source; the tier lands in `resolveTlsCaPathSelection`, the single
decision the subprocess projection and the Electron undici dispatcher already
share. An unmarked operator export still loses to a user `tlsCaPath` — pinned,
because without it the fix degenerates into "the variable always wins".

**`b0f42e6c` — `feat(managed): admin version gate and model allowlist`**

`requiredMinimumVersion` / `requiredMaximumVersion` implemented end to end and
wired in both hosts, failing open at all three points where the gate could be
wrong. `availableModels` / `enforceAvailableModels` parsed and carried with the
documented per-field invalid behaviour, plus `isManagedModelAllowed` and
`resolveManagedDefaultModel`.

## Deviations recorded

Each carries the audit rule's category string.

1. **The interactive startup dialog listing invalid managed entries** —
   `documented, not implemented — settings.md:206 wants a modal at startup
   listing stripped entries; we print the same content to the main log and to
   headless stderr instead. Cost: ~1 small slice in
   apps/electron/src/main/handlers/, alongside managed-approval-dialog.ts,
   which already owns a native startup modal.` The rendering half is shipped
   (`formatManagedPolicyDropSummary`); only the surface is missing.

2. **`/doctor`** — `documented, not implemented — settings.md:208's listing has
   no command because no /doctor command exists at all; R30b owns that surface.
   Cost: 0 for this unit — formatManagedPolicyDrop is the seam and renders the
   required source-and-field line today.`

3. **`autoMode.classifyAllShell` enforcement** — `documented, not implemented —
   the key is parsed, carried and composed (resolveAutoModeClassifyAllShell);
   the band it controls does not exist. auto-mode-config.md:226 suspends Bash
   and PowerShell ALLOW rules while auto mode is active, and our auto-mode gate
   consults the judge only for a result that already reached 'prompt'
   (pi-agent.ts:3612), so a narrow Bash allow rule never reaches the classifier
   in the first place. Accepted-and-inert is auto-mode-config.md:241's own
   description of a client that predates the key. Cost: 1 small slice in
   pre-tool-use.ts + pi-agent.ts — a new checkArgs field that downgrades a Bash
   or PowerShell 'allow' to 'prompt' when the mode is auto and the flag is set.
   Not taken here because pi-agent.ts is Unit 1's file this wave.`

4. **`forceLoginOrgUUID`** — `documented, not implemented — needs an
   organization identity our shipped provider does not have. The Nessy Gateway
   JWT carries jwt/expiresAt/username/userId (AGENTS.md, nessy-cli's contract)
   and no org UUID, so there is nothing to compare. The one provider that DOES
   capture one is Claude OAuth (oauthOrganizationUuid on LlmConnection, from
   auth/claude-oauth.ts:parseClaudeOAuthIdentity), and it ships only under
   NESSY_FEATURE_PROVIDER_CLAUDE, which is off by default. Cost: ~1 small slice
   for the Claude-OAuth-only check (compare parseClaudeOAuthIdentity's org uuid
   at SETUP_LLM_CONNECTION, refuse on mismatch, empty array fails closed per
   settings.md:286); the gateway half needs a gateway-side org claim that does
   not exist and is not ours to add.` No org concept was invented.

5. **`availableModels` enforcement at the selection sites** — `documented, not
   implemented — the keys parse with the full settings.md:196/:197 invalid
   semantics and the resolvers exist (isManagedModelAllowed,
   resolveManagedDefaultModel), but nothing consults them yet. The catalog
   choke point is getLlmConnections()'s connection.models, which every selector
   and every server-side helper (getMiniModel, getSummarizationModel,
   resolveGatewayFastModelId) reads; filtering there would round-trip through
   updateLlmConnection — which rebuilds connections from a hardcoded allowlist —
   and permanently destroy a user's model list. Cost: 1 medium slice: filter at
   the read boundary that feeds the UI and the session model authority, NOT at
   the persistence boundary, plus the subagent/skill/advisor tiers
   settings.md:241 names.`

6. **The `:206` dialog vs the `:218` deferral** — not a new deviation; the
   existing `managed-approval-dialog.ts` already implements `:218`/`:221` for
   the *approval* dialog. Only the *validation-error* dialog of `:206` is
   missing, which is deviation 1 above.

## Propagation found — reported, not fixed

**The delivered managed POLICY is never enforced.** `server-managed-settings.md:139`
— "Claude Code uses the first source that delivers a non-empty configuration.
Server-managed settings are checked first, then endpoint-managed settings.
Sources don't merge." Our delivered payload reaches exactly two consumers:
`applyManagedDeliveryEnv` (the `env` block) and `managed-refresh-gate.ts` (the
`forceRemoteSettingsRefresh` flag). `rg 'getManagedDeliveryState|loadCachedManagedDelivery'`
over non-test sources returns those two and nothing else. `createStorageRuntime`
builds `managedPiPolicy` from `loadManagedPiPolicyWithDiagnostics()` — the
host-owned FILE — only. So an organization that delivers `permissionDsl`,
`claudeRules`, `deniedMcpServers`, `sandbox` or `cleanupPeriodDays` through the
server has none of it enforced. This is a separate row from the four in this
unit and is not on the worklist; it should be added.

**`resolveTlsCaRuntime` and the main-process trust chain.** Fixed in passing by
this unit, because the managed tier landed in the shared
`resolveTlsCaPathSelection` rather than in `proxy-env.ts` alone. Recorded here
so a later reader knows the Electron undici dispatcher changed too.

## Gate evidence

Run from the repo root. Package-directory runs are refused by the config-dir
isolation guard and were not attempted.

```
bun run typecheck:all                       → clean (core, shared, server-core,
                                               server, session-tools-core,
                                               pi-agent-server, electron, ui)
bun run lint                                → 0 errors, 118 + 4 warnings (pre-existing)
bun run test:shared:all                     → 5 + 66 + 48 pass, 0 fail
bun test packages/shared/src/config/
     packages/shared/src/agent/pi-harness/
     packages/shared/src/auth/
     packages/shared/src/credentials/       → 975 pass, 2 fail
bun test packages/server-core/src/bootstrap/
     …/pi-harness/managed-policy-loader.test.ts
     …/sessions/__tests__/managed-sandbox-and-channel.test.ts
     …/handlers/rpc/__tests__/managed-files.test.ts
     …/handlers/rpc/__tests__/managed-resources.test.ts
     apps/electron/…/managed-approval-dialog.test.ts
                                            → 71 pass, 0 fail
bun test packages/server/src/               → 7 pass, 0 fail
```

The 2 failures are the same case twice (`config path default-root classification
> treats an empty override as the default root`), on the known pre-existing list
in the `paths-default-root` group. No other failure appeared.

### Behaviour probes on the final diff

```
D2 schemaVersion:2 + cleanupPeriodDays:45   → 45          (was: undefined)
D4 autoMode {classifyAllShell, allow}       → both kept, 0 drops
                                                          (was: autoMode undefined, 1 drop)
D1 drop summary                             → 2 managed settings entries were not applied:
                                                - /etc/nessy/managed-policy.json: schemaVersion — … [ignored]
                                                - /etc/nessy/managed-policy.json: disabledPermissionModes — … [ignored]
                                                          (was: nothing printed anywhere)
L3 managed CA vs user tlsCaPath             → /managed/org-ca.pem
                                                          (was: /tmp/user-ca.pem)
L4 version gate 1.9.9 vs min 2.0.0          → below-minimum
L4 version gate 'dev' vs min 99.0.0         → allowed      (settings.md:202 fail-open)
L4 availableModels: 'sonnet' (invalid)      → [] , isManagedModelAllowed('sonnet') = false
                                                          (settings.md:196)
```

## Pinned assertions rewritten

Seven, all of which pinned a contract the documentation contradicts.

| Test | Was | Now | Why |
| --- | --- | --- | --- |
| `managed-policy.test.ts` "a root that is not an object, **or stamped for another schema**, yields the built-in policy" | one wrong digit discards the whole policy | split: a non-object root still yields the default; a wrong stamp keeps the rest | `settings.md:186` |
| `managed-policy.test.ts` "the one version-shaped value we carry FAILS OPEN" | asserted `policy === DEFAULT` | asserts the rest of the policy still applies | failing open means the rest applies; asserting the default was asserting the defect enforced |
| `managed-policy-loader.test.ts` "a policy stamped for another schema does not stop the app from starting" | same, one layer up | keeps deny list and retention window | `settings.md:186` |
| `managed-delivery.test.ts` "nothing salvageable … records a fatal error" | fixture `{schemaVersion: 4, deniedMcpServers:['x']}` | a fixture where every delivered SETTING fails | the old one was unsalvageable only because of the whole-document drop; `server-managed-settings.md:181` is about settings |
| `managed-policy.test.ts` "rejects classifyAllShell — deferred, so strict-key must still refuse it" | pinned the refusal | pins acceptance + composition, with a BOUNDARY case keeping the strict parser throwing on a genuinely unknown key | `auto-mode-config.md:226`; the refusal cost the whole block |
| `managed-policy.test.ts` "every drop carries the source and field a doctor listing needs" | expected `autoMode` for a duplicated prose entry | expects `autoMode.allow[1]` | `settings.md:208` wants the entry, not the block |
| — | — | new: strict-parser BOUNDARY cases for the schema stamp and the autoMode block | `settings.md:212` must not drift with the tolerant path |

## Not in this unit

The worklist's § 3 Unit 4 also lists **"R1 — `defaultMode` + four managed-only
admin locks absent"** (`allowManagedPermissionRulesOnly`,
`disableBypassPermissionsMode`, `disableAutoMode`, `allowManagedHooksOnly`,
`defaultMode`). The execution brief for this unit did not enumerate it and its
enforcement lands in files two other units hold this wave —
`allowManagedHooksOnly` in the hook composition path (Unit 1's
`hooks-automation.ts` / `runtime-automations.ts`) and
`allowManagedPermissionRulesOnly` in the rule composition path (Unit 6's
territory). It is still open.
