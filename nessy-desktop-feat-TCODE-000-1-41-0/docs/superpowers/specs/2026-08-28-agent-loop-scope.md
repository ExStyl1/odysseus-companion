# The agent-loop scope cut: every open parity row, classified

Written 2026-08-28 by lane s1. **This is a proposal, not an edit.** The plan file
`docs/superpowers/plans/2026-08-22-runtime-parity-closure.md` is the controller's and is sorted by a
script; nothing here was written into it.

Companion document: `2026-08-28-runtime-feature-inventory.md`, which enumerates what each runtime
actually offers and draws the same boundary against the features rather than against the rows.

## What was classified

Every open row in the tracker — glyph `⬜` or `🟨` in the status cell. Parsed from the tracker at
HEAD: **679 rows total, 391 `✅`, 277 `⬜`, 3 `🟨`, 7 `⏸`**. The `⏸` rows are open but blocked on an
owner answer and the brief scoped this pass to `⬜`/`🟨`; they are listed unclassified in the
appendix so the count is honest rather than tidy.

## Counts

| Verdict | Rows |
| :-- | --: |
| **IN** | 176 |
| **OUT** | 99 |
| **GATED** | 1 |
| **DEFERRED-LAST** | 1 |
| **UNCLEAR** | 3 |
| **Total open (`⬜`+`🟨`)** | **280** |

`GATED` and `DEFERRED-LAST` exist because two rows are neither in scope nor safely deletable:

- **`GATED`** — a provider-subscription surface that is *built and hidden behind a build flag*, not
  absent. The owner: *«мы их потом добавим, то есть это можно сделать, но скрыто — раньше это
  работало, потом откроем»*. `NESSY_FEATURE_PROVIDER_CLAUDE` / `PROVIDER_CHATGPT` default **off**
  while the two runtime flags default **on** (`AGENTS.md` §Commands). Keep it working, do not
  delete it, do not spend on it now. Filing one of these as `OUT` would invite someone to remove
  code the owner intends to re-open.
- **`DEFERRED-LAST`** — the owner has ruled on the row's *priority*, not on its *finding*. Used
  only where an owner ruling exists; never on my own judgement.

## The boundary rule

**A row is IN when it changes — or protects from silent change — one of three things: (1) what the
model is told, (2) what the model may do, (3) what a tool call passes through. It is also IN when
it makes the three runtimes differ at a switch, or when it removes host machinery a runtime already
provides natively.** A row is OUT when its only effect is on our own records, our build and test
instruments, host presentation, or a report that gates nothing.

Three qualifications, each of which changed an answer while I was writing:

1. **A section's category label decides nothing; the note decides.** Notifications produced an IN
   (`P6.52` — `PushNotification` is a model-callable tool held to one runtime) and four OUTs.
   Managed-policy administration produced eleven INs, because a managed control that silently stops
   controlling changes what the agent may do whatever its category is.
2. **A control that silently stops controlling is IN regardless of category.** That is this fork's
   largest defect class and the rule that pulls in `P2.119`, `P2.258`, `P3.43`, `P6.33`, `P6.53`.
3. **Test and verification rows are IN only when the behaviour they pin is one of the three, AND
   the note shows it is currently unprotected.** `P2.189` is IN because deleting the managed-only
   lock forwarding left 225/225 green; `P2.187` is OUT because it is a repo-wide assertion sweep.

What the rule cuts, stated plainly so the owner can overrule it: **provider sign-in and subscription
flows** (we use `dp` against our own endpoint) — but as `GATED`, not deleted; **organisational
reporting** *unless* the report is of a permission verdict (`P6.42` is IN for exactly that reason);
**host UI, notifications, accessibility, keybindings**; and **our own bookkeeping** — dead
citations, drifted counts, stale registers, build gates and measurement rigs. That last group is
the single largest thing the cut removes, and the plan already measured it at roughly 80 rows.

## The largest OUT clusters

| Cluster | Rows | What the cut actually removes |
| :-- | --: | :-- |
| Documentation, citations and coverage-map bookkeeping | 24 | Dead `settings.md:<line>` anchors, phantom quotes, stale coverage maps, register regeneration, one-sentence comment corrections. No runtime behaviour depends on any of it — but see the two carve-outs below. |
| Build, CI and typecheck/lint gate plumbing | 15 | `&&` chains that hide reds, packages outside `typecheck:all`, a lint script that OOMs and reads as a pass, tsconfig excludes. Real defects in our instruments; invisible to a user. |
| Dead code, stale comments and consolidation | 11 | Fields parsed and never read, dead unions, duplicated expressions, stale comments. Six of these are one family the plan keeps re-meeting. |
| Measurement-rig and evidence-capture traps | 10 | Traps that corrupt evidence — a worktree that measures the parent tree, a rig that reports isolation it did not achieve, `pipefail`, the test mutex. High value to the team, zero to the product. |
| Host UI, notifications, accessibility, keybindings | 10 | Accessibility, keybindings, notification timing, composer queue verbs, thinking-block rendering, dead renderer keys. Named out by the boundary. |
| Test-assertion quality sweeps | 9 | Assertion sweeps (`toHaveLength`, bare `toBe(true)`, vacuous optional chains), fixture discipline, tests guarding unreachable paths. |
| Lane process and git discipline | 4 | `git commit --amend` under concurrency, the isolated-index recipe, zone ownership. |
| Live/packaged verification cases owed | 3 | Live/packaged cases owed for behaviours already proven by unit. |
| Host performance | 2 | Rows: `P2.63`, `P2.201` |
| Permission-splitter internals (owner-deferred family) | 2 | Rows: `P2.92`, `P2.104` |
| Cost and usage reporting that gates nothing | 2 | Rows: `P2.227`, `P3.98` |
| Platform reach outside the three runtimes | 2 | Rows: `P2.352`, `P3.7` |
| Operator diagnostics | 2 | Rows: `P3.38`, `P6.44` |
| Host convenience features | 1 | Rows: `P2.11` |
| Provider credential diagnosis | 1 | Rows: `P3.90` |
| Release and close-out mechanics | 1 | Rows: `P5.4` |

The eight small clusters below the fold, for completeness: host performance 2 (`P2.63`, `P2.201`);
permission-splitter internals 2 (`P2.92`, `P2.104` — the owner-deferred family, and both already
fall to the safe side); cost/usage reporting that gates nothing 2 (`P2.227`, `P3.98`); platform
reach outside the three runtimes 2 (`P2.352` iOS, `P3.7` WSL); operator diagnostics 2 (`P3.38`,
`P6.44`); host convenience 1 (`P2.11`); provider credential diagnosis 1 (`P3.90`); release
mechanics 1 (`P5.4`).

### Two carve-outs from the bookkeeping cluster, which is otherwise the safest thing to cut

- **`P2.308`** is filed OUT as a corpus sweep, but one of its five unread codex pages is `webmcp` /
  Site tools, which documents **a tool surface we ship**. Read that page into the feature inventory
  rather than closing it as bookkeeping.
- **`P3.178`** carries no work today; its only action is a **re-check trigger** on the next SDK or
  corpus refresh. OUT means *not now*, not *delete the trigger*.

## The three UNCLEAR rows, and what is missing from each

**`P2.261` — a runtime-assigned proxy env var is invisible to env spreads in Bun.** Written as a measurement-rig trap (a runtime-assigned proxy variable is invisible to `Object.keys`/spread on Bun 1.3.14), but the same mechanism is live in `projectProxyEnv`, which writes the proxy into `process.env` at runtime. MISSING: whether any production spawn path builds a runtime child's env by spreading `process.env` after that assignment — if one does, this is a silent egress bypass (IN); if none does, it is rig discipline (OUT). The note measures only the rig.

**`P2.335` — the cloud agent carried three of six, and has no corpus to check it against.** MISSING: whether the nestor-cloud remote agent is in scope at all. The four goals name pi, claude and codex; this row (and P3.158) shows the product's own runtime vocabulary has FOUR values. If the cloud agent counts as a runtime under goal 1 this is IN; if it is a separate product line it is OUT. That is an owner call, not a lane's.

**`P3.67` — the credential-paired-routing exception is deliberately inert.** MISSING: what the credential-paired-routing exception actually governs when reached. The note says only that it exists, is exercised by nothing, and reads as coverage. If it belongs to the credential/egress floor it is IN; if it is scaffolding it is OUT, and the row does not say which.

## The full table

Ordered as the tracker orders them.

| Row | Title | Verdict | Reason |
| :-- | :-- | :-- | :-- |
| `P2.11` | background auto-commit | **OUT** | Host-side git convenience on background-session completion; uniform on all three, changes nothing the model is told or may do, and thickens the host against goal 2. |
| `P2.46` | the backwards-total guard splits its two causes | **IN** | Cost totals feed the spend ceiling that stops turns; folding a crash into a `/clear` reset is a silent permanent undercount, i.e. a gate that stops gating. Unreachable today, so low priority — not out of scope. |
| `P2.47` | the block-escape set guard covers every reachable branch | **IN** | Guards the permission block-reason branches; the set already covers 6 of 8 reachable branches and the escape literals are copied to a third place, so the guard on a permission verdict has already drifted. |
| `P2.53` | the bare-form role prefix, decided | **IN** | Transcript entry rendering fed to the model; a body can forge a host-authored `User:` opener. This is what the model is told. |
| `P2.56` | the mode picker ignores the workspace cycle | **IN** | A permission-mode control that is inert on one of its two surfaces; the mode decides what the agent may do without asking. |
| `P2.58` | hook stdout gets an in-band notice on nestor-cloud | **IN** | In-band prose telling the model that hook output is data, not authority — what the model is told, on nestor-cloud. |
| `P2.62` | a CDP case proves the index survives a restart | **OUT** | A live case for a durability behaviour already proven by unit; its own note says the case would not have caught either defect. |
| `P2.63` | three whole-store scans remain on Pi-only paths | **OUT** | Whole-store scans on Pi-only paths off the continuation path; its own note says cost, not correctness. |
| `P2.77` | nothing justifies alphabetical source precedence | **IN** | Alphabetical source precedence decides which source wins a tool permission conflict — slug spelling is load-bearing for allow/deny. |
| `P2.83` | the advisor's field labels are outside the vocabulary | **IN** | The advisor transcript is fed to a model and a body can forge a tool `result:` line; a fabricated tool result reads as ground truth the host observed. |
| `P2.86` | a hand-rolled `User: ` opener survives in-tree | **IN** | Same family: a hand-rolled transcript opener outside the one seam that makes forgery impossible. Not a defect today; the lint rule is what makes the seam's claim true. |
| `P2.92` | powershell here-strings are unmodelled | **OUT** | No executable miss could be constructed — every here-string shape lands on `unparseable` -> prompt, the safe side — and closing it means making the splitter cleverer, which the owner's dumber-splitter ruling and goal 2 both refuse. |
| `P2.100` | the blast-radius sweep is prose, not an artifact | **OUT** | Evidence hygiene: a phantom citation living only in plan rows, plus optional fuzz tooling. No runtime behaviour depends on it. |
| `P2.104` | the ANSI-C glued-head is a pre-existing 2-hole fuzz residue | **OUT** | Pre-existing ANSI-C residue that already falls to the conservative side; the dumber-splitter ruling says do not chase it. |
| `P2.111` | the moved-class prompt should name its own remedy | **IN** | Makes the accepted Pi vs claude/codex divergence at the gate honest to the user; AGENTS.md's native-first rule requires the residual difference be uniform or honest. |
| `P2.115` | a partially-refused parallel fan-out blocks the immediate return | **IN** | Subagent fan-out return semantics: the tool result the model reads says `Started background subagent task` for a run that has already completed. |
| `P2.119` | host wiring has no behavioural test surface | **IN** | Money-adjacent host wiring: deleting the spend-ceiling wire restores a per-instance ceiling walk-past with `tsc` and every behaviour test green — a control that stops controlling with nothing red. |
| `P2.125` | a handoff passes an image as a path the model cannot open | **IN** | Runtime-switch handoff passes an image as a path the receiving model cannot open. Goal 1, directly. |
| `P2.147` | replaced-default folders may be short two entries | **OUT** | Warning-only constant drift, and the row's own header flags it UNCONFIRMED; its stated cost is at most a missing warning. |
| `P2.163` | a run that admitted nothing still says it started | **IN** | A workflow tool names an outcome it did not observe, in a result the model reads. |
| `P2.164` | the accepted cost is wider than the decision text said | **IN** | A backgrounded workflow that never calls `agent()` now blocks the turn for its whole duration — turn lifecycle, and an owner decision taken on a narrower cost description. |
| `P2.175` | the strict drain coalesces without knowing what must survive | **IN** | Monitor-watch survival must be uniform on all three runtimes or none, and `agent view stop` can return `ok: true` while leaving a watch alive — a stop that reports success without stopping. |
| `P2.187` | the loose-assertion sweep is a third done | **OUT** | Repo-wide test-assertion quality sweep; no runtime behaviour depends on it. |
| `P2.188` | three removal spellings the fallback still will not name | **IN** | The destructive-removal floor decides what the agent may do, and its long-option behaviour cannot be measured against GNU `rm` on this host at all — a whole class of the floor is unverified. |
| `P2.189` | sixty-two bare true-assertions guard permission answers | **IN** | Permission-outcome assertions that stay green when the policy behaviour is deleted: the managed-only lock forwarding, the builtin/managed swap and the domain allowlist each survived removal at 225/196/159 green. |
| `P2.191` | four phantom quotes remain in the managed-policy header | **OUT** | Phantom quotes in a source header; the enforcement they annotate is unchanged. |
| `P2.197` | six of seven modes leave the asking to the model | **IN** | With the sandbox off, six of seven modes emit codex `on-request` — `The model decides when to ask` — so a command the model never raises reaches no gate at all. |
| `P2.201` | the merged-config memo is still unmemoized | **OUT** | A performance memo; the structural hazard is already mitigated by the frozen publish. |
| `P2.203` | model-supplied slugs reach the merge unvalidated | **IN** | Model-supplied source slugs arrive over the wire as a bare string array and reach the permission merge unvalidated. |
| `P2.214` | two held one-liners and a message that names the wrong operation | **IN** | A malformed skill grant list is refused at import and still trusted at enforcement, and a READ tool is refused with a message naming write operations — a user learns the wrong rule. |
| `P2.215` | the AGENTS.md diff rule yields five false positives | **OUT** | The rule's repair is documentation hygiene; AGENTS.md now carries the 13-row analysis and its own measurement that `lspServers` is NOT the `lsp`/`lspServers` family recurring, so no runtime behaviour is owed. |
| `P2.216` | a twenty-second restatement fails open to pi | **IN** | The runtime-switch copy is a twenty-second restatement of the runtime list and fails open to `pi`, so a switch describes the wrong runtime to the user. Goal 1's honesty half. |
| `P2.217` | the approve menu row and two headless-empty surfaces | **IN** | Carries a silent-corruption path in `makeSessionPathPortable`, which feeds the session mirror a switch reads, plus an unlanded `/approve` affordance for durable approvals. |
| `P2.218` | server-core is sixteen errors from strict indexing | **OUT** | Typechecker strictness backlog in one package. |
| `P2.220` | the safe-mode grant guard is a named spot-check list | **IN** | Flipping a session tool's `safeMode` grant allow->block is invisible to the suite for the unnamed majority (35 allow / 26 block defs, ~11 and ~8 named by hand) — the guard on what the agent may do names members, not the property. |
| `P2.221` | MCP_ENTRY_KEYS order is enforcement-visible and undocumented | **OUT** | The enforcement order is already pinned from the test side; the row's whole deliverable is one explanatory comment. |
| `P2.222` | an `&&` chain hides every package after the first red | **OUT** | `typecheck:all` and `lint` are `&&` chains that hide every package after the first red; build-gate plumbing. |
| `P2.223` | a non-null assertion resolves to undefined at runtime | **IN** | `setModel(undefined)` neither throws nor no-ops — it assigns, and `getModel()` returns it. Which model runs the turn is the loop's most basic input, and the null path is user-reachable. |
| `P2.224` | twenty-eight vacuous assertions across thirteen files | **OUT** | Vacuous-assertion sweep with a per-hit human verdict; the row's own correction says roughly half are not the defect. |
| `P2.227` | four residues from the budget-notice guard | **OUT** | Cost-notice wording and test shape; measured, the guard cannot fire on either runtime that uses the arm it gates. |
| `P2.229` | four packages still let an inert waiver pass | **OUT** | Lint configuration parity across four packages. |
| `P2.230` | the zeroed-crash fixture is not zeroed | **OUT** | A test fixture whose name overstates what it drives; the verdict it pins does not depend on the numbers. |
| `P2.231` | a worktree's symlinked node_modules measures the parent | **OUT** | A worktree measurement trap for the verification kit; it invalidates evidence, it does not change behaviour. |
| `P2.232` | initialize and thread/start are unbounded on the same path | **IN** | `initialize` and `thread/start` are unbounded on codex's spawn critical path at 10.5 s and 34.7 s cold — a 35-second start indistinguishable from a hang is the runtime's own agent-loop startup, and pi and claude do not behave this way. |
| `P2.233` | codex-agent-server has no gates at all | **OUT** | A package with no eslint config, no tsconfig and no place in `typecheck:all`. |
| `P2.234` | three residues from the dev-staging fix | **OUT** | Three build recipes for one Pi artifact, a missing dev watcher and bundle size. |
| `P2.235` | the digest gate covers six of seventy-seven pins | **IN** | The pins guard the tool schema identity and the `exact-name:<tool>` wire-name prefix the model sees; `--pin` manufactures a stale prefix the gate reports green, so a rename can change the model's tool surface unnoticed. |
| `P2.236` | the hook_context fences carry no notice | **IN** | Every transcript fence carries an untrusted-content notice; the whole `hook_context` family attaches none, on codex and nestor-cloud, and the composed turn never explains the tag. What the model is told. |
| `P2.237` | the test mutex crashes while waiting | **OUT** | The test mutex crashes while waiting; the cost is misattribution in reports. |
| `P2.238` | the wording is decided by notification timing, not the runtime | **IN** | A permanent runtime property — codex cannot price a turn — is reported as a per-turn accident depending on notification timing. A runtime-capability claim is the switch lens's substance. |
| `P2.239` | one verdict collapse, written three times | **OUT** | Internal dedup of one cost-verdict expression written three times; no behaviour change. |
| `P2.240` | a 10s spawn ceiling reads as an assertion failure | **OUT** | Test-rig legibility for a spawn ceiling whose production expiry already falls to the safe side. |
| `P2.241` | every POSIX command pays a PowerShell subprocess | **IN** | Every Bash permission check spawns a PowerShell subprocess: measured 2 s -> 1318 s on one suite once the validator resolved correctly. This is latency on the path every Bash tool call passes through. |
| `P2.242` | packages/shared's tests are never typechecked | **OUT** | `packages/shared/tests/**` sits outside `typecheck:shared`; the row's own correction strikes its causal anecdote. |
| `P2.243` | two classifiers read the same code oppositely | **IN** | Codex capability probing reads `-32600` as method-absence when the shipped binary returns it for everything, so a live feature can be declared `unsupported` — a capability verdict the switch lens and the loop both read. |
| `P2.244` | the alarm fix drops sub-keys silently | **IN** | Five managed `sandbox` sub-keys land in the policy, map to nothing and emit zero diagnostics — an administrator's setting that silently stops being carried, in a module whose stated contract is that unsupported keys are surfaced. |
| `P2.246` | a gate report printed bun's ran count as its pass count | **OUT** | Report-template discipline: state bun's pass/skip/fail split rather than the ran count. |
| `P2.247` | a third script rebuilds Pi and never stages it | **OUT** | A third script that rebuilds Pi and never stages it, spending 27 MB on an artifact the server distribution never ships. |
| `P2.248` | a ledger test's docstring carries a refuted cause | **OUT** | A test docstring carrying a refuted cause; the assertions stay. |
| `P2.250` | a hook's block reason is elemented but unfenced | **IN** | `recordHookBlockFeedback` composes a hook's reason into an element with no fence and no defang, in shared base code that reaches all three runtimes. What the model is told. |
| `P2.253` | four residues from the escape-hint and register work | **OUT** | Escape-hint wording registry and measurement-register hygiene; the one substantive item (a Windows shim exercised only on POSIX) is coverage, not behaviour. |
| `P2.255` | the gate and its test run on different commands | **OUT** | A gate and its test ride different commands; which command a lane is guaranteed to run. |
| `P2.256` | a rig that looks isolated and is not | **OUT** | The standard isolation recipe silently fails to isolate outside `bun test`; a rig that reports success. |
| `P2.258` | codex's USD ceiling counts zero forever | **IN** | A user setting a USD ceiling on codex gets a warning and a cap that will never fire, because the cap accumulates a field codex emits nowhere. A control that silently stops controlling, and it differs by runtime. |
| `P2.261` | a runtime-assigned proxy env var is invisible to env spreads in Bun | **UNCLEAR** | Written as a measurement-rig trap (a runtime-assigned proxy variable is invisible to `Object.keys`/spread on Bun 1.3.14), but the same mechanism is live in `projectProxyEnv`, which writes the proxy into `process.env` at runtime. MISSING: whether any production spawn path builds a runtime child's env by spreading `process.env` after that assignment — if one does, this is a silent egress bypass (IN); if none does, it is rig discipline (OUT). The note measures only the rig. |
| `P2.262` | the deadline helper's own doubles ignore the timeout too | **OUT** | A helper with no behavioural defect whose doubles ignore the timeout; a row about evidence, not behaviour. |
| `P2.263` | the HOST's own loopback requests are proxied too, and it is the same shipped card | **IN** | The host's own loopback fetch is proxied, and the fix spans `shouldBypassProxy` AND `projectProxyEnv` — the variable every runtime child inherits. The network trust chain is what all three runtimes' traffic passes through. |
| `P2.266` | a source comment still says P2.226 is open | **OUT** | One stale source comment claiming a closed row is open. |
| `P2.267` | a third lock/operand pair, and withholding it is a product decision | **IN** | `allowManagedPermissionRulesOnly` + `claudeRules.allow`: its `WebFetch(domain:...)` residue can reproduce a deny-all through the network allowlist — the same inversion by a different door. |
| `P2.268` | a restrictive sandbox key the mapper neither sends nor reports | **IN** | `sandbox.filesystem.disabled` is a RESTRICTIVE key our mapper neither sends nor reports, so the agent is less restricted than the administrator set and nothing says so. |
| `P2.269` | more than 512 permission entries still collapses the whole layer | **IN** | More than 512 permission entries collapses the whole layer, and for deny rules choosing which survive is the widening direction. Named in the plan's own live-shipped-holes carve-out. |
| `P2.275` | a piped gate on this plan reported the pipe's status, not the gate's | **OUT** | `pipefail` is off, so a piped gate reports the pipe's status; evidence-capture discipline. |
| `P2.285` | 772 dead doc anchors remain, and one row re-hung 55 of them | **OUT** | 772 dead line anchors; conversion to section anchors plus verbatim sentences. |
| `P2.288` | an `ifRule` is validated at none of its four registration sites | **IN** | A hook's `ifRule` condition is validated at none of its four registration sites, so a malformed condition is reported only at evaluation — on every tool call, where the contract says we must not fail closed. |
| `P2.291` | extend the enumerating-doc guard to the Claude and Pi tables | **OUT** | A drift guard over doc tables; the per-runtime truth it protects is real, but no runtime behaviour depends on the guard. |
| `P2.294` | turn 1 of a bridge-less codex session is still lied to | **IN** | Turn 1 of a bridge-less codex session offers `/loop` with its four cron tools absent — the model-facing tool listing is wrong for a whole turn. |
| `P2.295` | a seventh site of the dead pi-only claim, in the renderer | **IN** | A seventh site of a dead `pi-only` claim about the cron tools, in the renderer, where the user reads per-runtime truth. |
| `P2.305` | five more inert-spec entries are stale, four naming live code | **OUT** | Inert-spec entries naming live code; a deletion hazard in a worklist, not a behaviour. |
| `P2.307` | the codex coverage map is stale and was wrong when written | **OUT** | The codex coverage map is stale and was wrong in both directions when written; corpus accounting. |
| `P2.308` | the codex corpus grew to 143 pages and five were never opened | **OUT** | Corpus sweep of five unread codex pages. CARVE-OUT: one of the five is `webmcp` / Site tools, which documents a tool surface we ship — read that one into the feature inventory rather than as corpus bookkeeping. |
| `P2.310` | the ⛔ column of the codex map has never been re-triaged | **OUT** | Re-triage of the codex map's 73 not-our-surface rows; corpus accounting, though a wrong not-our-surface verdict is exactly what hides a contract we should have taken. |
| `P2.312` | one command in seven has the breaker as its only floor | **IN** | Measured 2,517 of 18,272 real agent commands — one in seven — reach the fallback with the removal breaker as their SOLE floor, whatever rules the user has. |
| `P2.318` | the codex model preference list is one-of-seven live | **GATED** | Changes which model a connection talks to, but the connection is `PI_PREFERRED_DEFAULTS['openai-codex']` — the ChatGPT-authenticated card behind `NESSY_FEATURE_PROVIDER_CHATGPT`, default off. Built and hidden; keep it working, do not delete it, do not spend on it now. |
| `P2.320` | `/compact` with an attachment still bypasses the seam on Claude | **IN** | `/compact` carrying an attachment bypasses the command seam on Claude and reaches the model as prose; compaction is context management and this is a claude-only divergence. |
| `P2.321` | a codex test now guards a path that cannot be reached | **OUT** | A codex test that guards no reachable path while continuing to look like coverage. |
| `P2.322` | the composer still prefills a command three runtimes refuse | **IN** | `/subtask` is prefilled on three runtimes that decline it while `/compact` marks itself unavailable on the runtime that cannot do it — two treatments of one situation, neither written down. Goal 1's honesty half. |
| `P2.327` | `disallowed-tools` cannot be expressed for a ceiling-less child | **IN** | A skill's `disallowed-tools` has no wire representation for a ceiling-less child; if the child's own gate does not enforce it independently, a skill author's exclusion is being dropped. |
| `P2.329` | a newline in a quoted argument slips past every glob rule, including DENY | **IN** | A newline in a quoted argument fails every `*` pattern including DENY, on 2,482 corpus subcommands; the sweep found twelve compilers where the row named one and five still carry the omission. |
| `P2.335` | the cloud agent carried three of six, and has no corpus to check it against | **UNCLEAR** | MISSING: whether the nestor-cloud remote agent is in scope at all. The four goals name pi, claude and codex; this row (and P3.158) shows the product's own runtime vocabulary has FOUR values. If the cloud agent counts as a runtime under goal 1 this is IN; if it is a separate product line it is OUT. That is an owner call, not a lane's. |
| `P2.338` | a rename whose blocker is gone, and a `void` that outlived its reason | **OUT** | A rename whose blocker is gone and a `void` that outlived its reason; explicitly maintenance. |
| `P2.344` | a managed deny lock misses a path with a newline, and one edit cannot fix it | **IN** | A managed deny lock carrying `**/.ssh/**` does not fire on a path containing a newline, and one `s` flag cannot fix it because the same compiler serves deny and grant — the compiler must be split by direction first. |
| `P2.348` | the faithfulness gate's budget covers work that has no bound | **OUT** | A CI gate whose 120 s budget covers five unbounded `git archive` runs of the same tree. |
| `P2.349` | five readers of one variable, four independent parses, no shared definition | **OUT** | Consolidating five readers and four hand-rolled parses of one environment variable. |
| `P2.352` | a 116-file iOS client is in no map and no typecheck | **OUT** | A 116-file iOS client outside the monorepo map and every sweep; not one of the three runtimes. |
| `P2.353` | a lint script OOMs and reads as a pass | **OUT** | `lint:electron` exhausts Node's heap and exits 134, which a caller reading an exit status records as a pass. |
| `P2.355` | the output limits are five documented numbers against our one | **IN** | Five documented output limits against our three byte caps, and the page counts CHARACTERS while ours count BYTES — a model reading a truncated tool result cannot tell truncation from completion. |
| `P2.357` | a dead reset feature is the only thing keeping 34 setters harmless | **OUT** | Thirty-four silent no-op setters are unreachable solely because their only trigger is dead code; near-term deliverable is a documented dependency at both ends. Note the trigger (a reset/logout surface) sits in the GATED provider-auth area. |
| `P2.358` | the lint gate proves a config exists, not that it matches anything | **OUT** | The lint gate proves a config exists, not that it matches any files. |
| `P2.359` | three barrel files are imported by no test at all | **OUT** | Three barrel files reachable from no test; test topology. |
| `P2.360` | the same unbelted shape sits on the Stop path, which runs far more often | **IN** | `CodexAgent`/`NestorCloudAgent` `abort`/`forceAbort` carry the unbelted shape on the user STOP path, leaving an uncancelled remote task. You cannot operate an agentic system you cannot stop. |
| `P2.361` | Pi's restart path leaks a gigabyte-scale subprocess | **IN** | Pi's `disposeForRestart` orphans a ~1 GiB subprocess if anything above its last statement throws; runtime process lifecycle is what a restart and a switch both ride. |
| `P2.362` | two dead entry points lead into the path just fixed | **OUT** | `ClaudeAgent.close()`/`abort()` are on no interface and have no caller; no current behaviour. Take the delete-or-belt decision with P2.360. |
| `P2.363` | the splitter disagrees with the shell, and two rows have been spent downstream | **IN** | The sh splitter reports a subcommand list that disagrees with what the shell executes, and the fix is the DUMBER one its PowerShell sibling already ships: detect the disagreement and fall to `unparseable`. Root cause under two live permission rows. |
| `P2.364` | forty renderer keys and a whole security block that nothing reads | **OUT** | ~40 renderer keys and a whole pi-runtime security block computed, wired and rendered by nothing; the decision is finish-or-delete and nothing depends on it today. |
| `P2.365` | one isolation string still renders unconditionally | **IN** | `isolationEgressDeniedDesc` renders unconditionally, including under the switch-off banner where nothing is sandboxed — a safety claim about egress the user reads as true of their session. |
| `P2.366` | the output-limit module is landed and connected to nothing | **IN** | Wires the documented output limits into the model's Bash path; today the module is landed and no command is cut at any of them. |
| `P2.367` | an operator's output cap works on one runtime and is ignored on the other | **IN** | `BASH_MAX_OUTPUT_LENGTH` is forwarded to the Claude subprocess and honoured nowhere on Pi, so an operator's cap works on one runtime and is silent on the other. Goal 4 and goal 1 in one row. |
| `P2.368` | built-in dp MCP records are appended after the filter and escape the denylist entirely | **IN** | Built-in dp MCP records are appended AFTER the managed filter, so they escape the denylist on every path including runtime turns — measured surviving a Pi turn while denied by both `serverName` and `serverCommand`. |
| `P3.7` | WSL spike | **OUT** | A one-day feasibility spike for driving a runtime inside WSL2; a written verdict, no product code. |
| `P3.8` | codex-security home persistence | **IN** | Our ephemeral `CODEX_HOME` destroys a codex-native security plugin's config on every spawn — a runtime-native mechanism the host silently breaks, which is exactly what native-first forbids. |
| `P3.21` | no instrument catches an undriven terminal-event site | **OUT** | Choosing an instrument for a guard over turn-end emission sites; the sites themselves have behavioural rows. |
| `P3.23` | structured output has no runtime-independent validation point | **IN** | `outputSchema` is validated inside each runtime's own adapter with no host backstop, so a runtime arm that forgets ships unvalidated structured output. The host-is-the-floor question, on the shape OQ-6 already answered for permissions. |
| `P3.38` | no operator-visible surface says what codex trusts | **OUT** | An operator-facing disclosure of what codex trusts; the CA chain itself already reaches codex. |
| `P3.39` | `SSL_CERT_DIR` reads as a third CA override and is not one | **OUT** | One comment so the next lane does not `fix` a third CA override that is not one. |
| `P3.40` | the proxy docblock says codex consumes nothing from the projection | **OUT** | A stale docblock sentence about the proxy projection. |
| `P3.43` | the context-window drift detector is structurally dead on every gateway model | **IN** | The context-window drift detector reads only the static Anthropic registry, so it can never fire for a gateway or BYO model — which is every model on the shipped default card. An instrument that cannot fire reads as coverage. |
| `P3.44` | `CLAUDE_CODE_DISABLE_1M_CONTEXT` is never set | **IN** | A documented context-window control we never set; latent today and live the moment a gateway alias carries `[1m]`. Context is what the model is told. |
| `P3.45` | the codex shell has no network in any shipped configuration, and DNS exits 0 empty | **IN** | A codex session cannot reach the network from its shell in any shipped configuration while a Pi session can, and the diagnosis the user gets points at DNS. A first-order cross-runtime difference in what a tool call can do. |
| `P3.46` | the lane rules ban `git commit -a` and say nothing about `--amend` | **OUT** | One line into the lane rules and the traps spec about `git commit --amend`. |
| `P3.47` | `--replay-user-messages` is a stream-shape change, not a flag | **OUT** | A costing correction for an unadopted flag; nothing is built or changed. |
| `P3.48` | rewind clears the exact handle an SDK-side rewind would need | **IN** | Rewind clears `sdkSessionId`/`sdkSessionAnchors` — the handle an SDK-side rewind needs — and `enableFileCheckpointing` is absent from the live-session signature, so a conditional use would not respawn. The session-history surface a rewind and a switch both ride. |
| `P3.49` | the two-lists shape drops its second list again, sixth instance | **OUT** | A renderer event mirror drops two lists from a rewind event; the rewind behaviour is unaffected. |
| `P3.50` | the real context window may be fetchable from llm-proxy instead of invented | **IN** | The real per-model context window is published by llm-proxy rather than needing to be invented; the window is what fits in the model's context and today it degrades silently. |
| `P3.52` | `DISABLE_NONESSENTIAL_TRAFFIC` is a posture trade, not a telemetry fix | **IN** | One env var set on the claude GATEWAY path only, which per `env-vars.md#variables` also kills auto-updates, release notes, gateway model discovery and feature-flag fetching. An undecided posture asymmetry between two paths of one runtime. |
| `P3.53` | a managed OTLP endpoint marked `immediate` cannot arm an exporter built at bootstrap | **IN** | A managed value marked `immediate` cannot arm an exporter built once at bootstrap; the row's own instruction is to enumerate every `immediate` key, and some of those DO change what the agent may do mid-session. |
| `P3.56` | a codex native carry references no attachment at all | **IN** | The codex arm of the switch handoff never passes an attachment block that pi and claude both pass; the obstacle is a sync/async shape change, not a missing argument. Goal 1. |
| `P3.57` | a real image carry is reachable on Pi and blocked on Claude by EVIDENCE, not by types | **IN** | Carrying an image across a switch; the owner's direction is the simple option that works on all three — re-attach through the ordinary attachment path. Goal 1 plus goal 2. |
| `P3.60` | `disableWorkflows` records an enforcement verdict that is now vacuous | **IN** | A managed control recorded as `unmeasured` with the reason `our workflow gate enforces it` when there is no workflow surface off Pi — the honest verdict is not-enforced, and an administrator reading it draws the wrong conclusion. |
| `P3.61` | nobody has asked which other `ThreadStartParams` fields survive a codex fork | **IN** | `thread/fork` inherits `developerInstructions`; nobody has asked which other `ThreadStartParams` fields inherit, and we re-pass only `config` and `model`, so any non-inheriting field is silently lost on every fork. |
| `P3.62` | the codex e2e evidence is darwin-arm64 only, and three platforms ship | **OUT** | Evidence-scoping discipline: state the platform on every codex behavioural claim. |
| `P3.64` | the headless host applies no managed env at all | **IN** | The desktop host applies managed `env` and the headless one does not, so an administrator's environment policy is enforced or not depending on which binary the user runs, with nothing saying so. |
| `P3.65` | the `policyHelper` drop reason reads like a typo | **OUT** | One sentence restating why an owner decision dropped `policyHelper`. |
| `P3.66` | a packaged live case is owed for managed env | **OUT** | A packaged live case owed for managed env at desktop boot. |
| `P3.67` | the credential-paired-routing exception is deliberately inert | **UNCLEAR** | MISSING: what the credential-paired-routing exception actually governs when reached. The note says only that it exists, is exercised by nothing, and reads as coverage. If it belongs to the credential/egress floor it is IN; if it is scaffolding it is OUT, and the row does not say which. |
| `P3.68` | dead `settings.md:<line>` anchors survive in the managed tree | **OUT** | Anchor conversion in the managed tree; its own residue note records the five false citations as not fail-open here. |
| `P3.70` | the utility model is a per-connection field a switch silently re-resolves | **IN** | Only the main model is reported at switch time; the utility/mini model is silently re-resolved. The row's own note puts it on the owner's switches-correctly goal. |
| `P3.72` | L10's skill-listing cap is a flat constant, not a share of the window | **IN** | `SKILL_LISTING_MAX_CHARS` is a flat constant rather than a share of the window, so the initial skill listing takes a fixed bite out of a small model's context. What the model is told, and how much room is left. |
| `P3.75` | a `Read` deny must bind Edit and Write, and the fix site is NOT the one the row names | **IN** | A `Read` deny must bind Edit and Write, and the fix belongs in `evaluatePermissionDslV1` so all call sites inherit it — doing it in `pre-tool-use.ts` covers Pi and misses codex. CAUTION: lane z1 reports this row's premise refuted through the `absent-by-identifier-search` bias; re-measure before dispatch. Classified on its subject, not on its premise. |
| `P3.77` | A4's codex cell is now half right | **IN** | The read-side non-negotiable floor is still absent on codex: its only `shouldAllowToolInMode` call consults `deniedPaths` solely to stop a rule auto-approving, never to deny. A floor that exists on two runtimes and not the third. |
| `P3.79` | the invented default P3.32 declined is already shipped on the Pi path | **IN** | `pi-agent-server` stamps a hand-typed 131,072 context window on every custom-endpoint model and the electron preset seeds 262,144 above the gateway's own 262,000 — the invented default the plan declined, already shipped, on the card that ships. |
| `P3.80` | our allow-rule projection also turns the sandbox OFF for that prefix | **IN** | An execpolicy allow rule resolves to `Skip { bypass_sandbox: true }`, so every durable Always-Allow grant we project also removes the sandbox for that prefix. The user consented to the prompt going away, not the sandbox. |
| `P3.82` | a per-model switch strips our allow rules while keeping deny | **IN** | `AllowPrefixRules::IgnoreForCyberModel` strips allow-prefix rules per model while keeping deny, so the durability of a user's Always-Allow is conditional on the model in use and that condition is stated nowhere. |
| `P3.85` | the codex managed tier is module-scope and unpersisted, and the launch check is ungated | **IN** | The codex managed tier is module-scope and unpersisted and the launch check is ungated on a codex-only fleet, so an organisation running codex alone gets a weaker guarantee than the same policy elsewhere, silently. |
| `P3.87` | `I5`'s claude and codex cells may be scoring a capability that has no subject there | **OUT** | A ledger cell-scoring correction; the underlying worktree entry point is pi-only and no runtime behaviour changes either way. |
| `P3.88` | llm-proxy IS reachable with a personal key, and the two back ends disagree about the same model | **IN** | The two back ends disagree about the same shipped model's window (262,144 vs 262,000) and 17% of the catalogue carries a `<=1` sentinel — the context window is what fits, and a naive consumer ships a worse bug than the one being fixed. |
| `P3.90` | the gateway returns 500 on a wrong credential type, not 401 | **OUT** | Credential-type diagnosis on the model-catalogue endpoint plus a gateway-side defect; a real user-facing bug, but nothing the agent loop passes through. |
| `P3.97` | a classifier denial is never minted into a receipt | **IN** | A classifier denial is indistinguishable from a rule denial in our own record because the adapter never reads `decision_reason_type`. An unauditable influence on permission outcomes is worse than an absent one. |
| `P3.98` | classifier tokens are billed to our gateway and excluded from the usage we report | **OUT** | Cost attribution for classifier tokens; superseded in substance by P3.122's measurement, and no gate depends on the number. |
| `P3.99` | the 1.16.0 release note describes a breaker the SDK does not have | **OUT** | A release note describing our breaker as the SDK's; correct the note, do not change the breaker. |
| `P3.105` | denied paths are excluded from reads but not from SEARCH RESULTS | **IN** | `settings-reference.md#exclude-sensitive-files` promises three things and we deliver two: a search rooted above a denied directory still returns content FROM it. The deny is enforced on the request and not on the response. |
| `P3.113` | `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` flips first-party treatment of a foreign host | **IN** | An undocumented shipped control that flips first-party treatment of a non-Anthropic host — and our whole deployment is a loopback adapter in front of a corporate gateway. |
| `P3.118` | `ConfigWarningNotification` carries `path` and `range` and our record of it does not | **IN** | The wire shape carries `path`, the only non-textual way to tell which config artefact failed; our classifier matches on message text, so an upstream wording change silently unclassifies the warning and the security failure goes quiet again. |
| `P3.120` | the codex config warning reaches the log and no user | **IN** | The codex config-warning line reaches the session log only, and a packaged build logs nothing outside debug mode — for a real user the silent security failure is still silent. |
| `P3.122` | the classifier costs 110,519 characters of prompt per check, billed to us and reported to nobody | **IN** | 110,519 characters of system prompt per classifier check, x2 on the first auto-mode action. This is the cost input to the owner decision on whether a second model adjudicates what the agent may do. |
| `P3.123` | the page states model and provider requirements the shipped binary does not enforce | **IN** | The availability gate for auto mode — a permission mode — is a deny list in the binary where the page reads as an allow list, so a reader who trusts the page concludes auto mode is unavailable here. |
| `P3.124` | `permissionDecision` has four values and we may cover three | **IN** | `permissionDecision` carries four values including `defer`, and the measurement turned on sending a value versus omitting the field; if omitting is inexpressible in our hook contract, that blocker is ours. |
| `P3.125` | two comments now assert a falsehood, and one is load-bearing for a default | **IN** | The `claude-runtime` image default is `false` for a reason that is now dead, so a BYO vision-capable upstream is denied a capability that works. What the model can see. |
| `P3.126` | `input_audio` is a third modality with no row anywhere | **IN** | Codex carries audio content items and nothing in the plan or the ledger has ever mentioned audio; the owner's ruling is to carry it faithfully and let the endpoint refuse. |
| `P3.128` | `allowedWritePaths` is entirely non-functional on Windows | **IN** | Every write grant misses under a Windows home, drive-letter grants included, on case alone. Fail-closed, so a usability defect rather than a hole — but it is what the agent may write. |
| `P3.129` | a real Windows build has never been exercised, and it hid two security defects | **IN** | The credential floor is unverified on a shipped platform, and that blind spot has already hidden two shipped security defects: a directory deny that never matched its directory and ten credential entries inert under a Windows home. |
| `P3.135` | `packages/shared/AGENTS.md` repeats the falsehood P3.112 just retired | **OUT** | One sentence in a shared AGENTS.md repeating a measured falsehood. |
| `P3.136` | the one-click image toggle is withheld on claude-runtime for the same dead reason | **IN** | Both gateway models declare `supportsImages: false` and the vision toggle is compat-provider-gated, so that declaration now has no UI writer at all — a user on a BYO vision-capable claude-runtime cannot turn images on by any route. |
| `P3.137` | the `pi_compat` image default is a two-file lockstep | **IN** | The `pi_compat` image default lives in two files that must move together; a one-file finish leaves a placeholder rather than a refusal, which is the silent-loss shape the ruling exists to prevent. |
| `P3.138` | the legibility pin covers one runtime of three | **IN** | The owner's carry-faithfully ruling holds only while the refusal stays legible, and that is now pinned on two runtimes of three. Pi is unmeasured. |
| `P3.139` | the classifier works, and enabling it is now an OWNER decision about latency and variance | **IN** | Whether the auto-mode classifier adjudicates borderline shell, network and MCP actions — what the agent may do — at a measured median 7.5 s and ~24.2k tokens per hop, with one measured verdict flip on identical input. |
| `P3.141` | stage-1 truncation under a realistic transcript is unmeasured, and it reads as a parse failure | **IN** | All 28 classifier parses ran against a two-line transcript that already consumed 59% of its input budget, and a truncation reads as a parse failure, which BLOCKS. The reliability figure behind the enable decision is measured in the easiest possible case. |
| `P3.142` | the classifier is a second opinion whose verdict is not recorded | **IN** | If the classifier is enabled, every action it ALLOWS runs with no record that it was reviewed while every denial is recordable — for a bank deployment that asymmetry is the interesting half. |
| `P3.147` | hand our floor to the native deny surfaces instead of re-implementing filtering | **IN** | Hand our 19-entry floor to the SDK's `permissions.deny` and codex's `permissions.filesystem` instead of re-implementing filtering. Native-first, steps 1 and 2, and it converts a three-runtime project into two configuration changes plus Pi. |
| `P3.149` | `LocalToolRuntime.grep` never checks that `rg` exists | **IN** | `LocalToolRuntime.grep` never checks that `rg` exists, so on a host without ripgrep a tool the model calls fails with no named diagnosis. |
| `P3.153` | the handoff context can truncate a path to a dead pointer | **IN** | The handoff context's 1200-character cap can leave a truncated path pointing at nothing and its 24-message window drops the pointer with its message. Latent, and on the switch path. |
| `P3.155` | `codex-protocol`'s generated bindings are typechecked by nothing AND imported by nothing | **OUT** | The generated codex bindings are imported by nothing, so no behaviour depends on them; the decision is wire-them-in or declare the package reference-only. |
| `P3.158` | `/help` is offered on all four runtimes and answered by no seam at all | **IN** | `/help` is offered on every runtime and answered by no seam, so it composes an ordinary turn and asks the model — which, on a fork of Claude Code, will describe a product that is not this one. |
| `P3.160` | the EOL notice is English prose inside a description field | **OUT** | An EOL notice as English prose inside a description field; i18n and a renderer badge. |
| `P3.161` | the `eol` shape is second-hand and nobody has confirmed its variants | **OUT** | Confirming the variant shapes of a model-catalogue metadata field. |
| `P3.169` | `bun test` structurally cannot see the `HOME` defect class | **OUT** | `bun test` cannot see the `HOME` defect class; instrument choice for a family that needs a Node-hosted check. |
| `P3.170` | a `cannot lock ref HEAD` turned a clean `git add` into another lane's commit | **OUT** | A failed commit leaves your work staged for whoever commits next; the isolated-index recipe. |
| `P3.171` | two readers are stubbed in the shipped binary, and one is a settings path | **IN** | Two readers are STUBS in the shipped bundle and one is a settings path — a setting we believe is honoured may be read by a stub, and it changes how every membership probe of that bundle must be read. |
| `P3.172` | a locale key can be reverted by a concurrent commit with BOTH i18n lints green | **OUT** | Both i18n lints stay green through a symmetric key loss; add a monotonic key-count assertion. |
| `P3.173` | `git commit` with no pathspec is the mirror hazard, and no check-then-commit closes it | **OUT** | Commit-under-concurrency procedure; no check-then-commit sequence closes the gap. |
| `P3.174` | the vendor documents a search-results exclusion its shipped binary does not perform | **IN** | Measured with the strongest control on the plan: the shipped 2.1.223 denies `Read` of a denied file and `Grep` one level above returns the line containing the secret. A vendor defect that governs three of our rows and must be re-measured on every SDK bump. |
| `P3.175` | codex's deny map is OS-enforced and takes far more than we send | **IN** | Codex's `permissions.filesystem` takes `~/` keys it expands itself, absolute keys and deny-only globs, and is OS-enforced rather than tool-mediated; we pass one path. It may close the results half the SDK fails to close. |
| `P3.178` | the page documents `classifierContext` and the vendored bundle does not have it | **OUT** | A page-ahead-of-bundle observation with no work today; keep it as a re-check trigger on the next corpus or SDK refresh, do not delete it. |
| `P3.179` | a fixture less specified than the product it stands for turns a deletion into a defect | **OUT** | A fixture less specified than the product it stands for manufactures false positives when a default is removed. |
| `P3.180` | a suite loses a lifecycle hook to a timeout only when sharing a process | **OUT** | A suite that loses a lifecycle hook to a timeout only under process sharing; known-failing register. |
| `P3.182` | codex persists every tool output to a rollout file, secrets included | **IN** | Codex writes every tool output to a rollout file, so a credential the floor stops a tool from READING is a different thing from one a tool has already read and codex has written to disk — and the second has no floor at all. |
| `P3.183` | the codex floor mirror is measured on darwin only, and the other two platforms are FATAL cases | **IN** | The codex floor mirror is measured on darwin only, and the source says a `**/`-anchored pattern is REFUSED on Windows — discarding the entire config, credential deny included — and fatal on Linux. |
| `P3.184` | an OS deny on `~/.ssh` also stops `ssh`, `git push` and the cloud CLIs in a codex shell | **IN** | Codex's OS-enforced deny on `~/.ssh` also stops `ssh`, `git push`, `aws`, `gcloud` and `kubectl` in a codex shell where the other two runtimes' tool-mediated deny leaves them working. Decided keep-and-make-legible; the legibility half is the work. |
| `P3.186` | `Options.settings` is single-valued and now has TWO contributors | **IN** | `Options.settings` is single-valued and now has two contributors; a second spread instead of a compose would have silently deleted the credential floor, and `managedSettings` has the identical shape with one contributor today. |
| `P3.187` | `useAutoModeDuringPlan` defaults to TRUE and nobody has measured what that means | **IN** | `useAutoModeDuringPlan` defaults to TRUE, so plan mode may already carry auto-mode semantics — and this plan has owner rulings about what reaches the classifier in plan mode that were decided against a possibly incomplete picture. |
| `P3.188` | one unresolved read and one unidentified field, both recorded rather than explained away | **OUT** | Two recorded nulls in the bundle's autoMode shape; no work owed today, kept so the next reader does not guess. |
| `P3.189` | a required option added at the baseline commit is read nowhere | **OUT** | A required option read in no code path; wire-it-or-delete-it. |
| `P3.190` | a directory outside every `include` is invisible to an exclude audit | **OUT** | A directory in no tsconfig `include` is invisible to an exclude audit. |
| `P3.191` | P3.181's end-to-end arm is owed and `bun test` cannot pay it | **IN** | The end-to-end claim that a reassigned `HOME` no longer splits the credential source from every other reader cannot be asserted under `bun test` at all; one rig with P3.129, and the same credential floor. |
| `P3.192` | eight more shell variables are copied and read by nobody | **OUT** | Eight copied shell variables with zero readers; a recorded null. |
| `P3.193` | the DEFAULT merge policy still ignores `defer` | **IN** | The documented precedence `deny > defer > ask > allow` was fixed on the STRICT policy while `legacy` is the DEFAULT, so it holds where most sessions are not. |
| `P3.194` | two near-duplicate merge functions have now drifted TWICE | **IN** | Two decision-merge implementations, and the native one has been right both times the SDK one was wrong. Collapsing them is goal 2 with a working reference sitting beside it. |
| `P3.195` | a command hook's PreToolUse deny still ends the turn | **IN** | `continue: false` outranks `permissionDecision`, so a command hook's PreToolUse deny still ends the turn where the page implies it should not. What happens to the loop after a denial. |
| `P3.196` | a fourth `permissionDecision` union, three-valued, with zero readers | **IN** | A fourth, three-valued `permissionDecision` union read by nothing, in a plugin-facing file — the natural thing for a plugin author to code against, and nothing honours it. |
| `P3.197` | the SDK PreToolUse arm is built per session and thrown away | **IN** | The SDK PreToolUse arm is constructed every session and dropped by the merge that consumes it, with the two facts two files apart, so neither site reads as dead. A permission arm that looks live and is inert. |
| `P3.198` | an excluded test file can be FAILING and silent | **OUT** | An excluded test file can be failing and silent; the argument for clearing the remaining exclusions. |
| `P3.199` | `pi-auto-compaction-thrashing.test.ts` is load-sensitive on its own internal budget | **OUT** | A load-sensitive internal scenario budget; known-failing register. |
| `P3.200` | five errors sit in a shared MCP file mid-refactor, reached only through excluded tests | **OUT** | Five typecheck errors in a file another lane holds; re-measure when it lands. |
| `P3.201` | `model_catalog_json` is codex's native custom-model surface and we never asked it | **IN** | `model_catalog_json` is codex's OWN mechanism for describing a model it does not ship — context window, reasoning levels, service tiers, shell type — and we describe our default model with two scalars. Native-first step 1 was never asked. |
| `P3.202` | codex's on-demand image read-back is unproven and now has a named suspect | **IN** | `view_image` is declared and live on codex and has never been run end to end; the named suspect is that the attachments store sits outside the profile's filesystem scope, so a refusal would read as the model declining. |
| `P3.203` | `modelProvider/capabilities/read` is a second unread native self-report, and it already disagrees with our config | **IN** | Codex publishes `{namespaceTools, imageGeneration, webSearch}` and we read none of it — and it reports `webSearch: true` while we write `web_search = "disabled"`, so either the report is a ceiling or one of the two is wrong about what the turn can do. |
| `P3.204` | the genuine reviewer gap is a context-isolated agent plus a host-computed diff, and it is NOT isolation | **IN** | A bundled read-only reviewer agent, a host-computed diff tool and a SKILL.md branch on claude-runtime — an agentic capability, and the row records why the obvious worktree-isolated build is the wrong one. |
| `P3.205` | `SdkAgentDefinition.isolation` goes inert silently if the binary drops the field | **IN** | `SdkAgentDefinition.isolation` degrades to no isolation at all, silently, if the binary drops the field, and only prose says so. One schema tripwire. |
| `P3.206` | the headless server never seeds bundled skills at all | **IN** | A headless `nessy-server` deployment ships zero bundled skills, on every runtime — not a stale copy, none. Skills are what the agent can do. |
| `P3.207` | the electron dist bundle still carries the pre-fix seeder, so the live pass needs a packaged build | **OUT** | A packaged-build prerequisite for live skill evidence. |
| `P3.208` | `skillTier` can now be exact, and two stale comments were left deliberately | **OUT** | An approximation that can become exact plus two stale comments left to avoid a cross-lane pathspec collision. |
| `P3.209` | the managed tree's line-anchor residue, sized | **OUT** | 106 remaining line-anchor citations in the managed tree; a re-verification pass, since five of the converted ones were false rather than stale. |
| `P3.210` | `OTEL_EXPORTER_OTLP_ENDPOINT` sits in our safe allowlist while the page says it always requires the dialog | **IN** | An endpoint variable is an egress control, it sits in our known-safe allowlist so it applies without the approval dialog, and the page says it always requires one. Our side is the looser one. |
| `P3.211` | `allowedTools` and `toolRules` are undocumented in the same three schemas | **IN** | `allowedTools` is fail-CLOSED and absent from three published schema blocks; an allowlist documented wrong denies work silently. |
| `P3.212` | `apps/electron/resources/docs/permissions.md` has no zone owner | **OUT** | Zone ownership for a user-facing permissions doc. |
| `P4.4` | thinking renders | **OUT** | Reasoning-block rendering is absent uniformly on every runtime, so it is a host display feature rather than a switch difference. |
| `P4.5` | advisor UI | **OUT** | The advisor mechanism is host-side and already built; this row is its renderer card, settings picker and playground states. |
| `P4.6` | lens update | **IN** | The runtime-switch cost lens is the artifact that tells a user what a switch costs — goal 1's honesty half — and it currently over-warns on a stale ground and carries three stale tool counts. |
| `P4.8` | settings show real default mode | **IN** | Workspace Settings seeds a hardcoded `default` while sessions now start in Auto, so the displayed permission mode claims LESS autonomy than reality. A permission-mode control showing the wrong value. |
| `P4.9` | elapsed visible on ordinary rows | **OUT** | Painting an existing elapsed field on ordinary running tool rows. |
| `P5.3` | registers regen | **OUT** | Regenerating two generated registers; note the measured contamination hazard — the generator reads the plans directory as a glob, so three untracked files must be resolved first. |
| `P5.4` | close-out | **OUT** | Plan close-out mechanics: version lockstep, release notes, docs-site, CDP checklist, final regression. Required to ship whatever the cut keeps; must be re-scoped to the reduced set. |
| `P6.1` | the middle tier of the permission DSL is never emitted to codex, and a codex refusal names no rule | **IN** | The middle tier of the permission DSL is never emitted to codex and a codex refusal names no rule — an ask/prompt rule silently disappears instead of pausing the runtime. |
| `P6.2` | a managed `false` silently overrides a user's stricter `true` on six security-sensitive keys | **IN** | A managed `false` silently overrides a user's stricter `true` on six security-sensitive keys; managed precedence deciding what the agent may do, against the documented exception. |
| `P6.3` | `--restricted` shipped upstream and collides with the three `settingSources` this fork passes | **IN** | `--restricted` shipped upstream — no command/code tools, file tools confined to cwd, `bypassPermissions` refused — and collides with the three `settingSources` this fork passes. |
| `P6.4` | seven permission-mode descriptions are runtime-independent strings and three are false on codex | **IN** | Seven permission-mode descriptions are runtime-independent strings and three are false on codex; the user cannot trust the description of the mode they are in. |
| `P6.5` | the vetted-plugin hook carve-out is Pi-only, on a premise P2.314 refuted | **IN** | An organisation's plugin allow/deny policy and its vetted-hook carve-out are enforced on Pi only, on a premise P2.314 refuted. Plugins deliver hooks, skills, agents and MCP. |
| `P6.6` | twenty-one of codex's twenty-two managed requirements are read, reported and discarded | **IN** | Twenty-one of codex's twenty-two managed requirements are read, reported and discarded — an organisation's requirements are not enforced on that runtime. |
| `P6.7` | a codex requirement we read and do not honour is reported only to a debug sink | **IN** | A codex requirement we read and do not honour is reported only to a debug sink, so a silent degradation of the user's setting is invisible. |
| `P6.8` | codex reports a fourth skill scope, `admin`, that we have no origin to represent | **IN** | Codex reports a fourth skill scope, `admin`, that we have no origin to represent — skills from an administrator-owned location are what the agent can do. |
| `P6.9` | shell, hook and stdio-MCP launches have no corporate-launcher seam, in the deployment the page is written for | **DEFERRED-LAST** | OWNER RULING, in the owner's words: <<этого не будет, я бы не стал сейчас это делать>> and <<я бы сместил это аж в самую последнюю очередь>>. The MEASUREMENT STANDS — three live unwrapped spawn sites, absent on all three runtimes, switch verdict UNIFORM — and by criterion 1 every Bash tool call does pass through such a wrapper. What was ruled on is PRIORITY: the launcher changes how an organisation OBSERVES and constrains the agent rather than what the agent can do, and the four goals are about the agent loop. Not refuted, not done, not to be started. |
| `P6.10` | the carry planner degrades every `claude-*` target to text, and the T2 its comment defers to has already closed | **IN** | The carry planner degrades every `claude-*` target to a 24x1200 text tail, and the row its comment defers to has already closed. Goal 1, on the largest switch surface. |
| `P6.11` | codex fires four hook events of twelve and discards the Stop result | **IN** | Codex fires four hook events of twelve and discards the Stop result — hooks intercept every tool call and the roster differs by runtime. |
| `P6.12` | four of the five hook handler kinds are wired for Pi alone | **IN** | Four of the five documented hook handler kinds — http, prompt, agent, mcp_tool — are wired for Pi alone. |
| `P6.13` | the codex import registers a PostToolUse hook that can never fire, and records no deferral | **IN** | The codex import registers a PostToolUse hook that can never fire and records no deferral, so a security plugin reports itself installed and enabled while its per-edit check never runs. |
| `P6.14` | we write no `[hooks]` table, so codex's own hook vocabulary is unreachable | **IN** | We write no `[hooks]` table, so codex's own hook vocabulary is unreachable. Native-first step 1, unasked. |
| `P6.15` | the advisor never checks it is as capable as the model it advises | **IN** | The advisor never checks it is at least as capable as the model it advises; a second opinion from a weaker model is worse than none. |
| `P6.16` | the host's RAM-derived subagent ceiling never reaches a claude session | **IN** | The host's RAM-derived ceiling on concurrent subagents never reaches a claude session — subagent dispatch bounded on one runtime and not another. |
| `P6.17` | a subagent whose every declared tool fails to resolve launches anyway | **IN** | A subagent whose every declared tool fails to resolve launches anyway, so a useless agent burns a turn instead of being refused at spawn. |
| `P6.18` | `isolation: worktree` is forwarded unobserved on claude and absent on codex | **IN** | `isolation: worktree` is forwarded unobserved on claude and absent on codex; subagent isolation differing by runtime. |
| `P6.19` | a Pi subagent holding the messaging tool is given no roster | **IN** | A Pi subagent holding the messaging tool is given no roster, so it cannot know which agents exist before sending. |
| `P6.20` | a worktree can only be entered mid-session, so no session ever starts isolated | **IN** | A worktree can only be entered mid-session, so no session ever starts isolated and the user cannot choose where a chat runs. |
| `P6.21` | a scheduled task's per-run worktree is swept on the Pi child path and leaked on the other two | **IN** | A scheduled task's per-run worktree is swept on the Pi child path and leaked on the other two. |
| `P6.22` | a worktree the sweep keeps because it holds work is announced only to the log, and no exit offers keep-or-remove | **IN** | A worktree kept because it holds work is announced only to the log, and no exit offers keep-or-remove — the agent's work can be deleted without a snapshot. |
| `P6.23` | deferred tool loading is Pi's alone, and a BYO claude connection turns the SDK's own on where we can neither see it nor render it | **IN** | Deferred tool loading is Pi's alone, and a BYO claude connection turns the SDK's own on where we can neither see it nor render it. Which tool definitions reach the model's context. |
| `P6.24` | an MCP result that mixes text with a resource loses the resource, silently | **IN** | An MCP result mixing text with a resource loses the resource, silently, on all three runtimes. What a tool call passes through. |
| `P6.25` | MCP resources and prompts never reach a claude-runtime session, and nothing says so | **IN** | MCP resources and prompts never reach a claude-runtime session and nothing says so. |
| `P6.26` | a running MCP tool call has no operator ceiling on Pi, and the documented name is left unoccupied | **IN** | A running MCP tool call has no operator ceiling on Pi, and the documented setting name is left unoccupied. |
| `P6.27` | the built-in browser is unreachable from a codex session by omission from a list, not by architecture | **IN** | The built-in browser is unreachable from a codex session by omission from a list, not by architecture — a tool the model can drive on two runtimes and not the third. |
| `P6.29` | nobody has measured whether WebSearch executes on the claude runtime through our gateway | **IN** | Nobody has measured whether `web_search` executes on the claude runtime through our gateway; a tool that may not run at all. |
| `P6.30` | the documented thinking env vars reach the claude subprocess and are read by nothing on Pi | **IN** | The documented thinking env vars reach the claude subprocess and are read by nothing on Pi — reasoning effort set from the environment works on one runtime. |
| `P6.31` | two of the six thinking levels are silently downgraded to `high` on every codex turn | **IN** | Two of the six thinking levels are silently downgraded to `high` on every codex turn: the user selects Extra High or Max and the runtime never receives it. |
| `P6.32` | nobody can ask which settings file a value came from, and claude loads a second stack no surface reports | **IN** | Nobody can ask which settings file a value came from, and claude loads a SECOND settings stack that no surface reports. |
| `P6.33` | auto-memory off stops our prompt block and not the SDK's own memory directory | **IN** | Auto-memory off stops our prompt block and not the SDK's own memory directory, so the control silently stops controlling and memory keeps loading into the model's context. |
| `P6.34` | the runtime subprocess never receives `--add-dir`, so an added directory contributes no skills, commands or subagents | **IN** | The runtime subprocess never receives `--add-dir`, so an added directory contributes no skills, commands or subagents. |
| `P6.35` | `AGENTS.override.md` steers codex and is invisible to our own instruction collector | **IN** | `AGENTS.override.md` steers codex natively and is invisible to our own instruction collector, so the user cannot see what is steering the agent. |
| `P6.36` | codex receives no output style at all, and the widening is one line on a seam already wired | **IN** | Codex receives no output style at all; the output style rewrites the system prompt, which is what the model is told. |
| `P6.37` | our `Concise` output style drops all three of the page's qualifiers, including the safety carve-out | **IN** | Our `Concise` style drops all three of the page's qualifiers INCLUDING the safety carve-out, so a terse style can suppress error reports, security warnings and destructive-action confirmations. |
| `P6.38` | one host skill marker serves three runtimes and the decision is recorded nowhere, so a pasted `$plugin:skill` resolves to nothing | **IN** | One host skill marker serves three runtimes and a pasted `$plugin:skill` resolves to nothing; skill invocation is how a skill's instructions and tool grants enter the turn. |
| `P6.39` | a marketplace entry carries no credential, so a plugin on a corporate artifact server 401s | **IN** | A marketplace entry carries no credential, so a plugin on a corporate artifact server 401s — the delivery vehicle for hooks, skills, agents and MCP, in exactly the deployment this fork is for. |
| `P6.40` | a `#ref` pin is dropped, and a `.git` URL on any host but github/*gitlab* is read as a bare marketplace.json | **IN** | A `#ref` pin is dropped and a `.git` URL on any host but GitHub or GitLab is read as a bare marketplace.json — self-hosted git is the corporate case. |
| `P6.41` | the reserved marketplace names are checked at neither add nor load, and the skip is recorded only in one docblock | **IN** | Reserved marketplace names are checked at neither add nor load, so a third-party catalog can present itself as the official Anthropic marketplace. Supply-chain trust for what the agent loads. |
| `P6.42` | the audit-event stream is gated on Pi while its metrics sibling is deliberately not | **IN** | The audit-event stream — tool_decision, tool_result, user_prompt — is gated on Pi while its metrics sibling is not. Those events ARE the permission-verdict record, and an unauditable influence on permission outcomes is worse than an absent one. |
| `P6.43` | the gateway correlation and operator custom headers never reach a claude request | **IN** | Gateway correlation and operator-supplied custom headers never reach a claude request; headers are what every request to our endpoint passes through. |
| `P6.44` | `/heapdump` snapshots the host and never the process holding a claude conversation | **OUT** | `/heapdump` snapshots the host process; a diagnostic command. |
| `P6.45` | two sessions messaging each other have no cap, no dedup and no clock, so A→B→A never stops | **IN** | Two sessions messaging each other have no cap, no dedup and no clock, so A->B->A never stops. An unbounded agent loop. |
| `P6.46` | a session cannot refuse or hold an inbound message from another session | **IN** | A session cannot refuse or hold an inbound message from another session; an ungated inbound path into a running turn is a named injection vector. |
| `P6.47` | an author's `SendMessage`/`ListAgents` denial resolves to nothing and silently stops denying | **IN** | An author's `SendMessage`/`ListAgents` denial resolves to nothing and silently stops denying. |
| `P6.48` | the assistant's streaming reply is announced to no screen reader | **OUT** | Screen-reader announcement of the streaming reply; accessibility, named out by the boundary. |
| `P6.49` | the hotkey override map is declared, read, re-exported and never written | **OUT** | Keybinding override map; named out by the boundary. |
| `P6.50` | one notification boolean stands where the contract has three positions, and permission alerts have no control | **OUT** | Notification timing positions and permission-alert notification control; the alert's timing, not the permission. |
| `P6.51` | the queue strip ships three of the page's four verbs and reorder is a comment | **OUT** | Queue-strip verbs and message reorder in the composer. |
| `P6.52` | PushNotification stays pi-only on the premise T1 and P2.2 already falsified | **IN** | `PushNotification` is a MODEL-CALLABLE tool held pi-only on a premise two closed rows already falsified; the category is notifications, the subject is which tools the model has on which runtime. |
| `P6.53` | the auto-compaction off-switch is gated to Pi, and the claude path turns the SDK's own compaction back on | **IN** | The auto-compaction off-switch is gated to Pi and the claude path turns the SDK's own compaction back on — a control that silently stops controlling, on context. |
| `P6.54` | compaction cannot be steered on Pi: nothing reads a `Compact Instructions` section, and Pi's auto path hardcodes `customInstructions: undefined` | **IN** | Compaction cannot be steered on Pi: nothing reads a Compact Instructions section and the auto path hardcodes `customInstructions: undefined`. What survives compaction is what the model still knows. |
| `P6.55` | the compaction-thrashing guard has exactly one producer, so a context that refills after every compaction loops the turn on codex | **IN** | The compaction-thrashing guard has exactly one producer, so a context that refills after every compaction loops the turn on codex. |
| `P6.56` | four of the rewind menu's six documented actions exist on no runtime | **IN** | Four of the rewind menu's six documented actions exist on no runtime; rewind is session history, which is the switch payload. |
| `P6.57` | no command surfaces the session's running work — `/tasks`, `/workflows` and `/plugin` are absent from a curated seventeen | **IN** | No command surfaces the session's running work — you cannot operate an agentic system you cannot observe, attach to or stop, which is goal 3 directly, and it is worst on Pi, the only runtime that runs dynamic workflows. |
| `P6.58` | a stalled model stream hangs the session — none of the three SSE relays we own carries an idle abort | **IN** | A stalled model stream hangs the session: none of the three SSE relays we own carries an idle abort. |
| `P6.59` | a skill's own frontmatter hooks never dispatch on claude, deferred to an SDK that never loads the skill | **IN** | A skill's or subagent's own frontmatter hooks never dispatch on claude, deferred to an SDK that never loads the skill. |
| `P6.60` | one setup-script string is handed to `cmd.exe` and `/bin/sh` alike, so a cross-platform user can declare only one of the two | **IN** | One setup-script string is handed to `cmd.exe` and `/bin/sh` alike, so a cross-platform user can declare only one of the two — worktree setup runs before the agent works in that tree. |
## Appendix — the seven `⏸` rows, not counted above

The brief scoped this pass to `⬜`/`🟨`. These seven are open but pinned on an owner answer, so the
queue skips them. They are listed with an **indicative** verdict only, so that nobody reads the
280-row table as the whole open set. They are **not** in the counts.

| Row | Title | Indicative | Note |
| :-- | :-- | :-- | :-- |
| `P2.306` | our only codex deny is written through the key the docs say loses | IN | The plan calls it the severest thing it has found: on codex the `credentials.enc` deny is expressed through `sandbox_mode`, and the page says the two do not compose and `sandbox_mode` wins. A security control failing exactly where it is meant to work. |
| `P2.341` | a documented `ultracode` exemption is quoted twice and implemented nowhere | IN | A user running `ultracode` is silently capped at the ordinary subagent concurrency limit; the exemption exists in the vendor's page and our prose and in no enforcement site. |
| `P4.1` | scheduled-tasks list | OUT (renderer) | `⏸` by the Phase-4 process decision: drawn in the playground last, after the phase-2/3 rows it renders close. |
| `P4.2` | goal status | OUT (renderer) | Same process decision. |
| `P4.3` | watches in panel | IN (borderline) | Same process decision — but "watches in panel" is the observe-and-stop surface `P6.57` is IN for. Decide the two together. |
| `P4.7` | Pi inspector | OUT (renderer) | Same process decision. |
| `P4.10` | settings stop rendering unenforceable `blockedTools` | IN | The permissions page renders ~15 tool names as BLOCKED that the runtime never honours — a settings page asserting the opposite of the behaviour, with no diagnostic. A control that claims to control. |

## What contradicts the four goals, as stated

Recorded because the brief asked for it, and because each one is a question only the owner can settle.

1. **The product has four agent backends; the goals name three.** `P3.158`'s own text reads
   *"`/help` is offered on all four runtimes"*, and `P2.335` is a `[remote]` row about `NestorCloudAgent`
   having no documentation corpus of its own to be graded against. Goal 1 says *switching between pi,
   claude, codex*. Either the nestor-cloud remote agent is a fourth runtime that goal 1 covers — in
   which case it is the one runtime with no corpus, and "covered" for it has to be **defined by us** —
   or it is a separate product line, in which case its rows leave this plan. `P2.335` is filed
   `UNCLEAR` on exactly this.

2. **"The host must be as thin as possible" and "Pi is built strictly to Claude's documentation" pull
   in opposite directions, and the plan has already paid for it.** Pi has no contract of its own, so
   every Claude behaviour Pi must reproduce is host code — `P2.367` is the clean example: an operator
   sets `BASH_MAX_OUTPUT_LENGTH`, the Claude subprocess honours it, and Pi honours nothing, because on
   Pi *we* are the implementation. Goal 4 makes the host thicker every time it is satisfied. The
   native-first ordering resolves this for claude and codex and cannot resolve it for Pi; that is
   worth stating rather than discovering per row.

3. **Goal 2 and the OQ-6 ruling are in tension on permissions, and the owner has already chosen —
   against goal 2.** OQ-6 was resolved 2026-08-23 by keeping our host-side gate authoritative on all
   three paths, explicitly on maintenance cost, and the claude path now layers our gate over an
   **active** SDK permission system. That is deliberate duplication, and it is the right call for the
   stated reason — but a reader applying "thinnest possible host" to the permission rows would
   reach the opposite conclusion. `P3.194` (two decision-merge implementations, the native one right
   both times the SDK one was wrong) is where the two rules meet head-on.

4. **The exclusion "we do not need their authorization commands" is not the same as "authorization is
   out of scope."** Two rows sit in the gap: `P3.90` (our own gateway returns 500, not 401, on a
   wrong credential type, and a 500 is retried where a 401 is not) and `P2.357` (34 silent no-op
   setters are harmless only because the reset/logout path that would arm them is dead code). Both
   are filed OUT on the exclusion as written; both would be IN if "our own `dp` path against our own
   endpoint" counts as agent-loop infrastructure.

5. **One IN row rests on a premise another lane reports refuted.** `P3.75` (a `Read` deny must bind
   Edit and Write) is classified IN on its subject — permission-rule binding across tools, with the
   fix site in `evaluatePermissionDslV1` so codex inherits it — but lane z1 reports the row refuted
   via the systematic bias in identifier-search absence claims. Re-measure before dispatch. More
   generally: **57 ledger cells assert absence on that kind of evidence, and the class is biased
   toward false `absent`**, so no gap in this document should be read as established until its own
   evidence is checked.
