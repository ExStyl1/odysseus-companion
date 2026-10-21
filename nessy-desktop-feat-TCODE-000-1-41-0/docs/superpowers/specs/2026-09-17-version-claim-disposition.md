# Version claims in this tree: which decay, which are facts — a disposition

> **Correction, 2026-09-17 22:06 (WI-r, D1.230):** every `2.1.247` / `0.3.247` below is the DECAYED claim this disposition classifies, not today's bundle. Today's two self-reports (AGENTS.md's instruments, agreeing) are **`2.1.251` / `0.3.251`** — a repair that copies `2.1.247` as the current version mints a new false stamp while removing one. Re-run both instruments on the day each repair lands and write THAT number with its date.

**2026-09-17, lane WI-i, rows D1.167 and D1.103.** The sibling of
`2026-09-07-settings-anchor-rot-disposition.md`, for the other class of citation this
tree keeps re-writing by hand: a runtime version spelled inside a comment, a test
header or a spec sentence.

Both rows read as sweeps — *"re-read every `2.1.247`/`0.3.247` at `2.1.251`/`0.3.251`"*
and *"186 occurrences of `0.3.233`/`2.1.233`/`0.3.223` across the same six documents"* —
and D1.103's own note already refused the mechanical reading: *"a version named as
provenance is a fact and only counts and absences decay."* **This file measures how big
each half actually is, and the answer is why neither row should be executed as a sweep.**

## The rule

1. **A STAMP is a fact and never decays.** *"re-measured 2026-09-12 on the vendored
   `2.1.247`"*, *"in the vendored native binary (SDK `0.3.247` / `claudeCodeVersion
   2.1.247`) an MCP tool's model-facing text is returned raw"*, *"the `0.3.247` lift
   dropped `Write` from this list"*. The sentence says WHICH bundle it was read in; that
   remains true after every later lift, and rewriting the number would destroy the only
   thing that makes the reading checkable. **Leave it. Rewriting a stamp is the damage.**
2. **A PRESENT-TENSE claim decays at every lift.** *"the bundle is `2.1.247`"*, *"we now
   ship `2.1.247`"*, *"our `claudeCodeVersion`, which is now `2.1.247`"*. It is a reading
   with a date and no date on it. **Convert it to the instrument** — say that the bundle
   self-reports, name both self-reports, and let the reader re-derive:

   ```sh
   grep -o '"claudeCodeVersion"[^,]*' node_modules/@anthropic-ai/claude-agent-sdk/package.json
   ./node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --version
   ```

   — the AGENTS.md rule, in the form that section already prescribes. Where the sentence
   needs a number (a comparison against a documented threshold: *"past v2.1.242"*), keep
   the number and DATE it, so the next reader knows which bundle the comparison was true of.
3. **A COUNT or an ABSENCE taken against a bundle decays in the dangerous direction.**
   An absence recorded against `0.3.233` reads as a standing fact about a bundle nobody
   probed. Re-take it or date it; never carry it forward silently. (AGENTS.md's own
   worked example: the `headers` surface, where the bundle LAGGED the docs and then
   overtook them.)
4. **A version inside a TEST PIN is a control and must move with the lift**, or it goes
   green for the wrong reason. Those are not comments and are outside this disposition.

## The measurement, and it is the reason there is no sweep

**Instrument** (re-run it; do not quote these numbers — every count in this tree has
moved within a day of being written): `git grep -anI -E '<versions>' -- packages apps scripts`,
then a line carrying `20\d\d-\d\d-\d\d` is history, and a line matching a present-tense
frame (`is`/`are`/`ships`/`we ship`/`is now`/`which is`/`the bundle is`, immediately
before the version) is a claim about today.

### D1.167 — the `2.1.247` / `0.3.247` family, under `packages` + `apps` + `scripts`

| class | lines |
| --- | ---: |
| carry a DATE on the same line — history | **86** |
| undated, and a STAMP (`vendored`, `measured`, `at the`, `lift`, `shipped`…) | **160** |
| undated, and a claim about TODAY | **2** by the narrow frame, **14** by the wide one |
| undated, neither — mostly *"what the lift brought"*, also history | 113 |

**So the row's sweep is a no-op on 96 % of its own population**, and executing it as a
sweep would have rewritten 160 provenance stamps into falsehoods. The fourteen that do
decay are listed below, by zone.

### D1.103 — the `0.3.233` / `2.1.233` / `0.3.223` / `2.1.223` family, over the six documents

545 occurrences; **438 sit on a line that carries a date** — the documents are dated
records by construction — and **13** are present-tense. The ratio is the same finding
one corpus over: the class is dominated by provenance and the decayed part is small
enough to repair by hand, one sentence at a time.

## The fourteen present-tense claims, by owning zone (2026-09-17)

Each is a comment sentence naming the vendored bundle as if it were current. The repair
is rule 2: name the instrument, or date the number.

| file:line | zone at the time of writing |
| --- | --- |
| `packages/shared/src/agent/claude-agent.ts:3795`, `:3864` | WI-g |
| `packages/shared/src/agent/claude-managed-settings.ts:731` | WI-g |
| `packages/shared/src/agent/__tests__/claude-operator-ceiling-env.test.ts:109` | WI-g |
| `packages/shared/src/agent/__tests__/claude-auto-mode-classifier-gateway-e2e.test.ts:410` | WI-g |
| `packages/shared/src/agent/codex-agent.ts:4292` | WI-b |
| `packages/shared/src/agent/pi-harness/managed-policy.ts:999`, `:1670` | WI-h |
| `packages/shared/src/config/bash-output-limits.ts:146` | WI-j |
| `packages/shared/src/config/numeric-setting.ts:46` | WI-j |
| `apps/electron/src/renderer/components/app-shell/input/runtime-switch-costs.ts:2211` | WI-j |
| `packages/shared/src/agent/mode-manager.ts:1064` | unclaimed |
| `packages/shared/src/agent/options.ts:2240` | unclaimed (WI-c released it) |
| `packages/shared/src/interceptor-common.ts:179` | unclaimed |

**Three of the fourteen are converted in the commit that adds this file** — the three
unclaimed ones — so the form is demonstrated rather than only described. The other
eleven are hand-offs: one line each, in the zone that owns the file.

## What this file does NOT claim

It does not say any of the 160 stamped readings is still TRUE of `2.1.251`. A stamp is a
fact about when something was read, not a promise about now, and re-taking a reading is
a measurement with its own cost — which is exactly the work D1.167 was asking for and
exactly what a version rewrite would have hidden. Where a stamped behaviour matters at
the current bundle, the honest move is to re-drive it and add a second stamp, never to
edit the first one's number.
