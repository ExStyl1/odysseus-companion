# Release verification 1.39.0 — 2026-09-17 (lane SIT; the dp-auth wave-2 close-out build)

Build under test: `release/mac-arm64/Nessy Desktop.app`, version **1.39.0** (the bundle self-reports `1.39.0`;
`CFBundleShortVersionString` 1.39.0), built by the controller from HEAD **`b1f4f279c`** at 13:34; dmg
`release/NessyDesktop-1.39.0-mac-arm64.dmg`. `bun scripts/build/codex-integrity.ts` was run by the controller
against this artefact and verified. Runtimes inside the bundle: Claude Agent SDK 0.3.251 (the vendored `claude`
self-reports **2.1.251**, and so does `claudeCodeVersion` — the two self-reports agree), codex
**`codex-app-server 0.154.0`** (its own `--version`, read out of
`Contents/Resources/app/resources/bin/codex/darwin-arm64/`), Pi **0.84.4**.

Rig, for every case below unless the case says otherwise: port **9226**;
`--user-data-dir` and `NESSY_CONFIG_DIR` both under the lane scratchpad, created for the run and never under `~`;
the owner's profile (`~/.nessy-agent`) was never launched, and `dp auth login`/`logout` were never run. Every BYO
card carries a **fabricated** `sk-cdp-<32 hex>` key this lane generated — never a real credential, never printed.
The one-click gateway cards sign in through the app's own `dp` module reading its own file, which is the product
path; this lane never read, printed or wrote that file itself.

**What moved in the artefact since the 1.38.0 sitting, and it unblocks a row:** `NESSY_HOME` occurs **20 times**
over `Contents/Resources/app` (`grep -raoF 'NESSY_HOME' … | wc -l`), against **0** on the 1.38.0 artefact measured
2026-09-17 by WB-f; the positive control on the same rig, `NESSY_CONFIG_DIR`, answers **43** on both. DA1.5 is in
the build under test, so RS-43's re-mint arm (row DA2.19) is drivable here and was a NULL there.

## Case 1 — RS-32 / P6.1080: the one-click gateway card a FRESH profile seeds: **PASS 8/8**

`bun run scripts/cdp/cases/rs-32.ts` against a `NESSY_CONFIG_DIR` created seconds earlier, **20 184 ms**, load
6.43 (13:40:20–13:40:40). `##CDP-RESULT##` status **PASS**.

| reading | value |
| --- | --- |
| the card the click created | `pi-api-key` · *Nessy Backend (API Key)* · `pi_compat` |
| the seeded `defaultModel` | **`tgpt/deepseek-v4-flash-0731`** — the id behind the `coder` alias |
| the card's own catalogue | `["tgpt/deepseek-v4-flash-0731","tgpt/qwen36-35b-a3b-fp8"]` — the seed is in it |
| the retired id | **absent** (`tgpt/qwen35-397b-a17b-fp8` is what 404s) |
| the FIRST turn | **answers** — `ready`, two messages added |
| the negative control (retired id selected) | the app accepted the stored retired id on the session, and the Pi sidecar's own `model_change` line records **`tgpt/deepseek-v4-flash-0731`** — the host substituted the live id before the call, with **0** info rows about it |

The release-critical half of P6.1080 holds on 1.39.0 as it did on 1.38.0 and 1.37.0, and the control reads
identically on all three: the 404 is unreachable from the product's own surface because the host substitutes
silently. That is the fallback working, recorded rather than judged — it is the case's own `control-verdict`.

## Case 2 — RS-43's RE-MINT arm / row DA2.19: **PASS**, in three arms, and the card arrives in 2.5 s

The 1.38.0 sitting recorded this arm as a NULL for a stated reason: reaching the condition where a re-mint is
REQUIRED needs `NESSY_HOME`, and that artefact did not carry it. It does here (20 occurrences against the
`NESSY_CONFIG_DIR` control's 43), so the arm is drivable, and `scripts/cdp/cases/rs-43.ts` grew it rather than
gaining a second case file.

Rig: one profile, seeded by the product's own one-click button in arm A1 and reused by every arm after it; the
lane's own `scripts/cdp/fixtures/refusing-proxy.ts` on `127.0.0.1:9333` (it forwards nothing, ever); the app's own
`networkProxy` block merged into the `config.json` the app had already written, with `noProxy` naming the gateway
host so the gateway itself stays reachable and a turn earns a real 401 rather than a transport error. The positive
control — the driver's own `curl` through the same proxy — was refused (exit 56, `CONNECT tunnel failed, response
403`) and logged in every proxied arm.

| arm | what the rig changed | the app's own sign-in section | slowest `sessions:command` | the turn | dp card |
| --- | --- | --- | --- | --- | --- |
| A1 13:45 | nothing — the ordinary signed-in profile, no proxy | `ok` / present / 325 chars / jwt-shaped / claims decode | `switchRuntime` **37 ms** | answered, 12 991 ms | — |
| B1 13:50 | `NESSY_HOME` = an EMPTY dir; proxy in the app's SETTING | `ok` / present (re-minted at 13:46:52) | `switchRuntime` **117 ms** | answered, 22 321 ms | none |
| B2 13:52 | + the proxy in the app's ENVIRONMENT | `ok` / present (re-minted at 13:52:13.533Z) | `switchRuntime` **72 ms** | answered, 7 550 ms | none |
| B3 13:54 | + `HOME` = an empty dir, so `dp` has no session of its own | **`no_credentials` / `absent`** | `updateWorkingDirectory` **30 ms** | **ended, 2 464 ms** | **`NeedsLogin`** |

### B3 is the row's arm, and its answer is unambiguous

With no JWT anywhere and no dp session to mint one from, one turn produced: the dp sign-in card, recorded on the
session itself (`role: 'auth-request'`, `authRequestType: 'dp'`, `authStatus: 'pending'`, `authError: 'NeedsLogin'`,
*"Sign in to Developer Platform"*) — and **the turn ended in 2 464 ms**, with `as.tbank.ru` refused twice inside
that turn's own window. Every `sessions:command` answered, the slowest at **30 ms** against the 30 000 ms ceiling,
and the discriminator (`getSessions`) at 4 ms either side of the sequence.

`switchRuntime` answered in **8 ms** with the product's own refusal — *"Connection "pi-api-key" has no usable
credentials. Sign in to it first, then switch"*. That is a guard, not a ceiling, and it is exactly the confusion
this case's own fourth rig-fault note warns a reader against.

So the target scheme's clause holds where it had never been measured: **a failed re-mint under a proxy refusing the
app's own auth hosts reaches the user as a card in about two and a half seconds, not as a blocked turn.**

### The instrument gained a reading it did not have, and the FIRST version of the guard got it wrong

Each arm now records the credential state it was taken under, from the app's own config doctor (§*"Nessy Gateway
sign-in:"* — codes, lengths and booleans, no token by construction). The 1.38.0 sitting's explanation — *a machine
whose creds file already holds a usable JWT never re-mints* — was an inference about the rig; it is now a reading of
it.

The first version of the arm's guard read ONLY that section and BLOCKED arm B1, on the grounds that the app reported
`ok` and therefore nothing was forcing a re-mint. It was wrong, and instructively: the app had already re-minted
into the empty directory **six seconds after launch**, so the thing the arm exists to exercise had happened before
the case attached. The doctor prints a reason code and no PATH, so `ok` after a successful relocated re-mint is byte
for byte `ok` on a profile where `NESSY_HOME` was ignored. The guard now takes a SECOND reading — the relocated
file's own existence and mtime, never a byte of its content, in a directory this lane created empty seconds earlier
and which `packages/shared/src/auth/dp` is the only writer of — and blocks only when both readings say this is an
ordinary signed-in profile.

### A finding this arm was not looking for: the app's `networkProxy` SETTING does not reach the `dp` exec

B1 and B2 differ in one thing — where the proxy is configured — and they had an identical need to mint a credential
from nothing:

- **B1, proxy in the app's own `networkProxy` setting only:** the re-mint succeeded and the proxy log recorded
  `as.tbank.ru` **zero** times. The `dp` child egressed somewhere the operator's configured proxy never saw.
- **B2, the same proxy also exported into the environment the app was launched with:** `as.tbank.ru` was refused
  **three times** inside 121 ms, so the child really does reach that host — and a usable JWT was written 231 ms
  after the third refusal anyway.

`packages/shared/src/auth/dp/internal.ts` symbol `dpExecEnv` builds the child's environment as `{ ...process.env,
HOME: latchedHomeDir(), DP_NO_WARNINGS: 'true' }`; the app's `networkProxy` setting is not in `process.env`, so it
cannot reach that child. This is the same family as C3.382 (Pi's shell reaching the network while claude was refused
in the same run), on a different child, and it is recorded as a proposed row rather than fixed here: `packages/**`
is not this lane's zone and the remedy is a posture question about what an operator's proxy setting is supposed to
bind.

It also re-dates DA2.11's own explanation. That row concluded the hosts were never reached because the machine never
re-minted; B2 shows the stronger version — **even when it does re-mint, and even when those hosts are refused, the
cost is sub-second and no `sessions:command` comes near the ceiling.**

## Case 3 — RS-44 (NEW) / row DA2.16: **FAIL 8/9**, and the one FAIL is the product

`scripts/cdp/cases/rs-44.ts` is new. It creates its own BYO card through the app's own `setupLlmConnection` with a
**fabricated** `sk-cdp-<32 hex>` key, points it at `https://api.anthropic.com/v1` with two `anthropic/…` model ids,
reads the rendered DOM, and removes the card again. **No turn is ever driven on it** — both surfaces are decided
before any request is sent, so the fake key is never spent and the vendor is never contacted.

Run 2026-09-17 14:12, **19 388 ms**, load 5.52, on the rig RS-32 had seeded minutes earlier.

### Surface 1 — the mark on a connection row: **PASS**, with its control in the same read

| reading | value |
| --- | --- |
| the marked rows | the BYO card's — both its collapsed active row and its row in the expanded list |
| the mark's text | `external model` (`chat.modelPicker.toolEgressBadge`) |
| the mark's `title` | *"This model answers from api.anthropic.com, outside Nessy Gateway. The names and schemas of your MCP tools are sent there with every turn."* |
| the gateway card's row | **unmarked** — 1 unmarked row against 2 marked ones, in one pass over one expanded list |
| after switching the session to the gateway | the BYO row is **still** marked — the verdict is per CONNECTION, as `TargetDisclosureMark` intends |

The rows are told apart by **the host the mark's own title names**, never by the cards' display names: a built-in
slug with a numeric suffix inherits the template's name, so `pi-api-key` and `pi-api-key-2` both read *"Nessy Backend
(API Key)"* on screen and `cru-3.ts` already records what that does to a row identified by text.

### Surface 2 — the line under the model list: **it is not in the picker a desktop window shows**

This is the finding, and it has both controls it needs.

| picker | width | the egress line | the provenance line |
| --- | --- | --- | --- |
| `FreeFormInput.tsx`'s own `DropdownMenu` | 1400 px | **absent** | **absent** |
| `CompactModelSelector` (drawer) | 700 px | *"This model answers from api.anthropic.com, outside Nessy Gateway…"* | *"This list comes from api.anthropic.com."* |
| `CompactModelSelector`, gateway card | 700 px | **absent** (correct) | *"This list comes from Nessy Gateway. Last read 24s ago."* |

Same card, same session, same minute. **The mode is not the difference:** the desktop picker's own text lists both
of the BYO card's models — `claude-sonnet-4-5 claude-haiku-4-5` — so `derivePickerMode` answered `flat` there too,
which is the only mode under which either line renders. What differs is the COMPONENT: `model-target-tool-egress`
occurs in `CompactModelSelector.tsx` and nowhere else in the tree, and so does `model-list-provenance`. Both
composers render the same `ConnectionRow`, which is why the mark is on both.

The compact arm is the POSITIVE CONTROL and it is what makes the desktop absence a reading rather than a suspicion:
the testid works, the classifier answered, the copy exists in both locales. The gateway control is deliberately read
in the **compact** picker too — a picker that renders no line for anybody would pass a gateway-arm check taken in the
desktop dropdown, and the control additionally requires the provenance line PRESENT so that silence cannot pass as
correct silence.

**What a desktop user therefore gets today:** the `external model` badge beside the connection, and the sentence
naming the host only as the badge's hover `title`. The rendered disclosure line — the one DA2.6 specified and
`bb098544e` built — reaches only the compact composer, which a desktop window shows below 768 px of shell width.
This is exactly the class DA2.16 was created to catch: *"both are asserted on their SOURCE today, which answers
'does the verdict reach the markup', not 'does the user see it'"*. The assertions are correct; the component they
assert is not the one the desktop user has in front of them.

It is recorded and not fixed here: `apps/electron/**` is not this lane's zone, and the remedy is a choice (lift both
lines into a shared block, or render them in `FreeFormInput`'s picker too) rather than a one-line repair. Proposed
row below. Note it is WIDER than DA2.6 — C3.346's provenance line is missing from the desktop picker by the same
mechanism, and nothing had asked.

### One rig residue, recorded rather than hidden

The card removal in the case's `finally` answered *"1 session(s) and 0 automation(s) still use "pi-api-key-2""* —
the app refusing to delete a connection a session still names, which is the product protecting the user. The session
holding it was a LEFTOVER from an earlier failed drive of this case, not the one this run created; the case now moves
its own session back to the gateway before deleting, and records the refusal verbatim when one still comes back.

## Case 4a — RS-40 (NEW) / rows DA1.11 + DA1.10: **PASS 4/4**, and DA1.10's end-to-end clause is proved

`scripts/cdp/cases/rs-40.ts` is new. Run 2026-09-17 14:23–14:24, **81 890 ms**, load 5.53, on a fresh profile
seeded by RS-32 minutes earlier, with the app launched under `NESSY_PROXY_AUTH_DEBUG=1`.

### The credential half — the clause no unit test reaches

DA1.10 narrowed the Pi-side JWT to the NAMED gateway endpoints, so a connection on the gateway HOST at any other
path must carry its own `Authorization` and never `Nestor-Token`. The detector is the app's own
`logUpstreamAuthScheme` line, whose entire vocabulary is `bearer` / `nestor-token` / `none` — a scheme, never a
credential. **It is filed per SESSION**, at `<config dir>/logs/runtime/<sessionId>-pi.txt`; this sitting looked for
it in the app's own captured stdout first and found **zero** lines there, which is recorded because it is where the
next reader will look too.

| session | card | the schemes its own sidecar wrote |
| --- | --- | --- |
| the CONTROL | the one-click gateway card | **`nestor-token`** |
| the case's own | `pi-api-key-3` on `https://code-completion-nestor.tcsbank.ru/api/v1/cli/other/v1`, fabricated key | **`bearer`, `bearer`** |

The control is what makes that a verdict: without a session that DOES write `nestor-token` on the same instrument in
the same run, `bearer` is equally true of an instrument that cannot say `nestor-token` at all, and an empty reading
is equally true of one that is switched off. Both arms answered, and the narrowing holds end to end on the packaged
build.

### The naming half — and two things the row could not have known

**The URL is ACCEPTED**: `setupLlmConnection` answered `{ success: true }` and the app's own record carries the
endpoint verbatim, which is what AGENTS.md requires of a legitimate custom endpoint. But the other two halves of the
row's recipe did not survive contact with the shipped build:

1. **There is no field to type the URL into.** The row says *"Settings → AI → Add connection → Custom, type
   `https://…/cli/other/v1`"*. Driven: the custom-runtime step renders its API-key field (`#byo-api-key`, the
   control that proves the form opened) and **no endpoint input at all** — `#byo-base-url` absent, `#base-url`
   absent. `ByoRuntimeStep.tsx` says why in its own comment: *"the Endpoint — v2 hides it. It appears only for an
   EDIT of a connection that points somewhere other than the hardcoded URL, and there it is read-only"*. So
   `apiSetup.gatewayHostNotGatewayUrl` is an EDIT-path surface on this build, and the sentence was **not** read this
   sitting — recorded as a NULL, not as a missing notice, with the arm that would reach it named for the next
   sitting.
2. **The EXACT gateway URL is not refused by the SAVE path.** The same call with
   `…/api/v1/cli/openai-like/v1` answered `{ success: true }` and produced a connection. The `endpointIsGateway`
   refusal lives in `validateByoRuntimeForm` / `validateMergedEndpointForm` — a FORM rule — and the form that would
   run it has no endpoint field to validate. Recorded rather than asserted, because the two layers are allowed to
   answer differently and only one of them is this row's subject; proposed as a row below, since a refusal whose only
   enforcement point is a hidden field is not an enforcement point.

## Case 4b/5 — RS-41 (NEW, carrying RS-42's control) / row DA1.13: **15 of 16**, and the one red is a logger

`scripts/cdp/cases/rs-41.ts` is new and carries both rows: RS-42 is literally *"the negative control for RS-41"*, and
a control measured in a different run on a different profile is not a control. Run 2026-09-17 14:34–14:35,
**41 663 ms**, load 7.91, on a profile created for the run with NOTHING seeded — the case presses the product's own
one-click buttons.

### The pair DA1.13 had to land as one: **PASS, all three cards**

| card | created by | `isAuthenticated` | the store's own record |
| --- | --- | --- | --- |
| `pi-api-key` (*Nessy Backend (API Key)*) | the onboarding's *"Nessy · Pi agent"* button | **true** | **null** |
| `codex-gateway` (*Codex (Nessy Gateway)*) | *"Nessy · Codex agent"* | **true** | **null** |
| `claude-gateway` (*Claude Code (Nessy Gateway)*) | *"Nessy · Claude Code agent"* | **true** | **null** |

Read together on one profile, which is the point: three presence readers each take a card away when they see no
credential, so "no snapshot" and "still selectable" are each true of a build the other half is broken on. All three
cards carry the gateway base URL and none carries a stored credential, and none is disabled.

### The migration: **it runs, and nothing it says reaches anybody**

The arm has to PLANT a snapshot first — on a profile created today nothing ever writes one, so a re-run deletes
nothing, and an unplanted assertion would fail against a build that is working. The plant is an upgrading user's own
shape: the slug is created as an ordinary BYO connection with a key and a non-gateway endpoint, verified through
`getLlmConnectionApiKey` (masked) before anything else happens.

| reading | value |
| --- | --- |
| the store, after the plant | `sk-cdp-••••••••…` — a snapshot really is there |
| the store, after the re-run | **`null`** — the migration ran |
| the card, after the re-run | `isAuthenticated: true` — it did not go disabled by losing it |
| *"Discarded the stored credential snapshot on gateway connection …"* | **absent from the app's captured output** |
| the CONTROL — the same handler's sibling line *"Saved API key to LLM connection"*, fired by the plant | **absent too, 0 occurrences** |

**So the red is the LOGGER, not the migration**, and the control is what says so: both lines come from the same
`deps.platform.logger?.info` in `packages/server-core/src/handlers/rpc/llm-connections.ts`, one on the discard branch
and one on the branch the plant takes, and neither reaches the packaged build's own output — while
`[ws-rpc-server] INFO`, `[dp-auth] INFO` and `[ConfigWatcher]` lines are in the same capture from the same run. The
migration itself is answered independently, by the store: a snapshot before, `null` after.

This is the same shape as DA2.6's original defect — a mechanism that works, announcing itself into a channel a
packaged build does not carry — and it is recorded as a proposed row rather than fixed here.

### RS-42, the control, in the same run: **PASS**

A BYO connection on the gateway HOST (`…/api/v1/cli/other/v1`, fabricated key) was created before the re-run and read
after it: the store answered the same masked key both times, and the card stayed `isAuthenticated`.
`isGatewayBackedConnection` is the STRICT whole-URL predicate precisely so a connection that merely lives on the
gateway host is not swept by the migration, and it is not.

### One product reading the arm was not looking for

**Pressing the one-click card again over a DIVERGED slug mints a new one rather than upserting.** With `pi-api-key`
pointed at a non-gateway endpoint by the plant, the *"Nessy · Pi agent"* button produced `pi-api-key-2` and left
`pi-api-key` alone. That is a defensible answer — the user's edited card is not overwritten — and it is why the
migration arm drives `setupLlmConnection` directly, which is the RPC the button itself calls. Recorded rather than
judged.

## Case 6 — RS-39 (NEW) / row DA1.17 option B: **FAIL**, and the pointer is UNREACHABLE on the two cards it was written for

`scripts/cdp/cases/rs-39.ts` is new. Run 2026-09-17 14:51–14:55, **257 559 ms**, load 7.11, on a profile created for
the run; the two gateway cards were created by pressing the product's own one-click buttons.

| session | the palette's rows for `quota` | what a TYPED `/quota` produced |
| --- | --- | --- |
| the Pi gateway card — **THE CONTROL** | **`Quota — Show the remaining usage budget`** | (not driven; the control is the offer) |
| `claude-gateway` | **none** | a `user` row carrying `/quota`, and **no non-user row in 45 s** |
| `codex-gateway` | **none** | the same |
| `claude-custom` (BYO, an ordinary endpoint) | — | no pointer |
| `codex-custom` (BYO at a gateway chat-base SUBPATH, review R1's arm) | — | no pointer |

**The pointer never reaches the user, because nothing dispatches the command that would print it.** DA1.17 option B
appends `NESSY_GATEWAY_QUOTA_POINTER` inside `describeQuota` on the claude and codex agents, and that override is
correct and unit-tested. But the only route to `describeQuota` is the host dispatching the quota command, and
`offersNestorQuota` withholds the MENU row on exactly these two cards — deliberately, which the row itself records —
while a `/quota` typed into the composer is submitted as PROSE: the transcript carries one `user` row with the text
`/quota` and nothing else.

The row's own recipe says *"`/quota` TYPED (the menu row stays withdrawn, deliberately)"*, which reads as an
assertion that typing reaches the sentence. On this build it does not.

**The control is what makes that a finding rather than a broken probe.** A Pi gateway session in the same run, on
the same rig, is offered `Quota — Show the remaining usage budget` by the same palette read — so the probe can see a
row when one exists, and the two empty readings are the product's own answer.

The two BYO controls both pass, including the one review R1 added: a card whose base URL is a SUBPATH of the gateway
chat base gets no pointer either, which a host-based decision would have got wrong.

Recorded, not fixed: `packages/shared/src/agent/**` is not this lane's zone, and the remedy is a choice between
widening `offersNestorQuota` to the gateway families (option A, which the row prices at M and leaves to the owner)
and giving the typed form a dispatch. Proposed row below.

## Case 7 — row DA1.54: the doctor's gateway section against a REAL credential

DA1.34 pinned the four reason codes against fabricated JWTs under a temp `NESSY_HOME`; DA1.54 is the one sitting that
confirms the `ok` arm end to end. Taken 2026-09-17 on this machine, in **codes, lengths and booleans only — exactly
what the doctor prints, and never the token**.

**The packaged build's own doctor surface** (`GET_CONFIG_DOCTOR`, the section `gatewayAuthLines` renders), read
through the running 1.39.0 app:

```
Nessy Gateway sign-in:
  re-mint reason: ok
  credentials file: present
  token: 325 characters, jwt-shaped, claims decode
  stored expiry: in 1051195 minute(s)
```

**The CLI's own doctor**, the other of the two surfaces DA1.34 wired, run against the same config dir on the same
machine minutes later — byte-identical but for the expiry, which is computed from `Date.now()`:

```
Nessy Gateway sign-in:
  re-mint reason: ok
  credentials file: present
  token: 325 characters, jwt-shaped, claims decode
  stored expiry: in 1051194 minute(s)
```

So the `ok` arm is confirmed against a real sign-in, on both surfaces, and they agree. `hasFindings` is `false` and
the section moves no exit code, which is correction (1) of DA1.34 holding: *a printed reading that moves nothing*.

### The row says "run the PACKAGED `nessy-general-agent doctor`", and that binary is not in the artefact

Three readings, so the next reader does not repeat the search:

1. `apps/cli` is **absent** from `Contents/Resources/app` — the bundle carries `dist`, `node_modules`, `packages`
   (only `shared`, the interceptor's own closure), `resources` and `package.json`, and `apps/electron/electron-builder.yml`'s
   `files` list never names it. `main/index.ts` nevertheless sets `NESSY_CLI_ENTRY` to
   `join(app.getAppPath(), 'apps', 'cli', 'src', 'index.ts')`, a path that does not exist in a packaged build.
2. The shim that would exec it, `resources/bin/nessy-general-agent`, is in the bundle only at
   `app/dist/resources/bin/` — and the directory `main/index.ts` prepends to the agent's `PATH` is
   `<resourcesBase>/resources/bin`, i.e. `app/resources/bin`, whose listing is `codex`, `darwin-arm64` and the eight
   document tools. **No `nessy-general-agent` on the PATH, and no entry for it to exec.**
3. Confirmation from the other side: `grep -aoF runDoctor` over `dist/main.cjs` answers **0**,
   while `collectGatewayAuthInput` answers **6** — the shared collector is bundled, the CLI's own driver is not.

So the CLI doctor reading above is the REPO's CLI (`bun run apps/cli/src/index.ts doctor`) run on this machine
against the same config dir, and it is labelled as such rather than as a packaged reading. The packaged half is the
app's own surface, which is the one a user of the shipped build can actually reach. That the agent-facing CLI shim is
unreachable in a packaged build is a finding of its own, proposed as a row below.

## Case 8 — RS-45 (NEW) / row DA2.5: the loopback bearer floor on the shipped listener — **PASS 10/10**

`scripts/cdp/cases/rs-45.ts` is new. Run 2026-09-17 15:00, **9 121 ms**, load 5.72.

**Port discovery, recorded because the row asks for the method:** `pgrep -f "Nessy Desktop"` → `lsof -nP -iTCP
-sTCP:LISTEN -a -p <pids>` → `POST /` and `POST /mcp` on every 127.0.0.1 port the app owns. The pool server is
identified by its OWN pair of answers rather than by a port number: `404` for any path that is not `/mcp`, `401` for
`/mcp` without a bearer.

| port | `POST /` | `POST /mcp` | |
| --- | --- | --- | --- |
| 9226 | 200 | 404 | the CDP endpoint this sitting drives through |
| 55442 | 426 | 426 | an upgrade-required socket |
| 55620 | 404 | 404 | |
| **55746** | **404** | **401** | a pool server |
| 55853 | 404 | 404 | |
| **55888** | **404** | **401** | a pool server |

Four of the six do not match, which is the control: the signature identifies something rather than everything.

**The four probes, identical on both pool ports:**

| probe | status | body |
| --- | --- | --- |
| no bearer | **401** | `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Unauthorized"},"id":null}` |
| a wrong bearer | **401** | the same |
| a body that is not JSON at all | **401** | the same |
| an `mcp-session-id` naming no session | **401** | the same |

The last two are the ORDERING, and they are why this case is not a restatement of the unit test. A body that does not
parse is answered `400` by the transport and an unknown session id is answered `404 "Session not found"` by
`handleRequest` — so both answering `401` measures that the bearer check runs before the body is parsed AND before the
session is looked up. DA2.5's *"401 before any route work"* is now a reading of the shipped listener rather than of
the source.

Nothing here could have been accepted: the bearer is 32 random bytes per instance, the case never learns it and never
tries to.
