# D1–D4 — the managed policy accepts what it does not enforce

Four rows, one sentence: **an administrator configures the fleet, the key
validates and saves, and nothing enforces it.** For a bank fork that is worse
than a missing feature — a missing feature is visible, and this is not. Every
one of these was found by reading code, not by anyone noticing.

Order matters here. D1 first (cheapest and the clearest lie), D2 second (egress
makes it the highest-value), D3 third, **D4 last** so its re-read path picks up
the corrected semantics of the other three rather than re-freezing them.

## 0. Method rules

1. `curl -s` the pages — `settings.md`, `server-managed-settings.md`,
   `permissions.md`, `auto-mode-config.md`. Quote WHOLE lines.
2. **Declared ≠ enforced.** For each row, name the PRODUCTION consumer that
   exists after your change. "It has a test" is not a consumer — that is the
   defect being fixed.
3. **NUL bytes** — always `grep -a`; never `head -N` a grep whose hit count you
   have not counted.
4. **Two git commands** — pathspec on the `commit`. One commit per task.
5. **Run every test from the repository ROOT.** A package-directory run
   destroys the user's real `~/.nessy-agent/config.json`.
6. CDP instances are live on ports **9223 and 9224** — do not kill, drive or
   rebuild for either. Do not run `electron:build:servers` or `electron:dev`.

---

## 1. Task 1 — `classifyAllShell` has a reader (D1)

**Commit:** `fix(policy): the managed classify-all-shell key reaches the auto-mode band`

`resolveAutoModeClassifyAllShell` (`managed-policy.ts:950`) has **only test
callers**, so an allow-matched Bash command still runs unclassified while the
key validates and saves. The administrator believes the fleet is under the
guardian; it is not.

- One production reader, at the auto-mode band. Read `auto-mode-config.md` for
  what the key is supposed to widen and quote the line.
- **The guardian consult was narrowed today** (`8c2990ad`): a non-negotiable
  prompt never reaches the judge. Classifying MORE commands must not route a
  floor into the judge — assert that a removal-breaker command in `auto` still
  reaches the human with the key on.
- State in the report what an allow-matched command does when the classifier
  rejects it, and make sure that is the documented answer rather than a new one.

**Gate:** with the managed key on, an allow-matched Bash command is classified
(approved runs, rejected blocks); with it off, behaviour is byte-identical to
today; a non-negotiable floor still prompts either way. **Mutation:** drop the
reader → the classified test goes red.

---

## 2. Task 2 — the managed-only lock closes every door (D2)

**Commit:** `fix(policy): the managed-only lock covers the widening appliers`

`allowManagedPermissionRulesOnly` gates `addPermissionDsl` only
(`permissions-config.ts:939-999`); **three appliers run unconditionally**, so a
workspace or source `permissions.json` can still add an allowed tool, a write
root, or an `allowedApiEndpoints` **egress target** under the lock. Found only
by auditing a machine.

- The appliers need **scope provenance** — which source a contribution came
  from — and must drop non-managed contributions **to allow-direction fields
  only**. Read that constraint twice: the app's own read-only defaults and every
  DENY-direction contribution must survive, or the lock becomes a way to make
  the product less safe.
- Egress is why this is the group's highest-value row. `allowedApiEndpoints` is
  a network allowlist; a non-managed layer widening it under a lock the admin
  set is the failure the lock exists to prevent.
- Say in the report exactly which fields are allow-direction, how you decided,
  and what happens to a contribution that carries both directions.

**Gate:** under the lock, a workspace `permissions.json` adding an allowed tool,
a write root and an `allowedApiEndpoints` entry contributes NONE of them, while
a deny it declares still applies and the app's own defaults are untouched;
without the lock nothing changes. **Mutation:** let one applier through → its
test goes red.

---

## 3. Task 3 — an anchored path rule is enforced, not dropped (D3)

**Commit:** `fix(permissions): a settings-anchored path rule reaches the layer`

A fleet admin writes `deny: ["Read(/secrets/**)"]` in the documented
`/`-anchored form and gets **zero coverage** — the rest of the layer applies, so
nothing looks wrong. `claude-project-settings-permissions.test.ts:82` already
asserts 2 of 3 rules vanish, which is the defect pinned as if it were the
contract.

- **The seam exists**: `permission-dsl` accepts `layer.sourceRoot` and it is
  already threaded for skill grants; `pinnedConfigs`/`addPermissionDsl` simply
  do not pass it. Thread it rather than building a second path.
- **Managed REMOTE policy has no source directory** and must keep dropping such
  a rule — a delivered policy has no file to anchor to. Document that half
  rather than inventing a root for it, and make the drop say why.
- Update the test that pins the defect. Its new assertion is the contract.

**Gate:** a `/`-anchored deny in a project settings file denies; the same rule
delivered by remote managed policy is dropped with a stated reason; a relative
rule is unchanged. **Mutation:** stop passing `sourceRoot` → the anchored-deny
test goes red.

---

## 4. Task 4 — delivered policy is re-read, not frozen (D4)

**Commit:** `fix(policy): a tightened managed policy reaches a running session`

An admin tightens policy after an incident — denies an MCP server, drops a
permission — and **every desktop already running keeps the snapshot taken at
`SessionManager` construction**. The fleet stays on pre-incident rules for as
long as users leave the app open, and the admin cannot see who is stale.

- Re-read on the signals that already exist. `config/watcher.ts` carries file
  change signals and the delivery cache has its own refresh; use them rather
  than polling.
- **Tightening must apply immediately; loosening is the question to answer
  deliberately.** Say what you chose and why. A mid-turn widening that lands
  between the gate and the tool call is a security event, not a convenience —
  if in doubt, apply a widening at the next turn boundary and a tightening at
  once.
- **An in-flight turn is the hard case.** A permission already granted for a
  running tool call must not be re-evaluated into an inconsistent state; state
  what happens to a call that is mid-flight when policy tightens.
- Do this LAST so it re-reads the corrected semantics from Tasks 1–3.

**Gate:** with a session running, tightening the delivered policy denies the
newly-denied MCP server on the next call without a restart; the app's own
defaults and an unrelated session are unaffected; an in-flight call behaves as
stated. **Mutation:** restore the construction-time freeze → the re-read test
goes red.

---

## 5. Task 5 — category strings

**Commit:** `docs(audit): what the managed-policy honesty work leaves open`

Unwrapped, unbolded, backtick-terminated, no inline backticks in the reason,
under 400 characters. At minimum: the loosening semantics you chose, and the
remote-policy anchor that stays dropped.

## 6. Gate

Focused suites per changed file; the config, pi-harness, permissions and
server-core aggregates once on the final diff; `bun run typecheck:all` **exit 0
with zero `error TS`, stated explicitly**; `bun run lint`; i18n parity + sorted
if strings are added; `git diff --check`.

**Managed policy, permission decisions and egress are all named risk triggers**
— run the expanded set once on the final diff, not after every edit.

Known-failing rows: `docs/superpowers/specs/2026-07-29-known-failing-tests.md`.

## 7. Constraints

- You own `packages/shared/src/agent/pi-harness/managed-policy.ts` and its
  neighbours, `packages/shared/src/config/permissions-config.ts`,
  `packages/shared/src/agent/permission-dsl.ts`,
  `packages/server-core/src/bootstrap/**`,
  `packages/server-core/src/sessions/SessionManager.ts`, and their tests.
- **A sibling executor may run on `packages/session-tools-core/src/runtime/**`,
  `server-core/src/pi-harness/isolation*`, and another on
  `packages/shared/src/plugins/**` + the renderer's plugin pages.** Stay out of
  both. `scripts/cdp/**` belongs to a third — never touch it.
- **A pathspec commit takes the WORKING TREE, not your hunks.** Two executors
  crossed on `SessionManager.ts` earlier today and each landed under the other's
  subject. Commit promptly after each task, and if you find a file dirty with
  work that is not yours, report it rather than committing it.
- One commit per task, subjects exactly as given. **No `Co-Authored-By`.** No
  push/MR/tags/reset/rebase/`--amend`/`checkout --`/stash of edited files.
  Restore mutation probes by re-edit or an `.orig` copy, **never git**.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`.
  No version bumps or release notes. Never write `~/.nessy/dp_auth_creds.json`.
- **Never test managed policy against the user's real managed-policy file or
  real config dir** — temp dirs you created, always. Never point a probe at a
  real external host.
- Code, comments and commits in English.

## 8. Report

Commit shas; each defect reproduced; the production consumer that now exists,
named, for each of the four; which fields you classified as allow-direction and
how you decided; the loosening semantics and the in-flight-call answer;
residuals word for word; corrections to this plan; mutation probes with which
side went red; the explicit typecheck statement.

### 8a. What this work leaves

Ten strings, each measured against the code as committed. Two are the decisions
Tasks 1 and 4 were told to take deliberately and state; three are bounds this
group chose on purpose so the locks cannot make the product less safe; three are
surfaces D4's re-read does not reach in one pass; one is a scope fact about the
key's own sentence; one belongs to another executor's commit.

- deliberate divergence, stated — a policy change is adopted MID-TURN only when it tightens; everything else waits for the next turn boundary. Tightening is structural: an added constraining key, or a named deny list that only grew. Any other changed value waits a turn even when it reads tighter, since a false immediate is a widening between gate and call: `isManagedPolicyTightening`
- deliberate divergence, stated — an in-flight tool call is never re-decided in either direction. The policy is read by the gate; the decision is minted as a receipt bound to the manifest generation, hash and response epoch, and the executor authorizes against the receipt. A policy change therefore takes effect from the next gate evaluation and cannot reach backwards: `refreshManagedPiPolicy`
- ours, stated — a settings-source-anchored rule delivered by REMOTE managed policy is still dropped, per rule, because a delivered document has no file to anchor to and inventing a root would point an administrator's rule at a directory they never named. The drop names the rule, the reason and the remedy on the diagnostic stream instead of failing the whole layer closed: `managed-anchored`
- deliberate divergence, stated — the managed-only lock drops non-managed contributions to allow-direction fields ONLY. Deny fields survive, and a toolRules array carrying both is split entry by entry. This key's doc row also names deny; its three sibling locks carve the deny half out, and a lock that made the product less safe is the outcome to refuse: `underLock`
- ours, bounded — the app's own permissions default layer keeps its read-only CLASSIFICATION under the lock, because dropping 196 bash and 15 MCP patterns would make every read-only command in safe, plan and auto prompt, and an administrator would switch the lock off. Its grant fields drop; the shipped file declares none, so today this costs nothing: `readOnlyClassificationAllowed`
- ours, bounded — that default layer lives in the user's own config directory and is user-writable, so under the lock a user who edits it can still widen the read-only allowlist. The genuinely dangerous grants there are closed, egress included; the classification is not: `permissions/default.json`
- documented, not implemented — D4 makes the SessionManager capture live, and the capability resolver keeps its own construction-time managed capture. So a delivered deniedMcpServers reaches the channel gate and the permission readers without a restart, while the resolver's admission filter still applies the boot policy until the next launch: `createCapabilityResolutionInputProviderV2`
- ours, bounded — the subsystems composed once per manager stay composed once: the process supervisor's sandbox settings, the workflow settings and the auto-compaction settings. Rebuilding a live supervisor mid-session is a different unit, and their inputs were already recorded as process-lifetime config: `resolveHostSandboxSettings`
- ours, stated — classifyAllShell is read from the MANAGED scope only, because no user autoMode scope is wired in this product and a checked-in repo must not steer the classifier band. The composer accepts a user scope and nothing supplies one. Our single shell tool is Bash, so the key's Bash-and-PowerShell pair is one tool name here: `resolveAutoModeClassifyAllShell`
- another executor's zone — managed-policy.test.ts is red at HEAD because a sibling commit added extraKnownMarketplaces to the schema key list without extending the everyKeyValid fixture the sweep compares against. The file is mine and the change is theirs, so it is reported rather than fixed: `covers every key the schema accepts`
