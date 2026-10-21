# P2.278 — `/advisor` is parsed, documented as answered, and answered by nothing

**Status: DONE.** Commit `b248abefc` on `feat/TCODE-000`. Base SHA when I started: `32631ac41`.

Three files, all in zone: `packages/shared/src/agent/base-agent.ts`,
`packages/shared/src/slash-commands/session-command.ts`,
`packages/shared/src/agent/__tests__/session-command-seam.test.ts`.
204 insertions, 1 deletion. Nothing outside the zone was touched.

---

## 1. The premise: reproduced exactly as the row states, before anything changed

I wrote the tests first and ran them against the unmodified tree. The seam test failed
with the sentinel:

```
error: chatImpl must not run for /advisor
      at chat (/Users/i.i.gavrikov/Desktop/work/nessy-desktop/packages/shared/src/agent/base-agent.ts:4341:16)
(fail) `/advisor on|off` moves the persisted setting at the seam and never reaches chatImpl
 17 pass
 1 fail
Ran 18 tests across 1 file.
```

`base-agent.ts:4341` was the fall-through line `yield* this.chatImpl(...)`. The row is
correct in every particular:

- the parser produces `kind: 'advisor'` (`session-command.ts:186`);
- the dispatch block had arms for `clear`, `quota`, `approve` and **no** `advisor`;
- **the comment describing the missing arm was already sitting in `base-agent.ts` itself**,
  immediately above where the arm should have been ("`/advisor` executes HERE for
  `/quota`'s reason…"). That is one site more than the row names — the row cites
  `session-command.ts:112`; `pi-agent.ts:8524` carries a third, and `codex-agent.ts:959`
  a fourth, which actually *documents the defect* ("nothing in production reaches it
  today… `chat()`'s session-command block has arms for `clear`, `quota` and `approve`
  and NONE for `advisor`"). Four comments, no arm.

**Positive control, in the same file and the same process:** the 17 passing rows include
`/clear`, `/quota` and `/approve` answering at the seam with `chatImpl` replaced by an
identical throwing sentinel, plus `/compact` and `/subtask`. The discrimination the row
was found by is reproduced in the suite, not asserted from memory.

## 2. What I built

### 2a. The arm (`base-agent.ts`)

```ts
if (sessionCommand.kind === 'advisor') {
  yield* this.describeAdvisor(sessionCommand.action);
  yield { type: 'complete' };
  return;
}
```

Placed under the comment that already promised it, in sibling shape with `quota` and
`approve`. `describeAdvisor` has no override in any backend (checked with `rg -a` across
`packages/shared/src` and `apps` — see §5 on why the `-a` matters), so one arm genuinely
covers Pi, Claude, Codex and Nestor Cloud.

### 2b. `describeAdvisor` was NOT safe to rely on — the second defect, measured

The dispatcher asked me to verify `describeAdvisor` and `setAdvisorEnabled` do what their
names say rather than assume it. One of them did not.

`describeAdvisor` lacked the `if (!i18n.isInitialized) setupI18n();` guard that its
sibling `approveGuardianDenial` carries eight lines above it. The headless `nessy-server`
entry never calls `setupI18n()`, and an uninitialized i18next returns `undefined` from
`t()` — not the key. So the arm alone would have shipped a `/advisor` that answers with a
**blank info line**: it would stop the text reaching the model, change the setting, and
report nothing. That is precisely the "looks fixed" failure I was told to resist, and it
would have been *worse* than the fall-through because the fall-through at least produced
a visible model answer.

**This is the part that nearly got away, and it is worth reading.** With the whole seam
file running, the arm alone was **green**: 18 pass, 0 fail, 75 expect() calls — including
my `expect(typeof onInfo.message).toBe('string')` assertion. The reason is pure ordering:
the `/approve` row runs earlier in the file and **its** guard initializes i18next for the
whole process. Filtering the run to the advisor rows only:

```
bun test packages/shared/src/agent/__tests__/session-command-seam.test.ts -t advisor
```

the identical code fails:

```
expect(typeof onInfo.message).toBe('string')
Expected: "string"
Received: "undefined"
```

So my own assertion was confounded by test order and passed with and without the
behaviour it was written to check — the exact blind-spot shape the lane rules warn about,
arriving through file ordering rather than through a test double. The guard is now in
place, and **both** the code comment and the test comment name the `-t advisor` rig as the
one that discriminates, so the next person to touch the guard can re-measure in one
command instead of rediscovering this.

With the guard, the filtered rig passes: `4 pass, 14 filtered out, 0 fail, 25 expect() calls`.

### 2c. `setAdvisorEnabled` — verified, with one latent edge (NOT fixed, out of zone)

It does what its name says: it writes `advisorEnabled` into `config.json` and
`getAdvisorEnabled()` reflects it. My test proves this against the **real** function pair
with no double, and additionally reads `advisorEnabled` back out of the persisted
`config.json` on disk. (`advisor-consult-wiring.test.ts` mocks `setAdvisorEnabled` and
asserts on a call log; that file would have stayed green with the arm missing entirely.)

The edge: `setAdvisorEnabled` opens with

```ts
const config = loadStoredConfig();
if (!config) return;
```

so it is a **silent no-op when `config.json` does not exist**. See §4 — reportable, not
live, and `storage.ts` is outside my zone.

### 2d. The parser's comment (`session-command.ts`)

The brief asked me to check the comment says what I actually built. The sentence at `:112`
("Answered at the `BaseAgent.chat` seam like `/quota` and `/advisor`") is now true, so I
left it — but I added the sentence that was missing, that the arm did not exist when that
was written, and I corrected a second claim that read like upstream parity and was not.
See §3.

## 3. Documentation — category (b), and the three forms only PARTLY match

`advisor.md` is in the corpus (`scripts/claude-doc-pages.tsv`, snapshot 2026-08-25,
191 pages; row `advisor`). Fetched from `https://code.claude.com/docs/en/advisor.md`
(200). Anchors taken from the **rendered** page (`curl` without `.md`, grep `id="…"`), not
derived from a slug rule — note `use-the-/advisor-command` keeps its slash, which no
hyphenation rule would predict.

| Form | Upstream | Ours | Verdict |
| --- | --- | --- | --- |
| `/advisor` (bare) | opens a **picker** | reports status | **deviation** |
| `/advisor on` | does not exist | enables | **ours** |
| `/advisor off` | stops + clears `advisorModel` | stops only | **partial** |

Verbatim, `advisor.md#use-the-/advisor-command`:

> "Run `/advisor` without arguments to open a picker listing the available advisor models, or pass the model directly:"

Verbatim, `advisor.md#turn-the-advisor-off`:

> "To stop using the advisor and clear your saved `advisorModel`, run `/advisor off` or choose **No advisor** in the `/advisor` picker:"

Verbatim, `advisor.md#impact-on-prompt-caching` — the sentence that makes the seam arm the
right shape, because it says the toggle is a live mid-session operation:

> "Enabling or disabling the advisor mid-session does not invalidate your main model's [prompt cache]"

**These are deliberate deviations, and I did not change behaviour to chase parity.** A
composer has no picker, so the bare form must report; and Nessy carries a separate
`advisorEnabled` boolean where upstream encodes "on" as "a model is saved", which is why
`on` exists here and why `off` must **not** clear `advisorModel` — clearing it would make
off/on lossy rather than a toggle. What I changed is that the parser's doc comment
asserted `advisor.md` parity and now names both deviations explicitly, with the anchor and
the verbatim sentence.

## 4. Concerns

1. **`setAdvisorEnabled` silently no-ops with no `config.json`** (`storage.ts:1799`,
   `if (!config) return` — one of 42 setters with that guard). Consequence for the arm:
   `/advisor on` would then answer "The advisor is off. Turn it on with /advisor on." — an
   unterminating loop, but *honest*; it never reports a success it did not perform, so the
   requirement holds. **Assessed not live:** `config.json` is bootstrapped at workspace
   creation (`workspaces/service.ts:921`, `workspaces/storage-readiness.ts:289`), and a
   session cannot exist without a workspace, so a user cannot reach `/advisor` first. Not
   fixed: `storage.ts` is outside my zone, and a warning path would need a new i18n key in
   both locales — a file two other live lanes could be holding, where a pathspec commit
   takes the whole working-tree file. **Flagged rather than reached across, deliberately.**
   Notable anyway because the isolated test config dir reproduces it exactly (`ensureConfigDir()`
   does not create `config.json`), which is why my test seeds one.

2. **The listing-versus-dispatch invariant the row argues for is worth building, but it is
   not the naive one.** Only 4 of the 9 `ParsedSessionCommand` kinds are answered at the
   seam (`clear`, `quota`, `advisor`, `approve`); the other 5 (`compact`, `subtask`, `btw`,
   `recap`, `heapdump`) are answered inside `chatImpl` **per backend**, which is legitimate
   — `/compact` and `/subtask` are Pi RPCs. So "every kind has a seam arm" would fire 5
   false positives on day one, and a rule that cries wolf is a rule people stop running.
   The invariant that would actually have caught this is "every kind is answered by the
   session on every runtime, at the seam **or** by a backend that claims it", which needs
   per-backend knowledge. **I did not measure whether all four backends claim all five of
   those kinds** — a coarse grep gave low counts (`subtask` 0 across the four backend
   files) but a grep count is not an answer, and it is outside this row's zone. If the
   controller wants that measured, it is a row of its own and it may well be a fifth
   instance of this same family.

3. **`describeAdvisor`'s ON path is under-covered by my tests.** I assert the message is a
   non-empty string, not which of the six `settings.ai.advisor.*` lines it is, because the
   seam agent has no `connectionSlug` and the resolution branch (`configured` /
   `session-model` / `refused-*` / `unavailable`) depends on session state I did not want
   to pin. `advisor.test.ts` covers `resolveAdvisorModel` itself. The gap is the mapping
   from resolution to i18n line, which remains exercised only in the `session-model`
   direction.

4. **Ordering-confounded i18n coverage is a property of the file, not of my test.** Because
   `/approve`'s guard initializes i18next process-wide, any future row added to this file
   after it inherits the same confound. Both the guard and the test now carry the `-t advisor`
   rig in a comment, but nothing *mechanically* prevents the next guard regression from
   passing a whole-file run. A cleaner fix would be an explicitly uninitialized-i18n
   fixture; I did not build one because de-initializing the i18next singleton mid-process
   is not something this suite has a pattern for.

## 5. One trap re-confirmed, worth a line

`packages/shared/src/agent/base-agent.ts` contains **exactly 1 NUL byte**, so plain
`rg` skips it **silently**. My first search for `describeAdvisor` returned `pi-agent.ts`
and `codex-agent.ts` and *not* the file that defines it — a clean false "no definition
found". `rg -a` returned all six hits. Every absence claim in this report was made with
`-a`. (Also: my first attempt at a NUL check using `grep -qU $'\x00'` reported "no NUL" —
zsh truncates the string at the NUL, so that check is itself broken. `python3` byte-count
is the one that works.)

## 6. Gates — with proof of work, not exit statuses

Every gate was run unpiped into a file and the file inspected, per the lane rule.

| Gate | Result | Proof of work |
| --- | --- | --- |
| Zone `bun test` (mutex, `--label P2.278`) | **PASS** | `91 pass, 0 fail, 279 expect() calls` / `Ran 91 tests across 7 files. [22.14s]` (seam suite + advisor wiring + advisor gate projection + `slash-commands/`) |
| Neighbour `bun test` — every advisor test + every test that reads `base-agent.ts` as source text | **PASS** | `195 pass, 3 skip, 1 todo, 0 fail, 493 expect() calls` / `Ran 199 tests across 13 files. [68.23s]` |
| Discriminating i18n rig (`-t advisor`) | **PASS** | `4 pass, 14 filtered out, 0 fail, 25 expect() calls` / `Ran 4 tests across 1 file.` |
| `bun run typecheck:shared` | **PASS** | exit 0 with zero `error TS` lines (`tsc --noEmit`, unpiped). Caught two real errors on the way: my seed object was missing `activeWorkspaceId` and `activeSessionId`, both required on `StoredConfig` |
| `eslint` on the 3 changed files, run from `packages/shared` | **PASS** | exit 0, empty report — `0 problems` |
| `git diff --check` on the 3 changed paths | **PASS** | exit 0, no output |
| `lint:i18n:parity` / `lint:i18n:sorted` | **NOT-RUN** | Correctly not applicable: no locale file was touched and no key added. All six `settings.ai.advisor.*` keys already exist in `en.json` **and** `ru.json` (verified) |
| Full repo suite / build / packaging | **NOT-RUN** | Implementation-first budget: no shared wire, schema, auth, lock or build-infra change. Not a claim they pass |

### Re-break, against the absolute SHA — not `HEAD~1`

Restored `base-agent.ts` from `32631ac41` (first proving `git diff --quiet 32631ac41 b248abefc^`
on that path — **identical**, so no other lane had moved it under me), ran the seam suite,
then restored from `b248abefc` and cleared the index rewrite with `git reset -- <path>`:

```
error: chatImpl must not run for /advisor
      at chat (…/base-agent.ts:4341:16)
(fail) `/advisor on|off` moves the persisted setting at the seam and never reaches chatImpl
 17 pass
 1 fail
 60 expect() calls
Ran 18 tests across 1 file. [36.10s]
```

**1 test fails without the fix; 17 pass — those 17 are the positive control.** Tree
verified identical to `HEAD` afterwards (`git status --porcelain` empty on all three paths,
`git diff --quiet HEAD` clean).

The i18n guard was re-broken separately and is recorded in §2b: without it, the `-t advisor`
rig fails on `Received: "undefined"`.

## 7. Tests added — four rows, and why each earns its place

In `session-command-seam.test.ts`:

1. `parseSessionCommand claims /advisor in three forms, whole-message only` — positive
   (three forms, case-insensitive, trimmed) and negative (`/advisor opus`,
   `/advisor use opus`, mid-sentence).
2. **`` `/advisor on|off` moves the persisted setting at the seam and never reaches chatImpl``**
   — the load-bearing one. Real `chat()`, live capability runtime, throwing `chatImpl`
   sentinel. Asserts the **state**, not the sentence: `getAdvisorEnabled()` flips both ways
   **and** the persisted `config.json` shows `advisorEnabled` true then false; the bare form
   reports without toggling; no `prompt` RPC on any of the three forms. Uses the real
   `setAdvisorEnabled`/`getAdvisorEnabled` pair — **no double** — seeding and restoring
   `config.json` around itself (snapshot bytes, restore or delete in `finally`, including
   on a `setupAgent` throw).
3. `prose that merely mentions /advisor is still a prompt for the model`.
4. `` `/advisor use opus` names a model and stays a prompt for the model`` — the
   discriminator against an arm that merely swallows anything starting with `/advisor`.
   Without rows 3 and 4, "intercept everything" would pass.
