# CDP preparation — nine NCA cases written, fourteen BLOCKED rows classified

Branch `feat/TCODE-000`, two commits, HEAD **`34415d953`**:

- `82dbd47d6` — the nine cases and their shared lib (12 files, +2479)
- `34415d953` — a detector bug found in my own self-review (2 files, +101/−6)

Both verified with `git show --stat`, not `git diff --cached`; nothing outside `scripts/cdp/` was touched, and
another lane's `f05071054` landed between the two without interference. Nothing in
`docs/testing/cdp-live-checklist.md` was edited (the controller owns it).

*Toolchain note:* `/usr/bin/git` and `/usr/bin/python3` fail on this host with an Xcode-licence error
(environmental, needs the user's `sudo`). Everything below was run with `/opt/homebrew/bin` first on `PATH`;
no licence-error output was treated as a finding.

### Verification actually run

| Check | Result |
| --- | --- |
| `bun run tsc -p scripts/cdp/tsconfig.json` | exit 0 (twice — before and after the fix) |
| `cd scripts && npx eslint cdp/lib/nestor-cloud.ts cdp/cases/nca-*.ts cdp/run.ts cdp/harness.test.ts` | clean, no output |
| `git diff --check` | clean |
| `bun scripts/bun-test-lock.ts run --label NCA-detector -- bun test scripts/cdp/harness.test.ts` | **13 pass / 0 skip / 0 fail**, 118 `expect()` calls, 1 file, 5.19s (queued ~25 min behind `P2.226-wave`; no holder reaped) |
| case wiring, executed directly as well | 9/9 — modules import, `meta.id` matches filename, `drive` is a function, id present in `run.ts`; importing drove nothing |

### The bug the self-review caught (`34415d953`)

Worth carrying into the plan, because it is the exact failure mode the block was written against — and it was
in *my* code. `describeNestorQuota` joins `Quota:` and its limits with `\n`, but the info row renders as a
bare `<span>{content}</span>` inside a `flex items-center` div with **no `white-space` override anywhere in
`ChatDisplay.tsx`** (grepped), so CSS collapses the newlines and `innerText` returns one line:

```
Quota: - Daily [user] (allowed): 73% remaining - Monthly [user] (allowed): 91% remaining
```

The first detector was `/^- \S.*$/m` over `delta.split('\n')`, which scores that as **zero limit lines** —
NCA-7 and NCA-9 would have reported a failure about a budget the operator is looking at, on every run, and the
row would have read as a product defect. `textContent` (the `chatPaneText` fallback) keeps the newlines, so
both spellings reach a case. `quotaLimitLines` now splits on the bullet marker and is pinned by eleven
assertions covering both spellings, a bare `Quota:` head with nothing under it, and the four near-misses that
are each an `info` too.

**None of the nine cases was run, and none can be run here — every one needs a live corporate gateway.**
What was verified offline: they typecheck, they load, `meta.id` matches the filename, the wave runner and the
wiring test enumerate them, and every literal they assert on was read out of the shipping source rather than
transcribed from a summary.

---

## Part 1 — the nine owed NCA cases

New files:

- `scripts/cdp/lib/nestor-cloud.ts` — the wave's shared reads
- `scripts/cdp/cases/nca-1.ts` … `nca-9.ts`
- `scripts/cdp/run.ts`, `scripts/cdp/harness.test.ts` — the nine ids added

### The measurement that shaped every case in the block

Three facts, each measured against the source, each of which inverts an obvious detector. They are written
into `lib/nestor-cloud.ts`'s module doc so the next reader does not have to rediscover them.

**1. A `/quota` SUCCESS never reaches `getSessionMessages`; a `/quota` AUTH FAILURE does.**
`SessionManager`'s `case 'info'` (`SessionManager.ts:24074-24138`) persists a message only when it starts with
`Compacted` or carries `level: 'warning'`. `describeNestorQuota` yields the successful render as a plain
`info` and reserves `warning` for 401/403 and `missing-token` ("LEVEL policy (owner decision, T17 review)",
`backend/internal/nestor-quota.ts`). So a transcript-shaped detector for NCA-7 and NCA-9 finds **nothing when
the feature works and finds the failure when it does not**. Both cases read the rendered pane instead; the
renderer appends every `info` to its own session state (`event-processor/handlers/session.ts` `handleInfo`).

The same holds for `case 'status'`: NCA-6's retry lines are renderer-only and are dropped again on interrupt,
so NCA-6 watches the pane **while the turn runs** rather than reading it afterwards.

**2. "An info message appeared" is not "a limit rendered".** Every outcome of `describeNestorQuota` is an
`info` — a rendered budget, an empty limiter, an HTTP 500, a cancelled read. `classifyQuotaRender` separates
the five and only `limits-rendered` counts. Without it NCA-7 and NCA-9 would pass on a gateway answering 500.

**3. `this.debug` is an always-on log line.** `SessionManager` wires `agent.onDebug` to `sessionLog.info`
(`SessionManager.ts:16023,:16045`), so `NestorCloudAgent.postInit`'s fallback confessions are in the app log
on any run that has one. That is what makes NCA-3 possible at all — see below.

### Per case: what it proves, what stops a vacuous pass, what the operator must supply

#### NCA-1 — a live turn: text back plus one local tool executed and its result accepted
Creates a session on the cloud card (creation, not switching — `switchSessionRuntime` refuses a
`nestor-cloud-agent` target with `CONNECTION_NOT_SWITCHABLE`, which cost `q6-live.ts` a deterministic FAIL),
writes a probe file into the session's own working directory whose body is a per-run 20-hex token, asks for
the file's one line, and requires three things: a tool row whose **own `toolResult`** carries the token, the
model's reply carrying it, and the stored user message **not** carrying it.

*Vacuous worlds closed:* the model inventing the answer (the token is 20 random hex written seconds ago); the
token riding in on the prompt (the probe FILENAME is a second, different random value — a name built from the
token would put the answer in the question, and the case asserts both the filename and the composed prompt are
token-free); a remote-side tool satisfying the assertion (`server_tool_invocation` is decoded as a read-only
card, never an executable `tool_call`, and the file is on this disk only); a reused session's history (created
for the run, transcript asserted empty); another runtime answering (`composerCapabilities.connection.activeRuntime`).

*Operator needs:* a signed-in `nestor-cloud-agent` connection; a session working directory the case may write
one file into (it deletes it in a `finally`). Permission cards are expected — `bypassPermissions` is not one of
this runtime's modes — and are cleared by `approvePermissionsWhile`.

#### NCA-2 — the live stream's frame shapes are the ones the codec decodes
Reads the **app log, not the reply**, exactly as the checklist row instructs: zero occurrences of
`Unknown A2A stream envelope key`, `Skipped A2A part with no recognised content key`,
`Skipped server_tool_status with an unknown state`, `Skipped malformed server_tool_invocation part` — reported
verbatim with their `keys: [...]` payload when non-zero, because the key list IS the finding.

*Vacuous world closed:* an absence needs a positive control on the same rig. The control is the codec's own
`Nestor request id` info line (`event-adapter.ts:110`), emitted only after a decode, plus a grown transcript.
The zero-warning assertions only count once both hold; otherwise the case BLOCKS naming the three causes.

*Operator needs:* a signed-in cloud card **and an app log** — `nohup bun run electron:dev > /tmp/app.log 2>&1
& disown`, or `NESSY_CDP_APP_LOG`. **A packaged build writes no application log at all**, so this case cannot
be run against one.

#### NCA-3 — Plan/Act chips come from the LIVE agent card
The trap here is the reason the row exists. `KNOWN_REMOTE_MODES` (`agent-card-modes.ts:12-29`) maps a card's
`plan`/`act` onto options **byte-identical** to `NESTOR_CLOUD_MODE_OPTIONS` (`composer-capabilities.ts:11-28`),
the static fallback. For the ordinary card the composer state is the same in both worlds — **so reading
`modeOptions` cannot tell a live card from a dead parse**, which is precisely the world T2 shipped in.

The discriminator is `postInit`'s own confession — `Nestor Cloud AgentCard did not advertise composer modes` /
`Nestor Cloud AgentCard unavailable` — whose **absence** across the window containing this session's postInit
is the proof the card was read. The case therefore requires an app log and BLOCKS without one rather than
falling back to the mode list, because falling back to the mode list is the vacuous pass. When the card names
ids beyond plan/act the mode list discriminates on its own, and the case says which situation it was in.

*Operator needs:* a signed-in cloud card and an app log. Launch the app **before** the case so postInit is in
the window; the case opens the log first for that reason.

#### NCA-4 — a follow-up question reaches the user, and the next prompt answers THAT question
Two wrong detectors were ruled out by measurement:
- **`terminal_reason:tool_deferred` does not exist.** `tool_deferred` is not in `TERMINAL_REASON_NOTICE_VALUES`
  (`core/types/message.ts:1094`), so no verdict row is ever persisted for it. A case looking for one would
  report a failure about a feature that worked.
- **"the second reply looks like an answer"** is the failure the row exists to fix, in its own words.

The detector is the sidecar: `pendingTerminalTool: { toolCallId, name }` written by the parking branch
(`turn.ts:284-286`), and cleared only by answering the call it names (`context-store.ts:96-98`). After turn 1:
`name === 'ask_followup_question'`, and the question is the turn's last text. After turn 2: no
`pendingTerminalTool`, the **same `contextId`**, and the reply carries the marker the answer supplied.

*Operator needs:* a signed-in cloud card. If the model answers in prose instead of asking, the case BLOCKS —
it cannot make a model ask, and a red there would be a finding about the prompt. Re-runnable.

#### NCA-5 — `/clear` then a prompt: no prior history, and the sidecar is gone
Plants a token, then **establishes the recall control first**: a separate turn must repeat the token before
anything is cleared. Only a session demonstrably carrying context is allowed to prove something by failing to
carry it. Then `/clear` (selected from the palette, submits on selection), and three assertions: the
`Context cleared…` notice on the pane, the sidecar file **deleted**, and the next turn's sidecar carrying a
**different `contextId`** — which is what "a fresh cloud context" means on the wire.

*Vacuous world closed:* `requireSessionDir` runs first, because a wrong `NESSY_CONFIG_DIR` makes "the sidecar
is gone" true for every run ever made.

*Operator needs:* a signed-in cloud card, and `NESSY_CONFIG_DIR` exported to the dir the app was launched with
if it is not `~/.nessy-agent`.

#### NCA-6 — a rate-limited turn shows honest retry status and then completes
Watches the pane while the turn runs (the status rows are transient and renderer-only) and matches the
backend's own template, **em-dash included**, from its two producers (`turn.ts:206-210`, `:259-262`):
`Nestor rate limit — retrying in <N>s (attempt <A>/10)...`. The honesty claim is the counter: every retry must
name its attempt out of the real cap (`RATE_LIMIT_MAX_RETRIES = 10`) and no attempt may exceed it. Then the
turn must complete with an answer and no error row.

*Vacuous world closed twice:* the case refuses to spend a turn without `NESSY_CDP_NESTOR_RATE_LIMIT=1`, and
then re-checks the precondition against the gateway itself — `/quota` must report `exhausted` or `warning`
(`quota_handler.go:18` makes `status` the authority; the percentage is not). If it says `allowed`, a 429 is not
reachable and the case BLOCKS rather than reporting "no retry line" as a failure.

*Operator needs:* **a genuinely exhausted budget or an operator-side limit**, plus `NESSY_CDP_NESTOR_RATE_LIMIT=1`.
This is the one case in the block whose precondition cannot be created by anyone but the gateway owner.

#### NCA-7 — `/quota` on the default gateway AND on a custom-baseUrl connection
`resolveNestorQuotaUrl` takes the ORIGIN from the connection and keeps the path fixed
(`nestor-quota.ts:41-47`), so both origins must be exercised in one sitting: a run against the default alone
cannot distinguish "follows the connection" from "always the compiled-in URL". Each arm must reach
`limits-rendered`, and the two renders must differ.

*Vacuous worlds closed:* the classifier rejects `No quota limits apply…`, `Quota is unavailable: …`,
`Quota read was cancelled.` and `Quota is not available on this runtime.`; and if the custom baseUrl's origin
equals the default's, the two renders are legitimately identical and the case BLOCKS instead of passing.

*Operator needs:* a **second** `nestor-cloud-agent` connection pointed at a non-default Nestor origin, named
by `NESSY_CDP_NESTOR_CUSTOM_SLUG`.

#### NCA-8 — reasoning frames render as reasoning
`isIntermediate` survives to the stored message (`SessionManager.ts:23723`), and on this backend the
`data_type === 'reasoning'` branch is its only producer. The case requires at least one intermediate assistant
row **and** at least one non-intermediate one — the reasoning and the reply must be two different rows.

*Vacuous worlds closed:* a reused session's leftover row (session created, transcript asserted empty); the
reasoning row being the answer (the second requirement); and — the important one — an absent row being
reported as a product fault when the part was actually SKIPPED. When no intermediate row arrives the case
checks the log for `Skipped A2A part with no recognised content key` and, if present, FAILS on the skip (that
is the envelope drift the stricter gate exists to catch); if absent, it BLOCKS, because it cannot make a model
think out loud.

*Operator needs:* a signed-in cloud card. An app log is optional but recommended — without one the case cannot
tell a skipped frame from an absent one, and says so in its observations.

#### NCA-9 — `/quota` on the built-in Pi Nessy Gateway card; absent on BYOK
The positive half is the only live proof that `GET /api/v1/quota` answers for a CLI-proxy-authenticated user —
both unit suites inject a fake `fetchImpl`. Arms are picked by the shipping rule, not by slug:
`offersNestorQuota` is `provider === 'pi' && isNestorCliBaseUrl(connection.baseUrl)`, prefix
`https://code-completion-nestor.tcsbank.ru/api/v1/cli/`.

The negative half carries **three** detectors, because one is not enough: the state
(`excludedCommandIds` contains `quota`), the menu the user sees (`peekPalette` drives the app's own filter —
a state read alone would not catch a renderer ignoring the exclusion), and the seam (a TYPED `/quota`,
submitted as prose, answered `Quota is not available on this runtime.`).

*Operator needs:* **both** a gateway-prefixed Pi card (signed in) and a BYOK Pi card — `NESSY_CDP_PI_GATEWAY_SLUG`
/ `NESSY_CDP_PI_BYOK_SLUG` if the automatic pick is wrong. Missing either half BLOCKS: without the BYOK card
the run shows that the gateway card offers `/quota` but not that anything is excluded, which is the half the
row is about.

### Env vars the block introduces

| Var | Used by | Meaning |
| --- | --- | --- |
| `NESSY_CDP_CLOUD_SLUG` | NCA-1…8 | pin the remote-agent connection |
| `NESSY_CDP_NESTOR_CUSTOM_SLUG` | NCA-7 | the second, custom-origin remote connection |
| `NESSY_CDP_NESTOR_RATE_LIMIT=1` | NCA-6 | the operator's assertion that a limit is in force |
| `NESSY_CDP_PI_GATEWAY_SLUG` / `NESSY_CDP_PI_BYOK_SLUG` | NCA-9 | the two Pi arms |
| `NESSY_CDP_APP_LOG` | NCA-2, NCA-3, NCA-8 | the app log (default `/tmp/app.log`) |
| `NESSY_CONFIG_DIR` | NCA-4, NCA-5 | must name the dir the app was launched with |
| `NESSY_CDP_WORKSPACE_ID` | all | only when the profile has several workspaces |

---

## Part 2 — the fourteen BLOCKED rows, classified

(a) genuinely operator-owned · (b) harness-creatable today, the row is stale · (c) obsolete.
**None is (c): every feature under test still exists, with the symbols the cases name.**

| Row | Verdict | Evidence, and the one sentence the owner can act on |
| --- | --- | --- |
| RTS-4 | **(a)** | The Pro/Max card is hidden by owner decision 2026-08-15 (code retained). Needs a build with `NESSY_FEATURE_PROVIDER_CLAUDE=1` **and** an Anthropic subscription sign-in — a credential action the harness must not perform; a packaged run additionally needs lane K (credential-store machine id). Deferred, not inapplicable. |
| RTS-9 | **(b), fixture not yet written** | `when: 'always'` monitors still exist (`capabilities/resolver.ts:587`, `RuntimeCommandMonitorRegistration`) and a USER-scope activation is not refused — only a project-scope-only one is (`resolver.ts:2062-2068` → `project-scope-monitor`). A fixture can author a local marketplace + plugin with `experimental.monitors`; the operator installs it into the fixture config dir, the same step MCP-W1..3 already require. **Caveat to confirm on the first sitting:** the detector is `pgrep -f <sessionId>`, which assumes the monitor process's argv carries the session id — unverified. |
| RTS-10 | **(b), stale — the strongest find** | The case's block message sends the operator to the MCP-W plugin route, but the **RTS fixture already writes the precondition into the same config dir**: `seedProbeServer()` copies `echo-server.mjs` to `<root>/probe/echo.mjs` and registers it globally in `<configDir>/mcp.json` as `rts-echo`, `PROBE_TOOL_NAME = 'whoami'` — and that constant's own doc says *"The MCP server name RTS-10 drives, and the tool it calls on it"*. Only `NESSY_CDP_MCP_TOOL` has no default. Two-line fix (default it to `PROBE_TOOL_NAME`, correct the message). **Caveats:** `seedProbeServer()` runs only when `config.json` already exists (boot the app once, then re-run the fixture), and the guard is `!toolName \|\| mcp.length === 0` — the first sitting must confirm `rts-echo` surfaces in the capability catalog as an enabled MCP row. |
| CDX-ROLES | **(b)** | Two markdown files: `probe-role.md` (fresh `ZEPHYR-<8 hex>` in the BODY, no `tools:`/`disallowedTools:`/`permissionMode:` frontmatter, codeword absent from the description) and `probe-denied.md` (`tools: [Read, Grep]`) — spec at `VERIFICATION-STATE.md:75-81`; both are absent from `~/.nessy-agent/agents/` today (which holds only `cru-*.md`). **Case defect worth its own row:** `cdx-roles.ts:83` hardcodes `join(homedir(), '.nessy-agent', 'agents')` and ignores `NESSY_CONFIG_DIR`, so a fixture config dir cannot serve it as written. Also needs a codex-runtime connection and an app log. |
| AGT-4 | **(b) fixture / case debt** | Output style = `<configDir>/output-styles/*.md` → id `custom:<slug>` (`prompts/output-styles.ts:17,:586-628`); memory = `<configDir>/MEMORY.md` or `<workingDirectory>/MEMORY.md` (`memory-store.ts:58-64`). Both plain files under `NESSY_CONFIG_DIR`, so the reason string's objection ("it would write into the operator's own files") does not apply to a fixture tree. **But** `agt-4.ts:148` is a hard-coded failing check, and `report.ts:117` makes a failed check win over `BlockedError` — with all three env vars set this row becomes **FAIL, not PASS**. |
| AGT-5 | **(b), doubly stale** | Fixture = one markdown agent with `effort: high` in `<configDir>/agents/` (`definitions.ts:550`, rejected-if-invalid at `:572`). **And its terminal reason string is false today:** "no field of the Pi runtime snapshot carries [the effort]" is contradicted by `protocol/pi-harness-runtime.ts:174-175` (`effort`, `model` on the child record), `SessionManager.ts:4669`, pinned by `pi-harness-runtime.test.ts:42-67`; `lib/state.ts piRuntime()` already returns `raw`, so `raw.childState.children[].effort` is readable now. Terminal `blocked()` at `:90` is unconditional → cannot PASS as written. |
| AGT-6 | **(b) — the cleanest win of the six** | One gate, no terminal `blocked()`, no hard-coded false check: it can actually reach PASS. Fixture = `<configDir>/hooks.json` with a `UserPromptSubmit` and a `SessionStart` (matcher `compact`) command hook echoing the two markers; read at `native-sources.ts:1523`, and stdout-becomes-context is implemented for exactly those events (`hook-command.ts:315-360`). |
| AGT-7 | **(b) fixture + (a) UI drive** | Authoring a `userConfig` plugin bundle is what `fixtures/mcp-naming.ts` already does for a bundle, and **the "harness does not type secrets" objection is stale**: `plugin.manage({action:'configure', values})` is the same RPC the dialog calls (`channel-map.ts:212`, `handlers/rpc/plugins.ts:135-152`). `CLAUDE_PLUGIN_OPTION_<KEY>` is still emitted (`user-config-substitution.ts:93-97`, `mcpb-configuration.ts:234`, attached to hooks at `resolver.ts:1000,:2167`). The step-1/2 dialog claim stays a UI drive, and the terminal `blocked()` at `:114` is unconditional → cannot PASS. |
| AGT-8 | **(b) enforcement + (a) residues** | Two managed sources. The FILE source needs root (`managed-system-paths.ts:38-40`, uid-0 enforced at `managed-policy-loader.ts:85-88`) — operator. The DELIVERED source lives in the config dir: `<configDir>/managed-delivery.json` (`managed-delivery.ts:78-83`), and an `availableModels`-only payload needs **no approval** — `classifyManagedApproval` raises items only for sandbox/allow-rule/env categories (`managed-approval.ts:111-168`) — so a fixture can enforce an allowlist without root. Residues stay (a): the withdrawal half needs an app **relaunch** (the allowlist is fixed for the process lifetime, `managed-model-allowlist.ts:105-108`) and the harness attaches rather than launches; the toast half is a UI drive. Terminal `blocked()` at `:88` unconditional → cannot PASS. Enforcement itself is alive (`handlers/rpc/settings.ts:201-206` → `MODEL_RESTRICTED_BY_POLICY`, toast at `ChatPage.tsx:297`). |
| STR-2 | **(b), and the block names its own fix** | `CORRECTION_DELAY_MS = 6_000` is a bare module const (`str-2.ts:86`) and `longProsePrompt` is a harness-owned string (`mid-stream.ts:774-778`). Three levers, all harness-side: send the correction as soon as `waitUntilProcessing` returns (nothing about the claim needs 6 s — the case's own doc says it is "NOT a timing assertion"); lengthen the requested prose (must not induce a tool call, or the `:161` gate fires instead); or make the delay an env knob. `steer_undelivered` is fully alive (`claude-agent.ts:4218-4219`, `SessionManager.ts:24589-24608`). Residue (a): the live claude-runtime card, and the no-tool-call precondition, correctly modelled as a re-run condition. |
| CRU-1 | **(b)** | The ask rule is a plain `permissions.ask` array in `<projectDir>/.claude/settings.json`, `.claude/settings.local.json`, or `<configDir>/workspaces/<ws>/claude-config/settings.json` — the app redirects `CLAUDE_CONFIG_DIR` per workspace (`options.ts:226-260`) and passes `settingSources: ['user','project','local']` (`claude-agent.ts:1099`); the app itself owns a writer (`claude-settings-store.ts:119`). Nothing exists on disk today, so the current BLOCKED is honest. The only obstacle is the case header's self-imposed "the harness will not write the policy it measures" — a policy judgement, and by that argument SKL-P1's fixture also measures itself and it ships. |
| CRU-3 | **(b), stale/mislabelled** | Its only fixture precondition is the RTS trio, which `fixtures/runtime-switch.ts:106,:145` already seeds and which **both** `~/nessy-cdp-rts/config` and the operator's own `~/.nessy-agent/config.json` already carry. CRU-3 PASSED on 2026-08-17. The 2026-08-21 close-out recorded no case-specific reason; the reachable blockers are rig-shaped (multi-panel `:418`, narrow window `:534`, an expired dp JWT `:205/:211/:625`), none of which a fixture creates. **Could not determine which `blocked()` actually fired** — the close-out has only a blanket "fixtures/env, unchanged from history". |
| CRU-5 | **(b), stale** | Agent + skill are two markdown files (`<configDir>/agents/*.md` with `skills: [...]` parsed at `definitions.ts:555`; `<configDir>/skills/<name>/SKILL.md` at `native-sources.ts:1520`) — and **they are already on disk**: `~/.nessy-agent/agents/cru-skilled.md` (`skills: cru-house-marker`), `cru-plain.md`, and `~/.nessy-agent/skills/cru-house-marker/SKILL.md` carrying `MARKER=QUILL-VERBENA-8317`. The block is three unset env vars in the invocation (`NESSY_CDP_SKILLED_AGENT`, `NESSY_CDP_SKILL_MARKER`, `NESSY_CDP_SKILL_QUESTION`; optional `NESSY_CDP_PLAIN_AGENT=cru-plain`). |
| CRU-6 | **(a), with a (b) shell** | The agent files exist (`~/.nessy-agent/agents/cru-isolated.md`, `isolation: worktree`) and are fixture-creatable; forwarding is alive (`claude-runtime-agents.ts:616`). What actually stopped three sittings is (a): **no Claude card on this host both starts and finishes a delegated turn** — the gateway model sat at `executing` with an empty result past 300 s, and `claude-custom-2` 403s our own `mcp__session__*` tools — plus the operator's trust decision on a real repository. The checklist note "fixture: parent delegates both arms" describes the attempt-1 symptom that attempt 2 superseded. |

### The cross-cutting finding the row-by-row table hides

**Four of the fourteen cannot report PASS by construction**, so "unblocking" them is case work and not fixture
work: AGT-5 (`:90`), AGT-7 (`:114`) and AGT-8 (`:88`) end in an *unconditional* terminal `blocked()`, and
AGT-4 (`:148`) carries a hard-coded failing check which — because `report.ts:117` lets a failed check win over
`BlockedError` — would turn the row from BLOCKED into **FAIL** the moment its fixture arrived.

### Ordered by value to the owner's next gateway day

1. **RTS-10** — precondition already exists in the fixture; two lines and it is runnable.
2. **CRU-5** — artifacts already on disk; three env vars in the invocation.
3. **AGT-6** — one fixture file (`hooks.json`), and it is the only AGT row that can reach PASS.
4. **CDX-ROLES** — two markdown files, plus one small case fix so it honours `NESSY_CONFIG_DIR`.
5. **CRU-3** — probably not a fixture problem at all; re-run it with one content panel, a wide window and a
   fresh dp JWT before treating it as blocked.
6. **STR-2** — a timing constant in our own source.

---

## Things I could not determine

- Whether `rts-echo` surfaces in the capability catalog as an *enabled* MCP row — RTS-10's guard needs that as
  well as the env var, and it cannot be checked without the app running.
- Whether the monitor process for RTS-9 carries the session id in its argv (`pgrep -f <sessionId>`).
- Which `blocked()` actually fired for CRU-1 and CRU-3 on 2026-08-21.
- Whether the delivered-managed-policy route (AGT-8) has ever been exercised against a fixture config dir —
  the chain is read from source, not from a recorded run.
- Everything about the nine NCA cases' *behaviour*: they are unrun, and only a gateway day can change that.
