# Claude doc-sweep parity wave (R31–R76, grown to R31–R89)

> **CLOSED 2026-08-08 at `1535e0839`, released as 1.21.0.** 55 units closed,
> 4 deferred by owner decision, 2 filed follow-ups (`R87b`, `R88b`). The plan is
> KEPT, not deleted — it is where each deviation's reason lives, and
> `scripts/regenerate-deviation-register.py` harvests it.
>
> The wave grew from 51 rows to 59 because it found its own work: `R82`/`R83`
> (the plugin update badge and its discoverability), `R84`/`R85` (two findings
> `R64` refused to ship without their consumers), `R86` (a background subagent's
> result never reaching the model), `R87`/`R87b` (component-scoped hooks),
> `R88`/`R88b` (the Update button was a no-op), `R89` (a bypassable injection
> guard). The last three came from the **adversarial post-completion audit**
> (see that section below): ten skeptics told to refute the closed rows, which
> found a real shipped defect every green test had missed.
>
> Evidence at close: `bun test` 12 528 pass / 0 fail; `typecheck:all` + `apps/cli`
> clean; lint 0 errors; all branch pipelines green; CDP re-run on rebuilt 1.21.0
> bundles (`docs/testing/cdp-live-checklist.md`, 2026-08-08 third pass) with its
> uncovered edges stated rather than glossed. Generated parity report:
> **140 of 152 rows built, 12 open** — it read 87 of 136 with 49 open before this
> branch's close-out, because the audit had never been told what the wave built.

Executes the surviving findings of the full 174-page Claude Code doc sweep.
Specs per finding (file, symbol, change, blast radius):
`docs/superpowers/specs/2026-08-02-claude-doc-sweep-worklist.md` — this plan
does not restate them; a unit's spec is the union of its findings' entries there.
Queue rows: parity audit §A R31–R76; method and counts: audit §5f.

**Scope (owner decision 2026-08-04).** 43 of 46 units. Deferred as UI periphery /
managed-admin tier: `keybindings-config` (f184), `statusline-surfaces` (f205 f206),
`managed-policy-sources` (f027 f109 f108). Their §A rows are ⏸ with this plan named.

**Pre-decisions.**
1. `deep-link-safety` (R43) executes FIRST — an OS-delivered `nessy://` URL reaches
   the internal command bus with no origin check (`deep-link.ts`); that is a security
   fix wearing a parity label, not queue position #13.
2. **f224 (`MessageDisplay`) lands under R32. Owner decision 2026-08-04, option (a).**
   §A row R9 routed "MessageDisplay→R30"; R30 was then split into three sub-units
   (skill frontmatter, `/doctor`, subagent frontmatter) and none carried the event,
   so it fell out of the queue. R30 stays ✅ — its three sub-units are genuinely
   done with recorded evidence. **What was false was R9's routing, not R30's
   closure**, so the correction belongs in a note rather than in a reopened row.
   The full-read sweep is what found it again; a split that drops a routed item is
   invisible from either side of the split.

**Order.** R31 `managed-settings-key-vocabulary` leads the settings half: six units
add keys through the same strict gateway (`refuseUnknownKeys` managed-policy.ts:727-733;
`StoredConfigTopLevelSchema` validators.ts:208 fails the whole file closed), and the
alias-vs-new-key / strict-vs-soft decision must be made once. R32 leads the hooks half:
it widens `AGENT_EVENT_CONTRACTS_V1`, which is versioned and mirrored into the prebuilt
Pi bundle — host and subprocess ship from one build, so a config naming a new event
must not reach an old bundle. Hooks units run SEQUENTIALLY (they share
`automations/types.ts` and `lifecycle-bridge.ts`; `git commit <pathspec>` takes
working-tree state — zone by file). `memory-load-limits` precedes the other memory
units: until the caps sit on the live route, recognition/feedback changes are
unmeasurable. `headless-init-frame` precedes `headless-cli-flags-and-exit`;
`hook-firing-and-await` runs after headless because it needs the launch modes that
unit introduces.

**Rules.**
- One unit = one commit: `<type>(parity): <unit slug> [R<n>]`; the tracker row is
  flipped in that SAME commit. The Commit column carries the subject rather than
  the sha — a sha cannot be written into the commit that produces it, and a
  follow-up commit per unit just to paste one is noise. `git log --oneline
  --grep '<unit slug>'` resolves it.
- Gates per the Implementation-First Verification Budget: focused tests for changed
  behaviour + affected-package typecheck. `bun run typecheck:all` does NOT cover
  `apps/cli` — units touching it (headless, deep-link) run it separately.
- ⚡ units cross a persistence or wire boundary — run the smallest expanded boundary
  set once on the unit's final diff.
- Effort is ordinal, not an estimate (§5f: 61 L / 56 M / 2 S — the classifiers do
  not distinguish small work). Re-size by hand as units are planned.

## R31 · managed-settings-key-vocabulary · decision (verified 2026-08-04)

**The premise this unit was queued on was wrong, and the check said so.** It was queued
as "soften our strict parse to match Claude Code's tolerance". That tolerance is
**managed-tier only**. Verbatim, `settings.md`:

> "This tolerance applies only to managed settings. User, project, and local settings
> files remain strict: a file that fails validation is rejected as a whole and reported."

> "Managed settings parse tolerantly. When a managed configuration contains an entry
> that fails schema validation, Claude Code strips that entry, records a warning, and
> enforces every remaining valid policy. A single typo cannot disable the rest of your
> organization's policy."

So on parse POSTURE we already match upstream: strict user tier, tolerant managed tier
(`refuseUnknownKeys`, managed-policy.ts:727). The real divergence is narrower — the
documented KEYS are absent from `StoredConfigKnownFields`, and a strict schema rejects
what it does not declare. Neither page states any rule for an unknown key; the one
documented case (`mcpServers` in `settings.json`) is described as silently "never
appear" — ignored, not rejected.

**Decision: do NOT soften `.strict()`. Declare the keys instead.** That fixes every
user-visible symptom in this gate's dependents without touching the parse posture. The
five items below are what a blanket softening would have cost, each verified against
this code — they are the reasons, not a wishlist:

1. **`env` at user scope is carved OUT.** `~/.nessy-agent/config.json` has no write
   containment against the agent's own Bash tool (`protected-paths.ts` says so in its own
   "Known limits" block). A user-scope `env` block is therefore unprompted code execution
   in the HOST process, plantable by one shell redirect from a prompt-injected turn and
   persistent across restarts. **f163 keeps only its managed half; the user-scope half is
   parked pending an owner threat-model decision.**
2. **A strip must never mutate the persisted object.** `loadStoredConfig`
   (storage.ts:793-865) returns the object every setter mutates and `saveConfig`
   serializes it verbatim — 38 writers. The zod-natural softening (drop `.strict()`,
   return the parse result) would make an unknown key **permanently deleted** on the next
   unrelated write, with the warning gone by then.
3. **Aliases must not resolve by spelling.** "Canonical wins, alias shadowed" is
   backwards for restrict-direction keys: `{"deniedReadRoots":[…secrets],"denyRead":[…]}`
   drops the secrets deny with only a warn-log. And an ADDED canonical key would outrank
   an EXISTING one — appending `cleanupPeriodDays: 1` beside a user's `retentionDays: 30`
   deletes session history down to a 1-day floor. **Rule: aliases are read-only, and on
   conflict the more restrictive value wins for restrict-direction keys.**
4. **Do not import the managed tier's fail-closed poles into a tier with no admin.** A
   typo'd `allowManagedDomainsOnly` read as `true` denies all sandboxed egress — an outage
   the user cannot diagnose and will "fix" in the loosening direction.
5. **Never normalize spellings in `.claude/settings.json`.** That file is co-owned with
   real Claude Code under an additive-only merge-preserve boundary
   (`claude-settings-store.ts:119-166` header). Writers emit canonical only in fork-owned
   files.

Rejected/stripped keys must keep reaching the existing diagnosis surface
(`collectRejectedUserSettingsLayers` storage.ts:1263, `config-doctor.ts:79`) — that is
our analogue of the documented `/doctor` + `/status` reporting, and it is the
compensating control for anything this unit relaxes.

### R31 execution — three dispatches, STRICTLY SEQUENTIAL

All five findings touch `managed-policy.ts`, and two also touch `storage.ts` /
`SessionManager.ts`. `git commit <pathspec>` takes working-tree state, so
overlapping agents cross. One at a time, verified between each.

**Verified 2026-08-04 before dispatch:** `StoredConfigTopLevelSchema.safeParse`
failure THROWS `UnsupportedStorageLayoutError` (`storage.ts:856-862`), so a single
documented-but-undeclared key costs the user **every** setting in `config.json`,
not just that key. That is the user-visible severity this unit removes.

- **A · f017 + f110 — `strictPluginOnlyCustomization`.** One key, two pages
  (`permissions.md:507` + `admin-setup.md:91`). Managed tier only. Value is `true`
  or a subset array of exactly `skills`, `agents`, `hooks`, `mcp`. Files:
  `managed-policy.ts`, `storage-runtime.ts`, `SessionManager.ts`.
- **B · f185 + f163a — declare the keys so a file stops failing closed.**
  `claudeMdExcludes` at all four scopes with array merge; `env` DECLARED so the
  file parses. Files: `validators.ts`, `storage.ts`, `instruction-excludes.ts`,
  `native-sources.ts`, `base-agent.ts`.
- **C · f121 — `$defaults` needs an operand.** The sentinel, splice position and
  replace-on-absence are already correct in `resolveAutoModeList`; what is missing
  are built-in `environment`/`hard_deny`/`soft_deny`/`allow` lists to splice.
  Files: `guardian.ts`. **Note for the record:** this finding's content is
  auto-mode rule data, not key vocabulary — the slicer put it here. Kept rather
  than renumbered, because moving it would renumber a queue the audit already
  references.

**Dispatch A landed. Four things from it are decisions, not notes.**

1. **Citations in f017/f110 had MOVED — the page grew.** The `skills` row is
   `settings.md:1185` (not `:1187`, which is now `hooks`; `:1188` is `mcp`), and the
   ignore-unknown rule is `:1190` (not `:1191`). Verified independently by the
   orchestrator. The sentence, not the number, is the identifier.
2. **`:1190`'s second half decided a design question.** Verbatim: "Surface names
   that a Claude Code version doesn't recognize are ignored rather than failing the
   settings file, **so you can add new surface names before all clients have
   updated**." So an unrecognised surface NAME records no drop (a drop would make
   `doctor` flag a policy that is documented-correct and merely newer), while a
   malformed ENTRY — a non-string — is stripped with a warning under the managed
   tier's general rule. Two defect classes, two behaviours.
3. **`hooks` was already enforced under a different key.** `allowManagedHooksOnly`
   → `managedHookLock` → `runtime-automations.ts:144`. The documented key was wired
   to that EXISTING gate with one `||` rather than a second gate. `mcp`, `skills`
   and `agents` were genuinely unenforced as origin locks and are newly wired in the
   discovered-record filter. This is the "already handled upstream" trap caught in
   the act: filing all four as absent would have been wrong for one of them.
4. **f110's `loadAllSkills` leak claim is REFUTED, and the spec is wrong here.**
   `broadcastSkillsChanged` ignores its `skills` argument except for a log count and
   emits `capabilities.CHANGED` with `generation: ''`, so the renderer refetches
   through the filtered snapshot. And `SendMessageOptions.skillSlugs` has no reader:
   `grep -arn skillSlugs` over `packages`/`apps` finds producers only — orchestrator
   confirmed. Gating those sites would change nothing observable, so it was not done.

**Deliberately NOT done in A, worth its own follow-up:** a locked skill or agent
now vanishes from the list with no explanation, because `BlockedCapabilityLayer`
(`capabilities/types.ts:215-221`) was not widened — a shared type with renderer
readers, and a UX addition rather than part of the lock.

**Dispatch C landed, with three orchestrator rulings.**

1. **KEEP the two new `environment` default entries.** C flagged them as new
   content rather than a moved representation, correctly. Ruling: keep, because
   they are the PAGE's own documented defaults, verified verbatim —
   `auto-mode-config.md:98` "The repo and source-control entries default to the
   working repository and its configured remotes. Every other trust slot defaults
   to `None configured`, so nothing else is trusted until you add it." and `:99`
   "Each defaults to a broad heuristic, such as treating any host or namespace
   whose name carries `prod` or `production` as a sensitive remote target". They
   are also narrower than the host-wide trust a model infers from prose alone. An
   empty `environment` default would leave `$defaults` with no operand in the one
   section `:103` is specifically about — f121 half-fixed.
2. **The section header change is right.** `## Organization policy (trusted — from
   host-owned managed settings)` became `## Policy rules (trusted — built-in
   defaults, extended or replaced by host-owned managed settings)`. Keeping the old
   string would have told the judge that managed settings authored rules we ship —
   a false provenance claim inside the one section whose whole purpose is the
   trusted/untrusted split.
3. **The cap stays a cap.** The spec wanted `GUARDIAN_INPUT_CAPS.orgPolicy` raised
   to cover the defaults plus a 64×512 admin worst case. A cap sized to its worst
   case (131k chars) is not a cap. The admin budget stays 6000 and the built-in
   body is counted separately, so shipping rules as data cannot start truncating
   admin prose that fits today.

**Two more spec citations were truncated or misattributed** — the same failure mode
as f017/f110, now three units running:
- `:182` was cut at "before or after them". The whole line continues "**and you
  continue to inherit updates as the built-in list changes across releases**",
  which is the strongest argument for this change and precisely the property prose
  in a prompt cannot offer. Verified by the orchestrator.
- `:103` is NOT "the same sentence" as `:182`. It says "entries" not "rules", and
  carries neither the keep-the-built-ins framing nor the inherit-updates clause.
  Same semantics, different wording — citing it as identical would fail a verbatim
  check.

**One line of C's work is NOT wired, and the orchestrator owns it.**
`managed-policy.ts:1228` still reads `defaults: Partial<ResolvedAutoModePolicyV1> = {}`;
it must become `= GUARDIAN_BUILT_IN_AUTO_MODE_DEFAULTS`. Until then the operand
exists and the sentinel is still swallowed, so **f121 is not fixed**. The line moved
from `:1199` to `:1228` under dispatch A's edits — another decayed cite. Applied by
the orchestrator after dispatch B releases the file; `:1232`
(`resolveAutoModeList(scopes.user?.[key], [])`) must STAY `[]` so the defaults
splice exactly once, in the managed scope.

**New candidate finding, NOT in the 245 and NOT yet a row.** `auto-mode-config.md:214`
names the built-in soft blocks as "every built-in soft block rule, including force
push, `curl | bash`, production deploys, and auto-mode bypass". We have force push
and production deploys; we have never had **`curl | bash`** or **auto-mode bypass**.
C refused to add them under a representation change, which was right — that would be
policy smuggled in. Per this repo's rule nothing reaches the parity tracker before
it has been challenged, so it is recorded here as a candidate and nowhere else.

**Unmeasured, stated rather than implied:** moving the lists out of the system
prompt takes ~1.9k chars out of the cacheable prefix and adds ~4.2k per judge task,
net ≈ +2.3k chars per consult. No live judge run was made, so verdict-level
equivalence between prose-in-prompt and rules-as-data is unverified.

**f163 splits, and only half of it lands here.**
- **f163a — declare `env`, ignore it at user scope with a recorded warning.** A
  documented key must not destroy the file. This is unconditional and lands in B.
- **f163b — HONOUR user-scope `env`. PARKED, owner threat-model decision.**
  `~/.nessy-agent/config.json` has no write containment against the agent's own
  Bash tool (`protected-paths.ts`, its own "Known limits" block), so a user-scope
  `env` block is unprompted code execution in the HOST process, plantable by one
  shell redirect from a prompt-injected turn and persistent across restarts.
  Declaring the key is safe; executing its contents is not. Do not implement b
  without an explicit owner decision.

## Queued by the owner for AFTER the wave (2026-08-06, mid-R38)

Two directives arrived in chat while R38 executed; both run after the wave's
own close-out (which already ends with the full CDP run on a packaged build):

1. **Full CDP verification of plugins, skills, MCP, and the marketplace** — a
   dedicated pass over those subsystems' checklist sections (Plugins &
   marketplace, Skills, MCP sources, Hooks & automations) on the packaged
   build, to confirm the wave's changes left them working. Can fold into the
   wave-final CDP run as its own wave section.
2. **Research: our plugins under the codex/claude runtimes.** The runtimes now
   ship by default (1.19.0) and run their OWN harnesses (codex-app-server /
   Claude Agent SDK) with their own tool sets — our plugin ecosystem (skills,
   MCP, hooks, commands, agents via `packages/shared/src/plugins/` and the
   format adapters) is wired into the Pi loop and partially into the Claude
   SDK path. Research what carries over per component type on each runtime,
   what the Claude SDK path already handles natively vs what the codex
   Responses adapter would need (an IR-level adapter seam like
   `format-adapters/{claude,codex}.ts` but at RUNTIME, not import time), and
   what is structurally impossible (e.g. Pi workflow tools). Deliverable: a
   written report with a per-component matrix before any implementation.

3. **The live checklist is a deliverable, not a byproduct (2026-08-07).** The
   wave-final CDP pass must also CURATE `docs/testing/cdp-live-checklist.md`:
   extend cases where a wave unit left a user-visible affordance untested, and
   DELETE rows that no longer describe the product. A stale row is worse than a
   missing one — it reads as coverage. The bar the owner set is the user's
   experience, not the diff's: every wave unit that changed something a person
   can see must have a row that a person could actually run.

## Owner decision 2026-08-07: there are no third-party administrators

Binding for every remaining unit, and for the close-out review.

**We are the administrator.** Managed policy in this product is written by our
own team for our own fleet — there is no external or third-party admin whose
settings we receive and must contain. Claude's docs are written for a
multi-tenant world where an administrator is a separate, semi-trusted principal;
several specs inherit that framing and ask for machinery that models it.

What this changes, and what it does NOT:

- **Scope down admin-facing elaboration.** Where a spec asks for per-admin
  isolation, admin-visible approval UX, or containment of a managed value
  *because an administrator might be hostile*, build the documented behaviour and
  skip the containment. Record it as a scoped narrowing with this decision as the
  reason.
- **Do NOT drop protections whose threat is the CONTENT, not the admin.** The
  distinction is who the attacker is. R63's suggestion allowlist is the worked
  example: its source-binding rule does not defend against a rogue administrator,
  it defends the administrator's own allowlist from being captured by whoever
  registers a marketplace under that name first. The marketplace is third-party
  even when the admin is us, so the check stays. Same for anything defending
  against plugin, MCP-server, skill or model output.
- **Managed-policy PARSING still ships**, because it is doc contract and because
  our own policy files are how the fleet is configured. The narrowing is about
  defensive machinery around the administrator, not about the feature.

Revisit queue (owner's instruction: after the plan completes, not now) — decisions
already landed that this may reopen: R63's admin-facing surfaces, R31's managed
key vocabulary, and any managed-approval flow the remaining units add.

## Merge gate, opened by the owner 2026-08-07

The owner authorized pushing and driving MR !37
(`gitlab.tcsbank.ru/nessy-desktop/nessy-desktop/-/merge_requests/37`,
`feat/improvments` → `master`) to merge-readiness.

**Measured 2026-08-07 from CI, not inferred.** Branch pipeline 120468629:
`lint`, `typecheck`, `build-desktop` green; `semgrep-sast` fails on
infrastructure (gatekeeper rejects `registry.gitlab.com/security-products/semgrep:6`;
only artifactory mirrors are allowed) — reviewer-owned; `test` fails with
**eleven** cases. `master`'s last pipeline (119773080, 2026-08-01) is GREEN, so
by this repo's own merge-gate rule every one of the eleven is branch-introduced:

| Failing case | Register status |
| :-- | :-- |
| `fixed Pi lifecycle bridge > freezes a complete per-hook semantic contract for the documented inventory` | row exists; measured branch-introduced |
| `SessionManager Pi child orchestration composition > normalizes disabled Pi modes …` | REGRESSED — was fixed 2026-07-31 by `e9e691c2` |
| `SessionManager Pi child orchestration composition > normalizes an imported Pi permission mode …` | REGRESSED — same commit |
| `background shell tracking > deleteSession kills every registered background shell before removing the session` | NEW, unregistered |
| `filesystem scope receipts (P6) > surfaces trusted project config diagnostics as safe codes in the runtime snapshot` | NEW, unregistered |
| `SessionManager project mutation > rejects a follow-up send while deletion owns the active-turn boundary` | row exists; master comparison was deferred, now decided by master-green |
| `SessionManager backend config project trust > carries host-resolved trust into the backend config for a preset-cwd session` | NEW, unregistered — adjacent to R42 |
| `SessionManager backend config project trust > stays fail-closed while the project is not trusted` | NEW, unregistered — adjacent to R42 |
| `registerSystemCoreHandlers OPEN_URL > routes nessy action links internally via deeplink:navigate` | row exists; branch-introduced by R43 |
| `registerSystemCoreHandlers OPEN_URL > routes workspace deep links to workspace target when URL workspace differs` | row exists; same |
| `resolveMcpDynamicHeaders > kills a hanging helper at the deadline and names the timeout` (15 000 ms) | NEW — introduced by R34 (this wave); a real-deadline test that overruns the runner |

Sequencing decision (orchestrator, 2026-08-07): clear these ELEVEN before adding
more wave units. Stacking units on a red branch deepens exactly the accumulation
this repo's merge-gate trap describes — a per-base check cannot see it, and
`master` being green is the whole finding. A row leaves the register by being
FIXED, never by being re-verified.

**All eleven were cleared** and the branch reached `bun test` 11 833 pass / 0 fail
— the first all-green run on it — with CI green behind it.

### Second red, found 2026-08-07 late (pipeline 120627856)

`build-desktop` GREEN, `test` FAILED with **two** cases at 12 319 tests. The
count is the finding as much as the failures are: the all-green run was at
11 833, so ~486 tests have landed since and two of them do not survive a full
suite. Both are in units already marked ✅, which means neither was broken by the
unit that owns it — something later moved under it.

| Failing case | First read |
| :-- | :-- |
| `child session spawner > counts a fork against the ceiling but never refuses one, and leaves workflow and judge children alone` (`spawner.test.ts:959`) | expected `['held','user fork','workflow stage','guardian']`, received the first three. The case budgets **two `await Promise.resolve()` ticks** for four spawns to reach the port. That is the same defect shape already fixed twice in this wave — *budgeting a fixed number of microtasks instead of polling for the effect* — and it is load-sensitive, which is why it survives locally and dies on a shared runner. |
| `per-agent memory directories > is entirely inert when auto memory is off` (`agent-memory.test.ts:127`) | wrote `memoryEnabled:false` to `CONFIG_DIR/config.json`, still got a context back. **Not the `NESSY_CONFIG_DIR` trap**: verified statically that `CONFIG_DIR` (`paths.ts:21`) is one frozen const and `CONFIG_FILE` (`storage.ts:186`) is `join(CONFIG_DIR,'config.json')` off that same const, so test and code cannot disagree on the path; and `loadStoredConfig` (`storage.ts:830`) re-reads the file every call, so it is not a cache either. Cause therefore still OPEN — reproduce before theorising further. |

Neither may be waved through as flaky. The rule this wave has used throughout
applies: **reproduce first, on a rig where nothing else is running.** Both
reproductions were blocked at the time of writing because three executors held
the repo and two concurrent `bun test` processes manufacture failures of exactly
this kind.

### Both diagnosed and fixed 2026-08-07 — and BOTH are test defects, not product defects

The full suite on a free repo: **12 370 pass / 1 fail**. Only the memory case
reproduced locally; the spawner case is load-sensitive and needs a loaded runner.

**A NEW REPO-WIDE TRAP, and the reason four rounds of static reasoning got it
wrong — including two of mine, recorded above.** `packages/server-core/src/handlers/rpc/sessions.memory.test.ts:9`
called `mock.module('@nessy-agent/shared/config', …)` with an object listing
**only the two exports that file needed**, no spread of the real module and no
restore. `mock.module` is **process-global and permanent**: from the moment that
file loads, every later test file in the same process sees a
`@nessy-agent/shared/config` whose every other export is gone and whose
`getMemoryEnabled` is hard-wired to `true`. `packages/server-core` sorts before
`packages/shared`, so in a full run the stub was always installed first.

Every static theory failed because the premise was wrong in a way reading cannot
show: the code was never consulted. What settled it was **instrumenting the test
and printing the installed function's own source** — `getMemoryEnabled` came back
as `() => !0`, while `loadStoredConfig()` called from the same namespace returned
the correct `{…,"memoryEnabled":false}`. Bisection alone would not have found it
either: no single file reproduced it, because the pair has to load in the right
order.

Fixes, each with a control run in both directions:

- `sessions.memory.test.ts` — spread the real module AND restore it in
  `afterAll`, the pattern `claude-gateway-adapter.test.ts:79` already uses. The
  spread alone is NOT sufficient and that was measured, not assumed: the override
  is the whole point of the mock, so it is the override that leaks. Sibling
  `sessions.shell-command.test.ts:16` was checked and already correct.
- `spawner.test.ts` — the two `await Promise.resolve()` ticks replaced by a
  `waitUntil` that polls for the effect. Control: counting the fork as
  `agent-tool` makes the ceiling refuse it, only three children start, and the
  poll fails loudly with its label instead of asserting a race — so the rule is
  still gated, which is the thing a timeout-based wait usually loses.

**Generalisable rule for this repo:** a `mock.module` that does not spread the
real module is a package-wide amputation, and one that does not restore is
permanent for the process. Neither is visible from the file that breaks.

## Scheduling constraint found while dispatching (2026-08-04)

**`packages/server-core/src/sessions/SessionManager.ts` serializes most of this wave.**
R32/f224, R34, R35 and R38 all list it, and `git commit <pathspec>` takes the file's
WORKING-TREE state, so two executors holding it WILL cross and each will land under
the other's subject. Units are therefore dispatched **one at a time** rather than
fanned out. The plan's dependency order stands; what changes is that there is no
parallelism to exploit below it. Zone by file, not by subsystem — the subsystem
boundaries in this wave look independent and are not.

## Citations pre-verified for the next units (2026-08-04, orchestrator)

Every unit so far had at least one decayed or half-quoted cite, so these were checked
against the live pages BEFORE dispatch rather than during it.

**R38 — all three hold at the cited lines**, and two carry a load-bearing second half
the specs stop before:
- `worktrees.md:112` continues past the fetch rule: "If no remote is configured, or
  `origin/HEAD` isn't cached locally and can't be fetched, the worktree falls back to
  your current local `HEAD`. **Before v2.1.208, a fresh worktree used whatever
  `origin/HEAD` was already cached locally.**" The version note is the evidence that
  refreshing is the CORRECTED semantics and our current behaviour is the old one.
- `large-codebases.md:242` continues: "**Before v2.1.207, the entry remained after the
  last worktree was removed, and go-git-based tools such as `tea` failed to open the
  repository until you ran `git config --unset extensions.worktreeConfig`.**" That is
  the concrete user consequence of f186 — not a tidiness issue, a repository other
  tools cannot open.

**R35 — the premise needs restating, and the citation the specs use is the wrong one.**
- `sub-agents.md:864` is the depth-limit section (the specs cite `:522`/`:523`). It also
  binds the AT-LIMIT behaviour, which no spec quotes: "At the depth limit, Claude Code
  withholds the `Agent` tool from every subagent except a fork, so a subagent at the
  limit does its delegated work itself and returns one summary. A fork at the limit
  keeps `Agent` in its inherited tool list, but the tool returns an error instead of
  spawning." Withholding the tool and erroring in a fork are two different mechanisms.
- **Our default of 1 was never wrong — it is stale.** `env-vars.md:280`: "**In v2.1.217
  through v2.1.218, the default was 1**, so a subagent couldn't spawn its own unless you
  raised the limit; **v2.1.219 raised the default to 3.**" So f076/f084/f130/f164 are
  "upstream moved and we did not follow", not "we implemented it incorrectly". The same
  line also binds the parse: "Accepts a positive whole number in plain digits; anything
  else is ignored, so the limit can be adjusted but not removed."
- `:893` names **three** separate limits with three variables — total-per-session,
  concurrent, and depth. f086 is the concurrent one; `:905` puts its default at 20 via
  `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, with a carve-out no spec mentions: "Sessions
  with ultracode active are exempt: the limit isn't enforced there."

## R38 · worktree-lifecycle (f096/f147/f159 + f097 + f186) · implementation plan (planned 2026-08-06, orchestrator)

**Citations re-verified against the live pages 2026-08-06 — all three hold, all
three drifted:**
- `worktrees.md:128` (was :112): "For a `\"fresh\"` base, Claude Code keeps
  `origin/HEAD` current: when the repository hasn't been fetched in the last 24
  hours, it fetches the default branch, capped at five seconds, and uses the
  locally cached ref if the fetch fails. If no remote is configured, or
  `origin/HEAD` isn't cached locally and can't be fetched, the worktree falls
  back to your current local `HEAD`. Before v2.1.208, a fresh worktree used
  whatever `origin/HEAD` was already cached locally." Byte-identical, whole line.
- `worktrees.md:150-162`: `.worktreeinclude` at the project root, gitignore
  syntax, "Only files that match a pattern and are also gitignored are copied,
  so tracked files are never duplicated", the three-line example
  (`.env`/`.env.local`/`config/secrets.json`), "applies to every worktree Claude
  Code creates with git", and the carve-out "With a `WorktreeCreate` hook, copy
  the files inside the hook script"; `:231` adds "Because the hook replaces the
  default git behavior, `.worktreeinclude` is not processed".
- `large-codebases.md:245` (was :242): "Claude Code removes that entry after the
  last worktree is removed, but only if Claude Code added it. It never removes a
  value you set yourself. Before v2.1.207, the entry remained…`tea` failed to
  open the repository…". Byte-identical, whole line.

**Code anchors re-verified on HEAD (979c69c2) — the specs' line numbers drifted
~+80 under the 1.18.0/1.19.0 work; every structure holds:** `runWorktreeGit`
SessionManager.ts:10099 (60s literal at :10121), `createPiWorktreeLeaseService`
:10165, `runGit` closure :10198, `policy.select` candidate loop :10229-10235
(breaks on `exitCode === 0 && baseSha`), `git.create` :10242-10281 (symlink loop
:10268), `git.remove` :10292-10295, no-op-emit path :9593;
`worktree-lease-service.ts` `create(lease)` port :91, acquire call :227,
`applyWorktreeCreateHookPath` :251-284 (adopts a path at :283), recover call
:296, `releaseUnlocked` remove-throw :330-334; `worktree-git-plan.ts` (125
lines) `worktreeBaseShaCandidates` :39-53, `worktreeCreateCommands` :74-96,
`worktreeSymlinkPlan` :112-124; `worktree-settings.ts` caps :64-65
(`MAX_LIST_ENTRIES` 128 / `MAX_ENTRY_LENGTH` 512), defaults comment :67-70,
unknown-key throw :78-83, `repoRelativePaths` :91-107. `.worktreeinclude` reader
absence re-confirmed NUL-safe (`grep -a`, 0 hits; positive control `sparsePaths`
15 files).

**Unit = one commit, three parts (specs: f096 §change is authoritative for A,
f097 for B, f186 for C — this section records only the deltas the executor must
not rediscover):**

- **A (`.worktreeinclude`, one fix for three findings).** New pure planner
  `packages/server-core/src/pi-harness/worktree-include-plan.ts`
  (`parseWorktreeInclude` / `worktreeIncludeCandidateCommands` /
  `worktreeIncludePlan`) per f096; the include step lands in `git.create` AFTER
  the `worktreeCreateCommands` loop beside the symlink loop, root =
  `projectRoot()` (:10248), copy with mode preservation (`chmod` to source mode
  — secrets), skip-if-exists (idempotent for `recoverUnlocked`'s re-`create`),
  `sessionLog.warn` tolerance including a malformed file. Hook carve-out rides a
  CALL ARGUMENT: `create(lease, context: { hookReplacedPath: boolean })` — NEVER
  a field on persisted `WorktreeLeaseV1`; `applyWorktreeCreateHookPath` reports
  adoption; `recoverUnlocked` passes `false`. `matchGitignoreGlob` is reused
  READ-ONLY (it is the permission matcher — module header pins it); negation /
  anchoring / last-match-wins stay local to the new planner.
- **B (default-branch freshness).** `WorktreeGitCommand` gains
  `timeoutMs?: number`; `worktreeBaseShaCandidates(repoRoot, baseRef,
  freshness?)` — for `'fresh'` with `lastFetchedAtMs === undefined || nowMs -
  lastFetchedAtMs >= 86_400_000` prepend `fetch --no-tags --quiet origin`
  (`base-fetch`, `allowFailure`, `timeoutMs: 5_000`), and when
  `originHeadCached === false` also `remote set-head origin --auto`
  (`base-set-head`, same caps). Omitted `freshness` keeps today's two-candidate
  output. SessionManager: `runWorktreeGit` gains a `timeoutMs = 60_000` trailing
  param (replaces the :10121 literal), `runGit` threads it; `policy.select`
  learns the inputs before the loop — shared git dir via `rev-parse
  --git-common-dir`, `lastFetchedAtMs` from that dir's `FETCH_HEAD` mtime
  (missing ⇒ stale), `originHeadCached` from `symbolic-ref --quiet
  refs/remotes/origin/HEAD` exit 0 — and the loop must NOT capture a sha from
  prelude commands (gate on operation prefix `base-fetch`/`base-set-head`).
  Comment edits: worktree-git-plan.ts `"fresh"` doc (cite worktrees.md:128),
  worktree-settings.ts defaults comment, definitions.ts `AgentIsolation`
  comment (its "already satisfied" claim is stale against :128).
- **C (`extensions.worktreeConfig` cleanup).** Two pure builders in
  worktree-git-plan.ts: probe `config --local --get extensions.worktreeConfig`
  (`allowFailure`; absent = exit 1) and cleanup `worktree list --porcelain` +
  `config --local --unset extensions.worktreeConfig` (`allowFailure` —
  unset-of-absent exits 5). `git.create`: when `settings.sparsePaths.length >
  0`, probe BEFORE the create loop; absent ⇒ write ownership marker
  `join(namespaceRoot, '.worktree-config-owned')` with flag `'wx'`, swallow
  `EEXIST`; present ⇒ NO marker (doc: "never removes a value you set
  yourself"). `git.remove`: after a successful remove, if the marker exists —
  `worktree list --porcelain`, count lines starting `worktree ` — exactly 1 ⇒
  unset + unlink marker; skip the unset when `<sharedGitDir>/config.worktree`
  exists; the WHOLE cleanup wrapped in try/catch + `sessionLog.warn` (a thrown
  cleanup becomes `worktree-remove-failed` in `releaseUnlocked` :330-334 and
  would block drain). Marker is per-repository on-disk state, deliberately NOT
  on the lease record.

**Gates (⚡):** new worktree-include-plan.test.ts (doc's own example verbatim;
negation; tracked-file-not-copied; `..`/absolute/overlength refused;
collapsed-directory not expanded); worktree-git-plan.test.ts updated `fresh`
pins (no-freshness overload unchanged) + four freshness rows + the two config
argv pins; both lease-service suites' fake `git` ports accept the widened
arity; `bun test` over `packages/server-core/src/pi-harness/` +
`packages/server-core/src/sessions/`-adjacent worktree suites; typecheck
server-core + shared; `git diff --check`. Expanded boundary review on the final
diff (risk triggers: first network egress from a worktree git child — must
degrade silently under `allowManagedDomainsOnly` via allowFailure+timeout; the
first path copying gitignored SECRETS into `namespaceRoot` — mode preservation +
destination containment; a WRITE to the user's own `.git/config` — ownership
probe + last-worktree count + `config.worktree` guard are preconditions).
CDP checklist rows `WTR-1/2/3` land in the same commit.

## R34 · mcp-server-config-and-connect (f037 f041 f042 f044 f221) · implementation plan (planned 2026-08-06, orchestrator)

**Citations re-verified live 2026-08-06 (drift in parens):** `mcp.md:83` (was
:78) — the `streamable-http` alias sentence, byte-identical; `agent-sdk/mcp.md:378`
(was :375) — alias accepted in JSON configs, "The programmatic `mcpServers`
option accepts only `"http"`"; `mcp.md:768` (was :761) + `:795-818` — the
headersHelper contract in full: flat string-JSON stdout, shell + 10s timeout +
session-cwd (plugin root for plugin-provided, v2.1.195), dynamic-over-static
merge, fresh on EVERY connection ("There is no caching"), 401/403 → re-run +
reconnect + retry once (v2.1.193), helper env
`CLAUDE_CODE_MCP_SERVER_NAME`/`_URL`/`CLAUDE_PLUGIN_ROOT` (plugin-only),
`${user_config.*}` refused as a misconfiguration error (v2.1.207), and the
trust note (project/local scope runs only after workspace trust);
`mcp-quickstart.md:333/:336/:342` — MCP_TIMEOUT remedy, ms;
`env-vars.md:412` (was :410) — default 30000; `env-vars.md:407` (was :406) —
`MCP_CONNECT_TIMEOUT_MS` is the OTHER variable (5000, blocking-startup batch,
"Distinct from `MCP_TIMEOUT`"); `whats-new/2026-w20.md:87` — stdio servers
receive `CLAUDE_PROJECT_DIR`, "matching hooks"; `skills.md:331` (was :307) —
"the same path hooks and MCP servers receive".

**f221 premise correction (found on the whole-page read, 2026-08-06 — the
specs never cite it): `mcp.md:115`.** "This variable is set in the server's
environment, not in Claude Code's own environment, so referencing it via
`${VAR}` expansion in the `command` or `args` of a project-scoped `.mcp.json`
entry or a local- or user-scoped server entry in `~/.claude.json` requires a
default such as `${CLAUDE_PROJECT_DIR:-.}`. Plugin-provided MCP configurations
substitute `${CLAUDE_PROJECT_DIR}` directly and don't need the default." So
f221's project-config.ts item — seeding
`NESSY_PROJECT_DIR`/`CLAUDE_PROJECT_DIR` into the `.mcp.json` ${VAR}-expansion
environment — is REFUTED as written: a bare `${CLAUDE_PROJECT_DIR}` in a
project entry's `command` must stay literal-with-warning (the `:-default`
already works through the ordinary expansion), and its spec test case (1)
pins the wrong outcome. What stands: (a) stdio SPAWN environments — native,
`.mcp.json`-resource, and plugin — all receive
`CLAUDE_PROJECT_DIR`+`NESSY_PROJECT_DIR`; (b) plugin-config token
substitution: `pluginRuntimeEnv` emits `NESSY_PROJECT_DIR` (the name
`claude.ts` rewrites `${CLAUDE_PROJECT_DIR}` to), keeping
`claudeCompatPluginEnv`'s `CLAUDE_PROJECT_DIR` as the compat alias. The
`parseMcpServersDocument({ projectDirectory })` options-bag from the spec is
still wanted — but it feeds the stdio spawn-env merge, NOT the expansion
environment.

**Everything else follows the five specs' `change` arrays verbatim** (f041's
shared `normalizeMcpTransportAlias` helper subsumes f037's per-site ternaries;
f044 includes the `MCP_CONNECT_TIMEOUT_MS` → `MCP_STARTUP_TIMEOUT_MS` rename
and the docs-site EN+RU `NESSY_MCP_TIMEOUT` section; f042's fail-soft contract:
helper failure ⇒ connect with static headers + named log reason, resolved
headers NEVER in `mcpConnectionKey`, 401/403 retry-once as a NEW branch — do
not widen `isRetryableDiscoveryError`). Env var name for f044 is
`NESSY_MCP_TIMEOUT` (Nessy prefix, like every other runtime env knob).

**Two dispatches, one commit:**
- **A (small, first):** f037+f041 alias fold (helper + 6 sites + the two test
  files) and f044 (env lever + rename + deadline tests + docs-site EN/RU).
- **B (after A lands in the tree):** f042 headersHelper end-to-end + f221
  (as corrected above). Both edit `project-config.ts` and
  `runtime-pool-servers.ts` — strictly after A.

**Gates (⚡ auth/egress boundary):** focused new/updated suites
(streamable-http alias, mcp-pool-connect-deadline, ws-transport inversions,
claude-mcp-ws, config-variable-expansion, data-paths, mcp-pool); typecheck
shared + server-core; `bun run lint:i18n:parity`/`sorted` untouched (docs-site
only — no locale JSON); expanded final-diff review on: the helper spawn (shell
injection surface is the USER'S OWN config — same trust tier as hook commands;
must copy hook-command.ts's spawn/timeout/kill shape), secrets flow (helper
stdout never logged, never in the safe capability view, never in the
connection key), and the retry-once bound (401/403 must not become a general
4xx retry). Live cases MCP-N* rows in the same commit.

## R35 · subagent-nesting-depth (f076 f084 f130 f164) · implementation plan (planned 2026-08-06, orchestrator)

**Citations re-verified live 2026-08-06:** `sub-agents.md:867` (pre-verified
at :864) — "By default, a subagent can spawn subagents of its own, up to three
layers below the main conversation. At the depth limit, Claude Code withholds
the `Agent` tool from every subagent except a fork … A fork at the limit keeps
`Agent` in its inherited tool list, but the tool returns an error instead of
spawning." `:873-884` — the env var, the settings.json example, "Set `1` to
turn nesting off." `:889-891` — the version note (172-216: five fixed;
217-218: default 1; **219: default 3**) — the evidence our 1 is STALE parity,
not wrong parity. `:331` — the tool-list surface of the same rule.
`env-vars.md:281` (was :280) — "default: 3 … Accepts a positive whole number
in plain digits; anything else is ignored, so the limit can be adjusted but
not removed."

**Design pick where the four specs disagree:** the env reader is the NEW
module `packages/shared/src/config/subagent-spawn-depth.ts` per f084/f164
(modelled on `print-background-wait.ts`'s aliased pair), NOT
`background-task-settings.ts::maxSubagentSpawnDepth` per f076/f130 — the
aliased pair honours Claude's own spelling
(`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, Nessy name wins when both set),
which f076/f130's single-name reader silently drops, and f164 is the env-vars
page's own spec. Everything else is the union of the four `change` arrays;
where they repeat the same edit the wording differs but the edit is one.

**The edit list (executor follows f164 + f084 as primary, f076/f130 for the
per-file details they add):**
1. NEW `subagent-spawn-depth.ts`: `DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH = 3`,
   both env names exported, `resolveMaxSubagentSpawnDepth(env =
   process.env)` — trim, `/^\d+$/` only (NOT `Number()` — `1e3`/`0x3`/`2.5`
   must be ignored), `>= 1`, else 3; Nessy name wins. Plus its table-driven
   test file.
2. `harness-manifest.ts:107` `depth: 1` → `DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH`;
   lockstep comment cites sub-agents.md:867 + env-vars.md:281.
3. `spawner.ts:110` `DEFAULT_MAX_DEPTH = 1` → `= DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH`.
4. `SessionManager.ts` — the ONLY host-side env entry points:
   `createPiExecutionManifestSeed` orchestrator block gains
   `depth: resolveMaxSubagentSpawnDepth(),` (unconditional — host-resolved
   because both sides assert manifest identity), and the plugin-hook budgets
   fallback `maxDepth: parentBudgets?.maxDepth ?? 1` → `??
   resolveMaxSubagentSpawnDepth()`. DO NOT touch the judge self-pin
   (`maxDepth: (args.depth ?? 0) + 1`, commented 'does not nest, ever') nor
   the plain inheritance (`maxDepth: inherited.maxDepth`).
5. `runtime-agent-definitions.ts` — the observability half (without it the
   raise changes nothing a subagent can see): make the `subagent` subtraction
   depth-derived on BOTH branches (inherited pool AND `resolveExplicitTools`),
   using the SAME comparison the spawner's gate uses (childDepth =
   sessionDepth + 1 against maxDepth) so the withhold exactly mirrors the
   refusal; sub-agents.md:867/:331 — a FORK at the limit keeps the tool listed
   (the spawner's error is its enforcement); apply the fork carve-out where
   the fork descriptor branch exists.
6. `pi-agent-server/src/index.ts` `buildPiRuntimeAgentDefinitions` call: pass
   `{ sessionDepth: config.orchestrator?.sessionDepth ?? 0, maxDepth:
   config.orchestrator?.depth ?? DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH }`; leave
   :1279 textually untouched (pi-agent-init-contract.test.ts:207 pins the
   literal string).
7. `pi-agent-server/README.md` depth row: default 3, env override pair named,
   `1` = nesting off; keep the nested-spawns-stay-foreground note (background
   default keys off depth 1 and does not change).
8. Tests: spawner.test.ts lockstep→3 extended to all four definers;
   admissions child/grandchild/third-layer + fourth-layer refusal; raise
   control above 3; `maxDepth: 1` refuses a grandchild (the documented
   opt-out); fix the stale :274 comment. harness-manifest.test.ts :97 → 3,
   move the explicit-override case off the new default (e.g. 5), re-run the
   legacy-hash test. runtime-agent-definitions.test.ts inherited-pool keeps
   `subagent` below the limit / drops at it, explicit-request granted below /
   withheld at; tool-manifest.test.ts:449 and
   context-usage.categories.test.ts:38 get the new argument.
9. Orchestrator-owned close-out (NOT the executor):
   `docs/superpowers/specs/2026-07-26-r-queue-doc-verification.md:555/:559`
   stale R30 closure ("default 1 — already matched by P9's depth-1 fix") gets
   a dated correction line, and the parity report regenerates.

**Gates (⚡):** focused suites above + `bun test packages/pi-agent-server/`
+ `bun test packages/shared/src/agent/pi-harness/` sequentially; typecheck
shared, server-core, pi-agent-server; the manifest-identity boundary is the
risk trigger — the legacy-hash test and pi-agent-init-contract must stay
green untouched. Live case rows SAD-1..2 (depth default observable; env
override) in the same commit.

## R36 · builtin-session-commands (f074 f124 f183) · implementation plan (planned 2026-08-06, orchestrator)

**Citations re-verified live 2026-08-06:** `agent-sdk/slash-commands.md:212`
— "/clear … resets the conversation to an empty context … The previous
conversation remains on disk"; `:214` — one-shot queries unaffected;
`interactive-mode.md:359-387` — the /btw contract in full (full conversation
visibility, no tools, available WHILE Claude is working, dismissible overlay,
never enters history; `:374` bare `/btw` REOPENS the overlay — v2.1.212, the
opposite of a usage error; keys at `:378-385`: Space/Enter/Escape dismiss,
Up/Down scroll, Left/Right step across earlier answers, `c` copy raw
Markdown, `x` clear, `f` fork; `:387` — the inverse-of-a-subagent sentence);
`interactive-mode.md:398-404` — /recap: one-line summary on demand;
`best-practices.md:410`.

**Design picks where the specs disagree (orchestrator, binding):**
- **Wire = f183's `SessionCommand` union widening** (`{ type: 'sideQuestion';
  question }` + `{ type: 'recap' }` on the existing sessions:sessionCommand
  invoke, results on the widened return union) — the exhaustive switch in
  server-core forces every handler, and no new channel is minted. f124's
  dedicated `ASK_SIDE_QUESTION` channel is NOT built.
- **`/clear` per f074**: parsed in `session-command.ts` (whole-message,
  no-arg), executed at the `BaseAgent.chat` seam (clearHistory + the
  onSdkSessionIdCleared persistence seam + info/complete yields, chatImpl
  never called); `claude-agent.clearHistory` gains the missing
  `super.clearHistory()`; `codex-agent` gains the missing override nulling
  `threadId`; SessionManager resets managed state copy-shaped from the rewind
  path (messages emptied, streamingText/lastFinalMessageId/lastMessageRole
  cleared, sdkSessionId undefined, persist+flush). Transcript decision:
  MODEL context is the doc-bound thing; the stored session file keeps the
  history on disk (slash-commands.md:212 "remains on disk") — we empty the
  LIVE transcript like the rewind path does and rely on session storage for
  the on-disk history. `storage.ts::clearSessionMessages` is NOT called from
  the agent layer (it writes behind SessionManager's back and the next
  enqueuePersist undoes it) — fold its intent into the SessionManager reset.
- **`f` fork key: OMITTED, recorded narrowing** — no substrate (a
  transcript-copying sessions:create does not exist; /subtask is not it).
- **Pi prompt-cache reuse for side questions: NOT in v1** — it needs a new
  `side_question` inbound message in the Pi protocol; the tool-less
  `queryLlm` route answers the doc's functional contract (visibility, no
  tools, mid-turn availability) without it. Recorded as deviation.
- **nestor-cloud-agent**: `btw`/`recap` excluded from its composer
  capabilities — its `queryLlm` throws by design.
- **Version bump/release notes: wave close-out, not per unit** (f124's last
  item over-applies the AGENTS.md rule; docs-site edits DO ride the unit).

**Dispatch A (shared + server-core):** session-command.ts (/clear + /btw
kinds; recap too — same classifier), btw.ts parser (bare form = reopen),
base-agent chat seam for /clear, claude/codex clearHistory fixes, pi-agent
runSessionCommand defensive btw branch (never a model turn; the fall-through
to subtask is the hazard), BaseAgent.askSideQuestion over tool-less queryLlm,
conversation-summary.ts builders (side-question prompt with an explicit,
wider transcript budget than the 12k default; recap builder produces the
one-line form), SessionManager.askSideQuestion/generateSessionRecap (no
transcript push, no persist, no user_message event, no title/label, works
while isProcessing) + the sendMessage guard so a typed /btw never becomes a
turn + the /clear reset, dto.ts SessionCommand union + result DTOs,
handlers/rpc/sessions.ts cases, session-manager-interface.ts declarations,
composer-capabilities exclusion, i18n keys (en+ru, sorted), tests
(btw.test.ts, session-command-seam /clear + /btw rows, the
transcript-unchanged invariant, storage untouched).

**Dispatch B (electron renderer + docs-site), after A:**
slash-command-menu.tsx ('btw'/'recap'/'clear'? — check whether 'clear'
already exists in the menu; add what's missing), slash-command-actions.ts
(branches BEFORE the isProcessing-gated MESSAGE_COMMANDS block; bare /btw
reopens, never prefills), FreeFormInput.tsx typed-command interception on the
submit path (never reaches onSubmit, not blocked by isProcessing),
SideQuestionOverlay.tsx (renderer-state-only ring of exchanges; keys per
:378-385 minus `f`; dimmed earlier list; raw-Markdown copy), channel-map +
ElectronAPI typing, docs-site interactions.md EN+RU.

**Owner directive 2026-08-06 (binding for dispatch B): NO new design
components — compose the overlay from what exists.** The reference the owner
named: the agent-driven chat used for adding skills/MCP — that is
`apps/electron/src/renderer/components/ui/EditPopover.tsx` in its INLINE mode
(popover + title/subtitle + the compact
`apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx`). The /btw
overlay is that popover shell + compact ChatDisplay for the Q/A rendering
(Markdown, streaming, copy affordances come free), with the /btw-specific
delta limited to: renderer-only exchange ring (never a session), the
:378-385 key bindings, and the dimmed earlier-answers list. Reuse the
existing popover positioning/dismiss primitives (Radix) as EditPopover does;
if a needed affordance is missing, extend the EXISTING component with a
prop, never fork a copy.

**Gates (⚡ wire boundary):** focused suites (slash-commands, agent seam,
session-command flow, SessionManager-adjacent, channel-map parity test);
typecheck shared/server-core/electron; i18n parity+sorted; the exhaustive
switch is the wire proof (typecheck fails until every case lands). Live
cases CMD-N1..N3 rows in the same commit.

## R37 · shell-command-response-mode (f228) · implementation plan (planned 2026-08-06, orchestrator)

**Citations re-verified live 2026-08-06:** `settings.md:315` (was :314) —
"`respondToBashCommands` **Default**: `true`. Whether Claude responds after an
input-box `!` shell command runs. Set to `false` to add the command output to
context without a response … Requires v2.1.186"; `whats-new/2026-w26.md:37`
and `interactive-mode.md:321` — the same contract, plus "The response costs
the same as sending a normal prompt" and the pre-v2.1.186 note (our current
hardwired behaviour IS the documented `false` branch).

**Edit list = f228's change array verbatim, four items:** (1)
`storage.ts` — `respondToBashCommands?: boolean` +
`getRespondToBashCommands()` (`!== false`, absent = ON, mirror
`getUseAutoModeDuringPlan`) + setter + index re-export; (2)
`SessionManager.runShellCommand` — branch after the transcript push: OFF
keeps today's persist/flush/one-user_message shape byte-identical; ON +
`result.executed` dispatches a turn on the SAME message via sendMessage's
`existingMessageId` adoption (no duplicate user_message); (3)
`getPendingDirectShellContext` — NO edit, but BOTH directions tested (ON: the
assistant reply moves `lastFinalAssistantIndex` past the shell output so the
fold is empty and the output is never prepended twice; OFF: fold unchanged);
(4) `sessions.shell-command.test.ts` — the green pre-change pin at :148-180
is REWRITTEN as the `respondToBashCommands: false` case (it pinned what is
now the non-default branch), plus the ON-path case (turn dispatched on the
existing id, no duplicate event); config stubbed at module scope per the
`pi-agent-guardian-consult.test.ts:16` pattern. `ShellCommandResult` wire
shape NOT touched (the spec's optional `responded` field is skipped —
FreeFormInput reads only `executed`).

**Gates (⚡):** the rewritten + new shell-command tests, the fold tests both
directions; typecheck shared + server-core; no wire change. Live case
SHL-N1 in the same commit. One dispatch.

## R39 · loop-and-self-paced-scheduling (f199 f200 f201) · implementation plan (planned 2026-08-06, orchestrator)

**Citations re-verified live 2026-08-06 (scheduled-tasks.md 223 lines,
tools-reference.md:46):** `:35` /loop is a bundled skill, interval and prompt
both optional; `:37-41` the three-row dispatch table; `:43-46` a scheduled
fire only runs model-invocable skills; `:52` "Claude converts it to a cron
expression"; `:58` grammar (leading bare `30m` or trailing `every 2 hours`;
units s/m/h/d); `:60` rounding (seconds up to a minute; `7m`/`90m` to the
nearest expressible step, choice reported); `:64` self-paced window "a delay
between one minute and one hour", "The chosen delay and the reason for it
are printed at the end of each iteration"; `:74` dynamic loop appears in the
task list, jitter rules do NOT apply, seven-day expiry DOES; `:82-88` the
built-in maintenance prompt's three items in order + the no-new-initiatives /
irreversible-actions guard; `:94` bare /loop = maintenance prompt at a
dynamic interval; `:100-120` loop.md (project `.claude/loop.md` beats user
`~/.claude/loop.md`; ignored when a prompt is supplied; edits take effect on
the next iteration; >25,000 bytes truncated); `:126-128` Esc clears the
pending wakeup, directly-scheduled tasks unaffected; `:130` ScheduleWakeup
stop:true cancels immediately; the ~20-minute fallback wakeup, loop ends
when the fallback iteration doesn't reschedule either;
tools-reference.md:46 — 1min-1hour window, `stop` is the only documented
field, the pending wakeup appears in `session_crons` (satisfied for free by
storing dynamic loops as records).

**Design picks (binding):**
- **NO standalone `loop-interval.ts` module** (deviation from f199's change
  item, recorded): `:52` puts interval→cron conversion on Claude, the skill
  body carries the `:58`/`:60` grammar and rounding rules as instructions,
  and a host function with no production caller is this repo's
  unused-identifier trap. The rounding contract is exercised by the live
  case instead.
- **One dynamic marker, named `dynamic`** (f201's spelling; f199's
  `selfPaced` is the same field). Cron-store additions all optional:
  `dynamic?: boolean`, `nextFireAt?: number`, `promptSource?: 'loop-md'` —
  persisted schemaVersion 1 stays load-compatible both directions, pinned by
  a round-trip test.
- **Prompt module home = `packages/shared/src/prompts/loop-prompt.ts`**
  (f200's detailed spec wins over f199's skills/ path):
  `MAX_LOOP_MD_BYTES = 25_000`, `BUILTIN_LOOP_MAINTENANCE_PROMPT`
  PARAPHRASED per AGENTS.md's prompt rule (three items in documented order +
  the guard), `resolveLoopPrompt(projectDir, configDir = CONFIG_DIR)` —
  project `.nessy-agent/loop.md` beats `<CONFIG_DIR>/loop.md`, re-read every
  delivery, byte-capped. Re-export via `@nessy-agent/shared/prompts`.
- **ScheduleWakeup schema**: `{ delaySeconds?: number; reason?: string;
  stop?: boolean }` — `stop` is the documented field; the delay field is
  undocumented, `delaySeconds` clamped to [60, 3600] per
  tools-reference.md:46's window, `reason` carries the `:64` printed line;
  choices recorded in the schema comment. `executionMode: 'registry'`,
  `safeMode: 'block'`, `visibility: 'pi-only'` — the cron tools' precedent.
- **`promptSource: 'loop-md'` substitution at DELIVERY** (f200): the service
  re-resolves via a `resolveDefaultPrompt` option in flush; the stored
  prompt stays populated so CronList shows something.
- **Fallback semantics** (f201): a delivered dynamic fire with neither rearm
  nor stop arms ONE ~20-minute wakeup and marks the record; a second
  unrescheduled iteration ends the loop (record deleted).
- **Esc** (`:126-128`): host half only in this unit — `stopWakeup` on the
  cron port/service; IF a natural renderer Esc hook exists (the existing
  escape-interrupt path) wire it minimally, else record the renderer half as
  a follow-up in the tracker note. Executor investigates, bounded.
- **isCronDisabled** also withholds the `loop` skill slug from slash
  selection and the model-facing listing (one condition, two places, f199).
- **Bedrock/Vertex/Foundry carve-outs (`:123`)**: not applicable to this
  fork's providers; noted, not coded.

**Zone:** apps/electron/resources/skills/loop/SKILL.md (frontmatter: name +
description ONLY — no disable-model-invocation, no user-invocable:false;
body encodes the dispatch table, grammar+rounding, CronCreate usage with
recurring:true + promptSource:'loop-md' when promptless, ScheduleWakeup
usage for the self-paced mode incl. the reason line and stop:true, the
1min-1h window, Esc note), packages/shared/src/skills/seed.ts (only if the
slug enumeration needs it — verify it enumerates the directory),
packages/shared/src/prompts/{loop-prompt.ts,index.ts} + tests,
packages/shared/src/sessions/{cron-store.ts,cron-scheduler.ts} + tests,
packages/server-core/src/sessions/{session-cron-service.ts,SessionManager.ts}
+ session-cron-service tests, packages/session-tools-core/src/{tool-defs.ts,
context.ts,handlers/cron-tools.ts} + their tests.

**Gates (⚡ persisted-schema boundary):** cron-store round-trip old⇄new;
jitter-zero + nextFireAt scheduling + seven-day-bound pins; the loop-md
second-fire edit test; ScheduleWakeup handler suite (clamp, stop, no-port
backend fails through the existing unavailable path); typecheck shared,
server-core, session-tools-core; live cases LOOP-N1..N4.

## R40 · egress-and-provider-routing (f093 f116 f118 f191) · implementation plan (planned 2026-08-06, orchestrator)

**Citations re-verified live 2026-08-06:** `network-config.md:30-33` — both
NO_PROXY separators documented side by side (space form + comma form + `*`);
`amazon-bedrock.md:437/:444/:485/:497` — `CLAUDE_CODE_USE_MANTLE`,
`ANTHROPIC_BEDROCK_MANTLE_BASE_URL`, `CLAUDE_CODE_SKIP_MANTLE_AUTH` ("Skip
client-side authentication for proxy setups");
`authentication.md:172-173` — precedence tier 1 = the THREE cloud toggles
(BEDROCK, VERTEX, FOUNDRY), tier 2 = `ANTHROPIC_AUTH_TOKEN` as
`Authorization: Bearer`, above the tier-3 `ANTHROPIC_API_KEY` we write;
`llm-gateway-protocol.md:159` (was :157) — "any redirect is treated as
failure so the credential can't leak to a redirect target", 3-second
timeout.

**Design pick where f116/f118 collide:** ONE shared leaf module
`packages/shared/src/config/claude-provider-routing-env.ts` (f116's home)
exporting `CLAUDE_CLOUD_PROVIDER_ROUTING_ENV_KEYS` (f118's name) with the
UNION set: `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`,
`CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_ANTHROPIC_AWS`,
`CLAUDE_CODE_USE_MANTLE`, `AWS_BEARER_TOKEN_BEDROCK`,
`ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_BEDROCK_MANTLE_BASE_URL`,
`CLAUDE_CODE_SKIP_MANTLE_AUTH`. Both consumers (options.ts loop-delete;
llm-connections.ts local re-pointed) import it. Everything else follows the
four change arrays verbatim: f093's NO_PROXY splitter at three sites
(dedicated helper — do NOT widen splitCommaSeparated, cert stores stay
comma-only; interceptor keeps its INLINE twin with a naming comment —
preload bundle) + proxy-env canonical comma join + docs-site EN/RU line;
f118's postInit `delete process.env.ANTHROPIC_AUTH_TOKEN` beside
API_KEY/OAUTH_TOKEN; managed-env classifications (all USE_* toggles +
MANTLE_BASE_URL = 'routing', SKIP_MANTLE_AUTH = 'credential') with the
by-design pin update; f191's `redirect: 'error'` + wired
`AbortSignal.timeout` on both model-fetch sites; shared AGENTS.md
sanitization note re-pointed at the constant.

**Gates (⚡ auth boundary):** managed-env pin, llm-connections-auth-env
table-driven over the exported constant (cannot drift again),
claude-turn-options comment + strip case with an AWS_REGION positive
control, network-proxy page-example cases, nestor/anthropic fetch-init
assertions + the reject-on-redirect negative; typecheck shared +
server-core; live case NET-N1 (NO_PROXY space form) + the redirect row in
the same commit. One dispatch.

## R41 · permission-tool-classification (f021 f139) · implementation plan (planned 2026-08-06, orchestrator)

**Citations re-verified live 2026-08-06:** `permissions.md:158` — "the tool
labeled `Stop Task` in the transcript has the canonical name `TaskStop`.
Permission rules and hook matchers match the canonical name only";
`tools-reference.md:55` — the `TaskStop` row; `chrome.md:106` — plan mode:
"browser tool calls that only read the page or browser state run without a
permission prompt, and calls that change state prompt for approval";
`:108-109` — the two classes; `:111` — v2.1.199: a read-only verb with a
state-changing input flag (`createIfEmpty`, `clear` on console/network
readers, `save_to_disk` on screenshot) also prompts, and a batch runs
promptless only when EVERY action is read-only.

**Both specs' change arrays verbatim.** f021: the `stop_task` binding's
permissionName becomes `TaskStop` (5th arg only — piName/bindingName stay
Pi's wire names, the static model-contract hash must not move); alias
comment updated; descriptor + claude-permission-rules tests pin the new
spelling and RECORD the legacy `stopTask` verdict (leaves
PERMISSION_RULE_TOOL_NAMES → a legacy deny warns; `stop_task` still
resolves via descriptorId); tool-surface fixture row reconciled with its
own claudeBehaviorCounterpart. f139: classifier
`BROWSER_READ_ONLY_COMMANDS`/`isReadOnlyBrowserToolInput` lives in
browser-tool-names.ts (mode-manager already imports it — no new edge);
`splitBatchCommands`/`tokenizeCommand` move to a shared parse module so the
GATE uses the executor's own tokenizer (a second tokenizer is the bypass);
the read-only set is the EXECUTOR's verb list (help/snapshot/find/
screenshot/screenshot-region/console/network/windows/wait/downloads/
get-clipboard), unknown verbs classify STATE-CHANGING, state-flag inputs
(`clear`, `save_to_disk`, …) flip a read-only verb per :111, batch =
all-read-only; mode-manager drops `browser_tool` from ALWAYS_ALLOWED_TOOLS
so both spellings fall through to ONE decision site (read-only → allowed;
state-changing in plan → the plan-review prompt path); pre-tool-use's
prompt gains a browser branch so the approval row shows the COMMAND and
'don't ask again' scopes to the command, not the whole tool; re-exports;
the two pinning tests re-cut per command class per the spec's table.

**Gates (⚡ permission boundary):** descriptor + permission-rules +
browser-tools-permissions suites; the static model-contract hash pin must
NOT move (f021's own constraint); typecheck shared + server-core +
pi-agent-server; live cases PRM-N1 (TaskStop deny matches) + BRW-N1 (plan
mode: snapshot silent, click prompts, batch mixed prompts). One dispatch.

## R42 · project-trust-home-carveout (f173) · implementation plan (planned 2026-08-06, orchestrator)

**Citation re-verified live 2026-08-06, byte-identical at `glossary.md:231`:**
"Acceptance is saved per project directory, except your home directory, where
trust is held for the current session only and the prompt reappears on each
launch." The session-only mechanism EXISTS (`persistence: 'process-only'`,
salted per-process key); the delta is that $HOME never classifies into it.

**Edit list = f173's change array verbatim, five code items + tests:**
(1) `project-identity.ts` — `homeDir?` seam defaulting to `os.homedir()`;
canonicalize home through the SAME injected realpath; widen the process-only
fallback condition to `!identity || canonicalPath === canonicalHome`. (2)
`SessionManager.ts` workspace-default-project restore — the REQUIRED
compatibility guard: a stored `defaultProject.projectKey` that no longer
matches (a pre-fix persisted $HOME key can never match a process-only one)
clears the selection instead of throwing the restore away. (3)
`recent-store.ts` `staleHint` gains `&& resolved.persistence === 'stable'`
so a pre-fix $HOME recent record doesn't quarantine/throw. (4) renderer leg
(`ChatPage.tsx`): open `ProjectTrustDialog` when a restored session's
project resolves `trustState: 'unknown'` — the value is already on the wire
(`security.projectTrustState`), no wire change. (5) Tests per the spec: the
identity pair (home stat-success → process-only, salt-varying key; SUBDIR of
home → stable; home-via-symlink → process-only), the trust-store
restart-simulation probe (record → nothing on disk → fresh store reads
'none'; stable case as positive control), the handle-service end-to-end
(home is NOT refused — trusted session-scoped only), and the two guards'
compat cases.

**Gates (⚡ trust boundary):** those suites + typecheck shared, server-core,
electron; live case TRST-N1 (home prompt reappears on relaunch; a real
project's grant survives) in the same commit. One dispatch.

## R44 · output-styles (f193 f194 f195) · implementation plan (planned 2026-08-06, orchestrator)

**Citations re-verified live 2026-08-06:** `output-styles.md:19-25` — the
three additional built-ins with their prose (Proactive: "executes
immediately, makes reasonable assumptions instead of pausing for routine
decisions, and prefers action over planning … works without changing your
permission mode"; Learning: "collaborative, learn-by-doing … `TODO(human)`
markers in your code for you to implement"); `:55` — "Project output styles
load from every `.claude/output-styles/` between the working directory and
the repository root … uses the one closest to the working directory"
(v2.1.178); `:100-101` — system-prompt placement PLUS "All output styles
trigger reminders … during the conversation"; `:104` — subagents exempt
(own system prompt), forks inherit.

**Three change arrays verbatim, one dispatch:** f193 — the reminder is a
VOLATILE context part (PromptBuilder gains activeOutputStyleLabel +
setter + buildOutputStyleReminder modelled on buildPendingPluginAuthReminder;
fed at both backends' existing style-resolution sites with the SAME
child-kind-guarded value, so named subagents stay reminder-free per :104;
label defanged against `</system-reminder>` closure; Default emits nothing);
composition exposes `label` (single-reader invariant kept). f194 — APPEND
`proactive` + `learning` after the existing entries (never rename/reorder —
`outputStyleId` persists raw ids), prompts PARAPHRASED per AGENTS.md,
`keepCodingInstructions: true` for Proactive (it layers on the engineering
prompt), Learning carries the `TODO(human)` contract; four i18n keys EN+RU.
f195 — `OutputStyleRoots.projectRoot?` as the walk's stop boundary (absent =
today's single-dir behaviour, ~15 test call sites stay valid);
`outputStyleDirectories` walks nearest-first cwd→projectRoot, refusing the
chain when cwd is outside root; `getSystemPrompt` gains the trailing
optional param; both backends pass the session's canonical project root —
executor picks the threading (non-persisted runtime field vs in-module
derivation) after studying what the config already carries, and records the
choice.

**Gates (⚡):** output-styles suite (built-ins list, proactive/learning
composition incl. keep-coding half and the TODO(human) literal; the three
nested-walk cases incl. closest-wins and the untrusted negative);
prompt-builder context-split (reminder in volatile only, defang case);
i18n parity+sorted; typecheck shared + server-core + electron; live case
STY-N1..N2. One dispatch.

## R45 · claude-informational-messages (f081) · implementation plan (planned 2026-08-06, orchestrator)

**Citations re-verified live 2026-08-06:** `agent-sdk/typescript.md:1159` —
`SDKInformationalMessage` in the union; `:1396-1410` — the shape
(`subtype: "informational"; content; level: info|notice|suggestion|warning;
tool_use_id?; prevent_continuation?`) and the binding sentence: "Generic
text banner emitted by the loop. Carries non-error status lines, hook
feedback such as a `UserPromptSubmit` hook's block reason, and command
output. Render `content` as plaintext at the given `level`."

**Edit list = f081's change array verbatim:** adapter branch narrowing off
the SDK's exported type (empty content skipped; level map
info/notice/suggestion→'info', warning→'warning'); `AgentEvent` info
variant gains `level?` reusing the EXISTING four-value vocabulary (never a
fifth); SessionManager's info case threads the level onto the DTO field
that already exists AND persists warning-level banners as
`role: 'info', infoLevel: 'warning'` (parity with reportHookErrors — a
block reason must survive reload); the frozen-contract trio (EVENT_FIELDS
constant + agent-events.json fixture + the source-scrape) moves in the
same commit; the first-ever adaptSystem cases (positive warning block
reason; notice/suggestion collapse; empty content = no event; unknown
subtype = no event).

**Gates (⚡ wire-adjacent):** claude-event-adapter + frozen-contract +
SessionManager info-path suites; typecheck shared, core, server-core; live
case INF-N1. One dispatch.

## R47 · goal-completion-state (f175) · implementation plan (planned 2026-08-06, orchestrator)

**Citations re-verified live 2026-08-06:** `goal.md:129` — "**Yes**: Claude
Code clears the goal and records an achieved entry in the transcript";
`:13` — "The goal clears automatically once the condition is met"; `:28` —
stops when "A model confirms the condition is met".

**Edit list = f175's change array verbatim:** evaluator gains terminal
authority (terminalGoal parameterized by evaluation source, 'manual' at the
two existing sites, 'evaluator' from the settlement yes-branch);
`validTerminalState` accepts evaluator-sourced completion (evidence
required) so the record survives reload; the evaluator prompt keeps "You
have no tools" (pinned) but drops the now-false no-authority sentence;
SessionManager adds ONLY the missing transcript achieved entry (the
existing status guard + canContinue already stop continuation — prove with
a test, add no second guard; the 'goal' domain invalidation already fires
from the persist callback — add no second one); the defect-locking test is
RENAMED and re-cut to the doc outcome (busy-settlement no-call and the
invalid/timeout/empty-evidence downgrades stay byte-identical); a
round-trip case pins reload survival. `complete_suggested` STAYS in every
union for backward parsing — listed so nobody deletes it as dead. The
`/goal` renderer surface is a SEPARATE unit — not bundled here (wire half
already exists end-to-end).

**Gates (⚡):** goal-service suite + the SessionManager continuation/entry
tests; typecheck server-core (+shared/core untouched-but-verify); live
case GOAL-N1. One dispatch.

## R48 · web-search-budget (f236) · implementation plan (planned 2026-08-06, orchestrator)

**Citations re-verified live 2026-08-06:** `env-vars.md:284` — default 200,
"positive whole number with no upper bound. Anything else is ignored …
raised but not turned off", v2.1.212; `tools-reference.md:449-451` —
"counted across the main conversation and every subagent it spawns"; the
over-cap NOTICE contract: "a notice telling Claude to continue with the
information it already gathered, rather than an error that would invite a
retry … if Claude genuinely needs more searches, the notice tells it to
ask you to raise the limit"; "/clear resets the count";
`whats-new/2026-w29.md` — the announcement row.

**Edit list = f236's change array, with two orchestrator additions the spec
predates:** (1) **/clear reset** (tools-reference.md:451, and R36 landed
/clear after the spec was cut): the subprocess budget resets where Pi
handles the clear signal (the SessionEnd('clear')/session-start latch path
R36 noted), pinned by a test. (2) Audit/report regeneration deferred to
wave close-out per convention (the spec's last item over-applies).
Otherwise verbatim: new `web-search-budget.ts` (default 200, env
`NESSY_MAX_WEB_SEARCHES_PER_SESSION`, strict positive-whole-number parse —
the subagent-depth module's discipline; `createWebSearchBudget` with
tryConsume/remaining/reset); `createSearchTool` gains an optional budget
and returns the NOTICE (never isError — an error invites the retry the
page forbids) BEFORE the provider call; pi-agent-server owns ONE
module-scope budget (buildSessionDefinition runs twice — a closure counter
would reset on a cwd switch); the cross-tree half rides `InitMessage` as
optional `webSearchesUsed?` seed + consumption report-back on the child
result (host-owned per session tree; JSONL-only shape, orchestrator
config untouched); provider failure still consumes (a failing search
cannot loop free); parser table + the two representative tool cases;
fork-subagents.md env-row documentation.

**Gates (⚡ JSONL boundary):** search-tool + child-session-port +
child-session-service + init-contract suites; typecheck shared,
server-core, pi-agent-server; live case WSB-N1. One dispatch.

## R32 · f224 MessageDisplay · implementation plan (planned 2026-08-04)

The other three findings of R32 landed in `40b2ba76`. This is the remainder.

**Doc contract, re-verified by the orchestrator with `curl -sL`, whole lines read:**
- `whats-new/2026-w22.md:108` — "New `MessageDisplay` hook event lets hooks transform or hide assistant message text as it is displayed"
- `hooks.md:876` — "`displayContent` replaces the displayed text on screen. Display-only: the transcript and what Claude sees keep the original"
- `hooks.md:1273` — "MessageDisplay is display-only: the replacement text changes only what is rendered on screen. The transcript and what Claude sees keep the original text, so Claude never sees the replacement, and verbose mode shows the original. **The hook receives assistant message text only, so tool results and the text you type render unchanged.**"
- `hooks.md:1311` — "`displayContent` | Text displayed in place of the delta. **Omit it to display the original**"
- `hooks.md:740` — "`MessageDisplay` | No | The original text is displayed"
- `hooks.md:270` — MessageDisplay "don't support matchers and always fire on every occurrence. If you add a `matcher` field to these events, it is silently ignored."
- `hooks.md:345` — "`MessageDisplay` lowers it to 10" (seconds)

**Two citations the spec did not carry, both load-bearing — added by the orchestrator:**
`:740` is the fail-open row: on hook failure the ORIGINAL text displays, so absent
override must always mean original, at every layer. `:1273`'s last clause scopes the
event to assistant message text — tool results and the user's own text are out.

**Planner decisions:**
1. **Absent means original, at every layer.** `displayDelta ?? delta` and
   `displayText ?? text`. This makes the documented fail-open (`:740`) the natural
   behaviour of an omitted field rather than a branch someone has to remember, and it
   makes an old client that ignores the new fields fail in the documented direction.
   Note the cost honestly in the field comment: a client that ignores `displayDelta`
   shows the UNREDACTED text, so for a redaction hook the point fails silently. That
   is the doc's own posture, not ours to improve here.
2. **The transcript is the original, unconditionally.** The persisted entry and what
   the model sees never carry the override. Today one field is both the rendered text
   and the persisted entry (`dto.ts:344-345`), which is exactly why the companion
   pair is the prerequisite and not an optimisation.
3. **Scope the emitter to assistant text.** Per `:1273`, tool results and user text
   are untouched. Do not hang this off a generic text channel that also carries them.
4. **No matcher, no decision control.** `MATCHERLESS_AGENT_EVENTS` and
   `decisionValues: NO_VALUES`. A matcher on it is silently ignored — that is the
   documented behaviour, not a bug to report.
5. **10 s timeout for imported hooks**, beside the existing `UserPromptSubmit`
   lowering, not a new mechanism.

⚡ Wire AND persistence boundary — both risk triggers. Expanded boundary check once
on the final diff, and the persistence assertion is explicit: a session whose
messages were written with an override in flight must reload showing the ORIGINAL.

## R49 · host-diagnostics-rpc (f208 f210) · implementation plan (planned 2026-08-07, orchestrator)

**Doc contract, re-verified live 2026-08-07 (line numbers current that day):**

- `troubleshoot-install.md:692` — "Claude Code accepts only a file named
  `bash.exe`, `sh.exe`, `bash`, or `sh`; with any other name, such as Git for
  Windows' `git-bash.exe` launcher, it ignores the variable and auto-detects Git
  Bash as if it were unset, logging a warning visible with `--debug`."
- `troubleshooting.md:39` — "run `/heapdump` to write two files to `~/Desktop`:
  a JavaScript heap snapshot named `<session-id>.heapsnapshot` and a memory
  breakdown named `<session-id>-diagnostics.json`. The command doesn't appear in
  the command menu; type it in full. On Linux without a Desktop folder, the
  files are written to your home directory."
- `troubleshooting.md:41-43` — the `.heapsnapshot` "contains every string in the
  process, including your full conversation and credentials. Don't attach it to
  a public issue or share it."
- `troubleshooting.md:45` — "The command also prints a summary in the
  conversation, showing resident set size, JS heap, array buffers, and
  unaccounted native memory, plus any leak indicators it detected … The summary
  says whether most memory is in the JS heap, which the snapshot captures, or in
  native memory, which it doesn't."
- `troubleshooting.md:49` — report guidance: "attach only the
  `-diagnostics.json` file, which carries the statistics behind the printed
  summary and no conversation content or credentials".

**Two spec corrections against the LIVE page (f210 was written against an older
revision):**

1. **No command-menu entry.** The page now says the command "doesn't appear in
   the command menu; type it in full" — f210's slash-command-menu.tsx /
   featureCommands / TRANSLATED_COMMAND_IDS changes are DROPPED, they would
   build the opposite of the contract. `/heapdump` joins `parseSessionCommand`
   (the one typed-command classifier, R36) instead.
2. **File base name is the session id** — `<session-id>.heapsnapshot`, not the
   spec's invented `nessy-<role>-<pid>-<ISO>` shape.

**f208 — git-bash filename enum (small, exactly as spec'd):**

1. `packages/server-core/src/services/git-bash.ts` — `isGitBashExecutablePath`
   becomes a basename-in-enum test over `bash.exe/sh.exe/bash/sh`,
   case-insensitive, splitting BOTH separators by hand (`split(/[\\/]/)` — not
   `path.basename`, which won't split `\` on POSIX and the cross-platform tests
   rely on that). `validateGitBashPath`'s error copy: "Path must point to
   bash.exe, sh.exe, bash, or sh". The `stat`/`isFile` block stays.
2. Both Browse dialogs (`packages/server-core/src/handlers/rpc/system.ts` and
   the electron copy `apps/electron/src/main/handlers/system.ts` — the latter
   imports the validator from server-core but carries its OWN dialog block):
   keep the `exe` filter, add `{ name: 'All files', extensions: ['*'] }` so the
   extension-less `bash`/`sh` are selectable; title "Select bash.exe" → name the
   shell, not one filename. `commonPaths` probes stay as-is (our own
   auto-detect, not the variable's contract).
3. `apps/electron/src/main/__tests__/git-bash.test.ts` — table gains
   `sh.exe`/`bash`/`sh` accepted, case-variant `SH.EXE`, and rejected
   `git-bash.exe`; error-string assertion updated.
4. i18n `onboarding.gitBash.customPath` copy (en+ru) reworded generically;
   parity/sorted stay green.

**f210 — `/heapdump` (corrected shape):**

1. **Writer lives in `packages/shared/src/diagnostics/heapdump.ts`** (NEW; spec
   said server-core, but the Pi subprocess needs the same writer and
   pi-agent-server cannot import server-core). `writeHeapdump({ baseName })`:
   dir = `join(homedir(), 'Desktop')` if it exists else `homedir()` (returns
   which); files `<baseName>.heapsnapshot` via `node:v8` `writeHeapSnapshot` —
   FEATURE-DETECT it (`typeof v8.writeHeapSnapshot === 'function'`) and return
   an error row when absent (Bun may not implement it; the desktop host's
   Electron Node does) — and `<baseName>-diagnostics.json` from
   `process.memoryUsage()`: rss, heapUsed, heapTotal, external, arrayBuffers,
   derived `unaccountedNative = max(0, rss − heapTotal − external)`, plus
   `process.getActiveResourcesInfo()` count when available, uptime, versions,
   appVersion. Unit tests exercise dir-resolution/naming/JSON content with an
   injected snapshot writer; one integration case attempts a real snapshot only
   when the runtime has the function.
2. `packages/shared/src/slash-commands/session-command.ts` — new
   `{ kind: 'heapdump' }`, whole-message `/heapdump`, no argument (like
   `/clear`; `/heapdump now` is prose).
3. Renderer: `typedOutOfBandCommandSubmission` (slash-command-actions.ts) gains
   the `heapdump` kind; `FreeFormInput` routes it to
   `window.electronAPI.sessionCommand(sessionId, { type: 'heapdump' })` and
   clears the input, exactly the `/btw` idiom. NO new UI: the printed summary
   arrives as a persisted transcript message (below). On `{success: false}`
   surface the error the same way the btw path does.
4. Wire: `SessionCommand` union (where the R36 kinds live) gains
   `{ type: 'heapdump' }`; `handlers/rpc/sessions.ts` case calls
   `sessionManager.heapdump(sessionId, workspaceId)`. NO new RPC channel, no
   ipc-channels regen — it rides `sessionCommand`. (f210's `server:heapdump`
   channel + REMOTE_ELIGIBLE row + CLI subcommand are DROPPED — the doc binds
   the in-conversation command only; recorded as narrowing.)
5. `SessionManager.heapdump()` — deliberately NO `isProcessing` gate (a dump
   must work on a wedged session; that is the feature's point). Host dump with
   `baseName = sessionId`; when the Pi subprocess is alive, also request its own
   dump (`baseName = <sessionId>-pi` — our multi-process extension, recorded);
   then persist ONE summary message via the `runShellCommand` idiom
   (`managed.messages.push` → `persistSession` → `flushSession` → `user_message`
   event), role `user`, badge `{ type: 'command', label: '/heapdump' … }`,
   content = the four documented numbers, the heap-vs-native verdict, the file
   paths, and the "share only the `-diagnostics.json` file" line
   (`troubleshooting.md:41,49`). Summary text is host-composed English like the
   shell transcript — no i18n keys.
6. `SessionManager.sendMessage` guard — `/heapdump` joins the btw/recap refusal
   (backstop so it can never become a model turn).
7. Pi round-trip, modelled on `get_context_usage`:
   `InboundMessage |= { type: 'heapdump'; id: string }`, `handleHeapdump` with
   NO `ensureSession()` dependency, reply
   `{ type: 'heapdump_result', id, success, wroteTo?, snapshotPath?,
   diagnosticsPath?, memory?, errorMessage? }`; pi-agent.ts `requestHeapdump()`
   mirrors `getContextUsage`'s pending-map + timeout and tolerates an old
   subprocess bundle (timeout → error row in the summary, not a failed command).
8. `packages/session-tools-core` slash-command allowlist: UNCHANGED on purpose —
   the model must never trigger a dump that writes every credential in the
   process to disk (`troubleshooting.md:41`).

**Recorded narrowings:** leak "growth rate" indicator absent (we keep no memory
history — summary reports the four documented numbers, handle count, and the
heap-vs-native verdict); electron RENDERER process not dumped (doc targets the
one-process CLI; our host = the session-owning process, Pi = its own pair); no
CLI `heapdump` subcommand; CLI chat typing `/heapdump` gets the guard's refusal
text naming the session command.

⚡ Wire boundary (SessionCommand union + InboundMessage variant): expanded check
once on the final diff — adjacent-backend frozen-contract + session-command seam
+ init/inbound contract tests, three typechecks.

## R51 · sandbox-path-settings (f022 f023) · implementation plan (planned 2026-08-07, orchestrator)

**Doc contract, re-verified live 2026-08-07 (`settings.md`):**

- `:413-418` — the four path keys are NESTED under `sandbox.filesystem`:
  `filesystem.allowWrite` ("Additional paths where sandboxed commands can
  write. Arrays are merged across all settings scopes: user, project, and
  managed paths are combined, not replaced. Also merged with paths from
  `Edit(...)` allow permission rules"), `filesystem.denyWrite`,
  `filesystem.denyRead`, `filesystem.allowRead`, plus
  `filesystem.allowManagedReadPathsOnly` (:417) and `filesystem.disabled`
  (:418) which we already accept nested.
- `:446` — the prefix rule governs "`filesystem.allowWrite`,
  `filesystem.denyWrite`, `filesystem.denyRead`, `filesystem.allowRead`, and
  `credentials.files`".
- `:450-452` — the three prefixes: `/` "Absolute path from filesystem root"
  (`/tmp/build` stays `/tmp/build`); `~/` "Relative to home directory" (`~/.kube`
  becomes `$HOME/.kube`); "`./` or no prefix" — "Relative to the project root
  for project settings, or to `~/.claude` for user settings" (`./output` in
  `.claude/settings.json` resolves to `<project-root>/output`).
- `:454` — "The older `//path` prefix for absolute paths still works."
- `:456` — "This syntax differs from Read and Edit permission rules, which use
  `//path` for absolute and `/path` for project-relative."

**Code side re-verified on HEAD:** `sandbox-settings.ts:174-183` — the deny/allow
WRITE-and-READ roots are flat (`deniedReadRoots`, `deniedWriteRoots`,
`additionalWritableRoots`) while only `disabled`, `allowRead` and
`allowManagedReadPathsOnly` live under `filesystem`. So the doc's own example
document (`settings.md:466-467`) does not parse into the fields it names.
Prefix expansion is absent: `~/` and bare/`./` entries throw rather than
resolve.

**Plan:**

1. `packages/shared/src/config/sandbox-settings.ts` — accept the documented
   NESTED spelling as canonical, keep the flat names as ALIASES (do not remove:
   `foldSandboxRuleRoots` and `pi-agent.ts` produce the flat shape internally and
   on-disk configs already carry it). Two spellings CONCAT-DEDUPE — neither
   replaces the other, which is what ":413 Arrays are merged … combined, not
   replaced" means when both spellings appear in one document.
2. Prefix expansion in `filesystemRoots`, EXPANDING before validating, with a
   `scope?: { home?: string; root?: string }`: `~`/`~/x` → `join(home, x)`;
   `//x` → absolute (kept, `:454`); `/x` → `resolve(x)` absolute (`:456` — NOT
   project-relative, and that difference from permission rules is the trap this
   unit exists to avoid); `./x` and bare `x` → `join(scope.root, x)` when a root
   is known, else dropped through the existing `sink` with a named reason.
3. Scope roots: `getUserSandboxSettings` (storage.ts:~1293) passes
   `{ root: CONFIG_DIR }` — the doc anchors user-settings bare paths at
   `~/.claude`, ours is the Nessy config dir. `parseManagedPiPolicyV1`'s sandbox
   branch (managed-policy.ts:~1358) passes home only, NO root: a delivered
   managed policy has no file on this machine to anchor to, the same posture
   `sandbox-permission-rules.ts:80-84` already takes for source-anchored rules.
4. Tests: the doc's `settings.md:460-478` stanza parses at both tiers with
   `filesystem.allowWrite` landing in `additionalWritableRoots` and
   `filesystem.denyRead` in `deniedReadRoots`; both spellings in one document
   concat-dedupe; a `~/` entry expands; a bare entry expands under a scope root
   and is DROPPED with a reason without one; `['/']` still throws `too-broad`.
   `collectRejectedUserSettingsLayers()` returns nothing for the doc's stanza
   (today: one row for `sandbox`) while a genuinely unknown nested key still
   rejects the layer whole — the tier's strictness must not widen by accident.
5. Docs-site `reference/config/config-file.md` sandbox row (EN + RU) leads with
   the nested spelling, names the flat forms as accepted aliases, adds the
   prefix table.

⚡ Settings-parse + sandbox boundary. A widened-strictness regression is the risk
this unit's negative test exists to catch; run the strict-report suite whole.

## R58 · tool-result-size-thresholds (f038) · implementation plan (planned 2026-08-07, orchestrator)

**Doc contract, re-verified live 2026-08-07:**

- `agent-sdk/mcp.md:894` — "When a tool result is larger than 25,000 tokens, the
  full output is saved to a file and the tool result is replaced with an error
  message that names the file path … Raise the limit with the
  `MAX_MCP_OUTPUT_TOKENS` environment variable."
- `mcp.md:1040` — "the default maximum is 25,000 tokens"; `:1039` the env var
  adjusts it.
- `mcp.md:1041` — "the environment variable applies to tools that don't declare
  their own limit. Tools that set `anthropic/maxResultSizeChars` use that value
  **instead** for text content, regardless of what `MAX_MCP_OUTPUT_TOKENS` is set
  to. Tools that return image data are still subject to
  `MAX_MCP_OUTPUT_TOKENS`."
- `mcp.md:1058` — the annotation raises "up to a hard ceiling of 500,000
  characters" (we already have this ceiling).
- `mcp.md:246` — "Claude Code displays a warning when MCP tool output exceeds
  10,000 tokens and limits output to 25,000 tokens by default … the warning
  threshold is fixed."

**Code side re-verified on HEAD:** `large-response.ts:42` `TOKEN_LIMIT = 12000`
governs everything; `tokenLimitFor(contextWindow)` lowers it further to
`min(12000, 10% of window)` with a 2 000 floor; `grep -a` for `10000`/`10_000` in
`mcp-pool.ts` finds nothing — the warning threshold does not exist here.

**Plan:**

1. NEW `packages/shared/src/config/mcp-output-settings.ts` —
   `MCP_OUTPUT_TOKEN_LIMIT_DEFAULT = 25_000`, `MCP_OUTPUT_WARN_TOKENS = 10_000`
   (fixed, `:246` — no env), and `mcpOutputTokenLimit(env)` reading
   `NESSY_MCP_OUTPUT_TOKENS` with `MAX_MCP_OUTPUT_TOKENS` as the documented
   compat alias, Nessy name winning — the aliased-pair discipline of
   `subagent-spawn-depth.ts` / `web-search-budget.ts`. Strict `/^\d+$/`, `>= 1`,
   anything else falls back to the default.
2. Make the threshold INJECTABLE rather than raising the global: `TOKEN_LIMIT`
   stays 12 000 (its 15k→12k lowering carries a recorded reason at
   `large-response.ts:36-40` and it governs Read/Bash/api-tools results, which
   this page does not bind). Add a `tokenLimit` option to `guardLargeResult`
   that, when present, replaces the `tokenLimitFor(contextWindow)` computation
   outright.
3. Three call sites pass it, so the number is the same on every backend:
   `mcp-pool.ts` `callTool` (the site the doc sentence is about),
   `claude-agent.ts`'s `tool_result` guard for `mcp__`-prefixed tools, and
   `local-tools/runtime.ts` `guardResult` for the MCP proxy branch. The two
   second-guard sites must OMIT `contextWindow` — it can only lower the limit
   (`large-response.ts:141-147`), which is how a raise in the pool becomes
   invisible one layer up.
4. `maxResultSizeChars` composes as INSTEAD, not as a raise-only floor
   (`mcp.md:1041`): a declaring tool's value replaces the token limit for TEXT
   content in both directions, still clamped by the 500 000-char ceiling; image
   content stays on the token limit. And the declared allowance must reach the
   second guard, or a result the pool legitimately kept inline is re-persisted
   above it.
5. `MCP_OUTPUT_WARN_TOKENS` — emit the over-10k warning at the pool call site on
   the existing warning channel (find what `mcp-pool` already uses; do NOT
   invent a new event type). Fixed threshold, no env knob.
6. Tests: `large-response.test.ts` gains one positive/negative pair for the
   `tokenLimit` option (≈20k-token text passes at 25 000, persists at the
   default) with the four existing cases untouched; `proxy-tool-names.test.ts`
   P3 gains an inline-at-20k case and an env-moves-the-threshold case (save and
   restore the env var the way `mcp-pool-call-idle-timeout.test.ts:34-39` does);
   one case pins a DECLARED value BELOW the default lowering the threshold.

⚡ Shared wire-adjacent behaviour across three backends: the boundary check is
that the same MCP result lands the same way on the pool path, the Claude path,
and the local-tools path — assert it at all three, not just in the pool.

## R52 · model-selection-defaults (f107 f226 f242) · implementation plan (planned 2026-08-07, orchestrator)

**Doc contract, re-verified live 2026-08-07 (`model-config.md`; the line numbers
below are that day's — the sentences are the contract):**

- `:453` — "The default effort is `high` on every model that supports effort,
  except Opus 4.7, which defaults to `xhigh`."
- `:455` — "When you first run Fable 5, Opus 4.8, or Opus 4.7, Claude Code
  applies that model's default effort even if you previously set a different
  level for another model, and holds it across sessions until you make an
  explicit effort choice, such as running `/effort` in an interactive session or
  launching with `--effort`. Opus 5 has no such hold: a level you previously set
  carries over."
- `:364` — "Configure one or more fallback models and Claude Code tries them in
  order, showing a notice when it switches. The switch lasts for the current
  turn only, so your next message tries the primary model first again. Chains
  are capped at three models after duplicate removal, and extra entries are
  ignored."
- `:366` — "`--fallback-model` flag, which accepts a comma-separated list".
- `:387` — the chain "also covers compaction, but Claude Code won't fall back to
  a model with a smaller context window than the primary's … If every fallback
  is smaller, compaction shows the original error and you can retry."

**Code side re-verified on HEAD:** `thinking-levels.ts:63`
`DEFAULT_THINKING_LEVEL = 'medium'` for every model, and `NARROWED_EFFORT_MODELS`
(:220) is the only model-aware rule — it NARROWS a chosen level and is not a
default. `storage.ts:284-286` coerces `fallbackModel` with
`typeof … === 'string' ? trim() : ''`, so a doc-shaped `["a","b"]` becomes `''`
and DISABLES fallback. `models-pi.ts:20-22` only trims.

**Plan:**

1. **Per-model default effort.** `thinking-levels.ts` gains `MODEL_DEFAULT_EFFORT`
   beside `NARROWED_EFFORT_MODELS` and
   `getModelDefaultThinkingLevel(modelId): ThinkingLevel | undefined`:
   `/claude[-.]opus-4-7/i → 'xhigh'`; Opus 4.8 / Sonnet 5 / Fable 5 / Opus 5 and
   the other effort-capable Claude ids → `'high'`; **anything unmatched →
   `undefined`**, which is the load-bearing case here — every Nessy gateway model
   is unmatched and must keep landing on `DEFAULT_THINKING_LEVEL`. Match bare,
   slash-prefixed and Bedrock-native id forms, the way the sibling table does.
2. **Make the model default REACHABLE.** `config-defaults.json` ships
   `workspaceDefaults.thinkingLevel: "think"` (→ medium), and `syncConfigDefaults`
   overwrites the user copy on every launch, so that tier wins forever and the
   per-model default can never apply. Ship it absent instead. Measured
   consequence, and the reason this is safe: an unmatched model still resolves to
   `DEFAULT_THINKING_LEVEL` = `'medium'`, which is what `"think"` already meant —
   so gateway users see NO change, and only the Claude-runtime models move to
   their documented default.
3. **Split the getter.** `storage.ts` gains
   `getConfiguredDefaultThinkingLevel(): ThinkingLevel | undefined` (user-set
   value only); `getDefaultThinkingLevel()` keeps returning a concrete value for
   existing callers. The precedence chain becomes: explicit option → project
   default → workspace config → user-configured default → **model default** →
   `DEFAULT_THINKING_LEVEL`. In `SessionManager.createSession` the model is not
   known until after the level is first computed, so compute in two steps and
   apply the model default only where nothing above it answered.
4. **The hold (`:455`).** Two persisted facts beside `defaultThinkingLevel`: an
   explicit-choice marker set by EVERY explicit setter (the `/effort`-equivalent
   session setter and the settings writer), and the model id the held default
   came from. A held default re-asserts across sessions until an explicit choice
   clears it. Models with no hold (Opus 5, and every model absent from the hold
   list) carry a previously-set level over. **The hold list and the default table
   are separate lists** — `:455` names three models, `:453` covers all — and
   conflating them is the mistake this note exists to prevent.
5. **Fallback chain.** `normalizePiFallbackModelChain(raw, opts)` in
   `models-pi.ts`: accept `string` (split on commas) or `string[]`, trim, drop
   empties, dedupe preserving first occurrence, then cap at three — in that
   order, because `:364` says "capped at three models AFTER duplicate removal".
   `storage.ts` stores the normalized `string[]`; the legacy scalar keeps parsing
   forever (`""` is on disk in every install); `config-defaults-schema.ts` and
   `validators.ts` widen to `string | string[]`.
   **Import direction is a trap:** `models-pi.ts` pulls
   `@earendil-works/pi-ai/compat` and its header forbids renderer-reachable
   imports, while `storage.ts` IS renderer-reachable. Put the pure normalizer
   where `storage.ts` may import it (a sibling module with no pi-ai import) and
   keep the pi-aware wrapper in `models-pi.ts`.
6. **Walk the chain.** In `pi-agent.ts`, `PiChatOptions.fallbackModelRetry?:
   boolean` becomes `fallbackChainIndex?: number`; `getFallbackModel()` returns
   `string[]`; `getRetryFallbackModel` picks the entry at the cursor and returns
   nothing past the end; each hop emits its own switch notice. **The switch is
   turn-scoped** (`:364`): restore the primary when the turn ends, so the next
   message tries the primary first — today it sticks, and an existing test
   asserts the sticking, so that assertion inverts.
7. **`--fallback-model a,b,c`** in `apps/cli`, taking precedence over the
   setting, applying to interactive runs too.
8. **Deferred, and recorded rather than silent:** `:387`'s compaction rule (never
   fall back to a smaller context window; show the original error if every
   fallback is smaller). `handleCompactResult` currently just rejects. Record it
   as an open row in the tracker note — do NOT leave it looking done.

⚡ Persistence boundary (two new config facts) + a behavioural default change:
the expanded check is that an existing config with a scalar `fallbackModel` and
a previously-set effort level loads unchanged, and that a gateway-model session's
effort is identical before and after.

## R54 · hook-input-payload-parity (f002 f003 f004 f007 f009 f218) · implementation plan (planned 2026-08-07, orchestrator)

**Doc contract, quoted from `curl -sL https://code.claude.com/docs/en/hooks.md`
on 2026-08-07.** This unit is where the "quote the raw page, never a summary"
rule earns its keep: R24 shipped three wrong hook field names from a paraphrase.
Every name below was read off the fetched Markdown, and the executor must
re-read the WHOLE line — several of these tables put the load-bearing clause in
the second sentence.

- `:2636` — "In addition to the common input fields, FileChanged hooks receive
  `file_path` and `event`." `file_path` is "Absolute path to the file that
  changed"; `event` is `"change"` / `"add"` / `"unlink"`.
- `:2562` — "In addition to the common input fields, CwdChanged hooks receive
  `old_cwd` and `new_cwd`." The page's own example carries `cwd` AND `new_cwd`
  with the SAME value, and `old_cwd` with the directory left behind.
- `:2414` — "StopFailure hooks receive `error`, optional `error_details`, and
  optional `last_assistant_message`. The `error` field identifies the error type
  and is used for matcher filtering." `error` ∈ {`rate_limit`, `overloaded`,
  `authentication_failed`, `oauth_org_not_allowed`, `billing_error`,
  `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`,
  `unknown`}. And the second sentence of the `last_assistant_message` row is the
  trap: "Unlike `Stop` and `SubagentStop` … for `StopFailure` it contains the API
  error string itself, such as `\"API Error: Rate limit reached\"`."
- `:2784` — "PreCompact hooks receive `trigger` and `custom_instructions`. For
  `manual`, `custom_instructions` contains what the user passes into `/compact`.
  For `auto`, `custom_instructions` is empty."
- `:2810` — "PostCompact hooks receive `trigger` and `compact_summary`. The
  `compact_summary` field contains the conversation summary generated by the
  compact operation."
- `:707` (common input fields table) — `effort` is "Object with a `level` field
  holding the active effort level for the turn: `"low"`, `"medium"`, `"high"`,
  `"xhigh"`, or `"max"`. If the requested model effort exceeds what the current
  model supports, this is the downgraded level the model actually used. Ultracode
  is not a distinct level and reports as `"xhigh"`. … Present for events that fire
  within a tool-use context, such as `PreToolUse`, `PostToolUse`, `Stop`, and
  `SubagentStop`, when the current model supports the effort parameter. The level
  is also available to hook commands and the Bash tool as the `$CLAUDE_EFFORT`
  environment variable."

**Code side re-verified on HEAD** (`lifecycle-bridge.ts`, and the frozen
expectations in its test at :99-100): we emit `{hook_event_name:'CwdChanged',
cwd}` with no `old_cwd`/`new_cwd`; `{hook_event_name:'FileChanged', change_kind,
path}` — both keys differently named and `path` not guaranteed absolute;
PreCompact carries `trigger` and `source` but no `custom_instructions`;
PostCompact no `compact_summary`; StopFailure carries `error_code` holding the
UNPROJECTED Nessy `ErrorCode` (`rate_limited`, `service_error`,
`invalid_model`), which is a different vocabulary from the doc's `error`, not a
rename. `effort` exists nowhere in the hooks subsystem.

**Plan:**

1. **Add, don't rename, where a name is already load-bearing.** `CwdChanged`
   gains `old_cwd` and `new_cwd` alongside the existing `cwd` — the page's own
   example proves `cwd` and `new_cwd` coexist, so this is additive and no
   existing consumer breaks. `FileChanged` gains `file_path` (absolute — run it
   through `resolve()`, the doc says absolute and our value is not guaranteed to
   be) and `event` mapped from `change_kind`. Keep `path`/`change_kind` as
   emitted aliases and say why in a comment: they are on the frozen contract and
   in `redactedPayload`.
2. **`redactedPayload` must grow with the payload.** Every new key that can
   carry a path or user text goes into the contract row's `redactedPayload` in
   `packages/shared/src/automations/types.ts`, or the redaction that protects
   `path` today silently stops covering `file_path`. This is the security half
   of the unit; treat a missed key as a defect, not a nit.
3. **StopFailure `error` is a PROJECTION, not an alias.** Add a mapping from our
   `ErrorCode` vocabulary to the doc's ten values, with `unknown` as the
   documented fallback for anything unmapped — and keep `error_code` emitted
   beside it. Then `error_details` and `last_assistant_message`, the latter
   holding the RENDERED API error string for this event specifically. Matcher
   filtering already conforms; do not touch it.
4. **PreCompact/PostCompact** gain `custom_instructions` (the `/compact`
   argument; empty string for `auto` — empty, not absent, per `:2784`) and
   `compact_summary` (the generated summary). Find where the compact result
   already holds the summary rather than recomputing it.
5. **`effort` is three absences behind one sentence** (`f009`): the input field,
   the `$CLAUDE_EFFORT` hook-command env var, and the Bash-tool child env. Do all
   three or record which is deferred. Scope it as the page scopes it: present for
   events firing within a tool-use context, and only when the model supports the
   effort parameter — so it is OPTIONAL on the type, and an absent effort must
   not become `"medium"` by default. Ultracode reports as `xhigh`. The level to
   report is the DOWNGRADED one the model actually used, which
   `clampThinkingLevelToModel` already computes — use that result, not the
   requested level.
6. **Tests:** extend `lifecycle-bridge.test.ts`'s frozen per-event expectations
   (they are exact-match `toEqual`, so every added key must be added there too),
   plus one negative per event family: an unmapped error code projects to
   `unknown`; `auto` compaction yields an EMPTY `custom_instructions` rather than
   omitting it; a model without effort support yields NO `effort` key.

⚡ Wire + payload boundary and a redaction rule: the expanded check is that every
newly added key appears in its contract row's `redactedPayload` where it can
carry a path or user text, asserted directly rather than by inspection.

## R63 · marketplace-auto-update (f025 f046 f047) · implementation plan (planned 2026-08-07, orchestrator)

**Doc contract, quoted from pages fetched 2026-08-07. The spec cited
`settings.md:879`; the sentence now sits at ~`:886` — the page grew, the sentence
did not change.**

- `settings.md` § `extraKnownMarketplaces` — "Each marketplace entry also accepts
  an optional `autoUpdate` Boolean. Set `\"autoUpdate\": true` alongside `source`
  to make Claude Code refresh that marketplace and update its installed plugins
  in the background after startup. When omitted, official Anthropic marketplaces
  default to `true` and all other marketplaces default to `false`."
- `plugins/loading.md#when-auto-update-runs (was line 445 of the retired discover-plugins page)` — "Claude Code checks for marketplace and plugin
  updates after your session starts, with a random delay of up to ten minutes, so
  the running session keeps using the versions it loaded at launch. If any
  plugins were updated, you'll see a notification prompting you to run
  `/reload-plugins`, or the new versions load on your next launch."
- `plugins/loading.md#which-marketplaces-and-plugins-auto-update (was line 454 of the retired discover-plugins page)` — "Official Anthropic marketplaces have auto-update
  enabled by default. Third-party and local development marketplaces have
  auto-update disabled by default."
- `plugins/org.md#turn-auto-update-on-or-off-per-marketplace (was line 456 of the retired discover-plugins page)` — administrators "can also set `\"autoUpdate\": true`
  on each `extraKnownMarketplaces` entry in managed settings … without requiring
  each user to toggle it."
- `plugins/org.md#recommend-plugins (was line 159 of the retired discover-plugins page)` — "When your administrator has allowlisted the
  marketplace via the `pluginSuggestionMarketplaces` managed setting, plugins
  marked as relevant to your current working directory are pinned at the top with
  a **suggested for this directory** label."
- `settings.md:303`, the `pluginSuggestionMarketplaces` row — **read the whole
  row; its second half is the security rule and it is easy to miss.** "No
  marketplace-declared suggestions surface without this allowlist … Suggestions
  come from each plugin's `relevance` declaration in its marketplace entry. **A
  name only takes effect when the marketplace is registered on the machine and
  its registered source is also declared in managed settings**, either as the
  `extraKnownMarketplaces` entry for that name or as an entry of
  `strictKnownMarketplaces`. **A marketplace registered from a different source
  under an allowlisted name is ignored.** The official marketplace is exempt from
  the source requirement, since that name can only register from the official
  Anthropic source."

**Code side re-verified on HEAD:** `managed-marketplace-entries.ts` `deliveredRows`
maps exactly `{name, source, ref}` — `autoUpdate` is dropped silently, with no
parse, no validation and no drop receipt. `pluginSuggestionMarketplaces` and
`relevance` do not exist anywhere (`grep -a`, both spellings).

**Plan, in three stages that can each stand alone if the unit has to stop early:**

1. **Carry the flag.** `deliveredRows` gains `autoUpdate`, validated as a Boolean
   with a DROP RECEIPT on a non-Boolean rather than a silent ignore (this file's
   established posture). Persist it on the registry row
   (`marketplace/registry-source.ts`, `plugins/store.ts`) and expose it on the
   wire. Resolution order: managed value wins; otherwise the user's own toggle;
   otherwise the documented polarity — **official Anthropic marketplaces default
   true, everything else false**. Our fork has no official-Anthropic marketplace,
   so in practice every default is `false`; implement the polarity anyway and say
   so, because the alternative is a hidden `true` the day one is added.
2. **Run it.** A post-startup check with a **random delay of up to ten minutes**
   — the delay is the contract, not an implementation detail: it exists so the
   running session keeps the versions it loaded. Refresh only marketplaces whose
   flag is on; on any update, surface the "run `/reload-plugins`" notification
   rather than hot-swapping into the live session. Respect `DISABLE_AUTOUPDATER`,
   and `FORCE_AUTOUPDATE_PLUGINS=1` as its documented escape hatch. A UI toggle
   per marketplace, mirroring `/plugin` → Marketplaces → Enable/Disable
   auto-update.
3. **Suggestions (f047), and its security rule.** `pluginSuggestionMarketplaces`
   becomes a managed-only key; plugin entries gain `relevance`; the Discover tab
   pins matches with a "suggested for this directory" label. **The allowlist is
   by NAME, and a name alone is not enough:** the registered source must ALSO be
   declared in managed settings for that name, or the entry is ignored. That
   clause is the anti-squatting rule — without it, anyone who can register a
   marketplace under an allowlisted name gets their plugins pinned in front of
   the user by an administrator's own setting. Implement the source check with
   the official-marketplace exemption, and give it its own negative test:
   allowlisted name + different source ⇒ NO suggestion.

**Sequencing:** stage 3 is separable and may land as its own commit if stages 1-2
grow past one reviewable diff. Stages 1-2 must land together — a persisted flag
nothing acts on is worse than no flag.

⚡ Managed-policy + wire + persistence boundary, and a background scheduler.
Expanded check once on the final diff: a managed policy written the documented
way parses, an unknown-typed `autoUpdate` produces a receipt rather than silence,
and the suggestion allowlist refuses a name whose source does not match.

## R55 · memory-import-recognition (f099 f100 f101) · implementation plan (planned 2026-08-07, orchestrator)

**A pre-flight pass re-verified both sides before this was written, and its
challenger overturned the framing. Read this section, not the specs, for what
the unit is.**

**The finding the specs do not state: `@path` imports do nothing on the shipping
route.** Verified on HEAD by the orchestrator:

- `readMemoryFileWithImports` — the only function that expands an import — is
  reachable ONLY through `loadMemoryPromptBlock`, whose one production caller is
  `prompts/system.ts:461-463`, gated on `capabilityContextPinned ? '' : …`. Both
  backends pass `capabilityTurnRuntime !== null` for that flag, which is true on
  every normal turn. The existing test at
  `storage-runtime-fork-memory.test.ts:11` says so in its own words. **So the
  expander is dead in production, and both flagship spec change entries edit it.**
- What actually ships are two OTHER deliveries, and they disagree with each
  other: `BaseAgent.composePinnedCapabilityContext` (base-agent.ts:1026-1029)
  DELETES every line `parseMemoryImportPath` recognises, and
  `materializePiContextResources` (context-resource.ts:64-79) ships the body raw,
  so Pi's curated resource still carries the literal `@path` text. Neither
  expands anything.

So the user-visible truth today is: an `@path` line in a CLAUDE.md is silently
dropped from the model's pinned block and silently kept as prose in Pi's context.
Fixing the recognition rule inside the dead expander — which is what the specs
describe — would ship no observable change at all.

**Doc contract, verbatim from `curl -sL https://code.claude.com/docs/en/memory.md`
(2026-08-07):**

- `:95` — "CLAUDE.md files can import additional files using `@path/to/import`
  syntax. Imported files are expanded and loaded into context at launch alongside
  the CLAUDE.md that references them."
- `:97` — "Both relative and absolute paths are allowed. Relative paths resolve
  relative to the file containing the import, not the working directory. Imported
  files can recursively import other files, with a maximum depth of four hops."
- `:99` — "Import parsing skips Markdown code spans and fenced code blocks. To
  mention a path in your CLAUDE.md without importing it, wrap it in backticks:
  writing `` `@README` `` keeps the text literal, while `@README` outside
  backticks imports the file."
- `:101` and the fenced example at `:104` — imports are recognised "anywhere in
  your CLAUDE.md", including mid-sentence: "See @README for project overview and
  @package.json for available npm commands for this project." `:107` and `:116`
  show them after list markers.

**Plan:**

1. **One scanner, and it is stateful.** The specs conflict here — f099 says
   delete `parseMemoryImportPath` and its extension heuristic for a mid-line
   token scanner, f100 says keep it and add a separate fence scanner. Two
   recognisers with different rules is exactly the trap f100's own text warns
   about, so build ONE document scanner that walks the file tracking fenced-block
   and code-span state and yields import tokens with their positions. Line-start
   anchoring goes away (`:101`), the extension heuristic goes away (`@README`
   with no extension is an import per `:104`), and backticked text is skipped
   (`:99`). `parseMemoryImportPath`'s per-line signature cannot express fence
   state — that is why it must be replaced rather than patched.
2. **Wire it into the two LIVE deliveries, and make them agree.** The pinned
   block must EXPAND rather than strip, and the Pi context resource must expand
   the same body the host expands. R33's comment at context-resource.ts:68-74
   already states the invariant — capping one site and not the other "would ship
   two different bodies for one file"; the same now goes for expansion. An
   executor who edits only `base-agent.ts` reproduces exactly the bug R33 fixed.
3. **Keep the depth at the documented four hops.** `MEMORY_IMPORT_DEPTH_LIMIT`
   is 5 (memory-store.ts:27) against the page's "maximum depth of four hops".
   Fix the number and pin it with a test that actually nests five deep.
4. **Order against the caps.** `capMemoryIndexLoad` is applied BEFORE expansion
   today (memory-store.ts:206, base-agent.ts:1017-1019) and the existing comment
   says the budget is measured against the file as written. Preserve that order
   and say so — measuring after expansion would let an import silently blow the
   200-line / 25 KB budget.
5. **Leave the dead expander alone or delete it deliberately.** Do not "fix" it
   in place and call the unit done. If it stays, it must stay consistent with the
   new scanner; if it goes, `loadMemoryPromptBlock`'s fallback route goes with it
   and that is a separate decision — record which was chosen.

**Do NOT touch** `packages/server-core/src/sessions/SessionManager.ts`: it is a
reader here only, and it serializes the wave.

**Tests:** `memory-index-load-limits.test.ts` (R33, 210 lines) asserts cap
behaviour through BOTH live seams and will fail if only one is changed — treat it
as the invariant, not as an obstacle. Add: an import mid-sentence resolves; a
backticked `` `@README` `` does not; an `@target.md` inside a fenced block does
not; a five-deep chain stops at four; a relative path resolves against the
importing FILE and not the cwd.

⚡ Both live context deliveries: the expanded check is that the host's pinned
block and Pi's curated resource carry the SAME body for one file.

## R56 · memory-write-feedback (f102 f103 f166) · implementation plan (planned 2026-08-07, orchestrator)

**Pre-flight verified both sides. The doc content is intact; the specs are stale
in four ways that would cost real work.**

**Doc contract (fetched 2026-08-07):**

- `memory.md:386` — "After Claude writes to `MEMORY.md`, Claude Code measures the
  file against the 200-line and 25KB read limits. If the file is near a limit,
  Claude Code reminds Claude to shorten it … If the file is over a limit, the
  write still succeeds, but Claude Code returns an error telling Claude to
  rewrite the index, because everything past the limit is dropped on the next
  load."
- `memory.md:398` — "When Claude writes a memory file that begins with YAML
  frontmatter, Claude Code records the write time in a `modified` frontmatter
  field as an ISO 8601 timestamp." Read the whole line: "Any file that has
  frontmatter gets the field the next time Claude writes it … **Claude Code never
  adds frontmatter to a file that has none.**"
- `errors.md` § "Memory index is over its read limit" — now at **:1522-1539**,
  not the spec's `:1435-1452` (the page grew ~87 lines; the old range is a
  different section now). The literal error text at `:1527` survives verbatim.

**Four spec corrections, each of which would otherwise waste or damage work:**

1. **Do NOT byte-cap `readMemoryFile`.** Two specs say to. `memory-store.ts:45-55`
   records the opposite as a decision: it is line-only ON PURPOSE, because the
   `@import` discovery scan (`native-sources.ts:442-457`) and the rule-file
   reader depend on it — a byte cut there changes which files become capability
   RECORDS, and with them the snapshot generation, the Sources list and the
   InstructionsLoaded set. Build the measurement on `capMemoryIndexLoad`
   (`memory-store.ts:106-126`), whose own docblock already reserves this exact
   finding so the load cap and the write check cannot count different bytes.
2. **f166's change[2] is already done.** `base-agent.ts:1017-1019` caps each
   memory layer, gated by `isMemoryIndexLayer` so rule files and imported topic
   layers stay exempt, and `context-resource.ts:75-76` mirrors it. Re-doing it
   risks regressing those exemptions.
3. **The package boundary decides where the helpers live, and only one direction
   is legal.** `packages/session-tools-core` has NO dependency on
   `@nessy-agent/shared`; `shared` depends on `session-tools-core`. So f103's
   "import `measureMemoryIndex` from shared into `remember.ts`" is unbuildable.
   Put stamp + measure + message builders in ONE home inside
   `session-tools-core` and let `shared` import them — do not duplicate the
   thresholds a third time.
4. **f166's change[6] names a test file that already exists** at
   `packages/session-tools-core/src/handlers/remember.test.ts` (not under
   `__tests__/`). Extend it; creating the proposed path forks the suite.

**And one contradiction to settle before writing code:** f103 wants an over-limit
write to return an error response, f166 wants a different result shape. Pick one
— `memory.md:386` says the write SUCCEEDS and an error is returned to the model,
so the write must not be rolled back and the error is advisory to the caller.

**Prompt-cache risk, and it is the real one.** There is no frontmatter strip on
the load path, so a `modified:` line that changes on every write becomes a
changing line inside the pinned `<memory>` block — which invalidates the cached
prefix and everything after it on every memory write. Either strip frontmatter
before the body enters the pinned block, or do not stamp. Decide deliberately and
record it; shipping the stamp without the strip is a per-write cache flush.

**Sequencing: R56 must land AFTER R55** — both edit `memory-store.ts` and its
test, and `git commit <pathspec>` takes working-tree state, so concurrent
executors in one file cross.

## R57 · mcp-roots-and-channels (f040 f134 f135 f136) · implementation plan (planned 2026-08-07, orchestrator)

**Pre-flight verified all four premises HOLD. One change entry would ship a
security hole while looking like it closed one — that is the reason to read this
section before the specs.**

**f136's change[3] is FALSE on HEAD.** It says to defang a channel body with
`neutralizeHarnessMarkers` "so a literal `</channel>` inside an event cannot
close the fence and forge trusted structure after it". But
`untrusted-text.ts:41` is `HARNESS_TAG =
/<(\/?)(untrusted|system-reminder|nessy_agent_environment)\b/gi` — a CLOSED
three-name list that does not contain `channel`. So the helper passes
`</channel>` through untouched, and an implementer following the entry ships a
**forgeable fence** believing it is defanged.

**And the obvious fix is worse.** Adding `channel` to `HARNESS_TAG` changes
behaviour at 22+ production call sites across shared, server-core and
pi-agent-server (every `scanSubagentOutput` in the orchestrator tools) — and it
destroys f136's own wrapper the moment f134 lands, because f134 routes channel
events through `buildTaskNotificationDelivery`
(`server-core/src/sessions/task-notification.ts:54`), which runs
`neutralizeHarnessMarkers` over every queued event and would neutralise the very
element f136 is trying to emit.

**The correct shape:** a channel-LOCAL escape inside the new
`formatChannelEvent`, applied to the body before the wrapper is built, leaving
the shared constant untouched. State the ordering explicitly in the code: escape
the body, then wrap, then let the shared neutraliser run over the result without
touching the fence.

**Second decision to make once:** f135 and f136 give OPPOSITE defaults for the
same guard. f135 says `isMcpChannelMessage` may "reject the message (or drop just
`meta` — pick one)"; f136 says a bad `meta` must make the guard reject. One
guard, one commit, one rule — otherwise the second edit silently reverses the
first.

**Third: two docs-site pages become false when f134 lands.**
`docs-site/content/sources/mcp-servers/overview.md:14` and its RU twin both say
"A notification never wakes or creates a session." They must change in the SAME
commit.

**Pointer drift is severe here — several hundred lines in places** — because R34
and R58 landed after the specs were written. Re-locate every symbol by name
before editing; the spec's line numbers will land in the wrong code.

⚡ This unit holds `SessionManager.ts`, `pi-agent.ts` AND `mcp-pool.ts`. Nothing
else in the wave may run concurrently against those files.

## R59 · headless-init-frame (f125 f133 f180) · implementation plan (planned 2026-08-07, orchestrator)

Pre-flight verified: f125 and f133 HOLD, f180 is STALE. Doc quotes all verbatim
(`best-practices.md:482`; `headless.md:181,197,202,211,219,220,222`;
`changelog.md:143`).

**The hardest part is what counts as an entry, and both halves fail SILENTLY in
the direction that defeats the feature:**

1. **`plugin_errors`.** `headless.md:211` binds it to plugins that are "demoted
   and absent from `plugins`". The diagnostic list in
   `capabilities/resolver.ts` now holds FIVE families and only THREE demote.
   `plugin.user_config.unredacted_sink` is new since the spec and is explicitly
   NON-demoting ("Substituted, not refused") — mapping it in makes a CI gate fail
   on a plugin that loaded correctly, the exact inverse of the point. And
   `plugin.dependency.*` is the SAME set as the `dependencyErrors` array the fix
   separately projects, so a naive pass emits every dependency failure twice.
   **Pin the mapping to the three demoting codes BY CODE, never by line range** —
   the range has already grown once.
2. **`mcp_server_errors`.** The spec calls `native-sources.ts` "the only
   genuinely new PRODUCER". It is not: an executor who builds only that reports
   Source skips while a PLUGIN MCP server that failed projection stays invisible.
   Find both producers.

**Other corrections:** every `apps/cli/src/index.ts` pointer in the spec is ~14
lines low; the flag enumeration is missing `--fallback-model` (added by R52).
`apps/electron/src/transport/channel-map.ts` needs NO entry (its parity test keys
off `ElectronAPI` method names), but `packages/shared/src/protocol/routing.ts` IS
exhaustive — `routing.test.ts` asserts every channel is classified exactly once,
so a new `sessions:*` channel must be classified there or CI fails. And
`packages/server-core/src/handlers/rpc/capabilities.ts` carries its own
`HANDLED_CHANNELS` array that no change entry names.

**Casing is a deliberate, documentable mix:** the frame is snake_case per the
page while our passthrough lines are camelCase Nessy events. Say so in the code
rather than "fixing" one side.

**Sequencing:** R66 shares `apps/cli/src/index.ts` — the two must not run
concurrently. `SessionManager.ts` is NOT needed for the init-frame half
(`getPiHarnessRuntimeSnapshot` is already public and `deps.sessionManager` is
already in scope in the capabilities handler).

## R60 · subagent-limits-and-child-output (f086 f090 f165) · implementation plan (planned 2026-08-07, orchestrator)

Pre-flight verified all three premises HOLD. Three corrections, one of which is a
security gap the spec does not mention at all.

**1. The documented 20 is architecturally unreachable, and shipping the counter
alone makes things worse.** After the obvious change there are THREE gates on one
spawn: the new subprocess counter at 20; the host's per-parent throw in
`child-session-service.ts` whose `active` set includes forks and resumed
children; and `live-agent-ceiling.ts`, whose default is
`max(2, floor(totalMemory / 2 GiB))` — 8 on a 16 GiB laptop, 4 on 8 GiB. Once the
Agent-tool path leaves its `cpuCores - 2` semaphore, that memory ceiling binds
first on almost every machine and refuses with `live-agent-ceiling-reached`, NOT
the documented `Concurrent subagent limit reached`. So the change as specified
replaces a silent queue with a differently-worded refusal at 8. **Decide how the
three compose so that 20 is the number a user observes with the documented
message**, and note `sub-agents.md:902-903`: a `/subtask` fork is never blocked by
the limit and resumes may push the running count past it — so the host number
must be strictly higher than the subprocess number, or fork/resume must be
exempted host-side.

**2. The spec misses the forgery guard, which is the security point of the
feature.** Nothing in its change list stops a CHILD from writing
`[harness: subagent output matched instruction-shaped pattern(s): none]` as the
first line of its own report and thereby forging the harness's own voice. Build
the guard and test it.

**3. Two smaller ones.** The spec's `'turn-marker'` label would fire on every
report containing a line starting `Assistant:` — routine in this repo's own audit
output — and the page's own pairing shows the turn marker is defanged
deliberately WITHOUT being reported; drop that label. And change entry #2
hand-rolls a writer that already exists: `saveLargeResponse` in
`utils/large-response.ts` does exactly the documented thing, is already imported
by the subprocess, and returns `null` instead of throwing. The repo rule is to
prefer the existing helper.

**Sequencing: R60 HOLDS `SessionManager.ts`** (f090 needs `readPiChildPartialOutput`)
— no other unit may touch that file concurrently, and note it has moved ~+500
lines since these specs were written. `orchestrator/subagent-tool.ts` is touched
by all three findings and f090/f165 collide on the SAME expression: do them in one
sequence inside the unit, never in parallel.

## R61 · skill-visibility-settings (f060 f171) · implementation plan (planned 2026-08-07, orchestrator)

Pre-flight: premise HOLDS, every doc sentence verbatim (`skills.md:661-689`; the
spec's `:635-663` moved +26). `skillOverrides` is absent from our code.

**The two specs give INCOMPLETE and COMPLEMENTARY refusal rules, and shipping
either alone leaves a hole.** f060 refuses only on `off`, for both origins. f171
refuses on `user-invocable-only || off`, model origin only. The page specifies
the merge:

- **Model origin** refuses on BOTH `user-invocable-only` and `off` — the table at
  `:667-672` marks both "Listed to Claude: Hidden", and omission from the listing
  is a HINT, not a control (our own docblock at `prompt-builder.ts:447` already
  says so). Ship f060 alone and a model that guesses the slug bypasses
  `user-invocable-only` entirely, which is the whole point of that state.
- **User origin** refuses ONLY on `off` (`:676` — "Invoking a hidden skill by its
  full name still returns the `skillOverrides` error") and must stay UNrefused for
  `user-invocable-only`.

**Do not hand-roll the schema.** The normative shape is already in the repo,
inside the vendored Pi bundle: `skillOverrides: z.record(z.string(),
z.enum(["on","name-only","user-invocable-only","off"])).optional()` with a
`describe()` spelling out each state. Mirror it in a new
`packages/shared/src/config/skill-overrides.ts`. The same bundle also declares
`disableBundledSkills`.

**Two more sentences nobody quoted.** `:674` — the `/skills` menu labels
`user-invocable-only` as `user-only`; `:689` — plugin skills are NOT affected
(falls out by construction here, since plugin skills take their control fields
from a different resolver branch, but assert it). And `skills.md:30` widens
scope: `/doctor` stays typable when `disableBundledSkills` is on.

**One spec entry is wrong about where to stamp:** f060 says to stamp inside the
`discoveredRecords` pass, which is a `.filter()` predicate — mutating records from
a filter callback. f171 is right: keep the filter a filter and add a `.map()`
where `nativeInventory` is assembled.

**Reachability confirmed** for all three enforcement points (the listing builder,
the slash-command selector, and `resolveSkillReferences`), so none of this is dead
code. `SessionManager.ts` needs NO edit — one delegate, two call sites.

## R62 · scheduled-task-catchup (f161 f162) · implementation plan (planned 2026-08-07, orchestrator)

Pre-flight: premise HOLDS. The scheduler is unconditional (no feature flag), and
the catch-up family is genuinely absent.

**The best finding is one the specs do not make: an orphan-worktree LEAK.**
`planWorktreeOrphanSweep` iterates the lease list only and never enumerates the
on-disk namespace — its own docstring says walking leases only is deliberate. So
a worktree whose lease was lost is never swept. R38 did not close this (it
shipped include-copying, fresh-base and config cleanup, no per-task wiring).
Decide explicitly whether R62 closes it or records it; do not let it fall between
the two units.

**Sequencing: R62 holds `SessionManager.ts`.** It must not run concurrently with
R57 or R60.

## R64 · hook-output-and-process-env (f010 f012 f141 f216) · implementation plan (planned 2026-08-07, orchestrator)

Pre-flight: premise HOLDS. R54 (hook INPUT parity) has landed and moved the ground
— read that commit first.

**The defect worth the whole unit is one the specs miss: the merge allowlist
silently drops fields the moment TWO hooks match one event.**
`mergePreToolUseDecisionObjects` rebuilds the decision object from an explicit
field list. It passes an object through untouched only while exactly one source
produced a decision; `mergeExecutionResults` is a four-way nest (native +
user-global + project + plugin) called on EVERY event. So with one hook everything
works, and with two — one imported plugin bundle plus one user-global hook, the
ordinary case — `initialUserMessage`, `reloadSkills` and `watchPaths` vanish.

**`reloadSkills` therefore demos perfectly and silently does nothing in real
use:** a skill the hook installed stays invisible for the whole session, with no
error. Widen the rebuild to carry all four fields (`sessionTitle` was already
spotted; add the other three) with last-writer-wins, matching how
`updatedInput`/`updatedToolOutput` already behave, and add the negative test: two
`SessionStart` results merged, all fields survive.

Missing from the spec's file list and load-bearing:
`packages/shared/src/agent/backend/types.ts`.

## R65 · memory-discovery-scopes (f068 f207) · implementation plan (planned 2026-08-07, orchestrator)

Pre-flight: premise HOLDS, all 20 quoted sentences verbatim, production route
real and unflagged.

**BLOCKER the challenger raised: a KEY COLLISION that compiles and passes today's
suite.** `qualifiedKey` in `native-sources.ts` would produce the same key for the
new scope and an existing one — a wrong contract that no current test catches.
Resolve the key scheme BEFORE writing the discovery, and pin it with a test that
registers both scopes at once.

**The managed tier is `CLAUDE.md` ONLY** — `memory.md:153`/`:157` spell bare names
and the Steps block at `:279-281` confirms it independently. One spec correction
rests on this for a second reason.

`SafeCapabilityScopeKind` already contains `'builtin'`, so reusing it avoids a
wire change. `MAX_INSTRUCTION_ANCESTOR_LAYERS` counts ancestors only and the cwd
tier is never dropped, so the R33 interaction is safe. R55 explicitly held
`@README`-inside-CLAUDE.md out as R77 — do not absorb it here.

## R66 · headless-cli-flags-and-exit (f126 f176 f178 f179) · implementation plan (planned 2026-08-07, orchestrator)

Pre-flight: premise HOLDS. **Sequencing: shares `apps/cli/src/index.ts` with R59
— the two must not run concurrently, and R59 lands first (R66 depends on it).**
Remember `bun run typecheck:all` does NOT cover `apps/cli`; run
`cd apps/cli && bunx tsc --noEmit` separately.

## R68 · workflow-invocation-contract (f094 f095) · implementation plan (planned 2026-08-07, orchestrator)

Pre-flight: premise HOLDS. **Sequencing blocker the verifier missed and its
challenger caught:** the verifier zoned f095 against its sibling f094 only and
concluded it could run in parallel with any SessionManager-holding unit. But R60
edits the SAME file (`orchestrator/workflow-tool.ts`) at four anchors, and R60 is
this unit's declared dependency. `git commit <pathspec>` takes working-tree state,
so the two WILL cross. **R68 runs after R60**, as the deps column always intended.

The child permission floor is a security boundary: `clampPermissionModeToParent`
reads `PERMISSION_MODE_ORDER`, and a wrong position in that order is a silent
widening. Any change there needs a test that a child cannot exceed its parent.

## R67, R69–R77 · implementation notes from pre-flight batch 3 (planned 2026-08-07, orchestrator)

Every premise was verified against the live pages and every verification was then
overturned by its challenger. These are the corrections that decide whether each
unit ships something real. **Read the unit's paragraph before its specs.**

**R67 · agent-memory-directories (f089 f148).** Treat them as ONE change — same
field, same three producers. **The obvious implementation fails closed on exactly
the agents the finding is about:** both specs union `read/write/edit` into
`allowedTools` in the spawner, but the host re-validates the child's tool list
against the PINNED author-declared `tools` and throws
`runtime-agent-tool-unavailable:write` — so a `toolset: read-only` agent
declaring `memory:` (the flagship case) cannot spawn. Worse, builtin agents carry
no `definitionKey`, so the check is skipped for them and a test written against a
builtin PASSES while hiding this. Widen the host's declared set in the same
change, or apply the grant host-side only. Also: do NOT append the memory block
in `composeChildPrompt` — the host asserts the child prompt ends with the pinned
system prompt and a fourth segment fails that; forward `memory` on restrictions
and let the host append AFTER the pin check. And do NOT add a second byte-limit
constant or byte-cap `readMemoryFile`: R56 already moved that contract into
`session-tools-core`, and `readMemoryFile` is line-only by a recorded decision
whose consequence is a changed record set for every user with a large MEMORY.md.

**R69 · skill-frontmatter-runtime (f058 f062).** The two findings COLLIDE
invisibly: f062 routes a forked skill around `formatPinnedSkillInstructions` and
hands the child `invocation.body`, while f058 puts the placeholder substitution
INSIDE that formatter — so the page's own worked example silently ships
unsubstituted. Decide one path for both.

**R70 · skill-discovery-precedence (f063 f170).** Land f170 first, then f063:
both rewrite the SAME preference tuple in `resolver.ts` and each spec quotes it
in its pre-other shape. f170's `aliasScopeRank` looks safe because it is gated on
`kind`, but plugin skill candidates SHARE the collision bucket — their
`logicalName` is the bare slug, not the `plugin-name:skill-name` the page
promises — so the gate does not exclude them.

**R71 · code-review-contract (f142 f143).** STALE, and the drift is invisible
without the trailing clause: `:327`'s effort sentence still literally contains
the spec's rule, but a following sentence demotes it to pre-v2.1.223 behaviour
and makes it the never-typed FALLBACK. In-unit collision: both findings write
`fixtures/tool-surface.json` (different rows) — sequence them.

**R72 · plugin-install-and-dependencies (f048 f244).** STALE. **The biggest hole
is not in either finding:** R63 explicitly deferred installed-plugin BUNDLE
updates to this unit ("catalog refresh only", recorded in-source at
`registry-source.ts`). Close it here or re-file it; do not let it fall between
the two units a second time.

**R73 · hook-firing-and-await (f001 f005 f006 f217).** PARTLY-CLOSED. There is no
session-bootstrap hook route at all: the agent is constructed LAZILY and the only
session-source `SessionStart` emission lives inside `chatImpl`, so nothing fires
before a first turn. Heavily self-serializing: three findings mutate one
three-entry inert-matcher list and each assumes the other two survive — one
executor, one sequence.

**R74 · agent-definition-fields (f211 f220).** The filesystem markdown loader is
NOT on the subagent dispatch route: it gates its reads on
`runtimeDefinitions === undefined` and both dispatch sites pass an empty ARRAY,
so the gate is closed on the exact route both findings care about — the
default-parameter trap again. `definitions.ts` is claimed by SIX specs; this unit
must hold it exclusively.

**R75 · custom-command-expansion (f144 f145 f149).** Order is forced:
f144 → f145 → f149. f149's change text re-introduces the exact regex f145
deletes, so it must be rewritten to compose over f145's expander and inherit its
MCP guard. The `/loop` stop-rule clause has no analogue here — the spec elided
the middle of that sentence and then dismissed the whole clause.

**R76 · plugin-bundle-component-shapes (f053 f054).** f053's fixture entry is
WRONG, not stale — the row it claims to protect was retired when hooks and MCP
became first-class. Read the fixture's actual bytes before trusting any entry
that cites it. Intra-unit collision on `plugins/types.ts`.

**R77 · instruction-file-imports (f099 part B).** The scanner exists (R55); the
hard part is the dedupe-and-order decision, and it alone decides whether the
doc's flagship case closes: a CLAUDE.md whose whole body is `@AGENTS.md`.
AGENTS.md is registered as its own root record BEFORE CLAUDE.md is walked, so a
shared `seen` set leaves the token unresolved and ships the literal — **a green
R77 that changes nothing for the case the page uses as its example.** No
SessionManager edit needed; real contention is `native-sources.ts` and
`base-agent.ts`.

## R43 · deep-link-safety · implementation plan (planned 2026-08-04)

**Doc contract, verbatim from `curl -sL https://code.claude.com/docs/en/deep-links.md`:**
- "A deep link never executes anything on its own. The link only chooses a directory and fills the prompt box. If you click a link from a page you do not trust, the prompt is still inert: nothing reaches the model until you read what was filled in and press Enter."
- "When the session opens, a warning line below the input box reads `Prompt from an external link` and stays visible until you send or clear the prompt. For prompts over 1,000 characters, the warning includes the character count and tells you to scroll and review the full text before pressing Enter"
- "The prompt is populated but not sent until you press Enter."

Finding f154. Full spec: worklist § `сделано не так · sessions`.

**Planner decisions (do not re-litigate):**
1. `shell.OPEN_URL` is stamped `origin: 'external'` in BOTH implementations
   (`apps/electron/src/main/handlers/system.ts:206`, `packages/server-core/src/handlers/rpc/system.ts:281`).
   That channel carries a markdown-link click from MODEL OUTPUT
   (`Markdown.tsx:201-224` hands the original href through), so it cannot be internal.
2. The only legitimate internal producer is `EditPopover.handleLegacySendMessage`
   (`EditPopover.tsx:1081-1101`), which round-trips through `buildNewSessionDeepLink`
   + `openUrl`. It moves to the direct `onCreateSession`/`onSendMessage` calls its
   sibling inline branch already makes (same component, both already in scope).
   If that branch turns out unreachable, delete the round-trip instead.
   No new RPC channel — the spec's fallback is not taken.
3. `origin` is a REQUIRED parameter on `handleDeepLink`, so a missed call site is a
   typecheck error and not a silent trust grant.
4. **Fail-safe direction, the one thing easy to get backwards:** on the DTO the field
   is optional for wire compatibility, and the renderer MUST read a missing value as
   `'external'`. This is the OPPOSITE of the `workspaceId` convention documented two
   interfaces above it (`dto.ts:987-989`, "Missing/null entries always pass the
   filter"). State it in the field comment.
5. Untouched: the `nessy://auth-callback` carve-out (`deep-link.ts:111-114`) and the
   `workdir` rejection (`NavigationContext.tsx:685-690`).

**Two dispatches, one commit.** (a) origin plumbing + external gating. (b) the
documented disclosure line + i18n across all locales.

⚡ Wire boundary (`DeepLinkNavigation` on `deeplink:navigate` reaches apps/cli,
webui, viewer) and persistence boundary (link `mode` → session header via
`store-v2.ts:272`). Both risk triggers: expanded boundary check once on the final diff.

## R82 — `plugin-update-affordance`

R81 made the wire truthful: `availableUpdateVersion` has a producer and `canUpdate`
can be true. Nothing shows either. Verified on HEAD before dispatch — `canUpdate`
and `availableUpdateVersion` appear in `apps/electron/src` **only in three test
fixtures**, and `useMarketplaceInstall.ts:17` declares
`LifecycleRequest = … { action: 'update' | 'repair' | 'uninstall' }` while shipping
hooks for only the last two. The server half is already there:
`packages/server-core/src/handlers/rpc/plugins.ts:97,140` handle
`request.action === 'update'`.

**Doc contract, quoted, all three parts:**

1. The action exists and is per-plugin. `plugins-reference.md` § *plugin update* —
   "Update a plugin to the latest version." with `claude plugin update <plugin>` and
   `-s, --scope <scope>` "Scope to update: `user`, `project`, `local`, or `managed`",
   default `user`.
2. The Installed tab's own verb list does **not** include update —
   `plugins/install.md#manage-installed-plugins (was line 319 of the retired discover-plugins page)` is "view, enable, disable, or uninstall". So the badge
   is what carries the affordance's discoverability, not a fourth always-present verb.
3. **The honesty requirement, and the reason this is not a two-line unit.**
   `plugins/cli-reference.md#reload-plugins (was line 703 of the retired plugins-reference page)` — "When a plugin updates mid-session, hook commands,
   monitors, MCP servers, and LSP servers keep using the previous version's path. Run
   `/reload-plugins` to switch hooks, MCP servers, and LSP servers to the new path;
   monitors require a session restart."

**Scope:**

1. `useMarketplaceUpdate` in `useMarketplaceInstall.ts`, mirroring
   `useMarketplaceRepair` exactly — same `completePluginMutation`, same
   `onSettled: invalidateMarketplaceQueries`. The type already admits `'update'`.
2. An Update item in the installed-row dropdown at `PluginsPage.tsx:1592`, gated on
   `item.installed.actions.canUpdate`, sitting next to Repair.
3. The badge: `availableUpdateVersion` rendered on the row. R81 established what it
   means and the constraint rides along — a held plugin whose catalog latest is
   outside the intersected dependency range gets **no** badge, because R81 already
   withholds the field in that case. Do not re-derive it renderer-side; render what
   the wire says and nothing more.
4. **After a manual update succeeds, raise the same reload notice the auto-update
   path raises.** `plugins.autoUpdateNoticeTitle` / `plugins.autoUpdateNoticeBody`
   already exist and `AppShell.tsx:1434-1442` already cites `plugins/loading.md#when-auto-update-runs (was line 445 of the retired discover-plugins page)`
   for them, naming this fork's equivalent action (Plugins → Refresh runtime).

**Two traps, both of which produce a green-looking wrong answer:**

- **Do not widen the `AppShell` toast condition.** It is keyed on
  `MARKETPLACE_AUTO_UPDATE_REASON_CODE` *deliberately*, with the reason in a comment
  — "so an interactive mutation the user just made never toasts at them". Widening it
  makes enable, disable and uninstall toast a reload notice too. The manual update's
  notice belongs at its own mutation site.
- **Without part 4 this unit ships a lie.** The toast says updated, the row shows the
  new version, and every hook, MCP server and LSP server in the running session keeps
  executing the old path. That is worse than no button.

⚡ None. Renderer-only, no wire change, no persistence boundary — the RPC action and
the server handler both already exist.

## R84 — `hook-block-cap-lever` (f012)

**Doc contract, fetched fresh 2026-08-07 and quoted whole** — `env-vars.md`, the
`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` row: "Maximum number of consecutive times a
[Stop](/docs/en/hooks#stop) or [SubagentStop](/docs/en/hooks#subagentstop) hook
may block the turn from ending before Claude Code overrides it and ends the turn
anyway (default: 8). Set to `0` to disable the cap. Raise this if your hook
legitimately needs more iterations to resolve".

**Verified on HEAD:** `MAX_CONSECUTIVE_HOOK_BLOCKS = 8` is a private const in
`base-agent.ts:136`, read at exactly one site (`:564`). The mechanism is live on
BOTH documented events — `Stop` via `pi-agent.ts:7312`, `SubagentStop` via
`SessionManager.ts:5814` — plus our own undocumented `ConfigChange` at
`pi-agent.ts:7340`, which shares the counter.

**Scope.** A `resolveStopHookBlockCap` module shaped exactly like the existing
`config/print-background-wait.ts` precedent: Nessy name wins over the
`CLAUDE_CODE_` compat name, `undefined` → 8, trim then `/^\d+$/` only, and **any
malformed value falls back to 8** — a typo must never silently buy an uncapped
loop. `0` disables the cap.

**The one thing that makes this a unit and not a constant rename:** R64 refused
it because a resolver with no consumer is dead code. So the consumer ships in the
SAME change — `:564` must read the resolved value, and a test must prove a raised
cap actually allows more consecutive blocks and `0` allows them without limit.
Do not ship the module alone.

⚡ None.

## R85 — `hook-env-file-channel` (f141)

**Doc contract, fetched fresh 2026-08-07** — `hooks.md`: "SessionStart hooks have
access to the `CLAUDE_ENV_FILE` environment variable, which provides a file path
where you can persist environment variables for subsequent Bash commands." And
the scope line: "`CLAUDE_ENV_FILE` is available for SessionStart, [Setup](#setup),
[CwdChanged](#cwdchanged), and [FileChanged](#filechanged) hooks. Other hook
types don't have access to this variable."

**The spec's event set is STALE and must be corrected:** it lists `Setup`, which
R73 removed from this fork entirely. Our set is **SessionStart, CwdChanged,
FileChanged** — all three verified present in `automations/types.ts`.

**The open question was the READ-BACK** — "persist environment variables for
**subsequent Bash commands**". Minting the variable alone hands hooks a file
whose exports never apply, the demos-perfectly-does-nothing shape R64 refused.
**Answered by a read-only feasibility pass, 2026-08-07: the seam exists, and my
own starting assumption was wrong.**

The Pi `bash` tool is NOT a vendored pi-coding-agent tool that runs inside the
subprocess. It is a runtime-backed port that sends `process_start_request` over
IPC and executes **on the host, per command**:
`runtime-backed-tools.ts:353` → `local-tools/runtime.ts:233-259` →
`pi-agent-server/src/index.ts:1694-1753` → `:3823-3857` (which wraps the model's
string as `/bin/sh -lc <command>`) → `pi-agent.ts:5315-5412` →
`ProcessSupervisor.start` (`process-supervisor.ts:172-181`, spawn at `:244`).

**The insertion point is `pi-agent.ts:5379-5401`** — the `childEnvironment` object
and the `env:` spread on `port.start(...)`. This is not a guess: the identical
shape already ships `CLAUDE_EFFORT`/`NESSY_EFFORT` there (`:5388`), and the
in-source comment at `:5368-5371` already calls it "the one seam that reaches the
Bash tool and its siblings". It also sits on the safe side of the trust boundary —
`pickSupervisedChildStartFields` (`process-supervisor-port.ts:124-140`) carries no
`env` field, so a child cannot smuggle one.

**Scope it to Pi, and say so.** Claude-runtime and Codex both fix their env once
at subprocess spawn (`options.ts:237-270`; `runtime-manager.ts:36-54`) and expose
Bash only as an approval callback — so `SessionStart` on those two backends is an
explicit, recorded NON-GOAL, not an oversight. It barely narrows the feature:
`CwdChanged` and `FileChanged` are emitted **only** by the Pi lifecycle bridge
(`lifecycle-bridge.ts:275`, `:342`), so two of the three in-scope events are
Pi-exclusive already.

Prefer the **command-preamble** form over an env merge. The doc's own recipes are
`export PATH="$PATH:./node_modules/.bin"` and an `export -p` diff — both need
shell evaluation, which a key/value merge cannot do. Guard it on the exact shape
minted at `pi-agent-server/src/index.ts:3838-3840` and on `semanticId`
`bash`/`bash_background`.

Also required or the hook cannot write the file at all: the env file's directory
must join `additionalWritableRoots` at the hook spawn
(`SessionManager.ts:4871`, `:4899`), which runs `environmentProfile: 'explicit'`.

⚡ Session-directory writes, and a change on the model's own shell path — the
strongest risk trigger in this wave. Expanded boundary check once, on the final diff.

## R87 — `component-scoped-hooks`

The `hooks` key in skill and subagent frontmatter. Deliberately NOT folded into
R69b: it is a hook LAYER with its own lifetime, not a field read, and mixing it
into a unit that is carefully carrying a consumer for every new field would blur
both.

**What it solves for a user.** Today an author writes the doc's own example — a
skill that runs a security check before every `Bash` command — and it does not
run. We are honest about it (`format-adapters.ts:501` emits
`plugin.format.frontmatter_hooks_unregistered`, whose message reads "Nessy does
not register component-scoped hooks, so they will not run — move them to the
plugin's hooks file to have them execute"), so nothing is silently broken. But an
author who wants a guardrail that exists only while one skill is active has no way
to express it: moving the hook to the plugin's `hooks.json` makes it global, which
is a different and more dangerous thing.

**Doc contract, fetched 2026-08-07, quoted.**
- `hooks.md` § *Hooks in skills and agents*: "hooks can be defined directly in
  skills and subagents using frontmatter. These hooks are **scoped to the
  component's lifecycle and only run when that component is active**."
- "**All hook events are supported.** For subagents, `Stop` hooks are
  automatically converted to `SubagentStop` since that is the event that fires
  when a subagent completes."
- "Hooks use the same configuration format as settings-based hooks but are scoped
  to the component's lifetime and **cleaned up when it finishes**."
- Source-precedence table: `Skill or agent frontmatter` → active "**While the
  component is active**".
- `once` field: "If `true`, runs once per session then is removed. **Only honored
  for hooks declared in skill frontmatter**; ignored in settings files and agent
  frontmatter."
- Trust: "Frontmatter hooks in a **project** subagent run only after you accept the
  workspace trust dialog for the folder the agent file came from."

**This is a fifth layer, not a new architecture.** `PluginScopedAutomationSystem`
(`plugins/hooks-automation.ts:480`) already composes native, user-global,
workspace, plugin and project hook configs. The doc says the format is the same as
settings hooks. So the config half is an addition to something that already exists.

**The seam, verified on the code rather than assumed (orchestrator, 2026-08-08).**
`executeAgentEventInner` (`plugins/hooks-automation.ts:606`) is a LINEAR CHAIN:
`nativeSystem` → `userGlobalHookConfig` → `projectHookConfig` → `pluginHookConfig`,
each one a plain `executePluginHookAutomations(config, event, input, options)` call,
folded together by `mergeExecutionResults` under the same `decisionMergePolicy`.
So a component layer is **one more call in that chain** — the config half is
genuinely additive. What must differ is where the config comes from: every existing
layer reads a constructor field, and the component layer must read a
**reader/getter consulted at this call**, so a component that became active after
the system was built is visible and one that finished is gone. Decide and state the
merge POSITION deliberately (a component hook is the narrowest scope and the
decision-merge policy is order-sensitive — R64 exists because that merge lost fields).

**The one genuinely hard part, and the shape of the fix.** The system is built ONCE
per capability generation — a single `buildPinnedAgentAutomationSystem` call site
(`SessionManager.ts:12220`). Plugin hooks fit that perfectly because they are
stable for the session. Component hooks must appear when a skill becomes active and
**disappear when it finishes**, which is dynamic within a turn and cannot be
expressed by a frozen snapshot. The correct form is the one this repo already
settled twice: make the component layer a **reader consulted at dispatch time**,
not a config frozen at build time — the same correction the 429 plan's T2 made when
a snapshot would have kept a stale endpoint's backoff. Attach/detach then becomes
an entry appearing and leaving a registry of active components, with no rebuild.

**Three rules that are easy to lose, each giving silently wrong behaviour:**
1. `Stop` → `SubagentStop` conversion, for SUBAGENTS only.
2. `once` honoured for SKILL frontmatter only — explicitly ignored in agent
   frontmatter and settings.
3. The trust gate for PROJECT-scoped agent frontmatter. Getting this wrong runs
   code from a folder the user never trusted, which is the one failure here with a
   security consequence rather than a correctness one.

**What must be proven — the lifetime, not the parse.** The test that matters is
that a component hook fires while its component is active and **does not fire after
it finishes**. A test that only asserts the hook was registered would pass on a
half-built version and is worthless here.

**Do not ship the parse without the dispatch.** If the layer lands unread, the
result is worse than today: the author-facing diagnostic above would be removed
(the field is now "supported") while nothing actually runs — the exact
demos-perfectly-does-nothing shape f062 was refused for.

⚡ Executes author-supplied commands on a new schedule, and touches the trust
boundary. Both are risk triggers; expanded boundary check once on the final diff.

**Sequencing: after R86 and R69b** — all three touch `SessionManager.ts` and the
automation layer.

## R69b — `skill-fork-dispatch` (f062)

Scoped by a read-only feasibility pass, 2026-08-07. **Verdict: contained, not
architectural** — the previous executor's "needs a backend seam and a Pi RPC" is
half right (both are the correct design) but neither is a blocker.

**THE CORRECTION THAT DECIDES THE DESIGN.** `context: fork` is **not** the
`/subtask` conversation fork. `skills.md`: "Add `context: fork` to your frontmatter
when you want a skill to run in isolation. The skill content becomes the prompt
that drives the subagent. **It won't have access to your conversation history.**"
Its system prompt comes from a NAMED agent type (`agent:`, defaulting to
`general-purpose` upstream). `/subtask` is the opposite — it inherits history, and
`FORK_AGENT_DEFINITION` / `composeForkRestrictions` exist precisely to guarantee
that. **Anything built on `FORK_AGENT_DEFINITION` would be wrong.** The dispatch
primitive is the ordinary named-subagent spawn.

**Doc, quoted:** `context` — "Set to `fork` to run in a forked subagent context."
`background` — "Only applies with `context: fork`. Set to `false` to wait for the
forked subagent's result in the turn that invoked the skill… Default: `true`."
And the consequence that makes `background` load-bearing: "The forked subagent runs
in the background: you keep working while it runs, and **its result arrives in your
conversation when it completes.**"

**The Pi-RPC claim, tested rather than accepted** (the R85 shape). A host-side
route needs NO new wire message: `AgentConfig.childSessionPort` already exists and
the guardian judge already calls `piChildSessionPort.start(...)` directly, with a
comment saying it adds no new host↔subprocess RPC class. So `background: false` is
buildable today. **Take the RPC anyway**, for three measured reasons: background
registration is subprocess-side (`BackgroundTaskRegistry` — a host-started
background child would be unreachable by `stop_task` and invisible to the renderer);
the host route bypasses `spawner.ts`'s concurrency ceiling, the only place the
documented refusal message is produced; and it would become a THIRD composer of
child restrictions where the spawner already warns that both existing copies must
change together. **Build it as a sibling of `/subtask`, not of the guardian judge.**

**Two traps that would silently corrupt existing behaviour:**
- `frontmatter.agent` today is a CEILING on which subagents the invoking turn may
  spawn (`prerequisite-manager.ts:221`), not a fork target. The fork target must be
  a NEW field, or every non-forked skill's ceiling semantics change.
- `SkillInvocationRecord` feeds `computeSkillInvocationDigest`, and
  `PiChildRestrictionsV1` is embedded verbatim in a PERSISTED record that survives
  restart. Append any new field LAST, exactly as `maxTurns?`/`memory?` were.

**The part that would be a dead field without a consumer, and its consumer.**
`background: true` is the documented DEFAULT, and it owes "its result arrives in
your conversation". `recordForkResultInTranscript` already replays a settled child
into the transcript exactly once — but its gate is
`restrictions.fork === true && ownerTaskId === undefined`, and a skill fork is
neither a conversation fork nor a tool call, so it matches NEITHER. Widening that
gate is part of this unit, not a follow-up. Without it the default path is exactly
the demos-perfectly-does-nothing shape f062 was refused for the first time.

**Out of scope, deliberately:**
- **`hooks` stays open and is architectural.** It needs a component-scoped hook
  registry with lifecycle attach/detach, not a field read; it was already costed and
  refused in R30c, and a user-facing diagnostic already tells authors it will not
  run. Do not fold it in.
- **`shell` belongs to f058's zone** and is now small: the interpreter is hardcoded
  `/bin/sh -lc` at one call site, and the PowerShell validator already exists and is
  wired. Worth recording: the doc's default is `bash`, ours is `/bin/sh`.

⚡ Persistence boundary (skill-invocation digest; `PiChildRestrictionsV1` record
shape) and wire boundary (a new host→Pi RPC pair). Both additive-last-field with
in-repo precedent. Expanded boundary check once on the final diff.

**Sequencing: dispatch AFTER R86 lands** — R86 holds `SessionManager.ts` and
`pi-agent-server/src/orchestrator/**`, which this unit also needs.

## R86 — `background-result-delivery`

**Doc contract** — `sub-agents.md` § *Run subagents in foreground or background*:
"A background subagent's results reach Claude as a completion notification in a
later turn. Claude waits for that notification before reporting the subagent's
results, and if you ask about progress first, it reports that the subagent is
still running."

**Verified on HEAD by the orchestrator, line by line.** Background is the DEFAULT
for every top-level `subagent` call. `task_completed` reaches
`SessionManager.ts:19606`: it releases the retained authority, stores the summary
for `getTaskOutput()`, completes the task-service entry, and forwards to the
RENDERER. Its only model-facing branch is `schedulePiGoalContinuation`, which
returns immediately unless a `/goal` is active (`:3738`). Nothing else reaches the
model.

**The mechanism already exists and is one case below it.** `task_notification`
(`:19651`) calls `deliverMonitorEvent`, whose docstring (`:2971-2989`) states the
three-rule discipline verbatim — **Idle: the event STARTS a turn**; **Busy: queues
in order and is delivered as ONE group on the next turn, never one turn each and
never steered into the running turn**; **before the first user prompt: held as
first-turn context**, because starting a turn there would make a machine event the
session's opening message and the title is derived from that. Its own comment
already lists its producers (monitor service, cron, R10 detached MCP results, MCP
channel pushes) — this unit adds one more.

**Scope.**
1. Route `task_completed` for subagent/workflow kinds through `deliverMonitorEvent`,
   reusing that discipline rather than inventing a second one. `managed.piBackgroundTaskKinds`
   already carries the kind and is deleted in this very handler — read it BEFORE the delete.
2. The text must be a notification, not a dump: name the agent/workflow and carry
   the summary the handler already stores. The full output stays behind
   `getTaskOutput()`; a 128 KiB child result must not be pasted into a turn.
3. **Add a workflow result path.** There is `get_subagent_result` and no
   `get_workflow_result` (verified against the manifest tool list), while the
   workflow tool's guidelines say "Set background true for long-running workflows"
   — so following the guideline makes the result permanently unreachable. Either
   add the retrieval tool or make `get_subagent_result` accept a workflow task id.
4. **Stop the tool descriptions lying.** `subagent-tool.ts:426-427` tells the model
   to watch "the `task_completed` event", which is emitted host- and renderer-only.
   Once (1) lands the sentence becomes true for subagents; make sure it is true for
   workflows too, or remove the clause.

**The trap.** A foreground (`background: false`) subagent already returns its
result as the tool's return value. Delivering a notification for those too would
double-report and burn a turn per child. Gate on the recorded kind/背景 flag, and
prove the foreground case delivers NOTHING.

⚡ Agent-loop behaviour and token cost: this makes completions start turns when the
session is idle. That is the documented behaviour and the queueing discipline is
already implemented, but it is the strongest risk trigger in this plan — expanded
boundary check once on the final diff.

## Post-completion adversarial audit (2026-08-08)

Ten independent skeptics, one per highest-risk CLOSED unit, each told to REFUTE
its tracker row rather than confirm it, against the live docs and the code on
HEAD. **45 claims CONFIRMED, 4 REFUTED, 0 unverifiable.** The refutations, with
the orchestrator's own re-verification and disposition:

- **HIGH — R82/R83 update is a no-op on an auto-update-OFF marketplace.** Confirmed
  by direct reading; filed and tracked as **R88** above. This is the one real
  user-facing defect the audit surfaced.
- **MEDIUM — R69 `$ARGUMENTS` injection guard is evadable by a count-PRESERVING
  injection.** The guard only fires when the expanded placeholder count exceeds the
  raw count (`runtime-skill-content.ts:~1003`); an argument crafted to destroy one
  opener and introduce one fresh placeholder keeps the count equal and slips
  through. Mitigated — the injected command still passes the Bash permission gate,
  so it is not silent RCE unless the mode/allowed-tools already permit it — hence
  medium not high. **Disposition: HELD.** R69b is actively editing that exact file;
  re-verify against R69b's final diff before fixing, since the fork route changes
  this code. If it survives, fix the guard to compare command SETS, not counts.
- **LOW — R73's native/legacy manifest surface refuses `Setup` but the REASON does
  not reach the author, and the legacy route regressed.** `normalizeLegacyHooks`
  (`format-adapters.ts:~1480`) drops the `deferredReasonCode` and emits
  `plugin.format.legacy_capability_incomplete` ("requires id, event, and command
  hook type") — factually wrong for an entry that supplied all three; pre-commit
  the author at least got `unknown_hook_event` naming the event. The hard invariant
  (no silently-registered dead hook) still holds, so severity is low. **Disposition:
  fix in the R88 batch** — carry `deferredReasonCode` through the legacy caller and
  add a `nessy`-dialect `Setup` test (today only claude/codex spellings are pinned).
- **LOW — the 429 plan's renderer `StatusEvent` type understates `'retrying'`** and
  it was NOT recorded anywhere. No user-facing defect (the value crosses IPC
  structurally and renders); the stale type only endangers a future exhaustive
  renderer switch. **Disposition: recorded here now** (that is the fix for a
  "not recorded" finding); the one-line union widening rides the R88 batch.

The 45 confirmations include every load-bearing claim of R64 (the two-hook merge),
R85 (the env-file constant preamble and the glob-match measurement, re-derived
independently by the skeptic), R86 (the foreground double-report gate, checked at
the keying argument not just the test), R84, R70/R78/R79 and T4's cause
classification.

## R87b — `subagent-frontmatter-hooks`

**My earlier framing was too pessimistic and is corrected here.** I recorded this
as needing "a cross-session seam we lack". Verified 2026-08-08: **the seam
exists.** This is contained, and it rides the mechanism R87 already built.

**Doc contract — `sub-agents.md` § *Hooks in subagent frontmatter*, quoted:**
- "Define hooks directly in the subagent's markdown file. These hooks only run
  **while that specific subagent is active** and are cleaned up when it finishes."
- "**All hook events are supported.** The most common events for subagents are:
  `PreToolUse` (Before the subagent uses a tool), `PostToolUse` (After the
  subagent uses a tool), `Stop` — "When the subagent finishes (**converted to
  `SubagentStop` at runtime**)"."
- Trust, stated precisely and NOT the same rule as skills: "To let a
  **project-level** subagent's frontmatter hooks run, accept the workspace trust
  dialog for the folder that contains the agent file. Hooks from **user-level**
  subagents in `~/.claude/agents/` and from definitions you pass with `--agents`
  run **without this step**." And the failure mode: "Until you trust the folder,
  the subagent **still runs**, but Claude Code **skips its frontmatter hooks** and
  logs an error to the debug log explaining how to trust the folder."
- Also in scope per the Note: frontmatter hooks fire both when the agent is
  spawned as a subagent AND when it runs as the main session via `--agent`, where
  they run *alongside* settings hooks.

**What already exists — verified, do not rebuild:**
- `SubagentStop` is ALREADY emitted parent-side with the full documented payload
  (`SessionManager.ts:6252` `executePiChildTerminalAutomation`), dispatching
  through `authority?.system ?? backgroundAuthority?.automationSystem ??
  managed.agentAutomationSystem`. The `Stop`→`SubagentStop` *event* is done; what
  is missing is the agent's own hooks being IN the system that dispatches it.
- `piChildAutomationAuthorities` (`:6121`) already retains a per-child authority
  for the child's lifetime — the exact lifetime this feature needs.
- R87 shipped `ComponentHookLayer`, `parseSkillFrontmatterHooks` and
  `frontmatterHookToAction`. The parser is format-identical (Claude's nested
  `hooks:[{type,command}]`), so **reuse it; do not write a second parser.**

**The two halves, and where each lives:**
1. **`PreToolUse`/`PostToolUse`** fire inside the CHILD's own Pi session. The
   child is a real session with its own automation system, so the agent's
   frontmatter hooks become that session's component layer, active for its whole
   life. Carry them on the child-session record the way R69b carried `skillFork`
   — appended LAST, since `PiChildRestrictionsV1` is persisted and survives restart.
2. **`Stop`→`SubagentStop`** is parent-side and already emitted; the agent's
   hooks join the dispatching authority for that child, converted at parse so a
   `Stop` in agent frontmatter registers as `SubagentStop` (the conversion is
   SUBAGENT-only — R87 already established a skill's `Stop` stays `Stop`).

**The trust gate is NOT the skill rule — this is the trap.** R87 reused
`isRunnable`, which is right for skills. Here the doc splits by SCOPE: user-level
and `--agents` run without trust; project-level needs the containing folder
trusted; and an untrusted project agent **still runs, with its hooks skipped and
an error logged**. So the gate belongs on the HOOKS, not on the agent — refusing
the agent would contradict the page.

**What must be PROVEN:**
1. A subagent's `PreToolUse` hook runs while that subagent is active and is gone
   after it finishes.
2. A `Stop` in agent frontmatter fires as `SubagentStop` when the child returns.
3. A **project-level** agent from an untrusted folder still RUNS, with its hooks
   skipped and the reason logged — not refused.
4. A **user-level** agent's hooks run with no trust step.
5. A skill's `Stop` still stays `Stop` (R87's rule is not broken by the new
   conversion).

⚡ Persistence boundary (`PiChildRestrictionsV1` gains a field — append LAST) and
a trust decision. Both risk triggers; expanded boundary check once on the final diff.

### Two recorded partials, and one correction the executor made to this section

**PARTIAL 1 — the `--agent` main-session case is UNREACHABLE, not merely
disproportionate.** The Note says frontmatter hooks also fire "when the agent runs
as the main session via `--agent` or the `agent` setting". This fork has no such
surface at all, and the absence is already a recorded deviation (R30c): the
`initialPrompt` field on `PiRuntimeAgentDefinitionDescriptor` carries the same
note — "the surface that row names (`--agent`/`--agents`/an `agent` setting) does
not exist in this fork". There is nothing to wire the hooks to. **Revisit when a
main-session-agent surface lands**; the parsed `componentHooks.child` block is
exactly what that surface would feed to the main session's automation system, so
the work is a call site, not a mechanism.

**PARTIAL 2 — the untrusted-project failure mode is unreachable for a NATIVE
project agent, because a broader pre-existing boundary already withholds it.**
The page says an untrusted folder's subagent "still runs" with its hooks skipped.
Verified 2026-08-08: in this repo an untrusted project contributes **nothing** —
`native-sources.ts` wraps the whole project tier in
`if (context.projectTrustState === 'trusted')` and the `else` arm pushes one
`untrusted-project` blocked-layer diagnostic with "no repository-owned content",
so a project-scoped agent file is never scanned, never resolved and never in the
runtime view. Skills, hooks, MCP and memory sit behind the same boundary; it
predates R87b and widening it for agents alone would be a security decision, not
a parity fix.

So the gate R87b implements is the correct one and is proven at the layer that
decides (`buildPiRuntimeAgentDescriptor` — given a project-scoped definition and
no grant, the definition loads whole and only its hooks are dropped, with the
reason reported), and it is a SECOND line of defence in production today. It
becomes the only line the moment the project tier is admitted under a narrower
grant than full workspace trust, which is exactly what the detect+consent model
(`project-contribution-detect.ts`) exists to make possible. **The important half
was implementable and is implemented: the code does not refuse the agent.**

**CORRECTION to this section's framing of `once`.** The section says the parser
is format-identical and should be reused, which is right, but the reuse needed
one more axis than "same parser": a subagent's frontmatter has TWO documented
differences from a skill's, not one. `Stop`→`SubagentStop` was named here; the
second — `once` is "ignored in settings files and agent frontmatter" (`hooks.md`)
— was not. Both are now options on one shared partitioner
(`partitionFrontmatterHooks`), so there is still exactly one reader.

**CORRECTION to the section's split of the two halves.** It says the parent-side
tier "joins the dispatching authority for that child". It cannot: a parent holds
several live children, `ChildSessionService.emitTerminalOnce` is not serialized
across them, and the authority is retained for BACKGROUND children only — a
foreground child dispatches through `managed.agentAutomationSystem`. Registering
per-authority would have run one child's `Stop` hook on a sibling's completion,
which is precisely what "only run while that **specific** subagent is active"
forbids. The tier is instead held in `ManagedSession.piChildComponentHooks` keyed
by `agentId` for the child's lifetime, and `ComponentHookLayer.matchersFor` was
widened with the dispatch INPUT so the layer can answer for that event's own
`agent_id`. A test pins the sibling case, and breaking the filter fails exactly
it.

## R53c — `subagent-row-effort-and-model` (R53b half (a))

Owner chose half (a) on 2026-08-08: surface the per-subagent facts we already
hold. The `subagentStatusLine` COMMAND (half (b)) stays optional and unbuilt.

**Why this is a projection, not a feature.** Verified end to end:
- `effectiveThinkingLevel` (`pi-agent-server/src/orchestrator/spawner.ts:392`)
  resolves the child's effort by the documented precedence — session →
  frontmatter `effort` → invocation — then clamps to the model.
- It is a REQUIRED field on the child restrictions:
  `child-session-port.ts:23` `thinkingLevel: ThinkingLevel`.
- The host clones the restrictions wholesale into its record:
  `child-session-service.ts:130` `restrictions: structuredClone(input.restrictions)`.
- But the wire summary the renderer reads carries neither it nor the model:
  `packages/core/src/types/pi-harness-runtime.ts:141` `PiHarnessChildSummaryV1`
  has `inputTokens`/`outputTokens`/`costUsd` and no `effort`, no `model`.

So the value exists on the host and stops one step short of the panel.

**Doc anchor** — `statusline.md` § `subagentStatusLine` names the per-task fields:
"`model`", "`effort`", "`contextWindowSize`", "`tokenCount`". "The per-task
`effort` field is the reasoning effort set for that subagent, in its definition
frontmatter or on the individual invocation… The field reports the configured
value as written: if the model doesn't support that level, the effort Claude Code
actually applies may differ."

**That sentence decides one design question.** The page reports the CONFIGURED
value, while our `thinkingLevel` is already CLAMPED to the model. Those differ
exactly when a model cannot run the requested level. Carry the value we actually
apply — that is the honest one for a panel whose purpose is telling the user what
ran — and if both are cheaply available, prefer showing the applied value and
recording the divergence from the page's wording rather than silently relabelling.

**Scope:**
1. Widen `PiHarnessChildSummaryV1` with `effort?` and `model?`, appended LAST
   (it is a wire type; older payloads must keep parsing).
2. Fill them where the summary is built from the child record.
3. Render them on the agent-panel row (`AgentPanel.tsx` `toAgentPanelRows`), in
   keeping with the row's existing density — it is a compact row, so follow what
   `AgentPanel` already does rather than pasting a wide badge.
4. Playground swept per the owner's standing playground rule.

**What this pays off.** CDP `AGT-5` is BLOCKED today with "the effort each spawn
actually used is not exposed to the renderer — no field of the Pi runtime snapshot
carries it", re-confirmed on 2026-08-08 against the dev log as well. After this the
case can assert it. Update `docs/testing/cdp-live-checklist.md` accordingly.

**What must be PROVEN:** a child spawned from an agent whose frontmatter asks for a
higher effort than the session shows THAT effort on its row; a child that inherits
shows the inherited one; and the row is unchanged for a summary that carries
neither field (back-compat).

⚡ Wire type change (additive, last). One boundary check on the final diff.

## Tracker

| R | Unit | What it closes | Findings | After | Eff | ⚡ | ✓ | Commit | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R31 | `managed-settings-key-vocabulary` | Documented settings keys our strict parser strips, rejects, or enforces under… | f017 f110 f121 f163 f185 | — | L | ⚡ | ✅ | `parity(managed-settings-key-vocabulary)` | f163 split: a declared, b PARKED (2026-08-04-user-env-park.md); live cases MS-1..MS-5 |
| R32 | `hook-event-roster` | Widen the documented hook-event roster and fix documented-but-unemitted class… | f000 f079 f129 f224 | — | L | ⚡ | ✅ | `parity(hook-event-roster)` + `parity(message-display)` | all 4 findings; ordering race in the new async flush found and fixed by the orchestrator; live cases MD-1..MD-5 |
| R33 | `memory-load-limits` | The 25KB memory cap, and moving the 200-line cap onto the live route | f092 f098 f104 f172 | — | M | ⚡ | ✅ | `parity(memory-load-limits)` | caps on BOTH live deliveries; positive control verified by orchestrator; live cases ML-1..ML-3 |
| R34 | `mcp-server-config-and-connect` | What an MCP server config may say, and the environment and headers we connect… | f037 f041 f042 f044 f221 | — | L | ⚡ | ✅ | `parity(mcp-server-config-and-connect)` | all 5; f221 premise CORRECTED against mcp.md:115 (spawn env only, never the .mcp.json expansion env — the spec's positive test pinned the wrong outcome); merge-order positive control verified by orchestrator; executor deviations accepted: schema.ts descriptor carriage (required for persistence), connector-promotion guard for helper-declaring entries, stricter server-refusal on ${user_config.*}; CLAUDE_ADAPTER_VERSION 1→2; live cases MCP-N5..N8; follow-up candidate: parse-time user_config refusal for NATIVE manifests (adapter path covered; native literal fails inert in the shell) |
| R35 | `subagent-nesting-depth` | Subagent nesting depth: default 3 and its override | f076 f084 f130 f164 | — | M | ⚡ | ✅ | `parity(subagent-nesting-depth)` | all 4 (one knob, four pages); default 3 across all four definers; env pair NESSY_/CLAUDE_CODE_ host-resolved onto the manifest; `subagent` tool withheld at the limit on both branches (fork keeps it structurally — no fork path through the builder — spawner error enforces); legacy-hash + init-contract pins green; off-by-one positive control verified by orchestrator; stale R30 depth closure got its dated correction (r-queue-doc-verification.md); audit-row mirror + report regen deferred to wave close-out per wave convention; the 1 red in pi-agent-server is the registered lifecycle-bridge known-failing row; live cases SAD-1..2 |
| R36 | `builtin-session-commands` | Built-in session commands: /clear, /btw, /recap | f074 f124 f183 | — | L | ⚡ | ✅ | `parity(builtin-session-commands)` | all 3; wire = SessionCommand union (exhaustive switch = proof, all 3 tsc clean); overlay composed from EditPopover-inline + compact ChatDisplay per owner directive (ChatDisplay gained hideInput prop, no fork); recorded narrowings: `f` fork key omitted (no substrate), Pi prompt-cache side-question path not v1, /clear refetch keyed on own submission (other-client clears correct on reload); typed result DTO {success,text?,error?} (forced by empty-question error), slash.excludedCommandIds additive wire field; guard positive-control verified by orchestrator (disabled → exactly 2 host-path tests fail); claude clearHistory super-call + codex threadId override fixed en route; storage.clearSessionMessages deleted (caller-less, grep -a); follow-up: playground slash-command states not swept (owner playground rule) — fold into wave-final CDP prep; live cases CMD-N1..N3 |
| R37 | `shell-command-response-mode` | The shell-command response mode and its default | f228 | — | M | ⚡ | ✅ | `parity(shell-command-response-mode)` | f228; the spec's event-ownership inference did not hold on HEAD (adopted sendMessage path emits NO user_message) — the pre-authorized fallback shape shipped: runShellCommand keeps its single accepted event in both modes; validators.ts row REQUIRED beyond the spec zone (strict schema would brick startup on the new key); green pre-change pin rewritten as the documented false branch with the why-comment; branch positive-control verified by orchestrator; not-executed commands keep the OFF shape under either value; live case SHL-N1 |
| R38 | `worktree-lifecycle` | Worktree creation include-list, default-branch freshness, and post-removal cl… | f096 f097 f147 f159 f186 | — | M | ⚡ | ✅ | `parity(worktree-lifecycle)` | all 5 findings (f096=f147=f159 one fix); candidate git incantation MEASURED on a scratch repo (collapsed node_modules/, check-ignore 0/1); negation positive-control verified by orchestrator; hook flag rides create() call arg, never the persisted lease; live cases WTR-1..WTR-3 |
| R39 | `loop-and-self-paced-scheduling` | The /loop surface, its default prompt, and self-paced wakeups | f199 f200 f201 | — | L | ⚡ | ✅ | `parity(loop-scheduling)` | all 3; /loop bundled skill + loop.md resolver (project>user, 25k cap, delivery-time re-resolve) + dynamic records (jitter-exempt, 7-day-bound, nextFireAt) + ScheduleWakeup (registry/block/pi-only; delaySeconds [60,3600] clamped in handler, reason echoed, stop cancels; fallback = one ~20min wakeup then end); recorded deviation: f199's loop-interval.ts NOT built (no production caller — the unused-identifier trap; :52 puts conversion on the model, grammar lives in the skill body); CronCreate gained dynamic/promptSource (forced by composition — the only model-reachable creator); harness ledger re-pinned (54 tools) — same path R27b used; jitter positive-control verified by orchestrator; Esc renderer half = FOLLOW-UP (no natural idle-state hook; cancelProcessing no-ops when idle — needs its own RPC slice); seed.ts untouched (runtime enumeration); live cases LOOP-N1..N4 |
| R40 | `egress-and-provider-routing` | Proxy bypass parsing, provider routing env lists, and gateway request hardeni… | f093 f116 f118 f191 | — | M | ⚡ | ✅ | `parity(egress-provider-routing)` | all 4; f116/f118 merged into ONE leaf constant (9 names) both consumers import — the duplicate literal was the root cause; NO_PROXY whitespace at 3 sites + canonical comma re-emission (incl. network-runtime mirror per spec); postInit deletes ambient ANTHROPIC_AUTH_TOKEN (tier-2 > our tier-3 key); managed-env: 4 new routing rows + SKIP_MANTLE_AUTH as credential; redirect:'error' + wired timeouts on both model fetchers; redirect positive-control verified by orchestrator (stripped → nestor negative fails); follow-up candidate: adapter envOverrides neutralize OAUTH_TOKEN but not AUTH_TOKEN cross-session; live cases NET-N1..N3 |
| R41 | `permission-tool-classification` | Tool identity and state-change classification in the permission path | f021 f139 | — | M | ⚡ | ✅ | `parity(permission-tool-classification)` | both; TaskStop permissionName (5th arg only — static model-contract hash proven unmoved); browser plan-mode split: shared tokenizer moved to browser-tool-command-parse.ts so the gate uses the executor's parser, 13-verb read-only set with unknown=state-changing, state-flag family pre-emptively pinned (executor parses none today — chrome.md:111 pins), batch=all-read-only, ONE decision site (browser_tool left ALWAYS_ALLOWED), prompt names the command and remember scopes to it; recorded deviation: explore keeps its allow (spec's deny would flip default/acceptEdits via the mutation oracle — the spec itself called that widening its own decision); snapshot-declassify positive control verified by orchestrator (3 tests fail); pre-tool-use-checks.isolated 107/20 IDENTICAL on clean base — pre-existing; follow-up candidate: pi-agent addRules suggestion is tool-wide for browser prompts; live cases PRM-N1, BRW-N1 |
| R42 | `project-trust-home-carveout` | The home directory must not receive a persisted trust grant | f173 | — | M | ⚡ | ✅ | `parity(project-trust-home-carveout)` | f173; $HOME classifies process-only via the same realpath the identity uses (symlinked home covered); two compat guards (stored default-project pin cleared not thrown; recent record self-heals key-less); renderer re-prompt leg rides validateProjectDirectory (the snapshot field has zero renderer readers — spec's wire assumption corrected); carveout positive-control verified by orchestrator (3 identity tests fail); found+registered a NEW pre-existing branch failure (project-mutation active-turn row, register updated, master comparison on close-out list); pre-fix persisted $HOME trust rows become unreachable (harmless, prune not in scope); live case TRST-N1 |
| R43 | `deep-link-safety` | Deep links must not execute actions without a user step | f154 | — | L |  | ✅ | `parity(deep-link-safety)` | live cases DL-1..DL-5; disclosure copy verbatim from deep-links.md |
| R44 | `output-styles` | Output style placement, the two missing built-ins, and the project directory … | f193 f194 f195 | — | M | ⚡ | ✅ | `parity(output-styles)` | all 3; during-conversation reminder as a VOLATILE context part (defanged label, named subagents exempt, mini-preset guard added for truthfulness); Proactive+Learning appended (ids never reordered — persisted raw), prompts paraphrased, TODO(human) carried literally; nested walk cwd→projectRoot with nearest-wins + escape refusal; projectRoot threading = in-module .git climb — the spec's config-threading option proven a cwd→cwd NO-OP (canonicalPath tracks cwd, not the repo root); nearest-wins positive-control verified by orchestrator; known separate gap re-confirmed: settings picker still lists workspace-tier styles only; live cases STY-N1..N2 |
| R45 | `claude-informational-messages` | The informational system subtype dropped by the Claude event adapter | f081 | — | M | ⚡ | ✅ | `parity(claude-informational-messages)` | f081; SDK 0.3.215 exports the type (no local interface needed); level map warning→warning else info (unknown future levels collapse safe); warning banners PERSIST as role:'info'/infoLevel:'warning' (reportHookErrors parity — block reasons must survive reload), others transient; frozen-contract trio moved together; first-ever adaptSystem coverage + trailing-else debug for unknown subtypes; level-map positive control verified (clean re-run after a first ambiguous attempt); follow-up candidate found: reportHookErrors' own wire event is un-levelled until reload; live case INF-N1 |
| R46 | `keybindings-config` | The keybindings.json loader, action-id vocabulary, and contexts | f184 | — | L | ⚡ | ➖ |  | **CLOSED AS A DELIBERATE DIVERGENCE, owner decision 2026-08-08** (was ⏸). Verified before accepting: this app already has its own shortcuts surface — `apps/electron/src/renderer/pages/settings/ShortcutsPage.tsx` with 48 `shortcuts.*` locale keys. Claude's `keybindings.json` is a CLI config-file concept for a terminal client; we solve the same user need with a native settings screen. Not a gap, a different shape. |
| R47 | `goal-completion-state` | Goal completion must clear the goal and record an achieved entry | f175 | — | S | ⚡ | ✅ | `parity(goal-completion-state)` | f175; evaluator yes now TERMINAL (source-parameterized terminalGoal; validator accepts evaluator-sourced completion so it survives reload); achieved entry hooked at the single settlement call site via the return value (persist-callback alternative would double-fire); complete_suggested retained in all three unions for backward parsing; no second guard, no second invalidation — existing ones proven by test; both mutation controls green (executor's seam control + orchestrator's validator control); /goal renderer surface = separate unit (wire half exists unconsumed); live case GOAL-N1 |
| R48 | `web-search-budget` | The per-session web-search budget and its over-cap notice | f236 | — | M |  | ✅ | `parity(web-search-budget)` | f236; default 200, aliased env pair, strict parse; the over-cap NOTICE (never isError — an error invites the retry the page forbids); consume-before-call (failures aren't free); cross-tree accounting: absolute-at-spawn seed (webSearchesUsed) + subtree delta on result (webSearchesConsumed), cumulative-max fold — parallel fan-out overshoot is the spec's own recorded narrowing; /clear reset added by orchestrator (post-spec R36 landed it): subprocess dies on clear, so the HOST count zeroes in clearHistory or the next spawn re-seeds pre-clear — pinned; off-by-one positive control verified (4 tests fail); Claude-SDK/Codex search paths remain unbudgeted (blast radius); live case WSB-N1 |
| R49 | `host-diagnostics-rpc` | Host diagnostics: the git-bash filename predicate and /heapdump | f208 f210 | — | M | ⚡ | ✅ | `parity(host-diagnostics)` | both; **f210's spec was written against an OLDER revision of the page and the orchestrator corrected it live before dispatch** — the page now says `/heapdump` "doesn't appear in the command menu; type it in full", so the spec's slash-menu entry would have built the opposite of the contract (dropped), and the file base name is the SESSION ID, not the spec's invented `nessy-<role>-<pid>-<ISO>`; also dropped the spec's `server:heapdump` RPC channel + REMOTE_ELIGIBLE row + CLI subcommand (the doc binds the in-conversation command only) so it rides `sessionCommand` with no ipc-inventory churn; writer lives in `packages/shared/src/diagnostics/` because the Pi subprocess needs it and cannot import server-core; NO `isProcessing` gate — a dump must work on a wedged session, which is the feature's whole point; the model can NEVER trigger it (session-tools-core allowlist untouched: the snapshot holds every string in the process); privacy split is the contract — the `.heapsnapshot` is unshareable, the `-diagnostics.json` is counters-only and the summary says so; recorded narrowings: no growth-rate leak indicator (we keep no memory history), renderer process not dumped, no CLI subcommand; **also repairs an R48 defect this unit found: `runtime-behavior.json` never gained `web_search_usage`, so the frozen outbound union was red at 7/1 — R48's own gate missed it** (folded here rather than left red); two positive controls (enum narrowed → 2 fail; Desktop branch disabled → 1 fail); live cases HD-N1..N3 |
| R50 | `managed-policy-sources` | The missing managed-policy source channels and the policyHelper executable | f027 f108 f109 | R31 | L | ⚡ | ➖ |  | **DROPPED, owner decision 2026-08-08** (was ⏸). Follows the standing owner ruling of 2026-08-07: "there are no third-party administrators". The whole managed-policy delivery tier presumes a fleet administrator pushing policy to machines we do not have. Not deferred — out of scope for this product. |
| R51 | `sandbox-path-settings` | Sandbox filesystem key names, nesting, and path-prefix expansion | f022 f023 | R31 | M | ⚡ | ✅ | `parity(sandbox-path-settings)` | both; the documented `filesystem.{allowWrite,denyWrite,denyRead}` nesting accepted as canonical with the flat names kept as ALIASES (never removed — `foldSandboxRuleRoots` and `pi-agent.ts` produce the flat shape internally and on-disk configs carry it), two spellings concat-dedupe per `:413` "combined, not replaced"; all three prefixes expand BEFORE validation (`~/`→home, `/`→absolute per `:456` NOT project-relative, `//`→`resolve` normalizes onto the same string so the two dedupe, `./`/bare→scope root); user tier anchors at `CONFIG_DIR`, managed policy gets home-only and refuses bare entries by name (`sandbox-<key>-no-scope-root`) because a delivered policy has no directory to anchor to; orchestrator found and fixed a SECOND cap site the executor flagged out of zone — `sandbox-permission-rules.ts` read only the flat grant key, so a nested-spelling floor sent the rule-derived grant to a layer the floor then capped away (silent loss, fail-closed but wrong), and the merge now writes back into whichever key the floor used so both spellings yield the same list in the same order; two positive controls (tilde branch → 6 fail; nested cap → exactly 1 fail); recorded narrowings: `enabled`/`autoAllowBashIfSandboxed`/`network.*` are separate findings and stay refused with an explicit pin, drop reason renamed `not-absolute`→`no-scope-root`; release-ordering risk: a config written in the new spelling is rejected by an older build; live case SBX-N1 |
| R52 | `model-selection-defaults` | Fallback-model chain arity and per-model default effort | f107 f226 f242 | R31 | L | ⚡ | ✅ | `parity(model-selection-defaults)` | all 3; per-model default effort table + a SEPARATE hold list (`:453` covers every effort-capable model, `:455` names only Fable 5 / Opus 4.8 / Opus 4.7 — merging the two lists is the mistake the code comment now names); hold persisted as two keys (`defaultThinkingLevelExplicit`, `heldThinkingLevelModelId`) declared REQUIRED in validators because the envelope is `.strict()` and an optional key would have bricked startup; every explicit setter wired, including `SessionManager.setSessionThinkingLevel` (the `/effort` analogue) — missing one makes the hold un-clearable, which is worse than not having it; shipped `workspaceDefaults.thinkingLevel` REMOVED so the model default is reachable at all, safety argument verified against the real asset rather than assumed (an unmatched model still lands on `DEFAULT_THINKING_LEVEL` = medium, exactly what `"think"` meant); chain normalizer is a leaf module with no pi-ai import so renderer-reachable `storage.ts` may take it, dedupe BEFORE the cap per `:364` "capped at three after duplicate removal"; walk replaces the one-hop boolean with a cursor and the switch is TURN-SCOPED per `:364` — restore guarded so it only reverts a model the walk itself installed, since `updateSessionModel` has no in-flight gate and a mid-turn user pick would otherwise be silently reverted; three positive controls (cap-before-dedupe → 3 fail, restore disabled → 3 fail, hold's explicit check removed → 1 fail); **USER-VISIBLE: effort default rises medium → high on Anthropic-backed sessions (`xhigh` on Opus 4.7) — a real spend increase, and an existing user's stored level is overridden on their first Fable 5 / Opus 4.8 / Opus 4.7 session because they carry no explicit marker. That IS `:455`, and it is reversible by setting a level explicitly. Gateway/Pi sessions measured identical.** Also repaired a pre-existing red R44 left behind (`settings-default-thinking` was 0/3: its `mock.module` lacked the output-style getters). OPEN, recorded not silent: `:387`'s compaction rule (never fall back to a smaller context window) is DEFERRED with a code comment at `handleCompactResult`; the renderer's optimistic seed (`useSessionOptions.ts:32`) still hardcodes `medium` and will disagree with the server for Claude models until it asks; the `fallbackModel` SETTING has no UI surface (`syncConfigDefaults` overwrites the user copy) — the CLI flag/env is now the reachable channel; `"default"` alias expansion and the `availableModels` drop filter not built; live cases MDL-N1..N3 |
| R53 | `statusline-surfaces` | statusLine: the bottom status bar | f205 | R31 | L | ⚡ | ➖ |  | **DROPPED, owner decision 2026-08-08** (was ⏸): `statusLine` is "a customizable bar at the bottom of Claude Code" that runs a shell script per refresh — a terminal-client shape. **The subagent half was SPLIT OUT rather than dropped with it (f206 → R53b), because the owner's reason does not cover it** — see that row. |
| R53b | `subagent-status-row` | `subagentStatusLine`: the per-subagent row body in the agent panel | f206 | R53 | M |  | ⬜ |  | **Split from R53 and NOT dropped with it, because the CLI reasoning does not apply.** `statusline.md`: it "renders a custom row body for each subagent shown in **the agent panel below the prompt**" — a panel this app HAS (`AgentPanel.tsx`; CDP `AGT-2` drives it and asserts its rows). **The reason to keep it is concrete, not completeness**: its per-task payload carries `effort` — "the reasoning effort set for that subagent" — plus `model`, `contextWindowSize`, `tokenCount`. **CDP `AGT-5` is blocked today precisely because the effort a spawn actually used is exposed NOWHERE** (verified twice: absent from the Pi runtime snapshot the renderer reads AND from the dev log). So this row is the documented carrier for an observable we already know we are missing. Owner may still drop it — but on "we do not want per-row customization", not on "that is CLI". **Premise checked 2026-08-08 and it is BETTER than assumed — no API work is needed.** The owner asked whether we could ship this with default parameters and wait for the model API to offer effort switching. That wait is unnecessary: `effort` in this payload is "the reasoning effort **set for** that subagent" — OUR configured value, not something the provider returns. We already resolve it per spawn: `effectiveThinkingLevel` (`spawner.ts:392`) applies the documented precedence session → frontmatter `effort` → invocation, then clamps to the model, and the result is a REQUIRED field on the child restrictions (`child-session-port.ts:23` `thinkingLevel: ThinkingLevel`) which the host clones wholesale into the child record (`child-session-service.ts:130`). **So the value already sits on the host; the only gap is a projection outward.** That collapses this row from "implement a status-line runner" to two separable pieces: (a) **surface the per-subagent fields we already hold** — `effort`, `model`, `tokenCount` — on the agent-panel row, which alone closes CDP `AGT-5`'s observability block; (b) the optional `subagentStatusLine` COMMAND that lets a user re-render the row body. **Recommendation: do (a), treat (b) as optional.** (a) is small, needs no shell-script runner, and pays a debt we have already recorded twice; (b) is the customization surface and carries the same trust/`disableAllHooks` gates as `statusLine`, so it costs a runner and a gate for a cosmetic win. **Half (a) SHIPPED as R53c (2026-08-08); half (b) — the `subagentStatusLine` command that lets a user re-render the row body — remains optional and unbuilt, and would cost a shell-script runner plus the same trust/`disableAllHooks` gates as `statusLine` for a cosmetic win.** |
| R53c | `subagent-row-effort-and-model` | Surface the per-subagent `effort` and `model` we already hold on the agent-panel row | f206 (half a) | R53b | S | ⚡ | ✅ | `parity(subagent-row-effort-and-model)` | **closed — a projection, exactly as scoped**: the fill in `SessionManager` is ONE line, because the value was already resolved at spawn and already cloned into the host's child record; only the wire summary and the row were missing it. Both fields appended LAST on `PiHarnessChildSummaryV1`, and the parser validates `effort` against a closed set. **Ships the APPLIED value, not the configured one** — `restrictions.thinkingLevel` is post-clamp and the pre-clamp value is carried nowhere the host can read, so applied was the only one that exists, and it is the right one for a row whose job is saying what RAN. The divergence from `statusline.md`'s "reports the configured value as written" is recorded on the type and repeated in the CDP row. **A real trap found en route**: `getModelDisplayName('claude-opus-4-6')` returns **"Opus 4.8"** — it resolves through `DEPRECATED_MODEL_REPLACEMENTS` first, so the row would have named a version the child is not running, and precisely on the model where the effort clamp bites. `agentRowModelLabel` uses `getModelShortName`, with a test asserting no `4.8` reaches the row and the raw id stays on the `title`. Back-compat asserted as STRING EQUALITY, not `not.toContain`: a summary with neither field renders byte-identically. Executor ran two controls (break the fill → exactly the 2 seam tests; break the row copy → exactly the 2 render tests), each leaving the untouched subject correctly green; orchestrator added a third on the wire boundary (accept any string for `effort` → the protocol test fails), so validation is pinned too. **Closes CDP `AGT-5`**, blocked twice on this exact observable; its checklist row is rewritten to what the case can now assert. |
| R54 | `hook-input-payload-parity` | Documented fields missing or misnamed on hook stdin payloads | f002 f003 f004 f007 f009 f218 | R32 | L | ⚡ | ✅ | `parity(hook-input-payload)` | all 6; every documented key ADDED beside the existing one, never renamed (`cwd`+`new_cwd`+`old_cwd`, `file_path`+`event` beside `path`+`change_kind`) — the page's own CwdChanged example proves `cwd` and `new_cwd` coexist, so nothing downstream breaks; StopFailure `error` is a PROJECTION onto the page's closed ten-value vocabulary with `unknown` as fallback (our `rate_limited`/`service_error`/`invalid_model` are a different vocabulary — a rename would have shipped values the page does not define), `error_code` still emitted beside it and the MATCHER deliberately keeps passing Nessy codes through so existing matchers stay reachable; all three `effort` surfaces built (input field on the SessionManager wrapper so host-emitted SubagentStop is covered, `$CLAUDE_EFFORT`/`NESSY_EFFORT` for hook commands, and the Bash child env), reporting the CLAMPED level per `:707` and omitting the key entirely when the model has no effort support; **the plan's redaction premise was WRONG and the executor proved it rather than following it** — `redactedPayload` has ZERO runtime readers (`grep -ran`, only types.ts and tests), hook stdin is deliberately unredacted by a recorded decision at `hook-command.ts:671`, and `path` was never on the FileChanged row at all; the rows were grown anyway as inventory parity and the pre-existing missing `path` added; positive control on the `unknown` fallback (exactly 1 fail); recorded deviations: `event` is derived from a pre-write `existsSync` probe because `change_kind: 'write'` cannot tell `add` from `change`, `unlink` is unreachable and says so; `EFFORT_BEARING_HOOK_EVENTS` is the documented four only, since `:707` says "such as" and a superset would be a decision without a sentence behind it; `runDefaultCommand`'s Bash surface deferred (its only consumer declares `supportsThinking: false`, so the variable could never be set — threading env there would be dead code). **CONSEQUENCES TO WATCH: `compact_summary` is conversation content leaving the app for the first time — a user-configured WEBHOOK action on PostCompact now posts a conversation summary off-machine (`webhook-utils.ts` is a real action type); `NESSY_ERROR` becomes populated on StopFailure, changing behaviour for any automation that treated it as a tool-failure-only signal; and the execution receipt's `environmentDigest` shifts whenever the effort level changes mid-session.** Live cases HOK-N5..N6, HOK-N4 |
| R55 | `memory-import-recognition` | @path import recognition: position, file family, Markdown awareness, comment … | f099 f100 f101 | R33 | L | ⚡ | ✅ | `parity(memory-imports)` | f100 f101 closed, f099 PARTLY (see the new R77 row); **the plan's re-framing was confirmed by measurement** — `readMemoryFileWithImports` really is dead on the shipping route, so both flagship spec entries edited code no user reaches; the executor then found a THIRD live seam the plan itself missed and it is the decisive one: `memoryFileRecords`' walker (`native-sources.ts:458`) turns an imported file into its own capability RECORD, so in this architecture "expansion" is record DISCOVERY — a token the walker misses can never load no matter what the composers do; one stateful scanner now serves all of them (`memory-imports.ts`), `parseMemoryImportPath` deleted with zero remaining refs, and one shared body composer (`memory-layers.ts`) is called by BOTH live deliveries so they are byte-identical; **design deviation, and it is the right one**: literal inline splicing would DOUBLE-SHIP every imported body because the import is already its own layer — resolution happens against the VIEW, never disk, which also preserves a user's Sources-level disable (a disabled import stays unresolved rather than being re-read); whole-line tokens are replaced by the body, mid-line tokens keep the sentence and append the body, because `memory.md:104`'s own example is a sentence with two imports in it; depth 5→4 per `:97`; comment strip → caps → expansion, order kept so the budget is still measured against the file as written; three positive controls by the executor plus one by the orchestrator (depth reverted → exactly the two four-hop tests fail); recorded narrowings: code spans matched within a line only (an unclosed backtick would otherwise swallow the rest of the file), `@@` stays an escape but is not unescaped in emitted text (no doc sentence for it), indented code blocks are not code (only fences and spans, which is what `:99` names); open and NOT silent: the Pi route still ships a `rule` layer's raw body while the host applies `unscopedRuleBody` (pre-existing, R33 pinned it), a FOURTH recogniser survives on the legacy project-context route (`prompts/system.ts:parseContextImportLine`, line-start only, also dead behind the capability runtime), and capability generations shift once on first run because which files become memory records changed; live cases MEM-N1..N2 |
| R56 | `memory-write-feedback` | Post-write memory measurement, over-limit error, and frontmatter timestamp | f102 f103 f166 | R33 | M | ⚡ | ✅ | `parity(memory-write-feedback)` | all 3; **the plan's own framing of the frontmatter question was resolved by the page rather than by a workaround** — I had asked the executor to choose between stamping and stripping to avoid a per-write prompt-cache flush, and `memory.md:388` / `errors.md:1549` both say outright that YAML frontmatter and block HTML comments are STRIPPED before the index loads and excluded from the measurement, so the strip is doc contract and the changing `modified:` line never enters the pinned block; strip is gated by `isMemoryIndexLayer` — making it unconditional breaks `paths:` rules, which the executor proved with its own control; the f103/f166 contradiction settled once: over-limit returns an error response and the write is NOT rolled back (`memory.md:386` — the write succeeds and an error is returned), with "The write succeeded" inside the message text because `isError` is invisible on the Codex/Responses path; **package boundary forced a MOVE, not a duplication**: `session-tools-core` cannot import `shared`, so `capMemoryIndexLoad`, `stripBlockHtmlComments` and `fenceRun` moved DOWN into `session-tools-core` and `shared` re-exports the three previously-public names — measurement and cap now count the same bytes by construction rather than by keeping two constants in sync; orchestrator's own positive control: bypassing the strip pipeline fails exactly 3 (the byte-consistency fixture, the pinned-block test, and R55's import test), which also proves the two units' work is genuinely coupled; undocumented constants chosen and recorded: near-limit at 90% of either limit (the page says a reminder exists and names no number), byte rewrite target 17 920 = the same 70% share the documented 140/200 line target is; recorded: `errors.md` offsets moved 19 lines since the plan was written (content verbatim); `appendMemoryFile` stamps but does NOT measure — surfacing the notice on the UI path needs a wire field no doc sentence asks for; live cases MEM-N3..N4 |
| R57 | `mcp-roots-and-channels` | MCP roots capability and the channel notification envelope | f040 f134 f135 f136 | R34 | L | ⚡ | ✅ | `parity(mcp-roots-and-channels)` | all 4; **the security finding held: f136's change entry would have shipped a FORGEABLE fence.** It said to defang the channel body with `neutralizeHarnessMarkers`, whose tag list is closed and does not contain `channel` — so `</channel>` passed straight through and an implementer would have believed the hole was closed. Widening that shared constant was never viable either: 40 hits across 13 files, and it would have destroyed f136's own wrapper the moment f134 landed. Built as a channel-LOCAL escape with the order written into the docblock and at each step — escape body, build wrapper (attributes escaped separately so nothing is escaped twice), let the shared neutraliser run over the result; it does not know `channel`, so the fence survives while harness markers inside the body are still defanged. Proven by a POSITIVE CONTROL asserting `neutralizeHarnessMarkers('</channel>')` is a no-op while `'</untrusted>'` is not, so the local escape is provably load-bearing; orchestrator re-ran it (escape removed → exactly 4 fail, including the end-to-end hostile-body case); the f135/f136 guard contradiction settled once: `isMcpChannelMessage` REJECTS the whole message on a malformed `meta` — it is a type predicate, so "drop just meta" would require mutation and turn it into a silent normalizer, and the doc's silently-dropped rule is already honoured at PARSE, so the guard only fires when something bypassed the parser, which is the case it exists for; **roots deliberately EXCLUDE session `addDirectories` grants** — the pool is shared per (workspace, project), so one session's grant would widen what is disclosed to servers other sessions use; consequence recorded: the spec's pi-agent notify seam is not built because with this decision there is nothing to notify; change source is the config watcher's `onConfigChange` (previously an unwired callback with zero consumers), with the baseline seeded at watcher setup so the FIRST edit after launch is not the one change that never notifies; the read goes through a field seam matching the file's existing pattern, which kept R15's "exactly one direct caller" invariant at 1 rather than widening it to an allowlist; four docs-site pages corrected in the same diff, and the orchestrator additionally corrected two `docs/superpowers/` rows this unit SUPERSEDED — the audit's "the no-turn drop is the invariant a later feature will want to remove" is now that feature; channel subscription stays pi-only (not widened); harness ledger re-pinned; live cases MCP-N13..N14 |
| R58 | `tool-result-size-thresholds` | The tool-result persist threshold and its MCP-specific settings | f038 | R34 | M | ⚡ | ✅ | `parity(mcp-output-limits)` | f038; 25 000 default (`mcp.md:1040`) applied as an INJECTED limit, not a global raise — `TOKEN_LIMIT` stays 12 000 because its lowering carries a recorded reason and governs Read/Bash/api-tools, which this page does not bind; aliased env pair `NESSY_MCP_OUTPUT_TOKENS`/`MAX_MCP_OUTPUT_TOKENS`; passed at ALL THREE guards (pool, claude-agent `mcp__` branch, local-tools MCP branch) with `contextWindow` OMITTED at the two second guards — passing it can only lower the limit, which is exactly how a raise in the pool becomes invisible one layer up; `anthropic/maxResultSizeChars` now composes as INSTEAD in both directions per `:1041` (was raise-only, so a server declaring a smaller limit was ignored), still clamped at 500 000, and the declared allowance is now visible to the second guards via `declaredResultSizeCharsForProxyTool`; one predicate (`exceedsResultSizeLimit`) shared by `guardLargeResult` and `handleLargeResponse` so the two checks cannot disagree; positive controls on the pool limit and on the declared-below composition; **recorded gap: the over-10k warning (`mcp.md:246`) is emitted on the debug channel only — mcp-pool has no user-facing notice surface, so the DISPLAYED half of that sentence is still unmet** (needs a notice seam, filed as follow-up, not invented here); Pi subprocess sets `guardLargeResults: false` so its second guard never runs — the pool in the host is the one that matters; live case MCP-N9 |
| R59 | `headless-init-frame` | The headless system/init frame and its CI-gating arrays | f125 f133 f180 | R34 | L | ⚡ | ✅ | `parity(headless-init-frame)` | f125 f133 closed, f180 PARTLY (its `system/api_retry` half is explicitly separable and crosses AgentEvent/SessionEvent — deferred, recorded); **both error arrays were the point, and both would have failed silently in the gating direction.** `plugin_errors` is pinned to three DEMOTING diagnostic codes BY CODE, never by line range: `plugin.user_config.unredacted_sink` is non-demoting ("Substituted, not refused") and mapping it in fails a CI gate on a plugin that loaded correctly — orchestrator's own positive control confirms it (adding that code fails exactly the unredacted-sink test); and `plugin.dependency.*` is the same set as `dependencyErrors`, pinned against double-reporting by a test asserting the diagnostic IS present while the array has length 1; absence is asserted with `in`, never falsiness, because `[]` would pass a falsy check and defeat the gate; `mcp_server_errors` has BOTH producers as the plan required — native Sources/`mcp.json` parse failures, and plugin MCP capabilities the format adapter demoted to `unsupported` (which needed a new server-only `unsupportedReasonCode` so the frame reports a specific type rather than a flat `unsupported-runtime`); a demoting capability diagnostic demotes the WHOLE plugin from `plugins`, and both arrays are computed from one `demoted` set so they cannot disagree; casing is a deliberate documented mix (snake_case frame, camelCase passthrough); the stderr warning is gated on `isTTY` per the page's second sentence; `mcp_servers[].status` is `pending` at init because live health does not exist pre-first-turn, with a best-effort read so a RESUMED session reports real state; **executor caught one of the repo's own named traps in its own test**: a default parameter (`workspaceId = 'ws-1'`) silently applied to an explicit `undefined`, so the degraded-path case was exercising the bound path — fixed by making the parameter required; edited a file no spec named: `ipc-channels.test.ts`'s hand-maintained channel list (its generator script no longer exists); OPEN QUESTION for close-out: a Source with no recognised `type` is reported under `mcp_server_errors` — it may have been an `api` source, but the declaration is unusable either way and `unknown_type` is the page's own category; re-verify if a strict MCP-only gate is wanted; live cases HL-N1..N2 |
| R60 | `subagent-limits-and-child-output` | Subagent concurrency ceilings, output cap with disk spill, and instruction-sharing | f086 f090 f165 | R35 | L | ⚡ | ✅ | `parity(subagent-limits)` | all 3; **the plan's warning held — a flat 20 would have shipped the inverse of the finding.** The three ceilings now compose from ONE formula computed identically on both sides from env + `os.totalmem()`, so no manifest field and no hash moves: the subprocess counter always speaks FIRST and always with the documented `Concurrent subagent limit reached`; the memory ceiling is narrowed one runtime below it so it is structurally unreachable for a subagent child; the host backstop sits strictly above every legitimate scope mix, so `sub-agents.md:902`'s never-blocked fork holds by arithmetic without editing a persisted enforcement rule. **Honest number: the documented 20 is observed from ~42 GiB of RAM up; a 16 GiB laptop sees 7 and an 8 GiB one 3 — but WITH the documented message**, where a flat 20 would have produced `live-agent-ceiling-reached` at 8 and, for a background child, asynchronously as a FAILED subagent rather than a refused spawn. `NESSY_MAX_CONCURRENT_SUBAGENTS` wins outright and the host ceiling rises to follow it, which is the only shape in which the knob is not inert; two residues documented in comments (an ultracode session is exempt per `:898`; another of the user's sessions mid-turn is a busy occupant); **forgery guard built — the security point the spec never mentions**: a child could open its report with a verbatim `[harness: …: none]` and speak in the harness's voice. The hostile test drives exactly that and then asks for `--dangerously-skip-permissions`, asserting one undefanged marker survives, that it LEADS, and that it reads `harness-marker, permission-setting` rather than `none]`; **and the executor found a real bypass no spec listed**: control-character stripping ran LAST, so `<\u0001system-reminder>` missed the tag pattern, survived defanging, and became a LIVE `<system-reminder>` once the control pass deleted the byte — the same trick reassembled `Human:` and would have reassembled the forged marker. Stripping now runs FIRST; orchestrator re-ran the control (old order → exactly the reassembly test fails); spill uses the existing `saveLargeResponse` rather than a hand-rolled writer, per the plan; f090's `'turn-marker'` label dropped per the `:803`/`:804` pair; `readPiChildPartialOutput` deliberately KEEPS the fragment scan — it writes a durable record whose model-facing consumers mark themselves, so marking there would stamp the harness's voice into persistence and put two marker lines in one report; detection made tolerant of prior defanging so the outer boundary does not silently lose the label; orchestrator re-pinned two harness-contract shapes this wave moved (`RuntimeSkillHandle.overrideState` from R61, `mcpConfigSkips` from R59) and fixed a `/context` expectation R55 invalidated by trimming composed memory bodies; four tool-surface source digests re-pinned, the static model-contract hashes correctly did NOT move; live cases SUB-N1..N3 |
| R61 | `skill-visibility-settings` | The skill visibility settings key and its four states | f060 f171 | R30 | L | ⚡ | ✅ | `parity(skill-visibility)` | both; **the two specs carried COMPLEMENTARY HALVES of one rule and either alone leaves a hole** — merged rule is `off` refuses both origins, `user-invocable-only` refuses the MODEL only; proven by two positive controls, f060's rule alone fails exactly 2 and f171's alone fails exactly 3, and the decisive test invokes a slug the listing NEVER showed (`[skill:guessable]`) to prove a model cannot reach a `user-invocable-only` skill by guessing; orchestrator re-ran the model-origin control (exactly 2 fail); schema mirrored from the vendored Pi bundle's own `z.enum` rather than hand-rolled; `skillOverrides` added to `StoredConfigKnownFields` — load-bearing, the envelope is `.strict()`; stamped via a `.map()` where `nativeInventory` is assembled (f171's placement — f060's would have mutated records from inside a `.filter()` predicate); `name-only`'s description suppressed BEFORE the listing budget is charged, which is what makes it the documented way to free budget; `off` also leaves the `/` command list, which in this fork is one RPC surface; **PROJECT SCOPE implemented** though f171 marked it optional — without it the page's only named destination (`.claude/settings.local.json`) does nothing; trust-gated, fails open leg by leg, 1 MiB cap. Consequence recorded: a trusted project's checked-in settings can set `on` over a user's `off`, which is Claude's documented scope order and the same gate those files already use for permission rules; **generation invalidation added though NEITHER spec's change list had it** — an override state moves no `contentHash`, so a pinned snapshot would keep the pre-change listing; spread conditionally so no unoverridden catalog's generation moves; plugin exemption ASSERTED in two places rather than assumed; refusal is a parallel `refusedByOverride` channel so a hidden skill reports as hidden, never as missing; **orchestrator folded in a one-line defect this unit surfaced**: `disableBundledSkills` has a wired reader but was absent from `StoredConfigKnownFields`, and with a `.strict()` envelope that meant a user who set the documented key did not get it ignored — their whole `config.json` was REFUSED with `UnsupportedStorageLayoutError`. Declared, with a test for both halves; not shipped, deferred with the writer half both specs defer: the `/skills` menu's `user-only` label and any UI control; live cases SKL-N1..N2 |
| R62 | `scheduled-task-catchup` | Missed scheduled runs and per-task worktree isolation | f161 f162 | R39 | L | ⚡ | ✅ | `parity(scheduled-task-catchup)` | both; `desktop-scheduled-tasks.md:74` — on wake, exactly ONE catch-up run for the most recently missed time, anything older discarded, seven-day window, with a notification; `:70`'s second half keeps the in-session tick's skip-on-sleep behaviour, which is why cursors advance on EVERY tick and not only on a match; `:34` per-task worktree, default off; **the seed-never-fire rule is the load-bearing one and it has its own control**: an unseen matcher seeds its cursor rather than firing, so a fresh install, a corrupt read, or a task added by hand while the app was closed does not start a run for every task at once — orchestrator's control (bypass the seed) fails exactly 3, including the corrupt-file case; state reads fail CLOSED (missing/corrupt/malformed → `{}`), atomic temp+rename at 0600; **the orphan-worktree leak was traced FURTHER than the plan asked and is worse than 'a lease was lost' — RECORDED as its own row, not closed**: the lease store is PER SESSION, and `sweepOrphanedWorktrees` has exactly one caller, reached only when a **Pi** session builds its child-session port. So a worktree is reclaimed only if that same session restarts under Pi; a Claude- or Codex-backed session never sweeps at all, and finishing the run is enough — losing the lease is not required. Closing it safely needs a workspace-wide live-lease census (an on-disk walk from session A would see session B's ACTIVE worktree as an orphan, which is exactly what leases-only was protecting against) plus a decision about `recover()`, which throws for an active lease whose directory is gone. That is a contract change that deletes user data and does not belong in a focused unit. What keeps f162 from adding an unbounded leak: the toggle is default OFF and the lease rides the automation session's own record, so the existing strict-drain release and per-session retention do reclaim it; measured and previously unverified: croner's `previousRuns` is EXCLUSIVE of the reference — the planner's cursor comparison depends on it and it is now pinned by a named test; recorded follow-ups: renderer display of the worktree toggle not built (verified the flag cannot be DROPPED by the UI, only left invisible — `createAutomation`/`updateAutomation` have zero renderer call sites); history entries do not mark catch-up runs (`triggeredBy.catchUpForOccurrenceAt` carries it instead); **dirty-worktree drain hazard**: an isolated nightly task that edits files leaves its worktree dirty, and strict drain throws on a dirty release — pre-existing `EnterWorktree` behaviour that f162 makes the normal case; live evidence needs a packaged build (the wake listener is main-process); live cases SCH-N1..N3 |
| R63 | `marketplace-auto-update` | Per-marketplace autoUpdate and the managed pin | f025 f046 f047 | R31 | L | ⚡ | ✅ | `parity(marketplace-auto-update)` | all 3, three stages; `autoUpdate` carried managed→registry→wire with a DROP RECEIPT on a non-Boolean (strict Boolean — `"true"`/`1`/`"yes"` refused rather than coerced, because a coerced truthy string turns a typo into a standing background re-fetch of a code-distribution channel); resolution order managed → user toggle → documented polarity; **orchestrator overrode the executor here**: a bad `autoUpdate` originally dropped the WHOLE entry, matching the file's posture for `name`/`source`/`ref` — but those three IDENTIFY an entry while `autoUpdate` only modifies one, and taking a marketplace away from the whole fleet over a typo in an optional field is a far larger consequence than the typo; it now delivers with the flag absent plus the receipt, and the test was rewritten to say why; scheduler has an injected random+timer so no test sleeps, 600 000 ms ceiling, `unref`'d, honours `DISABLE_AUTOUPDATER` with `FORCE_AUTOUPDATE_PLUGINS=1` as the documented escape hatch, and never hot-swaps into a live session; **the suggestion allowlist is the security boundary and it is implemented in full** — an allowlisted NAME is not enough, the registered SOURCE must also be declared for that name (`extraKnownMarketplaces` entry, or `strictKnownMarketplaces`), `strictKnownMarketplaces === undefined` deliberately reads as "declares nothing" rather than "allows everything", and the official-marketplace exemption still requires the source to BE the official repo because this fork enforces no reserved-name list; orchestrator's own positive control confirmed it (source-binding half removed → exactly the two refusal tests fail); recorded gaps, NOT silent: the installed-plugin BUNDLE update half is unbuilt, so `discover-plugins.md`'s "updates installed plugins to their latest versions on disk" is STILL UNMET (deferred to R72 — it changes an existing RPC action's semantics), `/reload-plugins` has no analogue in this fork so the notification rides `emitPluginMutationInvalidation` with a new reason code pointing at Plugins → Refresh runtime, and only the `cwd` relevance signal is built (`cli`/`hosts`/`filesRead`/`manifestDeps` need per-session history this fork does not record, pinned by a test that a `cli`-only block is not promoted); `MANAGED_PI_POLICY_WIDENING_KEYS` grew 7→8; persistence: `marketplaces.json` gains an optional `autoUpdate` an older build ignores; live cases MKT-N1..N3 |
| R64 | `hook-output-and-process-env` | Hook output decision keys, the block-cap lever, and the hook env-file channel | f010 f216 (f012→R84, f141→R85) | R32 | L | ⚡ | ✅ | `parity(hook-output-merge)` + `parity(hook-session-directives)` | **f010/f216 are now END-TO-END; the second pass built the consumers the first pass could only carry.** A `SessionStart` hook that returns a session name now renames the session on disk, and one that asks for a skills reload gets it BEFORE the turn's manifest sync rather than after — proven by a test that spawns a REAL hook printing the page's own object through a real Pi turn, not by asserting the field parsed. The directive survives dispose+recreate (three new `AgentLifecycleState` fields) so a hook's rename is not lost to a runtime restart, and the callbacks are accessors so a title parsed before the host wired one is delivered on wiring instead of dropped. All three backends carry it (pi, codex, nestor-cloud); the Claude bridge still deliberately does not — R64's own recorded decision, since it would rename the SDK's session and rescan its skill dirs. Orchestrator's independent control: forcing `titleSetExplicitly = false` fails exactly the one test asserting a hook title survives the later LLM title, and nothing else — so the flag is load-bearing and the on-disk rename is proven separately from it. Executor deviation accepted and worth knowing: `titleSetExplicitly` also protects a user's own `/rename`, which is a small widening beyond the finding and is what stops the rename being visibly undone. `initialUserMessage` is parsed and carried but NOT consumed, correctly — hooks.md:1059 reads in full "Applies in non-interactive mode with the `-p` flag, where it becomes the first turn even if no prompt is provided", i.e. it CREATES a turn, and every Nessy surface runs SessionStart from inside `chat()` after a prompt is already accepted. **First pass:** \| **the merge defect was reproduced on UNMODIFIED code first, and it is worse than the plan said — it is live today with no new field involved**: two `WorktreeCreate` hooks each returning a path merge to `{}`, so the worktree gets NO path; and an `McpElicitation` accept-with-values merged with another hook's `additionalContext` returns only the context, so the accept and its values vanish and the dialog opens anyway. Fixed by making the base last-writer-wins over both objects with the five documented rules applied on top, so a field added later survives without editing the function again; plus one new invariant — elicitation content is dropped unless the winning action is accept, keeping the parser's accept-only rule true THROUGH the merge; **two more drop points the specs missed**: the NATIVE merge has always spread both objects, so two near-identical functions differed in exactly this and only the plugin one is reachable for imported hooks — the identical-bodies trap in reverse; and `parseHookOutputForEvent` gated the whole payload behind a can-decide check with a one-field escape hatch, which is the path `mcp_tool` and `http` verdicts take, so an http SessionStart hook's fields died there too; four decision keys landed with EXPLICIT per-event cases rather than a widened default — widening it would have handed a session rename to `Stop`, `PostToolUse`, `ConfigChange` and `PreCompact`; the documented source gate is ENFORCED (title dropped on clear/compact) in both executors, written as the exclusion half deliberately because an allow-list would silently kill every hook title from an emitter that sends no source; **f010/f216 are NOT end-to-end and this row stays 🔄 for that reason**: the consumers live in `base-agent.ts` and `SessionManager.ts`, both held by other executors at the time — the contract layer is correct and pinned, the wire is not built; **f012 and f141 NOT started, both refused deliberately**: f012's only constant lives in a file the executor did not hold, and a resolver with no consumer is dead code; f141's read-back is in two other packages, and minting the env var alone gives hooks a file whose exports never apply — the exact demos-perfectly-does-nothing shape this unit exists to stop. Both need their own units; also filed: `session_title` hook INPUT is absent repo-wide, and the page makes it the guard a hook checks to avoid overwriting a user-set title, so the feature is incomplete without it; the Claude-SDK bridge deliberately does NOT forward the new fields (it would rename the SDK's own session and rescan its own skill dirs), recorded as a comment at the branch; trap passed on: a hook-command test script must stay ONE LINE — the command is JSON-escaped and the shell receives a literal `\n`, so a multi-line script yields a hook that exits non-zero and decides nothing, which reads exactly like a merge that dropped the field |
| R65 | `memory-discovery-scopes` | Two missing instruction-file scopes: the cwd .claude/CLAUDE.md and the system tier | f068 f207 | R33 | M | ⚡ | ✅ | `parity(memory-discovery-scopes)` | both; **the plan's blocker was real and the executor REPRODUCED it before building**: `qualifiedKey` carries no path, so the naive implementation gives `<cwd>/.claude/CLAUDE.md` a key byte-identical to `<cwd>/CLAUDE.md` — and nothing fails, because the inventory is an array so both records survive discovery while every key-addressed consumer downstream folds them into one. Fixed by carrying the RELATIVE PATH in `logicalName`, POSIX-spelled so the key is identical on Windows (which is why the table is `{relativePath, logicalName}` pairs and not a string array), and by giving the system tier the `'managed'` discriminator — the field that already separates co-scoped tiers here; two collision tests with measured controls, one of them a standing guard asserting ZERO duplicate keys across a fully-populated inventory; orchestrator re-ran the control (collapse the logicalName → exactly 3 fail); managed tier is `CLAUDE.md` ONLY, not the whole project file set: `memory.md:279-281` names that one file and `:61` makes `CLAUDE.local.md` the PERSONAL per-project tier, so shipping it machine-wide and un-excludable would contradict its own row; no managed `MEMORY.md` invented (no page documents one); `claudeMdExcludes` deliberately cannot drop the managed tier per `memory.md:336`; ownership guard relaxed vs `managed-policy-loader` and documented in the helper: symlink rejection + no group/other write on file AND directory, owner root OR the current user — the strict `uid === 0` + `realpath` form is untestable without root and `realpath` fails for every macOS tmpdir; the property that matters (no OTHER unprivileged account can plant it) is preserved and now has a `chmod 0777` negative and a symlink case; `managed-policy.json` and the managed `CLAUDE.md` now join onto ONE shared path helper so they cannot drift; recorded: capability generations shift once on first run for anyone who has either file — but NO orphaned stored keys (verified: native instruction records never enter the policy or trust store, and the nested channel now suppresses the duplicate automatically); `InstructionsLoaded` can now carry `memory_type: 'Managed'`, a value no consumer has ever received; the managed tier is absent in safe mode, consistent with our posture; live cases MEM-N5..N6 |
| R66 | `headless-cli-flags-and-exit` | Headless flag names, exit codes, output cap, and session-retention default | f126 f176 f178 f179 | R59 | M | ⚡ | ✅ | `parity(headless-cli)` | f126 f176 f178 closed, **f179 PARTLY — and the executor's refusal to fake the rest is the right call**: nine documented flags (`--allowedTools`, `--append-system-prompt`, `--system-prompt`, `--settings`, `--mcp-config`, `--agents`, `--plugin-dir`, `--plugin-url`) need a `CreateSessionOptions` wire change plus permission-rule compilation in `SessionManager.createSession` — a wire + permission-decision double risk trigger — so they stay UNKNOWN FLAGS rather than being accepted as no-ops; and `--include-partial-messages`/`--forward-subagent-text` were deliberately NOT accepted either, because their contract is an opt-in default we currently violate (we forward unconditionally under `stream-json`), so accepting the name without the gating would make presence and absence indistinguishable and read as parity in the report; exit codes enumerated per terminal path, not invented: 0 on a completed stream; 1 for unknown flag (reported BEFORE any server, session or message), over-cap stdin, empty prompt, invalid `--json-schema`, no workspace, any body throw, and every `sendAndStream` failure; 130 on SIGINT and 143 on SIGTERM via `signalExitCode`, with `cleanup()` still running BEFORE the exit so the SessionEnd clause holds; the streamed-`interrupted` 130 is a different path and deliberately untouched; documented codes with no reachable path are named as such; 10 MiB piped-stdin cap with a `try/catch` added in `cmdRun` because `run` is dispatched OUTSIDE `main()`'s try, so the throw was escaping as an unhandled rejection; `--no-session-persistence` + the retention-default flip + `NESSY_SKIP_PROMPT_HISTORY`/`CLAUDE_CODE_SKIP_PROMPT_HISTORY` as a leaf module; `--permission-mode` accepts exactly our existing vocabulary, so it was a case label only; executor also fixed a decoder-flush bug it found en route (a multibyte character split across chunks was silently dropped) with its own test; orchestrator's positive control on `signalExitCode` (flattened to 1 → the table case fails); **widest blast radius is the unknown-flag gate, not the exit codes** — every command now rejects an unrecognised dash-token; `--stdin`/`--name`/`--strict` are allowlisted and `--` is the escape hatch; the only in-repo CLI caller uses known flags only; persistence answered rather than flagged: the retention sweep walks every workspace with no archive-only predicate, so headless sessions age out under the same policy; NOT observed live: SIGTERM against a packaged build — the SessionEnd-on-signal clause is still read off the call chain; live cases CLI-N1..N3 |
| R67 | `agent-memory-directories` | Per-agent memory directories and the prompt block that names them | f089 f148 | R30 | L | ⚡ | ✅ | `parity(agent-memory)` | both, as one change; **the plan's warning held and the executor picked the safe side of it**: the tool grant is applied HOST-SIDE ONLY, after every narrowing, so the pinned-tools re-validation still runs against the untouched author-declared list and `runtime-agent-tool-unavailable:write` never fires. Widening the host's declared set instead would have needed a SECOND carve-out, because the expected worktree policy is derived from that same declared list and a widened set flips a read-only agent to `isolated-worktree` — a consequence neither spec mentions; the decisive test uses a NON-BUILTIN pinned read-only agent (so the pinned-tools check really runs), asserts the precondition on the declared tools, then that the admitted record carries the granted trio, that the prompt names the absolute directory and quotes a sentinel from the on-disk MEMORY.md, and that the worktree policy stays `shared`; the same test covers two forgery attempts and a no-memory control byte-identical to today; orchestrator's control (empty the granted set → 1 fail); **FOUR restriction builders, not three** — the specs named two, the plan added the plugin-hook one, and the executor found a fourth (the guardian judge port, which builds from the builtin read-only scout and can never carry a scope, left alone deliberately); a fork declares nothing of its own and the host REJECTS a fork that sends a scope; the grant is BOUNDED by the parent tool ceiling rather than piercing it, and when the ceiling withholds write/edit the prompt block degrades to read-only wording rather than instructing a curate the agent cannot perform — which is the actual defect the finding is filed on; a symlinked state root DISABLES the feature instead of throwing, because here the user's request is the task, not the memory (unlike the scheduler, where scheduling IS the request); per-agent memory lives in its own module so it is structurally unable to merge into the session tier, and imports the index caps from `session-tools-core` rather than declaring a second limit; no digest moved; follow-up to re-file: f148's requested comment + regression test in `capabilities/native-sources.ts` (the behaviour it wants is already correct by construction — a nested agent-memory index is outside the scanned set) |
| R68 | `workflow-invocation-contract` | Workflow invocation: undefined args and the child permission floor | f094 f095 | R60 | M | ⚡ | ✅ | `parity(workflow-args)` | f095 closed; **f094 STOPPED AT THE ZONE BOUNDARY AND SAID SO RATHER THAN SHIPPING SOMETHING INERT** — the permission FLOOR (raise a workflow child to `acceptEdits`) cannot be built from the orchestrator: a workflow stage sends no `permissionMode` at all, the host clamp is narrow-ONLY (`clampPermissionModeToParent('acceptEdits','default') === 'default'`, asserted), so sending the request from pi-agent-server changes nothing; the seam is `SessionManager.startPiChildRuntime`, which was in the executor's do-not-touch zone. f094 remains OPEN; what DID land for it is the evidence: a new `workflow-permission-floor.test.ts` drives the REAL `createWorkflowTool` with no spawn override — real agent resolution, real `spawnChildSession`, real restriction build — and proves the CEILING holds: for every requested mode against all seven parents, the child's rank never exceeds the parent's; an agent asking for `bypassPermissions` resolves to `default` under a `default` parent, and a stricter `plan` request under an `auto` parent is still honoured. Positive control: honouring the request verbatim fails 2 of 3; f095: both `?? {}` coalesces removed (top-level run AND the nested `workflow()` helper) so `args` is genuinely `undefined` when omitted, per `workflows.md:225` — the page drifted two lines up from the spec; orchestrator's own control (restoring the coalesce → exactly the three-shape test fails); one out-of-zone edit, flagged by the executor rather than hidden: `handlers/rpc/sessions.ts` stopped attaching `args: { input: '' }` for a tail-less `/my-workflow` — it is the sole producer of `args` on the slash route, so without it the tool-level fix never reaches a real invocation; asserted on `Object.keys` because `toEqual` accepts `args: undefined`; **behaviour change worth knowing: a workflow script written against today's `{}` that does `args.input` unconditionally will now throw on a no-input run instead of silently reading `''`** — that is the documented behaviour, but it changes workflows saved before this; executor deliberately did NOT reword our own `promptSnippet`/`args` description (which still nudges the model toward the throwing shape): any model-visible string moves `PI_STATIC_MODEL_CONTRACT_HASHES.workflow`, a hash both host and subprocess compute, and fails a second contract test — measured, reverted, and filed as its own unit; only `workflow.execute`'s source digest moved |
| R69 | `skill-frontmatter-runtime` | Skill bash placeholders and the context/agent/hooks frontmatter consumers | f058 f062 | R61 | L | ⚡ | ✅ | `parity(skill-shell-placeholders)` | **f058 closed; f062 OPEN and structurally so.** The collision the plan named was settled by putting the substitution BELOW the branch rather than inside the formatter one finding routes around: one optional rendered-body parameter, one renderer, and all THREE consumers fill it from it — including the model-invocation continuation, where placeholders never ran at all before; **the record is untouched on purpose**: the invocation keeps its SOURCE text, so the digest, the budget assertion and the persisted continuation snapshot are unchanged and no volatile command output enters session state; the forked-route test is the proof the collision is resolved rather than avoided — a `context: fork` skill preloaded into a CHILD asserts the child prompt carries the substituted text, with a bundle-less sibling in the same admission keeping its literal placeholder as the plugin-gate control; without the parameter that test fails, because that route bypasses the formatter entirely; **backticks are now STRIPPED before execution** — they used to reach the shell as command substitution, which is why an `allowed-tools: Bash(gh *)` rule could never match; refusals are explicit and tested (a `!` after non-whitespace, anything inside an ordinary fence, an unclosed inline form, an unterminated block) and two refuse LOUDLY: an empty command, and a placeholder that arrived through `$ARGUMENTS` — the parse runs on both raw and expanded body and a grown count is an injection; child-route rendering moved to AFTER the admission decision so a DENIED subagent never runs the skill's shell; f062's fork DISPATCH is not built and the executor refused to half-build it: it needs a backend seam and a Pi RPC in files it did not hold, and reading `context`/`background` onto the record without a dispatcher would be a dead field — the unused-identifier trap. The collision is settled so the dispatch inherits rendered bodies by construction; executor also corrected a claude-parity evidence fixture whose observable this unit FALSIFIED, updating both halves of the asserted pair in lockstep; **re-verify live**: N placeholders now mean N Bash permission prompts, and on the child route they fire during subagent admission while the parent is mid-turn — the test stubs the executor, so that path is unproven live; the per-command output cap is 32 KiB with a 16-command / 128 KiB total, so one skill can add 128 KiB to a turn **CLOSED 2026-08-08: f062's dispatch landed as R69b** (see that row). Of the four ignored frontmatter keys: `context`/`background` now WORK; `hooks` is planned as R87 (a layer, not a field read); `shell` stays recorded-unimplemented DELIBERATELY — its only non-default value is `powershell`, gated on the PowerShell tool, and Windows builds are infra-blocked (no runner, five unmirrored GitHub downloads — see .gitlab-ci.yml), so on every shippable platform today the field would be a dead value; revisit when Windows builds unpark. Doc-default divergence recorded: the page says `bash`, our interpreter is `/bin/sh`. |
| R70 | `skill-discovery-precedence` | Descendant skill discovery and the global-over-project alias rule | f063 f170 | R30 | L | ⚡ | ✅ | `parity(skill-alias-scope)` | **[R78 has since CLOSED the bundled-tier blocker this row filed.]** **f170 LANDED; f063 BLOCKED and re-filed as R79** — every production file f063 needs (`native-sources.ts`, `base-agent.ts`, `views.ts`, `custom-commands.ts`, `storage-runtime.ts`, `capabilities/types.ts`) was held by a concurrent unit, and the resolver's own f063 term would have been unreachable dead code with no producer — the exact trap AGENTS.md names, refused rather than shipped; f170: `aliasScopeRank` beside the untouched `scopeSpecificity` (which layer ordering still needs), skills only — non-skill kinds keep the old rank so MCP nearest-scope and the subagent order do not move; **the plugin-origin hole was real and worse than the plan said**: plugin skills DO share the collision bucket (their `logicalName` is the bare slug), and the executor MEASURED it — applying the spec's literal kind-gated switch regressed a pre-existing test, a global plugin skill jumping over a native workspace one. Plugin skills now rank -1 at every scope, per `skills.md:122`'s second half ("Plugin skills use a `plugin-name:skill-name` namespace, so they cannot conflict"); an UNCONTESTED plugin skill still wins its own bucket and keeps the short name, pinned by its own test. Rejected alternative recorded: a separate per-plugin bucket would let two entries claim `selectedAsUnqualifiedAlias` for one name, which the alias map assumes is unique; **pre-existing bug surfaced by the measurement, NOT introduced here**: `storage-runtime.ts` hands plugin projection a `project` scope whenever a projectKey exists, never `global`, so a plugin skill already takes the bare name from a user's personal skill today; **BLOCKING CONSEQUENCE THIS CHANGE INTRODUCES — filed as R78 and must land before release**: this fork has no bundled tier. `ensureBundledSkills` COPIES bundled skills into the same personal root that is pushed at `global` scope, with no marker, so a seeded bundle is indistinguishable from a personal skill — and after the inversion it outranks a PROJECT skill of the same slug, which is the opposite of the doc. Four slugs ship (`loop`, `plugin-creator`, `skill-creator`, `code-review`). Recorded in-source in the `aliasScopeRank` docblock with the fix location; adjacent and deliberately untouched: the subagent arm has the same cross-scope plugin defect (R74 owns agents) |
| R71 | `code-review-contract` | The code-review entry point, target grammar, and the outcome field | f142 f143 | R20 | L | ⚡ | ✅ | `parity(code-review-contract)` | **both specs were STALE and the drift was invisible without the trailing clause — exactly what the plan predicted.** The effort sentence still literally contains the rule the spec quotes, but its last sentence demotes it: session effort is now the NEVER-TYPED FALLBACK, and the rule is that an untyped run reuses the last level the user typed. Implemented that way, with the fallback correct by construction; cross-session stickiness has no store in this fork and is recorded in-source; **four more drifts the specs missed**: `/review` is now an ALIAS of `/code-review`, not a wrong name — so f143's "rename it" was wrong; the fix rubric applies at every effort level; a re-report is an "updated findings list", not a new one; and FOREGROUND was the OLD default (background arrived in 2.1.218); `outcome` is an optional three-value enum where an UNKNOWN value fails the whole call rather than being stripped — the stripping was the defect, and the orchestrator's control confirms the enum is what enforces it (widen it to a string → exactly that test fails); it rides the RENDERED line, not only structured content, because nothing reads the latter here; target grammar gained `upstream` (the new default), `range`, `paths` and an explicit `scope`, every new ref/path through the existing safe-ref check; a new `code-review` skill is the entry point, model-invocation disabled; recorded deviations: no background mode (findings must return in the tool's own result), no GitHub/PR target (no such path exists — the skill REFUSES in words rather than guessing a bare integer is a PR), `ultra` degrades to the local review which the page explicitly permits, and `/review` cannot be a true alias because skills are one-slug/one-command — docs-site now says so instead of promising a command that never existed; three fixture digests moved (`session.report_findings`, `agent.review` source-state, and the review model-contract hash) and the gitignored subprocess bundle had to be rebuilt for a gate to pass; **executor also caught a false alarm honestly**: two automation fixture digests looked stale mid-run, it edited then fully reverted them, and re-running alone showed live == original — the concurrent-executor artifact AGENTS.md warns about, so nothing is owed to R62 |
| R72 | `plugin-install-and-dependencies` | Dependency acquisition and session-scoped installs | f048 f244 | R23 | L | ⚡ | ✅ | `parity(plugin-dependencies)` | **f048 closed; R63's deferred bundle-update half CLOSED here as the plan required; f244 re-filed as R80, which the OWNER then DEFERRED 2026-08-07 — so this row is complete for everything in scope.** Both premises were stale and the page had materially changed — the spec's anchor sentence NO LONGER EXISTS, and what replaced it ties this unit directly to R63; two further rules are new since the spec (auto-update picks the highest tag satisfying EVERY installed range and must name the constraining plugin on a skip; for non-git sources the constraint does not select a version, it is only checked at load); bundle update re-materializes only at a STRICTLY HIGHER semver — different-but-not-higher would re-fetch forever, because listing/bundle version skew is a tolerated, already-diagnosed condition — scoped to marketplaces that actually refreshed, so it inherits the allowlist gates; a catalog rollback does NOT downgrade (Repair does), chosen for idempotence; **the failure state is the substance and it is proven**: a plugin whose dependency has no satisfying tag returns `ok: false` with the available versions named, EXACTLY ONE install ran (nothing partial fetched, `installedDependencies` absent rather than half-populated), and the root's own bundle — which did commit — is INERT, because the pre-existing load-time verdict turns off every capability with `activationEnabled: false`. It never loads half its capabilities; tag listing needed no git binary: it hangs off the repository API base an existing helper already uses, through the same auth provider, and returns `undefined` rather than `[]` when unreachable — an unreachable listing must never read as "the upstream tags nothing"; **deliberately MORE conservative than the page**: the cross-marketplace refusal is unconditional because the widening half's allowlist is dropped at catalog parse and the parsed catalog is PERSISTED, so carrying it is a cache-schema change; the page's own escape hatch (install the dependency by hand) works and the error names the field; the deferred-record prose was corrected rather than deleted, because it still describes what remains. Orchestrator's control: disabling the refusal fails exactly 3; recorded: `no-matching-tag` is an install-time verdict only — after a restart the same plugin reads the less specific but equally disabling `dependency-unsatisfied`, because load-time resolution has no tag list without network; acquisition runs on the marketplace install route only, so a direct-source install still leaves dependencies to the load-time verdict; **executor corrected R63's own warning**: the three renderer tests said to break on `canUpdate` hand-build it as a fixture and would not |
| R73 | `hook-firing-and-await` | When lifecycle hooks fire, what trigger they carry, and whether the host waits | f001 f005 f006 f217 | R32 | L | ⚡ | ✅ | `parity(hook-firing)` + `parity(setup-hook-refusal)` | **f001 CLOSED in the second pass, by REMOVAL rather than by a firing rule — and the fresh fetch is what settled it.** The page defines every occurrence of `Setup` by a launch flag and closes with "For per-session initialization, use `SessionStart` instead", so our per-Pi-start emit was not an approximation of the documented event, it was the case the page explicitly excludes — and actively harmful: an author reaches for `Setup` (the page's own example is a dependency install) precisely to keep that work OFF the per-session path, and we ran it there every session. Building the launch modes was rejected with a reason, not on effort: the documented use case is a PLUGIN's Setup hook, plugin hooks exist only inside a pinned capability view, and that view is materialised by a session — so a CLI-only `--init-only` would fire the WRONG SUBSET (settings-file hooks, not plugin hooks) and would need a direct spawn outside the ProcessSupervisor isolation profile every other hook command goes through. A new code-execution surface bought to close a matcher gap. **The unit's hard condition — no author may end up with a silently-dead hook — was met by enumerating every registration surface and closing each with the REASON**: Claude plugin bundle, Codex plugin (both `Setup` and `setup`), native manifest, `hooks.json`, workspace `config.json`, `automations.json`, the `automation_management` session tool, the renderer event picker, and a backstop for a projection stored by an older build. The `automations.json` path is a WARNING not an error, deliberately, so one inert entry cannot take a user's working automations down with it. Structurally the removal is one deletion — the `Setup` row leaves `AGENT_EVENT_CONTRACTS_V1`, and that absence is what removes it from the union, the constant, the schema and every surface, so it cannot drift back; orchestrator verified 464 automations + 735 plugins tests green and the reason surfacing in the run output. Deviations recorded: `plugin.hooks.matcher_never_matches` DELETED (it would have become a zero-entry lookup) with a tombstone naming its revival condition; no migration for an already-stored `Setup` automation (dropped at load with a reason, nothing rewrites the user's file — flagged for the owner); `PI_ECHO_DROPPED_AGENT_EVENTS` deliberately NOT extended, verified rather than assumed (a stale bundle's echo reaches `executeAgentEvent`, which returns `matchedCount: 0` when no matcher can exist). One executor hand-off did NOT hold up: it reported `docs/testing/parity-wave-verification-checklist.md:446` as a stale citation of the deleted diagnostic code — that file does not exist, and `grep -a` across `docs/ packages/ apps/ scripts/` finds no reference to `matcher_never_matches` or `MATCHER_INERT_AGENT_EVENTS` at all, so there was nothing to fix. Still open and NOT this unit's: two stale `SessionManager.ts` comments (~7729, ~17182) claim closing the session-bootstrap route closes `Setup` too — it is closed another way now, but the route is still missing for `ConfigChange`/`UserPromptExpansion`. **First pass:** f005 f006 f217 closed. The plan's instruction to settle the three-entry inert list ONCE, up front, was followed and the reasoning is the unit's spine: `ConfigChange` and `UserPromptExpansion` left the list because their gap was a missing PRODUCER, not a missing matcher arm — so the producer landed in the same change and the arm with it. `Setup` STAYS, because its gap is a FIRING RULE: the page fires it only on `--init-only`/`--init`/`--maintenance`, launch modes Nessy has none of, and the fix must live in `apps/cli` + `base-agent.ts`. Adding the matcher arm alone would read a field nothing sets — the same dead filter under a new name. The spec's staged fallback was REJECTED for the same reason its own note gives: shipping half leaves authors a hook that registers and never runs, with no diagnostic; **the structural finding: there is NO session-bootstrap hook route.** The agent is built lazily and the only session-source `SessionStart` sits inside the turn handler — confirmed independently. That one fact now has three RECORDED symptoms rather than one hidden one: `Setup` cannot fire correctly at all; `ConfigChange` reaches only sessions that have already taken a turn; and `UserPromptExpansion` misses a session whose very first act is a slash command. The executor deliberately did NOT materialise the agent from the emitter to paper over the third — that would take a capability turn outside the send path, ahead of the lock `sendMessage` acquires moments later; `ConfigChange` fans out over the workspace's LIVE sessions because command hooks only have an execution authority per session — the workspace-level system would answer the page's own audit recipe with `command-hook-execution-authority-unavailable`; `UserPromptExpansion` emits PRE-resolution so a block really prevents the MCP prompt fetch and the model switch, and its interface method is OPTIONAL so partial harnesses and the frozen adjacent-backend contract still stand; f217 adds a real request/response pair so PreCompact can actually CANCEL a compaction, with the block reason substituted into the fixed cancellation string; `custom_instructions` was already there — R54 landed it, so the spec's "adjacent divergence" is closed; a new echo-drop constant is a deliberate SUPERSET of the gate list, because the packaged Pi bundle is prebuilt and a host against an older bundle would otherwise resume firing the per-turn copy this unit removed; **methodology trap the executor hit and recorded**: it made a verification worktree INSIDE the repo, and `bun test <dir>` treats args as filters — it collected the worktree copy too, ran every suite twice in one process and manufactured two failures from shared session-dir collisions. Put comparison worktrees outside the repo root; orchestrator re-pinned the harness contract for R79's `directoryQualifier` (field ORDER matters in that fixture); **the Pi bundle is stale and must be rebuilt before any packaged smoke** — degradation is graceful (an old subprocess never sends the new request and PreCompact stays advisory) but no packaged evidence was taken |
| R74 | `agent-definition-fields` | Agent definition fields: initialPrompt and name normalization | f211 f220 | R30 | L | ⚡ | ✅ | `parity(agent-name-folding)` | **f220 closed AND PROVEN to reach the dispatch route; f211 carried as far as this zone allows.** The plan's warning was confirmed by measurement in one process: `loadAgentDefinitions({runtimeDefinitions: []})` returns only the built-ins while `loadAgentDefinitions({})` leaks the machine's real `~/.nessy-agent/agents` entry — a positive control that the filesystem read happens in the `undefined` case and not in the `[]` case, so the gate really is closed on the route both findings care about. f220's fix sits in `resolveAgentDefinition`, AFTER the gate, and a before/after table through the exact dispatch-site option shape shows all six previously-throwing spellings now resolve; the fold runs on BOTH sides, which is what makes the rule symmetric — a definition declaring `name: Code Reviewer` was otherwise unreachable by the kebab spelling a model actually emits; and it is COMPARISON-ONLY, never replacing the storage normalizer, because that value is a Map key and travels the host→Pi descriptor, so folding it there would collapse two definitions into one; the reserved fork type is deliberately NOT folded (folding it would let `f-o-r-k` claim it while the writer-side block still only refuses the exact spelling); `prerequisite-manager.ts` folds on both sides too — without it the resolver fix is INVISIBLE under any `agent:` restriction, and the executor's control proves the two halves are independently load-bearing; f211 (`initialPrompt`) is carried on both definition producers but NOT forwarded to subagents, per `sub-agents.md:297` scoping it to the main session agent — that surface (`CreateSessionOptions.agent`, `createSession`, `--agent`) is R30c's already-recorded owner-level deviation and stays open; a YAML block scalar is OMITTED rather than rejected, because rejecting would make an imported Claude agent using `initialPrompt: \|` DISAPPEAR from the session over a field nothing yet consumes; four positive controls by the executor, one of which exposed a weak assertion in its own test (a field-dropped and a definition-dropped read the same) and was tightened; **orchestrator note: my own positive control initially damaged this file** — two functions had byte-identical bodies at that moment and the control replaced the wrong one, silently turning the storage normalizer into a fold and failing six tests including pre-existing ones; caught, restored from HEAD, and the control re-run correctly against `foldAgentName` alone (3 fail). Recorded because it is the `git commit <pathspec>`-adjacent trap in a new dress: an identical body is not an identifying one |
| R75 | `custom-command-expansion` | Custom slash commands: skill precedence, positional arguments, and multi-skill | f144 f145 f149 | R30 | L | ⚡ | ✅ | `parity(custom-command-args)` + `parity(hook-session-directives)` | **f144 closed in the second pass, and the trap the first pass recorded is exactly what made it non-trivial.** Dropping the skill-name reservation alone would have produced TWO identically-labelled `/review` rows, and typed dispatch matches by label in array order — native first — so the user would still have got the shadowed command file: strictly worse than before. The fix is therefore in TWO places, and a single private `skillReservedNames()` feeds both so they cannot drift: the loader no longer reserves a skill's name, and the listing filters native entries whose name a skill claimed. `source === 'workflow'` still reserves, because a workflow genuinely owns its name. End-to-end proof is the shape the finding is about: with `.nessy-agent/commands/review.md` on disk and a `review` skill, the summaries are exactly `[custom:skill:deploy, custom:skill:review]`, the `/review` label matches ONE row, and resolving it returns the skill. Executor's positive control removed only the caller-side filter and that test failed — i.e. the control reproduces the two-row defect the first pass predicted. Deviation: the shadowed `custom:review` id stays RESOLVABLE, deliberately — the native lookup short-circuits before any capability snapshot, so failing it would cost a snapshot resolve on every native resolution; the documented sentence is about what is listed, nothing in the UI mints that id any more, and a test pins it. **First pass:** — its behavioural half is unreachable from this zone, and removing the drop without the caller filter yields TWO `/review` rows where typed dispatch matches by label in array order (native first), so the user still gets the command file: strictly worse than today. The patch and the two tests to invert are named in the report; the file is clean for whoever holds it; **f149 was composed OVER f145 rather than reverting it, which was the trap**: f149's own change text re-introduces the exact regex f145 deletes. There is now ONE expander call site — f149 changes only what it is called WITH, so a stacked skill body inherits f145's positional table, its `{{args}}` normalisation and its MCP guard for free, where the spec's regex would have silently removed positional support; **absent ≠ empty, the same distinction R68 got wrong for workflow args**: `skills.md:353` — an indexed placeholder with no argument stays VERBATIM, a named one with no argument expands to EMPTY. All three cases tested separately; the MCP guard is an addition beyond f145's literal list and it is what makes the composition safe — an MCP prompt body is server-authored prose whose arguments were already consumed, so running the richer table over it would rewrite a literal `$1.00`; the old two-token regex was less likely to corrupt, the new one would; **the executor corrected the orchestrator's own instruction and was right**: I wrote that the `/loop` stop-rule clause has no analogue here; the forked-subagent HALF has none, but `/loop /babysit-prs` is the skill's own documented no-interval form and `LOOP_SKILL_SLUG` is live — without the rule that command would stack as a sibling instead of being handed to `loop`. Kept; orchestrator's control (empty the stop list → 2 fail) confirms it is load-bearing; f149 implemented server-side with NO wire change: the spec would have widened a positional RPC parameter through six renderer files and a frozen fixture, but the stop rule is a RESOLUTION question and resolution already lives in the handler — frozen contract untouched and green; deferred to whoever holds `plugins/**`: `DYNAMIC_SUBSTITUTION_PATTERNS` still defers `$1` as unsupported, which is now a FALSE compatibility warning since it works — one-line deletion plus one test edit |
| R76 | `plugin-bundle-component-shapes` | Doc-conformant plugin bundle layouts and plugin-provided settings | f053 f054 | R23 | L | ⚡ | ✅ | `parity(plugin-bundle-shapes)` | **the component-table diff AGENTS.md demands was actually run and is reported**: all 13 file-location rows and all 13 component path fields accounted for against the adapter's discovery constants — NO rename and NO new component type, so the recurring failure mode did not occur; `settings.json` was the single documented row with no reader, which is exactly f053, and it now has one; **f053's fixture change entry was WRONG, not stale, and reading the bytes is what showed it**: the fixture is 11 lines with `deferred: []` and a bundle declaring only `outputStyles` — there is no settings row in it to rename, and the suites that read it assert the EMPTY list; the row that actually needed updating was a different, unnamed one; reader merges `settings.json` OVER `plugin.json`'s `settings` per key, keeps only the two supported keys, and emits one deferred row PER unhonoured supported key actually set — so a bundle setting neither reports `supported` rather than being charged its activation grants for a file the docs call ignorable (observable change, recorded); `'skills-dir'` origin shipped as an IDENTITY with no producer, and the orchestrator kept it after reading the reasoning rather than applying R70's dead-code refusal: this participates in no decision, it PINS A NAME that is a string on disk in two places (`pluginKeyFor('skills-dir', …)` makes the documented `<name>@skills-dir` key, and managed settings block the source by that literal), so fixing the spelling before either half ships is what stops the two halves disagreeing later; the four missing halves are named inline; f053 step 2 (honouring a plugin's `agent` default) NOT built — its own spec gates it on an owner decision and it contradicts a standing recorded refusal; recorded in the IR and refused with an install-time diagnostic instead; no new capability KIND (that would touch a wire enum and six forbidden files) — the descriptor rides the existing extensions object, the file's own stated precedent for "the whole plugin, not one capability"; doc drift corrected: the spec's `plugins.md:209`/`:298-308` are `:184`/`:271-283` today, and `strictKnownMarketplaces` is `:905` not `:912` — new comments cite SECTIONS, not line numbers; retired reason code may exist in installed records and displays harmlessly; orchestrator's positive control on the settings filename (3 fail) |
| R77 | `instruction-file-imports` | `@path` imports inside CLAUDE.md / AGENTS.md — the file family the doc sentence names | f099 (part B) | R55 | M | ⚡ | ✅ | `parity(instruction-imports)` | **the plan's warning was the whole unit: the naive rule ships a GREEN unit that changes nothing for the page's own flagship example.** `memory.md:129-137` shows a CLAUDE.md whose entire body is `@AGENTS.md`, but AGENTS.md is registered as its own root record BEFORE CLAUDE.md is walked, so a shared `seen` set leaves the token unresolved. Solved by an ADOPT rule in the composer: a token resolves to (1) a declared child, else (2) a ROOT layer already in the view at that path — marked inlined so it ships ONCE, inside the importer — else (3) empty when that layer is already inlined elsewhere, because leaving the raw `@path` tells the model about a file while showing it nothing. No layer at all → the token stays verbatim, preserving R55's "resolve against the VIEW, never disk" invariant so a Sources disable is never reached around; the flagship test asserts the CONTENT arrives inside the importer's own block, that `@AGENTS.md` is absent from the prompt, that the body appears EXACTLY ONCE, and that Pi's descriptor carries the identical body — orchestrator's control (adopt clause disabled) fails exactly that one test with an empty body, which is the green-but-empty mode the pre-flight named; an imported instruction file is an `instruction` RECORD carrying its parent path — the alternatives were measured and named: a `memory` record makes the flagship WORSE (the sibling exists under two kinds and ships twice) and would list a `@README` as a memory file in Sources; reading disk loses the Sources entry, the user disable and the `InstructionsLoaded` entry, and re-opens double-shipping; **costs named rather than discovered later**: an adopted sibling MOVES to the importer's slot in layer order (which is where `:95` puts an imported file, but it is a move); an adopted root reports `load_reason: session_start`, not `include`, because it is not there because of the import — only a DECLARED child reports `include` + `parent_file_path`; generations shift once on first run; `instructionImportOwnedElsewhere` guard is load-bearing, not cosmetic — control 3 shows that without it a project `MEMORY.md` flips from a `memory` record to an `instruction` one, silently removing the 200-line/25 KB index cap, and a `paths:`-scoped rule would be promoted to unconditional; instruction discovery reads the WHOLE file rather than the 200-line memory slice, or an `@path` past line 200 would ship while its target was never registered; the managed-tier instruction file deliberately does NOT walk imports (it is un-excludable by design and the walker emits excludable children); nested on-demand bodies still do not expand, recorded with the reason; executor touched three files beyond its two, all justified — one of them (`context-resource.ts`) MANDATORY, since leaving it would ship an expanded body to the model and the literal `@AGENTS.md` to `/context`, the exact bug R33 and R55 each fixed |
| R78 | `bundled-skill-tier` | A seeded bundled skill must not outrank a project skill of the same name | — (from R70) | R70 | S | ⚡ | ✅ | `parity(bundled-skill-tier)` | closes the release blocker R70 filed against its own change; rank is now `global 4 / workspace 3 / project 2 / bundled 1 / builtin 0 / plugin -1`; **the marker is PROVENANCE, not content, and the reasoning for that is the good part**: it asserts only "this record sits at the seeded slug path for a slug the packaged bundle currently ships", so a user who EDITS a seeded skill in place keeps the tag, and so does someone who authored their own skill at a bundled slug before first run. Nothing on disk could say otherwise — the seed policy is seed-once by slug existence, never overwrite, no marker written. Accepted deliberately because that same identity is ALREADY what `disableBundledSkills` uses to delete such a skill from the catalog and what the origin lock uses to keep it under a locked surface: a content-sensitive third answer would make three decisions disagree about what "bundled" means, which is a worse defect than the mis-tag; and the consequence is narrow — the record stays in the catalog, stays enabled, stays reachable by its qualified key, and loses only the BARE name, only to a skill that actually claims it; an uncontested bundled skill still wins its own bucket (pinned); **deliberately NOT hashed into the generation**, with the argument written down: the tag's only consumer is the rank, whose entire output is `selectedAsUnqualifiedAlias`, which IS hashed — so every path by which the tag changes an observable is already covered, while hashing it would hand a fresh generation to EVERY already-seeded profile on the first launch after this lands, for nothing. Pinned by a PAIR (no-collision profile: byte-identical generation; collision profile: different); `native-sources.ts` proved unnecessary (a skill's source path is already the slug directory the seed predicate matches), so R70's dead-code refusal does not recur — the resolver term has a real producer; a cheap path gate went INSIDE the seed predicate because this is its first caller that asks about every record on every resolve; orchestrator's positive control (rank line deleted) fails exactly 4, and the unit also carries a PERMANENT control inside the decisive test that strips the tag off the same real records and asserts the bundle takes the name back, so it cannot silently rot |
| R79 | `descendant-skill-discovery` | Skills discovered below the cwd, and their qualified `/dir:skill` form | f063 | R70 | L | ⚡ | ✅ | `parity(nested-skills)` | closes R70's other half, which R70 correctly refused to half-build; **the rank term now has a real producer, so the dead-code refusal does not recur**; **the best moment in this unit is the executor discarding its own first test**: with two same-tier records the project root wins on the LEXICAL key whether or not the rank term exists, so the control PASSED and the test proved nothing. Rewritten around a case where the term is genuinely load-bearing (a nested `.nessy-agent` skill against a root `.agents` one, where tier rank alone would hand the package the bare name); orchestrator re-ran it — neutralising the term fails exactly 1; **architectural deviation, stated not hidden**: the spec's delivery route threads roots through two forbidden files, so instead a process-local registry lives beside its only consumer and `BaseAgent` emits on the EXISTING typed invalidation bus whose live subscriber already refreshes before the next turn — zero forbidden files touched. Cost named: the bucket is keyed by (workspace, project, cwd) rather than by session, because the policy context carries no session id, so a sibling session on the same trusted project and cwd sees a root its neighbour activated — additive, trust-gated, containment-checked repository content it would have found on its own next read there; **it is not a tree walk** — only the chain from a touched file up to the cwd is probed and a directory is admitted only if it actually holds a skills dir, so steady state is ≤16 directory reads per turn; bounds are 8 roots per bucket, depth 32, 32 FIFO buckets, a skip list that disqualifies a directory AND everything under it, and any segment containing `:` is rejected because `:` is the separator in both the qualified name and the record key; a nested record only exists after a touch, so NO profile's generation moves at rest; collision tests both ways: a nested `deploy` against a project-root one (both retained, root keeps the short name, nested reachable qualified) and against a GLOBAL one (global wins, R70's inversion untouched); **the executor introduced two literal NUL bytes into `native-sources.ts` through strings it wrote, caught them itself and scanned every changed file** — the repo's own named trap, self-inflicted and self-found; orchestrator re-verified byte-accurately: zero NULs across all seven changed files; not built and recommended as a follow-up: appending the qualified-variant list to an unqualified skill's content on invocation crosses the skill-invocation persistence boundary, a materially different risk from discovery; `.claude/skills` is still read at no level (separate rebrand gap); display-only residue: a `[skill:apps/web:deploy]` CHIP falls back to the bare slug in the renderer, server-side resolution is correct |
| R80 | `plugin-sideload-and-zip` | Session-scoped plugin side-load and the plugin-layout .zip | f244 | R72 | M | ⚡ | ⏸ |  | **DEFERRED BY OWNER DECISION 2026-08-07: not needed.** `--plugin-dir` / `--plugin-url` are a DEVELOPER surface — they load a plugin for one session with no install record, so an author can test a build artifact or shadow an installed plugin without uninstalling it. Our distribution path is an internal marketplace, so the scenario does not arise. Recorded for whoever reopens it: the capability is NOT missing — `plugins/mcpb-archive.ts` already opens zip via `yauzl` and carries `isZipArchive` for generic archives, because `.mcpb` import IS zip extraction and ships today. The blocker was a POLICY rule, not a gap: that extractor refuses any executable entry that is not the declared binary server, which is right for `.mcpb` (one server) and wrong for a plugin zip (an executable hook is ordinary). Reopening means choosing between refusing such archives and stripping the exec bit with a diagnostic; the orchestrator's recommendation was the latter, since it neither regresses `.mcpb` nor rejects valid plugins. |
| R81 | `plugin-update-availability` | `availableUpdateVersion` and the `canUpdate` action | — (from R63/R72) | R72 | M | ⚡ | ✅ | `parity(plugin-update-availability)` | **closed once R82 landed the surface** — the row was held open deliberately because a truthful wire nobody can see is not the feature. \| **the per-turn perf question was settled BEFORE the read shipped, with evidence — which is why this was deferred twice.** `listItems()` is disqualified three times over, all citable: it `await`s a delivery step that WRITES `marketplaces.json`; an uncached registry gets a git clone kicked off the request path; and a registry whose last fetch FAILED has its retry budget decremented, so a per-turn caller would silently spend the retries the browse list is meant to spend. There was no cached-only bulk path, so the smallest one was added: read the persisted rows, serve the in-memory catalog on a signature match, hydrate from the ON-DISK parsed catalog on a miss, return nothing for an unresolved registry. Five tests pin it, **each with a positive control on the same rig** showing `listItems` does the thing being avoided (clones / writes / spends the budget); sync in-memory-only was rejected deliberately: after a restart nothing has browsed, and the bundle-update pass only runs for auto-update-ON marketplaces — which the page makes the MINORITY, since third-party and local default off. Disk hydration is what makes the badge survive a restart with zero network; the badge honours the dependency hold: a held plugin whose catalog latest is outside the intersected range gets NO badge, because that badge would be a control that either does nothing or breaks the dependent; when the catalog version does satisfy, it is advertised as-is rather than as the highest satisfying tag the write side resolves, because naming the tag needs a network listing this read must never do — an honest floor; the write side's two private copies of the join and the comparison were DELETED and now import the shared module, so read and write cannot drift; **R63's warning was wrong and more so than R72 said**: the three renderer tests hand-build the action as a fixture AND no renderer production code reads either field at all, so the field could not have broken them; **OPEN, and the reason this row is 🔄: the user is still not told.** The wire is truthful now, but the renderer's lifecycle hook declares an update request and implements only uninstall and repair — there is no update hook and no affordance. Surfacing the badge is an `apps/electron` unit; filed as R82 |
| R82 | `plugin-update-affordance` | Surfacing the update badge and wiring the update action in the UI | — (from R81) | R81 | S |  | ✅ | `parity(plugin-update-affordance)` | closed; **the unit's whole value is part 4, and it is the part a scope-reading of the row would have skipped**: `plugins/cli-reference.md#reload-plugins (was line 703 of the retired plugins-reference page)` says a mid-session update leaves every hook, MCP server and LSP server on the PREVIOUS version's path, so a bare success toast is a lie — the successful update now carries the reload instruction itself. Two executor deviations, both accepted and both improvements on my instruction: (1) the Update item is **withheld** rather than shown-disabled like Repair, because `plugins/install.md#manage-installed-plugins (was line 319 of the retired discover-plugins page)` lists the installed verbs as "view, enable, disable, or uninstall" and a permanently-greyed fourth verb is exactly the always-present verb that list excludes; (2) `plugins.autoUpdateNoticeTitle` is deliberately NOT reused — it reads "Marketplaces updated in the background", which is false the instant a user clicks Update, so only the BODY (the load-bearing "Refresh the plugin runtime…" instruction) is reused under a new title. `AppShell` untouched, so trap 1 holds: its toast stays keyed on `MARKETPLACE_AUTO_UPDATE_REASON_CODE` and enable/disable/uninstall still never toast a reload notice — pinned structurally, since Radix portals the menu and this package has NO DOM harness (renderer tests are `renderToStaticMarkup` only, verified — no jsdom/happy-dom in the lockfile); three positive controls run in both directions, the notice control failing exactly its 3 tests and nothing else; orchestrator re-verified the file scope, because R73's concurrent `Setup` removal also touches `apps/electron` and would otherwise have been swept into this commit by the working-tree pathspec trap; **remaining gap, filed as R83**: `installed.actions` is read by `DetailActions` and nowhere else in the renderer (`grep -a`), so the badge reaches the plugin DETAIL view only — a user who never opens it is still not told |
| R86 | `background-result-delivery` | A background subagent's or workflow's result must reach the MODEL, not only the UI | — (from the 2026-08-07 agent-system analysis) | — | M | ⚡ | ✅ | `parity(background-result-delivery)` | **closed by adding one PRODUCER to the delivery path the page already describes, not a second path.** `task_completed` now reads the recorded kind BEFORE the delete in its own handler and hands the completion to `deliverMonitorEvent`, inheriting its three rules verbatim — idle starts a turn, busy groups in arrival order without steering the running turn, pre-first-prompt is held so a machine event never becomes the session's opening message. **The trap was the point and it is proven end to end**: a FOREGROUND subagent already returns its result as the tool's return value, so notifying would double-report and spend a turn per child. The gate is the recorded kind, not a heuristic — a foreground run keys `task_completed` on the orchestration `runId`, never the `task-<runId>` that `task_backgrounded` announces, so the lookup misses. The test drives the REAL `PiEventAdapter` over a real foreground tool result and asserts zero deliveries. `stopped` is excluded too: teardown aborts every registered task, and notifying there would start a turn on a session being disposed. Executor ran two controls (routing broken → exactly the 7 delivery tests fail; gate removed → exactly the 3 negatives fail). **Orchestrator ran a third on a different axis**: moving the kind read AFTER the delete — the ordering a later edit could plausibly introduce — fails 7 tests, so the ordering is pinned and not merely commented. **Accepted deviation on scope item 3**: no `get_workflow_result` was added. A background workflow's result now rides the same completion notification carrying its actual textual output, which IS the mechanism the page describes; a retrieval tool is a fallback the page never asks for, and building it needs a new in-process result store plus manifest/binding/fixture entries outside the zone. **Honest remainder**: a workflow summary past the 4 000-char notice cap leaves the script's own `log()` lines reachable only by the human on the task card. Tool descriptions fixed as part of the unit — they told the model to watch `task_completed` (host/renderer-only) and otherwise to poll with `wait:true`, which is a BLOCKING poll and the opposite of what the page prescribes; three model-contract hashes re-pinned, with the pinning method itself validated by reproducing three EXISTING pins byte-for-byte first. Evidence: 17 new tests; `packages/server-core/src/sessions/` 618 pass / 0 fail; typecheck:all + apps/cli clean; lint 0 errors. |
| R69b | `skill-fork-dispatch` | The `context: fork` / `background` dispatch half of R69 (f062) | f062 | R86 | M | ⚡ | ✅ | `parity(skill-fork-dispatch)` | **closed on the corrected design** — ordinary named-subagent spawn, nothing touches `FORK_AGENT_DEFINITION`; the RPC pair (`skill_fork_start`/`_result`) is a plumbing sibling of `/subtask`, not a behavioural one. `context: fork` routes `agent` and `model` into a NEW `restrictions.fork` field (appended LAST, digest-safe) and keeps them OUT of the ceiling semantics; `background` defaults true per the page. **No-history proof in two layers**: a planted parent-only canary is asserted absent from the dispatch request (with the positive control that the same rig carries it into the parent's own turn), and through the real `spawnChildSession` the child's `restrictions.fork` is undefined with the agent definition's system prompt in the child prompt — the exact inverse of `subtask.test.ts`. **The `background: true` consumer is real twice over**: the fork registers as a `kind:'subagent'` background task, so R86's `deliverMonitorEvent` path delivers the completion to the MODEL, and a widened third arm of `forkTranscriptEntry` (gated on `background === true` so a foreground fork is not double-reported) persists it to the transcript. **The executor caught a latent dead field the plan missed**: `skills.md:265` redirects `model` to the child under fork, and today's grant path would have THROWN for it — routed to the child as the spawner's per-call override instead. Four executor controls plus an orchestrator control on the axis nobody had tested (force EVERY skill to be a fork → exactly the dedicated non-fork-unchanged test fails, so the negative direction is pinned too). **Recorded, unimplemented**: the narrower background-subagent tool set for a backgrounded fork (`skills.md:580`); same-skill-still-running wait (`:577`); checkpoint/rewind exclusion (`:582`); default fork agent is `worker`, not upstream's `general-purpose` (no such builtin here). |
| R87 | `component-scoped-hooks` | The `hooks` key in SKILL frontmatter (subagent half → R87b) | (from f062's split) | R69b | L | ⚡ | ✅ | `parity(component-scoped-hooks)` | **SKILL hooks are DONE; the SUBAGENT half is a documented partial, split to R87b.** A skill's frontmatter `hooks` now parse and DISPATCH: the doc's own example — a `PreToolUse` hook running a security check before every `Bash` — runs while the skill is active and stops when it leaves. **Built as a fifth layer, exactly as the seam predicted**: one more `executePluginHookAutomations` call folded LAST in `executeAgentEventInner` (narrowest scope), read through a GETTER consulted at dispatch — not a snapshot. Orchestrator's own control (capture the active set at layer creation instead of reading live) fails exactly the 2 lifetime tests and leaves 11 green, so the read-live property is pinned, not merely commented. **All three rules handled**: `once` split into its own tier at parse, consumed only when it actually matched (keyed by skill+event), reset on `/clear`, honoured for SKILLS only; `Stop` stays `Stop` for a skill (no conversion); the trust gate is REUSED not reinvented — the layer has no skill source of its own, it reads only the admitted active set, and `isRunnable` already drops a `review-required`/`blocked` project skill upstream, so a project skill's hooks cannot fire before the folder is trusted (a test pins the layer contributing nothing for an unadmitted skill). **Correction to the plan's own wording, accepted**: component hooks do NOT go through the raw settings parser — Nessy's `AutomationsConfig` keys on `actions`, the frontmatter form is Claude's nested `hooks:[{type,command}]`, so a converter (`frontmatterHookToAction`) is required and now exists. **Behaviour change flagged and verified benign**: for non-Claude providers the automation system is now always constructed, so a session with only a skill guardrail still dispatches — `hasAgentEventMatchers` still reports false for an empty system, so the perf gates skip as before. |
| R87b | `subagent-frontmatter-hooks` | The subagent-frontmatter half of component hooks | (from R87's split) | R87 | M | ⚡ | ✅ | `parity(subagent-frontmatter-hooks)` | **DONE, with two recorded partials (see the section above).** A subagent's frontmatter hooks now RUN, split by which session dispatches each tier: `PreToolUse`/`PostToolUse` travel to the child on `PiChildRestrictionsV1.componentHooks.child` (appended LAST, older records parse unchanged) and are read live off the child session's own `piChildRestrictions`; `Stop` is converted to `SubagentStop` at PARSE and dispatched PARENT-side from `ManagedSession.piChildComponentHooks`, registered at `SubagentStart` and released in `executePiChildTerminalAutomation`'s `finally`. **R87's mechanism was reused, not duplicated** — one parser (`partitionFrontmatterHooks`, now carrying `honourOnce`/`renameEvents` options), one `ComponentHookLayer` contract, one executor; the new `capabilities/component-hooks.ts` only adds the subagent tier-split and three small layer factories, and `combineComponentHookLayers` folds skill + child + parent into the single seam the automation system already had. **The trust gate is by SCOPE, on the HOOKS, and it does NOT refuse the agent** — `subagentHookScope` is an ALLOWLIST of ungated scopes (`builtin`/`global`/`workspace`), so `project` and any future scope are gated and an unreadable scope resolves to gated; a plugin subagent's `hooks` are dropped outright per the security rule and no grant opens that gate. **The hooks are pinned on the digest-protected descriptor and the host REFUSES a transport-supplied block** (`runtime-agent-hooks-not-a-call-site-input`) rather than comparing one — stricter than `memory`, because the field decides which commands run; the trust decision therefore enters `definitionDigest`, so all three `materializePiRuntimeAgentDefinitions` call sites share one `agentDefinitionHookTrust` helper or every spawn would fail the identity check. **The `frontmatter_hooks_unregistered` diagnostic survives but its reason changed**: the reporter only ever sees plugin-bundled components, so it now cites the documented plugin rule instead of the false "Nessy does not register subagent-scoped hooks". 10 positive controls, each with a tight blast radius; the first attempt at the child-lifetime control PASSED with the code broken (the test rebuilt the layer per dispatch, re-taking the snapshot) and was rewritten to hoist the layer as R87's own test does. |
| R88 | `plugin-update-source` | The user-clickable Update must fetch the NEW version, not reinstall the installed one | (post-audit, 2026-08-08) | R82 | M | ⚡ | ✅ | `parity(plugin-update-source)` | **closed — the HIGH defect the audit found is fixed WITHOUT widening the wire.** The RPC resolves the catalog source server-side: `peekCachedItems()` (the SAME cached-only read R81 established — verified no clone, no network, disk-on-signature-miss) + `status()` → `planInstalledUpdate`, the write counterpart of the badge's `resolveAvailableUpdateVersion`, sharing one projection so read and write cannot drift. `update` case → hands `{source}`; `current` → repair-equivalent (reachable only by raw RPC since `canUpdate` withholds the button there); **`no-catalog-row` and a dependency-`held` plugin FAIL HONESTLY** rather than silently reinstalling the same version and claiming success — which was the whole defect. `repair` is unchanged and never peeks the catalog (asserted). Executor control: disabling the resolution fails exactly 4 tests (ahead / no-catalog / held / not-installed). **Two more no-op callers found and recorded, not silently left**: the agent tool `plugin_manage` update (`plugin-management-tools.ts:284`, same three-line fix, filed) and the headless server, which never wires `marketplaceRegistrySource` so `update` there now refuses honestly instead of silent-repairing. **Bundled the two LOW audit findings**: R73's legacy `Setup` refusal now carries the reason through (`plugin.format.deferred_hook_event` + an unsupported capability, keyed by reason code so a `TeammateIdle` author is not told about launch modes — the audit's own single-message fix-shape would have gotten that wrong); and the renderer `StatusEvent` type widened to include `'retrying'`, matching the wire. |
| R88b | `agent-tool-update-source` | The agent's own `plugin_manage` update tool must not reinstall the installed version | (from R88's audit) | R88 | S | ⚡ | ✅ | `parity(agent-tool-update-source)` | **closed by MOVING the decision, not copying it.** R88's switch lived inside the RPC handler; it is now `resolveInstalledUpdateOptions` in `marketplace/update-availability.ts`, shared by both callers — so the two surfaces cannot drift, and R88's own tests pin the shared function unchanged (messages byte-identical). The agent tool's new dep is the NARROWEST type that answers the question (a cached-catalog reader), so an agent tool still cannot mutate a registry or kick a clone. **Two things the plan got wrong, both caught by the executor.** (1) The tracker named ONE wiring site; there are **two** — `SessionManager` only forwards, and the tools are constructed in `apps/electron/src/main/index.ts` AND `packages/server/src/index.ts`. Wiring only SessionManager would have left the reader `undefined` in production with every new test still green, because absent-reader is a legitimate state. (2) A PRE-EXISTING test asserted against a plugin key that does not exist (`local.toolkit` vs the real `bG9jYWw.dG9vbGtpdA`) and passed only because the stub accepted anything — the audit's own blindness, sitting in the very test that touched `update`. Rewritten to install a real bundle. **Orchestrator's control ran on the honesty branch** (turn `no-catalog-row` into a silent repair): fails the honest-refusal test on BOTH surfaces at once, proving the extracted function is load-bearing on each. And the executor's own control restored the single pre-fix line and failed exactly 5 update tests while `leaves repair on the pinned origin` passed in BOTH directions — the fix does not leak into repair. **Orchestrator closed the residual the executor flagged**: `packages/server/src/index.ts`'s RPC deps did not carry `marketplaceRegistrySource` (electron passes it in both places, headless in only one), so after this unit the headless agent tool would have resolved while the headless RPC refused with a warm catalog — two surfaces disagreeing about the same plugin. One line, with the reason in place. |
| R89 | `skill-arg-injection-guard` | The `$ARGUMENTS` placeholder-injection guard, hardened from count to set | (post-audit MEDIUM, 2026-08-08) | R69 | S | ⚡ | ✅ | `parity(skill-arg-injection-guard)` | **closed — the audit's MEDIUM finding, fixed and with a correction to the finding itself.** f058's guard compared the placeholder COUNT before/after argument expansion; the audit showed a count-PRESERVING swap (an argument whose newline breaks one author placeholder while its `` !`…` `` opens a fresh one) slips through. The guard now compares the placeholder SET of the real body against a body expanded with argument VALUES neutralized (`sanitizeArgumentValues` → backticks and newlines replaced), where an argument can neither open nor break a placeholder. Any command in the real body absent from the neutralized set is author-unwritten and fails the turn. **No false positive on author interpolation**: `` !`echo $ARGUMENTS` `` with a backtick-free argument survives neutralization unchanged and is allowed — a test pins it. **Correction to the audit's repro**: its `$0` variant does NOT fire on this codebase — `splitSkillArguments` splits on whitespace, so `$0` captures only the first token and the dangerous tail never lands. `$ARGUMENTS` (the full string as typed) is the real vector, and the guard closes it. Control: reverting to the count comparison fails exactly the count-preserving test and leaves the add-a-placeholder and safe-interpolation tests green. |
| R84 | `hook-block-cap-lever` | The hook block-cap lever (f012) | f012 | R64 | S |  | ✅ | `parity(stop-hook-block-cap)` | closed WITH its consumer, which is the whole reason R64 refused it standalone — a resolver nobody reads is the unused-identifier trap this repo has hit four times. `MAX_CONSECUTIVE_HOOK_BLOCKS` is DELETED (0 references repo-wide, `grep -a`) and the single read site now resolves per event. **Safety direction verified in both directions**: every malformed value (`abc`, `-1`, `1e3`, `1.5`, `''`, `' '`, `0x8`) lands back on 8 — not on 0, not uncapped — so a typo cannot silently buy an unbounded hook loop; `0` is the only way to disable. Executor's control replaced the resolved read with the fixed default (i.e. reproduced the R64 state) and **exactly 7 tests failed** — raised cap, lowered cap, `0`-disables, SubagentStop, compat spelling, Nessy-wins, streak-reset — while everything that must be insensitive to the wire stayed green, including all 7 malformed cases and the pre-existing decisions suite. That is a control that discriminates rather than one that merely fails. Deliberate narrowing: `ConfigChange` keeps the fixed 8 and a test pins it — `env-vars.md` names two events, our ConfigChange block is advisory, and widening the default is precisely what R64 avoided when it wrote explicit per-event cases. Orchestrator closed the two items the executor refused by zoning: the env var is documented in `docs-site` in BOTH locales, and the stale deviation row (`2026-07-29-hook-context-injection.md`) is flipped to implemented, with the stale prose naming the deleted constant corrected in `2026-07-27-hook-decision-patterns.md`. Every line number in the original spec had decayed (the constant was at :143 not :136, the read site at :621 not :564, the callers off by ~400 lines) — the quoted symbols were all still findable, which is exactly what the doc-line-decay trap predicts. \| Split out of R64, which refused it deliberately rather than half-building it: the only constant lives in a file that executor did not hold, and a resolver with no consumer is dead code — the unused-identifier trap this wave has hit four times. Needs the consumer built in the same unit as the lever. |
| R85 | `hook-env-file-channel` | The hook env-file channel (f141) | f141 | R64 | M | ⚡ | ✅ | `parity(hook-env-file-channel)` | **closed with BOTH halves, and the executor caught a security-config regression in MY OWN plan instruction.** I specified joining the source-preamble to the model's command with a newline. `ProcessSupervisor` matches `sandbox.excludedCommands` globs against `[command, ...args].join(' ')`, and `globMatches` compiles `*` → `.*`, which does not cross `\n` — so a newline join silently stops EVERY user exclusion glob from matching. Measured by the executor and reproduced independently by the orchestrator: `*docker*` against the same command is `true` today, `false` with a newline join, `true` with a semicolon. The preamble is now a compile-time constant carrying NO path (`if [ -r "$NESSY_HOOK_ENV_FILE" ]; then . "$NESSY_HOOK_ENV_FILE"; fi;`), with the path travelling as a host-set child env value — which also removes per-session variation from the glob-matched line and removes path quoting as a concern. A test pins it. Guards, each reasoned rather than pattern-matched: the file lives at `<sessionDir>/hook-env/env.sh`, outside every model-writable root, and the hook's write grant is that SUBDIRECTORY so a hook cannot rewrite `session.jsonl`; the read-back refuses a symlink, an empty file, one past a 64 KiB cap, and any file that resolves inside a model-writable root; the rewrite fires only for `semanticId` `bash`/`bash_background` on the exact `/bin/sh -lc` shape; `pickSupervisedChildStartFields` is untouched, so a child still cannot smuggle an `env`. An `export`-only line grammar was REJECTED for a good reason — the page's own `export -p \| comm -13` recipe emits `declare -x` under bash, so the grammar would refuse a documented recipe. **Orchestrator's own control did NOT discriminate and that is recorded rather than hidden**: replacing the read-side `lstat` with `stat` (i.e. following symlinks) failed nothing. Instrumenting showed why — for a planted symlink the function returns BEFORE that line, so the refusal lives earlier in path resolution and the `lstat` is defence in depth. The security OUTCOME was then verified directly against the real function: a symlink at the real path yields `undefined`, a regular file at the same path yields the path. Scope recorded, not hidden: Pi-only and POSIX-only. Claude-runtime and Codex fix their env at subprocess spawn and expose Bash only as an approval callback, so `SessionStart` on those two is an explicit non-goal, and the write side is gated on the provider so they never receive a variable nothing consumes. `Setup` excluded (R73 removed it), so the set is `SessionStart`/`CwdChanged`/`FileChanged` — and two of those three are Pi-exclusive anyway. The file is truncated once per Pi runtime start, not per event, so a resume does not accumulate duplicate `export` blocks. \| Split out of R64 for the same reason and a stronger one: the read-back lives in two other packages, so minting the env var alone hands hooks a file whose exports never apply — the demos-perfectly-does-nothing shape. Also filed alongside it: the `session_title` hook INPUT is absent repo-wide, and the page makes it the guard a hook checks before overwriting a user-set title, so R64's title feature is incomplete without it. |
| R83 | `plugin-update-discoverability` | The update badge on the surfaces a user actually passes through | — (from R82) | R82 | S |  | ✅ | `parity(plugin-update-discoverability)` | closed on THREE surfaces, each with a shape argued from what the surface already is rather than by pasting R82's badge everywhere. **Installed strip: a dot, not a badge** — the tiles are 32px icons with no text, and R82's "Update available: 2.4.0" is about three tiles wide, so the badge would turn a glanceable map into a list; the version rides `title` AND `aria-label`, so hover and a screen reader both get what the dot cannot carry. **Sources ▸ Plugins: the row's note slot, not a badge** — and the executor was right to refuse the badge: `SourceCardBadges.tsx` states in its own header that it has no extension slot ON PURPOSE (owner ruling 2026-08-01, the slot was deleted rather than emptied so a panel cannot re-grow one), and the overlay is `pointer-events-none` with only `pr-16` clearance, so a sentence there collides with the name. **`PluginInfoPage`: the full badge**, added beyond the brief and correctly — both new indicators deep-link there, and without it the dot and the note lead to a page that says nothing. R81's constraint is pinned STRUCTURALLY, not just behaviourally: neither widened component can see the wire (each takes a string), and a test asserts with comments stripped that neither reads `availableUpdateVersion` and that the projection goes through `pluginUpdateVersion` — so the dependency-hold suppression cannot be re-derived renderer-side. Three positive controls, each failing EXACTLY its own tests (1, 2 and 1). No new i18n key — `plugins.updateAvailable` reused, so no locale file was touched. Playground swept per the owner's playground rule. Deliberately left alone with reasons: a count on the strip header (restates the dots), the browse catalog cards (same screen as the strip — marking one plugin twice is noise), and any new Update ACTION (`plugins/install.md#manage-installed-plugins (was line 319 of the retired discover-plugins page)` lists the installed verbs, and R82 withheld the item for that reason). **Open, and named by the executor:** the only place a user can RUN an update is still the marketplace detail view — the three new indicators tell you, `PluginInfoPage` included, but offer no control. Orchestrator correction to the executor's report: it filed `MarketplaceComponents.test.tsx` as running 0 of ~30 tests, which is SCOPE-DEPENDENT — it errors at module load when run alone or as its own directory, and passes inside `apps/electron/src/renderer/` (1154 pass) and in the full suite, which is what CI runs. Fragile, not dark; not a merge blocker. |
