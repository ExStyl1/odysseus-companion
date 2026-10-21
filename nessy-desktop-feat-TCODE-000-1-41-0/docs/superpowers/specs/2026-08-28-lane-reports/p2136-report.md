# P2.136 — a managed lock was sent without its operand

**Status:** DONE (carry fix + sub-key surfacing both landed).
**Commit:** `5d812230b` on `feat/TCODE-000`, exactly two files, no trailers.
**Tests:** 37 pass / 0 fail on the zone file; re-breaking the operand carry fails 6.

No surfacing blocker: the finer shape is additive and the single production
consumer absorbed it unchanged, so nothing outside the zone was touched.

**Zone touched, and nothing else:**

- `packages/shared/src/agent/claude-managed-settings.ts`
- `packages/shared/src/agent/__tests__/claude-managed-settings.test.ts`

`packages/shared/src/agent/permissions-config.ts` was never touched. No locale
strings were added (the diagnostics channel is `ClaudeAgent.debug`, not UI).

---

## 1. Reproduced first, on HEAD, before any edit

Driven through the real parser (`parseManagedPiPolicyTolerantV1`, source
`/etc/nessy/managed-policy.json`) so the fixture is a document an administrator
could actually deploy. Parser drops: `[]` — the fixture was not quietly stripped.

Policy (the row's, verbatim):

```json
{ "sandbox": {
    "network":    { "allowManagedDomainsOnly": true,   "allowedDomains": ["corp.example"] },
    "filesystem": { "allowManagedReadPathsOnly": true, "allowRead": ["/opt/corp"] } } }
```

**Before-state, measured:**

| what | value |
| --- | --- |
| reaches the SDK | `{"sandbox":{"network":{"allowManagedDomainsOnly":true},"filesystem":{"allowManagedReadPathsOnly":true}}}` |
| `mapped` | `["sandbox"]` |
| `unsupported` | `[]` |
| diagnostics | `["[managed] claude policy tier carries: sandbox"]` |

Both locks arrived. **Neither list did.** The surfacing reported a wholly-mapped
key and no gap at all. The row's description is correct in every particular of
this measurement.

**After the fix, same fixture, same rig:** both locks *and* both lists arrive;
`mapped=["sandbox"]`, `withheld=[]`, one diagnostic line unchanged
(`carries: sandbox`) — because with the operands carried there is nothing left
withheld to mark partial.

---

## 2. Documentation — category (b), and the docs settle it

The row is squarely category (b): `sandbox.network.*` / `sandbox.filesystem.*`
are documented settings keys and the managed tier has its own page. Anchors were
obtained by curling the **rendered** page and grepping `id="…"` (not derived from
a slug rule). All three pages are in `scripts/claude-doc-pages.tsv`.

### The rule itself — a lock's value is not a widening

`managed-settings.md#managed-only-settings` (explicit `<span id>` anchor;
the heading beside it publishes `#keys-only-a-managed-source-can-set`):

> "Most of them are locks: the value a lock governs, such as permission rules or
> `sandbox.network.allowedDomains`, is an ordinary key that any level can set,
> and the lock tells Claude Code to honor only the managed value."

That is the widening-vs-operand distinction stated by the documentation, naming
`sandbox.network.allowedDomains` by name. **A lock whose managed value is absent
honors nothing.**

### What each lock does, and what an empty managed list means

`settings-reference.md#sandbox-network-allowmanageddomainsonly`:

> "Lock the network allowlist to what managed settings define. Claude Code then
> honors only `allowedDomains` and `WebFetch(domain:...)` allow rules from managed
> settings, ignores domains from user, project, local, and `--settings` settings,
> and blocks a non-allowed domain automatically instead of prompting."

⇒ lock + empty managed list = **every host blocked, without a prompt.** The row's
"deny-every-host" is confirmed.

`settings-reference.md#sandbox-filesystem-allowmanagedreadpathsonly`:

> "Honor only the `allowRead` entries that come from managed settings, so
> developers can't re-open read access to paths your organization blocked.
> `denyRead` entries still merge from every settings file."

with `settings-reference.md#sandbox-filesystem-allowread`:

> "Re-open reading for specific paths inside a region that `denyRead` blocks, to
> build workspace-only read access."

and `sandboxing.md#keep-developers-from-widening-the-policy`:

> "Set `allowManagedReadPathsOnly` to `true` in managed settings so that only
> `allowRead` entries from managed settings are honored."

### Two corrections to the row (the measurement wins)

1. **The quoted SDK string belongs to a different key.** The row attributes
   "deterministically denies hosts not in `allowedDomains`" to
   `allowManagedDomainsOnly`. That sentence is `strictAllowlist`'s, in
   `sdk.d.ts` and in `settings-reference.md#sandbox-network-strictallowlist`
   ("Deny sandboxed commands access to hosts outside the allowlist instead of
   prompting for approval"). **The conclusion survives intact** — deny-every-host
   is established by `allowManagedDomainsOnly`'s own sentence, "blocks a
   non-allowed domain automatically instead of prompting". Nothing about the fix
   changes.

2. **"deny-every-read" overstates the filesystem half.** `allowRead` re-opens
   paths *inside* `denyRead` regions; it is not the read gate itself. Lock +
   empty managed list therefore means "nothing is re-opened inside any `denyRead`
   region, from any source" — which is a total read denial *of the regions the
   policy denies*, not of the whole filesystem. In the row's own fixture (no
   `denyRead` at all) the filesystem half is close to inert; in the realistic
   deployment the doc itself gives (`denyRead: ["~/"]`, `allowRead: ["~/work"]`,
   lock) the dropped operand is exactly the "deny every read" the row means. The
   defect and the fix are unchanged; the blast radius is narrower than stated.

---

## 3. The SDK filter, re-measured — the operand rides through

Extracted from the shipped `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`
(vendored 0.3.223, the version the module's extraction is pinned to), anchored on
the settings key `allowManagedHooksOnly===!0` per the method the module docblock
pins. Verbatim:

```js
if(o){let l=hor(o,["deniedDomains"]);
  if(o.allowManagedDomainsOnly===!0)l.allowManagedDomainsOnly=!0;
  if(o.strictAllowlist===!0)l.strictAllowlist=!0;
  if(t.sandbox?.network?.allowManagedDomainsOnly!==!0&&o.allowedDomains)l.allowedDomains=o.allowedDomains;
  if(Object.keys(l).length>0)a.network=l}
if(i){let l=hor(i,["denyRead","denyWrite"]);
  if(i.allowManagedReadPathsOnly===!0)l.allowManagedReadPathsOnly=!0;
  if(i.disabled===!1)l.disabled=!1;
  if(t.sandbox?.filesystem?.allowManagedReadPathsOnly!==!0&&i.allowRead)l.allowRead=i.allowRead;
  if(Object.keys(l).length>0)a.filesystem=l}
```

And the call site, which the row asserted and which I measured rather than
assumed — `t` (`f` here) is composed from the ADMIN tiers alone:

```js
let u=[r,o,s].filter(y=>y!==null),   // remote, MDM, file
    d=u[0]??null,
    f={ …, sandbox:{ network:{allowManagedDomainsOnly:u.some(y=>y.sandbox?.network?.allowManagedDomainsOnly===!0)||void 0},
                     filesystem:{allowManagedReadPathsOnly:u.some(y=>y.sandbox?.filesystem?.allowManagedReadPathsOnly===!0)||void 0}}},
    m=l&&vbg(d)?Ebg(l,f):null
```

`l` is our slice; `f` never reads it. So our operand is carried whenever no admin
tier set the same lock — and when one did, `vbg(d)` has already discarded our
whole slice, lock included. **There is no path on which the list arrives without
the lock that governs it**, which is what makes the carry safe.

---

## 4. The fix

`mapSandbox`, each list carried strictly inside its own lock's branch:

```ts
if (restrictiveTrue(sandbox.network?.allowManagedDomainsOnly)) {
  network.allowManagedDomainsOnly = true
  if (sandbox.network?.allowedDomains?.length) network.allowedDomains = [...sandbox.network.allowedDomains]
}
// …and the identical shape for allowManagedReadPathsOnly / allowRead
```

Direction preserved: a list arriving **without** its lock is still a plain
widening (it would merge on top of user/project entries) and is still withheld.
One lock does not smuggle the other list through. A lock with no list stays a
lock — deny-every-host is a policy an administrator may deploy deliberately and
the fix must not invent a list to soften it.

### Other `allowManaged*Only`-style pairs — the row asked, so I checked

Inventory taken from `managed-settings.md#managed-only-settings`'s own table,
cross-read against our `MANAGED_PI_POLICY_KEYS` and `SandboxSettingsV1`:

| SDK lock | its operand | in our schema? | verdict |
| --- | --- | --- | --- |
| `sandbox.network.allowManagedDomainsOnly` | `network.allowedDomains` | both | **FIXED here** |
| `sandbox.filesystem.allowManagedReadPathsOnly` | `filesystem.allowRead` | both | **FIXED here** |
| `allowManagedPermissionRulesOnly` | managed permission rules incl. `permissions.allow` | both | **NOT fixed — see below** |
| `allowManagedMcpServersOnly` | `allowedMcpServers` | lock **absent** from our schema | cannot arise |
| `allowManagedHooksOnly` | managed/plugin hooks, not a list we send | lock only | n/a |
| *(no `allowManagedWritePathsOnly` exists)* | `allowWrite` / `additionalWritableRoots` | — | stays a widening, correctly |

**The third pair is real and is NOT fixed here, deliberately.** With
`allowManagedPermissionRulesOnly: true` and `claudeRules.allow` set, the filter
would carry our `allow` (`if(t.allowManagedPermissionRulesOnly!==!0){…o.allow=i}`,
same admin-tier-only `t`), and the doc sentence quoted above names "permission
rules" in the same breath as `sandbox.network.allowedDomains`. Reasons for not
folding it into this row:

- Withholding `claudeRules.allow` is an explicit product decision ("a floor never
  grants") with its own gap row, its own rationale and its own tests. Reversing
  it is a policy call, not a defect fix.
- Its fail-closed outcome is materially different: an empty allow set means
  *nothing is pre-approved, so Claude asks* — the SDK's ordinary posture — not
  the hard, prompt-less deny the sandbox pair produces.
- **One residue does deserve its own row:** `WebFetch(domain:...)` allow rules
  count INTO the network allowlist
  (`settings-reference.md#sandbox-network-strictallowlist`: "The allowlist is
  `allowedDomains` plus domains from `WebFetch(domain:...)` allow rules, or only
  the managed settings entries when `allowManagedDomainsOnly` is set"). An
  administrator who expresses their allowlist that way, under
  `allowManagedDomainsOnly`, hits the *same* deny-all through a different key.
  Recommend a follow-up row; it needs its own measurement.

What DID change for that pair: the withholding is now **visible** (§5).

### One more finding, report-only

`sandbox.filesystem.disabled` exists in our `SandboxFilesystemSettingsV1` and the
SDK filter copies it at its restrictive pole (`if(i.disabled===!1)l.disabled=!1`,
i.e. "filesystem isolation stays on"). Our mapper neither maps nor reports it. It
is not an operand and not a widening, so it did not belong in this row's fix; it
is a candidate silent drop of a *restrictive* key. Same shape for the three SDK
restrictive sandbox keys our schema does not have at all
(`failIfUnavailable`, `autoAllowBashIfSandboxed`, `network.strictAllowlist`) —
those are schema gaps, not mapper gaps.

---

## 5. The surfacing, at sub-key granularity

New: `ClaudeManagedSettingsMappingV1.withheld: readonly ClaudeManagedSettingsWithheldSubKeyV1[]`
— `{ path, key, kind, reason }`, `path` dotted as an administrator writes it in
`managed-policy.json`, sorted by path.

**Consumer answer (the controller's ambiguity):** no blocker, and nothing outside
the zone was changed. `mapManagedPolicyToClaudeSettings` /
`ClaudeManagedSettingsMappingV1` have exactly **one** production consumer repo-wide
— `claude-agent.ts:2926-2934` — and it reads only `.settings` plus the formatted
lines. The module is not re-exported from `packages/shared/src/index.ts` or
`src/agent/index.ts`. So the finer shape is purely additive:

- `mapped` / `unsupported` keep their whole-key meaning (both are tied to the
  partition test and to `CLAUDE_MAPPED_POLICY_KEYS`, which are statements about
  whole keys);
- "partial" is **derived** from `withheld` in the formatter, never stored — the
  module's own rule against a second copy of the same fact.

Diagnostics now:

```
[managed] claude policy tier carries: sandbox (partial)
[managed] claude policy tier withholds sandbox.network.allowedDomains (widening): …
```

The `(partial)` marker is appended after the key name, so the existing readers
that grep `carries: <key>` are unaffected.

**The probe table is a measurement, not a restatement.** Each entry carries
`asked(policy)` and `sent(settings)`, and `sent` reads the **built `Settings`**.
So when the operand carry fires the entry disappears from `withheld` because the
value is genuinely in the payload — not because a second copy of the carry rule
was kept in agreement with the first. Six probes:
`claudeRules.allow`, `sandbox.excludedCommands`,
`sandbox.additionalWritableRoots`, `sandbox.filesystem.allowWrite`,
`sandbox.filesystem.allowRead`, `sandbox.network.allowedDomains`.

Two holes this closes beyond the row's own case:

- `claudeRules: { deny: [...], allow: [...] }` mapped `claudeRules` on the
  strength of its deny list, so the whole-key gap never fired and the withheld
  `allow` was **invisible**. Now: `carries: claudeRules (partial)` plus a
  withheld line.
- `sandbox.excludedCommands` / `additionalWritableRoots` / `filesystem.allowWrite`
  were withheld silently inside a carried `sandbox`. Now reported.

Negative control kept: a policy that withholds nothing prints no withheld line
and no `(partial)` marker. An alarm that fires on ordinary policy is one that
stops being read — this module was bitten by exactly that in P2.138.

---

## 6. Tests

**1 existing test changed, 10 added**, all in
`packages/shared/src/agent/__tests__/claude-managed-settings.test.ts`.

Changed: `a floor never widens › sandbox sends the denials and withholds the
grants`. Its fixture already carried `allowedDomains: ['corp.example']` beside
`allowManagedDomainsOnly: true` and **asserted the operand's absence** — it was
pinning the defect. The expectation now includes `allowedDomains`; the two real
widenings it also checks (`excludedCommands`, `additionalWritableRoots`) are
untouched, so the test still covers what it was written for.

`describe('P2.136 · a lock carries its operand')` — 5:

| test | what it pins |
| --- | --- |
| POSITIVE: the row's policy reaches the SDK as lock AND list | the fix, asserted on `buildClaudeManagedSettingsOptions(...).managedSettings` — **the value the spawn hands the SDK**, not a mapper intermediate |
| NEGATIVE: the same lists WITHOUT their locks are still withheld | the direction; unlocked lists produce **no option at all** |
| NEGATIVE: one lock set does not smuggle the OTHER list through | kills "carry both operands from any lock" |
| BOUNDARY: a lock with no list stays a lock | the fix must not invent a list to soften a deliberate deny-all |
| the write lists have no lock to be an operand of | `allowWrite` / `additionalWritableRoots` stay withheld beside a working read carry |

`describe('P2.136 · the surfacing reports at SUB-KEY granularity')` — 5:

| test | what it pins |
| --- | --- |
| the row's own fixture now reports a whole key | after the carry there is nothing withheld, so no false alarm |
| a withheld sub-key of a CARRIED key is visible, and the key reads as partial | the row's surfacing requirement, exactly |
| the report is read off the SETTINGS | the same `allowedDomains` once unlocked and once locked — only what reached the SDK differs |
| `claudeRules.allow` is reported even though `claudeRules` is MAPPED | the second instance of the same hole |
| a policy that withholds nothing prints no withheld line and no partial marker | negative control against a de-sensitising alarm |
| *(6th, in the same describe)* every withheld path names a real place in the policy document | each `path` is rooted at its `key`, and every `key` is in `MANAGED_PI_POLICY_KEYS` |

(That last row makes the surfacing describe **6** tests and the added total
**11**.)

**At least one test exercises the real path.** Three of the five carry tests
assert on `buildClaudeManagedSettingsOptions(...).managedSettings`, which is
literally the object `ClaudeAgent` spreads into `Options`. No test double stands
between the assertion and the value the SDK receives.

Pre-existing coverage kept green and unmodified: the partition test over
`MANAGED_PI_POLICY_KEYS`, the `CLAUDE_MAPPED_POLICY_KEYS`-vs-mapper tie, the
P2.133 verdict tests, and the binary filter re-extraction.

**Result, through the mutex (`--label p2136`):**

```
bun test packages/shared/src/agent/__tests__/claude-managed-settings.test.ts
 37 pass
 0 fail
 207 expect() calls
Ran 37 tests across 1 file. [28.42s]
```

Re-confirmed 37 pass / 0 fail twice more in the same lock hold (after the
re-break was restored) and once in a second, independent lock hold.

---

## 7. Re-break (prove the tests pin something)

The re-break removes **only the two operand-carry blocks** and leaves the
surfacing intact — so it isolates the carry, not the whole change. Scripted
(`scratchpad/sdd2/rebreak.ts`) with an anchor assertion that refuses to run if
either block has moved, a backup, and a trapped restore so a crash cannot leave
the source broken.

**6 tests fail, and these are the six:**

```
(fail) a floor never widens > sandbox sends the denials and withholds the grants
(fail) P2.136 · a lock carries its operand > POSITIVE: the row's policy reaches the SDK as lock AND list, both halves
(fail) P2.136 · a lock carries its operand > NEGATIVE: one lock set does not smuggle the OTHER list through
(fail) P2.136 · a lock carries its operand > the write lists have no lock to be an operand of, and stay withheld
(fail) P2.136 · the surfacing reports at SUB-KEY granularity > the row's own fixture now reports a whole key, because nothing is withheld
(fail) P2.136 · the surfacing reports at SUB-KEY granularity > the report is read off the SETTINGS, so the carry silences it and nothing else does
 31 pass
 6 fail
```

Then restored, and green again: `37 pass / 0 fail`.

Two of the six are surfacing tests, which is the point of building `withheld`
off the produced `Settings`: reverting the carry makes the report *correctly*
say the operands were withheld, and the tests that assert the post-fix state
fail. A `withheld` derived from the policy instead would have gone on printing
whatever the table said and killed nothing.

Four tests deliberately survive the re-break — `NEGATIVE: the same lists WITHOUT
their locks`, `BOUNDARY: a lock with no list`, `claudeRules.allow is reported
even though claudeRules is MAPPED`, and `every withheld path names a real
place`. They pin the *direction* and the surfacing, neither of which the carry
revert touches. A re-break that killed all eleven would mean the eleven were one
test written eleven times.

### A discrepancy, reported rather than smoothed over

The **first** re-break run reported `30 pass / 7 fail`; the **second**,
identical re-break reported `31 pass / 6 fail` with the complete list above. The
7th failure of run 1 **did not reproduce** and I cannot name it — that run's
output was captured through `tail -60`, which truncated the earlier failures.

What is known about it: both green runs in run 1 were `37 pass / 0 fail`, so the
extra failure appeared only in the re-broken state of a run whose whole-file time
was ~30 s — the "load artefact at 10 s or more" shape AGENTS.md records, with
five other lanes spinning on the mutex at the time. A second plausible cause is
specific to this file: its spawn-wiring tests read `claude-agent.ts` **off disk
by source match**, so a concurrent lane holding that file mid-edit would fail one
of those three anchors transiently. I did not raise any timeout to chase it.

Treat the 6 as the measurement and the 7th as unattributed. It is not evidence
about this change: the same re-broken state produced 6 on a clean re-run, and the
committed state is 37/37 across four separate invocations.

---

## 8. Gate — what each command proves

| command | the contract it proves |
| --- | --- |
| `bun scripts/bun-test-lock.ts run --label p2136 -- bun test packages/shared/src/agent/__tests__/claude-managed-settings.test.ts` | the mapper's whole contract: the operand carry in both directions, the partition over `MANAGED_PI_POLICY_KEYS`, the SDK-filter extraction, and the new sub-key surfacing |
| `bun run typecheck:shared` | the added `withheld` field and `ClaudeManagedSettingsWithheldSubKeyV1` typecheck across the package, tests included (`tsconfig.json` has `include: ["src/**/*"]` and excludes only `src/automations/**/*.test.ts`) |
| `cd packages/shared && npx eslint src/agent/claude-managed-settings.ts src/agent/__tests__/claude-managed-settings.test.ts` | style/lint on exactly the two changed files (root `eslint .` has no repo-root flat config; `lint:shared` is package-scoped) |
| `git diff --check` on the two paths | no whitespace damage in the diff |

Deliberately NOT run, per the implementation-first budget: the full repo suite,
`typecheck:all`, builds, packaging, live smokes. Nothing here touches a shared
wire/schema, auth, migrations or build infra; the one production consumer is in
the same package and was typechecked.

---

## 9. Concerns

1. **`/usr/bin/git` broke mid-session for the whole tree.** Every `git` call
   started failing with *"You have not agreed to the Xcode license agreements"*
   (`xcode-select -p` → `/Applications/Xcode.app/Contents/Developer`). It worked
   earlier in this same session, so something switched the developer dir
   underneath us. **This will hit every lane.** Workaround used here:
   `/opt/homebrew/bin/git` (2.43.0), which is unaffected. The real fix is
   `sudo xcodebuild -license` or `sudo xcode-select -s /Library/Developer/CommandLineTools`
   — both need a human.

2. **`allowManagedPermissionRulesOnly` + `claudeRules.allow` is a real third
   pair and is still open.** Not fixed here on purpose (§4). Its `WebFetch(domain:...)`
   residue can reproduce the same deny-all through the network allowlist and
   deserves its own row and its own measurement.

3. **`sandbox.filesystem.disabled` may be a fourth silent drop** — a *restrictive*
   key the SDK filter copies at `false` that our mapper neither sends nor reports
   (§4). Different category from this row; flagged, not fixed.

4. **Two corrections to the row's text** (§2): the "deterministically denies"
   quote belongs to `strictAllowlist`, not `allowManagedDomainsOnly`; and
   "deny-every-read" overstates the filesystem half. Neither changes the fix.

5. **One unattributed re-break failure** (§7): run 1 said 7, run 2 said 6 with a
   complete list, and the 7th did not reproduce. Reported rather than smoothed
   over. Leading hypotheses are concurrent-load artefact or a concurrent lane
   editing `claude-agent.ts`, which this test file reads off disk by source match.

6. **Mutex contention was the dominant cost.** The zone's test file waited ~25
   minutes behind `P2.226-wave` (`bun test packages/shared/src`) with five other
   lanes queued. No timeout ceiling was raised anywhere, per the dispatch note
   about P2.254's now-subprocess-spawning Bash permission checks; this row's tests
   do not exercise a Bash permission check, so that slowdown did not apply here.

7. **`claude-managed-settings.test.ts` reads `claude-agent.ts` off disk** for its
   three spawn-wiring anchors. Under parallel lanes that is a cross-lane coupling
   in a test file — worth knowing when scheduling, and a candidate explanation for
   concern 5.
