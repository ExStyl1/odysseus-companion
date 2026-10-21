# Open-row triage, 2026-09-02 — every open row against the agent-loop scope filter

> **What this is.** All **252** open rows of `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`
> (`⬜` 235 + `🟨` 17 at `f3a2b5f4d`), each read in full and classified against the three criteria of
> §*Owner ruling 2026-08-28: the goal is the AGENT LOOP*. The five `⏸` rows are listed separately at the
> end with the ruling that parked them, and are not re-decided. **Nothing here edits the plan.**
>
> The 31 rows tagged `decision` here are written up for the owner, one block each, in
> `docs/superpowers/specs/2026-09-02-owner-decision-brief.md`.
>
> Written by lane A2. Every count below is a reading with a date, not a standing fact.

## 0. How each verdict was reached, so it can be challenged

The three criteria, verbatim: **(1)** a tool call passes through it; **(2)** it changes what the model is
told, sees, or may do; **(3)** it differs between runtimes at a switch. Two things stay IN whatever they
look like: a control that **silently stops controlling**, and any switch-visible difference. The note
decides, never the title.

Four tie-breakers were needed more than once. They are stated here because they are where a reader will
most reasonably disagree:

1. **Criterion 1 is read literally**, following the section's own corrected example — the corporate
   launcher is IN because *every Bash tool call passes through a launcher seam*. So a seam on the
   permission or tool path is IN even when the row's content is a memo or a timeout.
2. **A test-quality row is IN only when the assertion it repairs guards a surface that itself meets a
   criterion** (a permission verdict, a tool grant, model-facing text, a switch). A repo-wide sweep over
   the test corpus with no named product surface is OUT — and both such sweeps here carry their own
   measurement that precision is about 1 in 6.
3. **A user-facing string is IN when it states a safety or permission guarantee** (what is sandboxed,
   what a policy refused, what a switch costs) and OUT when it is localization or copy hygiene.
4. **`DEFERRED-LAST` is used for the owner's own priority ruling of 2026-08-28** — *rows tagged
   `[doc:none]` are recorded and wait for the verification pass* — applied to rows that pass the scope
   filter and meet neither of that ruling's two narrow exceptions (a shipped security or permission
   boundary that is currently wrong; blocking a lane's ability to measure). It is **not** applied to
   `decision` rows: the ruling defers *repair*, not *answers*, and a queued answer costs the owner
   minutes while blocking a lane for weeks.

## 1. Counts

### By state

| State | Rows | What it means here |
| --- | ---: | --- |
| `IN` | 154 | Passes the filter and is dispatchable now. |
| `DEFERRED-LAST` | 41 | Passes the filter; the owner already deferred it to the verification pass (2026-08-28 priority ruling). |
| `OUT` | 55 | Fails all three criteria — real work, not agent-loop work. |
| `GATED` | 1 | Behind a build flag the owner intends to re-open; do not build, do not delete. |
| `UNCLEAR` | 1 | Cannot be decided without OQ-14. |
| **Total** | **252** | |

### By tag (in-scope rows only: `IN` + `DEFERRED-LAST` = 195)

| Tag | Rows | |
| --- | ---: | --- |
| `residue` | 125 | A declared leftover of a closed row. |
| `decision` | 31 | Needs the owner: a product posture, a user-visible policy, a safety trade, an operator cost. |
| `build` | 23 | A lane closes it without asking anyone. |
| `verify` | 16 | A live, CDP or packaged-build measurement is what closes it. |

### State x tag

| | residue | build | decision | verify |
| --- | ---: | ---: | ---: | ---: |
| **IN** | 90 | 21 | 31 | 12 |
| **DEFERRED-LAST** | 35 | 2 | 0 | 4 |
| **UNCLEAR** | 0 | 0 | 0 | 0 |

**The residue share is 125 of 195 in-scope rows (64%).** The 2026-08-31 measurement said 147 of 237
open rows (62%). The two rules differ — mine reads the note's own origin attribution, that one is not
stated — so read the direction and not the delta: **most of what is left is the declared tail of work
already done, not undiscovered gaps.** Under the 2026-08-31 in-place-fix ruling a large part of that
tail never needs a dispatch at all.

### By doc tag (the queue key of the 2026-08-28 priority ruling)

| Tag | All open | In scope |
| --- | ---: | ---: |
| `doc:claude` | 52 | 50 |
| `doc:codex` | 31 | 30 |
| `doc:none` | 111 | 66 |
| `untagged` | 57 | 48 |
| `remote` | 1 | 1 |

## 2. The largest OUT clusters

55 rows fail all three criteria. They are **not** dismissed: each carries a measurement already paid for,
and `docs/superpowers/specs/2026-08-28-out-of-scope-register.md` exists precisely so such an entry can be
promoted later with no re-measurement. Clusters, largest first:

| # | Cluster | Rows |
| ---: | --- | --- |
| 20 | **Test, rig and gate infrastructure** | `P2.187` `P2.255` `P2.321` `P2.348` `P2.369` `P2.376` `P2.386` `P2.387` `P2.461` `P2.473` `P2.480` `P2.493` `P2.506` `P3.172` `P3.179` `P3.190` `P3.198` `P3.199` `P3.200` `P3.252` |
| 16 | **Documentation, citation and stale-comment hygiene** | `P2.266` `P2.285` `P2.291` `P2.305` `P2.338` `P2.377` `P2.378` `P2.379` `P2.426` `P2.515` `P2.516` `P3.99` `P3.192` `P3.208` `P3.209` `P3.212` |
| 5 | **i18n and locale keys** | `P2.478` `P2.518` `P2.519` `P2.520` `P3.160` |
| 5 | **Lane and controller process** | `P2.275` `P2.401` `P3.46` `P3.170` `P3.173` |
| 3 | **Build and dev tooling** | `P2.234` `P2.247` `P2.349` |
| 2 | **Dead identifiers with no gate that can confirm them** | `P2.475` `P2.479` |
| 2 | **Owner-excluded: authorization (owner 2026-08-29)** | `P2.357` `P3.90` |
| 1 | **Outside the three-runtime goal** | `P2.370` |
| 1 | **Cost only, no criterion holds** | `P2.63` |

Two of these clusters deserve a sentence rather than a row each:

- **Cluster B (16 rows)** is dominated by one-line stale comments and dead doc anchors. Under the
  2026-08-31 in-place-fix ruling most of them are closed by the next lane that opens the file, not by a
  dispatch — provided the lane lists the fix in its report.
- **Cluster A (20 rows)** is where the plan's own evidence quality lives. Two entries are worth the
  owner's attention even though they are out of scope: `P2.480` measured that the repo's **largest**
  package resolves to **2 lint rules** where a base adopter resolves to 38, so every green `lint:shared`
  in this plan means *two rules passed*; and `P2.493` measured that the busiest renderer file cannot be
  loaded by the test runner at all, so **every renderer claim in this plan resting on a source-text
  assertion is weaker than it reads.**

## 3. Four things the classification pass found that the plan does not currently say

**(a) OQ-14 names the wrong row, and the `[remote]` tag is on a row that is not about the remote agent.**
OQ-14 states *"Two open rows carry the `[remote]` tag: **P2.335** (⏸) and **P2.58** (⬜)"*. Measured at
`f3a2b5f4d` over the tracker with the cell-index parser: the only open row whose note carries `[remote]`
is **`P3.184`**, whose subject is codex's OS-enforced deny stopping `ssh` / `git push` / `aws` inside a
codex shell — nothing to do with `nestor-cloud-agent`. `P2.58`, which *is* about the cloud agent's hook
fence, carries **no tag at all**. So resolving OQ-14 as **(b)** and moving "the `[remote]` rows" by their
tag would move a codex permission row out of the plan and leave the actual remote-agent row in it. Fix the
tag before acting on OQ-14, in either direction.

**(b) Two rows the owner already excluded were still sitting in the dispatchable queue.** The
2026-08-29 answers say, verbatim, that *"`P3.90` and `P2.357` sit in the gap between «we don't support
their auth commands» and «authorization is out of scope» and stay OUT on the exclusion as written."* Both
are still `⬜`. They are filed OUT here (cluster G); the tracker should follow.

**(c) One row is about a GATED surface and reads as ordinary work.** `P2.318` refreshes
`PI_PREFERRED_DEFAULTS['openai-codex']` — and `llm-connections.ts:935` states in its own docblock that
`openai-codex` is *the ChatGPT Plus/Pro OAuth path*, i.e. the subscription card that is flag-off and that
the owner ruled on 2026-08-29: *"do not build, do not delete, do not clean up."* It is filed `GATED`, and
the decision brief recommends **no decision needed**.

**(d) The 73-owner-decisions figure does not survive a reading of the notes.** Read row by row, **31**
rows need the owner. The 2026-08-31 note gives no method for its 73, and the 2026-09-01 section records
what a pattern-matched decision queue produced last time: *"the triage that produced the eight was a
regex over row text, not a reading. Three of eight were stale."* The gap is mostly rows whose note says
*decide* about something the 2026-08-28 delegation already delegates — *lean on the documentation and
make the decision yourself; where it is silent, be transparent and simple*. Those are `build`.

## 4. Every open row

Sorted by row id. `state` is the scope verdict; `tag` is what closes it. A `DEFERRED-LAST` row is in scope
and waits for the verification pass by the owner's own priority ruling.

| Row | Title | State | Tag | Why |
| --- | --- | --- | --- | --- |
| `P2.11` | background auto-commit | IN | build | DR-2 already scoped it to the commit half; an unattended session committing to the repo is the agent acting (crit 1). |
| `P2.46` | the backwards-total guard splits its two causes | IN | residue | Both cost guards fold a crash and a /clear reset into one branch; the failure direction is a silent permanent UNDERCOUNT of a spend ceiling. |
| `P2.47` | the block-escape set guard covers every reachable branch | IN | residue | The permission-matcher escape guard covers 6 of 8 reachable branches and the literals are hand-copied to a third site. |
| `P2.53` | the bare-form role prefix, decided | IN | residue | A forged `User:` opener is defanged nowhere; the review already supplied the decision (one renderTranscriptEntry seam) — build it, do not re-litigate. |
| `P2.56` | the mode picker ignores the workspace cycle | IN | decision | The picker ignores cyclablePermissionModes while SHIFT+TAB honours it, so one permission-mode control is inert on the click path. |
| `P2.58` | hook stdout gets an in-band notice on nestor-cloud | UNCLEAR | — | Subject is the nestor-cloud hook fence, i.e. the fourth runtime OQ-14 is about — but at HEAD this row carries NO [remote] tag (P3.184 wrongly does). |
| `P2.62` | a CDP case proves the index survives a restart | IN | verify | A CDP case that kills the app with a background shell running and reads the settlement afterwards; rides the close-out wave. |
| `P2.63` | three whole-store scans remain on Pi-only paths | OUT | — | Four whole-store scans on Pi-only paths OFF the continuation path — the row states it is cost, not correctness; no criterion holds. |
| `P2.77` | nothing justifies alphabetical source precedence | IN | residue | Lexicographic slug order silently decides which source wins a tool allow/deny conflict and nothing states why. |
| `P2.83` | the advisor's field labels are outside the vocabulary | IN | residue | The advisor `result:` label lets a body borrow the host field grammar; the verdict landed and the unpinned `input` immunity must be asserted before P2.53 closes. |
| `P2.86` | a hand-rolled `User: ` opener survives in-tree | IN | residue | A hand-rolled `'User: '` opener outside the new seam falsifies that seam's own physically-cannot claim; the ESLint machinery already ships. |
| `P2.100` | the blast-radius sweep is prose, not an artifact | IN | residue | Two closed rows cite a blast-radius sweep that exists in no file; the differential fuzz it assumes does not exist either, so this is build-it, not promote-it. |
| `P2.104` | the ANSI-C glued-head is a pre-existing 2-hole fuzz residue | IN | residue | The last two fuzz holes on the command splitter; the allow verdict now refuses that class, so the retire-vs-convert triage is answerable cheaply. |
| `P2.111` | the moved-class prompt should name its own remedy | IN | residue | On claude/codex two moved classes prompt where Pi clears silently and the prompt never names the one allow rule that ends it (crit 2+3). |
| `P2.115` | a partially-refused parallel fan-out blocks the immediate return | IN | residue | A partially-refused parallel fan-out never satisfies its Promise.all, so a background subagent launch reports started for a run that already finished. |
| `P2.119` | host wiring has no behavioural test surface | IN | residue | Deleting the wired spend ceiling compiles clean and leaves every behaviour test green — money-adjacent wiring with no behavioural guard. |
| `P2.147` | replaced-default folders may be short two entries | IN | residue | Two plugin-discovery constants that must agree may already disagree; the recurring Task->Agent / lsp->lspServers shape. |
| `P2.163` | a run that admitted nothing still says it started | IN | residue | A zero-admission workflow run still says it started; decide the honest sentence and move the two byte-identical pins with it. |
| `P2.164` | the accepted cost is wider than the decision text said | IN | decision | OWNER-FACING: the P2.131 trade was accepted on a narrower cost than the real one — an agent-less background workflow now blocks for its whole duration. |
| `P2.175` | the strict drain coalesces without knowing what must survive | IN | decision | Should a Monitor watch survive an auth retry — plus a coalescing lock that cannot see the keep set and can report ok:true while dropping a watch. |
| `P2.187` | the loose-assertion sweep is a third done | OUT | — | A repo-wide loose-assertion sweep on no named product surface; its own successor measured 1 real defect per 6 candidates read. |
| `P2.188` | three removal spellings the fallback still will not name | IN | decision | Owner-facing: two matchers disagree on flagless `rm ~`, and no long-option claim about our removal floor can be measured against GNU rm on this host. |
| `P2.197` | six of seven modes leave the asking to the model | IN | decision | With the sandbox off, six of seven codex modes emit on-request — "the model decides when to ask" — so a call the model never raises reaches no gate at all. |
| `P2.201` | the merged-config memo is still unmemoized | IN | residue | Every tool call reads the merged permission config; the memo is absent and its own measurement (25.6us warm vs 0.2us lookup) may close the row as not-worth-it. |
| `P2.214` | two held one-liners and a message that names the wrong operation | IN | residue | A malformed grant list is refused at import and trusted at enforcement, and a READ refusal tells the user MCP writes are blocked. |
| `P2.216` | a twenty-second restatement fails open to pi | IN | residue | A twenty-second restatement of the runtime vocabulary fails OPEN to `pi`, so an unrecognised runtime is described to the user as Pi (crit 3). |
| `P2.217` | the approve menu row and two headless-empty surfaces | IN | residue | /approve works everywhere and is offered nowhere; describeAdvisor answers undefined headless; a silent JSON path remap feeds the mirror. |
| `P2.220` | the safe-mode grant guard is a named spot-check list | IN | residue | The safe-mode grant guard enumerates named tools, so flipping an unlisted tool allow->block gives 28 pass / 0 fail. |
| `P2.221` | MCP_ENTRY_KEYS order is enforcement-visible and undocumented | IN | residue | MCP_ENTRY_KEYS order decides WHICH deny is dropped at the ceiling and no source line says so. |
| `P2.223` | a non-null assertion resolves to undefined at runtime | IN | residue | A `!` asserts non-null on an expression that resolves to undefined and hands it to setModel, which assigns without a guard — the model silently becomes undefined. |
| `P2.227` | four residues from the budget-notice guard | IN | residue | Four residues on the budget-notice guard, one corrected: the guard cannot fire on codex or nestor-cloud, so P2.129 protection is claude/pi-only (crit 3). |
| `P2.232` | initialize and thread/start are unbounded on the same path | IN | residue | initialize and thread/start are unbounded on the spawn path at a measured 10.5s and 34.7s, so a cold start is indistinguishable from a hang. |
| `P2.234` | three residues from the dev-staging fix | OUT | — | Three Pi dev-build recipes, no dev watcher, a 27MB bundle inlining the root package.json — build tooling, no agent-loop criterion. |
| `P2.235` | the digest gate covers six of seventy-seven pins | IN | residue | The digest gate reads 6 of 7 source-text pins and ignores their prefixes, so a renamed tool leaves a stale exact-name pin reporting green on the model-facing tool surface. |
| `P2.236` | the hook_context fences carry no notice | IN | residue | Every transcript fence carries an untrusted notice and the whole hook_context family carries none, on three runtimes (crit 2+3). |
| `P2.238` | the wording is decided by notification timing, not the runtime | IN | residue | On codex the cost sentence a user reads is decided by notification timing, understating a permanent property as a per-turn accident; it moves nestor-cloud wording too. |
| `P2.239` | one verdict collapse, written three times | IN | residue | The per-turn cost verdict collapse is written three times with no exported normalizer — the rule OQ-7 spent two rounds reasoning about. |
| `P2.240` | a 10s spawn ceiling reads as an assertion failure | IN | residue | parseCommand's 10s production ceiling sits on the permission path and its expiry surfaces as an ordinary wrong answer; the known-failing register rides along. |
| `P2.241` | every POSIX command pays a PowerShell subprocess | IN | residue | Every Bash permission check pays a real PowerShell subprocess; the naive gate was measured to fail OPEN, and the measured gate is P2.395. |
| `P2.243` | two classifiers read the same code oppositely | IN | residue | DEFINITIVE_REFUSAL_CODES states a false rule in a durable comment while its sibling already decides on message tokens; one binary needs one rule. |
| `P2.244` | the alarm fix drops sub-keys silently | IN | residue | Five parseable sandbox sub-fields now map to nothing and emit ZERO diagnostics, against a module whose contract is that unsupported keys are surfaced. |
| `P2.247` | a third script rebuilds Pi and never stages it | OUT | — | A third script rebuilds a 27MB Pi artifact the server distribution never ships and never stages it — build tooling. |
| `P2.250` | a hook's block reason is elemented but unfenced | IN | residue | A hook block reason is composed into an element with no fence and no defang at the shared base, so all three runtimes inherit the pre-P2.31 shape. |
| `P2.253` | four residues from the escape-hint and register work | IN | residue | Four residues on the permission escape hint: a hand-maintained wording registry, a POSIX-only shim standing in for the Windows production path, a quoted spawn cost, one copy overreach. |
| `P2.255` | the gate and its test run on different commands | OUT | — | Gate plumbing: the gate rides typecheck and its test rides bun test; the contract it protects stays IN as P2.235. |
| `P2.258` | codex's USD ceiling counts zero forever | IN | decision | A user who sets a USD ceiling on codex gets a warning and a cap that can never fire, because codex emits no costUsd anywhere. |
| `P2.266` | a source comment still says P2.226 is open | OUT | — | One stale source comment claiming a closed hardening row is open — close by in-place fix under the 2026-08-31 ruling, not by a dispatch. |
| `P2.267` | a third lock/operand pair, and withholding it is a product decision | IN | decision | allowManagedPermissionRulesOnly + claudeRules.allow is the third lock/operand pair; withholding it is defensible and its WebFetch residue can reproduce a deny-all. |
| `P2.275` | a piped gate on this plan reported the pipe's status, not the gate's | OUT | — | Lane process: piped gates report the pipe status; the mechanism half shipped, the remaining audit is controller docs work. |
| `P2.285` | 772 dead doc anchors remain, and one row re-hung 55 of them | OUT | — | 767-835 dead settings.md line anchors; documentation hygiene, with ~465 of them frozen historical records that must not be rewritten. |
| `P2.288` | an `ifRule` is validated at none of its four registration sites | DEFERRED-LAST | residue | An `ifRule` is validated at none of its four registration sites, so a malformed hook condition can only be reported at evaluation, where we must not fail closed. |
| `P2.291` | extend the enumerating-doc guard to the Claude and Pi tables | OUT | — | A doc guard over the capability-gaps tables; documentation accuracy, superseded in fact by P2.379. |
| `P2.294` | turn 1 of a bridge-less codex session is still lied to | DEFERRED-LAST | residue | Turn 1 of a codex session whose callback bridge failed still offers /loop with its four cron tools absent (crit 2); from turn 2 the view is correct. |
| `P2.295` | a seventh site of the dead pi-only claim, in the renderer | DEFERRED-LAST | residue | A seventh site of the dead pi-only cron claim, in the renderer, stating per-runtime truth that is false. |
| `P2.305` | five more inert-spec entries are stale, four naming live code | OUT | — | Five stale inert-spec entries, four naming live code; spec hygiene whose risk is a future wrong deletion. |
| `P2.312` | one command in seven has the breaker as its only floor | IN | residue | One command in seven reaches the fallback with the removal breaker as its sole floor; the find -delete miss is fixed, P2.388 is the open half. |
| `P2.318` | the codex model preference list is one-of-seven live | GATED | — | The list is keyed on `openai-codex` — the ChatGPT Plus/Pro OAuth card, flag-off and GATED by owner 2026-08-29 (*do not build, do not delete, do not clean up*). |
| `P2.320` | `/compact` with an attachment still bypasses the seam on Claude | IN | decision | /compact carrying an attachment still reaches the model as prose on Claude; both fixes are behaviour changes to a working path. |
| `P2.321` | a codex test now guards a path that cannot be reached | OUT | — | A codex test that passes while guarding a path chat() can no longer reach; test hygiene with two honest options. |
| `P2.322` | the composer still prefills a command three runtimes refuse | IN | decision | /subtask prefills on three runtimes that refuse it while /compact marks itself unavailable — two treatments of one situation, one file apart. |
| `P2.327` | `disallowed-tools` cannot be expressed for a ceiling-less child | IN | residue | A preloaded skill's disallowed-tools is enforced NOWHERE (measured); the fix landed as P2.385, so verify against HEAD before dispatch. |
| `P2.338` | a rename whose blocker is gone, and a `void` that outlived its reason | OUT | — | A rename whose blocker is gone plus a `void` outliving its reason; the row itself says it does not gate close-out. |
| `P2.348` | the faithfulness gate's budget covers work that has no bound | OUT | — | A generator-faithfulness gate that extracts the same 23MB tree five times and fails on a busy machine; gate infrastructure. |
| `P2.349` | five readers of one variable, four independent parses, no shared definition | OUT | — | Five readers and four hand-rolled parses of one env var; internal consolidation — the behavioural half is OQ-13. |
| `P2.355` | the output limits are five documented numbers against our one | IN | residue | The page documents five output limits against our three anonymous byte caps, and the model cannot tell truncation from completion; failure-excerpt half landed. |
| `P2.357` | a dead reset feature is the only thing keeping 34 setters harmless | OUT | — | OWNER 2026-08-29: named explicitly as staying OUT on the authorization exclusion (reset/logout); the 34-setter measurement stands in the register. |
| `P2.365` | one isolation string still renders unconditionally | DEFERRED-LAST | build | An isolation guarantee sentence renders beneath the switch-off banner, where nothing is sandboxed — a safety claim about an empty category. |
| `P2.369` | server-core's one production indexing error, behind a flag now documented as off | OUT | — | One production noUncheckedIndexedAccess error plus sixteen test ones; typecheck hygiene. |
| `P2.370` | a 116-file iOS client is named by no map and gated by nothing | OUT | — | A 116-file iOS client named by no map; (a) is a doc line, (b) whether a Swift gate is owed is an owner question OUTSIDE the three-runtime goal. |
| `P2.371` | a plugin following codex's own documented layout loses everything every session | IN | decision | A plugin following codex's documented $CODEX_HOME/state layout silently loses its state every session because we rebuild CODEX_HOME per session. |
| `P2.376` | two red suites at HEAD are in no register, and one of them is a live contract drifting | OUT | — | Two red suites at HEAD needing register entries; one closed itself mid-lane. Test-register hygiene. |
| `P2.377` | an OpenAI page is cited as a Claude one, and it 404s on the host it names | OUT | — | An OpenAI page cited without its host, so every anchor guard reads it as a dead Claude citation; citation hygiene. |
| `P2.378` | a hard-abort entry point named in `shared/AGENTS.md` no longer exists | OUT | — | One dangling entry-point name in shared/AGENTS.md; in-place fix under the 2026-08-31 ruling. |
| `P2.379` | the enumerating-doc guard cannot be widened where the row assumed, and one candidate would fire falsely | OUT | — | The measured blocker of P2.291: one guardable row, one that would fire falsely, and a Pi half that does not exist. Doc guard. |
| `P2.380` | codex reserves a permission-profile id our writer could collide with | IN | residue | codex reserves the profile id `codex_security_scan` and our writer does not know the name is taken; a collision rebinds sandbox_mode and approval_policy together. |
| `P2.381` | a remote-control transport we neither enable nor explicitly disable | IN | build | DECIDED 2026-09-01 (explicitly disable, measure the binary default as part of the work) — dispatchable, not a decision. |
| `P2.386` | five assertions whose condition is the thing under test | OUT | — | Assertions nested inside the claim under test; the permission-surface instance is fixed and the five remaining are non-permission (1 genuine of 5). |
| `P2.387` | the loose-assertion sweep's remaining arm is three times its stated budget and one mode is unreachable by regex | OUT | — | P2.187 residue with real denominators; the .toContain arm is closed as unworkable and the toHaveLength arm is 1-in-6 precision. |
| `P2.388` | a PowerShell removal hidden inside an unparsed sh span is invisible on both platforms | IN | residue | A PowerShell removal inside an unparsed sh span is invisible on both platforms while the same command fires at top level — the removal floor, incomplete. |
| `P2.389` | the corpus that would weight the removal-breaker's coverage lives where no lane may execute | IN | decision | The 18,272-command corpus that would weight every removal-breaker coverage claim sits under the real home, which no lane may execute against. |
| `P2.391` | a failing bash result is counted twice against one byte budget, so failures get half the cap | DEFERRED-LAST | residue | A failing bash result is charged twice for one payload, so a failure gets half the cap — and its diagnostic value is in the tail a halved budget removes. |
| `P2.392` | the Pi window tier trusts a model id with no check that the model came from the gateway | DEFERRED-LAST | residue | The Pi window tier matches on model id alone, so a BYO endpoint whose model id collides with a gateway id inherits the gateway context window. |
| `P2.393` | two more output caps sit on paths no row has measured | DEFERRED-LAST | residue | Two unnamed output caps on the supervisor and child-session paths, neither measured against the five documented numbers. |
| `P2.395` | the spawn-free PowerShell gate is measured, unproven, and one run from either verdict | IN | residue | The spawn-free PowerShell gate is written, measured and reverted unproven; it is one run from either verdict and is what makes a correct permission check affordable. |
| `P2.397` | a command-form policy entry gets no expansion guard, and inventing one is not implementing the page | IN | residue | A command-form managed MCP entry gets no expansion guard, and the argv analogue of "scope" is defined nowhere upstream — read the page and the bundle, then decide simply. |
| `P2.401` | three rows this session were open against work already in HEAD | OUT | — | A dispatch-time gate the controller owns: verify a row against HEAD before dispatch, because the tracker baseline lags the branch. |
| `P2.426` | two comments describe a shape the code left behind | OUT | — | Two comments describing a process topology the code left behind; in-place fixes under the 2026-08-31 ruling. |
| `P2.456` | codex ships two tool-search keys and the writer emits neither | IN | residue | Premise REFUTED at the source (both keys are Stage::Removed no-ops; the real gate is model metadata and belongs to the gateway) — close with the measurement. |
| `P2.460` | seven documented exception keys are refused at parse and none has a consumer | IN | residue | Seven documented managed-settings exception keys are stripped at parse; refusing is currently the safe pole, and adding one needs its own resolution point. |
| `P2.461` | the same rig defect sits one layer up in twelve files, and the type fix needs all thirteen | OUT | — | Twelve test files inject an env object without the administrator-roots field, so on a managed host they read the real machine roots; rig hygiene. |
| `P2.462` | codex's deferred-tool state IS legible on the wire, and nothing reads it | IN | residue | codex's deferred-tool state IS first-class on the wire and nothing reads it — read the items BEFORE the gateway ever declares the capability. |
| `P2.464` | the browser refusal is a bare error, so no surface can translate it | DEFERRED-LAST | residue | A browser policy refusal throws a bare English error with no code to translate and no Managed indicator, so a policy reads as a malfunction. |
| `P2.468` | one plugin id is a warning upstream and a hard error here, and that divergence is deliberate but unowned | IN | decision | A leading-hyphen plugin id is a warning upstream and a hard error here; defensible, but it is a product posture nobody has stated. |
| `P2.473` | two lock windows left open on purpose, and the race that motivated the fix is still unproven | OUT | — | Two deliberately-left check-then-act windows in the test lock, plus an interleaving no test can reproduce; dev tooling. |
| `P2.475` | ten unused-identifier hints in the most contended file in the repo, none of them verified | OUT | — | Ten unverified unused-identifier hints in the most contended file, invisible to typecheck:all because noUnusedLocals is false everywhere. |
| `P2.478` | fifteen more keys per locale outlived the same deletion commit, and the near-miss is already identified | OUT | — | Fifteen dead locale keys per locale, unblocked by the P4.7 ruling; i18n cleanup with a measured method. |
| `P2.479` | two identifiers measured dead at HEAD by two independent lanes, and no gate can confirm either way | OUT | — | Two identifiers measured dead by two lanes, with no gate able to confirm either way; the real item is whether noUnusedLocals is ever turned on. |
| `P2.480` | the largest package adopted none of the shared lint base, and resolves to two rules against thirty-eight | OUT | — | The largest package resolves to 2 lint rules against a base adopter's 38; lint infrastructure, but it weakens every green lint:shared in this plan. |
| `P2.482` | the blocklist refusal names the entry in a log and reuses another code on screen | DEFERRED-LAST | residue | A blocklist refusal reuses the allowlist code on screen and names the blocked entry only in a log — refusal indistinguishable from failure, mildest form. |
| `P2.483` | accepting owner wildcards in the ALLOWLIST would widen a grant, and today it is a visible drop | IN | decision | Accepting owner wildcards in the marketplace ALLOWLIST would widen a grant to every marketplace under an owner; today the drop is visible and honest. |
| `P2.484` | a codex session whose bridge failed gets the cost table's only unsafe answer | IN | residue | A codex session whose bridge failed non-fatally is told by the switch dialog that it keeps capabilities it has lost — the one under-warning row in that module. |
| `P2.485` | three text claims outlived their subjects, in three packages, one of them user-facing | DEFERRED-LAST | residue | The switch-cost toast tells the user the model can no longer schedule or watch; two of three clauses are false since the scheduling family landed. |
| `P2.486` | the surface that renders the cost rows has never been visually reviewable | DEFERRED-LAST | residue | The dialog that tells a user what switching costs them has no playground entry at all, so six stale claims accumulated unreviewed. |
| `P2.489` | the managed tier outranks the workspace default-mode control, so on a managed install it writes a value nothing reads | IN | residue | On a managed install the workspace default-mode control writes a value no session will ever read, with no indication to the user. |
| `P2.491` | the playground ships to users, and one of its files is reachable by nobody | IN | verify | The playground page is a rollup input beside the app's own and ships in dist/renderer — a security-shaped question that only a packaged build can answer. |
| `P2.493` | the busiest renderer file cannot be loaded by the test runner, and its tests assert source TEXT | OUT | — | TurnCard.tsx cannot be loaded by the bun runner, so its tests assert source text; the containment convention is real but is test infrastructure. |
| `P2.496` | a user-level all-hooks-off does not stop any SDK-registered hook in this binary | IN | decision | A user-level all-hooks-off does not stop any SDK-registered hook, task registry and scheduling projection included — a user who turns hooks off believes hooks are off. |
| `P2.497` | the codex worktree tier is open and silent | IN | residue | The codex worktree tier is neither closed nor honest while claude logs every withholding; ask the native-first question and say so if codex cannot. |
| `P2.501` | the marketplace policy feed is boot-only, so an edited blocklist takes effect at the next start | DEFERRED-LAST | residue | A managed marketplace blocklist edited while the app runs reaches the gate only at the next start; documented in the schema rather than left implicit. |
| `P2.504` | two exported-document headings are English literals, and whether they should be is a product question | IN | decision | Two markdown-export headings are English literals, and whether an exported document follows the UI language is a product question, not a wiring choice. |
| `P2.506` | the lint chain now reads the whole tree three times where it read it once | OUT | — | Three whole-tree lint walks where one would do, on a box whose filesystem is the cost; the row exists to say no optimisation is warranted. |
| `P2.511` | a refused source slug reaches a debug line and no user, and the package has no other channel | DEFERRED-LAST | residue | A refused source slug reaches a debug line and no user, and @nessy-agent/shared has no always-on channel; the keys and their reader must land together. |
| `P2.513` | claude keeps a stderr ring buffer and exposes it to nobody, and the accessor answers empty | DEFERRED-LAST | residue | claude keeps a stderr ring buffer and its duck-typed accessor answers empty, so a caller cannot distinguish no diagnostics from not wired (crit 3). |
| `P2.515` | the specs file the guide delegates to carries the same over-generalisation, one row deeper | OUT | — | The specs file AGENTS.md delegates to carries the same over-generalisation one row deeper; documentation. |
| `P2.516` | one file still deep-imports two names the barrel now exports, under a comment that says so | OUT | — | One deep import of two names the barrel now exports, under a comment that is now false; in-place fix in the most contended file. |
| `P2.517` | no `required` write can carry an operator's mark until the pool stops aggregating | IN | decision | Per-server criticality and per-server observability are mutually exclusive on codex, and every operator MCP server reaches it behind one aggregated endpoint. |
| `P2.518` | thirty-three keys have a live surface that renders the wrong thing today | OUT | — | Thirty-three keys with a live surface rendering the wrong thing; localization holes, explicitly identical on all three runtimes. |
| `P2.519` | 137 dead keys ship to every user, and the deletion must be key-by-key | OUT | — | 137 dead locale keys reaching every built renderer chunk; i18n deletion, key by key. |
| `P2.520` | the reachability gate under-reports, and its message is backwards for a deletion | OUT | — | The reachability gate under-reports and its message is backwards for a deletion; i18n gate diagnostics. |
| `P2.521` | the carry planner never passes the gateway window, so the case its own docblock exists for degrades | DEFERRED-LAST | residue | The carry planner never passes the gateway window, so the exact case its docblock exists for degrades to a text tail at a live crossover. |
| `P2.522` | the switch modal shows a generic body because it never sees the reason | DEFERRED-LAST | residue | The switch modal keys off the plan alone and never sees the reason, so two different fallbacks reach the user as one generic sentence. |
| `P2.523` | the running count already opens every record, so the list beside it is free | DEFERRED-LAST | residue | The snapshot renders an empty process list beside a count of the same running processes; the counter already opens each record, so the list is ~1.3ms. |
| `P2.524` | an ephemeral session lands checkpoints on disk, on every branch | IN | decision | A session the user was told leaves nothing behind writes checkpoints to disk on every branch; does ephemeral mean nothing written, or everything removed on exit? |
| `P2.525` | the host cannot receive a deferral, so claude refuses one it could otherwise honour | IN | residue | The runtime supports deferral and our adapter fills no deferral field, so a real deferral arrives as a reason-free completion: turn over, tool unrun, no resume. |
| `P2.526` | a scheduling tool answers success while nothing is scheduled | DEFERRED-LAST | residue | A wakeup tool gated on a remote flag returns SUCCESS with zeroed fields, so the model is told a wakeup is scheduled that never arrives. |
| `P2.527` | the judge-model write stores a model the policy forbids, then drops it silently at use | IN | residue | The judge-model settings write does not consult the managed allowlist, so a forbidden model is stored and silently substituted at judge time. |
| `P2.528` | the advisor model has no IPC surface at all, and its refusal has three distinct reasons | DEFERRED-LAST | residue | The advisor model has no IPC surface at all, and its refusal has three distinct reasons one error code may not carry. |
| `P3.7` | WSL spike | IN | verify | A WSL spike, evidence only — platform reach; read it beside the 2026-09-01 Windows deferral before spending on it. |
| `P3.8` | codex-security home persistence | IN | build | codex-security home persistence under DR-4 (supported install path, not bundled). |
| `P3.21` | no instrument catches an undriven terminal-event site | IN | residue | The terminal-event bench observes at the transport and fires on driven paths only; the choke-point check for an undriven site needs a hook in SessionManager. |
| `P3.23` | structured output has no runtime-independent validation point | IN | residue | Structured output is validated inside each runtime arm with no host backstop, so an arm that forgets ships unvalidated output; OQ-6 set the host-is-the-floor precedent. |
| `P3.46` | the lane rules ban `git commit -a` and say nothing about `--amend` | OUT | — | The lane rules ban `git commit -a` and are silent on `--amend`, which destroys another lane's commit; lane process. |
| `P3.47` | `--replay-user-messages` is a stream-shape change, not a flag | IN | residue | --replay-user-messages re-emits every user message and forces stream-json both ways: a stream-shape change, not a flag — record the cost before anyone budgets it. |
| `P3.48` | rewind clears the exact handle an SDK-side rewind would need | DEFERRED-LAST | residue | rewindToMessage clears the exact handle an SDK-side rewind needs, and enableFileCheckpointing is absent from the live-session signature; both block P6.56 action 3. |
| `P3.49` | the two-lists shape drops its second list again, sixth instance | DEFERRED-LAST | residue | The renderer mirror of ConversationRewoundEvent drops skippedLinks/skippedPaths with no guard — sixth instance of the two-lists shape. |
| `P3.52` | `DISABLE_NONESSENTIAL_TRAFFIC` is a posture trade, not a telemetry fix | IN | decision | DISABLE_NONESSENTIAL_TRAFFIC is set on the claude gateway path only and kills auto-updates, release notes, model discovery and feature flags with it. |
| `P3.53` | a managed OTLP endpoint marked `immediate` cannot arm an exporter built at bootstrap | IN | residue | Managed env marked `immediate` cannot arm an exporter built once at bootstrap, so `immediate` is a promise the mechanism does not keep — enumerate what else carries it. |
| `P3.56` | a codex native carry references no attachment at all | IN | residue | The codex arm of the handoff payload never passes attachmentBlock while pi and claude do, and the obstacle is a sync closure, not a missing argument. |
| `P3.57` | a real image carry is reachable on Pi and blocked on Claude by EVIDENCE, not by types | IN | verify | Owner objection settled the design (the shipped on-demand read-back wins); what is owed is proving codex's read tool returns an image as visual content. |
| `P3.61` | nobody has asked which other `ThreadStartParams` fields survive a codex fork | IN | residue | A codex thread/fork inherits developerInstructions; nobody has asked which other ThreadStartParams fields inherit, so any that do not are silently lost per fork. |
| `P3.62` | the codex e2e evidence is darwin-arm64 only, and three platforms ship | DEFERRED-LAST | verify | Every codex end-to-end measurement ran on darwin; state the platform on every codex claim and pick the smallest set worth confirming elsewhere. |
| `P3.64` | the headless host applies no managed env at all | IN | decision | The desktop host applies managed env and the headless one does not, so an administrator policy is enforced or not depending on which binary the user runs. |
| `P3.65` | the `policyHelper` drop reason reads like a typo | IN | decision | The 2026-08-08 owner decision that dropped policyHelper records a reason that reads as a truncation; only the owner can restate it. |
| `P3.66` | a packaged live case is owed for managed env | DEFERRED-LAST | verify | A packaged live case is owed for managed env at desktop boot; group it with the other packaged-boot cases. |
| `P3.67` | the credential-paired-routing exception is deliberately inert | IN | residue | The credential-paired-routing exception exists and nothing exercises it — an inert safety exception reads as coverage; reach it or delete it. |
| `P3.70` | the utility model is a per-connection field a switch silently re-resolves | IN | decision | Only the main model is reported at a switch; the utility/mini model is silently re-resolved, so a user who chose a cheap side model loses it and is not told. |
| `P3.72` | L10's skill-listing cap is a flat constant, not a share of the window | IN | residue | SKILL_LISTING_MAX_CHARS is a flat constant rather than a share of the window, so the skill listing bites a small model and the ledger cell reads the gap wrong. |
| `P3.77` | A4's codex cell is now half right | IN | residue | A4's codex read-side half is absent: its only shouldAllowToolInMode call consults deniedPaths solely to stop a rule auto-approving, never to deny. |
| `P3.85` | the codex managed tier is module-scope and unpersisted, and the launch check is ungated | DEFERRED-LAST | residue | The codex managed tier is module-scope and unpersisted and the launch check is ungated, so a codex-only fleet gets a weaker guarantee; dispatched as P3.261. |
| `P3.87` | `I5`'s claude and codex cells may be scoring a capability that has no subject there | IN | residue | Two propagated ledger cells may be scoring a capability with no subject on those runtimes; the pilot for auditing the other 37. |
| `P3.88` | llm-proxy IS reachable with a personal key, and the two back ends disagree about the same model | IN | build | RESOLVED by the 2026-08-28 owner ruling (a personal key is BYO, never a product credential; the gateway pool already publishes the window) — close it. |
| `P3.90` | the gateway returns 500 on a wrong credential type, not 401 | OUT | — | OWNER 2026-08-29: named explicitly as staying OUT on the authorization exclusion (the 500-vs-401 is a credential-type question on the gateway side). |
| `P3.97` | a classifier denial is never minted into a receipt | IN | residue | The classifier-denial receipt is built and dormant by construction; it stays dormant while the 2026-09-01 decision keeps the fall-through off. |
| `P3.98` | classifier tokens are billed to our gateway and excluded from the usage we report | IN | decision | Classifier tokens land on our gateway bill and are excluded from modelUsage; magnitude measured by P3.122 and it is not a rounding error. |
| `P3.99` | the 1.16.0 release note describes a breaker the SDK does not have | OUT | — | A release note describing a 3-of-10-of-50 breaker as the SDK's; user-facing documentation correction. |
| `P3.113` | `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` flips first-party treatment of a foreign host | IN | residue | _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL exists in the shipped bundle, appears in zero corpus pages, and flips first-party treatment of a foreign host. |
| `P3.118` | `ConfigWarningNotification` carries `path` and `range` and our record of it does not | IN | residue | ConfigWarningNotification carries `path` — the only non-textual way to tell which config artefact failed — and our classifier matches on message text. |
| `P3.122` | the classifier costs 110,519 characters of prompt per check, billed to us and reported to nobody | IN | decision | 110,519 characters of classifier system prompt per check, doubled on the first auto-mode action, billed to our gateway and reported to nobody. |
| `P3.123` | the page states model and provider requirements the shipped binary does not enforce | IN | residue | The page reads as an allow list of models and providers where the binary implements a deny list; record it against the page, do not file it as our defect. |
| `P3.125` | two comments now assert a falsehood, and one is load-bearing for a default | DEFERRED-LAST | residue | A dead reason is the recorded justification for defaulting claude-runtime images to false, so a BYO vision-capable upstream is denied a capability that works. |
| `P3.126` | `input_audio` is a third modality with no row anywhere | IN | residue | codex carries local_audio_content_items and no row or ledger cell has ever mentioned audio; the posture is set (carry faithfully) — enumerate before building. |
| `P3.128` | `allowedWritePaths` is entirely non-functional on Windows | IN | decision | Every write grant misses under a Windows home, including drive-letter grants; the direction is fail-closed, and widening a grant is an owner call. |
| `P3.129` | a real Windows build has never been exercised — DEFERRED as a posture (owner 2026-09-01): write the darwin-only evidence note and define the probe | IN | build | DECIDED 2026-09-01 (defer until a Windows build ships, record the darwin-only evidence as a posture) — retitled and dispatchable as a recording task. |
| `P3.136` | the one-click image toggle is withheld on claude-runtime for the same dead reason | DEFERRED-LAST | residue | The one-click enable-image toggle is withheld on claude-runtime for the reason 30628c7d0 killed, and the declaration now has no UI writer at all. |
| `P3.137` | the `pi_compat` image default is a two-file lockstep | DEFERRED-LAST | residue | The pi_compat image default lives in two files that must move together; a one-file fix yields a placeholder instead of a refusal. |
| `P3.138` | the legibility pin covers one runtime of three | DEFERRED-LAST | residue | The owner's carry-faithfully ruling holds only while the refusal stays legible, and that is pinned on two runtimes of three; Pi is unmeasured. |
| `P3.141` | stage-1 truncation under a realistic transcript is unmeasured, and it reads as a parse failure | DEFERRED-LAST | verify | All 28 classifier parses ran against a two-line transcript at 59% of the input budget; a truncation reads as a parse failure, which blocks. |
| `P3.142` | the classifier is a second opinion whose verdict is not recorded | IN | residue | If the classifier fall-through is ever enabled, everything it ALLOWS runs unrecorded while every denial is recordable — record the asymmetry beside the flag. |
| `P3.147` | hand our floor to the native deny surfaces instead of re-implementing filtering | IN | residue | Native-first: the claude half landed with the anchoring trap measured; the codex half is P3.175 and the results-exclusion promise is refuted as P3.174. |
| `P3.158` | `/help` is offered on all four runtimes and answered by no seam at all | IN | decision | /help is offered on all runtimes and answered by no seam, so it composes an ordinary turn and lets the model describe a product that is not this one. |
| `P3.160` | the EOL notice is English prose inside a description field | OUT | — | The EOL notice is English prose baked into a description field; i18n plus a renderer badge. |
| `P3.161` | the `eol` shape is second-hand and nobody has confirmed its variants | DEFERRED-LAST | residue | The `eol` shape is known from one catalogue pull and its variants are unhandled by construction; the personal-key route was ruled out, so record the null. |
| `P3.169` | `bun test` structurally cannot see the `HOME` defect class | IN | verify | Bun ignores a mid-process HOME while Electron follows it, so a bun test asserting the real credential-path defect can never fail — an instrument hole. |
| `P3.170` | a `cannot lock ref HEAD` turned a clean `git add` into another lane's commit | OUT | — | A failed commit leaves your work staged for whoever commits next; lane process, recorded in the traps spec. |
| `P3.172` | a locale key can be reverted by a concurrent commit with BOTH i18n lints green | OUT | — | Parity compares locales against each other, so a symmetric key loss is invisible to both i18n lints; gate hygiene. |
| `P3.173` | `git commit` with no pathspec is the mirror hazard, and no check-then-commit closes it | OUT | — | A pathspec-less commit takes whatever is staged and no check-then-commit closes the gap; lane process (the isolated-index recipe does). |
| `P3.174` | the vendor documents a search-results exclusion its shipped binary does not perform | IN | residue | The vendor documents a search-results exclusion the shipped binary does not perform: Read denies, Grep returns the line with the secret. Governs three rows. |
| `P3.175` | codex's deny map is OS-enforced and takes far more than we send | IN | residue | codex's OS-enforced deny map closes the results half the SDK fails — and ten of nineteen floor entries mirror while nine reach no enforcement anywhere. |
| `P3.178` | the page documents `classifierContext` and the vendored bundle does not have it | IN | residue | The page documents classifierContext and the bundle does not have it; not translatable yet, so re-check it on the next SDK or corpus refresh. |
| `P3.179` | a fixture less specified than the product it stands for turns a deletion into a defect | OUT | — | A connection fixture less specified than the shipped cards manufactured a false regression when a default was removed; fixture hygiene. |
| `P3.183` | the codex floor mirror is measured on darwin only, and the other two platforms are FATAL cases | IN | verify | The codex floor mirror is measured on darwin only, and on the two unmeasured platforms a **/-anchored pattern is refused (Windows, discarding the whole config) or fatal (Linux). |
| `P3.184` | an OS deny on `~/.ssh` also stops `ssh`, `git push` and the cloud CLIs in a codex shell | IN | build | DECIDED under the 2026-08-28 delegation (keep the deny, name it in a diagnostic). NOTE: it carries the [remote] tag and is not a remote-agent row. |
| `P3.186` | `Options.settings` is single-valued and now has TWO contributors | IN | residue | Options.settings is single-valued with two contributors; a second spread instead of a compose would silently delete the credential floor, and managedSettings is pre-loaded the same way. |
| `P3.187` | `useAutoModeDuringPlan` defaults to TRUE and nobody has measured what that means | IN | verify | useAutoModeDuringPlan defaults to TRUE and nobody has measured it — if plan sessions already carry auto-mode semantics, OQ-1 and OQ-3 were decided against an incomplete picture. |
| `P3.188` | one unresolved read and one unidentified field, both recorded rather than explained away | IN | residue | Two honest nulls kept so a future reader does not guess: an unresolved minified read, and an unidentified fifth sub-field in the binary's autoMode shape. |
| `P3.189` | a required option added at the baseline commit is read nowhere | DEFERRED-LAST | residue | PromptHandlerOptions.workspaceRootPath has been required since the baseline commit and is read in no code path; wire it or delete it. |
| `P3.190` | a directory outside every `include` is invisible to an exclude audit | OUT | — | A directory in no tsconfig include is invisible to an exclude audit; typecheck coverage infrastructure. |
| `P3.191` | P3.181's end-to-end arm is owed and `bun test` cannot pay it | DEFERRED-LAST | verify | The end-to-end HOME claim cannot be asserted under bun test at all; it needs a packaged run from Finder with a .zprofile — one rig with the credential-floor probe. |
| `P3.192` | eight more shell variables are copied and read by nobody | OUT | — | A recorded null: eight shell variables copied with zero readers, measured so nobody re-measures. No work owed. |
| `P3.195` | a command hook's PreToolUse deny still ends the turn | IN | residue | continue:false outranks permissionDecision, so a PreToolUse deny still ends the turn where the page implies it should not; the page decides the contract. |
| `P3.197` | the SDK PreToolUse arm is built per session and thrown away | DEFERRED-LAST | residue | The SDK PreToolUse arm is constructed every session and dropped by the merge that consumes it, two files apart, so neither site reads as dead. |
| `P3.198` | an excluded test file can be FAILING and silent | OUT | — | An excluded test file was red at runtime and silent; the argument for clearing the last exclusions, but typecheck infrastructure. |
| `P3.199` | `pi-auto-compaction-thrashing.test.ts` is load-sensitive on its own internal budget | OUT | — | A load-sensitive 120s internal scenario budget; known-failing register entry with its own distinction. |
| `P3.200` | five errors sit in a shared MCP file mid-refactor, reached only through excluded tests | OUT | — | Five typecheck errors in a shared MCP file another lane holds; re-measure after that lane lands. |
| `P3.201` | `model_catalog_json` is codex's native custom-model surface and we never asked it | IN | residue | NATIVE-FIRST: model_catalog_json is codex's own surface for describing a model it does not ship (window, reasoning levels, tiers) and we send two scalars. |
| `P3.202` | codex's on-demand image read-back is unproven and now has a named suspect | IN | verify | codex's view_image is declared and never driven, with a named suspect: the attachments store sits outside the profile's workspace scope, so a refusal would read as the model declining. |
| `P3.203` | `modelProvider/capabilities/read` is a second unread native self-report, and it already disagrees with our config | IN | residue | codex publishes modelProvider/capabilities/read and we read none of it; it already reports webSearch:true while our writer sets web_search="disabled". |
| `P3.204` | the genuine reviewer gap is a context-isolated agent plus a host-computed diff, and it is NOT isolation | IN | residue | The real claude reviewer gap is a bundled read-only agent, a host-computed diff and a SKILL.md branch — explicitly NOT worktree isolation, which cannot see uncommitted work. |
| `P3.205` | `SdkAgentDefinition.isolation` goes inert silently if the binary drops the field | IN | residue | SdkAgentDefinition.isolation goes inert silently if the binary drops the field, and nothing checks the prose that says so; one tripwire on the vendored schema. |
| `P3.206` | the headless server never seeds bundled skills at all | DEFERRED-LAST | residue | The bundled-skill seeder has one production call site in electron main, so a headless nessy-server deployment ships zero bundled skills on every runtime. |
| `P3.207` | the electron dist bundle still carries the pre-fix seeder, so the live pass needs a packaged build | IN | verify | The electron dist bundle still holds the pre-fix seeder, so any live skill evidence is invalid until electron:build runs — blocks a lane's ability to measure. |
| `P3.208` | `skillTier` can now be exact, and two stale comments were left deliberately | OUT | — | skillTier can read the seed receipt instead of inferring, plus two stale comments left to avoid a cross-lane pathspec collision. |
| `P3.209` | the managed tree's line-anchor residue, sized | OUT | — | 106 line-anchored citations in the managed tree; a re-verification pass (five of P3.68's were false, not stale) but documentation work. |
| `P3.210` | `OTEL_EXPORTER_OTLP_ENDPOINT` sits in our safe allowlist while the page says it always requires the dialog | IN | decision | OTEL_EXPORTER_OTLP_ENDPOINT sits in our known-safe allowlist and is applied with no dialog while the page says it always requires one — an egress control, on the looser side. |
| `P3.211` | `allowedTools` and `toolRules` are undocumented in the same three schemas | IN | residue | allowedTools and toolRules are absent from the same three published schema blocks; allowedTools is fail-CLOSED, so establish its semantics before writing a line. |
| `P3.212` | `apps/electron/resources/docs/permissions.md` has no zone owner | OUT | — | User-facing permissions documentation with no zone owner; process gap. |
| `P3.213` | 57 ledger cells claiming absence with a `ᵏ` marker are systematically biased toward absence | IN | residue | 57 ledger cells assert absence on a code-probe marker that is systematically biased toward FALSE absence — the row that most affects the owner's own table. |
| `P3.214` | the Read↔Edit/Write binding diverges from the page in BOTH directions, and one compiler is inert only by a whitelist | IN | decision | A Read ALLOW also grants Edit/Write/NotebookEdit/Grep/Glob (a widening we ship) while our Read DENY covers NotebookEdit (safer than the page) — the page or the safer behaviour? |
| `P3.218` | a managed-denied built-in toggled ON reverts with the same wording as the user's own OFF | DEFERRED-LAST | residue | A managed-denied built-in toggled ON reverts with the identical wording as the user's own OFF, so the UI cannot distinguish you did this from your organisation forbids this. |
| `P3.219` | a self-hosted Bitbucket/Gitea/Azure DevOps plugin is refused with no way forward | IN | residue | A self-hosted Bitbucket/Gitea/Azure DevOps plugin is refused with no way forward and no row owns the staged acquisition route its own comment names. |
| `P3.220` | a private registry whose CATALOG needs a credential cannot be added at all, and the key that would block its helper does not exist here | IN | residue | A private registry whose catalog fetch needs a credential cannot be added at all, and the managed key that would block its headersHelper does not exist here — land both together. |
| `P3.221` | the codex floor also stops the user's OWN credentials inside the agent's shell | IN | residue | Same subject as P3.184, already decided: the OS deny also stops ssh, git push, aws, gcloud and kubectl in a codex shell — measure the list, then say it. |
| `P3.222` | codex could LIST peers and not message one | IN | build | Fixed in 6173c9778 (codex could list peers and not message one); kept open only so the ledger cell has something to point at — close it. |
| `P3.223` | the Claude SDK we ship is ten versions behind what Artifactory already carries, and the newer one has a plugin source we just built by hand | IN | build | OWNER DIRECTIVE 2026-08-29: the 0.3.223 -> 0.3.233 upgrade is owed and the deliverable is the difference covered or removed; it must run on a quiet tree. |
| `P3.224` | we ship a codex version Artifactory carries only as alpha | IN | decision | We ship codex 0.148.0, which Artifactory carries only as per-platform alpha builds; an Artifactory-only rebuild cannot reproduce our binary. |
| `P3.226` | thinking `off` becomes `minimal` on codex, which has a first-class `none` | IN | residue | Thinking `off` maps to `minimal` on codex, which has a first-class `none`, so a user who turned thinking off is still billed for reasoning on every turn. |
| `P3.227` | style changes now take effect at different times on different runtimes | IN | residue | An output-style change now takes effect immediately on codex (per the page) and at the next session on pi and claude — converge, probably by moving those two to the page. |
| `P3.231` | two more hook silences survive one predicate past what P6.12 closed | DEFERRED-LAST | build | An http hook refused for a credential-bearing descriptor is still refused silently, and nestor-cloud carries the same Stop-result discard the shared path just fixed. |
| `P3.234` | codex ignores the compaction off-switch, and whether it HAS one is unmeasured | IN | residue | config-writer writes the compaction limit unconditionally, so a user who turned auto-compaction off keeps it on after switching to codex; ask the native-first question first. |
| `P3.235` | two compaction env knobs stop at Pi while the SDK has direct counterparts | IN | residue | Two compaction env knobs bind on Pi and reach claude never, while the SDK carries direct counterparts — configuration, not construction; the three-line wiring is recorded. |
| `P3.236` | the browser on codex needs a permission gate before it needs a bridge | DEFERRED-LAST | residue | codex has no PreToolUse path for MCP-shaped calls, so wiring the browser first would ship arbitrary in-pane JavaScript with no mode check: gate first, bridge second. |
| `P3.242` | an import reports success and its text never reaches the model | IN | build | DECIDED 2026-09-01 (refuse, naming the override, ~5 lines) plus the orthogonal item the owner did not fold in: the panel never renders which file an import lands in. |
| `P3.243` | one settings key marks the plugin tier managed-distributed without any narrowing having run | IN | residue | One settings key keeps the whole plugin tier as if vetted AND marks it managed-distributed, immune to a user's disableAllHooks, with no narrowing having run. |
| `P3.244` | managed `enabledPlugins` accepts only our internal spelling, not the documented one | IN | residue | Managed enabledPlugins accepts only our internal pluginKey spelling, so an administrator writing the documented plugin-name@marketplace form is silently stripped (fail-open). |
| `P3.245` | a docblock describes a bundle we no longer ship, and one warning is now false because of it | IN | residue | A docblock dated to a bundle we no longer ship makes a shipped warning false: it tells an operator compaction is OFF when the runtime now compacts. |
| `P3.246` | the sign-in verdict has no change notification, which is what pins MCP connect to blocking | IN | residue | The sign-in verdict has no change notification, which is the single reason non-blocking MCP connect (Claude's documented default) could only ship opt-in. |
| `P3.247` | two first-turn blocks remain, and one of them is runtime-asymmetric | DEFERRED-LAST | residue | Two first-turn blocks remain and one is codex-only by construction; the previous lane died mid-work and its corrections to both halves live in this note. |
| `P3.248` | a server's instructions are pinned at handshake and never refreshed on two of three runtimes | IN | residue | A server's instructions are pinned at handshake on Pi and codex with no protocol refresh, while claude can refresh only when a reconcile happens to fire (crit 3). |
| `P3.250` | three more mode-guidance lines promise codex a prompt it does not guarantee | IN | decision | Three mode-guidance lines promise codex a prompt it does not guarantee; correcting them tells the model on every codex turn that our gates are advisory — a product posture. |
| `P3.251` | four blocks of codex-specific prompt prose are written for codex and reach no runtime | DEFERRED-LAST | residue | Four codex-specific prompt sections are emitted by a function codex never calls, so the MCP naming rules and source table the other two runtimes have never reach it. |
| `P3.252` | four `await`s have no effect, and the inaccurate signature belongs to a dependency | OUT | — | Four awaits with no effect from an inaccurate bun-types declaration; a tree-wide style call, measured behaviourally identical. |
| `P3.255` | the shipped codex binary has three methods the generated bindings name nowhere | IN | decision | The shipped binary has three background-terminal methods our generated bindings name nowhere — and whether we want a runtime managing terminals we cannot observe is the product question. |
| `P3.256` | an option field now selects nothing, and the compiler cannot catch a partial removal | DEFERRED-LAST | residue | An option field that documents itself as selecting nothing, surviving on two surfaces because tsc will not excess-property-check a conditional spread; four sites move together. |
| `P3.257` | the enforcement table is not finished, and two of its remaining classes are named but unmeasured | IN | residue | codex loads its own project document and declares two config keys governing it and we set neither — the same silence P3.254 just made honest on claude. |
| `P3.258` | the strongest check on this tree is networked, commented out in CI, and run by hand | IN | decision | The only check that could catch a bad codex regeneration wholesale is networked and commented out of CI; re-enabling is a CI and owner decision. |
| `P3.259` | a claude session may deliver the project instruction file twice, and nothing records it either way | IN | verify | A claude session may deliver the project instruction file twice, paid every turn, and nothing records it either way; the two remedies point opposite ways. |
| `P3.260` | the results filter is built, unwired, and reaching its one predicate costs a third of the Pi bundle | DEFERRED-LAST | residue | The results filter withholds nothing until it is wired at the Pi construction site, and the obvious route adds ~8.8MB to the Pi bundle to reach one boolean. |
| `P3.261` | the launch check runs ungated on a codex-only fleet, and persisting without a reader would be the same defect | IN | residue | P3.85's dispatch unit: persist the answered managed requirement and read it at bootstrap BEFORE the launch check, or a codex-only fleet stays weaker than a mixed one. |
| `P3.263` | the capability ledger — the plan's stated measure — has not been re-scored since `3288b115c` (2026-08-30), and the controller reads its stale cut | IN | build | THE PLAN'S OWN MEASURE is stale: the ledger was last scored 2026-08-30, since when 88 code commits and 89 row closures landed, and the controller reads that cut. |
| `P4.7` | Pi inspector — NOT BUILT (owner 2026-09-01); record the declined posture | IN | build | DECIDED 2026-09-01 (do not build): the remaining work is three recording items — the posture, the coverage-map cell as declined-not-missing, and P2.478. |
| `P5.3` | registers regen | IN | build | Register regeneration is contaminated by three untracked files that belong to no lane; use --check first and resolve their ownership before regenerating. |
| `P5.4` | close-out | IN | verify | Close-out: TWO owed rebuilds (electron:build and electron:build:servers), version/notes/docs-site, and the CDP cases this plan must add. |
| `P6.21` | a scheduled task's per-run worktree is swept on the Pi child path and leaked on the other two | IN | build | A scheduled task's per-run worktree is reclaimed on the Pi child path and leaked on the other two — the leak half landed as P2.427, so verify against HEAD. |
| `P6.23` | deferred tool loading is Pi's alone, and a BYO claude connection turns the SDK's own on where we can neither see it nor render it | IN | build | Deferred tool loading: the OFF state is now uniform across runtimes and the ON state stays invisible on claude (residue closed as P2.457) — verify and close. |
| `P6.29` | nobody has measured whether WebSearch executes on the claude runtime through our gateway | IN | verify | Nobody has measured whether Claude's server-side WebSearch executes through our gateway; the ledger cell is a null, not an absence. |
| `P6.38` | one host skill marker serves three runtimes and the decision is recorded nowhere, so a pasted `$plugin:skill` resolves to nothing | IN | build | One host skill marker serves three runtimes, so a pasted $plugin:skill — the spelling the vendor documents — resolves to nothing (crit 2). |
| `P6.43` | the gateway correlation and operator custom headers never reach a claude request | IN | build | The gateway correlation header and operator custom headers reach no claude request under Electron; the mechanism landed, the two-call-site wiring is P2.422. |
| `P6.44` | `/heapdump` snapshots the host and never the process holding a claude conversation | IN | build | /heapdump snapshots the host and never the process holding a claude or codex conversation; the decision is recorded — say which process it captured and name the one it could not. |
| `P6.55` | the compaction-thrashing guard has exactly one producer, so a context that refills after every compaction loops the turn on codex | IN | build | The compaction-thrashing guard has one producer; codex counts and warns but does not interrupt mid-turn (that half landed as P2.437) — verify and close. |
| `P6.56` | four of the rewind menu's six documented actions exist on no runtime | IN | build | Three of six documented rewind actions are missing, two of them documented-and-impossible, plus five uncounted host-side items no runtime blocks. |
| `P6.57` | no command surfaces the session's running work — `/tasks`, `/workflows` and `/plugin` are absent from a curated seventeen | IN | build | No command surfaces the session's running work — /tasks, /workflows and /plugin are absent from a curated seventeen; explicitly IN per the 2026-08-28 ruling. |
| `P6.60` | one setup-script string is handed to `cmd.exe` and `/bin/sh` alike, so a cross-platform user can declare only one of the two | IN | build | One worktree setup-script string is handed to cmd.exe and /bin/sh alike, so a cross-platform user can declare only one of the two. |

## 5. The five `⏸` rows — parked by an owner ruling, not re-decided here

| Row | Title | The ruling that parked it |
| --- | --- | --- |
| `P2.335` | the cloud agent carried three of six, and has no corpus to check it against | Owner 2026-08-29: the remote agent is not a fourth column (no local runtime, so nothing to switch); parked for a close-out re-check folded into P5.4. OQ-14 governs. |
| `P4.1` | scheduled-tasks list | Phase-4 process decision (owner 2026-08-23): drawn in the playground LAST, after the phase-2/3 rows it renders are closed. |
| `P4.3` | watches in panel | Phase-4 process decision (owner 2026-08-23): same — waiting on its own data, not on a sketch from the owner. |
| `P4.10` | settings stop rendering unenforceable blockedTools | Phase-4 process decision (owner 2026-08-23); what the settings page should DO about unenforceable blockedTools is a product call with its own i18n/visual surface. |
| `P6.9` | shell, hook and stdio-MCP launches have no corporate-launcher seam, in the deployment the page is written for | DEFERRED TO LAST by owner ruling 2026-08-28, in the owner's own words; the measurement stands (three live unwrapped spawn sites, UNIFORM, absent everywhere). |

`P4.1`, `P4.3` and `P4.10` share one cause — the Phase-4 process decision — and it is worth noting that it
is **satisfiable**: they wait on the phase-2/3 rows they render, not on a sketch from the owner. `P4.10`
carries a product call inside it (*what should the settings page do about the ~15 `blockedTools` names the
runtime never honours — warn, grey out, filter, annotate?*) but that call is made **in the playground, when
the surface is drawn**, so it is not on the decision brief. `P2.335` waits on OQ-14. `P6.9` is the only one
deferred on priority alone.

## 6. What this pass did not do

- It did not re-measure a single row. Every verdict is read from the row's own note; where a note records
  a measurement, that measurement is quoted rather than repeated.
- It did not check any row against HEAD. `P2.401` measured that three rows were dispatched against work
  already landed, because the tracker's baseline lags the branch — so a `build` verdict here is a
  statement about the note, and the dispatch-time check `P2.401` asks for still applies.
- It did not touch the plan, the ledger, or any source file.
