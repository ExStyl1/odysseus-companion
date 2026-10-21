# Re-verification of every closed parity row — 2026-07-30

> **EVERY FINDING BELOW IS WRITTEN IN THE PRESENT TENSE AND MOST OF THEM ARE NO
> LONGER TRUE.** This file is the record of the sweep that demoted 23 rows; the
> 23 were then rebuilt, and the file was never annotated. Read it as history.
> The parity tracker at `:502`/`:505` names it "the full record", which is why it
> is kept rather than deleted, and each demoted row carries its own plan.
>
> **Re-measured 2026-07-30 — these are closed, not open:**
>
> | Finding as written | State now |
> | :-- | :-- |
> | "`disableAllHooks` does not exist" | 60 hits across 11 files |
> | "`headersHelper` has no reader anywhere — zero occurrences repo-wide, including tests" | 25 hits across 7 files |
> | "`(allow mach-lookup)` is emitted unconditionally in every darwin sandbox profile" | `bash-seatbelt.ts:80`/`:109` document the filtered form; `bash-seatbelt.test.ts:75` asserts `expect(profile).not.toMatch(/\(allow mach-lookup\)/)` |
> | "Protected paths … no permission-gate consumer exists" | `protectedPath` 24 hits across 4 files |
> | "`${CLAUDE_PROJECT_DIR}` substitution is broken in skill bodies" | `CLAUDE_PROJECT_DIR` 42 hits across 11 files |
> | "B2 — `parseConfig` keys solely on `OTEL_EXPORTER_OTLP_ENDPOINT`" | `otlp-telemetry.ts:6-16` documents `NESSY_ENABLE_TELEMETRY` as the primary opt-in with the Claude name as compat |
>
> **The part of this file that does NOT decay is procedural, and it is why the
> sweep is worth reading at all:** the fan-out collection lesson and the
> unchallenged-verdict rule at the bottom. Both have been copied into
> `AGENTS.md`'s traps section so they survive independently of this record.

Step 2 of the owner's three-step instruction: compare our code, the §A table and
the documentation, to establish precisely what is not done. Eight groups, ~30
closed rows, each survival verdict then handed to an adversarial challenger.

**The headline: the ✅ count was optimistic.** Twelve rows are
`partially-holds`, and **five `holds` verdicts were refuted by the challenger**
(R2, R3, R5, R12, R16). Two challenge agents died on API 529, so
`managed-policy` and `isolation-sandbox` "holds" verdicts are **unchallenged**
rather than confirmed — that is a gap in this sweep, not a clean result.

---

## The one that is a live user-facing hang

**The `/subtask` seam I found by CDP also breaks manual `/compact`, with a wider
blast radius.** `pi-agent.ts:6195` matches `/compact` against the same prefixed
`trimmedMessage`, **two lines above** the `/subtask` branch. `requestCompact` has
two callers: the model's path (which receives a bare command string) and
`chatImpl`'s — the user's, unreachable.

So **all three** user entry points reach the model as prose: the palette, the
80%-context warning button, and the pre-plan-execution compaction — and that last
one then **waits on a `compaction complete` listener for an event that will never
fire.** A user who clicks "compact before executing the plan" hangs.

Same root cause as `/subtask`, so one fix, but it needs to be understood as a
session-command seam rather than a fork bug. **And no test exercises the
`chat()` → `chatImpl` command seam at all** — which is why both commands could
break without a single suite noticing.

---

## Security, probe-proven

**`(allow mach-lookup)` is emitted unconditionally in every darwin sandbox
profile** — read-only, workspace, networked and plugin-mcp alike
(`filesystem-isolation.ts:70`), and a **second, dead duplicate** at `:94` whose
own comment claims the network profile "must opt those operations back in
explicitly" when `:70` already did it for everything.

The probe: `sandbox-exec -p '<our profile>' /usr/bin/pbpaste` returns **0**; the
identical profile with those two lines removed returns **1**. So a sandboxed
command reaches any system mach service by name — demonstrably the pasteboard,
which is **exfiltration of whatever the user last copied**, and by the same
unfiltered grant `com.apple.coreservices.launchservicesd`.

Zero mentions of `mach-lookup` in any spec or plan in this audit. This is the real
answer to "what does the seatbelt wildcard leave open", and it is worse than the
ambient file reads S12 measured.

---

## Safety floors that do not exist

**Protected paths — the floor that sits ABOVE allow rules.**
The load-bearing sentence is the anchor; the number is a convenience and is the
2026-08-23 fetch's `permission-modes.md:541` (the original `:443` is a blank line
there): "`permissions.allow`
rules in settings files do not pre-approve protected-path writes. The safety
check runs before Claude Code evaluates allow rules from settings, so an entry
such as `Edit(.claude/**)` … does not change the per-mode outcome." Ten protected
directories (`.git`, `.claude` except `.claude/worktrees`, `.vscode`, `.husky`,
`.cargo`, …) and ~30 files (every shell rc and profile, `.envrc`, `.npmrc`,
`.pnpmfile.cjs`, `bunfig.toml`, bazel, four lefthook spellings, the gradle and
maven wrappers, `.mcp.json`, `.claude.json`).

Searched as a concept, not a name: no permission-gate consumer exists. **Because
it is a floor above allow rules, a deny rule cannot substitute for it.** The
tracker records it at `:1796` as unowned; this sweep confirms it is still open.

**`WorktreeCreate` cannot block, and there is no channel for it to.**
`chooks.md:699`'s Warning ends with the exception — "The exception is
`WorktreeCreate`, where any non-zero exit code aborts worktree creation" — and
`:733` restates it. Our emit signature has **no abort channel at all**, and the
three `return selected` paths in `applyWorktreeCreateHookPath` proceed on a
thrown hook, a missing path, and a refused path alike. The escape screen holds, so
nothing leaves the repo; what is lost is the refusal. A hook written as a gate is
silently a no-op on failure.

**`disableAllHooks` does not exist.** `hooks.md:612` gives it as the way to turn
every hook off, and `:197`/`:614` make the managed-level one the only thing that
can disable managed hooks. Nessy has the **inverse** of the documented pair: a
per-automation `enabled` flag, which Claude explicitly does not offer, and no
global kill switch, which it does. For a bank fork that is the missing "hooks
off" lever.

**`ConfigChange` has no settings-source producer** — the documented
tamper-detection mechanism for managed policy
(`server-managed-settings.md:277`: "use ConfigChange hooks to log modifications
or block unauthorized changes before they take effect"). All three adapters accept
the event name; the only emitter is one call in `pi-agent.ts`.

---

## Correctness gaps the rows do not carry

- **Hook dedup is absent and matched hooks run sequentially.** `hooks.md:331`:
  "All matching hooks run in parallel, and identical handlers are deduplicated
  automatically." So the same plugin hook installed under two marketplace ids runs
  its command **twice**, and N matched hooks serialise timeouts of up to 600 s
  each.
- **`${CLAUDE_PROJECT_DIR}` substitution is broken in skill bodies**,
  probe-confirmed — and a live plan file asserts the opposite. `skills.md:309`
  says it is substituted in both the markdown body and `allowed-tools` Bash rules;
  our spelling table carries only three variables and no project dir, and the
  project path reaches a skill body only through the plugin-profile pass a native
  skill does not have.
- **`headersHelper` has no reader anywhere** — zero occurrences repo-wide,
  including tests, against four documented behaviours.
- **`acceptEdits` auto-approves four commands where the docs name seven**, plus an
  env-prefix rule and a wrapper rule we do not have. Stricter than documented, so
  not a hole — but undocumented on our side, **and the code comment defending the
  four cites the wrong page**, so it actively misdirects the next reader.
- **R1: `deny Bash(*)` and the `deny mcp__*` forms do not remove the tool from
  the advertised manifest**, contrary to the page.
- **R24: `reset()` is declared as the per-session lifecycle guard and called only
  from its own unit test**, while the subprocess demonstrably re-inits sessions.
- **R30: the doctor surface reports a FALSE finding on a valid managed policy** —
  it prints an "Invalid managed entries" line naming entries that are fine.

---

## A correction to my own sweep brief

I told all eight agents that "two fail-open locks" were an open finding, quoting
the tracker's §0 highest-priority follow-up. **They are closed** — my own fix
`f4ae5596` made both config-write guards read `path` as well as `file_path`, and
the group verified it on HEAD. Leaving that note in §0 will keep drawing effort at
a fixed hole, which is its own kind of defect: a tracker that lies about what is
broken wastes exactly as much time as one that lies about what works.

---

## What this changes about the table

Rows whose ✅ does not survive move to 🔄 with the gap named. New unowned items
get rows. The five refuted `holds` verdicts and the two unchallenged groups are
recorded as such rather than quietly folded in — an unchallenged verdict is
weaker evidence than a challenged one, and the difference should be visible.

## Correction, 2026-07-30 — a fifth challenge result arrived after this spec

The `context-and-skills` challenger finished AFTER the demotion pass above was
written, so its verdict was in the workflow journal and in no document: it
**refuted R11 and R17 as well** — seven refuted `holds`, not five; 19 demoted
rows, not 17. Both refutations were then verified first-hand before demoting:

- **R11** — the seven `/context` category ids match the doc, but the content of
  two is systematically mis-assigned on Pi: `context-categories.ts:103-104`
  splits system vs MCP tools on a bare `mcp__` prefix while every internal
  session tool is advertised as `mcp__session__*`. Measured with zero user MCP
  servers connected: `mcp_tools` = 11,946 tokens, `system_tools` = 1,065 —
  `context-window.md:43-48` makes the MCP row mean MCP-*server* tools. The
  fixture never uses the production shape, so 4/4 green proved the ids, not the
  split.
- **R17** — `skills.md:309` names TWO variables in TWO sites; only one is
  implemented. `SKILL_VARIABLE_SPELLINGS` has no PROJECT_DIR, and the failure is
  **worse than Claude's own documented downgrade**: `assertStaticRestriction:744`
  throws on any surviving `$VAR`, so a documented-valid
  `allowed-tools: Bash(${CLAUDE_PROJECT_DIR}/…)` aborts the whole skill —
  fail-closed where the doc's own pre-2.1.129 story is "stays literal, still
  prompts". Same for `${CLAUDE_PLUGIN_ROOT}` in a restriction.

The lesson is procedural: **a fan-out's results must be collected against the
list of what was dispatched, not against what has arrived** — the demotion pass
counted refutations from the results present at write time and nothing flagged
the one still running. The two 529-killed challengers are the same hole in a
louder form; their resume is in flight, and their last partial output already
shows `{"refuted": [1, 2]}` each (naming R10 and R25), so "unchallenged" should
be read as "probably wrong", not "probably fine".

## Final state, 2026-07-30 — the resume completed; the prediction held

All 15 agents finished; 0 errors. The re-run challengers refuted **four more
`holds`** — R25, R26, B2 from `managed-policy`, R18 from `isolation-sandbox` —
each verified first-hand before demoting. R10 survived. Final tally: **20 rows
still closed, 23 demoted, eleven refuted `holds`** (5 at first write → 7 after
the late result → 11 at completion; each partial collection understated the
damage).

The four late refutations, sharpest first:

- **R18** — structured output's schema is compiled and used for post-turn
  validation only (`index.ts:3262` → `runTurnStructuredOutputValidation`);
  nothing puts it in the request or the prompt, so the model is reprompted with
  ajv error strings about a schema it has never been shown.
- **B2** — `parseConfig` keys solely on `OTEL_EXPORTER_OTLP_ENDPOINT`;
  `CLAUDE_CODE_ENABLE_TELEMETRY` ("required") and `OTEL_METRICS_EXPORTER=none`
  (the documented disable) exist nowhere under any name. An ambient endpoint
  var in a corp shell starts exporting token/cost data with no opt-in.
- **R26** — `setNetworkProxySettings` replaces `config.networkProxy` wholesale
  with the form's six fields, erasing `certStore`/`clientCertPath`/
  `clientKeyPath`/`clientKeyPassphrase` on any proxy save.
- **R25** — `cleanupPeriodDays` is composed, pinned, cached — and consumed from
  the host-owned FILE on headless (`headless-start.ts:502`), from nowhere on
  desktop. The zero-drop suite is a key-set shape check that cannot see a
  dropped consumer.
