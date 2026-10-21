# B2 — Observability and cost

Parity row **B2**, the last of the three open rows besides B3 and R14.

Four things the row names: gateway correlation headers plus an
`ANTHROPIC_CUSTOM_HEADERS` equivalent; the full `modelUsage` map persisted with
an explicit cost-unsupported marker on Codex and Nestor; OTel interval flush and
shutdown drain; and token/cost counters **emitted from every shipped backend**.

**I checked the substrate before writing this**: there is no telemetry module —
`packages/shared/src/telemetry/` does not exist, and the `OTEL_`/`otlp` hits in
the tree are config keys, not an exporter. So the OTel half is greenfield. The
`modelUsage` half is not: `agent/backend/claude/event-adapter.ts` already reads
it, and its own comment says "result.modelUsage is cumulative; we need
per-message granularity" — read that before designing anything.

---

## 0. Method rules

1. **Fetch the pages yourself** with `curl -s`:
   `https://code.claude.com/docs/en/monitoring-usage.md`,
   `.../costs.md` if it exists, `.../agent-sdk/observability.md`,
   `.../analytics.md`. Take the page list from
   `curl -s https://code.claude.com/docs/llms.txt` rather than guessing URLs.
   **Never a summarising fetch tool** — it invented field names twice in this
   series and both inventions shipped.
2. **The quotation is the identifier, not the line number.** Report where you
   found each, and read the whole line — an executor recently reported a
   sentence deleted when it was the second half of the line it quoted.
3. **Read around each quotation.**
4. **Declared ≠ enforced.** A counter that exists and is never emitted is this
   row's own failure mode. Name the emission site and prove it runs on **Pi**.
5. **Two git commands** — pathspec on the `commit`.
6. Expected pre-existing failures:
   `docs/superpowers/specs/2026-07-29-known-failing-tests.md`. It has been short
   three times and wrong once in the other direction, so reproduce anything you
   call pre-existing on a clean `git worktree`, never `git stash`, and say which
   you observed.
7. **`rg` silently skips files containing a NUL byte; eight of ours have one** —
   tracker method note 11a. Use `grep -a` for absence claims.

---

## 1. Tasks

### Task 1 — correlation headers, and a custom-header channel

**Commit:** `feat(telemetry): correlation headers on gateway requests`

Establish from the docs what the header contract actually is, then implement it
for our gateway. `ANTHROPIC_CUSTOM_HEADERS` is Claude's env-var channel for
operator-supplied headers — find its documented shape and decide what our
equivalent is called and where it is read.

Two constraints that are not negotiable:

- **Never log a header value.** A custom-header channel is exactly where an
  operator puts a token. Log names, never values, and say in the report what you
  did about that.
- **The gateway rewrite is scoped by URL prefix on purpose** (`AGENTS.md`:
  Nestor-specific request rewriting must stay scoped to the verified gateway URL
  prefix). A correlation header must not leak onto a custom endpoint that merely
  shares a host.

**Gate:** a request built for the gateway carries the headers; a request built
for a custom endpoint on the same host does not.

---

### Task 2 — the `modelUsage` map, and an honest cost marker

**Commit:** `feat(telemetry): persist per-model usage with an explicit cost-unsupported marker`

Persist the full map, not a flattened total. Then the part that matters more:

**Codex and Nestor cannot report cost, and the row asks for that to be
*explicit*.** A zero, an absent field, or a silent omission all read as "this
turn was free". An explicit marker is the difference between "we do not know"
and "nothing was spent" — and this audit has closed four defects today whose
common shape was a UI stating something the backend never established.

Decide the marker's shape, put it in the persisted record and carry it to
whatever surface shows cost.

**Gate:** a Nestor turn's persisted record says cost is unsupported, and the
surface that renders cost does not render a zero for it. Assert both — asserting
only the record leaves the lie in the UI.

---

### Task 3 — OTel counters that actually leave the process

**Commit:** `feat(telemetry): token and cost counters with interval flush and shutdown drain`

Greenfield. Emit token and cost counters, flush on an interval, and **drain on
shutdown** — an exporter that loses the last batch on quit is the common bug
here, and the row names the drain specifically.

- **From every shipped backend.** Pi is the shipped default; Claude and Codex are
  flag-off but the code path exists. Report which backends emit and which do
  not, with a category string for any that do not.
- Decide what is *not* emitted and say so. Telemetry that carries prompt or tool
  content off the machine is a different product decision than telemetry that
  carries counts, and this is a bank fork. **Counts and identifiers only unless
  you can quote a doc line saying otherwise.**

**Gate:** a fake collector receives counters on the interval, and receives the
final batch after a simulated shutdown. **Never point a test at a real
collector.**

---

### Task 4 — what this row leaves

**Commit:** `docs(telemetry): the monitoring rows we do not implement`

Category strings. `analytics.md` and the managed/enterprise dashboards are
almost certainly `inapplicable` — say why rather than omitting them.

**Unwrapped, unbolded, backtick-terminated**, then confirm:
`python3 scripts/regenerate-deviation-register.py | grep -iE "telemetry|otel|cost"`.

---

## 2. Gate

Focused suites for every changed file, plus the agent-backend and server-core
bootstrap aggregates; `bun run typecheck:all`; `bun run lint`; i18n
parity/sorted if you add strings; `git diff --check`.

**Run every test from the repository ROOT.** A package-directory run bypasses the
config-dir isolation preload and destroys the user's real
`~/.nessy-agent/config.json`.

**Mutation probe:** remove the shutdown drain and the Task 3 drain test must go
red.

---

## 3. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By` trailers.**
  If a review finding forces an extra commit, take it and say so — four
  executors have now done that correctly rather than shipping a known bug.
- No push, MR or tags. No `reset`, `rebase`, `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- Pathspec on the commit itself.
- **Two other agents are working concurrently**: one in the isolation/sandbox
  code (`pi-harness`, `config/sandbox-settings.ts`, `server-core/src/pi-harness/`),
  one in `agent/backend/nestor-cloud/`. **Stay out of both.** If you need to touch
  `nestor-cloud` for the cost marker, put the marker in the shared type and let
  the other unit adopt it — say so in the report.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` (CDP fixtures).
- **Never log or export a token, header value, prompt, or tool payload.**
- No version bumps, no release notes. Never write to `~/.nessy/dp_auth_creds.json`.
- Code, comments and commits in English.

## 4a. What this row leaves

Recorded after execution. Line numbers are into the `.md` pages as fetched with
`curl` on 2026-07-29.

**Correction to § 0 first.** The claim that the OTel half is greenfield is wrong:
`packages/server-core/src/pi-harness/otlp-telemetry.ts` is a working OTLP/HTTP
**logs** exporter with a 278-line implementation, a 9.5 KB test, salted-HMAC
workspace/session hashing, and a `shutdown()` already awaited from
`SessionManager.cleanup()`. The parity audit this plan derives from names that
file at `2026-07-25-nessy-claude-parity-audit.md:1362`
(`otlp-telemetry.ts:13-20,101-127`), so the substrate check missed evidence the
row itself carried. What was actually missing is narrower and is what task 3
built: **metrics** (there were none), an **interval** flush (the log exporter
flushes on a `queueMicrotask`), and **emission from every backend** (the log
exporter's `emit` returns early unless the provider is Pi).

- `documented, not implemented — llm-gateway-protocol.md:78 and :79 define x-claude-code-agent-id and x-claude-code-parent-agent-id, each "present only on requests from an agent Claude Code spawned inside the session", to be used "with the session ID to attribute cost to parallel agents". Nessy emits the session header alone. There is no producer for either id: a Pi child session is its own subprocess carrying its own NESSY_SESSION_ID, and no agent config in this repo models a parent-agent relation at all, so both headers would be a constant. Wiring them means a parent-agent identity on BackendConfig first`
- `documented, not implemented — agent-sdk/typescript.md:4111 adds canonicalModel and provider to ModelUsage, and :4116 says both require Claude Code v2.1.218; canonicalModel "is the canonical model ID that the pricing lookup uses; it can differ from the raw model string that keys the entry". The installed @anthropic-ai/claude-agent-sdk typings declare eight fields and neither of those two, so the persisted per-model map is keyed on a raw model string that may be a provider ID or an alias with nothing to reconcile it against. It arrives with an SDK bump, not with our code`
- `documented, not implemented — monitoring-usage.md:472 through :479 list eight metrics. Task 3 emits the two the row named, token.usage and cost.usage. The other six have no counterpart: session.count, lines_of_code.count, pull_request.count, commit.count, code_edit_tool.decision and active_time.total. Each needs its own emission site rather than more exporter code, and lines_of_code and commit would need a diff and a git observer this app does not keep`
- `documented, not implemented — monitoring-usage.md:530 gives the cost and token counters a query_source attribute, "One of main, subagent, or auxiliary", and :533 to :538 add agent.name, skill.name, plugin.name, marketplace.name, mcp_server.name and mcp_tool.name with per-source redaction rules. Our data points carry backend, model, type and cost_reporting. The session layer sees a completed turn, not which subsystem issued each request inside it, so this needs attribution threaded down the turn rather than a new attribute`
- `documented, not implemented — monitoring-usage.md:446 to :455 define the standard attribute set every metric shares: session.id, app.version, app.entrypoint, organization.id, user.account_uuid, user.account_id, user.id, user.email, terminal.type, and OTEL_RESOURCE_ATTRIBUTES passthrough, each with its own OTEL_METRICS_INCLUDE_* toggle. Ours carries none of them, and that is a decision rather than an omission: this is a bank fork, :1277 says user.email "is included in telemetry attributes" when OAuth is used, and a per-user identifier on every counter is a different product than a per-backend one. A future operator who wants it should get the toggles, not a default`
- `documented, not implemented — monitoring-usage.md:106 to :110 define five content channels: OTEL_LOG_USER_PROMPTS, OTEL_LOG_ASSISTANT_RESPONSES, OTEL_LOG_TOOL_DETAILS, OTEL_LOG_TOOL_CONTENT and OTEL_LOG_RAW_API_BODIES, the last of which ":110" says carries "the entire conversation history". None exists here, and :1278 shows the doc's own default is the same as ours — "User prompt content is not collected by default. Only prompt length is recorded". Shipping the flags is a decision about what may leave a bank operator's machine, and nothing in this row asks for it`
- `documented, not implemented — monitoring-usage.md:144 opens the traces beta: CLAUDE_CODE_ENHANCED_TELEMETRY_BETA plus OTEL_TRACES_EXPORTER, a span hierarchy at :175 rooted at claude_code.interaction with llm_request, hook and tool children, tool spans splitting into blocked_on_user and execution, and TRACEPARENT propagated into Bash subprocesses. Nessy exports no spans of any kind. This is the largest single gap in the monitoring page and is a plan of its own, not a task`
- `documented, not implemented — monitoring-usage.md:605 through :1089 name twenty-three log events, from user_prompt and api_request to plugin_loaded, skill_activated, compaction and hook_execution_complete. The existing exporter emits six Pi-harness lifecycle events and only for Pi (otlp-telemetry.ts:13, and SessionManager.emitPiTelemetry returns early unless the provider is pi). Task 3 left that file alone on purpose: it belongs to the concurrent isolation unit's directory, and the metrics half needed none of it`
- `documented, not implemented — monitoring-usage.md:105 gives logs their own OTEL_LOGS_EXPORT_INTERVAL, "Logs export interval in milliseconds (default: 5000)". The pre-existing log exporter has no interval at all: scheduleFlush uses queueMicrotask, so a batch leaves as soon as the event loop turns and the variable is ignored. Task 3 added the interval on the metrics path only. Fixing the log path is a two-line change inside another unit's file`
- `documented, not implemented — monitoring-usage.md:95 makes OTEL_METRICS_EXPORTER a comma-separated selector over console, otlp, prometheus and none, and :481 describes a Prometheus scrape that drops the USD, tokens and s units so the text format stays valid. Ours is otlp-or-nothing, keyed off whether an endpoint is set. A console exporter is cheap; a Prometheus scrape endpoint is a listening socket in a desktop app and wants its own decision`
- `documented, not implemented — monitoring-usage.md:112 offers OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE, "Metrics temporality preference (default: delta). Set to cumulative if your backend expects cumulative temporality". Task 3 emits delta unconditionally, which matches the documented default and is what makes the shutdown drain load-bearing, but a backend that wants cumulative has no switch. Also unimplemented: the per-signal OTEL_EXPORTER_OTLP_METRICS_ENDPOINT and _PROTOCOL overrides at :100, and mTLS for the OTLP destination`
- `documented, not implemented — costs.md:32 shows the /usage screen's "Usage by model" block, one line per model with input, output, cache read, cache write and a dollar figure. Task 2 now persists exactly that breakdown on SessionTokenUsage.modelUsage, and no surface renders it: the usage overlay shows session totals plus the new cost verdict. This is a UI task with its data already in place, which is the cheapest row on this list`
- `documented, inapplicable — analytics.md:12 routes team reporting to two hosted dashboards, claude.ai/analytics/claude-code for Teams and Enterprise and platform.claude.com/claude-code for API customers, with a leaderboard, CSV export and a GitHub app for contribution metrics. All of it is Anthropic-operated infrastructure keyed to an Anthropic organization. Nessy sessions run against the T-Bank gateway and have no Anthropic org to report into, so there is nothing to implement and nothing to stub; the page's own escape hatch, at :24, is the OpenTelemetry export this row builds`
- `documented, inapplicable — costs.md:65 and :76 place organization cost control in Anthropic billing surfaces: Console workspace spend limits, per-member and per-group spend limits, usage credits, and the /usage-credits command that "isn't available with API key authentication" (:36). These govern an Anthropic account's money. The Nessy equivalent already exists and is ours: workspaceDefaults.maxBudgetUsd, enforced on the complete event in BaseAgent.exceedsMaxBudgetUsd. Adopting the documented surfaces would mean adopting Anthropic billing, not adding a feature`
- `documented, inapplicable — llm-gateway-protocol.md:95 describes a system-prompt attribution block that the api.anthropic.com endpoint "strips before processing when it arrives unchanged as the first system block", with CLAUDE_CODE_ATTRIBUTION_HEADER=0 to suppress it. The Nessy Gateway is an OpenAI-like endpoint, not an Anthropic Messages one, so no reader of that block sits behind our base URL and prepending one would put client-version text into the prompt of every gateway turn. On the flag-off Claude backend the native binary manages the block itself, out of our reach`

## 4. Report

Commit shas; the line you found each quotation at; **every correction to this
plan**; which backends emit counters and which do not; the cost-marker shape and
where it surfaces; what you deliberately do not export and why; the category
strings with proof they appear in the register; and the mutation probe.
