# Inert unit U-E — honesty and dead weight

Closes the nine rows in `2026-07-29-inert-worklist.md` §5 U-E. All commits are on
`fix/renderer`.

| Row | Ruling | Commit |
| --- | --- | --- |
| Skill `disallowed-tools` — parsed, syntax-validated, enforced nowhere | **finish** | `90c9af55` |
| `DOCUMENTED_SKILL_FIELDS` `context`/`background`/`hooks`/`shell` | **warn** | `55b711ce` |
| `SendUserFile` — the last "delivers file content" claim | **fix the claim** | `e55eae06` |
| `ManagedDeliveryStateV1.fatalError` + `.awaitingApproval` | **finish (one reader)** | `ddecda07` |
| `ManagedPolicyCompositionV1.winner` / `ManagedPolicyWinnerV1` | **keep, record the surface** | `3b6be75f` |
| `isManagedChannelServerAllowed` | **fold into the live path, delete the helper** | `42cf8850` |
| `PiPermissionReceiptV1.policyMatch` | **delete** | `3a57a709` |
| `MailboxService` / `mailboxState` / `fromAgentId` | **neither — record as R23** | `d04ba6e7` |
| `mode:'interactive-unavailable'` + `outcome:'deferred'` | **keep, record why** | `a5d14818` |

## The contract, re-derived from the pages

`curl -sL` on 2026-07-29: `skills.md` **929 lines**, `server-managed-settings.md`
**274**, `settings.md` **718**, `permissions.md` **567**. Line numbers below are
from those fetches and are expected to rot.

`skills.md:262` — `disallowed-tools`: "Tools removed from Claude's available pool
while this skill is active. Use for autonomous skills that should never call
certain tools, such as `AskUserQuestion` for a background loop. Accepts a space-
or comma-separated string, or a YAML list. The restriction clears when you send
your next message. Like deny rules, the field can't remove `EndConversation`
while any other tool remains." `:430` repeats it in prose.

`skills.md:262`-`:268`, the four we do not implement: `context` — "Set to `fork`
to run in a forked subagent context"; `agent` — "Which subagent type to use when
`context: fork` is set"; `background` — "Only applies with `context: fork`";
`hooks` — "Hooks scoped to this skill's lifecycle"; `shell` — "Shell to use for
`` !`command` `` and ` ```! ` blocks … Accepts `bash` (default) or `powershell`".

`server-managed-settings.md:180` — "When no field in the payload can be salvaged,
Claude Code keeps the last-accepted cached settings and **records a fatal
error**." `:218` — "If an interactive session can't show the dialog, Claude Code
doesn't apply the delivered settings and keeps the last-approved settings; the
dialog appears in the next session that can show it." `:143` — "Run `/status` to
see which managed source is active."

`settings.md:705` — "`/status` … the **Status** tab includes a `Setting sources`
line … When managed settings are in effect, the entry shows the delivery channel
in parentheses, for example `Enterprise managed settings (remote)`, `(plist)`,
`(HKLM)`, `(HKCU)`, or `(file)`."

`permissions.md:31` — "`/permissions`. This UI lists all permission rules and the
`settings.json` file each rule comes from." Rule-to-source attribution, read off
the rules. Nothing on any page documents decision-to-rule attribution carried on
a permission receipt.

## Did these rows undercount their real scope? Yes — three ways.

1. **`disallowed-tools` needs TWO enforcement chokepoints, not one.** The row
   names `applySkillInvocationGrant`. The second is
   `SessionManager.ts` §child-session admission, where `narrowRuntimeSkillTools`
   already narrows the pinned tool list a child session is admitted with: a skill
   preloaded into a subagent runs its calls *inside the child*, whose gate has
   its own `PrerequisiteManager` and never sees the parent turn's removal. Fixing
   only the parent seam would have left every preloaded skill's removal inert on
   exactly the "autonomous skill" case `skills.md:262` names as the reason the
   field exists.
2. **`isManagedChannelServerAllowed` is a missing narrowing, not a redundant
   duplicate — and the row's own correction was also wrong.** The row says a
   denied server "is already stripped upstream at `storage-runtime.ts:577-580`,
   so it can never arm a channel". That strip is inside
   `if (!isPiCapabilityTurn) return true`, so it does not run on a non-Pi turn.
   And the narrowing cannot be expressed by subtracting from the allowlist the
   live path already builds: with no layer naming one, `allowedSources` is
   `undefined`, which means *no per-source restriction*, so there is nothing to
   subtract from. Deny had to become its own list on `ChannelPolicy`.
3. **`SendUserFile` had a third claim, in a package the row's own citation did
   not cover.** `cf74b760` fixed `tool-defs.ts`; the row also named
   `runtime-agent-definitions.ts:79`, which is in `pi-agent-server` and still
   called it the tool that "delivers file content". Not model-visible (it is a
   TS comment justifying why the tool stays out of the implicit subagent grant),
   but it is the same false statement in the place a maintainer reads.

One row was **overcounted**: `awaitingApproval`'s "dead enum arms". See the
ruling below — `interactive-unavailable` is an exported host-facing parameter
that `server-managed-settings.md:218` requires to exist, not internal state.

## Rulings and reasoning

### Skill `disallowed-tools` — finish

Subtraction *is* expressible at `applySkillInvocationGrant`; the reason it was
never written is that the whole grant path is shaped as narrowing.
`narrowRuntimeSkillTools` intersects, `setSkillInvocationToolCeiling` stores an
allowlist, and `checkSkillToolCeiling` blocks a name that is absent from it — so
there was no state a removal could live in when the skill declares no
`allowed-tools` at all. It is a second, independent piece of state for that
reason: folding it into the ceiling would make the removal depend on a grant
existing.

Enforced at the prerequisite gate rather than by filtering the signed manifest,
which is where "removed from the available pool" would literally live. A
model-invoked skill lands mid-turn — `buildModelSkillContinuation` re-applies the
grant after the pass's manifest is already signed — so a manifest-level filter
would honour a user-invoked skill and silently ignore a model-invoked one. The
gate is on every call under both backends (`pre-tool-use.ts` for Claude,
`pi-agent.ts` for Pi) and its lifetime is already exactly the documented one:
`clearSkillInvocation()` in `chat`'s `finally` *is* "clears when you send your
next message".

Matched by glob on the canonical tool name, which is exactly what the
identically-named **subagent** field does (`spawner.ts:201` filters the agent's
tool list through `matchesToolPattern`). Nearest-equivalent, so the two spellings
of one documented idea cannot drift.

The `EndConversation` carve-out is decided in `base-agent`, the layer that knows
the pool: with a pinned `piAllowedTools` and at least one non-removed tool left
in it, the exception holds; an unknown universe keeps it too, because the pool is
then the full built-in set. Only a rule that removes everything else may take it
— "alone, it is removable like any other tool", the same shape
`filterCapabilityIdentitiesByWholeToolDeny` already enforces for deny rules.

Digest safety: `disallowedTools` is appended LAST in both `frozenUnsignedRecord`
and `validateSkillInvocationSnapshot`, after `effort`, so a record without the
field keeps the exact key set — and therefore the exact `JSON.stringify` — it had
before. Pinned by test.

### The four `DOCUMENTED_SKILL_FIELDS` keys — warn

The list's only effect is to suppress "Unknown frontmatter field … it will be
ignored". Putting an unread key in it tells an author the key is fine while the
runtime drops it — the inverse of the `disallowed-tools` defect, where we
validated a field's syntax and ignored the field. They now warn as
documented-but-unimplemented, each naming what is missing, in a separate map so
a key moves back to the honoured list only when something reads it.

Their neighbour `agent` **is** enforced, which is why the group looked supported:
ours is an agent *ceiling* on the invoking turn, not `skills.md:263`'s fork
target. `hooks` and `background` were already costed with categories in R30c and
deliberately not half-built; that costing is unchanged, this only makes it
visible to the author instead of to an auditor.

### `fatalError` and `awaitingApproval` — finish, one reader

`:180` requires the fatal error to be *recorded*. A field whose only readers were
two assertions in its own test file is not a record, so deleting it would have
dropped a documented behaviour whose implemented half (cache preservation) is
already correct. `:218`'s hold-back has the mirror problem: the mechanism works
without the field (through `source: 'none'`), so the field's entire job is to say
*why* the organization's new settings are not in effect — and it said nothing.
One reader serves both.

Reported at `publish()`, the single function every state change passes through,
for the reason `storage-runtime.ts` gives for the drop list: printed centrally so
no host can forget it. That is also what settles the ordering asymmetry which
deferred the `drops` reader as an owner decision — the desktop shell builds its
storage runtime *before* delivery is initialised, so a host-side read reports in
the headless host and silently not in the desktop one. A publish-site report
cannot have that asymmetry, so this is not a re-litigation of that decision.

No value travels: the fatal error is a fixed sentence, and the hold-back line
carries a count and the approval *categories* only — never a field name or a
value, because a managed `env` block routinely holds a credential. Pinned by
test. De-duplicated so the hourly poll cannot repeat a line every hour.

### `ManagedPolicyWinnerV1` — keep, record the surface

Not decoration. It is the computed half of `settings.md:705` — `/status`'s
`Setting sources` line showing `Enterprise managed settings (remote)` vs
`(file)` — and `server-managed-settings.md:143` sends a user to exactly that
line for exactly this question. So the reason nothing reads it is that the
`/doctor`/`/status`-class surface does not exist yet, and that surface has a
named owner (R30b). Category: `documented, not implemented`. It is free to
compute and `composeManagedPolicySources` is pure, so label and policy can only
disagree if they are ever derived twice. The docblock now names the surface, so
the next sweep does not re-file it as inert.

### `isManagedChannelServerAllowed` — fold in, then delete

Established before touching: **a missing narrowing**, not redundancy. It is the
only place `deniedMcpServers` reached the channel gate. `resolveManagedChannelPolicy`
now honours it, on `ChannelPolicy` as a `deniedSources` list checked first — deny
terminal, the shape every other managed helper has. The helper is deleted because
its content is on the live path, not because it was dead.

### `policyMatch` — delete

The only row where deletion won. Fourteen production writes, full wire
validation, and three consumers that all destructure around it. Both plausible
sinks exclude it *deliberately*: `projectPiPermissionTelemetry` takes
`Pick<receipt, 'outcome' | 'binding'>` and bounds every id through `SAFE_ID`,
with a test that pins an admin-authored rule id and source digest not leaking;
the model-facing `reason` is product text. And no page documents
decision-to-rule attribution — `permissions.md:31` attributes *rules* to their
settings file in a UI that reads the rules directly. So unlike `fatalError` and
`winner`, this is not the shipped half of a documented behaviour; it is a field
on a security artifact that the receipt validator has to keep being right about
for no reader. Deleting it removes the `else if (readableDecision.match)` arm in
`pi-agent.ts`, whose only effect was to attach it.

### `interactive-unavailable` / `deferred` — keep, record why

The row calls these "dead enum arms"; they are an exported host-facing parameter
and its outcome. `server-managed-settings.md:218` requires the state to exist —
an interactive session that cannot show the dialog does **not** apply the payload
— and `managed-approval-dialog.ts` already documents when a host should pass it.
Nothing produces it because Electron's `dialog.showMessageBox` needs no window,
so the desktop shell can always prompt, and the headless host is `:221`'s case.
Collapsing it into `non-interactive` would apply a payload the doc says to hold
back. Category: `documented, implemented — no host state requires it today`.

### The mailbox chain — neither

`MailboxService`, `mailboxState`, `PiMailboxMessageV1.fromAgentId` and the
harness snapshot's permanently-zero `messageCount` are R23's per-agent JSON
mailbox. R23 is `⬜ not started` in the parity audit with "First step is a
judgement call on whether we want the model, not a build."

**How much there is, and whether any of it is reachable.** Six declarations
across three packages: the type pair in `shared/src/sessions/types.ts`, the
`mailboxState` slot on the managed-session record (in the frozen persisted-key
list), the service in `server-core/src/pi-harness/mailbox-service.ts`, its
construction in `SessionManager`, the `PiHarnessMailboxSummaryV1` projection in
the runtime snapshot, and its wire parser in `protocol/pi-harness-runtime.ts`.

Reachable: **no**, and deliberately so rather than by accident. The service *is*
constructed in production with a real persist closure, but with no `profile`, so
`send()` refuses with `peer-messaging-disabled` before it can write; `.send()`
and `.list()` have no non-test caller; `piMailboxServices` is only
set/deleted/cleared, never read back; `messageCount` is therefore permanently
`0`; and `rg mailbox` over `apps/electron/src`, `packages/ui/src`, `apps/webui`,
`apps/viewer` and `packages/cli` returns nothing.

It is a **partial build of an undecided feature**, not dead weight — both
deleting it and finishing it would pre-empt the judgement call. Recorded as
`documented, not implemented — R23` in the code itself, where the next sweep will
read it. Live inter-session messaging is the unrelated `send_agent_message`.

## Grep evidence before each deletion

- **`isManagedChannelServerAllowed`** — `rg` over the whole repo (not just `-t ts`):
  one definition, three assertions in `managed-policy.test.ts`, four mentions in
  `docs/`. No barrel re-export (`packages/shared` has no `pi-harness/index.ts`
  and `package.json` exports the module path directly), no string-keyed registry,
  no spread of the module namespace.
- **`policyMatch`** — `rg -F "...receipt"` for whole-struct spreads (the only two
  hits are `PiHarnessExecutionReceiptSummaryV1`, a different type, and test
  fixtures); no `Object.keys`/`Object.entries` over a permission receipt; the
  receipt is hand-validated, not Zod, so no `.passthrough()` could carry it; the
  only JSON serialization of the whole struct is the `pre_tool_use_response`
  wire message, whose parser is `parseAndFreezePiPermissionReceipt` itself and
  whose `RECEIPT_KEYS` is updated in the same commit; no dynamic import, no
  template literal, no alias re-export (`PiPermissionPolicyMatch` was
  module-private and is removed with it).
- **`PermissionDslMatchV1`** kept — still the return type of
  `evaluatePermissionDslV1`; only the receipt's carriage of it is gone.

## Gate evidence, on the final diff

Every command run from the repo root.

| Check | Result |
| --- | --- |
| `bun run typecheck:all` | exit 0 |
| `bun run lint` | exit 0 (4 warnings, 0 errors) |
| `bun test packages/shared/src/{agent,capabilities,config,skills} packages/session-tools-core packages/shared/tests/mcp-pool.test.ts` | **2968 pass / 3 skip / 2 fail** |
| `bun test packages/server-core/src/{pi-harness,sessions,bootstrap}` | **685 pass / 2 fail** |
| `bun test packages/pi-agent-server` | **471 pass / 1 fail** |

All five failures are on the known pre-existing list and were not touched by this
unit:

- `config path default-root classification > treats an empty override as the default root` ×2 (`paths-default-root`)
- `SessionManager Pi child orchestration composition > retains the originating capability authority for a background workflow across turn cleanup`
- `SessionManager Pi child orchestration composition > retains the spawning turn hook authority through background SubagentStop and TaskCompleted`
- `Pi harness R0 baseline > executes golden foreground and background process contracts`

The skill grant is a permission decision, so the permission/mode, skill and
managed-policy suites above were run once on the final diff rather than per
commit, per the implementation-first verification budget.

## Propagation found — reported, not fixed

1. **`storage-runtime.ts` skips the whole managed MCP filter on a non-Pi turn.**
   `if (!isPiCapabilityTurn) return true` in the native-record filter, and the
   same guard on `pluginCandidates`. So `deniedMcpServers`, `allowedMcpServers`
   and `isManagedPluginAllowed` are all unenforced under the Claude backend. The
   worklist notes this as a residual of the channel row; the channel half is now
   closed at the gate, the record-filter half is not. Bigger than one row.
2. **`SkillMetadata.disallowedTools` is dropped by both display projections.**
   `capabilities/native-sources.ts` pins `skillAllowedTools` but no
   `skillDisallowedTools`, and `plugins/format-adapters/shared.ts` drops it from
   the plugin-skill controls projection. Neither is on the enforcement path —
   `materializeRuntimeSkillInvocation` reads the SKILL.md frontmatter directly —
   so this is a Sources-UI gap, not a permission one, and it belongs with the
   recorded Sources UI divergence rather than here.
3. **`execution-observability.test.ts` pinned telemetry against `policyMatch` by
   name.** Retargeted to a generic extra field, so it still pins that an
   unexpected receipt field cannot leak into OTLP. If a future field wants the
   same guarantee it should be added there deliberately.

## List claims that were wrong about the code

- "a denied server … can never arm a channel" (§2 `isManagedChannelServerAllowed`)
  — true only on a Pi capability turn; see undercount 2.
- "`awaitingApproval` … + its dead enum arms" (§5 U-E) — `interactive-unavailable`
  is a live exported parameter with a documented meaning, not dead state.
- The `SendUserFile` row's `tool-defs.ts:628` half was already closed by
  `cf74b760` before this unit started, as the caveat block says; only the
  `runtime-agent-definitions.ts` half remained.
