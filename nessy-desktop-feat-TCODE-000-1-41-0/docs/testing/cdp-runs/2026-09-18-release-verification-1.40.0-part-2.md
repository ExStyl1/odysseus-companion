# Release verification 1.40.0, part 2 — 2026-09-18 (lane SIT-5d; the drives sitting 5a left owed)

SIT-5a's narrative (`2026-09-18-release-verification-1.40.0.md`) closes with §7, *"What this sitting did
NOT drive, with the premise re-taken rather than assumed"*. This is that list driven. Nothing here
re-takes a reading SIT-5a already took; where a row of theirs is quoted it is quoted as the number this
sitting is measured against.

**Build under test.** `release/mac-arm64/Nessy Desktop.app`, **1.40.0** (`CFBundleShortVersionString`
reads `1.40.0`), built by the controller from `61cfc4659`; dmg
`release/NessyDesktop-1.40.0-mac-arm64.dmg`, unsigned, dev update feed, `codex-integrity` verified by the
controller. Never rebuilt, never removed.

**Rig.** Ports **9232** (the app), **9233** (this lane's own refusing proxy), **9234** and **9235** (the
two RS-43 arms). `NESSY_CONFIG_DIR` and `--user-data-dir` under this lane's scratchpad, created for the
run and never under `~`. The owner's profile was never launched; `dp auth login` / `logout` were never
run; no token was read, printed or committed — the one credential file this sitting speaks about is read
through the app's own `dp` module and reported by EXISTENCE, mtime and size only. Sitting lane SIT-5c ran
at the same time on 9252–9261 with its own config dir; nothing of its processes, ports or files was
touched.

---

## 0. The clean-environment control, printed once per run — and this run FIXED it (D1.325)

**The derivation, boundary-aware (`-P`) and with the filter repaired:**

```sh
env | cut -d= -f1 | grep -E '^(CLAUDE|ANTHROPIC|NESSY|CODEX|PI|OTEL|DISABLE|MAX_|BASH_|MCP)' | sort |
  while read -r n; do
    c=$(git grep -aclP "(?<![A-Za-z0-9_])$n(?![A-Za-z0-9_])" -- packages apps | wc -l)
    [ "$c" -ne 0 ] && echo "$n -> $c file(s)"
  done
```

It printed **thirteen lines over a 31-name candidate set** — `ANTHROPIC_BASE_URL` 51, `CLAUDE_EFFORT` 19,
`CLAUDE_CODE_DISABLE_CRON` 12, `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` 11, `CLAUDE_CODE_SUBAGENT_MODEL` 10,
`DISABLE_AUTOUPDATER` 5, `CLAUDE_CODE_EXECPATH` 4, `CLAUDECODE` 2, `CLAUDE_CODE_OAUTH_SCOPES` 2, and four
at 1 (`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`, `CLAUDE_CODE_MESSAGING_SOCKET`,
`CLAUDE_CODE_MESSAGING_TOKEN`, `MCP_CONNECTION_NONBLOCKING`). Membership and every count are unchanged
from sittings 3, 4, 5a and 5b.

**The difference is that the thirteen are now the OUTPUT.** The recorded filter was `[ "$c" != 0 ]`, a
STRING comparison, and `wc -l` pads its output on this shell, so the value compared was the eight
characters `"       0"` and the test passed for every candidate. SIT-5a measured that and said so; this
lane fixed it, in `scripts/cdp/lib/app-env.ts`'s docblock and in `scripts/cdp/README.md`
(`a770a3350`). Both arms were measured on the same shell before the edit — `c=$(printf '' | wc -l)` is
`[       0]`, the string form PASSES and `[ "$c" -ne 0 ]` FILTERS, with `c=$(printf 'a\nb\n' | wc -l)`
passing the numeric form as the positive control so the fix is not merely stricter. No reading ever
moved: the counts beside the names always were the reading.

**The app's own read-back**, through `ps eww` on the RUNNING app and never on this process:
`{"pids":8,"present":{},"controlSeen":true}` at the first launch and `{"pids":12,…}` later with the
sibling lane's app up beside it — no contaminating name on any of them, `NESSY_CONFIG_DIR` seen in the
same read as the positive control, `appEnvBlockReason` `(clean)` every time.

**The rig precondition.** `RS-32` **PASS 8/8**, 60 053 ms at load 8.80: the one-click Pi card seeding
`tgpt/deepseek-v4-flash-0731` (the `coder` alias), its first turn answering `ready`, and the retired-id
control showing the host substituting the live id before the call with 0 info rows.

---

## 1. RS-43 / DA2.19 — the 1.40.0 FIXED bullet **reproduces as fixed**, with its control

The release note says: *"The app's network-proxy setting, and its extra CA with it, now reach the `dp`
sign-in."* The 1.39.0 reading it is measured against, from that sitting's own three-arm rig: *"with the
proxy in the app's `networkProxy` SETTING the re-mint SUCCEEDED and the rig proxy logged `as.tbank.ru`
**zero** times; with the same proxy in the environment it was refused **three** times in 121 ms"*. So the
arm to drive on 1.40.0 is the SETTING one and the discriminator is whether that host now appears in the
rig proxy's log at all.

### The rig, and the one thing that makes the reading mean anything

Two arms, **the same artefact, the same minute, the same shape**, differing in exactly one thing:

| | SETTING arm (`rig-p`, port 9234) | CONTROL arm (`rig-q`, port 9235) |
| --- | --- | --- |
| `networkProxy` | `enabled: true`, `http(s)Proxy: http://127.0.0.1:9233`, `noProxy: code-completion-nestor.tcsbank.ru` | **absent** — `{"enabled": false}` |
| proxy in the ENVIRONMENT | none (`HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` and their lowercase twins deleted by the launcher) | none |
| `NESSY_HOME` | a directory created EMPTY seconds before launch | a directory created EMPTY seconds before launch |
| `HOME` | a directory created EMPTY seconds before launch | a directory created EMPTY seconds before launch |

Both config dirs were created by letting the APP write its own `config.json` first (launch once, quit),
because a `config.json` a rig writes from nothing blocks startup on the storage dialog — the recipe's own
step 2. The `networkProxy` block was then merged into one of them and not the other.

### The readings

| reading | SETTING arm | CONTROL arm |
| --- | --- | --- |
| `as.tbank.ru` in the rig proxy's log | **5** | **0** (nothing of the app's reached the proxy) |
| `devplatform.tcsbank.ru` | **2** | 0 |
| the app's own doctor, before the turn | `no_credentials` / `absent` | `no_credentials` / `absent` |
| a credential written into the empty `NESSY_HOME` | **none — the directory is still empty** | **`dp_auth_creds.json`, 452 bytes, 12:16** |
| the app's own doctor, after | — (no card to turn on) | `ok` / `present` / *325 characters, jwt-shaped, claims decode* |
| the one-click card | **`[]` — it could not be created** | **`pi-api-key`** |
| the case's own verdict | FAIL on `the app lists at least one connection` | **PASS 5/5**, 26 504 ms |

**`as.tbank.ru`: ZERO on 1.39.0 with this setting, FIVE here.** The dp child now sees the operator's
proxy, which is the whole of DA1.59's fix (`9e4d54e22`, *"the networkProxy setting binds the dp exec
too"*, an ancestor of `61cfc4659`; `1a883ceb2`, the CA half, likewise; `getProxyEnvVars` occurs 19 times,
`applyNodeEnvProxy` 10 and `applyLoopbackProxyExemption` 9 over the artefact's own `Contents/Resources/app`).

**And the control is what turns that into a finding rather than a coincidence.** The rig proxy refuses
everything, so a dp child that obeys it cannot mint — and the arm that does not obey it mints in the same
minute, on the same artefact, through the same empty `NESSY_HOME`, with a 452-byte credential file to show
for it. Without that arm, *"the re-mint did not happen"* would be equally true of an empty `HOME` leaving
dp with no session of its own, which is the confound this rig shape carries by construction.

**Two further positive controls, both from the app rather than from the case.** The case's own `curl`
through the proxy is refused with exit 56 and leaves `example.com` in the log; and the app's update feed
appears there as `updates.invalid` within seconds of launch, which says the setting binds the MAIN process
independently of anything dp does.

### What the reading does NOT say, said here rather than left to be assumed

- **It does not say a re-mint through a proxy succeeds.** It cannot: `fixtures/refusing-proxy.ts` forwards
  nothing, deliberately (*"a forwarding mode would make this an egress path shipped in the tree"*). The
  re-mint failing here is the operator's own deny-all policy being applied to a child that used to escape
  it, which is what the fix is for. An operator whose proxy forwards would see the mint succeed through it.
- **The CA half of the bullet is NOT separately driven** — see §4.

### A PROPOSED ROW this drive earns

`rs-43.ts` `require`s *"the app lists at least one connection"* before its timing table. Under
`NESSY_CDP_RS43_REMINT=1` **on a proxied arm**, that precondition is now unreachable on a correct build:
the one-click card is created by a sign-in the proxy refuses. The case's own detail already says the right
thing (*"under the proxied arm this is itself the finding"*), but it says it as a FAILED REQUIRED CHECK,
which ends the run and files the row's own answer as a broken precondition. The row is written up in the
lane report; it is not fixed here, because changing that `require` into a branch changes the case's
contract and `rs-43.ts` is not one of this lane's reserved ids.

---

## 2. D1.95 — the index survives a restart on DISK and the product does **not** report it (case `RS-61`)

P2.62's sentence is *"a `running` record from a previous host process staying visible"*. Measure sitting 4
answered the STORE half on the packaged 1.39.0 and recorded the product half as blocked by D1.264 — the Pi
harness snapshot a live chat produces being rejected by its own parser. SIT-5a verified that fix on this
artefact (RS-56 7 of 9 against 3 of 9), so the half is drivable, and `RS-61` is the case P2.62 asks for.

It reads `window.electronAPI.listSessionScheduledWork(sessionId)` — the ONE read behind `ActiveTasksBar`,
behind `useSessionScheduledWork` and behind the `/tasks` transcript row, all three fed by
`projectSessionScheduledWork`, which is why one of them can be driven and spoken about as the user's view.
It deliberately does not re-read the store.

### Plant, restart, read

| step | reading |
| --- | --- |
| **plant** (PASS 2/2, 34 122 ms, host pid 69244) | a `bash_background` `sleep 900`, one permission card approved underneath, and the product's own answer for that session: `[{"id":"process_940c84316d5b4db2939fb936e9fe1b07","type":"shell","status":"running","description":"sleep 900","command":"sleep 900"}]` |
| the app `kill -9`'d, port proved free, relaunched on the SAME config dir | new host pid **71240**; the shell **survives the host** (`70196 sleep 900` in `ps`) |
| **read 1**, cold | `listSessionScheduledWork` → **`[]`** |
| **read 2**, after the planted session is navigated to AND clicked (6 messages load) | **`[]`** |
| the store on disk, at the same moment | `status: "running"`, `pid: 70196`, `pidStartMarker: "darwin:Fri Sep 18 12:34:13 2026"`, `owner: "<workspace>:e49a853b-…"`, and the `.running/process_940c…` index entry **present** |

**RS-61 read is FAIL 3 of 5, and the two FAILs are the row's own answer.** The three controls all hold:
the host really is a new process (the case BLOCKS when the two pids match); the process the record names
is really alive; and a session seconds old answers `[]` through the identical call, so "everything reports
running" is excluded — as is its mirror, because the plant phase read a NON-empty answer through the same
call in the previous host process.

So: **the index survives the restart; the product does not report it.** That is a product finding with its
controls and it is a proposed row, not a fix. It also narrows: read 2 rules out *"the record comes back
when you open the conversation"*, which was the first alternative worth excluding.

### Two rig facts this case paid for, both now in the file

- **`sleep` not being in `DANGEROUS_COMMANDS` does not mean it raises no card.** That list is about which
  spellings `persistBashAlwaysAllowRule` refuses to REMEMBER. The first plant sat at `processing: true`
  for its whole 240 s budget behind **two** unanswered cards. `approvePermissionsWhile` runs for the
  length of that one turn now and its count is reported (it approved 1).
- **Asked for "your background shell tool" the model reached for plain `Bash`**, which runs the sleep in
  the foreground and leaves the turn holding it. The prompt names `bash_background`.
- And the liveness control reads the record's own `command` in `ps` rather than a pid, because **the
  projection carries no pid** — a `process.kill(pid, 0)` control would have reported `unavailable` on
  every run, which is a control that never fires.

---

## 3. RS-46 / D1.14 — inverted, and it now passes on the build that used to redden it (D1.326)

SIT-5a drove `RS-46` on this artefact and read **FAIL 6 of 8**, with both FAILs being the row 1.40.0
closes: `/tasks` and `/workflows` are CONSUMED by the host now, where D1.14's premise was that the text
reaches the model. A case that reddens on the fix is a case the next sitting learns to discount, so D1.326
asked for the inversion.

Inverted (`bac6fde40`) and re-driven: **PASS 10/10**, 196 744 ms at load 12.75.

| token | assistant row | the durable `info` row it left |
| --- | --- | --- |
| `/help` (control) | none — consumed | *"Commands this session answers itself — they never reach the model: …"* |
| `/status` (control) | none — consumed | *"Connection for this session: Nessy Backend (API Key) …"* |
| `/tasks` (subject) | none — consumed | **"This session is holding no background work and has nothing scheduled."** — `SESSION_SCHEDULED_WORK_EMPTY_LINE`, its own handler's sentence |
| `/workflows` (subject) | none — consumed | **"No background work is running in this session right now. `/tasks` lists everything this session has queued, scheduled records included."** — its own handler's sentence |

The discrimination is that the two subjects write DIFFERENT sentences on one and the same session: each
arm asserts its own and refuses the sibling's, so *"an `info` row landed"* is never banked as *"this
command answered"*. Both scored `matchedItsOwnSentence: 1, matchedTheSIBLINGSentence: 0`.

**Two readings this drive produced that are not checks, on purpose.**

1. **The 1.39.0 reading that `/help` and `/status` persist nothing is REFUTED on 1.40.0** — both leave an
   `info` row in `getSessionMessages`. This is why the seam controls' durability is an observation and not
   a check: a guard asserting the old silence would have reddened on an improvement, which is the
   stale-guard shape this repo pays for elsewhere.
2. **A `/tasks` or `/workflows` submit leaves NO `user` row.** Roles after the submit are `["info"]` for
   both subjects against `["user","info"]` for both controls, in one run on one session — the sharpest
   control pair available for it. Both are dispatched from `SessionManager` ahead of the user-message
   append, as `/cd` and `/branch` are. The user sees an answer with no question. Recorded as a proposed
   row rather than scored: nothing states a posture for it.
3. The palette offers **no** row named `tasks` or `workflows` while the host parses both
   (`slash-command-actions.ts` spells neither), with `Help` and `Status` rows found as the control. The old
   check asserted that absence as a guard against the advertised-then-refused shape; that shape cannot
   exist once the parser carries the name, so it is a reading now — a discoverability complaint for the
   owner, not a defect.

---

## 4. RS-56 / D1.264 / D1.323 — the residue was the CASE's own request, and the case now reads 10 of 10

SIT-5a verified D1.264's fix on this artefact and recorded a residue: `listPiAgentView` throwing
`pi-agent-view-invalid` in BOTH arms, including on a session that had never run a turn — *"a WIDER statement
than the subject's"*. WI-ap (D1.323) set out to find the field the live payload carries that the closed list
rejects and found that **there is no such field**: the case called
`listPiAgentView({ session: target, limit: 20 })`, and that request type has exactly `schemaVersion`,
`cursor` and `limit`, so the REQUEST parser rejected it for two independent reasons — the unknown key and
the missing `schemaVersion` — before the manager was reached at all. That is why it threw in both arms: the
request never changes. The listing is per WORKSPACE and the workspace comes from the RPC context, which is
why there is nowhere to put a session.

Repaired here (`7a147051f`) and re-driven on this artefact:

| reading | 1.39.0 (sitting 4) | 1.40.0 (SIT-5a) | 1.40.0, repaired request (here) |
| --- | --- | --- | --- |
| `getPiHarnessRuntime` before the turn | answers | answers | answers (`barrierSeq` 12) |
| the same call AFTER one turn | **throws** | answers | answers (`barrierSeq` 26) |
| `listPiAgentView`, both arms | throws | throws | **answers, both** (`viewErr: null`) |
| the agent panel | did not mount | mounts | mounts, 2 rows over 1 child record |
| the case | 3 of 9 | 7 of 9 | **PASS 10 of 10**, 34 190 ms |

**So this surface has no residue on 1.40.0.** The caution the repair leaves behind is wider than the one the
file already carried: `pi-agent-view-invalid` is `fail()`'s one shared word in FOUR parsers in
`packages/shared/src/protocol/pi-agent-view.ts`, the REQUEST parser among them, so from outside the preload
the word cannot tell a rejected ANSWER from a rejected QUESTION — which is how this case came to report a
product defect for four sittings.

A rig fact the repair paid for: **a backtick inside the preload template literal closes it and the file
still looks right.** The first draft of the new comment spelled three identifiers house-style and produced
four `TS1005`s. AGENTS.md's trap, met in the same place it warns about.

---

## 5. D1.184 — RS-37 re-run on 1.40.0: sitting 4's verdict RE-CONFIRMED, and the switch legs have no subject here

`FAIL 4 of 7`, 323 792 ms, on the `codex-gateway` card. The shape is sitting 4's exactly: the CONTROL passes
— `ReviewDiff` ran on the probe diff and answered with the inline delegation template, so the review path is
alive — and `the notice arrived on: never` after the wait and both flush turns, with 0 cards. So
`startDetachedReview` returns `null` on this card on 1.40.0 too, and the C4.42 default re-take does not
reproduce here either.

Sitting 4's named discriminator stands and is still unreachable on this rig: *this card runs codex against a
gateway model codex has no metadata for; the discriminator is a codex card on a model codex knows.* Creating
one needs a real upstream credential, which is the owner's and not a sitting's.

**`rs-60` (the switch legs mid-review) is therefore NOT built**, and that is a measurement rather than a
budget decision: with no detached review thread there is nothing to abandon by switching, so a case written
here could only block. The id is left unclaimed for the rig day that has such a card.

---

## 6. RS-53 and RS-54 re-run on 1.40.0 — both reproduce sitting 3

| case | row | verdict | the reading |
| --- | --- | --- | --- |
| RS-53 | D1.235 | **PASS 6/6**, 126 780 ms | the control ladder found its rung (`CONTROL-2/edit-inside`, 1 approval) and the worktree turn raised **zero** in the same session and the same mode with 1 worktree created — *"reading 1 is dead: the documented non-suppressible approval is not reaching the host card at all"* |
| RS-54 | D1.33 | **PASS 8/8**, 124 730 ms | `Always Allow` on a `touch` card writes `Bash(touch *)` to the MAIN checkout, a second worktree made before the grant resolves to the same settings root, a non-Bash approval leaves no durable rule, and the rule survives the worktree's removal |

Both on `claude-gateway`, both on a rig whose app-env read-back was
`{"pids":4,"present":{},"controlSeen":true}` — four pids, not twelve, because of §7.

---

## 7. Two hand-backs taken in this lane's zone

**`lib/app-env.ts` — the process read is scoped to THIS rig's config dir (`63b3669be`).** SIT-5c measured
`pgrep -f 'MacOS/Nessy Desktop'` answering twelve pids while the lane that asked owned four. Unscoped, a
case reads its NEIGHBOURS' app environments and `appEnvBlockReason` can block a measurement over a variable
in somebody else's process — and it fails the other way too, because on a lane whose own app has died the
control appears in a sibling's process and `controlSeen` goes true for a read that touched nothing of this
rig. `appProcessPids(configDir?)` filters by `NESSY_CONFIG_DIR` inside each process's own environment (the
shape `cases/rs-72.ts` already used locally), and `readAppEnvContamination` defaults to it.

Measured here with three sittings live: **unscoped 12 pids, scoped 4**, the default read answering
`{"pids":4,"present":{},"controlSeen":true}`. Negative control on the same instrument: a config dir no
running app carries answers 0 pids and `controlSeen: false` with its own naming reason — so the filter
filters rather than matching everything.

`configDirScope()` deliberately does not fall back to a default path: a lane that never exported
`NESSY_CONFIG_DIR` has no scope to apply, and silently scoping to somebody's home directory would be worse
than not scoping at all.

**`cases/rs-56.ts` — the `listPiAgentView` request (`7a147051f`).** §4.

---

## 8. D1.207 — codex DOES emit traces, and `session.id` is on NEITHER resource (case `RS-59`)

The row's residue: *"`session.id` on the OTLP resource is proven by source reading and by P2.450's
`/v1/logs` drive, but never on the trace stream with `[otel] trace_exporter` on"*. Driven with both
exporters pointed at a loopback collector this lane added as a repo fixture
(`scripts/cdp/fixtures/otlp-collector.ts`), and the trace half splits in two.

| reading | answer |
| --- | --- |
| the instrument records `session.id` when a resource carries one | **yes** — a synthetic payload posted by the case comes back out of the log |
| codex's own `logs` requests arrive | **yes** — 3 in the turn's window, 6–30 KB each |
| codex emits on the TRACE stream with `trace_exporter` on | **YES** — 1 request, **647 846 bytes** |
| its TRACE resource carries `session.id` | **NO** |
| its LOG resource carries `session.id` | **NO** — the half the row records as already proven |

Every key codex does put on the trace resource: `env`, `nessy.telemetry.coverage`, `service.name`,
`service.version`, `telemetry.sdk.language`, `telemetry.sdk.name`, `telemetry.sdk.version`; plus `host.name`
on logs. The absence is total rather than a spelling the case missed, because the fixture records every key
it sees and only the VALUES of an identity allowlist.

**Where the logs half was proven matters and is not asserted here.** A RECORD attribute is not a RESOURCE
attribute, and this fixture deliberately reads only the resource — an OTLP payload carries the telemetry
itself, prompt text included on a runtime configured for it, so a log a run narrative quotes must not be
able to reach a record. The honest statement is: on the RESOURCE, at `codex-app-server 0.154.0`, neither
stream names the session. Whether it rides a record is a separate question and a separate instrument.

Two controls were added after a first drive got them wrong, and both are worth carrying:

- **the window is filtered to `service.name === 'codex-app-server'`** — the HOST has exporters of its own on
  the same endpoint (8 `logs` and 3 `metrics` requests in this rig's log), so an unfiltered window answers
  "telemetry arrived" about a run in which codex emitted nothing;
- **the session is MOVED onto the codex card and the binding read back** — the first drive's session bound
  to the profile's default Pi card, answered `ready`, and produced an absence of codex telemetry that was
  entirely the rig's.

The per-session control is run and NOT SCORED when no id exists at all, with that sentence recorded:
scoring it would file the absence twice and read as a claim that the id is a constant.

---

## 9. D1.40 — the first turn's spawn share, all three runtimes (case `RS-62`)

Driven in this sitting and written up in `2026-09-18-measure-sitting-5d.md` §1. The headline, because it
decides a follow-up row: **on claude the process start is 54 % of the first turn** (3 059 ms of 5 714 ms),
against 71 % on codex and 90 % on pi, so P6.288's *"if the spawn dominates on claude, `startup()` is a small
follow-up row"* is met.

---

## 10. What THIS sitting did not drive, with the premise re-taken

- **The CA half of the RS-43 FIXED bullet.** *"and its extra CA with it"* rides the same one function —
  `dpExecEnv` (`packages/shared/src/auth/dp/internal.ts`) spreads `getProxyEnvVars()` and then calls
  `applyLoopbackProxyExemption` and `applyNodeEnvProxy` — and both implementing commits are ancestors of
  the artefact (`9e4d54e22` the proxy, `1a883ceb2` the CA), with all three symbols in the shipped bundle
  (19 / 10 / 9 occurrences over `Contents/Resources/app`, `grep -rao … | wc -l`). It is **not separately
  driven**, and the reason is the instrument rather than the budget: `NODE_EXTRA_CA_CERTS` is ADDITIVE, so
  a rig CA reaching the dp child changes no outcome that a rig can see, and the one shape that would make
  it visible — a TLS endpoint signed by that CA and nothing else — needs a forwarding proxy this repo
  deliberately does not ship. NULL with that sentence; the proxy half is driven and the two travel in one
  expression.
- **`rs-60`, D1.184's switch legs.** Not built, and §5 is why: with `startDetachedReview` returning `null`
  on the only codex card this rig can create, there is no detached review to abandon by switching, so a
  case written here could only block. The id is left unclaimed.
- **The measure rows `D1.41`–`D1.54`.** `D1.40` is driven (§9); the rest are in
  `2026-09-18-measure-sitting-5d.md` §2 with a line each saying what a rig of this shape would need, and §3
  says where the sitting stopped.
