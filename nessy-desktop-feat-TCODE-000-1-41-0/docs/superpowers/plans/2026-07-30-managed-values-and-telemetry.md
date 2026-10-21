# Managed values that never arrive, and telemetry that leaves without asking — R25, R26, B2

From the completed 2026-07-30 re-verification (`2026-07-30-reverification.md`,
§ Final state). Three refuted rows, one theme: **a value the administrator set —
or never consented to — is handled correctly for nine hops and then betrayed at
the last one.** A retention window read from the wrong source, a TLS identity
erased by an unrelated save, and a telemetry exporter that starts on an ambient
environment variable.

All three root causes are located to the line and were verified first-hand by
the planner. Reproduce each falsehood first; then fix at the named line.

---

## 0. Method rules

1. **Fetch every doc page yourself with `curl -s`** —
   `server-managed-settings.md`, `network-config.md`, `monitoring-usage.md`.
   Never a summarising fetch tool; quote whole lines.
2. **Declared ≠ enforced.** Prove on **Pi**, the shipped default, and in BOTH
   hosts where the row spans hosts.
3. **`rg` skips NUL-containing files silently** — `grep -a` for absence claims;
   search the concept, not one guessed identifier.
4. **Two git commands** — pathspec on the `commit`, not only `git add`.
5. **A CDP dev instance may be on port 9223.** Do not kill or drive it.
6. **Run every test from the repository ROOT.** A package-directory run bypasses
   the config-dir isolation preload and destroys the user's real
   `~/.nessy-agent/config.json`.

---

## 1. Task 1 — the retention window reads the composed policy, in both hosts (R25)

**Commit:** `fix(config): managed retention is consumed from the enforced policy in both hosts`

`cleanupPeriodDays` was named verbatim in the R25c reopening as a key that is
"fetched, salvaged, approved, digest-pinned, cached, and then dropped". It still
is, one hop later than last time:

- The ONLY consumer is `readManagedRetentionDays()`
  (`packages/shared/src/config/storage.ts:418-424`), fed by
  `managedRetentionDaysProvider`.
- That provider is registered **exactly once** repo-wide:
  `packages/server-core/src/bootstrap/headless-start.ts:502-507`, as
  `() => loadManagedPiPolicy().cleanupPeriodDays` — the host-owned FILE, never
  `resolveEnforcedManagedPolicy()`. A delivered-only policy's retention value is
  therefore composed, pinned, cached, and ignored.
- The **desktop shell registers no provider at all** — `ensureConfigDir` (which
  runs the destructive sweep) is called only from `headless-start.ts:509`, but
  verify whether the electron main process runs any sweep path of its own; if it
  does, it runs with no managed value there either.

Fix:

- The provider must read the **enforced/composed** policy — the same resolution
  the rest of the managed surface uses — not the raw file. Mind lifecycle: the
  comment at `headless-start.ts:500` claims re-loading "fails closed for real";
  make the comment true of the composed source or fix the comment.
- Register the provider in the **electron host too** if any sweep or retention
  consumer runs there; if none does, say so in the report with the call-site
  evidence, and record it as a deviation instead of wiring dead code.
- `requiredMinimumVersion`/`requiredMaximumVersion` are file-only **by
  deliberate design** (`headless-start.ts:648-658`, electron `index.ts`) and
  unrecorded — do NOT build delivery for them; record the category string.
- **Add the test the shape-check suite is missing:** the zero-drop suite asserts
  key-set equality on the composed object; what is missing is a consumer test —
  a delivered-only policy's `cleanupPeriodDays` must reach
  `readManagedRetentionDays()`. That is the assertion that goes red if the
  provider reads the wrong source.

**Gate:** with a delivered-only managed policy carrying `cleanupPeriodDays: 5`
and no host file value, `readManagedRetentionDays()` returns 5 in the headless
host (and in electron if wired). **Mutation probe:** point the provider back at
the raw file → the new consumer test goes red.

---

## 2. Task 2 — a proxy save cannot destroy fields it does not carry (R26)

**Commit:** `fix(config): saving proxy settings preserves the TLS client identity`

`ProxyFormState` (`apps/electron/src/renderer/pages/settings/AppSettingsPage.tsx`)
carries six fields; `setNetworkProxySettings`
(`packages/shared/src/config/storage.ts:2396-2429`) does
`config.networkProxy = normalized` — a wholesale replace. So saving any proxy
toggle **erases** `certStore`, `clientCertPath`, `clientKeyPath`,
`clientKeyPassphrase` that an administrator configured out-of-band. No UI for
those four fields was in scope; their destruction was not.

- Fix at the **storage** layer: merge-preserve fields the incoming object does
  not carry (`undefined` = "not my field", not "delete"). This is the same
  contract `~/.nessy/dp_auth_creds.json` already follows — merge-preserve
  unknown keys — and for the same reason: more than one writer, disjoint
  ownership.
- Decide and state the explicit-clear story: if the UI someday needs to blank a
  field it owns, blanking must be expressible (empty string) without making
  `undefined` destructive.
- Check `toNetworkProxySettings`/`ProxyFormState` for whether the form should
  simply carry all fields instead — and say why you chose the layer you chose.
  **You MAY edit `AppSettingsPage.tsx`** for this task, but no other renderer
  file — another agent owns `FreeFormInput.tsx` and the send path.
- **Never log or echo a proxy URL or passphrase** — existing code in this
  function already refuses to echo URLs; keep that property in every new error
  path.

**Gate:** a stored config with all four TLS fields survives a six-field proxy
save byte-for-byte on those fields; disabling the proxy entirely still removes
the key only when every field including the four is blank (the existing
delete-branch semantics — read them before changing them). **Mutation probe:**
revert to wholesale replace → the preservation test goes red.

---

## 3. Task 3 — telemetry requires the documented opt-in (B2)

**Commit:** `fix(telemetry): usage export requires the opt-in and honors the disable`

`monitoring-usage.md:94`: `CLAUDE_CODE_ENABLE_TELEMETRY` — "Enables telemetry
collection (**required**)". `:95`: `OTEL_METRICS_EXPORTER` — "Use `none` to
disable". Neither exists anywhere in production code under any name.
`parseConfig` (`packages/shared/src/telemetry/usage-metrics.ts:258-281`) keys
**solely** on `OTEL_EXPORTER_OTLP_ENDPOINT` — an ambient variable in many
corporate shells set for other tools — so Nessy exports token and cost data
with telemetry never enabled and the documented off-switch inert.

- Gate the exporter on the opt-in: unset/false → no exporter, regardless of
  endpoint. Honor `OTEL_METRICS_EXPORTER=none` as a hard disable. Decide the
  Nessy-prefixed spelling pair the same way every other env var in this repo
  does (`NESSY_*` primary, `CLAUDE_CODE_*`/`OTEL_*` compat — follow the
  existing pattern in the codebase, and say which precedent you followed).
- Read `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` (per-signal override of the
  general endpoint, `:100`) and `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`
  (`:112`, default delta, accept `cumulative`) — the second is currently a
  hardcoded `const DELTA = 1`.
- The challenger also corrected the attribute story: the cost data point
  carries two attributes (`backend`, `model`), while `:442-452` say all
  metrics share standard attributes with `session.id` default-true and
  `user.id` "Always included". Bring the standard attributes in line with the
  page **or** record the narrower set as a deliberate privacy-preserving
  deviation — for a bank fork the narrower set is probably right, but then it
  must be recorded, not accidental.
- **This is an egress surface.** No new attribute may carry a path, prompt
  text, or credential; keep the existing serialised-flush/drain semantics
  intact (they were verified as correct — do not refactor them).

**Gate:** with `OTEL_EXPORTER_OTLP_ENDPOINT` set and no opt-in, zero export
attempts (assert at the transport seam, not by absence of logs); with opt-in
plus `OTEL_METRICS_EXPORTER=none`, zero; with opt-in and endpoint, export as
today; temporality flips the AggregationTemporality value. **Mutation probe:**
remove the opt-in gate → the ambient-endpoint test goes red.

---

## 4. Task 4 — what stays open

**Commit:** `docs(audit): category strings for the managed and telemetry surfaces left open`

Category strings — the version pins (Task 1), the attribute-set decision
(Task 3) if recorded as deviation, and anything else you leave. Unwrapped,
unbolded, backtick-terminated, no inline backticks in the reason, under 400
characters.

### 4a. What this plan leaves

Four strings, each measured against the code as committed. The first two are
deliberate decisions now recorded rather than accidental; the last two are open
surfaces Task 3 scoped out — the fix landed on the usage-metrics exporter the
row named, and the logs signal and the non-OTLP exporter types stayed as they
were.

- documented, not implemented — settings.md:311 defines the requiredMinimumVersion and requiredMaximumVersion pins and server-managed-settings delivers managed settings remotely, but both hosts enforce the pins from the host-owned policy file only, deliberately: a version gate readable from the delivered cache would let a poisoned cache refuse app startup, so remote delivery for the two pins is withheld by design: `requiredMinimumVersion`
- documented, not implemented — monitoring-usage.md:442 has all metrics and events share standard attributes, session.id on by default per :446 and user.id always included per :452. Nessy usage-metric data points carry backend, model, type and cost_reporting only — a deliberate privacy-preserving narrowing for a bank fork: no per-user or per-session identifier leaves the operator's machine: `session.id`
- documented, not implemented — monitoring-usage.md:95 lists console, prometheus and otlp metrics exporter types. Nessy implements the otlp exporter and honors none as a hard disable; a selector naming console or prometheus creates no such exporter, and a list omitting otlp without saying none still exports over OTLP: `OTEL_METRICS_EXPORTER`
- documented, not implemented — monitoring-usage.md:94 makes the telemetry opt-in required for collection and the usage-metrics exporter now enforces it, but the Pi OTLP log exporter in server-core src pi-harness otlp-telemetry.ts still starts off the ambient endpoint variable alone; the same gate and the :96 logs none disable are still to be applied there: `OTEL_LOGS_EXPORTER`

---

## 5. Gate

Focused suites for every changed file; `bun run typecheck:all`; `bun run lint`;
`git diff --check`. Managed policy and telemetry egress are named risk
triggers — run the config and telemetry aggregates once on the final diff.
i18n parity/sorted if you add strings.

Expected pre-existing failures: `2026-07-29-known-failing-tests.md`. Reproduce
on a clean `git worktree`, never `git stash`.

## 6. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By`.**
- No push, MR or tags. No `reset`, `rebase`, `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- **DO NOT touch** `packages/server-core/src/sessions/SessionManager.ts`,
  `packages/shared/src/agent/pi-agent.ts`, `packages/shared/src/agent/base-agent.ts`,
  `apps/electron/src/renderer/components/**` (esp. `FreeFormInput.tsx`) — agent
  1 owns them. Nor `packages/session-tools-core/src/runtime/filesystem-isolation.ts`
  / seatbelt tests / pre-tool-use permission gate — agent 2. Nor
  `packages/shared/src/agent/pi-harness/managed-policy.ts`,
  `packages/pi-agent-server/src/context-categories.ts`,
  `packages/shared/src/config/network-address-guard.ts`,
  `packages/server-core/src/sessions/session-monitor-service.ts` — agent 3
  (false-surfaces). Your allowed renderer file is exactly
  `pages/settings/AppSettingsPage.tsx`. If a fix genuinely needs a locked file,
  land everything that does not and report the residual.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` (CDP fixtures).
- No version bumps, no release notes. Never write to `~/.nessy/dp_auth_creds.json`.
- **Never point a probe at a real external host or a real collector** —
  loopback stubs only, and never leave an exporter env var set in the user's
  environment after a test.
- Code, comments and commits in English.

## 7. Report

Commit shas; whether each falsehood reproduced before the fix; the doc line
each fix answers to, quoted whole; the provider's new source and both hosts'
registration story; the merge-preserve semantics chosen and the explicit-clear
story; the opt-in spelling pair and the precedent followed; the attribute-set
decision; every correction to this plan; and all mutation probes with which
side went red.
