# R25b — server-delivered managed settings

**Status:** ready for execution
**Parity row:** R25 (Ord 9), second slice. R25a and R26 are its prerequisites and both landed.
**Branch:** `fix/renderer`
**Base:** current HEAD (the plan's shas move; execute on HEAD)

## Contract source — quoted from raw markdown, with line cites

`curl -sL https://code.claude.com/docs/en/server-managed-settings.md` (274 lines).
**Fetch it yourself and re-read every cite.** This series shipped a wire contract
with three of four field names wrong because a plan and an executor each trusted
a `WebFetch` summary; that tool reconstructs "verbatim" text rather than
returning it. The last four executors each fetched the page and confirmed the
cites — repeat that, do not assume it.

`:147` — the lifecycle: "Claude Code fetches settings from Anthropic's servers at
startup and polls for updates hourly during active sessions."

`:151`–`:159` — first launch with no cache fetches asynchronously and **continues
without managed settings if the fetch fails**; subsequent launches apply the
cache immediately "except for the transport, routing, and authentication
environment variables described below", fetch fresh in the background, and
"Cached settings persist through network failures."

`:161` — **the hardening this slice exists for**, and the reason R26 came first:

> Claude Code withholds three categories of variables in the cached `env` block
> until the server confirms the payload for the session. This keeps a cached
> proxy, certificate authority, endpoint, or credential value from redirecting,
> intercepting, or re-authenticating the settings fetch that confirms the
> payload.

`:163`–`:165` list them: proxy and TLS (`HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, and
the mTLS client cert/key variables); API routing and provider selection
(`ANTHROPIC_BASE_URL`, provider-selection and provider-endpoint variables); and
authentication credentials (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`). `:167` — everything else in the cached `env` block,
"such as telemetry and OpenTelemetry configuration, applies at startup as
before. Once the fetch succeeds, the withheld variables apply for the rest of the
session." `:161` also scopes it: the hardening "applies only to the
server-fetched settings cache" — MDM and file-based managed settings are
unaffected.

`:179`–`:181` — the cache rules:

> The cache at `~/.claude/remote-settings.json` stores the salvaged payload with
> invalid entries removed. The raw invalid payload is never persisted.

> When no field in the payload can be salvaged, Claude Code keeps the
> last-accepted cached settings and records a fatal error.

> The security approval dialog evaluates the salvaged payload, so a stripped
> invalid entry is never presented for approval and never executes.

`:187`–`:189` — `forceRemoteSettingsRefresh: true` blocks startup until a fresh
fetch and **exits rather than proceeding without the policy**, and "This setting
self-perpetuates: once delivered from the server, it is also cached locally so
that subsequent startups enforce the same behavior even before the first
successful fetch of a new session." **`:199`** (this plan said `:197`; `:197` is
the closing fence of the JSON example at `:193`–`:197` — corrected against the
raw page during execution) — it is an **exception to the precedence rule**:
honoured when set in any admin-controlled managed source even if a cached server
payload exists. `:201` — the fetch sends `Cache-Control: no-cache` "so
intermediate HTTP proxies don't serve a stale response". `:205` — the auth
subcommands are exempt, so a user can re-authenticate when expired credentials
are why the fetch fails.

`:207`–`:222` — the **security approval dialog**. Four categories require
explicit approval before being applied (**`:211`–`:214`**; this plan said
`:209`–`:215`, where `:209` is the section's lead-in sentence and `:215` is
blank): settings that execute shell commands, environment variables outside the
known-safe allowlist, any hook definition, and managed `claudeMd` content. `:216`
— "If a user rejects the settings, Claude Code exits." **`:218`** (this plan said
`:219`) — when an interactive session cannot show the dialog, the delivered
settings are **not applied** and the last-approved settings are kept, with the
dialog appearing in the next session that can show it. `:221` — a non-interactive
run applies them **for that run only**: not recorded as approved, not written to
the cache, and re-fetched each run until a user approves interactively.

`:135` — server-managed and endpoint-managed both occupy the highest tier; "No
other settings level can override them, including command line arguments."
`:143` — clearing the server config does not clear client caches: "cached
settings persist on client machines until the next successful fetch."

## What is ours and what is Anthropic's

Do not port the Anthropic transport. **Our delivery point is the Nessy Gateway
sign-in we already own** — `ensureNessyGatewayAuth()` in
`packages/shared/src/auth/dp/`, the single facade both gateway cards call, which
already runs at authentication time and already owns a 0600 credential file. The
documented model is "clients fetch these settings automatically when users
authenticate" (`:9`); that is the shape to match, against our own endpoint.

**`~/.nessy/dp_auth_creds.json` is not the place to put settings.** AGENTS.md is
explicit that its shape is nessy-cli's contract and the `auth/dp` module is its
only writer. The settings cache is a separate file under the Nessy config dir,
following `:179`'s role — salvaged payload only, raw invalid payload never
persisted.

R25a already built the tolerant parser and the drop record this needs
(`parseManagedPiPolicyTolerantV1`, `ManagedDropSink`, `managedPiPolicyDrops`);
`:175` says delivered payloads "parse tolerantly with the same rules as the other
managed sources", so **reuse it — do not write a second parser.** R26 built the
proxy/CA/mTLS settings the withheld-env rule is defined over.

## Tasks

### Task 1 — fetch at sign-in, cache the salvaged payload

Fetch on the authentication path and cache. The cache stores the **salvaged**
payload with invalid entries removed and never the raw invalid one (`:179`);
when nothing is salvageable, keep the last-accepted cache and record a fatal
error (`:181`). Cached settings survive network failure and apply at startup
(`:157`). Send `Cache-Control: no-cache` (`:201`).

Mode 0600 on the cache file, atomic write, and never log the payload — it can
carry credentials.

**Commit:** `feat(policy): fetch and cache server-delivered managed settings`

### Task 2 — withhold the three variable categories until the payload is confirmed

The core security property. On a startup served from cache, the proxy/TLS, API
routing and credential variables in the cached `env` block are **withheld** until
a fresh fetch confirms the payload for this session; everything else applies
immediately (`:161`–`:167`).

Reason it through before coding, and put the reasoning in the commit body: a
cached `HTTPS_PROXY` or `NODE_EXTRA_CA_CERTS` that applied *before* the
confirming fetch could intercept that very fetch, so a single poisoned cache
would confirm itself forever. That is why the rule exists and why it is scoped to
the server-fetched cache only — MDM and file sources are physically protected
instead.

The withheld set is exactly the R26 surface plus routing and credentials. Name
each variable you withhold, and pin the list with a test that fails when a new
one is added to the cache without being classified.

**Commit:** `feat(policy): withhold transport and credential vars until confirmed`

### Task 3 — `forceRemoteSettingsRefresh`

Blocks startup until a fresh fetch; **exits** if it fails (`:187`). Self-
perpetuating: once delivered, it is cached so later startups enforce it before
any fetch succeeds (`:189`). It is an exception to precedence — honoured from any
admin-controlled managed source even when a cached server payload exists
(`:199`).

Provide our equivalent of `:205`'s exemption: a user must still be able to
re-authenticate when expired credentials are exactly why the fetch fails.
Without that, a credential expiry becomes an unrecoverable lockout. Say in the
commit body which entry points you exempted and why that set is complete.

**Commit:** `feat(policy): fail-closed startup on forceRemoteSettingsRefresh`

### Task 4 — the security approval dialog

Four categories need explicit approval before being applied (`:211`–`:214`):
shell-executing settings, env vars outside a known-safe allowlist, any hook
definition, and managed instruction-file content. Rejection exits.

Two rules that are easy to miss and both matter:

- The dialog evaluates the **salvaged** payload (`:181`), so a stripped entry is
  never shown for approval and never executes. Wire it after the tolerant parse,
  not before.
- A session that cannot show the dialog **does not apply** the settings and keeps
  the last approved ones; the dialog appears in the next session that can
  (`:219`). A headless run applies them for that run only, without recording
  approval or writing the cache (`:221`).

**Commit:** `feat(policy): approve shell, env, hook and instruction payloads`

### Task 5 — close-out

Append per-task shas, real gate numbers, the exact withheld variable list, the
Task 3 exemption set, and where the delivery endpoint lives.

**Commit:** `docs(plans): close R25b with gate evidence`

## Tests that must exist

- A poisoned cache carrying `HTTPS_PROXY` does not apply it before the
  confirming fetch, and does apply it after (the property, both directions).
- A cached payload with one invalid entry stores the salvaged form; the raw
  payload never reaches disk.
- Nothing salvageable → last-accepted cache retained, fatal error recorded, not
  a silent wipe.
- `forceRemoteSettingsRefresh` from an MDM-style file wins even with a cached
  server payload present (`:199`), and a failed fetch exits.
- The approval dialog never sees a stripped entry.
- A non-interactive run applies without recording approval or writing the cache,
  and the next interactive session still prompts.

## Gate

Affected packages during the loop: policy, config, auth/dp, plus `typecheck:all`,
`lint`, `git diff --check`. **This is credential handling, a permission decision
and a startup-blocking path — three listed immediate risk triggers.** Run the
policy, config, credentials and auth aggregates once on the final diff.

Tests from the REPO ROOT. A suite run from a package directory bypasses the
config-dir isolation preload and will destroy the real
`~/.nessy-agent/config.json`; a guard fails the run, do not work around it.

Never log a delivered payload, a token, or a credentialed proxy URL. Never write
to `~/.nessy/dp_auth_creds.json` — `auth/dp` is its only writer and its shape is
nessy-cli's contract.

## Out of scope

Per-group configuration (`:127` — not supported upstream either), `policyHelper`
and `wslInheritsWindowsSettings` (`:129` — OS-policy sources only), and a
`managed-mcp.json` equivalent over the wire (`:128` — deliver the
allow/deny keys instead, which R25a already parses).

## Live cases for the planner (do not run these yourself)

1. Sign in with a payload present: the policy applies without a restart.
2. Kill network, restart: cached policy still enforced, and a cached proxy
   variable is NOT in effect until the next successful fetch.
3. A payload with one bad key: the rest applies, the bad key is reported, and the
   cache on disk contains the salvaged form only.
4. `forceRemoteSettingsRefresh` with the endpoint unreachable: startup refuses,
   with a message that says how to recover.

## Execution constraints

One commit per task with the subjects above; no `Co-Authored-By`; no push, MR or
tag; never `reset`/`rebase`/`amend`; pathspec-limited commits; no version bump or
release notes. Never `git checkout --` or `git stash` a file you are editing.
Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`,
and leave `~/.nessy-agent/skills/r17-*` and `~/.nessy-agent/mcp/elicit-server.mjs`
alone — they are live CDP fixtures.

Report any propagation of these gaps on other paths — do not fix it.

## Close-out (2026-07-28)

Executed on branch `fix/renderer`. Plan base was `3afd37a3`; two docs commits
from a concurrent session (`78525294`, `85e022bc`) landed underneath during
execution and were left untouched — neither touches any file in this slice.

Contract re-read from the raw page before implementation
(`curl -sL https://code.claude.com/docs/en/server-managed-settings.md`, 274
lines). **Three of this plan's own cites were off and are corrected above:**
`:197` → `:199` (`:193`–`:197` is the JSON example and its closing fence),
`:209`–`:215` → `:211`–`:214` (`:209` is the section lead-in, `:215` is blank),
and `:219` → `:218`. Every other cite verified verbatim.

### Per-task commits

| Task | SHA | Subject |
| --- | --- | --- |
| 1 | `c98f65b6` | `feat(policy): fetch and cache server-delivered managed settings` |
| 2 | `34e69e2e` | `feat(policy): withhold transport and credential vars until confirmed` |
| 3 | `83ea6d80` | `feat(policy): fail-closed startup on forceRemoteSettingsRefresh` |
| 4 | `0c7acdfb` | `feat(policy): approve shell, env, hook and instruction payloads` |
| — | `1f1ff185` | `fix(policy): make delivery opt-in so sign-in never fetches unasked` |
| 5 | this commit | `docs(plans): close R25b with gate evidence` |

`1f1ff185` is not a fifth task. The first full aggregate run surfaced the
sign-in trigger making a real outbound request from library code — see
"Decided beyond the plan" below.

### Where the delivery endpoint lives, and the sign-in seam

`ensureNessyGatewayAuth()` was the right seam and is where it is wired. The
hook fires on **all three** of its success paths — env-bypass token, warm cached
creds, and a fresh dp login — not only the fresh one. A launch that takes the
warm cached-creds path (the common case) would otherwise never receive a policy.

Endpoint: `NESSY_MANAGED_SETTINGS_URL` =
`https://code-completion-nestor.tcsbank.ru/api/v1/cli/managed-settings`, a
sibling of the documented `/api/v1/cli/models` route, spelled out as its own
constant rather than derived from the chat prefix (same rule the token exchange
follows). Auth header `Nestor-Token`, plus `Cache-Control: no-cache` (`:201`).
`404`/`204`/an empty body mean "this org has no managed settings" — a successful
fetch delivering nothing, which `:143` makes the thing that supersedes a stale
cache.

Cache: `<CONFIG_DIR>/managed-delivery.json`, mode 0600, atomic tmp+rename.
`~/.nessy/dp_auth_creds.json` is untouched; `auth/dp` remains its only writer.

### The withheld variable list, and how each was classified

Rule: a cached variable is withheld when applying it **before the confirming
fetch** could change who that fetch trusts (`transport`), where it goes
(`routing`), what identity it presents (`credential`), or which binary answers a
shell-out (`execution`). Everything else applies immediately (`:167`).

| Category | Variables |
| --- | --- |
| transport | `ALL_PROXY`, `all_proxy`, `HTTP_PROXY`, `http_proxy`, `HTTPS_PROXY`, `https_proxy`, `NO_PROXY`, `no_proxy`, `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `CLAUDE_CODE_CERT_STORE`, `NESSY_DISABLE_BUNDLED_CA`, `CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY`, `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE` |
| routing | `ANTHROPIC_BASE_URL`, `ANTHROPIC_BEDROCK_BASE_URL`, `AZURE_OPENAI_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `AWS_REGION`, `NESSY_PI_MODEL_PROVIDER`, `NESSY_PI_MODEL_API`, `NESSY_PI_MODEL_BASE_URL`, `NESSY_SERVER_URL`, `NESSY_RPC_HOST`, `NESSY_RPC_PORT` |
| credential | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, `NESSY_DP_AUTH_TOKEN`, `NESSY_SERVER_TOKEN`, `NESSY_SANDBOX_SECRET`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GH_TOKEN`, `GITLAB_TOKEN` |
| execution | `PATH`, `NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES` |

Four additions beyond a literal reading of `:163`–`:165`, each deliberate:

- **the lower-case proxy spellings**, because `buildNetworkEnvVars` emits both
  and honouring half a proxy configuration is its own bug;
- **`NO_PROXY`**, kept with the rest of the triple rather than judged alone — a
  bypass list is part of deciding where a request goes;
- **`NODE_TLS_REJECT_UNAUTHORIZED`**, because the doc's list is prefixed "such
  as" and `:261` names disabled TLS validation as altering what the client
  receives;
- **the whole `execution` category**, which has no upstream counterpart:
  `resolveDpBinary` walks `PATH` to find `dp`, so a cached `PATH` plants a fake
  `dp`, which mints an attacker token, which authenticates the confirming fetch
  — exactly the effect `:161` names, through a mechanism Claude Code lacks.

`OTEL_EXPORTER_OTLP_*` are classified `immediate` explicitly rather than by
default, because `:167` names telemetry as the remainder. An unlisted variable
also applies immediately; its control is the approval dialog (`:212`), which is a
stronger gate than a delay.

The list is pinned twice. Each withheld category has a frozen membership test, so
membership only changes through a reviewed edit. And `buildNetworkEnvVars` —
R26's single decider of which variables carry the network trust chain — is driven
live with a fully-populated settings object, and every variable it emits must
classify as `transport`. A new network variable fails the suite until classified.

### The Task 3 exemption set, and why it is complete

`apps/cli` has no `auth` subcommand and the desktop app authenticates
in-process, so there is no separate binary to exempt the way `:205` exempts
`claude auth login`. A literal "exit on any fetch failure" would make expired
credentials unrecoverable: the fetch needs a JWT, the JWT needs a sign-in, and
the sign-in lives in the process that just exited.

The gate therefore classifies the failure instead of collapsing it. It asks one
question — did a fresh fetch succeed this session? — and can answer no for
exactly two reasons:

1. **No valid gateway credentials**, so no request could be made →
   `needs-authentication`. Startup continues, the sign-in banner path runs, and
   the gate re-runs the moment `ensureGatewayAuthForLaunch` produces
   credentials. It never exits.
2. **A request was made and failed** → `blocked`: an error dialog naming the
   endpoint and how to recover, then `app.exit(1)`.

There is no third cause, so completeness is by construction rather than by
enumeration. The corresponding call-site rule is that this repo's `claude auth`
equivalents stay reachable inside a gated process:
`nessy:ensureGatewayAuth`, `nessy:cancelGatewayAuth`, `nessy:getGatewayJwt`, and
the silent launch probe `ensureGatewayAuthForLaunch`. The probe in particular
would deadlock the gate if it were itself gated.

### The renderer surface

**None was needed and nothing is stubbed.** The approval dialog is a native
`dialog.showMessageBox` in the main process
(`apps/electron/src/main/handlers/managed-approval-dialog.ts`). That is the
design, not a shortcut: the delivered `env` block is applied at startup, so the
question has to be answerable before the first window exists. A React surface
would have to wait for a window, which is `:218`'s "cannot show the dialog"
state — the fallback, not the happy path. The modal renders field names,
categories and counts, never a delivered value.

Two of the four approval categories have no carrier in our schema. Delivered
`hooks` and `claudeMd` blocks are unknown keys the tolerant parser strips, so
they are "never presented for approval and never executed" by `:181`'s own
mechanism. That is pinned by test, so adding either key to the schema without
extending the classifier fails.

### Decided beyond the plan

1. **`1f1ff185` — delivery is opt-in.** The plan says to hook
   `ensureNessyGatewayAuth()`, which library consumers and test suites call
   routinely. Wired unconditionally, importing `auth/dp` made a real outbound
   request on every authentication in every embedder; it showed up as load-flake
   in an unrelated dp-broker test on the first full aggregate. The host now calls
   `setManagedDeliveryEnabled(true)` once. Only the implicit trigger is gated.
2. **An invalid `forceRemoteSettingsRefresh` is STRIPPED, not tightened.** Every
   other security switch in this policy tightens on garbage. This one must not:
   its tightened reading is "refuse to start", so a typo in a fleet-wide push
   would stop every client — what `:185` and `:201` both rule out.
3. **The salvage classification is measured on surviving settings, not on the
   drop count.** `disabledPermissionModes` is mandatory in this schema, so every
   document omitting it records a drop; a drop-count test would have read each
   legitimately empty payload as `:181`-fatal.
4. **The startup read verifies the approval digest.** The cache is only written
   for a payload that needed no approval or was approved, so a cached payload
   that needs approval and does not match its stamp was tampered with (`:254`);
   it is held back and the last approved settings are kept — `:218` applied to
   disk.
5. **With no approval gate wired, an approval-requiring payload is applied but
   not cached** (`:221`'s shape). Persisting it unstamped would write a payload
   the startup read then refuses — a cache that can only ever miss.
6. **`env` values reject a NUL** (it truncates at the exec boundary) and **no env
   drop reason ever carries a value**; a malformed key is reported by index
   rather than echoed.

### Gate evidence

Baseline on clean `3afd37a3` (worktree clean), same suite selection as the loop:
**598 pass / 3 skip / 2 fail** across 50 files. The 2 failures are
`packages/shared/src/config/__tests__/paths-default-root.test.ts` →
"config path default-root classification > treats an empty override as the
default root" (both cases). Pre-existing: the test spawns a child that inherits
`NODE_ENV=test` without `NESSY_CONFIG_DIR`, so `config/paths.ts`'s isolation
guard throws. Unrelated to this slice, and reproduced identically on the final
diff.

Final diff, policy + config + credentials + auth + electron-main-handlers
aggregates, from the repo root:

```
bun test packages/shared/src/config/ packages/shared/src/auth/ \
  packages/shared/src/credentials/ packages/shared/src/agent/pi-harness/ \
  packages/server-core/src/pi-harness/ apps/electron/src/main/handlers/
→ 1144 pass, 3 skip, 2 fail, 3740 expect() calls, 109 files, 68.10s
```

The 2 failures are the pre-existing pair above; no new failure.

`bun run typecheck:all` — clean (all 8 packages).
`bun run lint` — exit 0.
`git diff --check` — clean.

New coverage: `managed-delivery.test.ts` 20, `managed-env.test.ts` 15,
`managed-approval.test.ts` 16, `managed-refresh-gate.test.ts` 14,
`managed-approval-dialog.test.ts` 7, plus 6 env-block cases appended to
`managed-policy.test.ts` (51 in that file). Every "Tests that must exist" item
above is covered, both directions of the withholding property included.

Diff: 10 files changed, +3085 across the five commits (tests are 1131 of that).

### Propagation found, not fixed

1. **`buildNetworkEnvVars` precedence inverts the managed tier for
   `NODE_EXTRA_CA_CERTS`.** R26 treats any ambient value as "operator-provided"
   and lets a user-configured `tlsCaPath` win over it. A managed env block
   written into `process.env` therefore looks like an operator value and can be
   overridden by a user setting, which contradicts `:135` ("No other settings
   level can override them"). Changing R26's documented precedence is its own
   task.
2. **Hourly polling (`:147`) is not wired.** The interval constant and the
   rate-limit floor exist and `refreshManagedDelivery` is idempotent, so a timer
   is a one-liner — but no task asked for one and none was added.
3. **The headless server and CLI do not run the fail-closed gate.** The decision
   function is host-agnostic and returns a decision rather than exiting, exactly
   so a second host can wire it; only `apps/electron` is wired here.
4. **`disabledPermissionModes` records a drop whenever a policy omits it**
   (R25a). Correct given the field is mandatory in the strict parser, but it means
   every managed policy in the wild carries one drop that `doctor` will render as
   an invalid entry. Worth a look when R30 builds that surface.

### Live cases

Not run, per the plan.
