# W4 — P2.316 + P2.317: the coverage map, its regex, and the Pi column

**Status:** COMPLETE. **Commit:** `7f057f85d`. **Base SHA recorded before starting:**
`05733c4ad7c8f4b68dfbdf8e89c44191a9ea7ca2`.

**Headline numbers, first:**

- **The reconciled uncovered-page count is 102**, down from 122, with **exactly one real
  contradiction left standing** between the two artefacts (`plugin-relevance`).
- **The Pi column's propagated half is wrong 46% of the time — 12 of 26, a CENSUS, not a
  sample.** Three of the twelve are the owner's worry confirmed (Pi has less than the green
  cell claims); nine run the other way, where the false cells are claude and codex.

---

## 1. PREMISE CORRECTION — "one regex explains the 74-page difference" is a third of it,
## and not the largest third

`[doc:none]` · **kind: bug** (in an instrument, not the product).

The dispatch and C8 both say one regex explains the 48-vs-122 gap. Reproduced and
decomposed it before changing anything. **Measured:**

| term | pages | what it actually is |
| --- | --- | --- |
| ⬜ rows the report counts and the map subtracts | 59 | **not a disagreement at all** — the two were never counting the same set |
| pages both call uncovered | 39 | agreement |
| 🟩 in the map, "cited by nobody" in the report | 23 | the only real contradiction |
| ⏸ in the map, uncited in the report | 1 | agreement (C8's own breakdown omits this one; it sums to 121, not 122) |

So **the dominant term is a denominator difference, not a detector error.** The map excludes
out-of-product pages from its denominator by design; §3a counts the whole corpus. Two numbers
answering two questions were being read as one.

The 23 genuine contradictions then had **two** causes, and the second was undiagnosed:

**Cause 1 — the regex, and C8 is right about it.** `DOC_RE` requires a `.md` suffix, and the
audit tracker names its page in a **dedicated page column** without one. **Fifty-five pages are
named that way**, tied to specific closed rows: `features-overview` → R61/R70/R79,
`statusline` → R53c, `agent-sdk/modifying-system-prompts` → R65, `glossary` → R33/R42,
`how-claude-code-works` → R33, `best-practices` → R36/R59/R66, `authentication` → R40. That set
is C4's eleven pages almost exactly — the map had diagnosed this by hand twice and nobody swept.

**Positive control that the column is what I think it is** (the fix rests on this): the map's own
row 148 records R34's page column verbatim as "agent-sdk/mcp, mcp, mcp-quickstart,
whats-new/2026-w20". Parsing cell 5 of that row returns exactly
`'agent-sdk/mcp, mcp, mcp-quickstart, whats-new/2026-w20'`; R44 → `'output-styles'`,
R53c → `'statusline'`, R65 → `'agent-sdk/modifying-system-prompts, third-party-integrations'`,
all `✅`. Rows that use the column for a title instead are filtered by token shape — a title has
spaces, a slug does not.

**Cause 2 — undiagnosed, and larger.** `plan_docs` reads every plan in the directory (the
artefact's own provenance paragraph promises exactly that), and the loop that consumed it took
only the plans some tracker row happened to link: **55 of 134. Seventy-nine plans were parsed
and thrown away.** Fifteen pages a plan cites **by full `.md` name** therefore read as cited by
nobody — five of them among the seven non-weekly contradictions
(`agent-sdk/modifying-system-prompts`, 12 citations in `2026-07-29-output-style-contract.md`;
`agent-sdk/skills`; `code-review`; `gateways`; `managed-mcp`). The regex is innocent of these
five: they carry the suffix.

### What I changed, and what I deliberately did not

Both causes fixed in `scripts/build-parity-report.py`. **Result: §3a is 102.** Six of the seven
non-weekly contradictions are gone, plus `whats-new/index`; 16 remain, 15 of them weekly pages
whose reads live in findings specs the generator does not scan (explained, not open).

**I did NOT widen detection to bare names in prose**, and this was a decision, not an omission.
Measured over the tracker plus every plan, a bare-backtick rule adds ten pages beyond `.md`
detection, and most are not citations: `` `sessions` `` is a subsystem tally,
`` `setup` `` a coincident unit name, `` `agent-teams` `` and `` `tool-search` `` appear inside
lists of names. Admitting them would certify contracts nobody took — the dangerous direction.
They are now printed as **their own labelled bucket** inside §3a (11 pages), so the ambiguity is
visible rather than either silently admitted or silently dropped.

**The report now prints the crosswalk itself**, keyed off the map's Pi column, so the two files
can no longer be quoted against each other. That makes the map a **fifth input** to the
generator: edit a Pi cell and the report goes stale, which is the correct coupling and what the
stopping rule needs.

### Re-break, against the recorded base SHA

Built a `git archive HEAD` sandbox and reverted each fix independently.

| variant | §3a |
| --- | --- |
| HEAD, both fixes (control) | **102** |
| M1 — tracker page column removed | 107 |
| M2 — unlinked plans thrown away again | 113 |
| M3 — both removed | **122** |

M3 reproduces the pre-fix number exactly, so the two mutations together are the whole
difference; each is independently load-bearing (5 and 11 pages, overlapping by 4).

### The one contradiction left standing

`[doc:none]` · **kind: bug** (map cell). **`plugin-relevance` (row 97) is cited by no plan and
no tracker row** — `git grep -a -c` over `docs/superpowers/plans` + the audit → 0 files, positive
control `plugin-dependencies` → 3 files. Its `🟩ᵗ` rests on the page being cited in **source**
(`marketplace/relevance.ts:4`), which is not the closed row `ᵗ` claims. The subagent audit adds
that the green is thin on the merits too: of the three surfaces `#how-it-works` names we built
one (the Discover-tab pin); the spinner tip and the session-start notification are unbuilt.
Recorded in the cell; **not silently re-verdicted**, because the underlying implementation is
real and this is a marker-strength question for the owner.

---

## 2. The 41 wrong cells, and the direction that matters first

`[doc:claude]` · **kind: bug** (recorded verdicts contradicted by this repo's own closed work).

**55 rows edited across three passes**, all driven from
`docs/superpowers/specs/2026-08-28-claude-sweep-triage.md`. Every edited cell now names the
sweep, the direction of the error, and — this is the part that keeps it honest — **its evidence
class**: these are transcriptions of a static-reading report, `ʰ`/`ᵏ` class, and each cell says
so rather than borrowing the authority of a behaviour test nobody ran. The prior cell text is
kept as history rather than deleted; the evidence in it is still worth reading.

**The 8 too-green went first, as the brief directs.** 135 `agent-sdk/overview` → 🟥 (the probe
found code belonging to *other* pages; this page's own content — comparison table, branding
contract, auth restriction, licence — has never been read against a rebranded fork). 32
`security-guidance` → codex 🟥 (`PostToolUse` never fires there, so two of the plugin's three
layers are dead while it reports itself enabled). 7 `context-window` → codex 🟨. 90
`llm-gateway-protocol` → claude 🟥. 34 `code-review` → claude/codex 🟥. 69 `managed-mcp` →
claude 🟥. 127 `env-vars` and 64 `errors` → Pi 🟨, claude 🟩 — the vendored binary discharges
them and a Pi session does not get them.

**25 too-red**, including four whose ⬜ was actively hiding shipped work, and 5 SUSPECT rows
flagged rather than re-verdicted.

**All 23 ⬜ cells carrying «страница не открывалась» are corrected** — the sentence is false for
all 23 (phase 1 read 174/174 on 2026-07-31; `desktop-wsl` re-fetches byte-identical at 2 962 B).
It is **replaced, not deleted**: a cell that says nothing is not better than one that says the
wrong thing, so each now carries the page's real reason in the page's own words.

**Nine ⬜ rows were wrongly subtracted from the denominator** and are no longer ⬜ (14, 61, 71,
28, 67, 73, 87, 88, 24).

### The denominator, corrected

`[doc:none]` · **kind: bug**. A whole-file tally counts two rows that left `llms.txt`
(`ultraplan`, `agent-sdk/slash-commands`), and the published fraction did.

**In-corpus, the fraction the stopping rule should read: Pi 81/133 · claude 64/133 ·
codex 39/133** (191 corpus pages − 58 in-corpus ⬜). Stamped in the map's header along with the
corpus count (191), its snapshot date (2026-08-25) and the 2026-08-28 re-verification against a
fresh `llms.txt` — page set identical, nothing entered or left. The same re-verification is
recorded in `scripts/claude-doc-pages.tsv`'s own header, since both generators read it as their
denominator.

---

## 3. P2.317 — the Pi column: a CENSUS, not a widened sample

`[doc:claude]` · **kind: never-looked-at**.

The brief said "sampling, not exhaustion — widen until the error rate is worth quoting". I did
the arithmetic on that and **exhausted it instead, because the population is small enough that a
census is cheaper than defending an interval.** Of the 42 propagated Pi greens, 16 are weekly
changelogs, which legitimately carry one verdict by the map's own convention. **The 26
non-weekly ones were all audited** — 9 by the sweep's Batch M, 17 by four parallel falsification
runs, each required to name the seam and carry a positive control.

**Result: 14 justified, 12 unjustified, 0 unresolved. 46%.** No confidence interval, because
this is the population.

| direction | rows | pages |
| --- | --- | --- |
| **Pi has LESS** — the contract is discharged by the vendored binary on claude-runtime and never reaches a Pi session | **3** | 127 `env-vars`, 64 `errors`, 160 `agent-sdk/hosting` |
| **Pi has MORE** — the seam is `pi-only` / `pi-harness/`; the false cells are claude and/or codex | 9 | 159, 49, 60, 133, 132, 63, 22, 162, 80 |

### The answer to "re-verify the column, or label it propagated?"

**Neither, in the end — I did the re-verification, so there is nothing left to label.** `ˢ` is
stripped from all twelve and the cells the census names as false are corrected, so those rows are
now three cells instead of one measurement wearing three. The 14 justified markers stay, now
earned. That is a better outcome than an honest label, and it was available because the
population was 26 rather than 200.

**Three findings worth more than the rate itself:**

1. **The `env-vars` mechanism is a FORM, not an incident.** Row 160 `agent-sdk/hosting` repeats
   it verbatim: its `ˢ` was defended by *refuting* a finding on the grounds that the vendored
   binary implements the knob. "The binary does it" is an argument for Pi having **less**, used
   as an argument for a shared seam. Same shape twice more on that row
   (`CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS`: binary 3, our source 0 files, positive control
   `CLAUDE_CODE_MAX_OUTPUT_TOKENS`/`maxTurns` → 31 files; `CLAUDE_CODE_DISABLE_AUTO_MEMORY`:
   binary 4, our source 0 implementations).
2. **The opposite direction is three times as common, and it is also a lie.** Nine cells
   over-credited claude and codex. The owner's second clause — "the claude and codex runtimes
   are fully covered by our host" — is measured by exactly those cells, and they were optimistic
   by construction.
3. **One census row found a LIVE GAP, not a wrong cell** — see §4.

### What the census did not cover, named

The 16 weekly `ˢ` markers (legitimate as markers, but the sweep's own C9 shows 13 of 15 green
weekly rows rest on a three-keyword filter rather than a decomposition — a different defect,
untouched here) and the 31 Pi greens **without** `ˢ`, which were separately measured by
construction and needed no census. Everything measured here is `ʰ` class: a named seam was read,
no behaviour was executed.

---

## 4. New findings surfaced by this row (each needs a plan row)

1. **`[doc:claude]` · bug · row 133 `channels-reference` — a live gap, not just a wrong cell.**
   The only production arming of the channel path is `ensureSessionChannelSubscription`
   (`SessionManager.ts:3176`), called only from `armPiPluginPeripherals`, called only behind
   `if (runtimeRunsPluginPeripherals(provider))`; the pool's default is fail-closed
   `CHANNEL_PUSH_OFF`. **On claude-runtime and codex no policy is applied and no listener is
   registered.** The tree contradicts itself out loud: the sink's docblock at
   `SessionManager.ts:3853-3859` justifies leaving `deliverMonitorEvent` ungated because
   "gating the sink would silently drop a channel push on Claude or Codex" — the drop happens one
   layer up regardless. The binary cannot compensate: it implements channels (33 occurrences of
   `claude/channel`) but on claude-runtime every MCP server reaches the SDK as an in-process proxy
   over our own pool, so the SDK's MCP client never connects to a channel-capable server.
   Either the gate splits (peripherals vs channel subscription) or that comment is false and
   should say so.
2. **`[doc:claude]` · bug · row 93 `analytics` should be ⬜, not 🟩ᵗˢ.** B2's own recorded verdict
   is "documented, inapplicable — analytics.md:12 … there is nothing to implement and nothing to
   stub" (`plans/2026-07-29-observability-and-cost.md:190`) — verbatim this map's ⬜ criterion.
   The green added an Anthropic-infrastructure page to the in-product denominator and to all three
   green counts. **Corrected in this commit.** Separately recorded on the row: the page's two
   headline client metrics (`lines_of_code.count`, `code_edit_tool.decision`) live in the binary
   (2 occurrences each, with the other six) and nowhere in our source (0 files, positive controls
   `token.usage`/`cost.usage` → 2 files each), and `options.ts:244` strips no `OTEL_` key at all,
   so `CLAUDE_CODE_ENABLE_TELEMETRY` reaches the binary intact.
3. **`[doc:none]` · bug · row 80 `gateways` — the Pi green is a repeated claude measurement.**
   `gateways.md` is cited in exactly one plan file, and that plan is the claude-runtime one. Pi
   reaches the gateway by an entirely separate path (`resolveNestorGatewayJwtForPi`,
   `unified-network-interceptor.ts:634`, which `packages/shared/AGENTS.md:148` calls "currently
   Pi-only"). The capability is real; the citation behind the Pi cell is not Pi's.
4. **`[doc:claude]` · forgotten-vs-doc · row 63 `debug-your-config` — `/context` degrades
   silently on claude and codex.** `composer-capabilities.ts:111` returns
   `unavailable/unsupported` for both, and `context-overlay.tsx:213-237` falls back to coarse
   token rows — no seven categories, no `loadedFiles`. A user runs the page's first instruction
   ("Run it first") and gets something that looks like an answer and is not the documented one.
5. **`[doc:none]` · never-looked-at — a mechanically greppable class.** Two independent audits
   (rows 80 and 162) noticed the same shape: **the cell's prose NAMES a per-runtime seam while its
   marker ASSERTS a shared one.** That mismatch is greppable across every remaining `ˢ` cell and
   would be a cheap sweep.
6. **`[doc:none]` · note — an uncommitted fix may already close part of C8's `storage-runtime`
   finding.** One subagent measured the working tree carrying
   `packages/server-core/src/bootstrap/storage-runtime.ts` modified (+44/−8), replacing
   `isPiCapabilityTurn` with `isRuntimeCapabilityTurn` and the comment "the distinction this gate
   needed was RUNTIME TURN vs BROWSE, never Pi vs everything." **Another lane's in-flight work,
   untouched by me** — but the controller should check whether it lands before opening rows off
   row 69 / L/F52.3 / L/F69.1. The same audit corrected the sweep on two points: managed **hook**
   filtering is already fixed for every provider (`runtime-automations.ts:154-176`, P2.206) and
   fails *closed* off Pi; and what lapses on the plugin side is `isManagedPluginAllowed`'s
   allow/deny **lists**, not `resolveManagedPluginActivation`.

---

## 5. Gates — with proof of work, and one NOT-RUN named

| gate | result |
| --- | --- |
| `bun scripts/check-coverage-map.ts --check` | **exit 0**, output quoted below |
| `python3 scripts/build-parity-report.py` from a clean `git archive HEAD` sandbox | **exit 0**, 589 lines |
| re-break, 3 mutations + control | **102 / 107 / 113 / 122** — M3 reproduces the pre-fix number exactly |
| `git diff --check` | **exit 0** |
| `git show --stat HEAD` | 4 files, all mine, no other lane's work |
| new `<page>.md#<section>` citations in the diff | exactly one — `plugins/components.md#add-each-kind-of-component` (was plugins-reference § plugin-components-reference). Harvested from the RENDERED page and re-verified: `curl … \| grep -o 'id="plugin-components-reference"'` → 1 hit, positive control `grep -c 'id="'` → 122, so the grep is not vacuous. |
| `bun test` on the four doc gates | see below |
| repo typecheck / eslint | **NOT RUN, and not owed**: this commit changes one `.py`, one `.tsv` and two `.md`. No TypeScript or JavaScript file was touched, so there is nothing for `tsc` or eslint to cover. Named rather than left silent. |

```
coverage map: 193 rows
coverage map: Pi     🟩 82  🟨 41  🟥 10  ⏸ 1  ⬜ 59  — evidence ᵗ64 ᵏ9 ʰ54 none66, shared-host 56
coverage map: claude 🟩 65  🟨 51  🟥 18  ⏸ 0  ⬜ 59  — evidence ᵗ47 ᵏ9 ʰ72 none65, shared-host 56
coverage map: codex  🟩 39  🟨 70  🟥 25  ⏸ 0  ⬜ 59  — evidence ᵗ25 ᵏ9 ʰ94 none65, shared-host 56
```

**A note on `build-parity-report.py --check` run in the DIRTY tree: it reports 6 differing lines,
all in §3b, and this is correct behaviour, not a failure.** The three untracked files that
P5.3 already records as a contamination hazard belong to another owner and land in the output.
The committed artifact was generated from `git archive HEAD` plus exactly my three edited files —
which is the provenance the faithfulness gate compares against.

---

## 6. Concerns

1. **My re-verdicts are transcriptions, and every cell says so.** 55 rows were re-verdicted from
   a report I did not measure myself. I marked the evidence class honestly (`ʰ`/`ᵏ`, static
   reading) inside each cell rather than letting the new glyph inherit authority it has not
   earned. Where the sweep named a direction but not a specific cell, I recorded the correction in
   prose and moved only the glyph the sweep names.
2. **Two cells are inferred, not measured, and are labelled as such.** Rows 127 and 64: the codex
   column follows the same mechanism as Pi but nobody measured codex. The cell says
   "ОТДЕЛЬНО НЕ ИЗМЕРЕНА".
3. **The map has no glyph for a declared divergence**, and three rows want one (34 `code-review`,
   106 `sandboxing`, 79 `devcontainer`). I used 🟥/🟨 plus prose naming the written-down
   divergence. `code-review`'s `SKILL.md:16-22` is the template the sweep praises and it now reads
   as a plain gap in the glyph. Worth an owner call on a sixth glyph.
4. **The header's in-corpus fraction is hand-maintained** and `check-coverage-map.ts` does not
   recompute it — it rewrites the legend only. It is stamped with its date and a note saying to
   re-derive it whenever a ⬜ or 🟩 moves, but the honest fix is to teach the checker to emit it.
5. **The generator now reads the coverage map**, so a map edit makes the report stale. Intended,
   and the coupling the stopping rule needs — but P5.3 must regenerate from a clean tree **after**
   any further map edit, and the three untracked files still need their owner.
6. **The weekly seam is untouched and is the largest thing left in this file.** 15 of the 16
   remaining §3a contradictions are weekly pages, and the sweep's C9 shows 13 of 15 green weekly
   rows rest on a three-keyword filter. Both artefacts now agree about them; neither is right
   about them.
