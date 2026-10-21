# P2.309 — report

**Status:** DONE. **SHA:** `e3f0a485c` (branch `feat/TCODE-000`).
**Fallback chosen:** `gpt-5.6-luna`, at the HEAD, with the retiring `gpt-5.4-mini` behind it.
**Source:** the Codex page names it —
`learn.chatgpt.com/docs/enterprise/workspace-model-availability.md#prepare-for-the-gpt-54-retirement`,
*"Replace `gpt-5.4-mini` with `gpt-5.6-luna` (GPT-5.6 Luna)."* — and it was verified present in
the shipped Pi catalog for `openai-codex` rather than taken from the page alone.

---

## 1. The date. Verified, and it has NOT moved

`[doc:codex]`. Fetched 2026-08-28 by `curl`, both the `.md` and the rendered page.

> `learn.chatgpt.com/docs/enterprise/workspace-model-availability.md#prepare-for-the-gpt-54-retirement`
> — **"On August 31, 2026, GPT-5.4 and GPT-5.4 mini retire from Codex for users signed in with
> ChatGPT."**

and, in the same section:

> **"Replace `gpt-5.4-mini` with `gpt-5.6-luna` (GPT-5.6 Luna)."**

and the carve-out, which is why the `openai` row was never at risk and keeps its `gpt-5.4-mini`:

> **"The OpenAI API and Codex authenticated with your own API key aren't affected."**

The sibling page says it a second time, identically —
`learn.chatgpt.com/docs/models.md#deprecated-codex-models`: *"The `gpt-5.4` and `gpt-5.4-mini`
models retire from Codex with ChatGPT sign-in on August 31, 2026."*

**The anchor was verified the way the standing rule requires** — `curl` the page WITHOUT `.md`,
grep `id="…"`. `id="prepare-for-the-gpt-54-retirement"` is published (note it drops the dot, as
the corrected slug rule predicts for `,`/`:`/`(`/`)`-free headings). `#deprecated-codex-models` on
the models page is an explicit `<a id="…">`, not a heading slug — it would not have been derivable.

**So the row's urgency stands unchanged: three days from today.** Nothing to correct.

## 2. The defect, reproduced before it was fixed

Against the SHIPPED Pi catalog (not a mock), with the pre-fix one-element list restored and
`gpt-5.4`/`gpt-5.4-mini` removed from the catalog to model 2026-09-01:

```
PRE-FIX  today           : gpt-5.4-mini
PRE-FIX  after 2026-08-31: undefined        ← silent; no error, no notice
FIXED    list            : [ "gpt-5.6-luna", "gpt-5.4-mini" ]
FIXED    today           : gpt-5.6-luna
FIXED    after 2026-08-31: gpt-5.6-luna
```

`undefined` sends `queryLlm` to `getDefaultSummarizationModel()`, which returns a Haiku id that
does not resolve under codex auth either — the identical shape P2.97 closed for `github-copilot`
and `amazon-bedrock`.

## 3. Part one — the list

`packages/shared/src/config/llm-connections.ts`

```
-  'openai-codex': ['gpt-5.4-mini'],
+  'openai-codex': ['gpt-5.6-luna', 'gpt-5.4-mini'],
```

The whole shipped `openai-codex` catalog is **seven** ids (measured 2026-08-28 via
`getModels('openai-codex')`): `gpt-5.3-codex-spark`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`,
`gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`. Both chosen ids are in it.

**Why not a third entry.** `gpt-5.3-codex-spark` is the only other fast id, and the models page
marks it *"Available to ChatGPT Pro users"*. Pinning it would trade this silent degradation for a
Plus-account refusal at request time — a different silent failure, not a fallback. `gpt-5.6-sol`
and `gpt-5.6-terra` are the flagship and the workhorse; putting either in the mini slot is exactly
the "billed at the Opus rate" defect P2.97 closed.

**One dependent change.** `isSmallClassModelId` gained `luna`. It had to: the shared invariant
`llm-connections.test.ts` → *"contains only small-class candidates"* asserts every entry in this
table satisfies the predicate, and GPT-5.6 does not spell its cheap tier with any of the generic
words — it names it. Grounded, not asserted: `learn.chatgpt.com/docs/models.md` describes
`gpt-5.6-luna` as the *"Fast and affordable GPT-5.6 model that delivers strong capability at the
lowest cost in the family"*. Its siblings `sol` and `terra` are deliberately NOT matched.

## 4. Part two — the durable half, kept small

`packages/pi-agent-server/src/pick-mini-model.ts`. The walk's `if (!resolved) continue;` was the
third silence in this function, and the one that made P2.97's fix perishable: the day a pinned id
is retired, the mini path stops being what it claims and says nothing. It now names it on stderr,
with the same `[pi-server] [mini-model]` prefix the two existing warnings use:

```
pinned mini-model "gpt-5.6-luna" is no longer in the fetched catalogue for auth provider
"openai-codex" — it was probably retired upstream; falling through to the next preferred
candidate. Update PI_MINI_PREFERRED_DEFAULTS.
```

Three judgement calls, all in the direction of "warning, not mechanism":

- **`resolvePiModel` returning `undefined` means precisely "not in the catalogue we fetched for
  this provider"** — it never narrows on anything else (`preferCustomEndpoint` only *adds* a place
  to look). So a skipped candidate IS a dead pin and needs no separate catalogue check.
- **Deduped per `(provider, id)` for the process lifetime.** This is NOT a startup path: the call
  site is `index.ts:2892` inside `queryLlm`, i.e. once per session title and once per summary. An
  undeduped line would repeat forever, and a line that repeats forever is one nobody reads. A test
  seam `__resetMissingPinWarningsForTest()` exists because the dedupe is process-wide and would
  otherwise make the warning invisible to whichever test ran second.
- **A DENIED candidate is not reported.** `isDeniedMiniModelId` is a deliberate exclusion (the
  ChatGPT backend refuses `*codex-mini*` ids outright), not an absence. Reporting it as "retired
  upstream" would be a false alarm on every background query. There is a control test for this.

**Not built, deliberately:** a table-wide validation sweep at load. It would report pins that
vanished *behind* a working head — real, but the head is the one being used, and the brief's
"proportionate" instruction points away from it. Recorded as §6 finding 3 rather than shipped.

`packages/server-core/src/model-fetchers/nestor.ts` was NOT touched — nothing needed it, so the
"stop and report" clause never triggered.

## 5. Gates — with proof of work, not exit statuses

Every command redirected to a file; nothing piped through `tail`/`head` before the status was read.

| Gate | Result | Proof quoted from the output |
| --- | --- | --- |
| `bun test` on the zone, via the mutex | PASS | `111 pass  0 fail  536 expect() calls` / `Ran 111 tests across 3 files. [48.45s]` — `pick-mini-model.test.ts`, `model-resolution.test.ts`, `llm-connections.test.ts` |
| Mutation check on part two | PASS (fails when reverted) | Restoring the bare `if (!resolved) continue;` → `17 pass  2 fail`, and the two failures are exactly the two warning tests. File restored and byte-compared (`IDENTICAL-TO-PRE-MUTATION`). |
| `tsc` on the zone INCLUDING the test file | PASS | `error TS` count `0`, exit 0. Ran through a scratch config extending `tsconfig.typecheck.json` with the `**/*.test.ts` exclusion removed (the package's 567-error backlog trap). `--listFiles` proves the program really contained `pick-mini-model.test.ts` and `llm-connections.ts` — 2206 files. Scratch config deleted. |
| `bun run typecheck:shared` | PASS | `error TS` count `0`, exit 0 |
| eslint on `packages/shared/src/config/llm-connections.ts` | PASS | `--format json` → `"errorCount":0,"warningCount":0` for that exact `filePath` (an empty stylish output alone would not have proved it ran) |
| eslint on `packages/pi-agent-server` | **NOT-RUN** | Impossible as configured, not skipped — see §6 finding 4 |
| `git diff --check` on the three files | PASS | exit 0, no output |
| i18n parity/sorted | **NOT-RUN** | No i18n key was added or touched; no locale file is in the diff |

Commit verified with `git show --stat --oneline HEAD`: **exactly three files**, no other lane's
work carried in. Committed by explicit pathspec (never `-a`), which mattered — the working tree had
20+ files modified by concurrent lanes and a staged add in the index.

## 6. Findings, each tagged and classified

**1. `PI_PREFERRED_DEFAULTS['openai-codex']` is 1-of-7 live, and misses all three current models.**
`[doc:codex]` · kind: **forgotten against the documentation / parity** · NOT fixed, out of this row's
scope and a user-visible default change.
Measured 2026-08-28 against the shipped catalog:

```
gpt-5.5   present=true      ← the only one
gpt-5.2   present=false     gpt-5.1  present=false     gpt-5    present=false
o4-mini   present=false     o3       present=false     gpt-4o   present=false
present count: 1 / 7
catalog ids absent from the list: gpt-5.3-codex-spark, gpt-5.4, gpt-5.4-mini,
                                  gpt-5.6-luna, gpt-5.6-sol, gpt-5.6-terra
```

The page independently deprecates two of the dead entries for this same sign-in boundary:
`learn.chatgpt.com/docs/models.md#deprecated-codex-models` — *"The `gpt-5.2` and `gpt-5.3-codex` models are already
deprecated in Codex when you sign in with ChatGPT."* And all three **Recommended models** —
`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` — are absent from our primary list entirely, so a
codex-subscription connection defaults to `gpt-5.5`, which the page calls the
*"Previous-generation frontier model"*. **Not dated** (nothing retires `gpt-5.5`), so this is stale
rather than urgent — which is exactly why it wants an owner priority call rather than a drive-by fix
inside this row. The sweep anticipated it (`consider gpt-5.6-terra for :819-820`); I did not act on
it because it changes which model a connection TALKS to.

**2. The locally staged Pi bundle still carries the pre-fix pin.**
`[doc:none]` · kind: **bug, but a dev-machine one only** · no action taken, correctly.
`apps/electron/resources/pi-agent-server/index.js` (27 MB, mtime Aug 27) contains
`"openai-codex": ["gpt-5.4-mini"]`. It is **git-ignored** (`.gitignore:12`), so nothing shipped is
wrong and there is nothing to commit — but this is the AGENTS.md `electron:dev` trap in its exact
documented form: a fix on disk and absent from the running app. **Anyone running the dev app needs
`bun run electron:build:servers` before this change is live for them.** I did not rebuild it: it is
outside my zone and other lanes are active.

**3. A pin that vanishes BEHIND a working head is still silent.**
`[doc:none]` · kind: **never looked at** · deliberately not built.
The warning fires only for candidates the walk actually tries, i.e. those ahead of the winner. If
`gpt-5.4-mini` retires while `gpt-5.6-luna` is healthy, nothing is said — which is correct
behaviour today (the pick is fine) but means the table can silently accumulate dead entries until
one reaches the head. The proportionate fix is a load-time sweep of the whole table, which the
brief's "worth more than a mechanism" steer says not to build inside this row. Recording it so it
is a decision rather than an oversight.

**4. `packages/pi-agent-server` cannot be linted.**
`[doc:none]` · kind: **never looked at** · reported, not fixed.
The package has **no `eslint.config.*`**, and it is not in the root `lint` script — which chains
`lint:electron`, `lint:shared`, `lint:server-core`, `lint:ui`, `lint:scripts` and stops there.
`bunx eslint src/pick-mini-model.ts` fails with *"ESLint couldn't find an eslint.config file"*.
So the brief's "eslint from the package dir" gate is **NOT-RUN and unrunnable**, not skipped.
`packages/server-core`, `packages/shared`, `packages/ui`, `scripts` and `apps/electron` all have
one; this package and `packages/session-tools-core`-adjacent siblings should be checked for the
same hole. Combined with the known `typecheck:all` exclusion of this package's tests, `pi-agent-server`
is the least statically-checked package in the tree.

**5. `luna` is a family name in a keyword predicate.**
`[doc:none]` · kind: **bug, latent and minor** · accepted knowingly.
`isSmallClassModelId` is substring-matching, so a future id containing the letters `luna` anywhere
would be classified small. That is the same exposure the existing `mini`/`flash`/`lite`/`sonnet`
keywords already carry (`sonnet` in particular matches every Sonnet, including large ones), and the
function's own comment says it is keyword-based on purpose because "the id is all we have for a
catalog we do not own". Noting it rather than tightening the whole predicate inside this row.

**6. Absence claim, with its positive control.** No OTHER dated `gpt-5.4` pin exists in the tree.
`rg -a` (NUL-safe, per the standing rule) over `packages apps scripts docs-site` returns hits in
only: the two test files, two source comments (`model-resolution.ts:53`,
`scripts/cdp/lib/claude-child.ts:358`), `models.test.ts` (display-name humanization, no catalog
dependency), `llm-connections.ts` (the `openai` row, protected by the API-key carve-out and sitting
behind `gpt-5-mini` anyway), and the git-ignored bundle from finding 2.
**Positive control on the same run:** `rg -a gpt-5.6-luna` finds the pin I just wrote, in both
files, so the search was live.

## 7. Tests added

All in `packages/pi-agent-server/src/pick-mini-model.test.ts`, +174 lines, and all measured against
the **shipped** Pi catalog where the claim is about a catalog — the block above them says why a mock
is exactly the instrument that cannot see an id that is not there.

- the list is `> 1` element, and every id is in the shipped codex catalog and small-class
  (positive control: the catalog is non-empty)
- the pick today is `gpt-5.6-luna`, not the retiring id (only an assertion on *which one wins*
  catches a head that still resolves until the 31st)
- the pick after `gpt-5.4`/`gpt-5.4-mini` are removed is still `gpt-5.6-luna` — the row's actual
  claim, tested against a future catalog
- the missing-pin warning names the id, the provider, and the phrase; the pick is unchanged either
  way, so stderr is the only thing that can distinguish loud from silent
- it is said once per `(provider, id)`, not once per query
- **CONTROL:** silence when every pin ahead of the winner resolves (against the real catalog, where
  today's correct output IS silence)
- **CONTROL:** a denied candidate is not reported as a missing pin

The pre-existing suite is unchanged and green, including the two shared invariants that gate this
table (`contains only small-class candidates`, `covers every provider that has a primary-model
preference`).
