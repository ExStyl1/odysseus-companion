# Surfaces the user can actually reach — R12, the OTLP log gate, R24's host half, B1's last inert surface

Four items, one theme carried over from the false-surfaces plan: **a mechanism
that exists, is correct, and cannot be reached from inside the product.**

## 0. Method rules

1. `curl -s` the pages: `https://code.claude.com/docs/en/settings.md`,
   `.../monitoring-usage.md`, and for elicitation the MCP spec page
   `https://modelcontextprotocol.io/specification/2026-11-25/client/elicitation.md`
   (Claude's `mcp.md` does NOT carry the URL-completion or `-32042` text — a
   sibling executor already established that; do not re-litigate it, but do
   read the spec page yourself). Quote whole lines.
2. **Declared ≠ enforced, and enforced ≠ reachable.** For each item, name the
   production caller. "It has a test" is not a caller.
3. **Many files here contain NUL bytes** — ALWAYS `grep -a` for absence claims.
4. **Two git commands** — pathspec on the `commit`. One commit per task.
5. **Run every test from the repository ROOT.** Check no other `bun test` is
   running before recording a failure — concurrent runs manufacture failures.
6. CDP may be on 9223 — do not kill or drive it. Do not run
   `electron:build:servers`.

## 1. Task 1 — retention is changeable and its pause is visible (R12)

**Commit:** `fix(config): the retention window is settable and a paused sweep is surfaced`

Verified first-hand by the planner: **both halves of R12's ✅ have zero
production readers.**

- `setRetentionDays` (`shared/src/config/storage.ts:530`) — callers: the
  definition and `retention-policy.test.ts:43`. Nothing else. So
  "minimum 1, `0` fails validation" is enforced where nothing can reach it,
  and **the destructive 30-day default cannot be changed or disabled from
  inside the product.**
- `getRetentionSweepStatus` (`:397`) — callers: one isolated test, inside a
  `Bun.spawnSync --eval`. No wire type in `packages/core/src`, no RPC handler,
  no i18n key, no renderer component. `settings.md:251`, second half of the
  fail-safe clause: a parse failure "pauses the retention cleanup sweep **and
  shows a warning in `/status`** until you fix the file". **The pause ships;
  the telling does not.** The file's own comment admits it and calls a UI panel
  out of scope — that scope call is what this task reverses.

Also confirmed by the challenger: the production load path uses
`StoredConfigTopLevelSchema` where `retentionDays` is `z.unknown().optional()`
(`validators.ts:146`), while the `z.number().int().min(1)` at `:119`/`:197`
belongs to the schemas an earlier close-out already flagged as test-only.

Build the reach:

- A settable path from the product to `retentionDays`, going through
  `setRetentionDays` so the validation finally guards something real. Follow
  the repo's existing settings-write pattern (RPC handler → storage writer);
  do NOT invent a second write route, and do NOT bypass the validator.
- Surface the paused-sweep warning. Our `/status` equivalent is whatever
  surface already reports config health — **look for it before adding a new
  one** (the doctor report, the settings health area, the existing warning
  channel). One consumer that a user can actually see is the bar; a second
  console.warn is not.
- **This is a destructive-operation control.** Disabling must be expressible
  and must mean "never sweep", not "sweep with a huge number". Whatever value
  means disabled, assert it in a test that names the destructive consequence.
- i18n: keys in every locale file, parity + sorted green.

**Gate:** a product-level change of `retentionDays` reaches
`readManagedRetentionDays`/the sweep and is rejected for `0`; a managed-policy
parse failure produces a warning a user-visible surface reports (assert
through that surface, not the record); disabling stops the sweep (probe the
sweep, not the flag). **Mutation:** bypass `setRetentionDays` in the new write
path → the validation test goes red.

## 2. Task 2 — the log exporter asks too (the B2 defect, one signal over)

**Commit:** `fix(telemetry): the OTLP log exporter honors the telemetry opt-in`

`server-core/src/pi-harness/otlp-telemetry.ts:154-155` still keys solely on
`process.env.OTEL_EXPORTER_OTLP_ENDPOINT` — exactly the defect just fixed for
metrics in `d99daff6`. An ambient endpoint variable in a corporate shell starts
shipping logs with no opt-in.

- Reuse the metrics gate's decision helper — **one predicate, both signals**.
  Read `shared/src/telemetry/usage-metrics.ts` for the spelling pair
  (`NESSY_ENABLE_TELEMETRY` primary, `CLAUDE_CODE_ENABLE_TELEMETRY` compat)
  and the `OTEL_METRICS_EXPORTER=none` handling; the logs signal has its own
  `OTEL_LOGS_EXPORTER` selector — read the page and honor `none` there.
- Check whether log records carry anything metrics do not: **a log line may
  carry prompt text, a path, or a header value.** If any field could, say so
  explicitly in the report and narrow it; egress of transcript content is a
  different severity from counters.

**Gate:** ambient endpoint with no opt-in → zero export attempts, asserted at
the transport seam; opt-in + `none` → zero; opt-in + endpoint → exports.
**Mutation:** remove the gate → the ambient test goes red.

## 3. Task 3 — the elicitation client handles what the server sends (R24 host half)

**Commit:** `feat(mcp): the client handles elicitation completion and the retry error`

The vendored MCP SDK 1.29.0 already ships `ErrorCode.UrlElicitationRequired`
(`-32042`) and `ElicitationCompleteNotificationSchema`, and **nothing in Nessy
consumes either** (`grep -a`, whole tree). Per the spec the completion
notification travels **server → client**, so what we owe is a HANDLER, not a
sender — a sibling executor's correction; keep it that way.

- Register a `notifications/elicitation/complete` handler in
  `NessyMcpClient` (`shared/src/mcp/client.ts`) beside the existing
  list-changed handlers. The spec's client rules are MUSTs: **ignore
  notifications naming unknown or already-completed ids** — implement that as
  the first thing the handler does, and test it, because a malicious or
  confused server sending arbitrary ids is the threat this MUST exists for.
- Catch `-32042` at the MCP response path and honor the documented retry: the
  error names the elicitations that must complete first; retry the original
  request after they do. Retry **once** per requirement set, and never retry a
  request whose elicitation was refused.
- **`pi-agent.ts` is LOCKED** to another executor (it holds the dialog
  runner). Land the client-side halves; if wiring the dialog resolution to the
  retry needs `pi-agent.ts`, write the exact edit it needs in your report as a
  residual, and make the client side correct for any caller that adopts it.

**Gate:** an unknown-id and an already-completed-id notification are both
ignored (no state change, no throw); a `-32042` response retries once after
the named elicitation completes and does not retry on refusal.
**Mutation:** drop the unknown-id guard → that test goes red.

## 4. Task 4 — `experimental.themes` stops being declared-but-inert (B1's last)

**Commit:** `feat(plugins): a plugin's declared theme is loaded or refused`

`experimental.themes` is the last B1 surface with no runtime — the exact
"declared identifier with no consumer" shape this whole audit is named after.
Read the plugins-reference section for it, then choose ONE and do it fully:

- If a theme can be loaded into our renderer theming, load it (path rules,
  containment validation, and the same activation/scope gating other plugin
  capabilities get).
- If our theming genuinely cannot accept a plugin-supplied theme, **refuse the
  key at normalization with a diagnostic** so an author is told at install
  instead of shipping a bundle whose theme silently does nothing — and record
  the category string. Refusing loudly is a legitimate outcome; staying inert
  is not.

State which you chose and why in the report.

**Gate:** whichever path — a fixture declaring a theme either applies it or
produces the diagnostic; a bundle without themes is unaffected.

## 5. Task 5 — category strings

**Commit:** `docs(audit): what these reachable-surface fixes leave open`

Unwrapped, unbolded, backtick-terminated, no inline backticks in the reason,
under 400 chars.

### 5a. What this plan leaves

Six strings, each measured against the code as committed. Three record decisions
that are now deliberate rather than accidental — the off switch that Claude has
no key for, the theme vocabulary we refuse instead of guessing, and the retry
that is a MAY we honour only when the server tells us it finished. Three record
surfaces these tasks scoped out and did not build.

- documented, not implemented — settings.md:251 gives cleanupPeriodDays no disabled value at all, only a minimum of 1 and a validation error on 0, and names an env var for skipping transcript writes as the nearest thing. Nessy carries its own boolean off switch beside the window because a destructive sweep needs an off that means never, not a window nothing has aged past yet: `cleanupPeriodDays`
- documented, not implemented — settings.md:251 puts the paused-sweep warning in /status. Nessy has no /status surface: the pause reaches the settings retention card and the nessy-general-agent doctor report, and a session that is already open is not re-notified when a settings file becomes unreadable mid-run: `/status`
- documented, not implemented — monitoring-usage.md:105 defines OTEL_LOGS_EXPORT_INTERVAL with a 5000ms default. The Pi log exporter flushes on a queued microtask per batch and drains on shutdown, so there is no interval to configure and the variable is read by nothing: `OTEL_LOGS_EXPORT_INTERVAL`
- documented, not implemented — monitoring-usage.md:96 lists console, otlp and none as logs exporter types. Nessy implements the otlp exporter and honors none as a hard disable; a selector naming console creates no such exporter, and a list omitting otlp without saying none still exports over OTLP: `OTEL_LOGS_EXPORTER`
- documented, not implemented — elicitation.md:408 asks clients to provide manual controls to retry or cancel the original request when a completion notification never arrives. Nessy waits five minutes, then rethrows the server error and leaves the retry to the model or the user re-issuing the tool call; there is no dedicated resume control: `notifications/elicitation/complete`
- documented, not implemented — plugins/components.md#themes-and-output-styles (was line 340 of the retired plugins-reference page) has plugin themes appear in /theme beside built-in presets, with :354's custom:<plugin-name>:<slug> selection and a read-only copy-to-edit path. A plugin theme's base preset and terminal color tokens have no defined mapping onto the Nessy web theme token set, so the declaration is refused with a diagnostic at install: `experimental.themes`

## 6. Gate

Focused suites per changed file; config + telemetry + mcp + plugins
aggregates once on the final diff; `bun run typecheck:all`; `bun run lint`;
i18n parity + sorted (Task 1 adds strings); `git diff --check`.
Destructive-operation controls and telemetry egress are named risk triggers.

Known-failing rows: `docs/superpowers/specs/2026-07-29-known-failing-tests.md`
— note `Pi harness R0 baseline > executes golden foreground and background
process contracts` (`isolationProfile "workspace"` vs `"networked"`) IS on that
list; do not re-diagnose it.

## 7. Constraints

- **LOCKED to a running sibling: `packages/shared/src/agent/pi-agent.ts`,
  `agent/core/pre-tool-use.ts`, `packages/server-core/src/sessions/SessionManager.ts`,
  `permission-service.ts`, `packages/shared/src/agent/claude-agent.ts`, and
  `apps/electron/src/renderer/components/**`** (it is sweeping the
  permission-prompt card consumers). Your renderer scope is
  `apps/electron/src/renderer/pages/settings/**` only. If a fix needs a locked
  file, land the rest and report the residual.
- One commit per task, subjects exactly as given. No `Co-Authored-By`. No
  push/MR/tags/reset/rebase/`--amend`/`checkout --`/stash of edited files.
  Restore mutation probes by re-edit or `.orig`, never git.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`.
  No version bumps or release notes. Never write `~/.nessy/dp_auth_creds.json`.
- **Never point a probe at a real external host or collector**; never leave an
  exporter env var set after a test; **never run the retention sweep against
  the user's real config dir** — temp dirs you created, always.
- Code, comments and commits in English.

## 8. Report

Commit shas; for each item the production caller that now exists, named; the
disabled-retention semantics and the destructive-consequence test; whether log
records can carry prompt text or paths; the spec lines for the two client
MUSTs, quoted whole; the themes decision and why; residuals for locked files
word for word; corrections to this plan; mutation probes with sides.
