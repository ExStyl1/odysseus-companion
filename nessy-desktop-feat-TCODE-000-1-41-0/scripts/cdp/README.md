# CDP live-audit harness

Drives the real app over Chrome DevTools Protocol so the AGT-1..AGT-10 wave in
`docs/testing/cdp-live-checklist.md` is a command rather than an afternoon of
ad-hoc scripting.

```
scripts/cdp/
  lib/connect.ts    attach, send/await by id, protocol errors as thrown errors
  lib/keys.ts       real key events — the only way this harness types single-line
                    text; multi-line text rides composer.ts pasteIntoComposer
                    (the app's own paste handler, UA12.166/UA12.180)
  lib/viewport.ts   mouse input, refused when the point is outside the viewport
  lib/composer.ts   composer + slash palette, including palette SELECTION
  lib/chat.ts       turn-level flows (send a prompt, run a slash command)
  lib/state.ts      state reads through window.electronAPI, incl. freshSession()
  lib/fork.ts       /subtask forks: start, wait for settle, read what they said
  lib/codeword.ts   the per-run secret and the memory-leak scan that guards it
  lib/report.ts     PASS / FAIL / BLOCKED and the machine-readable result line
  cases/agt-*.ts    one runnable case per checklist case
  cases/rs-*.ts     the release sitting (P7.5): one case per `measure:` row,
                    run BY NAME and not by the wave — see the section below
  run.ts            the wave
```

## Starting the app for a run

```bash
NESSY_CDP_PORT=9223 bun run electron:dev
```

**A source change is invisible to a CDP run until the bundles are rebuilt and the
app is relaunched.** `electron:dev` runs BOTH the host and the Pi subprocess from
built bundles: the host is bundled into `apps/electron/dist/main.cjs`, and the Pi
subprocess into `packages/pi-agent-server/dist/index.js`. A run against a stale
bundle measures yesterday's code and reports it as today's.

```bash
bun run electron:build:servers   # then relaunch, then measure
```

This cost a real measurement once — the first AGT-1 run measured a Pi subprocess
built before the fix it was testing. Before trusting a result, confirm the
bundles carry the code under test, e.g.
`grep -c parseSubtaskCommand apps/electron/dist/main.cjs`.

## Launch the app with a CLEAN environment — this one cost a measurement too

**A sitting lane is a Claude Code agent, and that agent's own shell exports names
THIS PRODUCT READS.** A bare `exec` of the packaged binary — or `open`, or a
`bun` script that spawns it — hands every one of them to the app, and nothing
says so.

Measured 2026-09-17 on the packaged 1.39.0 (D1.27): with the lane's environment
inherited, every Pi subagent spawn resolved its child to **`opus`**, a model the
gateway does not serve and that nothing in the profile names, because the shell
carried `CLAUDE_CODE_SUBAGENT_MODEL=opus` and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`
— and the force flag restores the pre-`2.1.251` precedence in which that variable
outranks the per-invocation parameter, the frontmatter AND the tier map. The
child's own stored model had already been substituted back by the time it ran, so
the contamination was invisible in the transcript and visible only in
`piChildRestrictions.model`. The row's answer would have been a reading about a
shell, arriving as a product finding.

**Delete them, never overwrite them, and then read the APP:**

```bash
# The -u list is DERIVED from lib/app-env.ts's launcherUnsetNames(), never copied: its table
# PLUS every CLAUDE*/ANTHROPIC_*/MCP_*/DISABLE_* name this shell exports (the prefix sweep; a copy
# listed 7 of 13 names on 2026-09-19, SIT-7, and a measured list missed one on 2026-09-25, RC #1).
# The substitution is INLINE on purpose: an unquoted $(...) is word-split by BOTH bash and
# zsh, while an unquoted $VAR holding the same text is NOT split by zsh (measured 2026-09-19,
# both shells: the variable form left A=1 B=2 set under zsh; the inline form unset both).
env $(bun -e 'import { launcherUnsetNames as N } from "./scripts/cdp/lib/app-env.ts"; console.log(N().map(n => "-u " + n).join(" "))') \
    NESSY_CONFIG_DIR=<a fresh directory> NESSY_DEBUG=1 NESSY_PROXY_AUTH_DEBUG=1 \
  "release/mac-arm64/Nessy Desktop.app/Contents/MacOS/Nessy Desktop" \
  --remote-debugging-port=<port> --user-data-dir=<a fresh directory>

for p in $(pgrep -f "MacOS/Nessy Desktop"); do ps eww -p "$p" | tr ' ' '\n' | grep -E '^(CLAUDE|ANTHROPIC_|MCP_|DISABLE_)' | cut -d= -f1; done
```

**Stopping it: an app parked on the storage dialog does not stop on SIGTERM** —
measured 2026-09-23 (lane WJ-n, packaged 1.40.0, the F1.146 negative-control
root that answers `custom-root-reset-required`): 4 s after `kill -TERM` to the
main pid, the main process and both helpers were still alive; `kill -9` to each
pid, written out literally, stopped all three. So stop a rig app by pid — TERM
first, re-read `pgrep -f "user-data-dir=<its dir>"`, then KILL whatever is left,
ONE pid per argument (a literal list or a real array). The same drive paid the
AGENTS.md zsh trap on the way: `kill -9 $LEFT` over a multi-line `$(pgrep …)`
answered `illegal pid: 20459\n20790\n20791` and killed nothing. Then prove the
debug port free (`lsof -nP -iTCP:<port> -sTCP:LISTEN` prints nothing, beside a
listener you know is up as the positive control) before the next launch.

`scripts/cdp/lib/app-env.ts` is the machine half: `readAppEnvContamination()` reads
the RUNNING app's own environment through `ps eww` — never this process's, which
is a proxy at best — and `appEnvBlockReason()` turns it into the sentence a case
blocks with, naming each variable AND what it moves. It reports names and value
LENGTHS and never values, because two of the names are credentials by
construction. Its positive control is `NESSY_CONFIG_DIR` in the same read: *"no
contaminating name is present"* is equally true of a read that returned nothing,
so a case must treat a missing control as **unavailable** rather than clean.

**The list is a reading with a date, not a closed set.** It was derived by
intersecting the lane's environment with what the repo reads, and the derivation
command is in that module's own docblock. Re-run it; a new SDK release adds
variables and this repo grows readers.

**Read the NUMBERS the command prints, never its line count** — measured
2026-09-18 (SIT-5a, then fixed here as D1.325). Its filter read
`[ "$c" != 0 ]`, a STRING comparison, and `wc -l` pads its output on this shell,
so `"       0"` is not `0`, the test passed for every name, and the command
printed all thirty-one candidates instead of the thirteen with readers. The
filter is `[ "$c" -ne 0 ]` now — `test` tolerates the padding in a NUMERIC
comparison — and the two arms were measured on the same shell with a non-zero
count as the positive control. No reading ever moved: the counts beside the
names are the reading. A control a reader cannot take at a glance is one that
stops being taken.

**And re-run it the BOUNDARY-AWARE way** — measured 2026-09-18 (WI-aa, D1.260).
The original derivation used `git grep -ac "$n"`, a SUBSTRING match, so a
candidate name that is a substring of a real reader scored that reader as its
own. Two entries were inflated: `CLAUDE_CODE_SUBAGENT_MODEL` 14 → **10** (the
four extra are its own `_FORCE` sibling), and `MCP_CONNECTION_NONBLOCKING`
3 → **1**, whose one remaining hit is a docblock sentence rather than a reader —
the product reads the posture from `NESSY_MCP_CONNECTION_NONBLOCKING`, a
different name, so the bare one a lane exports moves nothing and RS-06's readings
carry no confound from it. That entry is now `files: 0`: the launcher still
deletes it, the read still reports it, and `appEnvBlockReason` does not block on
it, because a guard that refuses a measurement over an inert name teaches the
next operator to ignore the guard. Use `-P` and not `-E`: `git grep -E` does not
honour `\b` on this rig and the miss is silent.

**And the CASE process needs the same treatment**, for the same reason it needs
`NESSY_CONFIG_DIR` (see `configDir`'s docblock): a case is a second process, and
a case that reads a path or spawns anything inherits whatever the shell gave it.

## Running

```bash
bun run scripts/cdp/run.ts              # the whole wave
bun run scripts/cdp/run.ts AGT-1 AGT-2  # a subset
bun run scripts/cdp/cases/agt-1.ts      # one case, on its own
```

Each case prints human lines to stderr and one machine line to stdout:

```
##CDP-RESULT## {"case":"AGT-1","status":"FAIL","checks":[…],"observations":{…}}
```

Exit codes: `0` PASS, `1` FAIL, `2` BLOCKED. Screenshots for non-passing cases
land in `$NESSY_CDP_ARTIFACTS` (default `/tmp/nessy-cdp-artifacts`).

`BLOCKED` means a precondition the harness deliberately will not create for
itself — a hook, a plugin install, a managed policy. It is not a pass and not a
failure, and the message says exactly what to put in place.

## The `insertText` trap — read this before changing lib/keys.ts

CDP has `Input.insertText`, which commits a string into the focused editable in
one shot. **It fires no key events at all.** Two things in the composer depend on
them:

- `useInlineSlashCommand.handleInputChange` opens the palette only when the text
  *before the caret* ends with a slash-token — regex
  `(?:^|\s)\/([a-zA-Z0-9._-]*)$`. Committing `/subtask do a thing` in one shot
  leaves the caret after "thing", so nothing matches and no palette appears.
- `InlineSlashCommand` binds ArrowUp / ArrowDown / Enter / Tab / Escape on
  `document` keydown. With no key events there is no way to *select* a row — and
  selection is what turns typed text into a command.

A run that typed `/subtask …` with `insertText` and pressed send submitted the
text **as prose**. The parent answered a question about its own history, the run
recorded a PASS for conversation inheritance, and the pass was retracted the same
day (`docs/testing/cdp-live-checklist.md`, 2026-07-30). `Input.insertText` is now
refused by `CdpSession.send` itself — see `FORBIDDEN_METHODS` in `lib/connect.ts`.

**What a typed character sends instead** (`keyEventsForChar`):

| # | CDP call | payload | effect |
| - | --- | --- | --- |
| 1 | `Input.dispatchKeyEvent` | `{type:'rawKeyDown', key, code, windowsVirtualKeyCode}` — **no `text`** | DOM `keydown` |
| 2 | `Input.dispatchKeyEvent` | `{type:'char', key, text, unmodifiedText}` | inserts the character |
| 3 | `Input.dispatchKeyEvent` | `{type:'keyUp', key, code, windowsVirtualKeyCode}` | DOM `keyup` |

`rawKeyDown` deliberately carries no `text`: a `keyDown` that carries `text`
inserts the character by itself, so pairing the two types every character twice.
`KEY_MODE_KEYDOWN_TEXT` is the fallback encoding (`keyDown{text}` + `keyUp`, no
`char`) if a live run finds a character `char` will not insert — never send both.

Named keys (Enter, Tab, arrows, Escape) send **`rawKeyDown` + `keyUp` only, never
a `char`**. In a browser, `preventDefault()` on keydown suppresses the keypress
that follows; CDP does not link the two, so a separately dispatched `char` would
arrive anyway and insert a `\r` into the composer right after a successful
palette selection. Everything here handles those keys on keydown.

## Selecting, not typing

```ts
await selectSlashCommand(session, {
  token: 'subtask',            // typed one real character at a time
  match: /subtask/i,           // matched against the palette row's visible text
  expectComposer: '/subtask ', // the app's OWN prefill, asserted
})
```

The order is load-bearing. The palette closes as soon as the caret stops sitting
on a slash-token, so the entry must be committed **before** the argument is
typed. `submitComposer` refuses to press Enter while the palette is open, because
Enter would select a row instead of sending.

Selection is also the assertion: for `/subtask` the palette's own handler
prefills the composer with `"/subtask "` (`slash-command-actions.ts`
`PREFILL_COMMANDS`), so a composer holding exactly that string is proof the app —
not the harness — put the command there. Commands that submit on selection
(`/compact`, `/clear`, the permission modes) take `submitOnSelect: true` and
`expectComposer: ''`.

## Every case creates its own session

`freshSession()` dispatches the renderer's own `nessy-agent-navigate` event with
route `action/new-session` — the same path the sidebar's New Chat takes — waits
for the session to appear in `getSessions()` AND to become the selected row, and
names it `CDP <case> <time>` so the operator can find the litter afterwards.

**This is not tidiness.** The first AGT-1 run attached to whatever was on screen:
a real conversation with 86 messages. Every read in it — the transcript, the
"last assistant message", the child list — was a read of someone else's history,
and the case reported on it as if it had planted it. A check has to measure the
feature, not the screen.

The helper throws in one situation only. When it cannot create a session it
falls back to the open one and returns `fresh: false` with the reason and the
inherited message count; every case asserts `fresh`, so a contaminated run fails
loudly instead of passing quietly. It never changes the mode of a session it did
not create: an open session that is not in the mode the case runs in (bypass, or
for an opt-out the mode the app created the case's session in) BLOCKS the case
instead (F1.775 — SIT-k saw the old fallback write bypass onto the open session,
and a [DEFAULT] arm run in bypass).

**The selected row is not the pane, and this is the trap that bites hardest.**
The checklist records it as a standing gotcha: after New Session the route and
the sidebar row update while the content pane keeps showing the PREVIOUS session,
and the remedy is to click the row to resync. It is not cosmetic — the composer
belongs to whichever session the pane shows, so a case that types at that moment
sends its prompt into **another conversation** and then waits out its full
timeout on its own empty session. AGT-3 did exactly that: 180 s, `count: 0`, and
the seed turn landed in the previous case's session.

So `freshSession()` clicks the row and then waits for the composer to be
**empty**. A session created seconds ago has no draft, so text still sitting in
the composer is the stale pane, observed on the very surface the case is about to
drive rather than guessed at with a delay.

**And it names the session before it clicks.** `NavigationContext` auto-deletes a
session the moment it leaves the visible set while
`!lastFinalMessageId && !name && !isProcessing` and it has no draft — which
describes every session this helper has just created. The resync click is a
click, and a click can land on the wrong row; when it did, the app deleted the
session out from under the case and the next read failed with
`session-not-found` two steps later, pointing at nothing. A name makes it
ineligible for the sweep. It also leaves the litter labelled `CDP <case> <time>`
for whoever cleans up afterwards.

## A fork is not a turn

`waitForTurn` is the wrong wait for `/subtask` and produced a wrong answer to the
one question AGT-1 exists to ask. Submitting the command adds the user message,
spawns a **background** child, and leaves the parent not processing — so "the
transcript grew and nothing is streaming" is true within a second, before the
fork has done anything at all.

Then there is nowhere obvious to read the answer, because **a fork writes no
assistant message.** `lastAssistantText` therefore returned the parent's own
third-turn reply (`"\n\n3"`), which looked like a plausible fork answer and was
not one.

`lib/fork.ts` reads the three surfaces that do carry a fork:

| Surface | Read | Answers |
| --- | --- | --- |
| `childState.children` | `piRuntime()` | did a child register, and has it settled |
| `read_child` control | `readChildTranscript()` | what the CHILD itself said |
| `subtask-<agentId>` tool pair | `forkEntries()` | what the PARENT recorded |

The last one is the durable record: `recordForkResultInTranscript` writes a
`subagent` tool_start/tool_result pair with `toolUseId = subtask-<agentId>` and
`displayName` "Fork" when the child settles (`c842b3c7`). Reading it needs
`toolResult` off the message, which is why `transcript()` carries the tool fields
now — dropping them is what made the misread possible.

**Recorded deviation — `fork_start_line`.** The `Forked this conversation into …`
START line is a transient `info` event and is deliberately not persisted, so
asserting it fails on documented behaviour. `fork-transcript-entry.ts` states the
rule plainly: the panel is the live surface, the transcript entry is the record.
A suite that cries wolf over a deliberate design decision gets ignored, so the
check asserts the RESULT entry instead.

## The negative control needs a secret nothing else holds

AGT-1's value is entirely in the control: a fork answers something only the
parent's history can supply, and a named subagent cannot. That comparison is void
the moment the secret exists anywhere a fresh-context agent can read.

It went void once. The run planted `ZARYA-417` with the words *"Remember this
codeword exactly"*, the model did exactly that — through its memory tool, into
the session's own `data/MEMORY.md` — and the control subagent read it back
verbatim out of the file. The control scored FAIL and the finding was the
harness's own.

`lib/codeword.ts` answers with two defences, because either alone is a coin flip:

- **Don't ask for it to be remembered.** `plantPrompt` states the value and
  explicitly forbids persisting it. "Remember" is the word that reaches for the
  memory tool.
- **Check, don't assume.** `memoryLeaks()` reads the three files the memory layer
  actually loads (`memory-store.ts`: session `data/`, project cwd, config dir)
  and names any that hold the token. A leaked control is reported **BLOCKED** —
  never banked as a pass, never filed as a product failure.

The token is 20 random hex characters with no fixed prefix. `ZARYA` appears in
this repo's own checklist, so a subagent with a shell could have grepped its way
to a plausible answer without inheriting anything.

## A long transcript is built from MANY moderate tool results, never one big one

Measured 2026-09-18 (SIT-5b, D1.234). A case needing "a realistic long
transcript" reaches for one big tool result, and that is the one shape which
cannot produce one: asking a turn for `seq 1 9000` grew the conversation by
**4 366** chars, because the product PERSISTS a large tool result to a file and
leaves `<persisted-output> Output too large (42.9KB). Full output saved to: …`
in the transcript in its place. Three `seq 3000` calls in a loop grew the same
conversation from 2 843 to **57 377**.

So build the length with a LOOP of results under that threshold, stopping as
soon as a floor is met — and assert the floor before the arm that needs it, or
"the behaviour did not happen even on a long transcript" is equally true of a
transcript that never grew. `cases/rs-63.ts` is the worked example.

## Wait for the surface, do not sample it

Three checks in this wave failed against surfaces that were about to appear, and
each read like a product defect until the timing was looked at:

- **the slash palette.** `selectSlashCommand` slept 250ms and read once.
  `useInlineSlashCommand` assembles its command set from workspace, project and
  plugin sources, so how long the menu takes depends on what is loaded.
  `waitForPalette()` polls instead.
- **the agent panel.** Asserting `[data-testid="agent-panel"]` the instant a
  child appears in `childState.children` fails: the panel mounts on the
  renderer's invalidation event, which lands later. Wait for the row, then
  assert the panel.
- **the permission card's text.** `innerText` is layout-dependent and the card is
  `h-full` inside a pane that sizes a frame later, so the read taken the moment
  the selector matches returns `''` — and a check on empty text reports "the card
  does not name the agent" about a card that does.

The shape is the same every time: `selectorCount > 0` and "the element has the
content I expect" are different questions, and the gap between them is where a
false finding fits.

## The viewport guard

Every click goes through `lib/viewport.ts`, which reads `window.innerWidth/Height`
and **refuses** a point outside it with the numbers in the message. A previous run
clicked a palette row at y=1006 in a 900px-tall window; CDP dispatched it happily,
the click landed nowhere, and the click-outside handler closed the palette. Prefer
arrow keys + Enter; a click is the input that can miss.

Screenshots are 2x device pixels while every coordinate here is CSS pixels. Read
coordinates off `getBoundingClientRect()`, never off a screenshot.

## How the cases assert

State first, DOM second, pixels only as evidence on failure.

| Read | How |
| --- | --- |
| transcript, roles, info messages | `electronAPI.getSessionMessages(id).messages` |
| session identity, model, thinking level, `isProcessing` | `electronAPI.getSessions()` |
| forks / children | `electronAPI.getPiHarnessRuntime({workspaceId, sessionId}).snapshot.childState.children` — the exact field `useAgentPanel` maps into rows |
| permission mode, thinking level, rewind, memory | `electronAPI.sessionCommand(id, {...})` |
| output styles | `electronAPI.listOutputStyles / getOutputStyle / setOutputStyle` |
| fork panel rows | `[data-testid="agent-panel-row-<agentId>"]` + `data-fork`, `data-status` |
| permission card | `[data-tutorial="permission-banner"]`, allow `[data-tutorial="permission-allow-button"]` |
| composer | `div[data-tutorial="chat-input"][role="textbox"][aria-multiline="true"]` |
| open session | `.session-item[data-selected]` → `data-session-id` |
| policy refusal toast | `[data-sonner-toast]` |
| what the RUNTIME received, on a PACKAGED build | `lib/runtime-session-log.ts` — the Pi SDK's `<session>/.pi-sessions/*.jsonl` and the Claude SDK's `<workspace>/claude-config/projects/…/*.jsonl` |

A multi-panel layout puts several composers and several selected session rows on
screen; the harness throws rather than guessing which one a case meant. Run the
wave with a single content panel open.

**A packaged build writes no application log.** `apps/electron/src/main/logger.ts`
turns both electron-log transports off whenever `isDebugMode` is false, which on
a packaged Electron build it always is — so any case that asserts on a
`[session] …`/`[agent] …` line measures a DEV build only, and the audit of the
signed 1.25.0 confirmed nothing but `<config>/logs/auto-update.log` exists there.
Read the runtime's own session file instead (the row above). The debug logger
is the second choice, not the first, and it is reached by `-- --debug` written
AFTER the Chromium switches (`… --user-data-dir=<dir> -- --debug`), never by a
bare `--debug`: Node claims the bare flag as its own removed option and the
packaged app exits at start (`[DEP0062] node --debug … invalid`; SIT-b and SIT-am,
2026-09-25, while `-- --debug` gave `INFO [main]`/`[session]` lines — F1.767).
`NESSY_IS_PACKAGED=false` also turns the logger on, but SIT-b's one launch with it
never loaded a session ("Workspace connection is unavailable"). Either way the
same branch sets `NESSY_DEBUG=1`, which the Pi subprocess inherits and which
makes `isDevRuntime()` true — so it is no longer the configuration a user gets.

## Before driving a row that says "on a packaged build", ask the ARTEFACT first

A row's clause is a claim about a BUILD, and a build comes from a commit. The
fourth measure sitting had two rows — `D1.244` and `D1.162` — asking for
behaviour implemented LATER in the same wave than the commit the 1.39.0 artefact
was built from. Driven as written, each would have produced a confident false
finding: an empty gateway catalogue read as *"the gateway publishes no reasoning
block"*, a missing per-entry mark read as *"the renderer does not render it"*.
Neither is a product fact. Both are the build.

`lib/artifact-carries.ts` is the check, and it is two instruments because one is
not enough:

```ts
requireArtifactCarries(run, resolveAppUnderTest(session), {
  marker: 'sampling_params',          // the literal the behaviour ships as
  control: 'contextWindow',           // a sibling that MUST be there whatever the answer
  implementedBy: '4e3b57caf',         // the commit that built it, when the row names one
})
```

- The **scan** reads every file under the app's own `dist` tree — the renderer
  assets included, which the two named bundles in `lib/bundle.ts` do not cover —
  counting BYTES, for the reason `countInFile` states: `grep -c` counts lines, and
  a NUL byte makes plain `grep` skip a file silently.
- The **control** is not optional. Without it, *"the build does not carry this"*
  and *"I read the wrong directory"* are the same number, and the verdict says
  which one it is (`control-failed` never reads as an absence).
- The **ancestry** answers what the scan cannot: `git merge-base --is-ancestor
  <implementing commit> <artefact commit>`. The artefact's commit is the
  operator's to supply — nothing in the bundle states it — through
  `NESSY_CDP_ARTIFACT_COMMIT` or the `artifactCommit` field. An unknown sha
  answers `undefined`, never `false`, so a typo cannot manufacture a NULL.

The verdict `null-by-artefact` **BLOCKS** the case rather than failing it: the
question was never put to the product, and a FAIL would file a product defect
against a build. `marker-not-discriminating` is the opposite error and blocks
too — a marker already present in a build that predates its own commit proves
nothing.

**Where the triples live (D1.288).** `ROW_ARTEFACT_MARKERS` in the same module
carries the marker/control/commit for each sitting row that has stated one, with
the numbers it answered on the packaged 1.39.0 in the entry's own comment. A case
takes its row's entry rather than retyping the strings:

```ts
requireArtifactCarries(run, resolveAppUnderTest(session), ROW_ARTEFACT_MARKERS['D1.162'])
```

It is a holding pen, not a registry to grow: when a row gets its case, the entry
moves into the case and leaves the table. **Three rows are in it and no case
calls it yet, for a measured reason** — the rows that state a marker (`D1.244`,
`D1.162`) have no case file, the fourth sitting having nulled both by hand.

Some fixes ship **no literal at all**, and those rows are answered by the
ANCESTRY alone (D1.308): omit `marker` and `control`, name `implementedBy`, and
the shipped tree is not walked — the reading carries `scanRun: false` and says so
in its detail, so `filesScanned: 0` is a statement rather than a zero somebody
took. `D1.264`'s repair is the example the shape was built for: it NAMES three
fields where a spread published four and adds one string to an `exact()` list, so
nothing new reaches the bundle and both strings it touches are everywhere in it
already. With no scan there is no control, so the commit has to carry the
discrimination on its own: an unresolvable sha answers `ancestry-unknown`, never
an absence.

## A sitting case is not a wave case

`rs-02`…`rs-31` are the release sitting's cases (plan row **P7.5**), one per
`measure:` row the owner ruling names, plus `RS-30` (P6.1052) for the one P7.14
clause a unit test cannot reach and `RS-31` (P6.1064) for the stdin-approval arm
— RS-01 is skipped deliberately because `CRU-7` already answers it. **Every count
in this section is a reading with a date**, which is why `harness.test.ts` globs
the directory and asserts floors rather than equalities: the file count and the
driving count below both moved the day `RS-30` landed, again the day `RS-31` did,
and the sentences saying them did not move themselves. Derive them instead of
reading them here:

```bash
ls scripts/cdp/cases/rs-*.ts | wc -l                                    # files
grep -l 'export async function drive' scripts/cdp/cases/rs-*.ts | wc -l  # drives
```

They are still out of `run.ts`'s
default wave, and since P6.1007/P6.1012 they are neither unreachable nor
unenumerated:

- `harness.test.ts` **globs the directory** (`cases/rs-*.ts`) rather than
  restating it, and holds every file to `meta.id === <filename>.toUpperCase()`, a
  `meta.row` that names a row the plan actually carries, and — for a recipe — a
  detector and a positive control read through `lib/sitting.ts`'s types;
- `run.ts` knows the TWENTY driving ids in its own `SITTING` const, so
  `bun run scripts/cdp/run.ts RS-07` works, while a bare
  `bun run scripts/cdp/run.ts` still runs only the wave;
- the CRU wave's own habit works unchanged —
  `bun run scripts/cdp/cases/rs-07.ts`.

Staying out of the DEFAULT wave is deliberate, and for the same reason
`MCP-W1…W3`, `SKL-P1` and the `NCA-*` block are subsets of their own: each needs
preconditions the wave has no way to arrange, and several want the owner's hands.
The sitting adds one reason of its own — each case records WHICH card answered
rather than switching runtimes for you, so it is run **one card at a time**.

**Two shapes live under the one prefix.** `rs-02`…`rs-13` all carry a `drive()`
and print a `##CDP-RESULT##` line, blocking with the missing precondition named
when they cannot run, and several ALSO export a `manual` block for one arm a
driver must not perform. `rs-14`…`rs-29` split NINE pure recipes — which print
`{ meta, manual }` as JSON and no result line — from SEVEN drives. (Six and ten
until 2026-09-10: `rs-28` carries a `drive()` and a `main(ID, TITLE, drive)`
exactly like its `rs-27` partner and had been counted as a recipe.) Outside that
range `rs-30` drives and `rs-31` is a recipe. The total is the second command
above — `run.ts`'s `SITTING` const is what lists the drivable ids, and
`harness.test.ts` asserts against the DIRECTORY rather than against this
sentence, which is the only reason this paragraph being out of date has never
cost a run.

**A pure recipe must never be added to `run.ts`'s `CASES`.** `runOne` spawns the
file and looks for a `##CDP-RESULT##` line; a case that prints a sheet instead
would be scored FAIL for never having been meant to run.

**Every `rs-*` file exports a wider `meta`** than the wave cases' `{ id, title }`:
it adds `row` (the plan row it answers), `runtimes`, and `credentials` — which
names the CARD the owner must have signed in, never a key, a token or a header
value.

`runtimes` carries the runtime FAMILY and nothing else — `pi` / `claude` /
`codex`, the vocabulary `lib/sitting.ts` exports as `SITTING_RUNTIMES` and derives
its `SittingRuntime` union from, so the two can never disagree. Since P6.1058
every case file that declares the field binds its block with
`} as const satisfies CaseMeta`, which makes the compiler the primary reader;
`harness.test.ts` checks the same vocabulary over the directory's SOURCE, because
`satisfies` binds only a file that opted in and a new file can forget to
(`cru-7.ts` did).

## Every case runs in `bypassPermissions`, unless the card is its subject

**Owner rule, 2026-09-18 (D1.385):** testing runs through bypass permissions,
because the app asks for permission so often that an automated run cannot get
through. An unattended drive cannot click, so a card nobody answers is a hang —
RS-79's was one, and `rs-86.ts` records the same shape twice: a command hook's
card on screen, `awaitingApprovalCount: 0`, the turn wedged for 180 s and again
for 300 s.

`lib/permission-mode.ts` holds the default and the opt-outs; `lib/state.ts`'s
`applyCasePermissionMode` is the only writer, and `freshSession()` calls it on
BOTH its paths, so a case cannot forget — on the fallback path only when the
session it fell back to is the one it created (F1.775). `runCase` records the
case id, which is safe as a module-level value because `run.ts` gives each case
its own process.
`FreshSession.permissionMode` carries what actually took — read back off
`getSessions()`, never the mode that was asked for — so the checklist's `Note`
has a source rather than an assumption.

**A case that sets the mode itself needs no opt-out.** The default is applied at
creation and the case's own later `setPermissionMode` wins; `rs-65.ts` is the
worked example, and `rs-108.ts` is the worked example of why an opt-out would be
the WRONG instrument for a card case: an opt-out applies nothing, which leaves
the session in the shipped `auto` — the one mode that asks for nothing on an
ordinary in-workspace command, so the floor it measures could not be seen at
all. The preconditions table spells that shape ``bypass, then `<mode>` — the
case sets its own``, and the gate CHECKS it against the case file's own
`setPermissionMode` call rather than believing the sentence. Nor does a case that merely runs `approvePermissionsWhile` as a
NET — bypass makes that net idle, which is the point.

### The cases that keep the mode they measure

| Case | Subject | What bypass would destroy |
| --- | --- | --- |
| RS-07 | the card | its own section heading says *"Approval is part of the subject, not a nuisance"*; under bypass nothing is ever asked and its approved-count instrument reads zero for every run |
| RS-12 | the floor | `protected-paths.ts` returns `allow` for `bypassPermissions` before anything else is consulted, and arm 2 drives that floor as its own positive control |
| RS-51 | the card | the ABSENCE of a card is the finding — `awaitingApprovalCount` *"stayed 0: nothing asked the person before"* a worktree was created |
| RS-76 | read-before-write | a guard implemented as a permission decision is invisible under bypass, so *"nothing stopped it"* would be manufactured on all three runtimes |
| RS-97 | a hook approval | `PermissionRequest` is one of the host hook events in the matrix under test; under bypass no permission is requested and that row records a false non-firing |
| WIRE-PARITY | the card | the case refuses this lever BY NAME beside its own mode read: *"Setting `bypassPermissions` here would make F7's 'no permission prompt regressed' assertion vacuous"* |

**D1.385 also sketched an id list, and reading the cases refutes seven of its
eight entries.** `ROW_NAMED_NOT_OPTED_OUT` carries each with its measurement and
`harness.test.ts` re-runs them, so the disagreement is visible and dated rather
than silent: `RS-61` and `RS-79` are VICTIMS of the card storm (D1.385 names
RS-79 as its own motivating example, so opting it out would preserve the failure
the rule was written to end), `RS-65` sets its own mode, and `RS-46`, `RS-72`,
`RS-77` and `RS-81` carry no permission-mode code at all. `RS-76` is the one
entry of the eight that survives. The owner named those ids and can overrule the
reading — which is why it is a gated list and not an omission.

## Preconditions per case

| Case | Needs | Mode |
| --- | --- | --- |
| AGT-1 | nothing — it creates its session and generates its own codeword | bypass |
| AGT-2 | nothing; it seeds one turn first (see below) | bypass |
| AGT-3 | nothing; it seeds one turn and sets Ask mode itself | bypass |
| AGT-4 | `NESSY_CDP_OUTPUT_STYLE_ID`, `NESSY_CDP_OUTPUT_STYLE_MARKER`, `NESSY_CDP_MEMORY_MARKER` — all three written by `bun run scripts/cdp/fixtures/agent-surfaces.ts`. The rewind half needs no env: it drives a fork and a named subagent to each write a file and asserts which one the rewind reverts | bypass |
| AGT-5 | `NESSY_CDP_HIGH_EFFORT_SUBAGENT` (frontmatter `effort: high`) AND `NESSY_CDP_SESSION_EFFORT_SUBAGENT` (frontmatter with NO `effort:`). Two, because `resolveEffortLevel` is `invocation ?? declared ?? session` — a declaring agent masks the session level, so half 2 measures nothing on it. `fixtures/agent-surfaces.ts` writes both | bypass |
| AGT-6 | `NESSY_CDP_PROMPT_HOOK_MARKER`, `NESSY_CDP_COMPACT_HOOK_MARKER` + the two hooks in `<configDir>/hooks.json` — `fixtures/agent-surfaces.ts` MERGES them in and prints both markers | bypass |
| AGT-7 | `NESSY_CDP_PLUGIN_KEY`, `NESSY_CDP_PLUGIN_OPTION_KEY`, `NESSY_CDP_PLUGIN_SENSITIVE_VALUE` + the plugin INSTALLED; optional `NESSY_CDP_PLUGIN_PLAIN_KEY`/`_PLAIN_VALUE`, `NESSY_CDP_PLUGIN_DATA_ROOT` (which now defaults under `NESSY_CONFIG_DIR`, not `~`). The case supplies the values itself through `plugin.manage({action:'configure'})` — the dialog's own submit path — so no typing is involved | bypass |
| AGT-8 | TWO SITTINGS. Sitting 1: `NESSY_CDP_BLOCKED_MODEL` + a deployed policy (`fixtures/agent-surfaces.ts --managed <id>` writes the no-root delivered form). Sitting 2, after removing the policy and RELAUNCHING: the same var plus `NESSY_CDP_POLICY_WITHDRAWN=1`. The allowlist is fixed for the process lifetime, so one run cannot reach both halves | bypass |
| AGT-10 | a `claude-runtime` connection (the "Claude Code (Nessy Gateway)" card). The case refuses rather than passing vacuously on a Pi-only host | bypass |
| MCP-W1…W3 | their own fixture tree AND their own `NESSY_CONFIG_DIR`, which the APP boots before the fixture writes into it (F1.146): launch the app ONCE on a fresh `NESSY_CONFIG_DIR=<g6>/config` and quit; `NESSY_CDP_G6_ROOT=<g6> bun run scripts/cdp/fixtures/mcp-naming.ts` (it writes `mcp.json` and enables `t-tracker` only in a root carrying the app's `storageLayoutVersion`, and says so and writes nothing on any other); relaunch; complete the onboarding once (RS-32 does it with the one-click "Nessy · Pi agent" card and "Get Started" — while it is on screen no route renders and MCP-W1 BLOCKS naming it); install the probe plugins through the app's own marketplace RPC (`addRegistry` for `market-a` and `market-b`, then `marketplace.install` per listing). **The recipe this row carried until F1.146 — fixture first, then launch — never rendered a window**: the fixture had already written `config.json` and `mcp.json` into a root the app had never booted, storage readiness refused it (`custom-root-reset-required`) and `RS-32` against it answered `renderer-gone` (SIT-11, all three drivers). Each case reports BLOCKED, never FAIL, against any other config dir | bypass |
| SKL-P1 | its own fixture tree and config dir — `bun run scripts/cdp/fixtures/paths-skill.ts`, then `cdp-paths-probe` installed through the app's own marketplace RPC. A DIFFERENT root from the MCP-W tree; the two are not one wave. The case automates only the metadata half; the `paths` activation half is operator-run (the `SKL-P1` row in the checklist), so a green result is not a gating pass | bypass |
| LIV-1…LIV-3 | nothing seeded. Each creates its own session and picks a `claude-runtime` card BY MEASUREMENT — probing candidates in turn, starting with `NESSY_CDP_CLAUDE_CARD`, and using the first whose model completes a turn. They BLOCK when no card completes one (an upstream refusal, quoted verbatim — on 2026-08-17 `claude-custom-2` answered the L10 guardrail 403) and when `ps` cannot see the app or `lsof` cannot read a working directory, because every child is attributed to a session BY CWD. `LIV-3` also BLOCKS when the card offers no two models with the same derived session shape, since every switch on such a card respawns by design | bypass |
| CRU-5 | `NESSY_CDP_SKILLED_AGENT`, `NESSY_CDP_SKILL_MARKER`, `NESSY_CDP_SKILL_QUESTION`; optional `NESSY_CDP_PLAIN_AGENT`. Two markdown files under the config dir — `fixtures/agent-surfaces.ts` writes them and prints the whole invocation | bypass |
| CDX-ROLES | `<configDir>/agents/probe-role.md` + `probe-denied.md`, a codex-runtime card, and an app log. The path follows `NESSY_CONFIG_DIR` (it used to be hardcoded to `~/.nessy-agent`, so a fixture config dir could not serve it); `fixtures/agent-surfaces.ts` writes both with a fresh `ZEPHYR-<8 hex>` | bypass |
| RTS-10 | nothing, on the RTS fixture tree: `NESSY_CDP_MCP_TOOL` now defaults to the fixture's own `whoami` on `rts-echo`. `seedProbeServer()` runs only when `config.json` already exists, so the order is fixture → boot once → quit → fixture again → launch | bypass |
| AGT-9 | nothing for part 1. Part 2 needs the app LAUNCHED with `NESSY_AUTO_COMPACT_WINDOW=90000` — it narrows the capacity the threshold is computed against so a crossing is reachable in a handful of turns. Do not go much lower: at 30 000 the threshold falls below a session's ~46 000 base context and it compacts after every turn forever. Rebuild `packages/pi-agent-server/dist` first — dev loads the arithmetic from there | bypass |
| CRU-7 | a PACKAGED build behind a logging egress proxy, `NESSY_CDP_PROXY_LOG`, and a claude-runtime card. **Its claim INVERTED in `9af3a92c4`** and the file was refreshed to match: the host now writes `skipWebFetchPreflight: true` on every claude-runtime spawn, so the finding is the ABSENCE of `api.anthropic.com` in the proxy window and the discriminator arm expects a fresh hostname to SUCCEED with the vendor host refused. `NESSY_CDP_NO_DOMAIN_CONTROL=1` additionally asserts the empty-pairing notice | bypass |
| RS-02…RS-13 | the release sitting (P7.5), first half — one case per `measure:` row. EVERY one of them has a `drive()` and prints a `##CDP-RESULT##` line, so each runs standalone: `bun run scripts/cdp/cases/rs-07.ts`. `RS-02`, `RS-03`, `RS-04`, `RS-06`, `RS-07`, `RS-08`, `RS-10` and `RS-13` ALSO export a `manual` block for the arm a driver must not do — `RS-02` and `RS-07` (the sandbox master switch, OFF by standing owner decision), `RS-03` (reaching the `text` carry tier on purpose), `RS-04` (attaching an image, a native file picker), `RS-06` (four runs across two relaunches), `RS-08` (the loopback capture), `RS-10` and `RS-13`. Env: `RS-04` needs `NESSY_CDP_CODEX_VISION_CARD`, `NESSY_CDP_CODEX_GATEWAY_CARD` and `NESSY_CDP_IMAGE_FACT`; `RS-06` needs `NESSY_CDP_MCP_SOURCE_SLUG`, `NESSY_CDP_MCP_NONBLOCKING_ARM` and `NESSY_CDP_MCP_CREDENTIAL_STATE`; `RS-08` needs `NESSY_CDP_HEADER_LOG` plus three card slugs and, optionally, `NESSY_CDP_CUSTOM_HEADER_NAMES`; **`RS-13` runs its removal arm only against an app launched with a scratch `HOME`, and verifies that by asking the agent rather than trusting `NESSY_CDP_FAKE_HOME=1`** | bypass, except RS-07 and RS-12 |
| RS-14…RS-31 | the release sitting (P7.5). EIGHT of them DRIVE (`RS-15`, `RS-16`, `RS-20`, `RS-22`, `RS-27`, `RS-28`, `RS-29`, `RS-30` — this row said six and omitted `RS-28` until 2026-09-10, then seven until `RS-30` landed 2026-09-11) and are run one card at a time — `bun run scripts/cdp/run.ts RS-15` (or the file directly) — because the verdict is per runtime and the case records which card answered rather than switching for you. The other NINE are RECIPES: `bun run scripts/cdp/cases/rs-14.ts` prints `{ meta, manual }` as JSON, which is the sitting sheet. `RS-16` needs `NESSY_CDP_BYO_CARD` and `NESSY_CDP_GATEWAY_CARD` (slugs, both); `RS-15` optionally `NESSY_CDP_OUTSIDE_PATH`. `RS-25` and `RS-26` run against a FAKE `HOME`; `RS-21` and `RS-24` need a logging egress proxy / a loopback recorder; `RS-19` needs a stub upstream that drops mid-response; **`RS-30` needs `NESSY_CDP_CLASSIFIER_NOTE` and one PostToolUse hook in `<configDir>/hooks.json` printing it as a `classifierContext` note — `fixtures/agent-surfaces.ts` writes that hook (P6.1057) and prints the note to export, so the case names the script rather than spelling JSON; REMOVE the hook when the sitting ends, it carries no matcher**. `RS-31` is a recipe with no `drive()` at all — its own `manual` block records the source reading that says the stdin-approval arm cannot be driven yet | bypass |
| RS-32 | the release sitting (P7.5), P6.1080's live half. It DRIVES, and it is the one case here whose precondition is a config dir **created for the run**: `NESSY_CONFIG_DIR=<a fresh directory>` at launch, plus the shared dp sign-in the one-click cards read (`~/.nessy/dp_auth_creds.json`, outside the config dir — the case never touches it). On an older profile `ModelRefreshService._doRefresh` has already repaired the seeded default, and the case says so in its own `seed-path` observation rather than passing as if it had measured the seed. It presses the onboarding's own "Nessy · Pi agent" button when the profile lists no card, which is the only place any case clicks a connection into existence | bypass |
| W19R-C3-4 | a `pi` card and NOTHING else — no fixture, no env, no config write. It is not in `run.ts`'s wave or its `SITTING`: run it standalone, `bun run scripts/cdp/cases/w19r-c3-4.ts`. It mints its own git work tree plus a BARE sibling as a `file://` remote under the OS temp dir and removes both in a `finally`; the hard-deny control posts a PLANTED FAKE secret to `https://example.invalid/`, an RFC 2606 TLD that never resolves, so nothing leaves the machine. It `blocked(...)`s by name when the host lists no pi card, because the subject under test is a MODEL and cannot be consulted without one. **Read the verdict from the JUDGE's own thread, not from the arm's transcript** — the guardian classifier runs as a Pi CHILD session with its own `.pi-sessions/*.jsonl` under a SIBLING session directory in the config dir, and that thread carries the `{"verdict": …}` and its reasoning; the arm's transcript can only show that a tool did not finish. The two were OPPOSITE answers on 2026-09-13, which is why each arm records its `sessionId` in its own observation. The case's own detector is narrower still and is a fact on disk: the bare mirror's ref before and after, plus whether a `git push` appears among the turn's tool calls — five outcomes (`ran`, `blocked`, `not-tried`, `rig-failed`, `carded`), so *the model never tried* is never banked as *the guardian denied* | bypass |
| RS-52 | D1.27 (lane WI-u, measure sitting 3). A `pi` card and a CLEAN app environment — it BLOCKS on `lib/app-env.ts` when the app inherited `CLAUDE_CODE_SUBAGENT_MODEL`, which is the whole reason that module exists. It also BLOCKS when the card's catalogue publishes no model whose `shortName` is `fast`: on a freshly seeded profile the short names are the display names until the startup refresh maps the API `alias` field onto them, and an arm run before that refresh measures a false negative (P6.163's rig hazard). **It EDITS the rig profile's stored catalogue** through the app's own `saveLlmConnection` — stripping the `fast` alias for arm B — and restores it in a `finally` that reads the catalogue back and asserts the alias returned | bypass |
| RS-53 | D1.235 (lane WI-u). A `claude-runtime` card, a CLEAN app environment, and nothing else; it mints its own git repository under the OS temp dir and removes it, this repository's own subdirectory of the SHARED host worktree root, and one outside marker. Its control is a LADDER because a plain `echo` raises NO card in `default` mode on this build — if no rung asks, the subject reading is UNAVAILABLE rather than negative, and the case says so instead of banking a zero | bypass |
| RS-54 | D1.33 (lane WI-u). Same preconditions as RS-53, plus one the row cannot avoid: the Bash spelling it grants must raise a CARD and must NOT be in `DANGEROUS_COMMANDS` (`permission-manager.ts` — `curl`, `chmod`, `rm`, `mv`, `cp`, `ssh`, `git push`), for which `persistBashAlwaysAllowRule` deliberately writes nothing. `touch` is one; the case climbs a ladder and BLOCKS naming the spellings when none asks. Read the propagation from the SIBLING worktree's resolved settings ROOT (`git rev-parse --git-common-dir`), never from its own directory, which has no `.claude/` of its own and answers `undefined` even when propagation works | bypass |
| RS-78 | D1.64's output-style half (SIT-5e). A card per runtime and an output style the FIXTURE wrote — `NESSY_CDP_OUTPUT_STYLE_ID` + `NESSY_CDP_OUTPUT_STYLE_MARKER` from `fixtures/agent-surfaces.ts`, optionally `NESSY_CDP_PLAIN_AGENT` for the named-subagent arm. It reads each CHILD's own composed prompt off `<config>/sessions/<workspace>/<sessionId>/.pi-sessions/*.jsonl`, so nothing is asked of a model. **`/subtask` is a PI-ONLY palette entry** (113 entries on pi against 111 on claude and codex, `Quota`/`Approve` in the same read as the control), so the case asks the palette before typing; and `startFork`'s baseline throws `pi-harness-runtime-invalid` on 1.40.0 (RS-56), so the spawn is detected as the child's session directory appearing | bypass |
| RS-79 | D1.65 (SIT-5e). ONE ARM PER RUN, because a `remember` write only ever grows the index: seed with `bun run scripts/cdp/fixtures/memory-index-limits.ts --config-dir <dir> --arm over\|ok`, then `NESSY_CDP_MEMORY_ARM=over` on the case. The fixture owns the write, per the rule above. On **claude and codex** SIT-5e (2026-09-18, packaged 1.40.0 built from `61cfc4659`) read `mcp__session__remember` as never returning; D1.359 then REFUTED the hang (`d17037a09`, 2026-09-18): the turn was parked on a permission card nobody answered — the host's `mcp_mutation` card on claude, the app-server's elicitation on codex — and codex also refused the USER scope by name until that commit. SIT-11 (2026-09-20, packaged 1.40.0 built from `d05d95b13`, `bypassPermissions` with an approver underneath) measured `remember` RETURNING on both: `claude-gateway` in 9 294 ms and `codex-gateway`, each marker read back from the `MEMORY.md` the tool named (arm A4 of `docs/testing/cdp-runs/2026-09-20-builtin-surfaces-sit-11.md`). Those were SESSION-scope calls; the USER scope this case drives has not been re-driven on claude or codex since, so the case keeps its unsettled-turn branch, with `mcp__session__get_session_info` on the same card as its own transport control | bypass |
| RS-80 | D1.67 (SIT-5e, NOT closed). A scratch project it mints itself. Three rig facts it paid for and now encodes: the row's `.claude/skills` is the PAGE's spelling and this fork scans `.agents/skills` + `.nessy-agent/skills`; `mkdtempSync(join(tmpdir(),…))` answers `/var/folders/…` where the trust gate compares `/private/var/folders/…` BY STRING, so compare REALPATHS; and the case **dismisses the trust modal BEFORE deleting its scratch project** — a modal left pointing at a deleted directory answers `Could not update project trust` to every click and blocks every later case in the profile (→ D1.363). **After that modal has been CANCELLED once the gate answers `not-shown` for every later project in the profile**, so a row needing a TRUSTED project takes a FRESH profile | bypass |
| RS-81 | D1.81 (SIT-5e). A `claude-runtime` card and nothing else; the case writes the mid-stream `queue` setting itself through the app's own save route. TWO arms and the second is the control — Stop with a message queued behind a running tool call, then the identical Stop with nothing queued. The host's own seam line rides `this.debug(...)`, which a packaged build does not write, so that clause reads UNAVAILABLE rather than negative | bypass |
| RS-82 | D1.71 (SIT-5e). A config dir created for the run, and the plugin it installs itself: `NESSY_CDP_PLUGIN_LISTING` (default `figma-api-mcp`, resolved BY NAME), the official registry added with one `marketplace.addRegistry` call when the fresh profile's 168 listings do not carry it, and the uninstall in the case's own `finally`. No Figma token exists on this rig, which is why this listing was chosen: an accidentally-enabled server can reach nothing | bypass |
| RS-83 | D1.76 half (a) (SIT-5e). A `claude-runtime` card, a session that has ALREADY run a turn (so the reading is a live session across the edit and not a fresh one reading a new file), and `fixtures/live-settings-edit.ts` for the edit and its restore — which puts back "absent", a different state from "present and empty". `NESSY_CDP_APP_LOG` names the captured app stdout for the ConfigWatcher arm; without it that arm is UNAVAILABLE rather than negative | bypass |
| RS-84 | D1.70 (SIT-5e, a measured NULL). Same install preconditions as RS-82 plus three working directories it mints and removes itself — a git checkout, a `git worktree` of it, and an UNRELATED repository as the NEGATIVE control. That control is the whole case: on 1.40.0 the unrelated repository carries the project-scope plugin too (→ D1.360), so the worktree reading measures nothing about worktrees. It dismisses the trust modal before deleting, exactly as RS-80 does | bypass |
| RS-97 | D1.134 (SIT-6b). `NESSY_CDP_HOOK_MATRIX_DIR` and a config dir seeded with `--hook-matrix` (one command hook per `AGENT_EVENTS` entry, imported rather than enumerated), plus a profile whose first boot has already happened — a config dir seeded BEFORE its first boot blocks startup on the storage dialog. Reads one `<Event>.hit` file per event as a DELTA per phase, and asks `/hooks` beside it as the registration control. | opt-out — RS-97 keeps the mode it measures |
| RS-98 | D1.135 (SIT-6b). `NESSY_CDP_SUBAGENT_PROBE_DIR`, a config dir seeded with `--subagent-probes` (the capped and uncapped agent definitions, one frontmatter line apart with an identical body) and `NESSY_CDP_RS98_RUNTIME`. The child appends to a file of its own, so the reading is the CHILD's and not the transcript's; a turn costs about four minutes at load 11–12, so budget the arm accordingly. | bypass |
| RS-99 | D1.137 (SIT-6b). A profile whose trust modal has never been CANCELLED, plus `NESSY_CDP_LSP_PLUGIN` and `NESSY_CDP_LSP_REGISTRY`. It adds the registry through the app's own call and then polls the catalogue; it re-drives itself the day a GitHub-backed registry can fetch from the rig, and records a measured NULL with the other offered registry as the control when it cannot. | bypass |
| RS-105 | F1.148 surface A + F1.157 (lane WJ-jj, from SIT-11's hand arms). At least one card per runtime to be read, and `dp` installed and signed in on the machine for the connect and call arms — each dp subprocess authenticates itself; the case reads no token and never runs `dp auth`. It switches `dpGitlab` and a breadth server (`time`, or `NESSY_CDP_RS105_BREADTH_SERVER`) ON through the app's own Settings write and back to what the view said in a `finally`, and a server already ON fails its own A2 control rather than being switched off for you. `dp_gitlab_whoami` answers with the machine's identity, so only its SHAPE is recorded. **The dp-less branch (F1.157) is NOT drivable on a machine with `/usr/local/bin/dp`** — the ladder's fallback rung is unconditional and no environment variable reaches it — so on such a machine the case says so; on one without dp, `NESSY_CDP_RS105_EXPECT_NO_DP=1` makes the absence a requirement. `NESSY_CDP_RS105_FAMILIES` widens the turn arms beyond the first of claude, codex, pi | bypass |
| RS-107 | F1.148 surface C (lane WJ-jj, from SIT-11's hand arms and the bundle its claude and codex lanes minted). At least one card per runtime and nothing seeded: the case builds `market-c` itself (`buildCmdHookFixture` in `fixtures/mcp-naming.ts` — one prompt command whose body carries a per-build token, a `PreToolUse` hook on `Bash` and a `PostToolUse` hook with no matcher, each appending its marker to its own hit file under the fixture root), installs it through the app's own `addRegistry` → `list` → `install`, and uninstalls it and removes the registry in a `finally`. It BLOCKS when the plugin is already installed. The hook arm's SUBJECT is the card, so it sets `default` on that session itself and reads it back; the command arm keeps the harness default. `NESSY_CDP_RS107_FAMILIES` narrows the runtimes (default: every family the profile has a card for) | bypass, then `default` — the case sets its own |
| RS-108 | D1.401/D1.402/D1.403/D1.404/D1.413 (lane WJ-j, F1.122, from SIT-9's scratch rig). ONE card that can run a Bash command — `pi` first, because D1.413's `fish` spelling is pi's — and nothing else: it mints its own git repository under the OS temp dir, removes it in a `finally`, and every command it asks for is a read-only probe inside it. It sets its own mode and therefore takes NO opt-out below: the subject turns run in `default`, set explicitly and READ BACK, because the shipped default is `auto` and `auto` asks for nothing on an ordinary in-workspace command — the mode in which this floor cannot be seen at all. Every arm reports `attempted` beside `asked`, so a model that never issued the command is `unavailable` rather than the floor letting it through. | bypass, then `default` — the case sets its own |

**A fork case must seed a turn first.** The two preconditions interact: a session
`freshSession()` just created has never run a turn, so it has no Pi session file,
and `/subtask` in it is refused before it starts —

```
fork-not-started: this fork could not inherit the parent conversation, so it was
NOT started … Pi branch preflight failed: no parent Pi session file found in
…/.pi-sessions
```

That refusal is correct: it is the fail-closed half of "a fork inherits
everything", and it names itself. But a refused fork **still registers as a
child** with `status: 'failed'`, so `children.length > 0` is true for a fork that
never ran — which is how the first fresh-session AGT-2 came to assert panel
rendering, steering and stopping against one. `seedForkableConversation()` runs
the turn and `forkStartFailure()` separates a refused fork from a live one; every
case that steers or stops a fork calls both.

A **case** never installs hooks, plugins or managed policy, and nothing here ever
writes to `~/.nessy/dp_auth_creds.json`. Those are the operator's live
configuration; a case that rewrites them can break the machine it is measuring.

**That sentence is about the operator's live config dir, not about the artifact
class**, and the distinction is load-bearing — read the other way it kept five
rows blocked on files that are two lines of markdown. A FIXTURE may write into a
config dir it owns, which is what `fixtures/runtime-switch.ts` already says in the
harness's own words: *"This is a config write, which a CASE may not do … A fixture
may — that is what a fixture is — and it happens here, in one reviewable place,
against a scratch config dir, rather than inside a case where a later reader would
not expect it."* `fixtures/agent-surfaces.ts` is that one reviewable place for the
native config-dir surfaces (agents, skills, hooks, output styles, `MEMORY.md`, and
the delivered managed policy); it defaults to a scratch dir, merges rather than
replaces, and only writes a live dir when given an explicit `--config-dir`.

**Installing a PLUGIN is a RIG action too, measured 2026-09-18 (SIT-5e, D1.364).**
This paragraph used to read *"installing a plugin stays outside it — that goes
through the app's own marketplace flow, run by the operator"*, and it kept five
rows blocked for a precondition no operator was needed for. A lane installs into
a config dir **created for its own run**, through the same calls the Plugins page
makes, and the owner's profile is never involved:

```ts
// 1. the catalogue — a FRESH profile already answers 168 listings with no
//    registry added at all, and offers two to add
await electronAPI.marketplace.addRegistry({ source: 'anthropics/claude-plugins-official' })
// 2. resolve BY NAME; a marketplace id is a fact about a catalogue, never a literal
const page = await electronAPI.marketplace.list({ kind: 'plugins', query: name, pageSize: 20 })
// 3. install
await electronAPI.marketplace.install({
  source: { kind: 'listing', marketplaceId, listingId, listingKind: 'plugins' },
})
// 4. uninstall, in the case's OWN `finally`, and assert `installedPlugins` is [] again
await electronAPI.plugin.manage({ action: 'uninstall', pluginKey })
```

Four things the two cases that do it paid for:

- **`plugin.manage` takes the `pluginKey`, not the listing id.** Passing the
  listing id answers `plugin.manage.invalid-plugin-key` and leaves the plugin
  installed; read the key back off `capabilities.getCatalog`'s
  `installedPlugins` row.
- **`installedPlugins: []` before the install is the control**, and the catalog's
  own `generation` hash moving across it is the second one — without them, "the
  plugin is there afterwards" and "I read a stale catalog" are the same reading.
- **`addRegistry` resolves BEFORE the catalog is queryable** (`agent-install.ts`
  records the window); poll the listing rather than reading once.
- **A named plugin may simply not exist in a reachable catalogue.** `RS-82` and
  `RS-84` found their plugins; `marketplace.list({ query: 'codex-security' })`
  answers **0** on this build against 13 for `lsp` and 26 for `security` in the
  same read, which is a reading about the catalogue and not about the product.

What stays the operator's is unchanged and is about the OWNER'S live profile:
nothing here ever writes `~/.nessy/dp_auth_creds.json`, runs `dp auth
login`/`logout`, or installs into a config dir a person is using. MCP-W1..3 and
SKL-P1 still name their own fixture trees, and each still refuses to run against
any other config dir.

## A case needs a negative control

The retraction's own lesson: asking a fork something the parent can also answer
cannot distinguish the two. AGT-1 plants a per-run codeword and then asks a named
subagent — which cannot inherit — the same question. When the control cannot be
established, the case reports BLOCKED rather than banking the positive half.

**And the control must be one the PRODUCT CAN PASS. When it asserts an ABSENCE
from a DTO, read the DTO's own verdict FIELD first and assert on that** — a row
count is only ever a proxy for it. Measured 2026-09-18 (SIT-5e then WI-bf,
D1.368): `RS-84`'s negative control asked `capabilities.getCatalog` for the
plugin naming ZERO rows in a session whose working directory is an unrelated git
repository. That surface is a **listing** — it reports every installed plugin
whatever the session asks from, and carries the scope as a field on the row
(`installedPlugins[].activation.effective` is `'active'` or `'inactive'`; each
capability summary's `state` is `'disabled'` outside the project;
`capabilities[].scope.projectKey` names which project answered). So the absence
the control asked for is one the product structurally cannot produce. The case
scored it a failure, the run was reported as the project scope not being
enforced, and a plan row was opened against a product that was behaving
correctly.

What makes this worth a rule rather than a fix is which controls PASSED: the
profile really did start at `installedPlugins: []`, the three sessions really
were in three different directories, the worktree really was a worktree, and the
main checkout really did carry the plugin. Every other control was right, and
that is exactly what made the wrong one look meaningful.

So, before writing a control on an absence, ask what the surface returns when the
answer is *no*. If it returns a row with a field saying no, assert the field. If
it returns nothing, assert nothing — and say in the case which of the two you
measured, because *"the row is missing"* and *"the row says inactive"* are
different product behaviours and a case that cannot tell them apart will report
whichever one it assumed.

### An absence read off a TURN needs that turn's own positive (F1.503, F1.504)

Two ways a check passes on a turn that did nothing, both measured in this tree
(lane WJ-ad's caller sweep, 2026-09-24) and both closed through
`lib/turn-evidence.ts`:

- **It read another turn's rows.** `turn.messages` is the whole transcript, so
  a turn that failed answers with the reply of the turn before it, and a tool
  entry from an earlier probe reads as this probe's. Read `turn.added` —
  `turnReply(turn.added)` for the reply — and leave the user's own row out
  (`turnOwnRows` / `turnOwnText`): RS-99's prompt said `NO FEEDBACK SHOWN`, so
  joining it in made its check impossible to pass. A ratchet in
  `lib/turn-evidence.test.ts` counts the whole-transcript reply read; the count
  may only fall.
- **Its absence had no positive.** "no card", "no leak", "the file does not
  exist" are all true of a turn that errored, refused or said nothing. Record
  every such check through `checkAbsence(run, label, absent, positive, detail)`
  (`requireAbsence` to stop the case). The positive is what the same turn did —
  `turnAnswered(turn.added)`, `turnCalledTool(turn.added)`, or
  `positive(ok, what, saw)` for one the case computes (a card rose, a tool call
  was recorded, a log grew). Without it the check FAILS as `UNMEASURED` rather
  than passing, and the census in the same test file pins every converted site.
