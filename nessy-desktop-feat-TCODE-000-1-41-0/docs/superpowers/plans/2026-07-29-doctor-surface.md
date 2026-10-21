# R30b — the `/doctor`-class config-diagnosis surface, plus the row Unit 4 left open

**Status:** closed
**Source:** parity audit row R30 (`R30b`), and `2026-07-29-deviation-worklist.md` § 2
security-or-permission — "`defaultMode` + four managed-only admin locks absent"
**Branch:** `fix/renderer`
**Base:** `7bb4e93a` (S2 close-out)

Two halves in one unit because they live in the same parser and the same surface
reads both: the locks land as managed policy keys, and every entry the tolerant
parse refuses to accept from them shows up in the doctor listing.

## Contract source — re-fetched raw

```
curl -sL https://code.claude.com/docs/en/debug-your-config.md      # 125 lines
curl -sL https://code.claude.com/docs/en/settings.md               # 1221 lines
curl -sL https://code.claude.com/docs/en/slash-commands.md         # 933 lines
curl -sL https://code.claude.com/docs/en/server-managed-settings.md #  288 lines
```

Load-bearing lines, quoted from the fetched files.

`debug-your-config.md:26` — what `/doctor` is scoped to:

> `/doctor` | Setup checkup: installation health, invalid settings files, unused
> extensions, duplicate [subagent](/docs/en/sub-agents) names in the same
> directory, and checked-in `CLAUDE.md` content Claude can derive from the
> codebase, with proposed fixes

`debug-your-config.md:28` — the sibling surface:

> `/status` | Active settings sources, including whether managed settings are in
> effect

`debug-your-config.md:46` — the terminal form, and the property that decided this
unit's surface:

> From the terminal, `claude doctor` prints read-only installation and settings
> diagnostics without starting a session.

`settings.md:186` — tolerance and the listing:

> Run `/doctor` to list stripped entries with their source file and field.

`settings.md:208`, `:210`, `:712` — the same listing, three times, always the
terminal form:

> `claude doctor` lists each invalid entry with its source and field.
> Validate policy changes by running `claude doctor` on a test machine before
> deploying them fleet-wide.
> After you continue, `/status` lists the affected files. Run `claude doctor` to
> see the details for each error.

`settings.md:311`/`:312` — why it must not need the app to start:

> `claude update`, `claude install`, and `claude doctor` keep working above the
> ceiling so users can recover.

`settings.md:706` — the channel names:

> the entry shows the delivery channel in parentheses, for example `Enterprise
> managed settings (remote)`, `(plist)`, `(HKLM)`, `(HKCU)`, or `(file)`

`server-managed-settings.md:143` — the confusion this surface exists to prevent:

> If you clear your server-managed configuration in the admin console with the
> intent of falling back to an endpoint-managed plist or registry policy, be
> aware that cached settings persist on client machines until the next
> successful fetch. Run `/status` to see which managed source is active.

`slash-commands.md:23` and `:30` — what `/doctor` *is* in Claude today:

> Claude Code includes a set of bundled skills, such as `/doctor`, `/code-review`,
> `/batch`, `/debug`, `/loop`, and `/claude-api`. Bundled skills are prompt-based:
> they give Claude detailed instructions and let it orchestrate the work using its
> tools.
> Before v2.1.205, `/doctor` was a built-in command rather than a bundled skill.

The five keys, `settings.md:227`, `:229`, `:258`, `:385`, `:386`:

> `allowManagedHooksOnly` | (Managed settings only) Only managed hooks, SDK
> hooks, and hooks from plugins force-enabled in managed settings `enabledPlugins`
> are loaded. User, project, and all other plugin hooks are blocked.
> `allowManagedPermissionRulesOnly` | (Managed settings only) Prevent user and
> project settings from defining `allow`, `ask`, or `deny` permission rules. Only
> rules in managed settings apply.
> `disableAutoMode` | Set to `"disable"` to prevent auto mode from being
> activated. Removes `auto` from the `Shift+Tab` cycle and rejects
> `--permission-mode auto` at startup.
> `defaultMode` | Default permission mode when opening Claude Code. … The
> `--permission-mode` CLI flag overrides this setting for a single session
> `disableBypassPermissionsMode` | Set to `"disable"` to prevent
> `bypassPermissions` mode from being activated.

`settings.md:606` — the vetted-plugin carve-out and its stated intent:

> Hooks from plugins force-enabled in managed settings `enabledPlugins` are
> loaded. This lets administrators distribute vetted hooks through an
> organization marketplace while blocking everything else.

## Part 1 — the row Unit 4 left open

Established before implementing, per the brief. **Two of the five were already
shipped under another name, one was shipped for every tier except the managed
one, and two were genuinely absent.**

| Key | Verdict | Evidence |
| --- | --- | --- |
| `disableBypassPermissionsMode` | `documented, implemented` — as `disabledPermissionModes: ['allow-all']` | `DISABLEABLE_MODES` (`managed-policy.ts`) admits `allow-all`, our `bypassPermissions`; `normalizeManagedPermissionMode` demotes a request for a disabled mode down the permissiveness ladder rather than refusing it |
| `disableAutoMode` | `documented, implemented` — as `disabledPermissionModes: ['auto']` | same set, same normalizer |
| `defaultMode` | `documented, implemented` after this unit; the CONCEPT already shipped, the managed tier did not | `SessionManager` resolved session > trusted project `.nessy-agent/config.toml` `[defaults]` > workspace > global, with `normalizeProjectPermissionMode` already enforcing `:385`'s "a repository can't grant itself auto mode" as a general narrow-only rule. The managed tier could only *forbid* modes, never choose one |
| `allowManagedPermissionRulesOnly` | genuinely absent | `rg allowManaged` over permission composition returned zero hits; the only scope-conditional logic in the DSL compiler is the untrusted-project skip |
| `allowManagedHooksOnly` | genuinely absent | no hook tier filter anywhere; `allowPluginHooks` is a plugin-only kill switch and says nothing about user or project hooks |

**The row undercounted its own scope in one direction and overcounted in
another.** Overcounted: it calls all four locks "managed-only", but
`settings.md:386` says `disableBypassPermissionsMode` "works from any scope" and
`:258` only says `disableAutoMode` is "most useful in managed settings" — two of
the four are any-scope keys in Claude, and both are already covered by a managed
*list* that is strictly more expressive than two booleans. Undercounted: it
records `defaultMode` as flatly absent, when the four-tier chain already existed
and only the managed tier was missing; and it says nothing about the fact that
`allowManagedHooksOnly` has no managed hook *source* to be "only" — we carry no
hook-definition key at all (`managed-approval.ts:15`, which states it and pins it
with a test), so the lock's first clause names an empty set here.

`disabledPermissionModes` was already the more general shape, so no second key
was added for the two disable-switches: `['auto','allow-all']` says what both
booleans say, and adding aliases would give one policy two spellings.

### Two readings that are ours, not the doc's

1. **Invalid-value polarity for the two locks.** Neither is on the
   `settings.md:192`-`:200` security-enforcement table, so `:186`'s general rule
   would strip them. Both are read at their ENFORCING pole instead. A lock a typo
   silently switches OFF is the exact "declared on one path, enforced on another"
   failure this series exists to remove, and both are `true`-enforces switches of
   precisely the shape the table covers. The reading is never silent: the drop is
   recorded with disposition `tightened`, so `nessy-general-agent doctor` names
   the field and the reading it took. `defaultMode` goes the other way and
   strips, because there is no tighter reading of a *default* — guessing `plan`
   from a typo takes a fleet out of the mode its administrator chose, and
   `disabledPermissionModes` is still the key that forbids.

2. **`defaultMode` is spelled with our mode names.** `plan`, `ask`, `acceptEdits`,
   `auto`, `allow-all`, `dontAsk`, `safe` — not `bypassPermissions`/`manual`.
   `managed-policy.json` is a Nessy document and `disabledPermissionModes`
   already set that precedent; one document must not use two vocabularies for one
   enum.

## Part 2 — the four decisions

### 1. Surface shape: a CLI subcommand, `nessy-general-agent doctor`

Not a session tool, not a Settings page, and no invented command tier.

The docs name the terminal form three times for the exact requirement this row
carries — `settings.md:208`, `:210` and `:712` all say `claude doctor` — and
`debug-your-config.md:46` states the property that decides it: it "prints
read-only installation and settings diagnostics **without starting a session**".
`settings.md:311`/`:312` then put `claude doctor` among the commands that keep
working when the version gate refuses to start the app. Deviation Unit 4 shipped
exactly that gate (`b0f42e6c`), so a doctor that only exists inside a session is
unusable in the state an administrator most needs it. It also needs no session,
no model turn, no translated string and no new tier.

**`/doctor` as a literal slash command is buildable here, and is deliberately
not this slice.** R27b's finding was about a built-in *command* tier, which we do
not have — but `slash-commands.md:23`/`:30` say `/doctor` has not been a built-in
command since v2.1.205; it is a **bundled skill**, "prompt-based: they give
Claude detailed instructions and let it orchestrate the work using its tools".
We *do* have that tier: `ensureBundledSkills` seeds `resources/skills/<slug>/`
into the managed skills root, and `SessionManager.skillSlashCommands` surfaces
every skill as `/<slug>` in the composer. What is missing is the tool half — a
prompt cannot read the managed drop list, and `session-tools-core` cannot import
`server-core`, so the skill would need a new context seam. Recorded as deviation
1 with its cost.

### 2. What it shows: three sections, each required by a sentence

- **Which managed source is in effect**, in `settings.md:706`'s own words —
  `Managed settings (remote)` / `(file)` / none — with the cache or file path.
- **Every managed entry the tolerant parse refused**, source and field first,
  which is `settings.md:208`'s two required fields, rendered through the
  `formatManagedPolicyDrop` seam Unit 4 left for this.
- **Every strict-tier settings layer rejected whole**, which is `settings.md:712`.

Deliberately excluded, each because the docs put it on a different surface:
hook matcher diagnostics belong to `/hooks` (`debug-your-config.md:62`-`:72`),
context accounting to `/context` (`:15`), MCP connection status to `/mcp` (`:52`).
They are also all per-session, and this report is session-free by design. A
diagnostics surface that shows everything shows nothing, and `:26` is the doc's
own scoping of `/doctor`.

`ManagedPolicyWinnerV1` — recorded by U-E as `documented, not implemented — R30b
/status` — is the first of these and now has its reader.

### 3. Yes, it shows the delivered-vs-file disagreement — and so does startup

R25c made the composition winner-takes-all, correctly: `server-managed-settings.md:139`
says "Sources don't merge". The cost is that a policy file an administrator can
see on disk enforces nothing, with no signal, and `:143` warns that cached
settings persist until the next successful fetch. `resolveEnforcedManagedPolicy`
now returns `fileCarriesSettings` beside `winner`, and one predicate —
`shadowedManagedFileWarning` — renders the same sentence in the report and in a
`createStorageRuntime` startup warning. It fires only for the single ambiguous
combination, never for a file that carries nothing and never when the file won.

Carried out of composition rather than re-derived: `composeManagedPolicySources`
is pure, so the label and the policy can disagree only if they are derived twice,
and a second derivation is the shape of the R25c defect.

### 4. What was deliberately left out

- **The interactive `/doctor` slash surface** — deviation 1 below. It is the half
  that "proposes fixes it applies only after you confirm" (`:44`), which is a
  different product from a read-only report.
- **`/status` as a Settings panel.** `debug-your-config.md:28` scopes `/status`
  to "Active settings sources, including whether managed settings are in effect",
  which the doctor already prints. A renderer panel adds an RPC channel, a
  settings-registry entry, an icon and two locale files for content that has no
  reader problem — the reader problem was that nothing computed it, and that is
  fixed.
- **Installation health, unused extensions, duplicate subagent names, and the
  checked-in-`CLAUDE.md` trim check** from `:26`. Each is a separate detector
  against a separate subsystem; none of them is the thing R30's row was written
  for ("a setting that exists and nothing feeds"). Named here so the gap is a
  decision rather than an oversight.
- **A `--fix` / repair mode.** `:46` makes the terminal form read-only and `:44`
  puts the fix flow behind interactive confirmation. A CLI that edits managed
  policy files would also be running as the user, not as the administrator who
  owns them.

## The commits

| Sha | What |
| --- | --- |
| `1f7c509b` | `feat(config): the settings half of a doctor report, and a reader for rejected layers` |
| `67a9b48d` | `feat(managed): carry which managed source won out of composition` |
| `e40c1ded` | `feat(cli): a session-free doctor subcommand` |
| `4b55cb06` | `feat(managed): the three admin keys the worklist's R1 row named` |

Two design points worth keeping:

**`collectRejectedUserSettingsLayers` drives the real getters with their reporter
redirected**, rather than re-running the parses. Whatever a getter rejects is
what it returns, by construction, so the report cannot name a layer the app still
applies or miss one it dropped. A second copy of the parse rules is how the two
would drift, and drift between a declaring path and an enforcing path is this
series' recurring defect.

**`collectConfigDoctorInput` tolerates every failure it exists to diagnose.**
`managed-policy-loader` still fails closed on a file-level defect — broken JSON,
oversized file, unsafe path — by throwing `managed-pi-policy-invalid`, which is
exactly the state an administrator reaches for a doctor in. That becomes a
whole-document drop instead of a crash, and the delivered source is read
separately so the report still names the policy that IS in effect.

## Deviations recorded

Each carries the audit rule's category string.

1. **The interactive `/doctor` slash surface** — `documented, not implemented —
   slash-commands.md:23 makes /doctor a bundled prompt-based skill and we have
   that tier (ensureBundledSkills + skillSlashCommands), but a prompt cannot read
   managedPiPolicyDrops and session-tools-core cannot import server-core. Cost:
   1 small slice — a managed target on the existing config_validate tool plus a
   diagnostics seam on SessionToolContext supplied by the host that holds the
   storage runtime, then one resources/skills/doctor/SKILL.md that calls it. No
   new tool surface and no new command tier.`

2. **`settings.md:206`'s interactive startup dialog** — `documented, not
   implemented — carried forward unchanged from 2026-07-29-deviation-unit-4.md
   deviation 1. The rendering half ships; only the modal is missing.`

3. **Invalid-value polarity for the two locks** — `documented, implemented with a
   recorded reading — neither allowManagedHooksOnly nor
   allowManagedPermissionRulesOnly is on settings.md:192-:200, so :186 would
   strip an invalid value. Both are read at their enforcing pole instead,
   recorded as a 'tightened' drop that the doctor prints. Reversing this is one
   argument change per key if the contract is later read the other way.`

4. **`allowManagedPermissionRulesOnly` does not cover the flat permission
   arrays** — `documented, not implemented — settings.md:229 names allow/ask/deny
   RULES, which is the permission DSL, and that surface is fully locked. Our
   pre-Claude MergedPermissionsConfig arrays (allowedTools, allowedWritePaths,
   readOnlyBashPatterns, readOnlyMcpPatterns, allowedApiEndpoints) are a separate
   widening surface with no Claude counterpart and — the blocking fact — NO SCOPE
   PROVENANCE: applyDefaultConfig/applyCustomConfig/applySourceConfig append into
   flat arrays that no longer record which layer contributed. Locking them today
   would also strip the app's own default read-only bash patterns, changing base
   product behaviour rather than admin authority. Cost: 1 medium slice — carry
   the scope through the three appliers, then drop non-managed contributions to
   the allow-direction fields only.`

5. **`allowManagedHooksOnly`'s vetted-plugin clause degrades on non-Pi
   providers** — `documented, implemented fail-closed — settings.md:606 keeps
   hooks from plugins the administrator named, and our nearest key is
   allowedPluginKeys. The per-plugin narrowing that applies it runs in
   storage-runtime's pluginCandidates filter, which is gated on
   isPiCapabilityTurn. Rather than trusting a narrowing that did not happen, the
   caller passes pluginHooksVetted: provider === 'pi' && allowlist non-empty, so
   a non-Pi turn under the lock loses plugin hooks entirely. Stricter than the
   doc, never looser, and it disappears when the non-Pi managed-filter gap
   (ea24adc7) is closed.`

6. **`settings.md:676`'s cross-source clause for
   `allowManagedPermissionRulesOnly`** — `documented, inapplicable — the clause
   is about PARENT-supplied settings from an embedding host's SDK managedSettings
   option, and it explicitly says "the key's effect on the developer's own
   permission rules comes from the highest-priority source only", which is our
   ordinary winner-takes-all. We have no parent-settings channel, so there is
   nothing to gap-fill and the key is not added to composeManagedPolicySources'
   cross-source set.`

## Propagation found — reported, not fixed

- **`.nessy-agent/hooks.json` has a dead second reader.**
  `packages/shared/src/plugins/project-config.ts` defines
  `NESSY_AGENT_PROJECT_HOOKS_FILE` and `loadProjectNessyAgentHooks`, which parse
  and validate the file. Every caller of `loadProjectNessyAgentConfig`
  (`storage-runtime.ts`, and two `SessionManager` sites) reads only `.plugins`,
  `.defaults` and `.diagnostics` — nothing reads `.hooks`. The live path is the
  capability record registered in `native-sources.ts`. A parsed-and-never-read
  contract, i.e. the inert-contract sweep's own shape.

- **`PermissionDslScope` is a tiebreak, not a precedence gate.** `SCOPE_WEIGHT`
  in `permission-dsl.ts` orders scopes only among rules of EQUAL action weight;
  `ACTION_WEIGHT` (deny > ask > allow) decides first. So a `plugin`-scope allow
  competes with a `managed` allow on equal terms whenever no deny or ask matches.
  That is probably right, and it is not what the name suggests.

- **`permissions.additionalDirectories` has no scope provenance at all.** One
  flat global list from `config.json` (`additional-directories.ts`), no managed
  tier, no per-scope layering. `settings.md:676` has
  `allowManagedPermissionRulesOnly` drop parent-supplied `additionalDirectories`
  as well as allow rules; we have nothing to drop, but we also could not narrow
  it if we did.

- **The two `PermissionsContext` sites that bypass capability layers** —
  `assertCdRulesPermit` and `shouldPromptForAutoDirectShell` — build a context
  with no `pinnedConfigs`, so they take `buildMergedConfig`'s non-pinned branch
  and read `default.json`, the workspace file and every source file off disk. Both
  now carry the lock, but they remain a second composition path with different
  inputs from the one every turn uses.

- **`settings.md:186` also promises the listing from `/doctor` itself**, not only
  `claude doctor`. That half is deviation 1.

## Gate evidence

Run from the repo root. Package-directory runs are refused by the config-dir
isolation guard and were not attempted.

```
bun run typecheck:all                      → clean (core, shared, server-core,
                                              server, session-tools-core,
                                              pi-agent-server, electron, ui)
apps/cli  bun run typecheck                → clean
bun run lint                               → 0 errors, 118 + 4 warnings (pre-existing)
bun run lint:i18n:parity                   → i18n parity OK (1 locales, 2018 keys each)
bun run lint:i18n:sorted                   → clean (no new strings — the CLI is
                                              English-only and adds no t() call)
git diff --check                           → clean

bun run test:shared:all                    → 5 + 66 + 48 pass, 0 fail
bun test packages/shared/src/agent/
     packages/shared/src/capabilities/
     packages/shared/src/config/
     packages/shared/src/plugins/          → 3104 pass, 4 skip, 2 fail
bun test packages/server-core/src/         → 980 pass, 2 fail
bun test apps/cli/src/ packages/server/src/ → 103 pass, 0 fail
```

The 4 failures are all on the known pre-existing list: 2 × `config path
default-root classification > treats an empty override as the default root`
(`paths-default-root`) and 2 × `SessionManager Pi child orchestration composition`
background-authority cases. No other failure appeared.

### Mutation probes

Both enforcement points, removed and restored on the final diff:

```
addPermissionDsl scope filter removed
  + managedHooksOnly bucket skip removed      → 17 pass / 5 fail
both restored                                 → 22 pass / 0 fail
```

### Live smoke — the command, end to end

```
NESSY_CONFIG_DIR=<tmp> bun run apps/cli/src/index.ts doctor
  Managed settings source:
    No managed settings source is in effect

  Invalid managed entries:
    none

  Rejected settings layers (1):
    - <tmp>/config.json: worktree — invalid worktree setting: bgIsolaton [layer rejected whole]
  exit=1

NESSY_CONFIG_DIR=<tmp> bun run apps/cli/src/index.ts --json doctor
  {"managedSource":"none", "managedPolicyFileShadowed":false,
   "rejectedSettingsLayers":[{…"key":"worktree"…}], "hasFindings":true}
  exit=1

clean config → exit=0
```

## Pinned assertions rewritten

One, and it is the test doing its job rather than a contract changing.
`storage-runtime-delivered-policy.test.ts`'s `EVERY_KEY` fixture asserts its own
key set equals `MANAGED_PI_POLICY_KEYS`, so the three new keys failed it until
they were added with valid values — which is precisely the general-property
guard R25c's Task 3 was written to provide.
