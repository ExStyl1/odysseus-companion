# 2026-09-17 — measure sitting 1 (WAVE I-1, lane WI-f) on the packaged 1.39.0

The first sitting against the `measure:` rows the runtime-parity closure deferred on 2026-09-10 and the
integrations-and-authorization plan carries as `D1.*`. Batch 1 of roughly five.

**Build under test.** `release/mac-arm64/Nessy Desktop.app`, **1.39.0**, built by the controller from `b1f4f279c`.
Never rebuilt, never removed.

**Rig.** Port **9228**; `NESSY_CONFIG_DIR` and `--user-data-dir` under this lane's scratchpad, created per rig
(`rig-a`, `rig-b`, `rig-c`) and never under `~`. The owner's profile was never launched; `dp auth login` / `logout`
were never run; no token was read, printed or committed. The app was launched with `NESSY_DEBUG=1` and
`NESSY_PROXY_AUTH_DEBUG=1`. Every process this sitting started was killed at exit.

**The runtimes inside the artefact, read from the artefact.** Both claude self-reports were taken and they AGREE
(AGENTS.md asks for both, and records that they can part company): the packaged
`node_modules/@anthropic-ai/claude-agent-sdk-binary/claude` answers `2.1.251 (Claude Code)` to `--version`, and the
packaged `@anthropic-ai/claude-agent-sdk/package.json` says `"claudeCodeVersion": "2.1.251"`. The binary is
197 171 680 bytes, byte-for-byte the size of the vendored one in `node_modules/`.

---

## 0. Two rig facts this sitting paid for, before any row

**A case process needs `NESSY_CONFIG_DIR` too, or its file reads land in the OWNER's profile.** RS-32's first run on
this rig scored **FAIL** on its own negative control, and the reason was not the product: the case's runtime-session-log
read resolved `<config dir>` from ITS OWN environment, which had no `NESSY_CONFIG_DIR`, so it looked for the sidecar
under `/Users/<owner>/.nessy-agent/sessions/…` while the app was writing to the rig. The control's verdict came back
*"neither substituted nor refused"* — uninterpretable — and a lane that had not noticed would have recorded a product
finding. Exporting the same directory to the case process turned the same case into **PASS 8/8** on the next run.
The app's own `NESSY_CONFIG_DIR` is not enough; the case is a second process.

**A `keep` relaunch is not ready when CDP answers, and a fixed sleep is the wrong instrument.** Three runs were lost to
`electron-api-incomplete`, `composer-not-focusable` and `no-sessions` — each of which reads exactly like a product
defect — against an app that was still booting. The rig now polls for `window.electronAPI`, a composer (or the
onboarding, or an empty session list) and then settles, rather than sleeping a fixed number of seconds.

**And one reading that is a rig condition rather than a row.** Twice during the sitting the renderer showed its own
*"Failed to load sessions … Request timeout: sessions:get (30000ms)"* screen on a FRESH profile, with
`ERROR:…network_service_instance_impl.cc: Network service crashed, restarting service.` in the app log beside it. It
cleared on a relaunch both times. It is recorded here because a case running into it reports a CDP timeout, which is
indistinguishable from a hung renderer until the app log is read.

---

## 1. D1.14 — `/tasks` and `/workflows` (case `RS-46`, **PASS**)

**Premise at HEAD, re-taken first.** `parseSessionCommand`
(`packages/shared/src/slash-commands/session-command.ts`) matches a fixed table and returns `null` otherwise; neither
`/tasks` nor `/workflows` is in it. `git grep -acE "'/tasks'|'/workflows'" -- packages apps` answers **nothing at all**
over the tracked tree, against the positive control `'/help'` → **5 files**, which is what makes that an absence claim
rather than a failed grep.

**One correction to the row's own note.** P6.110 says the parser *"declares eight patterns"*, citing a line range of `session-command.ts` that no longer holds them. At HEAD
the parser returns **eighteen** distinct kinds (`advisor approve branch btw cd clear compact config diff heapdump help
hooks mcp quota recap resume status subtask`). The absence is unchanged; the count beside it is stale by more than
double, and a build sized against "eight" would be sized against a table that no longer exists.

**The live reading**, one Pi session on the `pi-api-key` card, packaged 1.39.0:

| token | palette row of that name | what answered |
| --- | --- | --- |
| `/help` (control) | **yes** — *Help / Show available slash commands* | consumed by the host: no assistant row in 46 s |
| `/status` (control) | **yes** — *Status / Show this session's endpoint, credential source and proxy* | consumed by the host: no assistant row in 32 s |
| `/tasks` | **none** | reached the MODEL: an assistant row plus a `tool` row *Running TaskList…* |
| `/workflows` | **none** | reached the MODEL: an assistant row |

So D1.14's premise is **confirmed on the packaged build**, and in its mildest form: the two names are not advertised
and not dispatched, so this is an absence rather than the advertised-then-refused shape P3.71 makes red. A build for
this row starts from nothing, not from a broken menu row.

**The detector that had to be replaced, and it is the transferable half.** The obvious one — *an `info` row lands in
the transcript* — is WRONG here. `/help` produced NO non-user row at all, so a case controlled on the info row scores
its own instrument a failure and can read nothing below it. Reading the chat pane's own text afterwards shows the help
listing IS on screen: the seam answers, and `getSessionMessages` does not carry it. The discriminator that survives is
the ASSISTANT row — *did the text reach the model* — which is exactly D1.14's question and is indifferent to whether
the seam's answer persists.

**And a palette match is a match on the row's FIRST WORD.** `peekPalette` returns each row's visible text INCLUDING its
description, so the first drive scored `/gsd-capture Capture ideas, tasks, notes…` as a row named `tasks` and
`/gsd-forensics … failed GSD workflows …` as one named `workflows`, and reported two false positives that read exactly
like a product defect.

---

## 2. D1.3 — the playground inside the packaged artefact (case `RS-47`, **PASS**)

Three readings, deliberately not one verdict.

**It ships.** `Contents/Resources/app/dist/renderer/` holds `index.html`, `playground.html`,
`browser-empty-state.html`, `browser-toolbar.html` and `assets/`, and the assets carry `playground-Ds5NsQMi.js` and
`playground-hiRtmWIC.css` — so the page ships with its own code, not as a shell. Read off the `.app`, not off
`electron-builder.yml`; `index.html` beside it is the control that the read is of a real renderer directory.

**No route reaches it.** `window.open('playground.html')` returned **null** and the app's page-target count stayed at
**1**. An anchor to the same href appended to the document and clicked did not move `location.href`.

**And the "one navigation away" clause is refused too — which is stronger than the row expected.** A forced
`location.assign('playground.html')` from inside the renderer left the window where it was, while the SAME forced
assign to the app's own entry with a `cdpNavProbe` query DID move it. That control is the whole arm: without it,
"the window did not move" is equally true of a probe that cannot see a navigation, because `location.assign` is
fire-and-forget and the read is taken five seconds later.

**So question 3 of the row — *what would the page hold if reached* — is NOT ANSWERED by this rig, and the case says so
rather than scoring it.** W8-x's source reading (`ensureMockElectronAPI()` installs only `if (!window.electronAPI)`, so
in an app window the playground would drive the REAL bridge) is not contradicted; it is simply not reachable from here.
The detector is written into the case for whoever does reach it, and it is not a key count — a fixture bridge has the
same shape by construction. It is `getSessions()` naming the session the case created seconds earlier.

**Stated residue.** The navigation control shares its PATH with the entry (same file, different query). So it separates
"this probe can see a navigation" from "it cannot", and NOT "a different file is denied" from "any navigation is
re-routed back". A later arm that wants the second distinction needs a third destination.

---

## 3. D1.13 — a Pi session Nessy did not create (case `RS-48`, **PASS**)

Ledger `F4/pi` has never carried a claim. The case plants a Pi sidecar under a session id the Nessy store has never
heard of, in the same workspace, and asks the product's own two surfaces about it.

| arm | reading |
| --- | --- |
| the plant | a COPY of a sidecar Pi itself wrote in this profile, 3 599 bytes, its token appearing **21** times |
| **control** — the product's own search finds a token it wrote itself | **1 hit** |
| the planted sidecar, same RPC, same run | **0 hits** |
| **control** — the session list is not simply empty | **10 sessions** |
| the session list carries the planted id | **no** |

So on the packaged 1.39.0 a Pi session created outside Nessy is **neither searchable nor browsable**, with both controls
standing. That fills `F4/pi` from a drive rather than from the host's abstention comment.

**Two design notes worth carrying to the next sitting.** The plant is a COPY with its strings token-suffixed rather than
a hand-written file: *"Pi wrote this"* is a claim about a FORMAT, and a malformed file the reader rejects scores exactly
like a reader that refuses to look. And the row's rig said *restart the app, then search* — read at HEAD the handler
calls `searchSessions(query, sessionsDir, …)` per call rather than consulting a boot-time cache, so the relaunch is
unnecessary and would only widen the failure modes. The bridge's own name for the surface is
`searchSessionContent(workspaceId, query)`, read off the live `window.electronAPI`: a guessed `searchSessions` would
have thrown for BOTH arms and they would have agreed for the wrong reason.

---

## 4. D1.11 — does the shipped claude binary HONOUR `DO_NOT_TRACK` and `DISABLE_TELEMETRY`

**MEASURED, binary tier — and the answer is yes, both are honoured.** For claude the vendored binary IS the artefact
and the strongest evidence obtainable, which is the distinction AGENTS.md draws between the two runtimes.

Occurrence counts over the PACKAGED binary at `2.1.251`, instrument named (`grep -aoF <needle> <binary> | wc -l`, i.e.
occurrences and not lines — on a minified file the two disagree by up to 4x):

| needle | occurrences |
| --- | --- |
| `DO_NOT_TRACK` | 14 |
| `DISABLE_TELEMETRY` | 10 |
| `CLAUDE_CODE_ENABLE_TELEMETRY` | 13 |
| `OTEL_METRICS_EXPORTER` | 12 |
| `OTEL_LOGS_EXPORTER` | 16 |
| `DISABLE_ERROR_REPORTING` | 8 |
| a fabricated name (the control) | **0** |

Presence is not semantics, so the context was extracted (`grep -aoE '.{130}<needle>.{130}'` → 11 windows for
`DO_NOT_TRACK`, 8 for `DISABLE_TELEMETRY`). **Paraphrase only — the binary is proprietary and nothing below is
quoted.** What the windows show:

- a privacy-mode resolver that reads `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` first and returns an
  *essential-traffic* mode, then `DISABLE_TELEMETRY` and then `DO_NOT_TRACK`, each returning a *no-telemetry* mode,
  and a default mode otherwise. These are USED in a branch, not merely listed;
- a sibling function returning WHICH of the three names caused the mode, in the same order — so the binary can name
  the variable that disabled telemetry;
- both names inside a five-name `Set` alongside `API_FORCE_IDLE_TIMEOUT`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
  and `DISABLE_ERROR_REPORTING`;
- an internal schema field, `analytics_disabled`, documented as true when analytics/telemetry is disabled by privacy
  level, by `DISABLE_TELEMETRY`/`DO_NOT_TRACK` **from any settings tier**, by a third-party provider or by a gateway —
  and documented as the same verdict the `system`/`init` message carries.

**One asymmetry worth stating, because it changes what an operator must write.** `DISABLE_TELEMETRY` is tested for
truthiness of the raw environment value, while `DO_NOT_TRACK` is passed through a helper first. So `DISABLE_TELEMETRY=0`
— a non-empty string — plausibly DISABLES telemetry while `DO_NOT_TRACK=0` plausibly does not. That is a reading of the
branch SHAPE and not of the helper's body; it is recorded as a hypothesis with its evidence, not as a verdict.

**The confirmatory live arm is NOT run and is a NULL with its reason.** The row asks for a packaged build pointed at a
local OTLP collector. This sitting's profile has only the Pi card, and the arm needs a claude-runtime session. What the
extraction found makes that arm CHEAPER than the row costs it: the binary publishes its own verdict as
`analytics_disabled` on the init message, so a collector is not needed — the detector is the SDK's own init object.

**And that detector is invisible from our side today.** `analytics_disabled` occurs **0** times in
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` at `0.3.251` and **0** times in this repo
(`git grep -an analytics_disabled -- packages apps scripts`). It is an instance of AGENTS.md's membership rule — the
bundle is the denominator, the typings are a subset of it — and it is a proposed row rather than a finding.

---

## 5. D1.16 — the claude hook-event column: **PREMISE REFUTED at HEAD**

The row (source `P6.119`) rests on a line of `runtime-hook-events.ts` reading `anthropic: false` — *"so `hookEventEmission`
returns `UNMEASURED_RUNTIME` and `describeCapabilityDelta`'s claude arm answers `[]` by construction"*. (The old anchor is
named in words rather than in the `path:line` form, because AGENTS.md records that a correction spelling the dead anchor
re-creates the finding it repairs.)

At HEAD, `packages/shared/src/automations/runtime-hook-events.ts` `MEASURED_HOOK_EVENT_COLUMNS` reads
`'codex-runtime': true, anthropic: **true**, pi: true, 'nestor-cloud-agent': false`, and
`ANTHROPIC_HOOK_EVENT_EMISSION` carries **32** cells. So the claude arm is no longer empty by construction and the
row's headline is closed by something that landed after it was written.

**And its denominator moved too.** The SDK's `HookEvent` union is **33** members at `0.3.251`, against the **31** the
row records at `0.3.247`. Read it, do not quote the row:

```sh
D=node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
sed -n "$(grep -n 'type HookEvent' "$D" | head -1 | cut -d: -f1)p" "$D" | tr '|' '\n' | grep -c "'"
```

What SURVIVES of D1.16 is much smaller than the row: whether those 32 cells are cited to an OBSERVED firing or to a
source reading, and G5/claude. Neither is answered here, and the row should be re-sized before it is dispatched.

---

## 6. D1.18 — the SDK's dynamic Workflows: **PREMISE ADVANCED at HEAD**

The four keys the row names are all still in `sdk.d.ts` at `0.3.251` (`disableWorkflows`, `enableWorkflows`,
`workflowSizeGuideline`, `workflowKeywordTriggerEnabled`), and the packaged binary carries `ultracode` **161** times,
`workflowKeywordTriggerEnabled` **9** and the gate name `tengu_workflows_enabled` **4** (fabricated control **0**).

What has changed is our side. The row says the delivery path is *"already open"*; at HEAD it is BUILT —
`enableWorkflows` is part of claude's managed-settings key set under C3.116, pinned by
`packages/shared/src/agent/__tests__/claude-auto-mode-policy.test.ts`. So the row reduces to the one question a source
read cannot answer: does a packaged claude session's init tool roster carry a `Workflow` entry, or is it held by the
remote flag — i.e. is H2/claude `partial` by ENTITLEMENT or genuinely absent.

**That arm WAS driven, as case `RS-49`, and it BLOCKED on its own control — which is a finding about the detector.**
A `claude-gateway` card was created with the product's own one-click button, a session on it answered `ready`, and the
SDK's own session file was read. `Task` and `TodoWrite` — tools every claude session gets — occur **zero** times in it;
the only capitalised identifier in the whole file is `HEAD`. So the SDK's persisted transcript is NOT where the init
tool roster lives on 1.39.0, `Workflow` → 0 and `ultracode` → 0 in it say nothing, and the case blocks rather than
filling `H2/claude` from an instrument that cannot see a roster.

**D1.18 therefore stays NULL, with a sharper reason than "no card": the detector named in the row is the wrong
surface.** The next arm needs the SDK `system`/`init` message as the HOST receives it, not the transcript the SDK
persists. That is written into `rs-49.ts` so the next lane does not re-take the same reading.

One rig fact from the same case: `sendPrompt` returns as soon as the USER row lands, so the first drive blocked on a
`claude-config/projects` directory that the turn created seconds later. The read polls now.

---

## 7. The rows this sitting did NOT reach, each with the reason

Recorded as NULLs rather than left implied. Every premise below was re-taken at HEAD, and where a re-take moved
something it is said so.

| row | premise at HEAD | why NULL |
| --- | --- | --- |
| `D1.5` credential floor, three runtimes | holds: `deniedReadPaths` occurs 6× in `codex-agent.ts`, `deniedPaths` 4× in `claude-agent.ts` | needs a claude AND a codex session, and a turn on each that READS a credential file. Not driven for a second reason worth stating: a model asked to read `credentials.enc` puts whatever it read into a transcript, and the standing constraint is that no real credential is printed. The arm needs a control file chosen after the profile's `config.json` has been checked for plaintext secrets |
| `D1.6` / `D1.7` the seven mode sentences, claude and pi | holds | 7 modes × 2 runtimes × a read-only and a mutating command × two agreeing runs. The most expensive pair in the batch; it wants a sitting of its own |
| `D1.8` managed clamp of the Pi mode | holds: `normalizePiPermissionMode` 21×; `noteSwitchVisibleDegradation` 7× in `claude-agent.ts` and `surfaceCodexOperatorNotice` 39× in `codex-agent.ts`, neither on any Pi path | needs a deployed managed policy carrying `disabledPermissionModes` and a relaunch |
| `D1.9` the administrator's skill, once or twice | holds: `storage.ts` carries `getAdminAgentSkillsDirs` / `NESSY_ADMIN_SKILLS_DIR` (7 lines) | needs the enterprise root established for the claude half — the row itself says to establish whether it follows `CLAUDE_CODE_MANAGED_SETTINGS_PATH` before running, or to run under a container |
| `D1.10` ambient `OPENAI_BASE_URL` on codex | holds | needs a codex card, a local sink, and the codex source re-read at `rust-v0.154.0` (the row cites `rust-v0.148.0`) |
| `D1.12` the SDK's compaction and `## Compact Instructions` | holds: `withProjectCompactSteering` is reached from `pi-agent-server/src/index.ts` and from codex, and from claude by nothing | needs a claude session, a `PostCompact` hook and a real compaction |
| `D1.15` background work against the reaper | holds: `backendBackgroundTasks` is one line in `SessionManager.ts` | needs a packaged Pi session with a `bash_background` command AND a background subagent, held across an idle-reaper window, plus the no-background negative control |
| `D1.17` a skill's frontmatter hooks on codex | **holds, and the naive re-take says otherwise.** `git grep -ac "provider !== 'anthropic'" -- SessionManager.ts` answers **1** — which reads as "the gate is still there" and is a COMMENT at line 22056 recording that P6.59 removed it. The layer is provider-neutral | needs a codex card and a skill declaring both a `PostToolUse` and a `PreToolUse` command hook |
| `D1.19` the claude USD budget cap | holds: `CHILD_SESSION_BUDGET_EXHAUSTED_ERROR` and `buildClaudeMaxBudgetUsdOptions` both at HEAD | needs a claude session with `workspaceDefaults.maxBudgetUsd` set just above one turn's spend, and two turns |
| `D1.20` a codex spawned agent's inherited tools | holds: `list_sessions` and `send_agent_message` carry no `visibility` in `tool-defs.ts`, the control `list_mcp_resources` is `visibility: 'pi-only'`, and `[features] multi_agent = true` is still written | needs a codex card and a real `spawn_agent` |
| `D1.4` stage-1 truncation under a realistic transcript | unchanged — the classifier prompt is inside the closed SDK | see §8: this row is NOT the one the wave brief names, and the swap is worth fixing before it is dispatched |

---

## 8. A plan defect: `D1.4` and `D1.14` are SWAPPED in the plan's own prose

`## Pointers back` maps `D1.4` → `P3.141` (stage-1 truncation, the classifier inside the closed SDK; ⬜, parked and
live-owed) and `D1.14` → `P6.110` (`/tasks` and `/workflows`; ⛔). The row lines agree with that map.

§Phase 1's slice 3 does not. It reads *"`D1.4` (P3.141) · `D1.14` (P6.110). **The first is ⛔** and stays that way until
the feed it needs exists; **the second is live-owed** — the classifier prompt is inside the closed SDK"* — which
attributes the ⛔ to the classifier row and the classifier to the `/tasks` row, i.e. exactly the other way round.

It has already propagated. The WAVE I-1 table's *Not this wave* line says *"`D1.4` ⛔ if unreachable"*, and this lane's
own brief describes `D1.14` as *"the classifier prompt inside the closed SDK"* and `D1.4` as *"stage-1 truncation"* —
two descriptions of the SAME row, with `P6.110` named nowhere. A lane following the brief literally would have measured
`P3.141` twice and left `/tasks` and `/workflows` untouched.

`D1.14` is measured above (§1). `D1.4` is not, and its NULL has a reason of its own: the arm needs a realistic
transcript driven through the auto-mode classifier on a claude card, which this profile does not have.

---

## What ran

| case | row | verdict | file |
| --- | --- | --- | --- |
| RS-32 (rig precondition) | P6.1080 | **PASS 8/8** — 1.39.0, port 9228 | `scripts/cdp/cases/rs-32.ts` |
| RS-46 | D1.14 | **PASS 7/7** | `scripts/cdp/cases/rs-46.ts` |
| RS-47 | D1.3 | **PASS 7/7** | `scripts/cdp/cases/rs-47.ts` |
| RS-48 | D1.13 | **PASS 7/7** | `scripts/cdp/cases/rs-48.ts` |
| RS-49 | D1.18 | **BLOCKED on its own control** — the detector surface is wrong, and that is the reading | `scripts/cdp/cases/rs-49.ts` |

`bun test ./scripts/cdp/harness.test.ts` → **59 pass / 0 fail, 1029 expect(), 1 file** at the final case (1019 before
`rs-49` landed), under the test mutex.
`bun run tsc -p scripts/cdp/tsconfig.json` exit 0 after every edit. `git diff --check` clean. Processes at exit: none.
