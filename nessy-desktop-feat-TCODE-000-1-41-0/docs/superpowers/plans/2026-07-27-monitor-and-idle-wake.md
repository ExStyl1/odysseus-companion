> **CLOSED 2026-07-27.** Executed and verified in code; evidence in the parity audit §0 (R3).
> CDP pass 5 found every live call failing on a registration/dispatch name mismatch —
> that fix is the next plan's pre-phase Step 0, not a reopening of this plan.
> Kept until the end-of-series sweep. Do not execute again.

# Monitor and Idle-Session Wake (R3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `Monitor` — the event-streaming watch tool — in both documented source forms (`command`, `ws`), registered in the background-task registry we already own, with the documented SSRF guard, and with the idle-session wake that makes an event arriving between turns start a turn instead of being dropped.

**Architecture:** We already have the hard half: `bash_background` + `BashOutput` + `ProcessStop` are an owner-bound background-shell registry (`packages/session-tools-core/src/context.ts:383-386`, `tool-defs.ts:292-298`). `Monitor` is a *second producer* into that registry whose per-line stdout becomes a session event rather than a buffer to poll. The ws source is a new client with the same registry entry shape. Idle wake is a delivery-discipline change in the session layer, not a new transport.

**Tech Stack:** TypeScript, Bun test. `node:net`/`node:dns` for the address guard; the platform `WebSocket` global for the ws source (Bun and Electron both ship it — no dependency).

**Contract source:** `code.claude.com/docs/en/tools-reference.md` (Monitor), `agent-sdk/typescript.md` + `agent-sdk/python.md` (the full `MonitorInput`/output shapes), `channels-reference.md` (delivery discipline), `scheduled-tasks.md` (resume rule), `plugins-reference.md` (plugin monitors), `hooks.md` (`background_tasks[]`). Distilled in `docs/superpowers/specs/2026-07-26-r-queue-doc-verification.md` § R3 — **READ IT FIRST**; the queue entry was understated on four counts.

## Global Constraints

- Scope: Pi runtime + app. One commit per task; no `Co-Authored-By`; no MR/tags; never reset/rebase/amend; pathspec-limited commits only; do not touch `docs/superpowers/specs/` (you may edit this plan file); Implementation-First Verification Budget.
- **The R19 ordering question, decided here so you do not have to.** The doc-verification flags that the documented ws guard reads `sandbox.network.deniedDomains` and managed `allowManagedDomainsOnly`, which §0 had deferred to R19. Decision: **this plan lands those two keys** as an additive extension of the existing `SandboxSettingsV1` (`packages/shared/src/config/sandbox-settings.ts` — P10's schema, which today has `excludedCommands`, `deniedReadRoots`, `additionalWritableRoots`, `allowUnsandboxedCommands` and no network section) plus the managed-policy floor, because shipping a knowingly incomplete SSRF guard is worse than widening a schema R19 will extend further. R19 keeps the egress proxy, per-domain first-use approval, and the request-level policy.
- **`Monitor` is gated under the `Bash` permission name for the `command` source** (documented: "it uses the same permission rules as Bash, so `allow` and `deny` patterns you have set for Bash apply here too"). R1's rule parser now compiles those patterns — reuse the existing Bash gate path, do not invent a second one. The `ws` source has **its own approval prompt with no always-allow option**.
- **Monitor tasks are never restored on resume** (documented). A resumed session must show no phantom watches.
- **Two failure modes the upstream changelog records, both of which we would reproduce by default** — pin each with a test: (1) a monitor notification arriving before the user's first prompt must **never** derive the session title; (2) a background-task notification must **never** read as human approval of a pending action. Our system-reminder text already says so for other channels — reuse that exact framing rather than writing new prose.

---

### Task 0: Pre-phase — fold in R9 close-out follow-ups

- [x] **Step 1 (done):** Read the R9 close-out (audit §0 entry "R9"). Two follow-ups land near this plan:
  - **Pi's one-way lifecycle sink** — R9 found that `UserPromptSubmit`, `UserPromptExpansion`, `PostToolBatch` and `PreCompact` are emitted inside the Pi subprocess through a sink with no response channel, so a hook block on those four cannot be honoured on Pi (the Claude-SDK path honours all four). R9 flagged it as deserving its own R-item. **Do NOT build the request/response pair here** — but Monitor's idle wake needs a main→subprocess *delivery* path, so if the seam you add is reusable for that pair, say so in your report and name the file, so the planner can size the follow-up item correctly.
  - **A deny reason reaches the model unlabelled** (CDP pass 4) — routed to R30, not this plan. Do not fix it here.
- [x] **Step 2 (done — nothing to land):** Neither R9 follow-up touches a session-event or background-task file this plan edits: the one-way sink is `pi-agent-server`-internal emission and is explicitly not built here, and the deny-reason labelling is a tool-result presentation fix routed to R30. So no pre-phase commit.
  Recorded while reading: **R22 also routed a follow-up to R3** — `asyncRewake`. It is imported and stored today (`packages/shared/src/plugins/schema.ts:621-623`, `capabilities/resolver.ts:284`/`:892`) and pinned inert with a deferral diagnostic at `packages/shared/src/plugins/hooks-automation.ts:658-662` ("the idle-session wake half is deferred to the idle-wake mechanism"). This plan builds that mechanism but its task list does not include re-pointing the async-hook exit-2 path at it, so it stays deferred rather than being smuggled in; the report names the exact file and line so the planner can size it as its own item.

### Task 1: Re-verify the plan against current code

- [x] **Step 1:** Anchors re-verified 2026-07-27 at `8d2c5992`. Confirmed, with the four corrections below.
  - `packages/session-tools-core/src/tool-defs.ts:292-299` — `BashOutputSchema` / `ProcessStopSchema`, both keyed on `shell_id`; `:565` the `BashOutput` description, `:569` `ProcessStop`'s; registry rows at `:745-746`; `SESSION_TOOLS_REQUIRING_HOST_CALLBACK` at `:778`. **Confirmed.**
  - `packages/session-tools-core/src/context.ts:383-387` — `readBackgroundShellOutput` / `stopBackgroundShell` (the plan said `383-386`; the stop capability is `:387`). **Confirmed.**
  - `packages/session-tools-core/src/handlers/bash-output.ts`, `handlers/process-stop.ts` + their colocated tests. **Confirmed.**
  - `packages/shared/src/config/sandbox-settings.ts` — `SandboxSettingsV1` with exactly four keys, `SANDBOX_SETTING_KEYS:63`, `assertKnownKeys:80`, `resolveSandboxSettings:191` with its documented restricting/granting/boolean-lock floor rules. **Confirmed.**
  - `packages/shared/src/agent/pi-harness/managed-policy.ts:40` (`sandbox?: SandboxSettingsV1`), `POLICY_KEYS:141` incl. `'sandbox':152`, parsed at `:365` through `parseManagedSandboxSettingsV1`. **Confirmed — and it needs no edit for this plan:** the network keys ride the existing `sandbox` parse, exactly as R22 found for its own policy keys.

  **Correction 1 — the owner-bound registry is the ProcessSupervisor, not a subprocess call.** `readBackgroundShellOutput`/`stopBackgroundShell` are bound in `packages/shared/src/agent/pi-agent.ts:4442-4443` to `requestBashOutput`/`requestProcessStop` (`:5162`, `:5180`), which do **not** talk to the subprocess — they call `config.processSupervisorPort.read/stop` in the **main process**. The registry is `packages/server-core/src/pi-harness/process-supervisor.ts` + `process-store.ts` (`assertOwner:75`, `list:130`). `ProcessSupervisor.start` already accepts everything the `command` source needs: `background`, `persistent` (`deadlineAt = MAX_SAFE_INTEGER`), `timeoutMs`, per-chunk `onStdout`, `onClose(exitCode, signal)`, `semanticId`. So the command source is a `start` call, and a monitor `taskId` **is** a supervisor handle — `ProcessStop` keeps working on it with no identifier translation. Only the **ws** source needs a non-process registry entry, so only ws needs the stop handler extended.

  **Correction 2 — a new session tool is five files, not two.** Beyond `tool-defs.ts`/`context.ts`, a session tool must also land: a descriptor in `HARNESS_TOOL_DESCRIPTORS` and a binding in `PI_TOOL_BINDINGS` (`packages/shared/src/agent/pi-harness/harness-tool-descriptor.ts:102`, `:194`); the injection seam for its host capability (`packages/shared/src/agent/session-scoped-tool-callback-registry.ts` + `packages/shared/src/agent/session-self-management-bindings.ts`, the lazy-getter path `sendAgentMessage` uses); and the pinned surface contract (`packages/pi-agent-server/src/__tests__/harness-contract/fixtures/tool-surface.json` + the `pins all 37 session tools` test at `pi-harness-baseline.test.ts:406`, which asserts `SESSION_TOOL_DEFS` length parity).

  **Correction 3 — "the gate `bash_background` goes through" is a binding field, and the Bash matcher would silently not match.** `bash_background` is gated because `PI_TOOL_BINDINGS` gives it `permissionName: 'Bash'` (`harness-tool-descriptor.ts:197`), and the subprocess presents that string as the request's `toolName` (`packages/pi-agent-server/src/index.ts:1547-1553`). The host then evaluates with `toolName` + `semanticId: descriptor.id` (`pi-agent.ts:3545-3557`). **Both DSL bash matchers hard-require `toolName === 'Bash' || semanticId === 'bash'`** (`packages/shared/src/agent/pi-harness/permission-dsl.ts:580` and `:591`). So a `Monitor` presented under its own name would accept a `deny Bash(curl *)` rule into the compiled program and then never match it — the series' recurring "green on the path production does not use" defect, one line deep. Decision: keep `permissionName: 'Monitor'` (so `deny Monitor` works and the UI does not label a monitor "Bash", the way `bash_background` is labelled today at `backend/pi/event-adapter.ts:1010`) and widen those **two** matcher guards to admit `semanticId === 'monitor'`. One matcher, one path, both sources correct: a ws call carries no `command`, so `typeof command !== 'string'` already excludes it.
  The ws prompt's "no always-allow" is **not** expressible today: `PermissionRequest` (`packages/core/src/types/message.ts:584`) has no such field and `apps/electron/src/renderer/components/app-shell/input/structured/PermissionRequest.tsx`'s Always Allow button (the `<Button>` whose `onClick={handleAlwaysAllow}`) renders **Always Allow** unconditionally. Task 3 adds the wire flag, hides the button, and — the part that actually enforces it — ignores an `alwaysAllow: true` answer server-side.

  **Correction 4 — there is no generic out-of-turn event delivery, and the title guard does not belong at `generateTitle`.** The only existing out-of-turn producers are `armPiPluginPeripherals` (`packages/server-core/src/sessions/SessionManager.ts:2073-2120`), whose `canDeliver()` returns `undefined` unless `managed.isProcessing`, so **an event arriving on an idle session is dropped today** — that is the exact gap Task 5 closes — and `sendMessage` (`:12364`), which is the turn-starting path. Title derivation is the first-user-message branch at `:12570-12597` (`isFirstUserMessage && !managed.name && !managed.triggeredBy` → immediate slice + async `generateTitle`); `generateTitle:14534` and `refreshTitle:11560` are downstream. The guard therefore belongs at the **`:12570` branch**, not inside `generateTitle`. Grouped delivery hangs off `onProcessingStopped:13916` (step 5, where `processNextQueuedMessage` already runs).
  Also noted so it is not mistaken for prior art: `packages/server-core/src/pi-harness/plugin-monitor-service.ts` is a **cron-driven plugin resource reader**, not Claude's `command` monitor. It shares the name and nothing else, and B1 still owes the command form.

- [x] **Step 2:** Corrected in place — see the four corrections above; recorded in the Task 1 commit body.

### Task 2: The `Monitor` tool contract — schema, registry entry, `command` source

**Files** (revised by Task 1's corrections 1 and 2):
- Create: `packages/session-tools-core/src/handlers/monitor.ts`, `packages/server-core/src/sessions/session-monitor-service.ts` (the host-side runtime: gate → supervisor/ws → registry entry → event fan-out)
- Modify: `packages/session-tools-core/src/tool-defs.ts` (schema + description + registration + host-callback set), `packages/session-tools-core/src/context.ts` (the `monitor` port), `handlers/process-stop.ts` (monitor-first, then shell), `packages/shared/src/agent/pi-harness/harness-tool-descriptor.ts` (descriptor + binding), `packages/shared/src/agent/session-scoped-tool-callback-registry.ts` + `session-self-management-bindings.ts` (the injection seam), `packages/server-core/src/sessions/SessionManager.ts` (instantiate + register), `packages/pi-agent-server/src/__tests__/harness-contract/fixtures/tool-surface.json` + `pi-harness-baseline.test.ts` (pinned surface)
- Test: colocated tests next to the handler and the service, following `bash-output`'s test layout

**Interfaces** (documented shapes — implement exactly):

```ts
export const MonitorSchema = z.object({
  command: z.string().optional(),
  ws: z.object({ url: z.string(), protocols: z.array(z.string()).optional() }).optional(),
  description: z.string(),                       // REQUIRED
  timeout_ms: z.number().int().positive().max(3_600_000).optional(),   // default 300_000
  persistent: z.boolean().optional(),
});
// Output: { taskId: string; timeoutMs: number; persistent?: boolean }  — timeoutMs is 0 when persistent
```

- Exactly one of `command`/`ws` per call — both or neither is an input error, not a silent preference.
- `command`: one event per **stdout line**; the watch ends when the command exits, and the exit code is reported. stderr goes to the task's output record but does **not** emit events.
- `timeout_ms` default 300 000, max 3 600 000 (clamp, do not reject above-max — the doc gives a max, and our existing timeout code clamps; keep that house style and pin it with a test).
- `persistent: true` → no timeout; `timeoutMs: 0` in the result; ends only via stop.
- Registry entry carries `type: 'monitor'` and the documented fields for that type (`hooks.md` `background_tasks[]`: `id`, `type`, `status`, `description` capped at 1000 chars with an in-string `… [+N chars]` marker, and `server`/`tool` for monitor and MCP-task entries). Cap the description **once**, where the entry is built.
- Stopping: extend the existing owner-bound stop rather than adding a second stop tool. Keep `shell_id` working and accept a monitor's `taskId` on the same handler (one identifier space, documented in the description).

- [x] **Step 1: Write the failing tests:** exactly-one-source (both → error, neither → error); `description` required; each stdout line becomes one event and the events preserve order; a partial final line without a newline still emits on exit; the exit ends the watch and reports the code; `timeout_ms` above max clamps to 3 600 000; `persistent: true` yields `timeoutMs: 0`; the registry entry has `type: 'monitor'` and a 1000-char-capped description carrying the `… [+N chars]` marker; the existing owner-bound stop terminates a monitor and refuses a task owned by another session.
- [x] **Step 2:** Run the new suite — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS, plus the existing `bash-output`/`process-stop` suites unchanged. `bun run typecheck:shared` and the session-tools typecheck.
- [x] **Step 5:** Commit: `feat(session-tools): Monitor tool with the command source`

### Task 3: Permission gating for both sources

**Files:** the Monitor handler + whatever gate `bash_background` uses; the approval-prompt path for the ws source
- Test: gate tests beside the handler

- `command` source → the **Bash rules**, so an existing `deny Bash(rm *)` denies the same command inside a Monitor. Per Task 1 correction 3 this is the two matcher guards in `permission-dsl.ts` admitting `semanticId === 'monitor'` — the same compiled rules, the same matcher, no second implementation and no re-labelling of the tool.
- `ws` source → its own prompt, **no always-allow option** (documented). The prompt must name the URL. Denial = no socket, no registry entry, no side effect. Needs a `PermissionRequest` wire flag, the renderer honouring it, and the server refusing an `alwaysAllow: true` answer.
- Plugin-declared monitors (B1's form) run at hook trust level — do not build B1 here, but make the handler's authority injection shaped so a plugin monitor can be added without a second code path, and say in your report what B1 will need.

- [x] **Step 1:** Failing tests: a `deny Bash(curl *)` rule denies `Monitor{command: 'curl …'}` with the same reason a direct Bash call gets; an allow rule permits it without a prompt; a ws Monitor raises an approval whose payload carries the URL and offers no remember option; a denied ws Monitor leaves no registry entry.
- [x] **Step 2:** Implement. **Step 3:** Suites + typecheck. Commit: `feat(session-tools): gate Monitor sources under Bash and a ws-specific approval`

### Task 4: The ws source and its SSRF guard + the two network keys

**Files:**
- Modify: `packages/shared/src/config/sandbox-settings.ts` (+`network` section), `packages/shared/src/agent/pi-harness/managed-policy.ts` (floor), `packages/server-core/src/pi-harness/managed-policy-loader.ts` if it needs the key (R22 showed validation lives in the shared parser — check before editing)
- Create: `packages/shared/src/config/network-address-guard.ts` (pure, no I/O except an injected resolver)
- Modify: the Monitor handler (ws branch)
- Test: colocated for the guard; handler tests for the ws branch

**Interfaces:**
- `SandboxSettingsV1.network?: { deniedDomains?: readonly string[]; allowedDomains?: readonly string[]; allowManagedDomainsOnly?: boolean }` — `deniedDomains` composes as a **floor** (union across layers, tighter side wins) exactly like `deniedReadRoots`; `allowManagedDomainsOnly` is a restricting boolean, so it composes by OR (any layer may tighten it, none may unlock it) rather than the AND that fits the *granting* `allowUnsandboxedCommands`. **`allowedDomains` is a third key the plan did not name but the guard cannot work without:** "deny any host outside the managed allowlist" needs an allowlist to name, and the guard signature already takes `managedAllowlist`. It composes with the existing **granting**-key rule — when the floor names it, the floor's list is the complete list and no layer may add to it — so a managed lock cannot be widened from user settings. Without it `allowManagedDomainsOnly` could only ever mean deny-everything.
- `packages/server-core/src/pi-harness/managed-policy-loader.ts` needs no edit (R22's finding re-confirmed in Task 1: validation lives in the shared parser).
- `isDeniedNetworkTarget(host: string, opts: { resolve: (h: string) => Promise<string[]>; deniedDomains: readonly string[]; managedAllowlist?: readonly string[] }): Promise<{ denied: boolean; reason?: string }>`

Guard content (documented, all four clauses): deny private, link-local and cloud-metadata addresses; **deny hostnames that RESOLVE to one** (this is the clause a naive implementation misses — resolve before connecting and re-check every resolved address); deny hosts in `deniedDomains`; under `allowManagedDomainsOnly`, deny any host outside the managed allowlist.

ws behaviour: each text frame is one event; a **binary frame** is delivered as the literal placeholder `[binary frame, N bytes]`; a message over **1 MiB** ends the watch; the **close code** is delivered on socket close; errors surface before close.

- [x] **Step 1:** Failing tests for the guard — table-driven, injected resolver: `127.0.0.1`, `10.0.0.1`, `192.168.1.1`, `169.254.169.254` (link-local **and** cloud metadata), `[::1]`, `fd00::1`, a public address (allowed), a hostname resolving to `169.254.169.254` (denied — the clause that matters), a hostname in `deniedDomains`, a host outside the managed allowlist with `allowManagedDomainsOnly` (denied) and the same host with the flag off (allowed).
- [x] **Step 2:** Run — FAIL. Implement the guard, then the schema keys (strict-key parse, floor composition, one test that unknown keys still throw), then the ws branch.
- [x] **Step 3:** ws branch tests: a text frame becomes one event; a binary frame becomes the placeholder with the right byte count; a >1 MiB message ends the watch; the close code is delivered; a guard-denied URL never opens a socket.
- [x] **Step 4:** Suites + `bun run typecheck:all` (the schema is shared). Commit: `feat(session-tools): Monitor ws source with the documented address guard`

### Task 5: Idle-session wake and first-turn safety

**Files:** `packages/server-core/src/sessions/SessionManager.ts` — the delivery path (`armPiPluginPeripherals:2073`'s drop-when-idle, `onProcessingStopped:13916` for the grouped next-turn delivery) and the title guard at the first-user-message branch (`:12570`), per Task 1 correction 4
- Test: session-layer tests
- **No "no human input" framing exists yet** (Task 1: the repo has no such string; the nearest prior art is the `<system-reminder>` wrappers at `SessionManager.ts:12780` and `:13297`). So this plan writes it once, in the same `<system-reminder>` shape those two use, and every inbound task notification goes through that one function.

Documented discipline, three rules:
1. **Idle** (no turn in flight): the event **starts a turn** rather than being dropped.
2. **Busy** (turn in flight): events **queue in order** and are delivered **together as one group** on the next turn — not one turn each.
3. **Before the first user prompt**: the event is held as first-turn context, must **never** derive the session title, and must **never** read as human approval. Reuse the existing "no human input has occurred" framing verbatim.

Plus: monitors are **never restored on resume** — a resumed session shows no phantom watches and no stale registry entries.

- [x] **Step 1:** Failing tests: an event on an idle session starts a turn; three events during a live turn arrive as one grouped delivery in order on the next turn; an event before the first prompt does not set the title (assert the title is still unset/derived from the user's first message instead) and its delivery text carries the no-human-input framing; a resumed session has zero monitor registry entries even though one was running before the restart.
- [x] **Step 2:** Implement. **Step 3:** Suites + typecheck. Commit: `feat(sessions): idle-session wake with grouped delivery and first-turn safety`

### Task 6: Close-out

- [x] **Step 1:** Full gates: `bun run typecheck:all`, `bun run test:shared:all`, the server-core and session-tools suites, `bun run lint`, `git diff --check`.
- [x] **Step 2:** Mutation probes: (a) skip the resolve step in the guard so only literal addresses are checked → the resolving-hostname test must fail; (b) drop the grouped delivery so each queued event starts its own turn → the grouping test must fail; (c) let the pre-first-prompt event derive the title → that test must fail; (d) restore monitors on resume → the resume test must fail. Restore all four.
- [x] **Step 3:** Report: per-task shas, real gate numbers, deviations, probe results, and: (i) whether the main→subprocess seam you added is reusable for R9's `automation_event_request`/`response` follow-up, naming the file; (ii) what B1 needs for plugin-declared monitors; (iii) the CDP cases for the planning session — expected at least: a real `Monitor{command}` streaming lines into a live session, a denied ws URL never connecting, and an event arriving on an idle session starting a turn.

---

## Execution evidence (2026-07-27)

| Task | Commit |
| --- | --- |
| 0 | no commit — neither R9 follow-up touches a file this plan edits |
| 1 | `3c7d633b` |
| 2 | `6fc4fa21` |
| 3 | `b5f8a628` |
| 4 | `3b18badb` |
| 5 | `fd88c11b` |
| 6 | this commit |

**Gates (Task 6 Step 1).** `bun run typecheck:all` exit 0. `bun run test:shared:all`
exit 0 (aggregate 20 / 5 / 66 / 48 across its four packages, 0 fail).
`bun test packages/server-core packages/session-tools-core packages/pi-agent-server`
**1334 pass / 0 fail / 190 files**. Full repository wave `bun test`
**8185 pass / 18 skip / 0 fail / 750 files (200s)**. `bun run lint` exit 0
(4 pre-existing unused-eslint-disable warnings in files this plan does not touch:
`session-scoped-tools.ts`, `setupI18n.ts`, `debug.ts`). `git diff --check` clean.

**Mutation probes (Task 6 Step 2).** All four killed their target test and were
restored; the tree after restoration is byte-identical to the committed state.

| Probe | Mutation | Result |
| --- | --- | --- |
| (a) | hostname branch returns ALLOWED without resolving | **5 killed**, incl. `denies a hostname resolving to the cloud-metadata address`, `denies when ANY resolved address is blocked`, `the allowlist never rescues a blocked address class` |
| (b) | `deliverMonitorEvent` flushes even while a turn is in flight | **2 killed**: the grouped-delivery test and the queued-user-message-keeps-priority test |
| (c) | `foldHeldTaskNotifications` writes the group to `message` too | **1 killed**: `the held group rides modelMessage only` |
| (d) | `sweepRestoredMonitors` adopts the persisted record | **2 killed**: the service-level and session-level no-restore tests |

Note on probe (a): the first attempt made the guard deny-everything (10 kills),
which is the *safe* direction and therefore the wrong probe. Redone as
trust-the-hostname, the dangerous direction, which is what the 5 kills above
measure.
