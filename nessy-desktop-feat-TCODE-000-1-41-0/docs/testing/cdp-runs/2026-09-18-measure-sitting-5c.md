# 2026-09-18 — measure sitting 5c (WAVE I-7, lane SIT-5c) on the packaged 1.40.0, CLEAN environment

The TAIL of the `measure:` list — the rows the fourth sitting and its siblings did not reach, from `D1.55`
onward. Two sibling sitting lanes ran at the same time on their own ports and their own config dirs
(SIT-5a on 9232–9241, SIT-5b on 9242–9251); this lane owns **9252–9261** and checklist ids **RS-71…RS-78**.

**Build under test.** `release/mac-arm64/Nessy Desktop.app`, **1.40.0** (`CFBundleShortVersionString` reads
`1.40.0`; the CDP user agent reads `NessyDesktop/1.40.0 … Electron/39.2.7`), built by the controller from
`61cfc4659`. Never rebuilt, never removed.

**Rig.** Port **9252**; `NESSY_CONFIG_DIR` and `--user-data-dir` under this lane's scratchpad, created for the
run and never under `~`. The owner's profile was never launched; `dp auth login` / `logout` were never run; no
token was read, printed or committed. `NESSY_DEBUG=1` and `NESSY_PROXY_AUTH_DEBUG=1` on every launch. Every
launch used the `env -u` launcher from `scripts/cdp/README.md`, with all thirteen names deleted.

**The rig precondition.** `RS-32` **PASS 8/8**, 28 202 ms at load 10.77 — the one-click Pi card seeding
`tgpt/deepseek-v4-flash-0731` (the `coder` alias), its first turn answering `ready`, and the retired-id control
showing the host substituting the live id before the call with 0 info rows. The codex and claude gateway cards
were then created by pressing the product's own one-click buttons, off-case.

---

## 0. The clean-environment control, printed once per run

The derivation re-run at HEAD in its boundary-aware form, never a copied list:

```sh
env | cut -d= -f1 | grep -E '^(CLAUDE|ANTHROPIC|NESSY|CODEX|PI|OTEL|DISABLE|MAX_|BASH_|MCP)' | sort |
  while read -r n; do
    c=$(git grep -aclP "(?<![A-Za-z0-9_])$n(?![A-Za-z0-9_])" -- packages apps | wc -l)
    [ "$c" != 0 ] && echo "$n -> $c file(s)"
  done
```

**Thirteen** names over a 31-name candidate set, membership and counts identical to sitting 4's:
`ANTHROPIC_BASE_URL` 51, `CLAUDE_EFFORT` 19, `CLAUDE_CODE_DISABLE_CRON` 12, `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`
11, `CLAUDE_CODE_SUBAGENT_MODEL` 10, `DISABLE_AUTOUPDATER` 5, `CLAUDE_CODE_EXECPATH` 4, `CLAUDE_CODE_OAUTH_SCOPES`
2, `CLAUDECODE` 2, `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` 1, `CLAUDE_CODE_MESSAGING_SOCKET` 1,
`CLAUDE_CODE_MESSAGING_TOKEN` 1, `MCP_CONNECTION_NONBLOCKING` 1 (the entry `app-env.ts` records at `files: 0`
and deliberately does not block on).

**The app's own read-back**, through `ps eww` on the RUNNING app: `{"pids":12,"present":{},"controlSeen":true}`
— clean, with `NESSY_CONFIG_DIR` seen in the same read as the positive control. Scoped to this lane's own four
pids the same read answers `{"pids":4,"present":{},"controlSeen":true}`.

**A rig fact THREE concurrent sittings created, and it is worth carrying.** `appProcessPids()`
(`scripts/cdp/lib/app-env.ts`) enumerates with `pgrep -f "MacOS/Nessy Desktop"`, which on this machine matched
**twelve** processes — three lanes' apps, four each — not this lane's four. The read was clean, so nothing was
mis-scored; but a SIBLING lane launching dirty would have blocked THIS lane's cases with a sentence naming this
lane's rig. The instrument is right for a one-sitting machine and over-wide for a three-sitting one.

---

## 1. D1.78 — the per-session runtime diagnostic, on all three runtimes in one profile (case `RS-71`, **PASS 14/14**, 84 067 ms, load 9.82)

### The premise has moved, and the row says so itself

D1.78 is *"there is no per-session, domain-filtered debug log on any runtime, and the one absence claim in the
record is already false"*; its source row P6.448 carried pi `unknown`, claude `unknown`, codex `partial` and an
explicit MEASURE-FIRST instruction. Since it was written the host grew `packages/shared/src/agent/session-debug-log.ts`
(C3.215 for the claude arm, C3.274 for the Pi arm), whose own type names the runtimes it serves —
`SessionDebugLogRuntime = 'claude' | 'pi'` — and whose naming rule is
`<config dir>/logs/runtime/<host session id>-<runtime>.txt`. **That module is a claim in the source tree. This
is the reading on the artefact**, which is what a `measure:` row is for.

### One profile, three sessions, one plain turn each, then ONE directory read

| runtime | card | path found | bytes | lines | distinct domain tags |
| --- | --- | --- | --- | --- | --- |
| pi | `pi-api-key` | `logs/runtime/2129d56e-…-pi.txt` | 4 412 | 12 | `interceptor-hint`, `nestor-proxy`, `nestor-reasoning-proxy`, `pi-server` |
| claude | `claude-gateway` | `logs/runtime/37d896f6-…-claude.txt` | 36 255 | 238 | `auto-mode`, `claudeai-mcp`, `init`, `print`, `session-notices`, `uds-messaging` |
| codex | `codex-gateway` | **none** | 0 | 0 | — |

All three turns answered, which each arm records beside its file reading: a turn that never reached the runtime
would produce no diagnostic for a reason that is not the subject.

**So D1.78's premise is REFUTED on two of three runtimes and CONFIRMED on the third**, and the claude file is
the stronger half: it is the vendored binary's own log, at a path this product chose, carrying `[DEBUG]`-level
lines with six domain tags — which is M17's *"per session, filterable by domain"* in everything but the argv
filter itself.

### The control, and why the three arms are one case

The codex absence is scored in the SAME directory, in the same run, by the SAME reader that found the other
two files by name. Without that, *"codex writes none"* and *"this case read the wrong path"* are one reading —
which is the failure mode the row's own `done_means` asks to be protected against. A control measured in a
different run on a different profile is not a control, so the three arms cannot be split into three cases.

### The posture, stated rather than driven

Both host arms are written only while the host is in debug mode — `openSessionRuntimeDebugLog` returns
`undefined` for `hostDebug === false`, and `applySessionDiagnosticLog` returns early unless
`NESSY_DEBUG === '1'`. Every sitting rig launches with `NESSY_DEBUG=1`, so what is measured here is the
**debug-mode** reading. The negative arm — the same three turns on an app launched without it — is a second
launch and is left to a sitting that has one; the observation carries the switch rather than implying it was
absent.

### One thing nobody was looking for: the vendor writes a `latest` SYMLINK into the host's directory

`logs/runtime/latest` is a symlink to the claude session's own file, written by the vendored binary beside the
file the host pointed it at. It is not a defect and it is genuinely useful — the most recent claude session's
diagnostic is addressable by a fixed name — but it is a NON-per-session entry in a directory whose every other
name carries a session id, and a reader that assumes the naming rule holds for everything there will
double-count the last claude session. Recorded so the next reader is not surprised by it.

### What this reading does NOT say

* It does not say codex CANNOT have one. P6.448's own evidence names codex's `log_dir` (config) and `RUST_LOG`
  (env, inherited for free because the spawn spreads `process.env`), and its PRECONDITION clause — check Dev-11,
  which rules `$CODEX_HOME` session artifacts out as deliberate — is unchanged by this run. What is measured is
  that the shipped 1.40.0 writes no per-session codex diagnostic into the host's own directory.
* It does not score the argv domain FILTER (`--debug=mcp`). `session-debug-log.ts` states in its own words that
  the filter has no environment twin and is deliberately not passed; asserting its absence would be asserting a
  decision rather than measuring a behaviour.

---

## 2. D1.60 — the six prompt-caching off switches, read off the SHIPPED claude child (case `RS-72`, **PASS 12/12**, 81 212 ms, load 11.14)

### What was already settled, and what was not

D1.60's hermetic half is shipped: `CLAUDE_PROMPT_CACHING_OFF_ENV_KEYS` is a declared constant and C3.160's suite
(`agent/__tests__/claude-child-prompt-caching-switches.test.ts`) pins that the six are forwarded verbatim and
enumerably, that the host invents none of them, and that none is in the strip union. **Every one of those
assertions is against `buildClaudeSubprocessEnv()` — a function call in a test process.** The row's own rig asks
for something else: *"export each of the six names before a claude turn on a PACKAGED build"*. Between that
function and the child there is a packaged main process and an Electron spawn, and nothing in this repo had read
the child's own environment on the artefact.

### The plant, and the child

The app was relaunched with the `env -u` launcher plus a plant: the six `DISABLE_PROMPT_CACHING*` names,
`NESSY_CDP_D160_CONTROL` (a name with no reader anywhere) and `CLAUDE_CODE_USE_BEDROCK` (a name in
`CLAUDE_SDK_STRIPPED_ENV_KEYS`). One claude turn, then `ps eww` on the claude child — found by its binary path
**and** by `NESSY_CONFIG_DIR=<this rig>` in its own environment, because an unfiltered `pgrep` on this machine
matched four other lanes' children.

| read | verdict |
| --- | --- |
| `NESSY_CDP_D160_CONTROL` — the POSITIVE control | **present** in the child's 113 names |
| `CLAUDE_CODE_USE_BEDROCK` — the NEGATIVE control | **absent** — the shipped strip list really runs |
| the six `DISABLE_PROMPT_CACHING*` names | **all six present** |

The negative control is what makes this a discrimination rather than *"this child inherits the whole shell"*.
And the shell it inherits is wide: the same read shows `CONTAINER_REGISTRY_TOKEN`, `JUMP_YARN_REGISTRY_TOKEN`,
`PACKAGE_REGISTRY_TOKEN`, `UIKIT_REGISTRY_TOKEN`, `BAGGAGE`, `USE_LOCAL_OAUTH` and `USE_STAGING_OAUTH` — names
from the launching shell that nothing in this product declares — arriving in the claude child verbatim. Names and
value LENGTHS only were read; no value was printed, because the same environment carries `ANTHROPIC_API_KEY` and
`CLAUDE_CODE_OAUTH_TOKEN`.

**So D1.60's ambient-reachability clause is CONFIRMED on the artefact**, with both controls, where it had only
ever been confirmed on a function.

### The BITE clause is a NULL, and a second runtime is what makes it an honest one

`done_means` wants a bite/no-bite verdict per name from cache read/write tokens. The app already keeps them:
`tokenUsage.cacheReadTokens`, `.cacheCreationTokens` and a `cache.warmth`, in the same `getSessions()` read the
session list renders. On the claude card they read **0 / 0 / `warmth: unknown`** — both with the switches planted
and, an hour earlier on the clean launch, without them (RS-71's claude session: the same three zeros).

A zero there is two different findings, and the separator is a second runtime on the SAME gateway model in the
same profile in the same run:

| arm | cacheReadTokens | cacheCreationTokens | warmth | costReporting |
| --- | --- | --- | --- | --- |
| claude, `claude-gateway`, switches planted | 0 | 0 | `unknown` | `reported` |
| claude, `claude-gateway`, clean launch (RS-71) | 0 | 0 | `unknown` | `reported` |
| **pi, `pi-api-key`, same model, same profile** | **8 192** | 0 | **`warm`** | `unsupported` |

**The gateway publishes cached-token accounting and the claude path does not surface it.** So the bite clause
cannot be scored off the app's own usage on this card — the claude reading is the same zero whether the switches
are set or not, which is a statement about the usage mapping and not about the switches. **D1.60's bite clause
stays a NULL, with this control naming why**, and the re-take needs either a card whose claude path reports cache
tokens or the loopback capture the row's rig names. Recorded as proposed row **P-5c-1**.

---

## 3. D1.63 — no output-token figure reaches the renderer mid-turn, on ANY of the three (case `RS-73`, **FAIL 15 of 18**, 145 015 ms, load ~10.5 — and the three FAILs are the product)

### The first spelling of this case was WRONG, and its own control is what said so

The overlay renders `session.tokenUsage.outputTokens` (`ChatDisplay.tsx`, under the `usage.outputTokens` label), so
the obvious probe is to poll `getSessions()` for that field. **Driven, it scored three flat lines**: over 17, 19 and
24 in-turn samples on claude, Pi and codex the field was ABSENT every time and present only after the turn ended.
The case stopped at its own positive control — *"claude's counter advances mid-turn, so this poll CAN see an
advance"* — rather than reporting three product absences, and that is the whole value of having written the control
first. `atoms/sessions.ts` says why in its own words: *"tokenUsage is only returned by getSession() (not
getSessions())"* — and the packaged preload publishes no `getSession` at all.

**The renderer gets it from the event channel.** The case was rewritten to subscribe to
`window.electronAPI.onSessionEvent` before submitting and to read what actually arrives.

### One profile, three cards, a long turn and a short turn each

| arm | events | `text_delta` (the POSITIVE control) | output-token frames BEFORE `complete` | `usage_update` fields | `complete` outputTokens |
| --- | --- | --- | --- | --- | --- |
| claude, long | 79 | **71** | **0** | `contextWindow`, `inputTokens` | 680 |
| claude, short | 8 | 1 | 0 | `contextWindow`, `inputTokens` | 3 |
| pi, long | 36 | **25** | **0** | `contextUsage`, `contextWindow`, `inputTokens` | 404 |
| pi, short | 12 | 1 | 0 | same | 2 |
| codex, long | 23 | **11** | **0** | *(no `usage_update` at all)* | 440 |
| codex, short | 12 | 1 | 0 | *(none)* | 3 |

**The positive control is green on every arm** — 71, 25 and 11 `text_delta` events on the long turns — so the
listener fired, the channel is live, and something really does advance mid-turn. What does not advance is the
output-token figure: **it arrives exactly once, with `complete`, on all three runtimes.**

The mid-turn `usage_update` frame is the trap this case names in its own `doNotConflate`: it exists on claude and
Pi and carries `inputTokens` and `contextWindow` only. Counting `usage_update` events would have reported a live
output counter that is not there. Codex sends no `usage_update` at all.

### What this says about the row, and about the ledger

D1.63 asks for the Pi and codex cells. Both are **no live output counter**, measured, with the control. And the
reading reaches further than the row's ask: **the claude cell, which the ledger scores `have`, does not reproduce
on this card.** That verdict rests on `includePartialMessages: true` and an adapter reading
`message_delta.usage` — source evidence that this run does not contradict, because what is measured here is the
last hop: whether the figure reaches the renderer. On the three gateway cards it does not.

**Scope, stated rather than implied:** all three arms run on GATEWAY cards, so the claude arm is claude through
the loopback adapter and not claude against a first-party Anthropic upstream. A different upstream is a different
reading. Recorded as proposed row **P-5c-2**.

---

## 4. D1.61 — the claude arm's mini tier resolves to the gateway's SMALL model, and the keyword rule would have inverted (case `RS-74`, **PASS 7/7**, 22 603 ms, load 10.65)

### The row's premise, and the two moves it has not been read against

D1.61 is *"the claude arm's mini model falls to a gateway id matching no small-class keyword"*, and P6.380 names
the failure it feared verbatim: *"the most expensive model in each list, on every background task."* Two things
have moved in the source since, neither read on an artefact until now: `resolveLocalAdapterMiniModel` asks
`resolveGatewayFastModelId` — the gateway's own `fast` ALIAS — **before** any keyword search, and the docblock
beside it already records the row's sentence as refuted (W12-f, 2026-09-11).

### The detector is the child's own environment

`ANTHROPIC_DEFAULT_HAIKU_MODEL` is what this fork writes the resolved mini into, and it is the SDK's own variable
for the tier its built-in tools (title generation, WebFetch summarisation) run on. Four model-id variables were
extracted from the claude child the packaged app spawned — scoped to this app instance by the `NESSY_CONFIG_DIR`
in the same environment — and nothing else from it.

| variable | value |
| --- | --- |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` (the mini tier) | **`tgpt/qwen36-35b-a3b-fp8`** — the gateway's `fast` alias, 262 000 ctx |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `tgpt/deepseek-v4-flash-0731` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `tgpt/deepseek-v4-flash-0731` |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` | `tgpt/deepseek-v4-flash-0731` |

**So the row's feared outcome did NOT ship.** The mini tier resolves to the SMALLER of the card's two models, and
the two controls make that readable: the resolved id is a member of the card's own catalogue (the SDK's built-in
default for this tier is a Haiku id no gateway serves, so a value outside the catalogue would have been the
unresolved case), and it is NOT the card's default model.

`miniModel` is unset on every one-click gateway card in this profile (`config.json`), so the value is computed at
spawn time and only the spawned child carries it — which is why the child's environment is the detector and the
stored connection is not.

### The keyword rule inverts on this catalogue, and that is the finding worth carrying

`isSmallClassModelId` matches `/haiku|mini|nano|flash|lite|small|sonnet|luna/i`. Over this card's two ids:

| id | matches small-class? | what it actually is |
| --- | --- | --- |
| `tgpt/qwen36-35b-a3b-fp8` | **no** | the `fast` alias — the small model |
| `tgpt/deepseek-v4-flash-0731` | **yes** (`flash`) | the `coder` alias — the 524 000-token flagship |

A resolver using keywords alone would pick the LARGER model on this catalogue. **The shipped answer is right
because of the ALIAS resolver, not because of the keyword list** — which is the same reading the source docblock
records, now taken on the artefact.

### What this does not claim

It reads the id the HOST resolved and handed over, not the model named on the upstream REQUEST — that needs the
loopback capture the row's own rig names, and the verdict says so rather than glossing it. The Opus-rate-warning
half of D1.61 is a guard on a host-side warning and is untouched here.

---

## 5. D1.62 — the gateway catalogue is one host-side fetch fanned out to all three, and carries no origin field (a READING, not a case)

### Why a reading and not a case file

D1.62's rendered half — a per-entry provenance MARK in the two model pickers — is `RS-58`'s subject in the sibling
lane SIT-5a (row D1.162, the same ledger cell K34), and a second case driving the same pickers in the same hour on
the same artefact would be two readings of one surface rather than two measurements. What is recorded here is the
half that row does not touch and that D1.62 asks for in its own words: *"the picker's entries match
`fetchNestorModels`' answer"* and *"whether any entry is labelled with its origin"*.

### The detector is the file the refresh itself writes

`<config dir>/config.json`, after the startup refresh landed on a profile created for this run:

| card | providerType | `catalogueRefreshedAt` | ids |
| --- | --- | --- | --- |
| `pi-api-key` | `pi_compat` | 1789719236826 | `tgpt/qwen36-35b-a3b-fp8`, `tgpt/deepseek-v4-flash-0731` |
| `claude-gateway` | `claude-runtime` | 1789719236849 | the same two, in the same order |
| `codex-gateway` | `codex-runtime` | 1789719236865 | the same two, in the same order |

**Three runtimes, one list, inside a 39 ms window** — with identical `name`, `shortName` (`fast` / `coder`) and
the gateway's own Russian `description` on every entry. That is one host-side fetch fanned out, not three
runtimes discovering their own catalogues, which is exactly what P6.381's native-mechanism clause describes
(*"The SDK's NATIVE discovery exists and is dead-lettered … We supply the list host-side per runtime instead"*).

**`catalogueRefreshedAt` is the control** for the second half: it proves a refresh really happened on each card,
so the absence below is an absence in a catalogue that was fetched rather than in one that never arrived.

### No entry carries an origin

No model entry on any of the three cards carries a `provenance`, `origin`, `source` or `catalogueListed` field —
the only per-entry text is the gateway's own `name` and `description`, which name the ALIAS (`fast`, `coder`),
never where the list came from. The page's *"Discovered models appear as additional /model entries labeled From
gateway"* has no counterpart in what this build stores.

So D1.62's two clauses both hold on the artefact: **supplied host-side on all three, with no provenance label**,
and the switch verdict it asks for is that the capability is delivered identically on all three — which is the
one shape that is NOT a divergence.

**Hand-back note:** whether the RENDERED pickers show a per-entry mark is `RS-58`'s reading, taken by SIT-5a in
the same sitting. The controller should read the two together before stamping K34.

---

## 6. D1.56 — a failing command does NOT cancel its batch, on any of the three (case `RS-75`, **PASS 12/12**, 104 064 ms, load 10.7)

### The rig the row asks for, driven

One session per runtime family, two turns each: the SUBJECT asks for two shell commands as a single parallel
batch with the first exiting non-zero (`echo FIRST-RAN && exit 7`, then `echo SIBLING-OK`), the CONTROL asks for
the same two with the first succeeding. The detector is the string `SIBLING-OK` in a tool RESULT among the turn's
own added messages — a marker only the second command can produce, in a record the app itself writes — never the
presence of a second tool CALL (a cancelled call leaves a row too) and never the model's prose.

| runtime | arm | tool calls | statuses | `FIRST-RAN` in a result | `SIBLING-OK` in a result |
| --- | --- | --- | --- | --- | --- |
| pi | subject | 2 | `error`, `completed` | yes | **yes** |
| pi | control | 2 | `completed`, `completed` | yes | yes |
| claude | subject | 2 | `error`, `completed` | yes | **yes** |
| claude | control | 2 | `completed`, `completed` | yes | yes |
| codex | subject | 2 | `completed`, `error` | yes | **yes** |
| codex | control | 2 | `completed`, `completed` | yes | yes |

**All three runtimes really batched** — two tool calls in the subject turn on each — and on all three the sibling
ran and returned. **So D1.56's answer is the same on pi, claude and codex: a non-zero exit in a parallel batch
does not cancel the rest of it, and there is no switch-visible difference to record.**

Two readings worth keeping beside that:

* **codex ordered the batch the other way round** (`completed`, `error`), which is the model's choice of order and
  not the host's. The marker-based detector is indifferent to it — which is why it is a marker and not an index.
* **no permission card was raised on any arm** (`approvalsAnswered: 0` in all six), with an approver running
  underneath the whole case. That is consistent with sitting 4's rule that *"Bash on Pi asks"* is too strong: two
  `echo` commands ask on none of the three.

### What the case refuses to score

An arm producing ONE tool call is recorded `not-batched` and is deliberately not scored as a cancellation — the
case cannot force a model to emit two calls in one message, and every arm here happened to batch. The control is
what makes the subject readable at all: without it, *"the failure cancelled the sibling"* and *"this model does
not run echo commands"* would be one reading.

---

## 7. D1.57 — Pi REFUSES to overwrite an unread file; claude and codex do it (case `RS-76`, **FAIL 11 of 12**, 113 626 ms — and the one FAIL is Pi being STRICTER)

### The row's premise is a source absence, and the behaviour refutes it

D1.57's evidence is a tracked-source absence taken at `34be43fde`:
`readBeforeWrite|hasBeenRead|read the file first|mustReadBefore` scores **zero** over `packages apps`, plus two
widened searches. Re-run at HEAD, all four still score zero. **And the behaviour exists anyway.**

### One scratch workspace, one seeded file, one turn per runtime

The case mints a workspace under the OS temp dir with `subject.txt` carrying a marker it wrote itself, binds a
fresh session per family to that directory, and asks in one turn for the file to be REPLACED without reading it
first, plus a new `control-new.txt` created beside it.

| runtime | classification | tools, in order | seeded marker gone | replacement on disk | control file created |
| --- | --- | --- | --- | --- | --- |
| **pi** | **`refused`** | `Write` (error), `Write` (completed) | no | no | **yes** |
| claude | `wrote-blind` | `Write`, `Write` | yes | yes | yes |
| codex | `wrote-blind` | `Bash`, `Bash` | yes | yes | yes |

**Pi's refusal, verbatim from the tool result:**

> `…/subject.txt exists and has not been read in this session. Read it first, then write to it — an overwrite of a
> file nobody looked at destroys content the conversation never saw.`

The writer is `packages/shared/src/agent/local-tools/runtime.ts` (the sentence is built there; every other
occurrence in the tree is a test asserting it). The row's four needles cannot find it because none of them is how
it is spelled — the rule is phrased as a MESSAGE, not as an identifier. **So the source-absence premise is not
wrong about the tree; it is wrong about the behaviour, which is exactly what a `measure:` row is for.**

### The control, and why the Pi arm is readable

`control-new.txt` was created by the same turn on **all three** runtimes, so the workspace was writable, the write
tool was reachable and each session was bound where the case thought it was. Without that, Pi's untouched subject
file would be indistinguishable from a rig that could not write at all.

The case also separates *complied* from *stopped*: an arm whose tool order shows a READ of the subject path before
the first write of it is recorded `read-then-wrote` and is NOT scored as a rule. No arm here needed that branch —
claude and codex wrote with no read in front.

### The finding: a switch-visible divergence on a SAFETY rule

The same write is **refused on Pi and performed on claude and codex**, in one profile, in one run, on one
directory. The rule is host-side and reaches only the arm that goes through `LocalToolRuntime`; the claude and
codex arms use their runtimes' own file tools and never meet it. Recorded as proposed row **P-5c-3**.

### The row's second behaviour is owed, not approximated

*"Writing to a network or cloud-synced path"* needs a network mount or a cloud-synced directory. This machine has
neither and a case may not create one; approximating it with a local path would measure nothing the arm above does
not. Recorded as owed with that reason.

---

## 8. D1.76(b) — the config-directory selector, read off the three children (a READING, not a case)

D1.76 has two halves. **(a)** — edit a settings file with a session LIVE and record per runtime what takes effect
without a restart — is not driven here and is recorded as owed. **(b)** is answered by this sitting's own rig plus
three process reads, and is recorded because the row asks for exactly it:

> *"Point `NESSY_CONFIG_DIR` at an empty folder before bun starts … and confirm a session loads nothing from the
> usual setup on all three; record that the DOCUMENTED spelling `CLAUDE_CONFIG_DIR` is deliberately overridden per
> Workspace and has no codex counterpart, so the documented recipe does not work here."*

**The empty folder.** Every launch in this sitting exported `NESSY_CONFIG_DIR` at a directory created for the run,
before the app started. On the first probe the profile answered `listLlmConnections() → []` and the app was on its
own onboarding screen: no connection, no agent, no skill, no hook from the operator's real profile. All three
cards had to be created by pressing the product's own one-click buttons. **So a session loads nothing from the
usual setup on any of the three runtimes**, and the selector really is `NESSY_CONFIG_DIR` — not the documented
spelling.

**What each child was actually given**, read with `ps eww` and scoped to this app instance:

| runtime | the variable | the value |
| --- | --- | --- |
| claude | `CLAUDE_CONFIG_DIR` | `<config dir>/workspaces/<workspaceId>/claude-config` — **per WORKSPACE**, inside the rig's own config dir |
| claude | `CLAUDE_JOB_DIR` | `<config dir>/sessions/<workspaceId>/<sessionId>/job` — per SESSION, six distinct values across six sessions |
| codex | `CODEX_HOME` | `/var/folders/…/T/nessy-codex-home-<random>` — a per-SESSION `mkdtemp` under the OS temp dir, six distinct values |
| pi | *(none of this shape)* | the Pi subprocess takes the config dir itself; no second selector |

**So the row's clause holds on the artefact, and the codex half is stronger than "no counterpart":** codex does
have a home variable, and the host mints a NEW one per session under the OS temp dir. An operator cannot point it
anywhere, and whatever lands in it does not survive the session — which is the same posture Dev-11 rules
deliberate for `$CODEX_HOME` session artifacts. The documented `CLAUDE_CONFIG_DIR` recipe cannot work here for the
opposite reason: the host writes that variable itself, per workspace, and an operator value would be overwritten.

**The control** is in the same read: every one of those children also carries `NESSY_CONFIG_DIR=<this rig>`, so a
read that saw nothing would have been visible as a read that saw nothing.

---

## 9. D1.79 — the hook-input capture route, and the ladder that shows it cannot be used on this build (a READING, plus one product finding)

### What the row asks first

D1.79 is *"nothing ties a hook trace, an export record and a transcript line back to one prompt"*, and its source
row P6.460 carries a MEASURE-FIRST clause: *"Measure whether `prompt_id` reaches our hook input on each runtime
first: if it does, this is a documentation row; if not, one host field unlocks M1's correlation."* Answering it
needs the hook's own INPUT — the JSON the host writes to a command hook's stdin — and no existing fixture records
it (`agent-surfaces.ts`'s hooks `echo` a marker AT the model).

A fixture was written for exactly that (`scripts/cdp/fixtures/prompt-correlation.ts`), and driving it produced a
product finding instead of a row answer.

### The ladder — one Pi gateway card, a fresh session per rung, the control first AND last

| rung | `UserPromptSubmit` hook command | turn | capture file |
| --- | --- | --- | --- |
| A (control) | *(no hook)* | **12 040 ms, answered** | — |
| B | `true` | 7 411 ms, answered | — |
| C | `echo <marker>` | 7 451 ms, answered | — |
| D | `cat > /dev/null` | 6 021 ms, answered | — |
| E | `cat` (stdin → STDOUT) | 11 087 ms, answered | — |
| **F** | **`cat >> <path>`** | **TIMEOUT — 60 s, and 121 s on a re-run** | **never created** |
| D again, run immediately AFTER F | `cat > /dev/null` | **6 021 ms, answered** | — |

**A `UserPromptSubmit` command hook that redirects its stdin to a FILE hangs the turn indefinitely, and the file
is never created.** The controls are what make that readable:

* rung A, with no hook at all, answers — so the rig and the card are fine;
* rungs B, C, D and E all answer, so it is not "any hook blocks";
* **rung D re-run immediately after F answers in 6 s** — so the hang is not sticky and the app has not wedged
  itself;
* the path makes no difference: the config dir and `/private/tmp` both hang, so it is not a denied-path floor;
* and both spellings run in milliseconds under a plain `sh -c` with the same stdin, so the command is not
  malformed. `>>` opens its target BEFORE the command runs, so whatever fails, it fails before the shell gets
  that far.

Recorded as proposed row **P-5c-4**. A user-visible consequence: a hook of this shape wedges every turn in that
profile with no error message — the silent-hang signature sitting 4 named.

### And the surviving route writes where nobody can read

Rung E (`cat`, stdin to stdout) completes, and the payload reaches **no readable surface**: `hook_event_name` and
`UserPromptSubmit` both score **0** over the transcript, the app's own captured output and the Pi runtime session
log, in the same run that the hook demonstrably ran (the turn answered under the hook, and rung C's `echo`
proves a hook's stdout is delivered somewhere).

**So D1.79's measure-first clause is NOT answerable by a capture hook on this build** — the one shape that could
record the payload is the one shape that hangs the turn, and the shape that survives writes somewhere no reader
reaches. The row keeps its NULL, with that as the reason, and the fixture is committed carrying the ladder in its
own header so the next lane does not re-derive it.

---

## 10. The rows NOT driven, each with the reason and the premise re-taken

One line per row, in id order. A reason is a READING wherever this sitting took one; where it is a precondition
the operator owns, it says which one. Nothing here is a guess about the product.

| row | subject, short | why not driven in this sitting |
| --- | --- | --- |
| D1.55 | MCP tool auto-backgrounds after two minutes | **Cheaper than the row thinks, and still an operator step.** The threshold is an ENV knob the subprocess reads — `NESSY_MCP_AUTO_BACKGROUND_MS` (`config/background-task-settings.ts` `mcpAutoBackgroundDelayMs`; `0` turns it off, a malformed value falls back to 120 000) — so no rebuild is needed, only a launch. What is missing is an MCP server with a tool that sleeps past the threshold, and installing one goes through the app's own marketplace flow, which the harness reserves for the operator. Record the knob in the row: it takes the next attempt from "rebuild pi-agent-server" to "relaunch with one variable". |
| D1.58 | does the shipped claude binary honour `ultrathink` | **Measured absence of a readable surface.** The thinking budget sent is only visible off the loopback adapter, which this rig does not capture, and the claude per-session diagnostic — 238 lines, six domain tags, proven readable in §1 — scores **0** for `thinking`, `budget_tokens`, `ultrathink`, `maxThinkingTokens` and `interleaved`. So the row needs the loopback capture its own rig names; nothing on the artefact substitutes for it. |
| D1.64 | claude arms of output-style inheritance and the prompt-cache environment block | **The L48 arm has no subject on this card, and §2 is the measurement that says so.** Its observable is "a shared prompt-cache read on the second session"; the claude path reports `cacheReadTokens: 0` / `warmth: unknown` on this gateway card whatever happens, while a Pi session on the same model reports 8 192. The output-style half is drivable and was not reached. |
| D1.65 | memory-index over-limit and near-limit write notices | Not reached. Needs `MEMORY.md` seeded past the 200-line / 25 KB limit (a config write, so a fixture) plus a model that actually uses the memory tool on each runtime; the codex arm is the one that can fail and it is the one that needs the most setup. |
| D1.66 | user-invocable skill dispatch when the model-invocation list omits it | Not reached. Needs two skill fixtures (with and without the flag) and a MALFORMED entry, on claude and codex. `fixtures/agent-surfaces.ts` writes skills, so the setup exists; the window did not. |
| D1.67 | nested `.claude/skills` discovery | Not reached. Needs a project with a nested `.claude/skills` root plus a same-named skill at the project root, and the control with the nested root removed. |
| D1.68 | one uninterrupted codex plugin prompt workflow | **Operator precondition.** Installing `codex-security` goes through the app's own marketplace flow; `scripts/cdp/README.md` reserves plugin installation for the operator, exactly as MCP-W1..3 and SKL-P1 already require. |
| D1.70 | a project-scope plugin in a worktree of the same repo | **Operator precondition** — the same plugin install. |
| D1.71 | does installing a plugin turn its bundled connector on | **Operator precondition** — the same plugin install, into a clean profile. |
| D1.72 | a codex plugin has no durable home | **Operator precondition** (a plugin writing into the codex home), and one reading is already in §8: `CODEX_HOME` is a per-SESSION `mkdtemp` under the OS temp dir — six distinct values across six sessions — so the row's premise about the home being rebuilt is visible on the artefact even without the plugin. |
| D1.73 | the plugin suggestion pin | **Operator precondition**: two registries, one on the managed suggestions allowlist, plus a delivered managed policy. |
| D1.74 | do list keys combine across settings files | **ANSWERED — see §12.** The rule is published per FAMILY by the product itself (`permissions: last-wins`, `instructionExcludes: union`), host-side rather than per runtime. The behavioural arm — two files supplying one family, then a decision — stays owed. |
| D1.75 | which settings keys wait for workspace trust | Not reached. Needs an UNTRUSTED workspace carrying all four keys plus a deny and an ask rule; `trustScratchProject` answers the gate, so the rig exists. |
| D1.76 | what a running session re-reads | **Half answered — see §8.** (b) is measured on the artefact; (a), editing a settings file with a session live, is not driven and stays owed. |
| D1.77 | codex rate-limit windows and account usage | **The row forbids its own strongest arm**: *"Do not take the codex USD arm here"* — `account/usage/read` is an already-asked owner question. What remains needs a codex account with published rate-limit windows; a gateway card has none, so there is nothing on this rig to read. |
| D1.79 | one id joining a hook trace, an export record and a transcript line | **Measured unanswerable on this build — see §9**, with the ladder and its controls. |
| D1.81 | does claude's interrupt receipt name messages Stop did not cancel | Not reached. The receipt is discarded by the host (`void live.interrupt().catch(...)`), and the claude per-session diagnostic scores **0** for `still_queued`, `cancel_queued`, `interrupt` and `control_request` over an ordinary turn — so a driven arm needs an actual interrupt with messages queued, and a surface that records the response. |
| D1.82 | two askUserQuestion expiry timers | Not reached. Needs a card that is left idle for the full expiry, twice, plus a permission prompt idled beside it as the control. |
| D1.131…D1.138 | the carried coverage-plan rows | Not reached; each needs a rig this sitting did not stand up — the Guardian's fourth tier (D1.131), the three standing MEASURE rows (D1.132), A57 (D1.133), the per-event hook matrix with `settingSources` narrowed (D1.134), the subagent-field rig (D1.135), RS-06's revoked credential across two relaunches (D1.136), an official `*-lsp` plugin in a trusted project (D1.137), and the Pi `toolcall_delta` arm (D1.138). |
| D1.175 | `view_image` on a switched codex session | **Rig-day**: needs a vision-capable BYO `openai-compatible` upstream. This host has one codex card and it is the gateway, whose model answers an image part with `400 Invalid Chat Message Part`. |
| D1.176 | the rewind menu's item set and toast on claude and codex | Not reached. One session pair closes both cells and the rig is cheap; the window did not hold it. |
| D1.177 | the Pi checkpoint arm end to end | Not reached. Needs six named skip reasons provoked plus a drive past 100 checkpoints — the largest rig in this list. |
| D1.178 | what a runtime keeps when the connection drops mid-response | **Rig-day**: needs a stub upstream that streams a partial response and then drops, plus two controls. Nothing on this rig can drop a connection mid-response. |
| D1.179 | a Bash command whose OUTPUT carries denied content | **Rig-day**: needs a FAKE `HOME` with a seeded denied file, and R6b measured why that is not free — `getCredsPath` resolves the shared dp credential under `latchedHomeDir()`, so a fake-`HOME` launch makes both gateway cards answer `auth-request`. |
| D1.180 | the two live codex arms W6-a could not drive | **Rig-day**, same fake-`HOME` blocker (C4.48, an owner question). |

**Two of these reasons are readings this sitting took rather than inherited:** D1.58's (the diagnostic file carries
no thinking marker, against 238 readable lines) and D1.64's (the claude cache accounting does not move on this
card, against a Pi control that does). They are recorded so the next sitting re-takes a premise rather than a
guess.

---

## 12. D1.74 — the combine rules are published per FAMILY, and the claude stack the surface publishes is not the one the child opens (case `RS-77`, **FAIL 6 of 7**, 29 587 ms — the one FAIL is the product)

### The row's answer is a read, and its shape is part of the answer

D1.74 asks *"whether list keys such as `permissions.allow` combine across settings files or one file replaces
another, on all three"*. The product publishes it: `getSettingsProvenance` carries a `combine` per FAMILY, and
`config/config-doctor.ts` types the vocabulary as `'last-wins' | 'union' | 'winner-takes-all'` with its own
docblock saying why — *"three different answers, none assumable"*.

| family | combine |
| --- | --- |
| `permissions` | **`last-wins`** — one file REPLACES another; `permissions.allow` does not accumulate |
| `instructionExcludes` | **`union`** — these do combine |
| `skillOverrides` | `last-wins` |
| `managedSettings` | `winner-takes-all` |

**And the rule is host-side, published per family rather than per runtime** — so the row's *"on all three"* is
answered by ONE reading rather than three, and that shape is itself the finding: there is no per-runtime merge
rule to diverge. The CONTROL is that the surface names a file inside this rig's own config dir, so the report is
about this profile.

**What is owed:** a merge driven END TO END — two files supplying one family, then a decision — is a different arm
and this case does not take it. The verdict says so rather than implying otherwise.

### The cross-check, and the divergence the surface exists to remove

The same report carries a second stack, `claudeChildSettingSources`, whose own docblock states its purpose:
*"Showing one stack would be the silent divergence this view removes, so the honest surface shows two."* On a
packaged build that stack is checkable without new instrumentation — the vendored claude binary logs every
`settings.json` path it tries into the per-session diagnostic §1 measured.

| account | files |
| --- | --- |
| the SURFACE publishes | `/Users/<operator>/.claude/settings.json` — **state `supplies`** |
| the CHILD actually opened | `<rig>/config/workspaces/<workspaceId>/claude-config/settings.json`, plus the session's own `.claude/settings.json` and `.claude/settings.local.json` |

**Zero overlap.** The surface hard-codes `join(homedir(), '.claude', 'settings.json')`
(`packages/server-core/src/handlers/rpc/settings.ts`, the `claudeUser` line), while the child's `user` scope
follows `CLAUDE_CONFIG_DIR` — which `buildClaudeSubprocessEnv` sets per WORKSPACE (§8 measured that value). The
operator's real `~/.claude/settings.json` exists on this machine (6 604 bytes, 14 keys including `permissions`,
`hooks`, `env` and `model`), which is why it is reported as **supplying** — and the child never opens it. Recorded
as proposed row **P-5c-5**.

### The control this case had to rewrite, and why it is worth recording

The first spelling required the two lists to OVERLAP. Driven, it stopped there: the surface publishes exactly one
file and that file IS the finding, so *"no overlap"* was the control failing and the subject failing at once,
indistinguishably. The control was narrowed to something independent of the surface — **does the child's own
account name a settings path belonging to THIS profile?** — which passed, and the subject check then failed on its
own terms. A control that the finding itself can falsify is not a control.

### A reading this run also settles

The child's log never mentions the operator's home settings file (`grep -ac` over the diagnostic: **0**), which
**confirms §8 rather than contradicting it**: a fresh `NESSY_CONFIG_DIR` really does isolate the claude arm from
the usual setup. What is wrong is the surface's account of it, not the isolation.

---

## 11. What ran, and where this sitting stopped

| case | row | verdict | file |
| --- | --- | --- | --- |
| RS-32 (rig precondition) | P6.1080 | **PASS 8/8**, 28 202 ms, load 10.77 | `scripts/cdp/cases/rs-32.ts` |
| RS-71 | D1.78 | **PASS 14/14**, 84 067 ms | `scripts/cdp/cases/rs-71.ts` |
| RS-72 | D1.60 | **PASS 12/12**, 81 212 ms | `scripts/cdp/cases/rs-72.ts` |
| RS-73 | D1.63 | **FAIL 15 of 18** — the three FAILs are the product | `scripts/cdp/cases/rs-73.ts` |
| RS-74 | D1.61 | **PASS 7/7**, 22 603 ms | `scripts/cdp/cases/rs-74.ts` |
| RS-75 | D1.56 | **PASS 12/12**, 104 064 ms | `scripts/cdp/cases/rs-75.ts` |
| RS-76 | D1.57 | **FAIL 11 of 12** — the one FAIL is Pi being stricter | `scripts/cdp/cases/rs-76.ts` |
| RS-77 | D1.74 | **FAIL 6 of 7** — the one FAIL is the product; all three controls green | `scripts/cdp/cases/rs-77.ts` |
| *(readings, no case)* | D1.62, D1.76(b), D1.79 | answered in §5, §8, §9 | — |

`bun scripts/bun-test-lock.ts run --label SIT-5c -- bun test ./scripts/cdp/harness.test.ts` → **84 pass / 0 fail,
1500 expect(), 1 file** at the last commit. `bun run tsc -p scripts/cdp/tsconfig.json` exit 0 after every edit.
`git diff --check` clean before every commit.

**Where it stopped.** The lane's list is `D1.55` onward in id order. Driven or answered: `D1.56`, `D1.57`,
`D1.60`, `D1.61`, `D1.62`, `D1.63`, `D1.74`, `D1.76(b)`, `D1.78`, `D1.79`. **The next sitting starts at `D1.64`'s
output-style half, then `D1.65`** — §10 says for each remaining row what it needs, and two of those reasons are
readings taken here rather than assumptions carried forward.

### Rig facts this sitting adds

* **Three concurrent sittings make `appProcessPids()` over-wide.** It enumerates with
  `pgrep -f "MacOS/Nessy Desktop"` and matched **twelve** processes where this lane owned four. Nothing was
  mis-scored — every read was clean — but a sibling launching dirty would have blocked THIS lane's cases with a
  sentence naming this lane's rig. Every process read in this sitting's own cases is therefore scoped by the
  `NESSY_CONFIG_DIR` inside the process's own environment, which is the only discriminator that works with more
  than one app on the machine.
* **Killing the app and relaunching on the same port immediately FAILS, and the failure is quiet.** The new
  instance logs `bind() failed: Address already in use (48)` / `Cannot start http server for devtools` and exits;
  a `ps eww` taken in that window reads the OLD process and reports the OLD environment, which is how a relaunch
  that did not happen reads as a relaunch that did. Wait for the port, then launch, then read the environment of
  the process you are about to drive.
* **A `latest` symlink appears in `<config>/logs/runtime/`**, written by the vendored claude binary beside the
  file the host pointed it at. It is useful and it is not per-session: a reader that assumes the directory's
  naming rule holds for every entry double-counts the last claude session.
