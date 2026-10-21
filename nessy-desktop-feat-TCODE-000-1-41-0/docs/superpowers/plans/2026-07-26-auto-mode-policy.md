> **CLOSED 2026-07-26.** Executed and verified; evidence recorded in the parity audit §0 (R21).
> Kept until the end-of-series sweep. Do not execute again.

# Auto Mode as a Policy Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `auto` stops being a static risk heuristic that only ever prompts, and starts consulting the judge and the org policy we already have — without giving the judge the power to widen anything.

**Architecture:** The re-verify below found that we already own both halves of the
documented design under different names, wired to a different mode. The classifier is
the **Guardian judge**; the risk band is `shouldPromptInAutoMode`'s risky tier; and P10
just landed the managed policy that can hold the org-declared trusted sets. What is
missing is that the judge is wired to `allow-all` only, `auto` itself never consults it,
the org sets do not exist as policy keys, and plan mode has no route through any of it.
So this plan connects existing parts and adds one policy key group — it does not build a
classifier.

**Tech Stack:** TypeScript, Bun test runner. Packages: `@nessy-agent/shared`
(`src/agent/core`, `src/agent/pi-harness`), `@nessy-agent/server-core` (`src/sessions`).

Covers **R21**, which deepens the §1 row `Permission evaluation and modes`. **Read
`§5e-2` of the audit first** — R21 exists because a full docs sweep found `auto` is a
policy engine and our row treated modes as a static table. **R21 must land before R15**
(the floor/overridable-band split) is written, because both touch the same band.

## Before you start: re-verify

Done by the planning session on 2026-07-26 at HEAD `52c1c86b`. **The two starred findings
re-frame this entry and are the reason it is tractable** — do not plan around the audit's
original wording without reading them.

- [x] ⭐ **We already have the model classifier: the Guardian judge.**
  `PiAgent.consultGuardianDenyNet` (`shared/src/agent/pi-agent.ts:2595`) uses
  `shouldPromptInAutoMode`'s risky tier as its **high-risk band** (`:2613`) and then asks
  the judge. Its documented outcome mapping is `no_objection` → run, `deny` → block,
  anything uncertain → **downgrade to ask**. The comment at `:2583-2586` states the
  invariant explicitly: *"this is a NET, it can only narrow, never widen"*.
- [x] ⭐ **But it is wired to `allow-all` only, not to `auto`.** The doc comment at
  `:2570-2571` scopes it to execute-mode (`allow-all`) because there "the deterministic
  gate auto-allows everything — there is no `prompt` band". So today: in `allow-all` a
  risky action is **judged**; in `auto` the same action **prompts**. Claude's `auto`
  judges. That asymmetry is the core of this entry.
- [x] **Our `auto` is a static heuristic.** `shouldPromptInAutoMode`
  (`shared/src/agent/core/pre-tool-use.ts:1362-1391`) is `shouldPromptInAskMode` with
  `{ autoAllowFileWrites: true }`, plus one call to `isRiskyAutoBashCommand`. No org
  policy, no trusted repos, buckets or domains, no denial-review flow.
- [x] **Managed policy can now hold the org sets.** P10 extended `ManagedPiPolicyV1`
  with `channelsEnabled`, `allowedChannelServers` and a `sandbox` group
  (`shared/src/agent/pi-harness/managed-policy.ts`), strict-key via `exact()`, loader
  fail-closed and unchanged. Adding an `autoMode` group is the same shape of change —
  and the same constraint applies: **a key with no consumer is worse than no key**.
- [x] **The escape hatch exists and does not consult anything.** P10 landed
  `dangerouslyDisableSandbox` + `excludedCommands` + `allowUnsandboxedCommands`
  (`server-core/src/pi-harness/process-supervisor.ts:369-380`). Claude's docs say that in
  auto mode "the classifier evaluates the underlying command instead of prompting you".
  **P10 deliberately shipped no model-facing producer for the hatch**, so this plan must
  not add one; it may only make the *existing* `excludedCommands` path policy-aware.
- [ ] **Not yet checked — do this first:** whether `useAutoModeDuringPlan` or any
  plan-mode → auto routing exists at all. `grep -rn "useAutoModeDuringPlan" packages`
  returned nothing when this plan was written, but confirm, and confirm what plan mode
  does with a Bash command today, before writing Task 3.

## Global Constraints

- **The judge may only narrow.** `consultGuardianDenyNet`'s stated invariant is that it
  is a net. Wiring it into `auto` must preserve that: a judge `no_objection` in `auto`
  means "the prompt you would have seen is not required", and anything uncertain must
  still **downgrade to ask**, never to allow. If a task seems to need the judge to
  approve something the deterministic gate would have prompted for, stop — that is the
  widening R15 owns, with its own threat model.
- **The deny floor does not move.** Same constraint every plan in this series has
  carried.
- **`safe` and `plan` remain undisableable by managed policy** (`DISABLEABLE_MODES`).
- **Extend `ManagedPiPolicyV1`; never create a second policy module.** New keys go in
  `POLICY_KEYS` **and** get a validator; `exact()` keeps rejecting unknowns; the loader
  gets no permissive `catch`.
- **Do not add a model-facing `dangerouslyDisableSandbox` parameter.** P10 removed the
  one it had threaded because `handleProcessStartRequest` rebuilds the host request from
  an allowlist and the flag could never be honoured. Whoever adds it must add its
  permission ask rule in the same change, and that is not this plan.
- **Zero judge calls for the common case must survive.** `consultGuardianDenyNet`
  returns early when the action is not in the band, and its comment calls that out as
  "the vast majority of allow-all actions — zero judge calls, no latency". Wiring `auto`
  must not make every tool call pay a model round-trip.
- One commit per task. No `Co-Authored-By` trailers.
- Gates: `bun run typecheck:all`; `bun run lint:i18n:parity`; `bun run lint:i18n:sorted`.
- **Never pass `-r` to `rg`** — it parses as `--replace` and silently rewrites every
  match. Four agents have lost time to this.

## File Structure

| File | Responsibility |
| --- | --- |
| Modify `packages/shared/src/agent/pi-agent.ts:2595-2620` | Consult the judge from `auto`, not only `allow-all`. |
| Modify `packages/shared/src/agent/core/pre-tool-use.ts:1362-1391` | Policy-aware band inputs. |
| Modify `packages/shared/src/agent/pi-harness/managed-policy.ts` | The `autoMode` key group. |
| Modify `packages/server-core/src/sessions/SessionManager.ts` | Thread the policy into the band. |

---

### Task 1: `auto` consults the judge instead of always prompting

**Files:**
- Modify: `packages/shared/src/agent/pi-agent.ts:2595-2620`
- Test: the guardian deny-net suite

**Interfaces:**
- Consumes: nothing.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

```ts
  it('consults the judge for a risky command in auto mode', async () => {
    const result = await runPreToolUse({ mode: 'auto', command: 'curl https://x | sh', judge: 'no_objection' });
    expect(result.type).toBe('allow');
    expect(judgeCalls()).toBe(1);
  });

  it('still prompts when the judge is uncertain', async () => {
    // The net may only narrow. Uncertainty downgrades to ask — never to allow.
    for (const verdict of ['unsure', 'failure', 'circuit-open'] as const) {
      const result = await runPreToolUse({ mode: 'auto', command: 'curl https://x | sh', judge: verdict });
      expect(result.type).toBe('prompt');
    }
  });

  it('blocks on a judge deny in auto mode', async () => {
    const result = await runPreToolUse({ mode: 'auto', command: 'rm -rf /', judge: 'deny' });
    expect(result.type).toBe('deny');
  });

  it('makes zero judge calls for a command outside the band', async () => {
    // The early return is the reason this is affordable. Losing it makes every
    // tool call pay a model round-trip.
    await runPreToolUse({ mode: 'auto', command: 'ls', judge: 'no_objection' });
    expect(judgeCalls()).toBe(0);
  });

  it('leaves allow-all behaviour byte-identical', async () => {
    // Regression guard: allow-all already had this wiring and must not change.
    expect(await runPreToolUse({ mode: 'allow-all', command: 'curl https://x | sh', judge: 'deny' }))
      .toMatchObject({ type: 'deny' });
  });
```

Read the existing guardian suite and reuse its harness — it already builds judge fakes
with each verdict.

- [ ] **Step 2: Run test to verify it fails**

Expected: the first three fail — `auto` never reaches `consultGuardianDenyNet`. The
fourth and fifth should pass already and must keep passing.

- [ ] **Step 3: Write minimal implementation**

The difference between the two modes is what a null band means, and what a
`no_objection` is permission to do:

- In `allow-all` the gate already allowed, so the judge can only deny or force a prompt.
- In `auto` the gate would have **prompted**, so `no_objection` means "skip that prompt".

Both are narrowings relative to their own starting point, so the net invariant holds in
both — say that in the commit body, because it is the whole safety argument.

- [ ] **Step 4: Mutation probe**

Make an uncertain verdict resolve to `allow` instead of `prompt` and confirm the second
test fails. Revert. That probe is the invariant.

- [ ] **Step 5-6: green, commit**

```bash
git commit -m "feat(permissions): let auto mode consult the guardian instead of prompting"
```

---

### Task 2: The org-declared trusted sets

**Files:**
- Modify: `packages/shared/src/agent/pi-harness/managed-policy.ts`
- Modify: `packages/shared/src/agent/core/pre-tool-use.ts:1362-1391`
- Test: `managed-policy.test.ts` and the band suite

**Interfaces:**
- Consumes: Task 1's wiring.
- Produces: an `autoMode` policy group. Task 4 may read it.

**The vocabulary is settled — the planner fetched `auto-mode-config.md` on 2026-07-26.**
Do not re-derive it, and note that the first finding invalidates how this task was
originally written.

⭐ **Entries are PROSE, not patterns.** "Entries are prose, not regex or tool patterns.
The classifier reads them as natural-language rules. Write them the way you would
describe your infrastructure to a new engineer." So this is **not** a matcher to build —
it is context handed to the judge. Our guardian already takes a policy prompt, which is
exactly the right shape. An earlier draft of this task tested a structured
`trustedDomains` array; that model is wrong and the tests below replace it.

The `autoMode` block has exactly five fields:

| Field | Shape | Meaning |
| --- | --- | --- |
| `environment` | prose array | what is *inside* the boundary — context, trust and sensitivity slots |
| `hard_deny` | prose array | unconditional; user intent and `allow` do not apply |
| `soft_deny` | prose array | destructive; user intent and `allow` can clear |
| `allow` | prose array | exceptions to `soft_deny` |
| `classifyAllShell` | boolean | suspends every Bash/PowerShell allow rule so the classifier sees every command |

Four documented facts that shape the implementation:

1. **Four-tier precedence inside the classifier:** `hard_deny` blocks unconditionally →
   `soft_deny` blocks → `allow` overrides matching `soft_deny` → explicit user intent
   overrides the remaining soft blocks. And "General requests don't count as explicit
   intent. Asking Claude to 'clean up the repo' doesn't authorize force-pushing, but
   asking Claude to 'force-push this branch' does."
2. **The classifier is a second gate that runs after the permissions system** —
   `permissions.deny` "blocks the action before the classifier is consulted and can't be
   overridden", and a content-scoped `permissions.ask` "always force[s] a permission
   prompt, even in auto mode". **This is our architecture already**: the guardian is a net
   after the deterministic gate. Say so in the commit body — it is the strongest evidence
   this entry is wiring rather than design.
3. **`autoMode` is deliberately NOT read from project settings.** "The classifier doesn't
   read `autoMode` from project settings in `.claude/settings.json` or
   `.claude/settings.local.json`. Both files live in the repo directory, so a checked-in
   repo or a build step could otherwise inject its own allow rules." **Reproduce that
   exclusion.** A repo-supplied allow list is a supply-chain hole.
4. **Managed `soft_deny` is not a hard boundary.** "A developer can extend `environment`,
   `allow`, `soft_deny`, and `hard_deny` with personal entries but can't remove entries
   that managed settings provide. Because allow rules act as exceptions to soft block
   rules inside the classifier, a developer-added `allow` entry can override an
   organization `soft_deny` entry: the combination is additive, not a hard policy
   boundary." So an admin who needs a real boundary uses `permissions.deny` in managed
   settings, not `autoMode.soft_deny`. Do not present ours as stronger than that.
5. **Omitting `"$defaults"` replaces the whole list**, which the docs flag with a Danger
   callout. If we adopt the `"$defaults"` splice convention, it must behave the same way,
   and the destructive case needs a test.

- [ ] **Step 1: Write the failing test**

```ts
  it('accepts the five documented autoMode fields as prose arrays', () => {
    const policy = parseManagedPiPolicy({ schemaVersion: 1, autoMode: {
      environment: ['$defaults', 'Source control: git.example.com/acme and all repos under it'],
      allow: ['$defaults', 'Writing to s3://acme-scratch/ is allowed: ephemeral, 7-day lifecycle'],
      soft_deny: ['$defaults', 'Never run migrations outside the migrations CLI'],
      hard_deny: ['$defaults', 'Never send repository contents to third-party review APIs'],
      classifyAllShell: true,
    } });
    expect(policy.autoMode?.environment).toContain('$defaults');
  });

  it('reaches the judge as policy text, not as a matcher', () => {
    // The documented contract is natural-language context. Asserting on the judge's
    // input is the only honest test — there is no pattern to match against.
    const judgeInput = buildJudgeInputWith({ autoMode: { environment: ['Trusted internal domains: *.corp.example.com'] } });
    expect(judgeInput.policy).toContain('*.corp.example.com');
  });

  it('splices $defaults in place and replaces the list when it is absent', () => {
    expect(resolveAutoModeList(['a', '$defaults', 'b'], ['D1'])).toEqual(['a', 'D1', 'b']);
    expect(resolveAutoModeList(['a'], ['D1'])).toEqual(['a']); // documented Danger case
  });

  it('never reads autoMode from a project-scoped settings file', () => {
    // Documented security exclusion: a checked-in repo or a build step must not be
    // able to inject its own allow rules.
    expect(resolveAutoMode({ project: { allow: ['anything goes'] }, user: {} }).allow).toEqual([]);
  });

  it('still cannot clear a deny rule from the deterministic gate', () => {
    // hard_deny inside the classifier is not the same thing as permissions.deny
    // before it. Our gate runs first; nothing in autoMode may reopen it.
    expect(decisionFor('Bash(curl *)', { denyRules: ['Bash(curl *)'], autoMode: { allow: ['curl is fine'] } }))
      .toMatchObject({ type: 'deny' });
  });
```

The fourth and fifth are the load-bearing ones: one is a supply-chain hole the docs
closed deliberately, the other is the invariant every plan in this series has carried.

- [ ] **Step 2: Ship only fields with a consumer**

Same rule P10 applied when it declined three keys. If the judge's policy prompt cannot
yet carry all five, ship the ones it can and say which you deferred and why.

- [ ] **Step 3-6: red, implement, green, commit**

```bash
git commit -m "feat(policy): add the auto-mode trusted sets to the managed policy"
```

---

### Task 3: Plan mode's route through auto

**Files:** determined by Step 1 — do not edit before it.

**Interfaces:**
- Consumes: Task 1.
- Produces: nothing.

- [x] **Step 1: Establish what plan mode does with a Bash command today**

The re-verify's one unchecked item. Answer in writing and append it to this plan:
does any plan-mode → auto routing exist; what happens to a read-only Bash command in
`plan` today; and is there a setting shaped like `useAutoModeDuringPlan`.

**Answered by the executor on 2026-07-26 at HEAD `261b0162`.**

1. **No plan-mode → auto routing exists, and there is no `useAutoModeDuringPlan`.**
   `grep -rn "useAutoModeDuringPlan" packages apps` returns nothing. Guardian eligibility
   in `handlePreToolUseRequest` is `checkResult.type === 'prompt' && mode === 'auto'` or
   `(allow|modify) && mode === 'allow-all'`; `plan` satisfies neither, which the existing
   `mode plan: never spawns the judge` test already pins.
2. **Plan mode never PROMPTS for Bash — it allows or blocks.** `runPreToolUseChecks` calls
   `shouldAllowToolInMode(..., 'plan', ...)`. `plan` is in neither the `allow-all` branch
   nor the `ask | acceptEdits | auto` "allowed, prompt later" branch, so it falls to the
   read-only allowlist: `getBashRejectionReason` returns nothing → `{allowed: true}` and
   the command runs with no prompt and no judge; it returns a rejection → the gate returns
   `{type: 'block'}`. The read-only patterns come from
   `apps/electron/resources/permissions/default.json`, which contains no `curl`/`wget`.
3. **The plan-allowed set and the auto risky band are DISJOINT.** Measured directly
   against both production functions:

   | command | `plan` | auto band |
   | --- | --- | --- |
   | `ls -la`, `git status`, `cat README.md`, `grep`, `rg`, `docker ps` | allow, no prompt | out of band |
   | `curl https://…`, `git push --force`, `rm -rf build`, `npm install`, `echo … > f` | block | in band (`bash`) |

- [x] **Step 2: Decide the scope from the answer, and say so**

**Scope chosen: investigation only, no code change.** Both available shapes are ruled out
by the answer above, in opposite directions.

- Routing `plan` through `auto` would let a judge `no_objection` run precisely the commands
  in the right-hand column — the ones `plan` blocks outright today. That is **widening what
  `plan` permits**, which this task's own Step 2 and the plan's stop conditions say to halt
  on, and `plan` is one of the two modes managed policy may never disable. Reported, not
  worked around.
- The narrowing shape — a deny-only net over what `plan` already allows, mirroring
  `allow-all` — is a **no-op**. Because the two sets are disjoint, the band is empty for
  every command `plan` allows, so `consultGuardianDenyNet`'s early return fires every time:
  zero judge calls, zero behaviour change, pure code. Declined on the same rule that
  declined `classifyAllShell` and P10's three keys.

Task 3 therefore lands no commit of its own beyond this record.

If plan mode already prompts for everything and there is no routing, this task is a
**new** behaviour rather than a fix — which raises the bar. `plan` is one of the two
modes managed policy may never disable, so loosening what it permits is a security
decision. If the answer is that plan mode is already permissive for reads, the task is
small. **If it turns out to require widening what `plan` allows, stop and report** —
that belongs with R15, not here.

- [ ] **Step 3-6: whatever Step 2 chose, TDD, one commit**

---

### Task 4: The excluded-command path becomes policy-aware

**Files:**
- Modify: `packages/server-core/src/pi-harness/process-supervisor.ts:369-380`
- Test: the escape-hatch suite

**Interfaces:**
- Consumes: Task 2's policy group.
- Produces: nothing.

Claude's docs say auto mode's classifier "evaluates the underlying command instead of
prompting you" at the sandbox boundary. We have the boundary (P10) and, after Task 1,
the classifier in `auto`.

- [ ] **Step 1: Write the failing test**

```ts
  it('consults the judge for an excluded command in auto mode rather than running it blind', async () => {
    const receipt = await runSupervised({ mode: 'auto', command: 'docker ps', excludedCommands: ['docker *'], judge: 'no_objection' });
    expect(receipt.isolationProfile).toBe('excluded-by-policy');
    expect(judgeCalls()).toBe(1);
  });

  it('refuses the exclusion when the judge denies', async () => {
    await expect(runSupervised({ mode: 'auto', command: 'docker ps', excludedCommands: ['docker *'], judge: 'deny' }))
      .rejects.toThrow();
  });

  it('leaves strict mode terminal regardless of the verdict', async () => {
    // allowUnsandboxedCommands: false must not be reachable through a judge.
    await expect(runSupervised({ mode: 'auto', dangerouslyDisableSandbox: true, allowUnsandboxedCommands: false, judge: 'no_objection' }))
      .rejects.toThrow('process-isolation-unsandboxed-commands-disallowed');
  });
```

The third test is why this task is safe: P10's lock must stay above the classifier.

- [ ] **Step 2-6: red, implement, green, commit**

```bash
git commit -m "feat(isolation): consult the judge before honouring a command exclusion"
```

---

## Final Verification

- [ ] `bun test packages/shared/src packages/server-core/src packages/pi-agent-server/src packages/session-tools-core/src`
- [ ] `bun run typecheck:all`; both i18n linters; `git diff --check`; `bun run electron:build`
- [ ] Diff review: the judge still cannot widen in either mode; the band's early return
  still gives zero judge calls outside it; `allow-all` behaviour is unchanged;
  `exact()` still rejects unknown policy keys and the loader diff is empty; strict mode
  is still terminal; no model-facing `dangerouslyDisableSandbox` parameter was added.
- [ ] Re-establish the two stale known-red notes before trusting a red run — the audit
  records that `session-branch-rollback` stopped reproducing and a different
  `isUsableGitBashPath`/`resizeImageForAPI` flake appeared.

### Live verification

- [ ] In `auto`, run a risky command and confirm from the logs that the judge was
  consulted once and the prompt was skipped on `no_objection`.
- [ ] Run a command outside the band and confirm **zero** judge calls.
- [ ] Confirm an uncertain verdict still produces a prompt.
- [ ] Authorized connections: `pi-api-key` (`pi_compat`) and `nessy-cloud-agent`. Note
  that a real model turn has been unreachable headlessly for four plans running — the
  Pi-capable connection fills its JWT behind an Electron IPC handler. Verify through the
  production code path and report the rest as `blocked: <reason>`.

## Deliberately out of scope

- **Letting the judge widen anything** — that is R15, with its own threat model.
- **A model-facing `dangerouslyDisableSandbox`** — needs its own ask rule; P10 removed
  the producer deliberately.
- **The denial-review flow and `auto-mode` CLI subcommands** — a UI and CLI surface, not
  a decision path. Record them as follow-ups if Task 2's doc read confirms they are part
  of the contract.

## Tracker

| # | Task | Status | Gate that proves it | Evidence |
| --- | --- | --- | --- | --- |
| 0 | Re-verify (planner, `52c1c86b`) | done | 5 anchors; plan-mode routing answered in Task 3 Step 1 | in the re-verify section |
| 1 | `auto` consults the judge | done `369c4ac3` | **Task 1's premise was wrong**: `auto` has consulted the judge since G2 (`consultGuardianForBorderline`, eligibility gate at `pi-agent.ts` `autoBorderlineEligible`). No production change; added the 2 missing uncertainty-tag pins (`failure`, `circuit-open`). Probe (uncertain→allow) re-failed 4 tests. `allow-all` untouched. | guardian suite 36 pass pre-existing +2 new |
| 2 | Trusted sets in managed policy | done `261b0162` | 8 policy tests + 4 PiAgent tests; deny-floor test proves a managed `permissionDsl` deny outranks a judge that cleared the action; project-scope probe re-failed exactly the exclusion test; `$defaults` splice + Danger case + sentinel consumption pinned | managed-policy suite 20 pass |
| 3 | Plan-mode route | done `dee851e2` (docs only) | findings appended above: no routing exists, no `useAutoModeDuringPlan`, plan-allowed set and auto band are disjoint → both shapes ruled out (widening = stop condition; narrowing = no-op) | measured table in Task 3 |
| 4 | Policy-aware exclusion | done `87f5ff39` + `21bc8a67` | 7 tests; band-level (not supervisor) so `resolveIsolationDowngrade` diff is empty and strict mode stays terminal; probe (always-fall-through) re-failed 3 tests. **Live verification caught a hole the units missed**: the shipped read-only allowlist auto-allowed `docker ps` before the exclusion check — `21bc8a67` moves the sandbox axis ahead of the ask-mode rules, +2 regression tests | escape-hatch suite untouched and green |
| — | Final Verification | done | full wave 5339 pass / 7 skip / 0 fail (526 files); `typecheck:all` clean; both i18n linters green (parity 1980 keys); `git diff --check` clean; `electron:build` ✓ 23.5s; loader + process-supervisor diffs empty; no model-facing `dangerouslyDisableSandbox` | this row |

**Deferred with reasons:** `classifyAllShell` (band control, no consumer until the band
is threaded — `exact()` refuses it, pinned by a test). Judge-side four-tier *enforcement*
is prompt-text only by design (entries are prose; the deterministic gate stays the only
authority). Live model turn: `blocked: JWT fill is behind an Electron IPC handler the
headless runner cannot reach` — judged paths verified through the production
`handlePreToolUseRequest` with only the judge port faked; CDP wave at series end covers
the rest.

Status values: `not started` / `in progress` / `blocked: <why>` / `done <commit>`.

**Stop conditions.** Halt and report rather than working around:

- A task needs the judge to approve something the deterministic gate would have
  prompted for. That is widening, and it is R15's.
- Task 3 requires widening what `plan` mode permits.
- A trusted set can override a deny rule in any test.
- Wiring `auto` costs a judge call for actions outside the band.
