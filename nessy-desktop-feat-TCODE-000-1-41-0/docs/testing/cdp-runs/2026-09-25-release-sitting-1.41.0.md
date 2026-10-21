# 2026-09-25 — the 1.41.0 release sitting: first pass (lanes SIT-a … SIT-v) and post-rebuild re-check

The release sitting that the 1.41.0 plan's close-out requires (owner decision 2026-09-23: a live sitting before
close-out). The owner was away for the whole of it (owner 2026-09-25: "продолжай выполнять план полностью без
меня"), so nothing that needs the owner's own sign-in, key, account or machine was driven — each such item is
recorded as NOT_DRIVABLE with its reason, and the list is at the end.

Twenty-two lanes, SIT-a to SIT-v, each drove its own packaged app instance in parallel, six at a time at first and
up to about thirteen at once later. Every lane wrote a verdicts file outside the tree
(`work/sitting/SIT-<x>/verdicts.md`); this narrative aggregates the 22 FIRST-PASS files. It does not re-judge
them: a verdict below is the lane's own, and a FAIL is mapped to the plan row it became in
`docs/superpowers/plans/2026-09-18-integrations-followup-1.41.0.md`. Several FAILs were fixed during the sitting.
Those fixes landed AFTER the build the sitting drove, so they are verified by the post-rebuild re-check, which has
its own section at the end.

## Build

- **Artefact:** `release/mac-arm64/Nessy Desktop.app`, built by the controller from HEAD `5896a66d2` after
  `bun run electron:build:servers`, bundle mtime **2026-09-25 04:45:55**. `dist/main.cjs` and the staged Pi server
  are both 04:45:54, later than the HEAD commit (04:38:15). SIT-a's control: the last fix's string (F1.712,
  "another workspace's automation run history") occurs once in `dist/main.cjs`.
- It reports **1.40.0**: the 1.41.0 bump happens at close-out (F1.54), so every verdict records the sha and the
  mtime, not the version string.
- Built with `NESSY_FEATURE_PROVIDER_CHATGPT=1` and the documented local rehearsal update feed
  (`https://updates.invalid/dev`), so a failing update check is expected and is not a finding.
- Runtimes in the bundle, read by SIT-q: codex `codex-app-server` rust-v0.156.1 (the pinned sha256), claude
  `2.1.267 (Claude Code)` with the SDK's `claudeCodeVersion` agreeing, Pi server `VERSION = "0.85.1"`.

## Rig

- **One instance per lane.** Debug ports 9301 (SIT-a) to 9322 (SIT-v). Each lane had its own relocated
  `NESSY_CONFIG_DIR` and `--user-data-dir` under the untracked `work/sitting/<LANE>/`, `NESSY_DEBUG=1`, and the dark
  theme. No lane touched the real `~/.nessy-agent` or `~/.nessy`, read a token, or ran `dp auth login/logout`.
  Every lane stopped its own app by pid and proved its port free with `lsof`, with the other lanes' listeners as
  the positive control.
- **Profile P1.** Every lane built its gateway cards with the product's own one-click buttons: `pi-api-key`
  (pi_compat), `claude-gateway` and `codex-gateway`, all on `tgpt/deepseek-v4-flash-0731`. The machine's dp
  session was valid, and **no lane saw a browser or a login prompt**. P2 cards (fabricated-key BYO) were minted by
  the cases or the lanes themselves; P3 was built by SIT-m from an onboarded profile.
- **Mode.** `bypassPermissions` everywhere except checks whose subject is the card or the mode ([DEFAULT],
  [MODE=x]), per the owner's rule (D1.385, F1.86). The mode was read back from the session record.
- **Launcher repair (SIT-a, 05:20).** The README's `env -u` launcher, derived from the names the REPO reads, left
  **16** names from the lane shell (a Claude Desktop agent) in the app's environment: 14 `CLAUDE_*` names plus
  `DISABLE_MICROCOMPACT` and `MCP_SERVER_CONNECTION_BATCH_SIZE`. Six of them are spelled by the vendored claude
  binary (`CLAUDE_CODE_ENTRYPOINT` 91 occurrences, `CLAUDE_CODE_CHILD_SESSION` 21, `CLAUDE_CODE_SESSION_ID` 13,
  and three more, by `grep -aoF … | wc -l`), and the claude child's env is a spread of `process.env`, so they
  reach it. The repair adds `work/sitting/extra-u-names.txt` as further `-u` arguments; after it, a `ps eww` read
  of the main pid showed 0 names in the four families, with `NESSY_CONFIG_DIR` present as the control. Checks
  that ran BEFORE the repair are named in each lane's verdicts: SIT-d's claude arms of B1, B3–B8 and B11 and its
  first B10; SIT-f's C1–C4, C7 and C8; SIT-i's D1 and D3–D9 (Pi only); most of SIT-u (codex only); and SIT-v's
  first launch (the Pi rows plus claude's guard rows h, o, s and m, which are host-side refusals). Every later
  lane launched repaired.
- **Rig confound (SIT-f, widened by SIT-b).** A claude session whose working directory sits inside this repo
  makes the claude child read the repo's own `.claude/settings.local.json`: 171 allow rules, and a forced
  subagent model the gateway answers 404 for. A session with NO project runs in
  `<config>/sessions/<ws>/<sid>`, which is inside the repo too, because the lane dirs are. The fix is a
  `git init` in the lane root plus an own-`git init` project folder per session; SIT-b measured 171 → 0 rules on
  every later session. Claude readings taken before it: SIT-b's RS-105 claude arm, SIT-d's claude B-arms (B8 and
  the Stop error were re-driven in a git-inited folder and held), and SIT-f's first two C2 attempts, where every
  subagent 404ed.
- **Harness hazard (SIT-k).** Under load `freshSession` can fail with `session-created-but-not-opened`, and its
  fallback then sets the OPEN session to `bypassPermissions`. Arms that fell into it are recorded INVALID, never
  PASS or FAIL: SIT-q's CDX-150 run 3, SIT-r's first F1.15 control, SIT-s's RS-12 run-2 control. Plan row F1.775.
- **Load, and what it does to every number here.** The machine load average ran **13 to 50** across the
  sitting, with up to about **13 app instances** live at once (SIT-q counted 13). CDP `Runtime.evaluate` calls
  took 30–120 s at times, a debug-port attach took up to 54 s, one lane's main thread was sampled blocked in a
  synchronous `open()` (F1.794), and gateway turns took 30 s to 7 min. **Every duration in this narrative and in
  the verdicts is load-confounded: none is a performance claim**, and several arms were BLOCKED by the budget
  rather than by the product.
- **SIGTERM.** On most lanes the main process survived SIGTERM for 5–40 s on an ordinary view, not only on the
  storage dialog, and needed KILL (F1.782).

## Lanes

This table is the FIRST pass, on the build of `5896a66d2`; the re-check lanes on the rebuilt artefacts have their
own tables under Post-rebuild re-check. Counts are verdict ROWS as each lane wrote them (a row is usually one check
on one runtime); a compound cell is
classed by its first verdict word. "Other" is partial readings, measurements with no pass condition, and checks
skipped because another lane covered them. The every-lane observations (F1.82, F1.212, F1.215, F1.256) are not
counted here; they have their own section.

| Lane | Scope | Port | PASS | FAIL | BLOCKED | NOT_DRIVABLE | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SIT-a | §0 + A1–A6 | 9301 | 11 | 1 (rig: the launcher) | 1 | 0 | 0 |
| SIT-b | A7–A12 + F1.266 | 9302 | 12 | 1 | 1 | 1 | 2 |
| SIT-c | A13–A18 | 9303 | 6 | 1 | 4 | 0 | 0 |
| SIT-d | B1–B11 | 9304 | 25 | 0 | 6 | 0 | 0 |
| SIT-e | B12–B28 | 9305 | 11 | 0 | 4 | 2 | 0 |
| SIT-f | C1–C9 (claude) | 9306 | 6 | 0 | 3 | 0 | 0 |
| SIT-g | C10–C19 (claude) | 9307 | 10 | 0 | 0 | 0 | 0 |
| SIT-h | C20–C26 (claude, default) | 9308 | 1 | 2 | 4 | 0 | 0 |
| SIT-i | D1–D9 (pi) | 9309 | 6 | 3 | 0 | 0 | 0 |
| SIT-j | D10–D17 (pi) + E14 | 9310 | 6 | 0 | 2 | 0 | 1 |
| SIT-k | E1–E11 (codex) | 9311 | 7 | 0 | 4 | 0 | 0 |
| SIT-l | E12–E22 (codex) | 9312 | 6 | 3 | 2 | 0 | 0 |
| SIT-m | §F settings, boot, logs | 9313 | 4 | 1 | 4 | 4 | 0 |
| SIT-n | §G dp sign-in | 9314 | 4 | 0 | 0 | 8 | 0 |
| SIT-o | asks WJ-ac … WJ-ap | 9315 | 8 | 1 | 11 | 3 | 5 |
| SIT-p | asks WJ-am … WJ-ax + RG-1 | 9316 | 5 | 2 | 11 | 4 | 5 |
| SIT-q | asks WJ-bf … WJ-bv (lifts, ChatGPT titles) | 9317 | 7 | 0 | 8 | 4 | 0 |
| SIT-r | rows F1.14–F1.17, F1.60–F1.63 | 9318 | 9 | 0 | 6 | 2 | 1 |
| SIT-s | rows F1.64–F1.69 | 9319 | 1 | 0 | 5 | 0 | 2 |
| SIT-t | rows F1.70–F1.73 | 9320 | 2 | 1 | 3 | 0 | 2 |
| SIT-u | codex security asks (WJ-crit-a/f/g/i/j/n/p) | 9321 | 19 | 3 | 4 | 0 | 0 |
| SIT-v | Pi + claude security asks (WJ-crit-h/o/s/m/q/l/b/k/d) | 9322 | 24 | 6 | 5 | 0 | 0 |
| **Total** | | | **190** | **25** | **88** | **28** | **18** |

Of the 25 FAIL rows, one is the rig (SIT-a's launcher) and three are SIT-v's Pi CONTROL arms failing on the same
cause, a card in a bypass session (F1.256). The FAIL-to-row table below lists each distinct finding once.

## Results by section

### §0 — preconditions

The build (0.1) and the one-click profile (0.3) PASS on every lane. `bun scripts/cdp/run.ts --check` (0.4) exits 0
with no id missing either way. The clean app env (0.2) FAILED as a rig reading and was repaired on the spot (see
Rig).

### A — automated cases

- **A1 RS-39: PASS 13/13**, twice (SIT-a in 109 s; SIT-e, as B19, in 693 s). claude-gateway and codex-gateway
  render the SAME Nessy Gateway budget as the Pi control, and both BYO cards are refused. This is the first PASS on
  a build that carries F1.6; 1.40.0 scored 7/13 as the designed negative control. SIT-e's first run at the default
  30 s CDP ceiling scored FAIL 3/3 on a rig timeout (`createSession` took 24 s), which is not a product reading.
- **A2 RS-50: PASS 34/34.** Every gateway card's `/quota` and `/quota␠` render a budget on the store and on the
  screen, and never reach the model; the BYO card refuses.
- **A3 QL9: PASS 9/9 twice.** The re-run came straight after three AGENT-INSTALL runs on the same profile, and
  `capability-snapshot-revoked` occurred 0 times (F1.260).
- **A4 AGENT-INSTALL: PASS 9/9 on pi and on claude-gateway; BLOCKED on codex-gateway**, the documented null. The
  agent install tools sit in `SESSION_TOOLS_REQUIRING_HOST_CALLBACK` and are not bridged for codex, so "9/9 per
  runtime" cannot hold there. With codex sessions open in the workspace both installs answered `ok:true`, and
  `disposal-failed` occurred 0 times: F1.211 holds.
- **A5 MCP-W1: PASS 12/12 twice**, with a no-project session (workspace scope) and with a project-bound one.
- **A6 MCP-W2: PASS 25/25.** Codex asked for its own spelling and the host row was dispatched; a fresh nonce came
  back on all three runtimes.
- **A7 RS-105, the case's first drive: PASS on claude-gateway and pi, FAIL 22/23 on codex-gateway.** A codex
  session-scope `remember` wrote to the pre-storage-v2 path and answered with a relative path (F1.765). A5 is
  NOT_DRIVABLE by construction, and the dp-less arm reported `not-drivable-here` because this Mac has dp.
- **A8 RS-106: BLOCKED (budget).** About 45 turns at this load did not fit; it is on the re-check list.
- **A9 RS-107, the case's first drive: PASS (28/30).** The plugin command dispatched its body-only token on all
  three runtimes, and the hooks fired behind their cards on all three: **the first C6/C7 reading on pi**. The two
  reds are the pi C6 palette read, an instrument miss (F1.767), and the claude C7 control, whose fresh session hit
  a `sessions:get` timeout.
- **A10 RS-108, the case's first drive: PASS on every measured arm (15/16, pi, `default` read back).** A1 wrote
  `Bash(npm test *)` and never `Bash(npm *)`; A2 ran card-free in a new session; B, C, D and F asked; the
  interpreter heads offered no durable grant. The E-absolute arm is unmeasured, not failed: the model never issued
  `/bin/rm -rf ./build`.
- **A11 RS-81: PASS on both arms.** The Stop pressed with a message queued interrupted the turn with 0 further tool
  calls (D1.376), and the seam line was in the HOST file `<id>-claude-host.txt`, as F1.85 predicted (D1.81). The
  case's last check still reads red on a stale expectation: the host now records the receipt, and it is empty
  (F1.767).
- **A12 RS-97: PASS 7/7** on claude-gateway and pi. `/hooks` lists 32 hooks grouped by event, and eight events
  fired on both runtimes.
- **A13 RS-98 H25, hand arms: PASS on the capped arm** — one line written, the `[partial] … maxTurns` notice
  reached the parent, and `subagent {resume, input}` ran steps 2 and 3. **The uncapped control was BLOCKED**: its
  background child waited on a card nobody could reach (F1.763). On Pi `subagent` is background, so the notice
  arrives in the host's background-task notification, not in the spawn result.
- **A14, the add-marketplace surface (F1.81): PASS** (the landing and the failure note), with `fetch_timeout`
  rather than the expected `repository_ref_unresolved`: the app's GitHub fetch timed out while the shell reached
  github.com in under a second. RS-99's LSP route was driven by SIT-t instead (below).
- **A15 RS-05, A16 STR-2, A17 RS-79: BLOCKED (budget).** They are on the re-check list.
- **A18, RS-104's C1 control (a hand arm, not an arm of the case):** claude writes another workspace file in
  `acceptEdits`, and a Pi session WITH a project refuses it with the managed-storage sentence (both PASS). A Pi
  session WITHOUT a project writes it, because its primary root is the managed Workspace root: the documented
  "refused in every mode" premise is wrong, not the floor (F1.763).

### B — every runtime (SIT-d, SIT-e)

- **PASS on all three runtimes:** B2 (a queued file message survives a quit and relaunch), B3 (FIFO behind a
  queued file row), B4 (Stop with a queued follow-up: composer empty, one `Response interrupted`, queue paused, with
  the refill control), B6 (Send now after Stop), B7 (a queued row renders after answer 1, live), B10 (the Stop
  button does not come back after a mid-stream Stop) and B11 (a Stop from a second window).
- **B1:** the file arm PASSES on all three (Queue label, Steer and Edit disabled with their tooltips, the file
  quoted afterwards). The image clause is NOT_DRIVABLE: no gateway model accepts images, and the composer blocks a
  staged image with its reason.
- **B5: BLOCKED on all three.** A Stop settles in 0.35–1.4 s, faster than anything can be typed. The safety half
  held: the next send was never steered into the stopped turn.
- **B8:** claude-gateway PASS (re-driven in a git-inited folder); pi and codex BLOCKED (budget). **B9: BLOCKED**
  (no workflow command on P1).
- **B12–B17: PASS** — the `/btw` panel's single in-flight line, the inert chord, the caret handed back, `Esc Esc`
  never asking `/rewind`, a typed `/rewind` in the add-source popover sent as text, and no failed RPC for a
  renderer-minted id. Two side findings: `/btw <question>` typed in the MAIN composer asks the question but never
  shows the panel (F1.753), and the add-source popover's `capabilities:submitManagedEdit` throws an unhandled 30 s
  timeout while the agent turn keeps running (F1.754).
- **B19: PASS 13/13** (RS-39). **B23: PASS** (a parent label lists child-only chats and counts a chat once).
  **B26 and B27: PASS** in en and ru. **B25: partial** — the permission-mode drawer, mode chip and copy buttons
  are Russian; the rest was not driven.
- **B18, B20, B22, B24: BLOCKED** (budget). **B21: NOT_DRIVABLE** (no CJK input method on this Mac). **B28:** the
  dock pixels are NOT_DRIVABLE (no Screen Recording grant); the shipped `icon.png` is square and sha-identical to
  the source.
- Side findings: Pi's Read tool refused the session's OWN attachment ("Managed Nessy storage is not accessible to
  file tools") and the model fell back to `cat` (folded into F1.725); the attachment remove button has no
  `type="button"` inside the composer form (F1.733); codex sessions post loud sandbox info rows after a restart
  (F1.734); a claude session shows "81 active · 28 did not load" and the palette lists the operator's own
  `~/.claude` skills on a fresh profile (F1.735).

### C — claude-gateway (SIT-f, SIT-g, SIT-h)

- **PASS:** C1 (two mid-turn messages answered in order), C2 (a message during a subagent answered by the MAIN
  agent), C3 (a tool-less steer re-queued and replayed), C4 (a steer then Stop: paused queue, Resume sends once),
  and all of C10–C19. C8 is a partial PASS (plan approval lands in Manual; the `explore` arm was not run), and C9's
  compact half passes while its `/context` and "(outdated)" parts were BLOCKED.
- **C18 and C19 on the packaged build:** an unanswered PreToolUse card left by itself at 540.0 s, and a
  `claude_native` card at 549.5 s, both with the host's own sentence; a late click was a no-op, and a card answered
  in time ran the tool (F1.76, F1.169).
- **C26: PASS** on its Stop arm (the ask-user dialog leaves and the badge clears).
- **FAIL:** C21 — after a Stop, the cancelled Monitor card's tool row carries the SDK's generic rejection instead
  of the host's "cancelled because the turn was stopped" (F1.747); C24 — a model switch does not close a card that
  is up while no host turn runs, which may be a wrong premise on claude (F1.748).
- **BLOCKED:** C5, C6 and C7 (SIT-f: fixtures and state not reached in budget), C20, C22, C23 and C25 (SIT-h).
  C23's premise did not hold: a background claude subagent reported having no session MCP tools (F1.749). C6's
  subject was largely answered by SIT-o's WJ-ah readings (below).
- Findings on the way: a user Stop on claude-gateway rendered as a provider error (F1.731); after a Stop the steer
  sat both in the paused queue and back in the composer (F1.732); in `plan` mode the model could not write its plan
  file without a card (folded into F1.725); a quoted heredoc falsely matched `**/.env` (F1.761); a `sessionTitle`
  `UserPromptSubmit` hook dropped every plan-mode prompt (F1.758); and the bypass-mode notice landed in the wrong
  session (F1.759).

### D — pi (SIT-i, SIT-j)

- **PASS:** D2 (a cold `/recap` answers), D4 (a multi-tool turn renders each call once), D5 (the generated title),
  D6 (one retry row that counts down in place; it is removed rather than relabelled), D7 (a failed partial stream
  disappears and the retry streams fresh; retries exhausted end in ONE Connection Error card) and D9 (a
  `maxTurns: 1` subagent survives a 429). D6, D7 and D9 ran on a BYO card against a local fault server, because the
  gateway produced no 429; the gateway's own 5×15 s ladder is unmeasured.
- **D10, D11, D13, D16: PASS.** D14 and D15 are partial: D14's first arm and D15's second arm PASS, the others
  BLOCKED.
- **FAIL:** D1 — `/code-review` on Pi reviews in a BACKGROUND subagent, not in the same turn, and twice tells the
  user the `review` tool is unavailable (F1.728); **D3 — Pi could not submit a plan in either mode, so Accept &
  Compact was unreachable (CRITICAL, F1.725)**; D8 — a manual `/compact` shows no "Compacting…" and no Stop, so it
  cannot be stopped from the UI (F1.729).
- **BLOCKED:** D12 (no `dpJira` tool reached the Pi catalogue on this profile) and D17 (needs
  `NESSY_DEBUG_SSE_RAW=1` at launch; the re-take recipe is in SIT-j's verdicts).
- Findings on the way: the packaged Pi `Find` tool could not reach the bundled ripgrep (F1.727); the trust dialog
  advertises a `.claude/agents` agent that Pi's loader does not find (F1.730); a deferred SESSION tool reported as
  loaded answered "not found" on the next turn (F1.738); and a call to a deny-removed tool surfaced an internal
  error row that never names the rule (F1.756).

### E — codex-gateway (SIT-j, SIT-k, SIT-l)

- **PASS:** E1 (a hyphenated source's tool called first try), E2–E5 (memory toggles, the relocated config dir,
  `autoMemoryDirectory`, a moved `plansDirectory`), E8 (one card naming `mcp__sources__…`), E10 (allow, deny and
  no-rule on a hyphen-free source), E12 (Always Allow holds), E13 (a deny removes the tool), E14 (both path cards,
  driven by SIT-j and SIT-l), E17 (the auto-review floor refusal, 0.2 s after the call), E18 and E22.
- **FAIL:** E16 — the floor fires on re-enabling a bypass automation but its sentence never reaches the card
  (F1.778); E15 and E21's control — every host refusal on codex's MCP and patch paths reaches the model and the
  user as "user rejected MCP tool call" or "patch rejected by user" (F1.779); and E21's side finding, an APPROVED
  sandbox escalation still runs sandboxed (F1.780).
- **BLOCKED:** E6, E7 (budget), E19 and E20 (every auto-review consult 404s on the gateway, F1.724, and the hook
  payload could not be read), E9 (codex never raised `request_user_input`; the plan-mode question this raised was
  measured and REFUTED as F1.773) and E11 (`spawn_session` is absent from codex's tools, F1.774).
- Also measured: turning auto-review OFF does not reach a live codex session (F1.781).

### F — settings, boot and logs (SIT-m)

- **PASS:** F1 (the P3 `permissions/default.json` retirement, user entries intact, and the MCP `update_*_status`
  card in `default`), F2 (`boot.log` names each retired string once), F3 (the broken-`hooks.json` banner) and F4
  (a scheduled prompt lists and fires; an invalid `automations.json` adds its own note).
- **FAIL:** F8 — the cached managed policy does decline the scheduler (0 ticks against 58 in the control), but
  silently: no sentence in the log and the automation still shows as scheduled (F1.795).
- **BLOCKED (budget and load):** F5, F6, F7, F10. **NOT_DRIVABLE:** F9 (none of the seven shells installed),
  F11 (this Mac has dp), F12 (the dev playground needs a rebuild), F13 (a managed `HOME` delivery).
- Also measured: in `default`, Pi's deferred-tool loader raises its own card and costs an extra user turn
  (F1.796).

### G — dp sign-in (SIT-n)

- **G1: PASS.** dp 13.60.0 `print-token` prints the SAME needs-login sentence, exit 1, for never-logged-in,
  logged-out, a locally expired refresh token and a server-rejected one (the expired workdirs were fabricated), and
  the app classifies it as needs-login.
- **G2: PASS.** `print-token` refreshes lazily and silently: at 43 min left the token file did not move, at
  4.8 min or less it did, inside the run's own window; nothing else wrote it in 55 min.
- **G3(a): PASS** (`dp auth ensure` on a valid session: exit 0, one line, no browser, no write). **G10: PASS,
  reading 401** (not 403) for a valid-shaped but rejected JWT, on every gateway path probed; the app re-minted
  non-interactively and showed the in-chat sign-in card.
- **NOT_DRIVABLE:** G3(b), G3(c), G4, G5, G6 and G7 each start a browser login for the owner; G8 needs a
  non-login `print-token` failure, and none occurred; G9 needs a freshly provisioned machine.
- Wording finding: a rejected JWT whose `exp` is a year away shows "Token expired, refreshing session…" (F1.783).

### Asks and plan-row measures (SIT-o … SIT-v)

- **SIT-o (plugin monitors, `/tasks`, config notes).** A monitor tick reaches the model as a framed task
  notification, never as "The user just sent", on claude-gateway and pi (codex not reached). A Stop mid-turn
  leaves ONE notification, not a nested one. `/tasks` names the scheduled monitor with its skip sentence. An
  invalid `automations.json` in a live workspace shows its note in the pane. The bundle carries
  `--permission-request-hook`. FAIL: a tick handed back after a TOOL-LESS turn is shown once but stays ABOVE the
  answer (F1.793). The main thread was sampled blocked in a synchronous `open()` under load (F1.794).
- **SIT-p (background subagents, installs, spawn, proxy).** FAIL: turn 2 of the FIRST claude session of an app run
  respawned the child and killed a running background task, although F1.512's fix is in the build (F1.802). FAIL:
  Pi's deferred `web_search` was loaded three times and never became callable (F1.803). PASS: the Pi background
  notice control, the `acceptEdits` install card with Deny honoured and `remember` card-free, the `spawn_session`
  card in `default`, the first-Bypass dialog in en and ru, the proxy CONNECT half against a direct control, and
  the headless proxy warning from a checkout. Readings: the claude roster lists `Workflow` (F1.29), and the gateway
  card reports a USD cost (F1.30, F1.47). Two English aria-labels remain in ru (F1.804). Side findings F1.805–F1.808.
- **SIT-q (lifts, ChatGPT titles).** PASS: the "ChatGPT Plus (Pi)" and "ChatGPT (Codex)" onboarding titles; a turn
  on each lifted runtime (codex 0.156.1, claude 2.1.267, Pi 0.85.1) with no "unrecognized configuration" warning;
  the bypass notice quoting Claude's permission-modes page while an explicit ask rule still cards (F1.596); a
  claude exit-2 hook reading "blocked the action" (F1.516). BLOCKED: CDX-150's MCP half (rig), Pi compaction and
  its Stop (nothing to compact). A Bash-matcher guard hook does not bound `script_sandbox` (F1.812).
- **SIT-r (rows F1.14–F1.17, F1.60–F1.63).** F1.15: codex bypass wrote outside the workspace with 0 cards and the
  `default` control carded. F1.60: claude and codex do NOT auto-background an MCP call at 120 s; both wait inline
  (claude posts heartbeat rows), and both deliver the result. F1.62: a `disable-model-invocation` skill is absent
  from the model's listing and still dispatches when the user names it, on claude and codex. F1.63: nested skill
  discovery PASS on claude and on codex's roster. FAILs: a codex session given the unknown mode `ask` drops every
  message silently (F1.800); a legitimately slow MCP call made its source read "not responding" to other sessions
  (F1.801).
- **SIT-s (rows F1.64–F1.69).** F1.67: one expiry per question, PASS; on claude the clock is armed when the card
  MOUNTS, not when the question is asked (F1.818). F1.64: a codex plugin workflow ran uninterrupted and produced
  its artefacts, but the plugin's MCP server was deferred by our `tool_timeout_sec` cap (F1.819). F1.68 BLOCKED:
  the Guardian judge never answered (the fanout half is F1.739, fixed after this build; the one-turn half is
  F1.817). F1.69: A19 BLOCKED twice; A16 read that the host ignores a project-file `permissions.defaultMode` in
  both directions. F1.65, F1.66 BLOCKED; `CODEX_HOME` is now per session under `<config>/codex-home/`.
- **SIT-t (rows F1.70–F1.73).** F1.73, the Pi checkpoint arm, was driven end to end for the first time: the
  producer runs, a rewind holds across a quit and relaunch, and 5 of the 6 skip reasons were observed; a `sed -i`
  edit makes no checkpoint, and 100-checkpoint retention was priced rather than driven. F1.72: the registry
  blocker is gone and `typescript-lsp` installs, but Pi's LSP route delivered no diagnostics (FAIL, F1.809); the
  stock case cannot reach its subject (F1.810). A rewind that skips every file still reports success (F1.811).
  F1.70 and F1.71 BLOCKED (time).
- **SIT-u (codex security).** The codex protection layer held in every layout measured — the state-file
  placement, the codex-home placement, the durable-deny projection, card-free patch refusals and the
  `project-directory-managed` refusal — **except the home directory as the project, where the codex sandbox was
  OFF in every mode**: an agent wrote the durable-deny record, the global `hooks.json` (which the host then
  loaded) and `/Users/Shared`. **CRITICAL, F1.723.** Its sibling, codex auto-trusting a restricted project, is
  F1.750. Auto-review on the gateway card 404s every review (F1.724).
- **SIT-v (Pi and claude security).** The records guard held on every spelling driven, on both runtimes, in
  bypass and in `acceptEdits`: 20 refusals, 0 landed writes, every guarded file's hash unchanged. FAILs: the
  protected-path card offers "Always Allow" while saying the path is never approved automatically (F1.737);
  `call_llm` is unusable on the claude-gateway card (F1.736); and Pi bypass sessions raised cards for ordinary
  judged writes, which failed three Pi control arms (F1.256).

### Every-lane observations

- **F1.82, the unexplained exit: none.** No lane saw the app exit on its own, over about 19 hours of driving
  summed across the lanes. Every `boot.log` line written was a lane's own stop.
- **F1.212, the 30 s request timeout: seen widely, always under load.** Right after onboarding, most lanes'
  first screen read "Failed to load sessions — Request timeout: sessions:get (30000ms)" while main logged
  `rpc.getSessions` in under 1 ms; Retry recovered it every time. A `sessions:sendMessage` timeout on a message
  that was delivered appeared twice (SIT-b, SIT-e); `session:setModel`, `capabilities:getComposerCatalog`,
  `capabilities:submitManagedEdit` and `createSource` timed out on switches and creations that landed. F1.212
  stays a measure row.
- **F1.215, the spinner after Stop: never seen.** Every lane that pressed Stop (SIT-b, SIT-d on all three
  runtimes, SIT-f, SIT-h, SIT-o, SIT-r) read `isProcessing` false within seconds, and the Stop button did not come
  back.
- **F1.256, a card in a bypass session: Pi only.** Pi bypass sessions raised cards on SIT-a (4, AGENT-INSTALL),
  SIT-b (1), SIT-c (7 or more), SIT-i (7), SIT-p (3, every `mcp__tool_load`), SIT-t (16) and SIT-v (14 over 5
  sessions). The gate and the record both read bypass. claude-gateway and codex-gateway raised none, apart from
  SIT-q's explicit ask rule, which is documented behaviour. SIT-i and SIT-v measured two causes: a fenced judge
  verdict, and judges refused or timing out, so the fail-safe card rose. Fixed after this build by `784690ce4`
  (F1.256), with its regression F1.739 fixed by `af57e43e0` and the one-turn judge as F1.817.

## Every FAIL and its plan row

"Fixed" means a commit on this branch AFTER the sitting's build `5896a66d2`, so it is re-checked on the rebuilt
artefact. "Deferred" means born DEFERRED under the owner's 2026-09-24 rule and left for the owner after close-out.
State read from the plan at HEAD `356fcd5e2` (2026-09-25, about 12:05; the first version of this table read it at
`6eef56955`, about 09:00).
"Held on RC #1" is the re-check lanes' own verdict on the first release candidate (`69a6d33da`); the evidence is in
§ Post-rebuild re-check.

| Finding | Lane(s) | Runtime | Row | State |
| --- | --- | --- | --- | --- |
| The `env -u` launcher missed 16 lane-shell names, 6 read by the claude binary | SIT-a | rig | F1.825 | deferred; repaired on the rig, and RC #1's lanes found one more name (`CLAUDE_CODE_TERMINAL_MCP_TOOLS`), now in the repair list |
| Home directory as the project: the codex sandbox is off in every mode (CRITICAL) | SIT-u | codex | F1.723 | fixed `c0d8c8671`; sibling F1.750 fixed `a35ec7c7c`; both held on RC #1 |
| Pi cannot submit a plan in either mode (CRITICAL); claude's plan file needed a card; Pi's Read refused the session's own attachment | SIT-i, SIT-f, SIT-g, SIT-d | pi, claude | F1.725 | fixed `627363f22`, held on RC #1; the next step, Accept & Compact on a short Pi session, is F1.856 |
| Cards in Pi bypass sessions (judge fenced, refused or timed out) | SIT-i, SIT-v, SIT-p, SIT-t, SIT-c | pi | F1.256; F1.739; F1.817 | fixed `784690ce4`; fixed `af57e43e0`; fixed `04ca7c69a`. On RC #1 both measured F1.256 causes held and F1.817 held; SIT-y's "0 cards" arm still FAILED under load, failing safe (two judge timeouts carded, F1.857 deferred); F1.739's >100 arm not reached |
| The packaged Pi `Find` tool cannot reach the bundled ripgrep | SIT-i | pi | F1.727 | fixed `5b2578294`, held on RC #1 |
| A user Stop renders as a provider error | SIT-d, SIT-f, SIT-h, SIT-o | claude | F1.731 | fixed `d1d52cef0`, held on RC #1 |
| `call_llm` unusable on the claude-gateway card | SIT-v | claude | F1.736 (F1.757) | fixed `acdec0974`, held on RC #1 (F1.757 deferred) |
| A `sessionTitle` `UserPromptSubmit` hook drops every plan-mode prompt | SIT-g | claude | F1.758 (F1.771) | fixed `35ad612f6` (F1.771 `7aba1c8ec`), both held on RC #1 |
| Codex session-scope `remember` writes to the pre-storage-v2 path | SIT-b | codex | F1.765 | fixed `cb493486d`, held on RC #1 |
| The codex floor card for re-enabling a bypass automation is not named | SIT-l | codex | F1.778 | fixed `7079d0f5e`, held on RC #1 |
| F1.512 regressed: turn 2 of the first claude session respawns and kills a background task | SIT-p | claude | F1.802 (F1.821) | fixed `0f4c1a954`, held on RC #1 (the effort-clamp residue F1.821 deferred) |
| A Pi deferred builtin (`web_search`) is never callable after loading | SIT-p | pi | F1.803 | fixed `722c67605`, held on RC #1 |
| The Pi Guardian judge spends its one turn on a tool call and never answers | SIT-s | pi | F1.817 | fixed `04ca7c69a`, held on RC #1 |
| `/code-review` on Pi runs in the background and says the tool is unavailable | SIT-i | pi | F1.728 | deferred |
| A manual `/compact` on Pi cannot be stopped from the UI | SIT-i | pi | F1.729 | deferred |
| After a Stop the steer is in both the paused queue and the composer | SIT-f | claude | F1.732 | deferred |
| The protected-path card offers Always Allow | SIT-v | pi, claude | F1.737 | deferred |
| A deferred tool loaded in one turn is "not found" in the next | SIT-v, SIT-j | pi | F1.738 | deferred (F1.803 names it as a sibling) |
| The cancelled Monitor card's row lacks the host's sentence after a Stop | SIT-h | claude | F1.747 | deferred |
| A model switch does not close a card raised outside a host turn | SIT-h | claude | F1.748 | deferred |
| `/btw` typed in the main composer never shows the panel | SIT-e | all | F1.753 | deferred |
| The bypass-mode notice lands in the wrong session | SIT-g | claude | F1.759 | deferred |
| A no-project Pi session writes its workspace root (docs claim too much); a background child's card has nowhere to be answered | SIT-c | pi | F1.763 | deferred |
| Host refusals on codex reach the model as "user rejected" / "patch rejected by user" | SIT-l | codex | F1.779 | deferred |
| An approved sandbox escalation still runs sandboxed | SIT-l | codex | F1.780 | deferred |
| A tool-less turn's monitor line stays above the answer | SIT-o | claude | F1.793 | deferred |
| A scheduler declined at startup by the cached policy is declined silently | SIT-m | host | F1.795 | deferred |
| An unknown permission mode on codex drops every message silently | SIT-r | codex | F1.800 | deferred |
| Two English aria-labels in the Russian UI | SIT-p | ui | F1.804 | deferred |
| Pi's LSP route delivers no diagnostics; RS-99 cannot reach its subject | SIT-t | pi | F1.809; F1.810 | deferred |
| A codex plugin's MCP server is deferred by our `tool_timeout_sec` cap | SIT-s | codex | F1.819 | deferred |
| Auto-review on the gateway card 404s every review | SIT-u, SIT-l | codex | F1.724 | deferred |

Deferred side findings and measure rows born from the sitting, with no FAIL verdict of their own: F1.730, F1.733,
F1.734, F1.735, F1.749, F1.754, F1.756, F1.760, F1.761, F1.766, F1.767, F1.774, F1.775, F1.781, F1.782, F1.783,
F1.786, F1.794, F1.796, F1.797, F1.801, F1.805–F1.808, F1.811, F1.812 and F1.818.

Rows the FIX lanes raised while the sitting ran are not sitting findings and are not in this table: among them
F1.768 (fixed `b3b993984`) and F1.784 (fixed `e43189507`); F1.813, confirmed CRITICAL and fixed `166a62dbe`, with
F1.830 born from its lane (fixed `8087d49ea`); F1.814, closed as a REFUTATION (`ecb603ac2`: a Claude-form deny binds
the login-shell frame the shipped codex really sends; F1.823 and F1.824 deferred); F1.839 (fixed `e090d014d`); and
F1.820 (a red gate, fixed `791ad2477`). All of these are in RC #1; no first-pass verdict speaks for them, and the RC #1
lanes' readings of them are in § Post-rebuild re-check.

## What could not be driven, and why

- **The owner's own logins and accounts (owner away).** All of §H (H1 headless routes, H2 Bedrock, H3 the
  owner's Anthropic key, H4 `/quota` on a ChatGPT codex card, H5 ChatGPT Plus on Pi). The dp items that start a
  browser login: G3(b), G3(c), G4, G5, G6 and G7. Everything behind a ChatGPT subscription sign-in (SIT-q: F1.8,
  F1.572, F1.598–F1.602, F1.604, F1.624), the Pi anthropic-messages BYO turn and the strict-BYO half of F1.329.
  The owner-only rows F1.13, F1.18, F1.19, F1.20 and F1.568.
- **What the sitting rules forbid on a shared machine.** A real MDM profile (WJ-ag 4, WJ-az 1, WJ-bt 3); a
  separate macOS account for F1.14 and F1.15's denied-path arm, because the real denied file holds a live
  credential; a revoked dp credential for F1.17; the user's real `~/.zprofile` and a system `managed-settings.json`
  for WJ-ai; a rebuild for the dev playground (F12, F1.460).
- **What this Mac does not have.** A CJK input method (B21), a Screen Recording grant for the dock (B28), the
  seven shells of F9, a machine without dp (F11, G9, the dp-less RS-105 arm), a managed `HOME` delivery (F13), the
  iOS CI job (F1.436), a gateway model that accepts images (B1 and B2's image clauses), and a gateway 429 (D6, D7
  and D9 ran on a BYO fault server instead; F1.477 P5).
- **The budget, at this load.** A8 RS-106, A15 RS-05, A16 STR-2, A17 RS-79, B8 on pi and codex, B18, B20, B22,
  B24, C5, C6, C20, C22, C25, D12, D17, E6, E7, F5–F7 and F10, and many of the asks sections (SIT-o's codex arms
  and RE-TAKEs, SIT-p's WJ-ar, WJ-aq 2, WJ-ba 2–3 and RG-1's F1.49/F1.52/F1.53, most of SIT-q's WJ-b asks, SIT-r's
  F1.16 and F1.61, SIT-s's F1.65 and F1.66, SIT-t's F1.70 and F1.71, and a few security arms on SIT-u and SIT-v).
- **States the rig could not reach.** B5 (Stop settles before anything can be typed), B9 (no workflow command on
  P1), C7 (the correction landed at a tool boundary), C22 and C23 (their premises), E9 (codex never asked a
  question), E11 (`spawn_session` absent on codex), the Stop arms of D8 and of Pi `/compact` (nothing to stop),
  SIT-p's in-turn race, and the RS-108 E-absolute arm (the model never issued the command).

## Post-rebuild re-check

The first pass's fixes landed after the build it drove, so they are re-checked on rebuilt release candidates, one
subsection per candidate. As above, a verdict is the re-check lane's own and is not re-judged here; each new FAIL is
mapped to the plan row it became. RC #1 and RC #2 read each state from the plan at HEAD `4facfa6e4` (about 16:28; the
first version of the RC #1 subsection read it at `356fcd5e2`, about 12:05). RC #3 read them at `ce468be1d` (about
20:50), and so did the refresh of three RC #2 rows that were fixed after that build: F1.933, F1.845 and F1.944. RC #4
and the closing `## Verdict` read them at `963463931` (2026-09-26, about 01:00).

### RC #1 (`69a6d33da`)

**Build.** The controller built the first release candidate from HEAD `69a6d33da` between 10:13:46 and 10:21:22:
`bun run electron:build:servers` (rc 0), then `build-dmg.sh arm64` with `NESSY_FEATURE_PROVIDER_CHATGPT=1` and the
same local rehearsal update feed (rc 0). `release/mac-arm64/Nessy Desktop.app` has mtime **2026-09-25 10:20:01** and
reports **1.41.0** (the F1.54 bump `6628b4840` is in it). Codex integrity was verified (rust-v0.156.1), and the bundle
carries F1.803's new `mcp__tool_load` pin. Every fix in the first-pass FAIL table is an ancestor of `69a6d33da`, and
so are the fix-lane rows F1.768, F1.784, F1.813, F1.830 and F1.839. Each lane re-checked the shas its own checks depend
on with `git merge-base --is-ancestor`. F1.844 (`15df77cab`, 10:51) and every later fix are NOT in this build.

**Rig.** The rig was the first pass's: one instance per lane, a relocated `NESSY_CONFIG_DIR` and `--user-data-dir`
under `work/sitting/<LANE>/`, `NESSY_DEBUG=1`, the dark theme (recorded by SIT-x, SIT-y and SIT-ae), and profile P1
from the one-click cards, with no browser or login prompt on any lane. Each lane ran `git init` in its lane root before its first session and gave every
project folder its own `git init`. Each lane read the mode back from the session record after creating a session.
What was new:

- **Launcher gap: `CLAUDE_CODE_TERMINAL_MCP_TOOLS`.** On all four lanes the FIRST launch still carried one name from
  the lane shell. It was in neither the README's derived list nor SIT-a's `work/sitting/extra-u-names.txt`. Every
  lane stopped that launch before any session and relaunched with one more `-u`; SIT-x and SIT-ae unset every
  `CLAUDE_*`, `ANTHROPIC_*`, `MCP_*` and `DISABLE_*` name in the shell. A `ps eww` read then showed 0 names in the
  four families, with `NESSY_CONFIG_DIR` present as the control. **No verdict below comes from a contaminated
  launch.** The name is now in `work/sitting/extra-u-names.txt`, and `sit-common.md` tells later lanes to re-read
  it. Whether the product or the claude child reads it was not measured. The row for the launcher is F1.825.
- **A case process needs the relocated config dir too.** SIT-w's first RS-105 run was started without
  `NESSY_CONFIG_DIR` exported for the CASE process, so the case read the real `~/.nessy-agent` from disk. Those reads
  are read-only and nothing was written. The lane stopped at A2 and re-ran with the variable exported (F1.852,
  deferred).
- **Load.** The load average was about 10–12 throughout (SIT-x read 10–11, SIT-y 11–12), with several sitting apps
  live: SIT-w's port check saw 16 other Nessy listeners and SIT-ae's saw 10. As on the first pass, **every duration
  is load-confounded and none is a performance claim.**
- **Harness hazards met.** SIT-x's first `freshSession` hit a `cdp-timeout` and fell back to the open session, whose
  mode the lane read back as bypass (F1.775). SIT-y's typing arm writes into the DISPLAYED session, so its partial
  F1.739 arm landed in another session and is recorded INVALID.
- **The five later lanes.** SIT-z (RS-106's first drive, 10:59–12:02) and SIT-aa to SIT-ad (the carry-over checks,
  run on RC #1 while RC #2 waited for the fix lanes) launched with the 17-name list from the start; SIT-ab and SIT-ad
  also unset every name of the four families in the shell. `ps eww` read 0 names on every launch. SIT-aa and SIT-ad
  record a pause on an API rate limit after launch; all four drove between about 13:52 and 14:35. Load: SIT-z
  10.6–13.3, SIT-ab 6–7, SIT-ad 5.9 at the start and 18.8 at 14:17. Lane-specific rig: SIT-aa gave its case processes
  `NESSY_CDP_APP_LOG` pointing at its own stdout log, because STR-2's and RS-05's log readers otherwise read the shared
  `~/Library/Logs/Nessy Desktop/main.log` (F1.909). SIT-ab's first launch stopped at the storage dialog because it had
  seeded `hooks.json` before first boot; no check ran on it (F1.898). SIT-ac's second launch carried
  `NESSY_DISABLE_BACKGROUND_TASKS=1` for its foreground Pi arm, and SIT-ad's carried `NESSY_SUBAGENT_MODEL` for
  F1.588. On SIT-z the pane-follow hazard met a slash command: `freshSession` reported a fresh session while the
  composer still belonged to the previous one, so the case typed `/skill-creator` into the wrong conversation (F1.877).

**Lanes.** The same convention as the first-pass table: verdict rows, classed by the first verdict word, with the
every-lane observations counted separately below. The first four lanes ran first; SIT-z and SIT-aa to SIT-ad
followed on the same build.

| Lane | Scope | Port | PASS | FAIL | BLOCKED | NOT_DRIVABLE | NOT_IN_BUILD | Other |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SIT-w | codex: F1.723, F1.750, F1.765 (RS-105), F1.778, F1.839; E6, E7 | 9321 | 17 | 0 | 1 | 0 | 1 | 0 |
| SIT-x | claude-gateway, with Pi and codex arms: F1.768, F1.784, F1.758, F1.771, F1.725, F1.731, F1.736, F1.802 | 9322 | 22 | 4 | 0 | 0 | 0 | 0 |
| SIT-y | pi: F1.256, F1.803 (with SIT-p's F1.50 arm), F1.727, F1.725, F1.758, F1.739 | 9323 | 9 | 4 | 4 | 0 | 0 | 0 |
| SIT-ae | the morning fixes: F1.813, F1.830 (claude), F1.817 (pi), F1.839 | 9329 | 10 | 1 | 1 | 0 | 0 | 1 |
| SIT-z | §A8: the RS-106 case run whole on pi, claude-gateway and codex-gateway (F1.148, F1.156) | 9324 | 16 | 1 | 0 | 0 | 0 | 1 |
| SIT-aa | §A15 (RS-05), §A16 (STR-2), §A17 (`remember` scopes), §F5–F7, §F10: F1.77, F1.238, F1.75, F1.151, F1.236, D1.425 | 9325 | 10 | 0 | 4 | 0 | 0 | 0 |
| SIT-ab | codex hooks, whole-server MCP deny, plugin-monitor ticks (SIT-l and SIT-o carry-overs): F1.482, F1.382, F1.371, F1.771, F1.485, F1.496 | 9326 | 9 | 1 | 0 | 0 | 0 | 1 |
| SIT-ac | subagent approvals: F1.70 (A57 on Pi), F1.527, F1.71 | 9327 | 7 | 0 | 1 | 0 | 0 | 1 |
| SIT-ad | the SIT-q carry-overs: F1.593, F1.536, F1.547, F1.588, F1.524/F1.541 and more | 9328 | 5 | 2 | 8 | 1 | 0 | 0 |
| **Total** | | | **105** | **13** | **19** | **1** | **1** | **4** |

"Other" is SIT-ae's check 3b, INCONCLUSIVE: the arm named the exact command, so the Guardian's tier 4 honoured
explicit intent and the arm could not test whether an unsafe action still cards. SIT-w's two NOT_DRIVABLE rows are its
F1.212 and F1.215 observations, so they are not counted. SIT-w's one red outside its own checks (F1.851) is not a
verdict row. Of the 9 FAIL rows, SIT-x's two block-hook controls are one finding (F1.864), SIT-x's crit-u #1 and
SIT-y's F1.725 #1b are one finding (F1.856), and SIT-y's F1.256 #1 fails safe under load (F1.857).

Among the later lanes, SIT-z's "Other" is its claude `/skill-creator` row (the case arm INVALID, the hand arm PASS),
SIT-ab's is WJ-ah(2) (not re-run: claude-only and already F1.793), and SIT-ac's is its rig-premise finding about
arranging a foreground Pi subagent. SIT-z's one FAIL is the only one of the RS-106 case's eight reds that the lane's
re-score left standing. SIT-ac's table has no FAIL row, but its FAILS section lists five findings, mapped below.

**What each first-pass fix did on RC #1.** "Held" is the lane's PASS on the check that re-runs the fix.

| Row | Fix | On RC #1 | Evidence |
| --- | --- | --- | --- |
| F1.723 (codex, home as the project) | `c0d8c8671` | held | SIT-w crit-t #1a–#1d, #2 and the trusted-`danger-full-access` arm. Every protected write was refused in default, in bypass and after a refork: the data-folder records, `hooks.json`, `permissions/default.json`, the codex-home rules file and `/Users/Shared`. SIT-u's FAIL 1 does not reproduce. The `/Users/Shared` refusal takes a new form: the escalation is declined with no card, and the tool row reads `completed` |
| F1.750 (codex auto-trust) | `a35ec7c7c` | held | SIT-w crit-aa #1 (with a synthetic twin), #2 (control) and #3. "Keep restricted" leaves `trust_level = "untrusted"`, and none of the `~/.codex` MCP servers start. "Trust project" loads the layer, and a subfolder the user trusts keys the trust on the repo root |
| F1.725 (plan files, attachments) | `627363f22` | held; the next step is a new FAIL | SIT-x crit-u #1–#5, SIT-y #1a and #3. Pi (plan and explore) and claude write their plan files with no card, and SubmitPlan opens the plan card (Pi explore answers `plan-not-ready`, F1.760, as the ask predicts). Pi reads its own attachment (SIT-x), and the data folder's `skills/` stays refused. **Accept & Compact on a short Pi session dead-ends** (SIT-x crit-u #1, SIT-y #1b) → F1.856. SIT-y's attachment arm and its `hooks.json` control were BLOCKED |
| F1.256 (cards in Pi bypass), with F1.739 and F1.817 | `784690ce4`, `af57e43e0`, `04ca7c69a` | both measured causes held; the 0-cards arm FAILED under load, failing safe | SIT-y: one hidden judge per consult, 8 consults all admitted, a fenced verdict accepted, `mcp__tool_load` with 0 cards, and the hard-deny control refused with no card. 2 of 5 `seq` consults ran past the 60 s budget under load and raised a card each (F1.857, deferred). F1.739's >100 arm: BLOCKED(budget). F1.817 held on SIT-ae 3a and 3b: the judge answered with a verdict both times, and "could not answer" occurred 0 times. 3b's judge raised a read card of its own (F1.861) |
| F1.727 (Pi Find, ripgrep) | `5b2578294` | held | SIT-y F1.727 #1 and #2: Find and Grep answer on the packaged build. Side reading: `**/*.md` omits root-level files (F1.859, deferred) |
| F1.731 (a Stop as a provider error) | `d1d52cef0` | held | SIT-x crit-x #1–#3: three Stops, no Error box and no `ede_diagnostic`, and the child was reused afterwards |
| F1.736 (`call_llm` on the claude card) | `acdec0974` | held | SIT-x crit-y #1–#3: `call_llm` with and without a model, `/btw`, and generated titles. F1.757 stays deferred |
| F1.758 and F1.771 (a user hook in plan, explore, dontAsk) | `35ad612f6`, `7aba1c8ec` | held on every mode driven | SIT-x crit-bb #1, #3, #4 and crit-ee #1, #3; SIT-y F1.758 #3. The block-hook CONTROLS (crit-bb #2, crit-ee #2) FAILED on claude: the prompt is stopped, but the hook's reason is shown nowhere (F1.864, deferred) |
| F1.765 (codex `remember`) | `cb493486d` | held | SIT-w crit-cc, RS-105 on codex: every F1.765 arm PASSED. The session-scope `remember` wrote the session's own `data/MEMORY.md`, and the pre-storage-v2 scaffold stayed empty. The case itself reads FAIL 11/13, because its two A2 reds are F1.851 |
| F1.778 (the codex floor card) | `7079d0f5e` | held | SIT-w crit-gg #1 (the floor's sentence leads the card, "cannot be remembered") and #2 (the no-op control keeps Always Allow) |
| F1.802 (claude turn-2 respawn) | `0f4c1a954` | held | SIT-x crit-ii #1, on SIT-p's exact precondition: the thinking value changed between turns 1 and 2, the child did not respawn, and the background task reported back. #2, the control: leaving bypass respawns the child and names its key. F1.821 stays deferred |
| F1.803 (a Pi deferred builtin) | `722c67605` | held | SIT-y: after `mcp__tool_load`, `web_search` and `web_fetch` are callable in the same reply, and on the next user message with no reload. That arm's web search surfaced a new FAIL, F1.853 |

The fix-lane rows the first pass did not find were re-checked too:

- **F1.813** (`166a62dbe`) held: SIT-ae 1a–1c, a deny names the rule in bypass and in Manual with no card, with both
  no-rule controls.
- **F1.830** (`8087d49ea`) held in bypass and in Unattended (SIT-ae 2a, 2c, 2d) and FAILED in Manual (2b) → F1.860.
- **F1.839** (`e090d014d`) held on codex (SIT-w) and on claude (SIT-ae 4a–4c). Its codex MCP-only folder (4d) was
  BLOCKED(budget).
- **F1.768** (`b3b993984`) held: SIT-x crit-dd #1 and #2, with four detectors, each with a positive control.
- **F1.784** (`e43189507`) held for ALLOW rules on all three runtimes (SIT-x crit-hh #1–#3). Its DENY-rule mirror
  FAILED (crit-hh #4) → F1.863.

Not in the build:

- **F1.844** (`15df77cab`, landed at 10:51). SIT-w reproduced it live and recorded it NOT_IN_BUILD: a repo subfolder
  that was never asked about, under a root carrying `.codex`, gets `untrusted` and silently loses the root layer.

Not reached by the first four lanes, all BLOCKED(budget) (the later lanes' are in their own bullets below):

- F1.739's >100 arm.
- F1.256 #3 and #4: the `/code-review` reviewer, and two borderline Auto actions.
- SIT-y's Pi attachment arm.
- F1.839's codex MCP-only folder.
- F1.830's dontAsk branch that refuses by naming the rule.
- A Guardian arm with a general request or a hard-deny action.

First-pass BLOCKED arms re-driven:

- **E7: PASS.** A `PostToolUse` hook on a codex MCP call shows its run in `/hooks` (F1.274).
- **E6: BLOCKED(rig) again.** No fault knob can force a runtime-refresh failure, and a local fixture cannot be
  installed.

**What the later RC #1 lanes found.** These ran checks the first pass could not reach, mostly on rows fixed before
the sitting's build. "Held" is the lane's own PASS.

- **SIT-z, the RS-106 case run whole (§A8), 2732 s.** The case reads **FAIL 27/35**. The lane re-scored every arm
  from its transcript with the case's own detector. The skill BODY reached the model in 21 of 21 skill×runtime cells,
  the palette listed all seven skills on all three runtimes, and the no-selection control leaked 0 windows on all
  three. ReviewDiff separates the skill on claude and codex, not on pi. Seven of the case's eight reds are the
  instrument (F1.877). The eighth, pi `/loop` stopping on a card in bypass, is F1.876. `/loop` really schedules on
  claude and codex (`CronCreate` plus `ScheduleWakeup`); whether it stops when its session is deleted was not
  asserted (F1.878).
- **SIT-aa, §A15–A17, §F5–F7 and §F10.** A17, driven by hand and not through the RS-79 case file: scope `project`
  saves to the project's `MEMORY.md` with a project and gives the named refusal without one, and scope `user` saves
  on claude and codex (F1.75, F1.151). A15 by hand: on Pi the restore-files button is offered on the anchors before a
  real edit, absent after it, and absent on every open of a no-edit session, and pressing it fires the toast (F1.77).
  The RS-05 case itself was BLOCKED by its rig. A16, the STR-2 case on claude-gateway: the correction was answered as
  its own turn, once, under the same transcript id; the case's three FAIL checks read log lines this packaged build
  never writes (F1.238). F7: the external-vendor disclosure fires on a `tgpt/` → `anthropic/` switch and on a
  baseUrl edit to a vendor host, with dpFs withheld (D1.425, F1.110, F1.143). F6: a bearer API source logs header
  names only, and the fabricated bearer occurs 0 times in every log (F1.236); the query half was BLOCKED because the
  query-auth source exposed no tool (F1.906). F5 and F10: BLOCKED(budget).
- **SIT-ab, codex hooks and plugin monitors.** A whole-server MCP deny withholds all four of the server's tools with
  auto-review on (F1.482). A user-tier `PermissionDenied` command hook runs with no card in default and in dontAsk,
  and its payload carries the host's `mcp__<source>__<tool>` name and the call's own arguments; a workspace-tier copy
  is refused in dontAsk with the named sentence (F1.382, F1.371, F1.771, F1.784). SIT-l's two BLOCKED payload reads
  are therefore PASS. A monitor tick reaches codex and claude framed as a host notice, never as the user, draws one
  line per tick, and keeps its place across a restart (F1.485, F1.496). The runtime-switch cost line reads the new
  wording in en and ru (F1.482, F1.368). The Stop hand-back of a tick on codex FAILED (F1.896).
- **SIT-ac, subagent approvals.** A57 was driven on Pi in `default`, foreground and background: the child's ruled
  command raises one card naming the rule and the subagent, Deny stops only that call, and the no-rule commands run
  with no card (F1.70, now closed). F1.527's expiry works at the host: both expired requests left at 540 s, a restart
  brings nothing back, and an in-time Allow runs the command. F1.71: claude `SendMessage` resumes a completed agent
  with its context and refuses a fabricated id, and codex children inherit `list_sessions` and `send_agent_message`;
  the negative control was not met, on self-report only, so F1.71 stays partial.
- **SIT-ad, the SIT-q carry-overs.** With `plansDirectory: "."` a Pi write to `../job/tmp` is carded (F1.536), and
  Explore's hint names the current session (F1.547). `NESSY_SUBAGENT_MODEL` reaches a claude subagent that has no model
  of its own and leaves one that has (F1.588). Stop Task on a background subagent closes its pending approval at once
  (F1.524, F1.541). The Pi half of the `$CLAUDE_JOB_DIR` exemption FAILED (F1.899), and so did the precondition that
  a background subagent's card stays on screen (F1.900). WJ-bt 1 is NOT_DRIVABLE: it needs a root-owned system file.
  The rest was BLOCKED: WJ-ba #2 and WJ-aq #2 by the rig (plugin tools accept only an https source or a marketplace
  id), and WJ-bd 1/2, WJ-bb 1/2, WJ-bv 2, WJ-bp 1–3 (also the rig), WJ-bs 1, CDX-150's MCP half and SIT-p's carry-overs by budget.

The deferred first-pass rows were not re-checked; they stay deferred.

**Every new FAIL on RC #1 and its plan row.**

| Finding | Lane(s) | Runtime | Row | State |
| --- | --- | --- | --- | --- |
| Pi `web_search` sends the gateway credential to `api.openai.com` (CRITICAL) | SIT-y | pi | F1.853 | fixed `2fc70c1fc` (after RC #1) |
| A mid-stream upstream failure crashes the Pi subprocess (CRITICAL) | SIT-y | pi | F1.854 | fixed `e2997eaf3` (after RC #1) |
| Hidden judge sessions pile up in All Sessions as "New chat" rows (a SIT-y note; CRITICAL once measured) | SIT-y | pi | F1.855 | fixed `57ec3783d` (after RC #1) |
| Accept & Compact on a short Pi session dead-ends: no plan turn, and the card loses its Accept | SIT-y, SIT-x | pi | F1.856 | born deferred, upgraded to CRITICAL on SIT-x's reproduction; fixed `e3f6969fc` + `08be21073` + `eb3c0c6f6` (after RC #1) |
| In Manual, "Allow for this session" on an ask-rule card silences the rule for the session (CRITICAL) | SIT-ae | claude | F1.860 | fixed `474b64fc1` (after RC #1) |
| The Guardian judge's own read card shows the planned action, and its Deny does not deny that action (a SIT-ae note; CRITICAL) | SIT-ae | pi | F1.861 | fixed `836fe85c1` (after RC #1) |
| A structural deny rule plus a compound user prompt hook drops every prompt, and the refusal names neither (CRITICAL) | SIT-x | pi | F1.863 | fixed `9fa33e612` (after RC #1) |
| A bare pi `/loop` in bypass stops on an `mcp__tool_load` card: the Guardian judge is handed the skill BODY as trusted intent and follows it (CRITICAL) | SIT-z | pi | F1.876 | fixed `3aa3a4b98` (after RC #1) |
| On Pi in Manual, a write to `$CLAUDE_JOB_DIR/tmp/…` is approved as session scratch with no card and lands in the system `/tmp`, because Pi's shell has no `CLAUDE_JOB_DIR` (CRITICAL) | SIT-ad | pi | F1.899 | fixed `51c199a30` (after RC #1) |
| A background subagent's pending card leaves the chat when the parent turn (or the next one) ends, while the host still holds the approval | SIT-ad, SIT-ac | claude | F1.900 | born critical if it measured; fixed `e7c514c6d` (after RC #1) |
| Pi's ask-rule card does not show the command it asks about | SIT-ac | pi | F1.902 | born critical if it measured; fixed `b8142381b` (after RC #1) |
| The SDK's `agent_summary` fork raises its own request for the subagent's pending command, so one action counts twice | SIT-ac | claude | F1.901 | upgraded to critical if it measured; closed as a REFUTED premise, pinned by the test `8eb2b456f` (an Allow on the duplicate runs nothing) |
| On codex a monitor tick steered live and then Stopped never reaches the model, while the transcript shows it delivered | SIT-ab | codex | F1.896 | deferred |
| An API source with `authType: 'query'` exposes no callable tool (why SIT-aa's F6 query half is BLOCKED) | SIT-aa | host | F1.906 | measured at master `27ff96dde`: not a regression, and the premise corrected (a new server instance's first turn lacks the tool, for any auth type); MEDIUM, deferred |
| A no-project Pi session cannot `Write` its own working directory (why RS-05's Pi control cannot pass on a no-project rig) | SIT-aa | pi | F1.907 | measured at master: not a regression, and the premise corrected (the session is told the session folder while its tools run in the workspace root); MEDIUM, deferred |
| A Pi child's card did not raise the parent's `awaitingApprovalCount` (unconfirmed) | SIT-ac | pi | F1.903 | deferred |
| RS-106 mis-measures seven of its arms (re-scored by SIT-z) | SIT-z | cdp | F1.877 | deferred |
| A built-in dp MCP server switched off still answers `listMcpTools` (RS-105's A2 red) | SIT-w | host | F1.851 | deferred |
| The judge runs past its 60 s budget under load, and a bypass turn raises cards | SIT-y | pi | F1.857 | deferred |
| On claude a prompt hook's `decision: block` reason is not shown | SIT-x | claude | F1.864 | deferred |

Deferred side findings and measure rows born from RC #1, with no FAIL verdict of their own: F1.852 (the case
process's config dir), F1.858 (Pi plan mode refuses `mcp__tool_load`), F1.859 (the Find glob), F1.862 (a trusted
claude project's skill loads but the model does not list it), F1.865 (SIT-x's single readings: a 33 s silence in
the main process, a "Hold on…" Stop before any message, and claude's SubmitPlan row marked `isError`), F1.878 (does a
`/loop` stop with its deleted session), F1.897 (a stale codex Bash row and shell chip after a Stop), F1.898 (a
Claude-shaped `hooks.json` is rejected and runs 0 hooks), F1.904 (Pi's `worker` needs a committed repository; a bypass
Pi model served a fixture from its own `git daemon`), F1.905 (the scratch-folder docs), F1.908 (the `[model-target]`
disclosure prints twice and contradicts the next line) and F1.909 (SIT-aa's side readings). SIT-ab also widened F1.747
(a long Bash call that completed leaves its heartbeat rows `executing`), and SIT-ac's rig finding and unmet negative
control are recorded on F1.70 and F1.71.

Rows the fix lanes raised after RC #1 are not sitting findings and are not in this table: F1.847 (fixed `d94c1c2c4`,
raised from F1.844's lane), F1.869 and F1.870 (raised from F1.860's lane, fixed `98978a3b3` and `f13cbb5c6`), F1.889
(raised from F1.876's lane, fixed `02e56c792`), F1.912 (born and fixed with F1.902, `b8142381b`), F1.895 (a red gate,
fixed `271a64eaf` + `c9fd83192` + `68cf3251e` + `673b0088d`), and, all deferred, F1.866–F1.868, F1.871–F1.875,
F1.879–F1.888, F1.890–F1.894, F1.910, F1.911 and F1.913–F1.919. Every fix that landed after `69a6d33da` is for RC #2
to re-check.

**Every-lane observations on RC #1.**

- **F1.82: no unexpected exit** on any lane: SIT-w about 30 min, SIT-x 43:58, SIT-y about 40 min, SIT-ae 43 min.
  Every `boot.log` line is a lane's own stop. SIT-w's SIGTERM quit cleanly in under 5 s and removed every codex home;
  on the first pass the same quit took 5–40 s (F1.782). That is one reading.
- **F1.212: not seen.** SIT-x, SIT-y and SIT-ae saw 0 `Request timeout` lines. SIT-w sent its prompts through the
  RPC, not the composer, so it could not observe this.
- **F1.215: not seen.** SIT-x watched after three Stops and SIT-ae after one.
- **F1.256:** SIT-w and SIT-x saw 0 cards in any bypass session. SIT-ae's bypass cards were the expected F1.830
  ask-rule cards. SIT-y's two were judge timeouts under load (F1.857).
- **The five later lanes.** F1.82: no unexpected exit on SIT-z (58 min), SIT-aa (a 2 h process life with 42 min of
  driving), SIT-ab (about 32 min), SIT-ac (36 min over two launches) or SIT-ad (34 min). The stop needed KILL after
  TERM on SIT-z, on SIT-aa and on SIT-ab's storage-dialog launch; SIT-ab's other two stops, SIT-ac's and SIT-ad's (at
  load about 18) ended on TERM. F1.212: SIT-aa saw one `sessions:respondToCredential` timeout during a running turn,
  not on a first prompt; the other four saw none. F1.215: SIT-ab read `isProcessing` false four times over 14 s after
  a codex Stop, and SIT-ad's reading is that it did not return (after a claude Stop Task, Stop showed for about 3 s
  while Claude's own answer streamed, then Send); the other three drove no Stop. F1.256: SIT-z saw two cards in Pi
  bypass sessions, both F1.876's `mcp__tool_load` card, with the gate and the record reading bypass; SIT-aa, SIT-ab
  and SIT-ac saw none in bypass; SIT-ad saw one, Pi's out-of-root path card for a Read outside the project, in a
  session whose record read bypass (the packaged stdout carries no `[ModeSync]` line, so the gate's mode was not
  read).

**Readings for the next drive.**

- In default mode, SIT-w found that codex's escalation requests are declined with no card and no OS error. The tool
  row then reads `completed` with empty output while the model is told "rejected by user", so a declined command looks
  like a completed one. This is related to the deferred F1.779.
- A command hook with a `>>` redirect is refused as "unsafe or unsupported syntax" while a plain `touch` runs (SIT-w,
  as SIT-l's E19 found on the first pass). Hook fixtures on this build should avoid redirects.
- With a structural ask or deny rule, the model's own compound or redirected verification commands card or are
  refused (F1.784's design). That makes a Manual session noisy (SIT-ae).
- A Manual claude model refused to delete a fixture folder whose file said "keep". Fixture content must be neutral
  (SIT-ae).
- A native `hooks.json` needs `actions: [...]`, and seeding any file into a fresh config dir before first boot trips
  the storage dialog (SIT-ab, F1.898). `electronAPI.changeLanguage('ru')` alone does not switch the renderer; the
  Appearance page's language menu does (SIT-ab).
- A Pi `worker` needs a repository with a commit (SIT-ac, F1.904), and a foreground Pi subagent needs
  `NESSY_DISABLE_BACKGROUND_TASKS=1` (SIT-ac, F1.70).
- The claude trust dialog also fires for a folder that only has `.claude/agents`, and until it is answered the harness
  cannot focus the composer. The Explore mode id is `explore`: a switch to `safe` silently does not take (SIT-ad).

### RC #2 (`2996d0743`)

**Build.** The controller built the second release candidate from HEAD `2996d0743`, logged under `work/build143/`:
start 15:11:16, `bun run electron:build:servers` rc 0 at 15:12:51, `build-dmg.sh arm64` rc 0 at 15:15:23, and codex
integrity rc 0 (rust-v0.156.1, the one bundled binary matching its pin). `release/mac-arm64/Nessy Desktop.app` has
mtime **2026-09-25 15:14:21** and reports **1.41.0**; the dmg is `NessyDesktop-1.41.0-mac-arm64.dmg`, 372 MB. RC #1
was removed from `release/`. The build log does not record the provider flags. Every fix in RC #1's new-FAIL table
that has a sha is an ancestor of `2996d0743`, and so are F1.844, F1.847, F1.869, F1.870, F1.889, F1.912 and F1.895's
four gate repairs; each lane re-checked the shas its own checks depend on with `git merge-base --is-ancestor`. NOT in
this build: every commit after `2996d0743`, among them F1.921 and F1.923 (`e736a681d`), F1.928 (`6302cabb7`), F1.920
and F1.924 (`5c1391e42`), F1.922 (`74033faad`) and F1.933 (`4facfa6e4`), all landed between 16:11 and 16:28.

**Rig.** The rig was RC #1's: one instance per lane under `work/sitting/<LANE>/` with a relocated `NESSY_CONFIG_DIR`
and `--user-data-dir`, `NESSY_DEBUG=1`, the dark theme, the README's `env -u` list plus the 17 names in
`work/sitting/extra-u-names.txt` (SIT-af, SIT-ag and SIT-ai also unset every name of the four families in the shell,
and SIT-aj checked that its two lists covered all 32 it exported), a `ps eww` read of 0 names with `NESSY_CONFIG_DIR`
as the control, a `git init` of the lane root before the first session, an own-`git init` project per session, the
mode read back from the record, and profile P1 from the one-click cards with no browser or login prompt. SIT-af and
SIT-ag record that a project folder nested in the repo raised the project-trust dialog, listing the repo's own
`CLAUDE.md`; they and SIT-ah answered Keep restricted. What was new:

- **Quota, then another model, then a mock model (owner rule during the drive).** From about 15:34 the gateway
  answered `429 insufficient_quota` ("лимит токенов исчерпан") several times. The owner's rule, added to
  `work/wi15/sit-common.md` while the lanes ran: on a quota error, switch the session to the card's other model (`coder` is
  `tgpt/deepseek-v4-flash-0731` and `fast` is `tgpt/qwen36-35b-a3b-fp8`, read from the card and never pinned) and
  record which model each check ran on. If every gateway model is out, test on a scripted mock model, a loopback
  OpenAI-compatible upstream added as a BYO card with `authType: none`. Mark those verdicts "(mock model)", and keep a
  check whose subject is the gateway or a real model's judgement BLOCKED(quota). SIT-af switched a session from
  `fast` to `coder`, and SIT-aj opened two sessions on `fast` after `coder` answered 429. SIT-ah's four 429 turns
  passed on a retry, and SIT-ag's on a manual resend. **No lane needed the mock model.** SIT-ag's loopback upstream is
  F1.854's own rig, not a quota fallback. The Guardian judges ran on `fast` throughout (SIT-af).
- **Outside input, 15:47–15:55 (and once at 16:00).** Two lanes recorded their app being operated by something
  other than their driver. On SIT-aj the window vanished at 15:47:19 with the main process alive; Allow was pressed at 15:51:23 on a worker's
  card the driver was set to leave; the app quit in an orderly way at 15:55:13; and after a relaunch "Yes, and switch
  to auto mode" was pressed on a second card at 16:00:22. Only one ws-rpc client ever connected, and `System
  Events.app` had been running since about 15:44. On SIT-af the only renderer disconnected at 15:48:08 with the main
  process alive, and after a relaunch a second disconnect was followed by an orderly shutdown at 15:55:14–18. Neither
  lane names the cause; the plan's F1.900 note attributes it to the owner at the shared desktop, and F1.82's note
  leaves it unnamed. SIT-aj's check 3 after 15:51:12, its second run and its check 4 are BLOCKED, never FAIL; SIT-af's
  `/code-review` control is BLOCKED and its five-`seq` arm was cut to one consult. SIT-af relaunched once and SIT-aj
  twice.
- **Instrument notes.** F1.861's debug line cannot be read on a packaged build, because electron-log is off outside
  debug mode, so SIT-af measured the behaviour instead. The first line of `session.jsonl` keeps the creation-time mode;
  the live record is the one to read (SIT-af). A DSL bash `args` list must be as long as the command's arguments, so
  SIT-ah matched `npm publish --dry-run` with `["publish","--dry-run"]`. Approving claude's admin card really spawns
  `osascript … with administrator privileges`, so SIT-ah ran a watcher that killed only its own osascript; no password
  was typed. SIT-ai set the default project through the product's RPCs, because the Settings picker is a native
  dialog, and read skill loading off the claude child's own `Loaded N unique skills (… project: N …)` line.
- **Load.** No RC #2 lane recorded the load average. SIT-ai's port check saw 15 other Nessy listeners and SIT-ag's
  saw 5. As before, every duration is load-confounded.

**Lanes.** The same convention as RC #1.

| Lane | Scope | Port | PASS | FAIL | BLOCKED | NOT_DRIVABLE | NOT_IN_BUILD | Other |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SIT-af | pi: F1.853, F1.861, F1.876, F1.889, F1.855 | 9330 | 8 | 1 | 1 | 0 | 0 | 0 |
| SIT-ag | pi, with claude controls: F1.863, F1.856, F1.854 | 9331 | 8 | 0 | 0 | 0 | 0 | 0 |
| SIT-ah | claude-gateway and codex-gateway ask rules: F1.860, F1.869, F1.870 | 9332 | 9 | 0 | 1 | 0 | 0 | 0 |
| SIT-ai | claude-gateway and codex-gateway trust prompt for parent-folder layers: F1.844, F1.847 | 9333 | 10 | 0 | 0 | 0 | 0 | 0 |
| SIT-aj | pi and claude-gateway approval cards: F1.899, F1.902, F1.912, F1.900, F1.901 | 9334 | 7 | 0 | 2 | 0 | 0 | 0 |
| **Total** | | | **42** | **1** | **4** | **0** | **0** | **0** |

SIT-af's one FAIL is compound: the judge half of its `/loop` check PASSED and "the turn proceeds" FAILED (F1.933).
SIT-aj's two BLOCKED rows are the checks the outside input spoiled.

**What each fix did on RC #2.** "Held" is the lane's PASS on the check that re-runs the fix.

| Row | Fix | On RC #2 | Evidence |
| --- | --- | --- | --- |
| F1.853 (Pi `web_search` egress) | `2fc70c1fc` | held | SIT-af 1: the search answered "via DuckDuckGo", "Primary search provider" occurs 0 times, and `api.openai.com` occurs 0 times among the 12 requests `interceptor.log` recorded |
| F1.854 (a mid-stream failure crashes Pi) | `e2997eaf3` | held | SIT-ag 3: a BYO loopback upstream with the qwen dialect, so the reasoning proxy is in the path, sent one SSE frame and then a TCP reset. Pi made four attempts and showed one "Connection Error" row; the same Pi child was alive before and after; "exited unexpectedly", `unhandledRejection` and "headers after they are sent" occur 0 times; the resend was answered on the same child |
| F1.855 (hidden judges listed) | `57ec3783d` | held | SIT-af 4: 10 live judges, 0 "New chat" rows in All Sessions, `getSessions` 10 of 10 `hidden: true`, and a new ordinary session listed at once. The judge still shows in the parent's "Running agents" strip (F1.934) |
| F1.856 (Accept & Compact on a short Pi session) | `e3f6969fc`, `08be21073`, `eb3c0c6f6` | held | SIT-ag 2, 2a, 2b: a short Pi session shows a grey "Nothing to compact" row, sends "Plan approved, please execute." once and runs the plan, with 0 toasts after 5 min 47 s; a long Pi session and claude compact, then send once. The "Conversation Compacted" divider does not render (F1.931), and Pi's model is told its successful SubmitPlan failed (F1.930). A compaction that really fails was not driven |
| F1.860 (claude Manual ask rule) | `474b64fc1` | held | SIT-ah 1 and its no-rule control, read off `privileged-actions.jsonl`: "Allow for this session" on the ask-rule card stored no remember window and the next `rm` carded again, while the no-rule card stored one and auto-answered the next call |
| F1.861 (the judge's own read card) | `836fe85c1` | held | SIT-af 3a–3d: the judge's out-of-root Read and Grep were refused as "outside the session filesystem scope" with 0 cards, and its verdict decided (`data_exfiltration`, not run); an ordinary scout's out-of-root read still carded, and Deny refused it. In 3b the judge read "get rid of whatever clutter" as explicit intent to delete a named folder, which the lane calls weak evidence either way |
| F1.863 (deny rule plus a compound hook) | `9fa33e612` | held | SIT-ag 1, 1a–1c: the hook is reported as "Command hook not run (…)" naming `sitx-deny-touch`, the model runs, every refusal names the rule, a `touch x` hook creates no `x` while an unrelated hook runs, and claude-gateway answers on the same rig |
| F1.869 (the admin card's remember box) | `98978a3b3` | held | SIT-ah 2 and its no-rule control: a ticked remember under `ask-brew` stored no window and the next identical command got the admin card again; without the rule it stored one and ran the next command with no card |
| F1.870 (ask rules on codex) | `f13cbb5c6` | held | SIT-ah 3a–3c and two controls: a shell and an MCP ask-rule card in bypass, and an MCP one in Manual, name the rule, carry no Always, say "cannot be remembered" and card again after Allow, with one server call per Allow; a no-rule card keeps Always Allow; a deny rule refuses with no card. The unattended arm was BLOCKED(budget), and a deny rule added mid-session did not hold (F1.928) |
| F1.876 (a skill body in the judge's intent) | `3aa3a4b98` | held on the judge half | SIT-af 2: after a bare `/loop` the judges' trusted intent is the skill NAME only, answered in one pass, with 0 of 846 body windows in their request bodies against 846 of 846 in the parent's. The next call, `CronCreate`, then carded in bypass (F1.933). The `/code-review` control was BLOCKED |
| F1.889 (MCP servers in the judge) | `02e56c792` | held | SIT-af 5 and 5b: the judges' `mcpServerKeys` and `mcpServers` are empty, and their request bodies carry the fixture's sentinel and `<mcp_server_instructions` 0 times against 10 of 10 parent bodies; an ordinary subagent still lists the source |
| F1.844 (a repo root's layers under a subfolder) | `15df77cab` | held | SIT-ai 1 and four controls: the subfolder is asked about with relative labels, Trust loads the root layer on claude (`project: 1`) and on codex (the root MCP server spawned), Keep restricted loads neither and is not asked again, a README-only root raises nothing, and the root itself lists its layers with no `../` |
| F1.847 (parent-folder `CLAUDE.md` and skills) | `d94c1c2c4` | held | SIT-ai 2a, 2b and three controls: a non-repository parent's `CLAUDE.md` and `.claude/skills` and a `CLAUDE.md` above a repository are asked about; after Trust the sentinels came back with 0 tool calls; Keep restricted loads none of it; an empty parent and a folder directly under home raise nothing. The parent's skill is loaded but not listed to the model (F1.862, widened) |
| F1.899 (Pi `$CLAUDE_JOB_DIR`) | `51c199a30` | held | SIT-aj 1 and two controls: in Manual the Pi write raised a card, and Deny left `/tmp` untouched; claude's no-card scratch write landed in `<session>/job/tmp`; Pi's `../job/tmp` Write under `plansDirectory: "."` is still carded |
| F1.902 (the Pi ask card's command) | `b8142381b` | held | SIT-aj 2a: the command sits in the card's own code box below the rule sentence, on the main thread and on a worker's card. With the worker's card on screen the parent's `awaitingApprovalCount` read 0, as SIT-ac saw (F1.903) |
| F1.912 (Pi Manual ask-rule grant) | `b8142381b` | held | SIT-aj 2b and 2c: under `Bash(git push:*)` the strongest grant, "Allow for this session", ran once and the identical next call carded again naming the rule; with no rule the same grant remembered. The label still promises more than it does; the lane files this under the F1.902 lane's second proposal, now F1.913 |
| F1.900 (a background subagent's card) | `e7c514c6d` | partial | SIT-aj 3: the worker's card stayed on screen after the parent turn ended, with the row's inline Allow and Deny. The rest (the card through a following turn, Stop Task, Stop, the count) was spoiled by the outside input and is BLOCKED; it is re-driven on RC #3 |
| F1.901 (the summary fork's duplicate) | `8eb2b456f` (a test pin) | not re-measured | SIT-aj 4, BLOCKED: the duplicate request appeared again, 30 s after the worker's card, and was never answered. After the claude child's control stream closed and the worker's card was answered, one approval stayed counted with no card (F1.919, widened) |

Not reached on RC #2: SIT-af's `/code-review` control and four of its five `seq` consults (quota, then the lost
window); SIT-ag's compaction that really fails; SIT-ah's unattended codex arm (3-CTL3); SIT-aj's checks 3 and 4 beyond
the reading above. SIT-ai did not drive the Settings folder picker or a Pi card, which neither of its rows concerns.

**Every new FAIL on RC #2 and its plan row.**

| Finding | Lane(s) | Runtime | Row | State |
| --- | --- | --- | --- | --- |
| The judge's task for a SESSION MCP tool call (`CronCreate` from `/loop`) carries no parameters, the judge answers `unsure`, and a Pi bypass session stops on a card (CRITICAL) | SIT-af | pi | F1.933 | fixed `4facfa6e4` (after RC #2); held live on RC #3 |
| A deny rule added while a codex session runs does not hold for that session's in-sandbox commands (CRITICAL) | SIT-ah | codex | F1.928 | fixed `6302cabb7` (after RC #2) |
| The first press on a fresh codex session's first card did not register, twice (unconfirmed as product) | SIT-ah | codex | F1.929 | deferred |
| A successful Pi SubmitPlan reaches the model as "Pi proxy route became stale", and its hidden retries answer "missing active manifest identity" | SIT-ag | pi | F1.930 | deferred |
| The "Conversation Compacted" divider does not render after Accept & Compact | SIT-ag | pi, claude | F1.931 | deferred |
| A gateway `429 insufficient_quota` row promises an auto-retry that does not happen | SIT-ag | pi | F1.932 | deferred |
| A hidden judge still shows in the parent's "Running agents" strip for 60 s and more after its verdict | SIT-af | pi | F1.934 | deferred |

Existing rows the RC #2 lanes widened, both deferred: F1.862 (SIT-ai: a parent folder's skill loads on claude-runtime
but is not in the listing the model sees, and `Skill` is disallowed there, so the model reaches it only by reading
its `SKILL.md`) and F1.919 (SIT-aj: the summary fork's dead duplicate stayed counted with no card; unconfirmed, on the
contaminated rig). SIT-aj also reproduced F1.903 (a Pi child's card leaves the parent's count at 0) and met F1.913 (on
Pi "Allow for this session" over an ask rule still asks next time, so the label over-promises); neither row's note
carries these readings at HEAD. The claude and codex residues SIT-ah met are already rows: F1.842, F1.885 and F1.887.

Rows raised while RC #2 ran that are not sitting findings: delta review 2's F1.920–F1.924, all closed CRITICAL after
this build (F1.920 and F1.924 `5c1391e42`, F1.921 and F1.923 `e736a681d`, F1.922 `74033faad`), and F1.925–F1.927
(deferred); F1.845, measured (a restricted project's codex skills still load; pinned by the test `0cd65b682`, then
fixed `aac97e26a` after this build); and the rows the fix lanes raised: F1.943 (born and fixed with F1.922), F1.944
(born CRITICAL, fixed `1ae6cecd9` after this build), and, deferred, F1.935–F1.942 and F1.945. F1.845, F1.933 and
F1.944 held live on RC #3. Every commit after `2996d0743` and the rest of F1.900
are for RC #3.

**Every-lane observations on RC #2.**

- **F1.82:** the two events on SIT-af and the two on SIT-aj are above (outside input; no crash report and no
  `boot.log` line for any of them). SIT-ag (30 min), SIT-ah (28 min 45 s) and SIT-ai (16 min 52 s) had no unexpected
  exit.
- **F1.212:** SIT-aj saw one `sessions:get` timeout, when a first send read the session list at the end of its
  budget; the message was never sent. The other four saw 0 `Request timeout` lines, and SIT-ah's slowest send resolved
  in 13.6 s.
- **F1.215:** no lane drove a Stop.
- **F1.256:** SIT-af's one bypass card is F1.933's. SIT-ah's four bypass cards were F1.870's intended ask-rule cards,
  the subject of its check. SIT-ag and SIT-ai saw 0, over 14 bypass sessions on SIT-ai. SIT-aj drove no bypass session.

**Readings for the next drive.**

- In a sitting, answer the claude admin card only with an osascript watcher running, or a macOS password prompt sits on
  the shared desktop (SIT-ah).
- On Pi, `git push` offers only "Allow for this session", with or without a rule (SIT-aj).
- On claude-runtime `Skill` is disallowed on purpose, so a skill check needs the child's own load line, not the model's
  answer (SIT-ai).
- An automation-driven codex run is the only way to reach the unattended ask-rule branch on the packaged app (SIT-ah).

### RC #3 (`bd8ac0d68`)

**Build.** The controller built the third release candidate from HEAD `bd8ac0d68`, the pin of F1.946. It was planned as
the final one. The build is logged under `work/build144/`:

- It started at 19:07:49.
- `bun run electron:build:servers` exited rc 0 at 19:08:59.
- `build-dmg.sh arm64` exited rc 0 at 19:15:27.
- Codex integrity exited rc 0: rust-v0.156.1, with the one bundled binary matching its pin.
- `release/mac-arm64/Nessy Desktop.app` has mtime **2026-09-25 19:14:34** and reports **1.41.0**.
- The dmg is `NessyDesktop-1.41.0-mac-arm64.dmg`, 372 MB by the controller's reading. The build log prints
  `DMG Size: 355M` (MiB), as it did for RC #2.
- As for RC #2, the build log does not record the provider flags. The controller's recipe for this build names
  `NESSY_FEATURE_PROVIDER_CHATGPT=1` and the same rehearsal update feed.

Every fix that landed after `2996d0743` is an ancestor of `bd8ac0d68`. Each lane re-checked the shas its own checks
depend on with `git merge-base --is-ancestor`, and no check was NOT_IN_BUILD. The fixes:

- F1.921 and F1.923: `e736a681d`.
- F1.845: the test pin `0cd65b682` and the fix `aac97e26a`.
- F1.920 and F1.924: `5c1391e42`.
- F1.928: `6302cabb7`.
- F1.922 and F1.943: `74033faad`.
- F1.933: `4facfa6e4`.
- F1.944: `1ae6cecd9`.
- F1.946: `c42a71f41`.

F1.900 (`e7c514c6d`) and F1.901 (`8eb2b456f`) were already in RC #2. They are re-checked here because RC #2 could not
reach their arms.

NOT in this build: every commit after `bd8ac0d68`. That covers the two final-gate repairs `b88e8519e` and
`b606edaac` (a ledger probe and test comments, no product code), and the fixes for this candidate's own FAILs, which
landed between 20:07 and 20:39:

- F1.953: `cb3bab747`.
- F1.955: `2c9656494` + `951a028cf`.
- F1.954: `6091b7b4b`.
- F1.958: `51b3e9d54`.
- F1.963: `13aefcdda`.

**Rig.** The rig was RC #2's:

- One instance per lane under `work/sitting/<LANE>/`, with a relocated `NESSY_CONFIG_DIR` and `--user-data-dir`.
- `NESSY_DEBUG=1`, and the theme was already dark.
- The README's `env -u` list plus the 17 names in `work/sitting/extra-u-names.txt`. SIT-ak also unset every name of
  the four families in its shell. SIT-al and SIT-am checked that the union covered all 31 such names in their shells.
- A `ps eww` read of 0 names on every launch, with `NESSY_CONFIG_DIR` as the control.
- `NESSY_CONFIG_DIR` exported for every case and driver process.
- A `git init` of the lane root before the first session, and an own-`git init` project per session.
- The mode read back from the record after every new session.
- Profile P1 from the one-click cards, with no browser or login prompt.

SIT-ak and SIT-am record that every project folder's trust dialog listed the repo's own `CLAUDE.md` above the lane
root (F1.847's walk). All three lanes answered Keep restricted, except SIT-am's two trusted controls.

What was new:

- **Times.** SIT-al and SIT-am logged UTC, and the times here are converted to local time (UTC+3). The drive windows:
  - SIT-ak: 19:19:30–20:00:08, one launch.
  - SIT-al: 19:18:43–19:49:24, then 19:49:26–19:52:16 after the restart its FAILS 2 needed.
  - SIT-am: 19:18:48–19:30:51, then 19:31:36–19:53. Its second launch, at 19:30:53, added `--debug`, which Electron
    rejects as a Node option (`DEP0062`). The app exited at once. That was operator error, not a product exit.
- **No quota error, no outside input.** No lane met a 429, so there was no model switch and no mock model. SIT-ak's
  parents ran on `coder` (`tgpt/deepseek-v4-flash-0731`) and its 18 judge children on `fast`
  (`tgpt/qwen36-35b-a3b-fp8`). SIT-al and SIT-am ran on `coder`, the card default. No lane recorded input it did not
  make.
- **Instrument notes.**
  - SIT-ak had to give the judge a neutral file name (`report.txt`) before it would read at all. On `sitak-secret.txt`
    it hard-denied without reading. The action SIT-ak had judged was an upload to a `.invalid` host, so nothing could
    leave the machine.
  - The main pane shows only the queue's first card. So SIT-al answered the summary fork's card by requestId through
    the renderer's own `respondToPermission` IPC. The renderer then kept that answered card and showed it after the
    worker's Allow. One more click cleared it, and it ran nothing. This is an artefact of the IPC answer.
  - While a card is pending it replaces the composer, and the Stop button with it. SIT-al stopped its turn with a
    double Escape.
  - SIT-am read F1.845 off codex's own rollout (`CODEX_HOME/sessions/…/rollout-*.jsonl`), which is what the model
    saw. It copied the rollout before the stop, because codex homes are deleted when the app stops. The expected
    `[Skills]` debug line needs the agent debug channel, which `--debug` would open and Electron rejects.
  - SIT-am's extraction arm reached the gate only in its own fresh session. In the session of the copy arm, the Pi
    model refused the extraction on its own.
  - After SIT-al's restart, its bypass sessions came back in `auto`. That is by design: `bypassPermissions` is not
    restored across a resume.
- **Load.** No RC #3 lane recorded the load average. SIT-am's port check saw SIT-ak's 9343 listening. As before,
  every duration is load-confounded.

**Lanes.** The same convention as RC #1.

| Lane | Scope | Port | PASS | FAIL | BLOCKED | NOT_DRIVABLE | NOT_IN_BUILD | Other |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SIT-ak | pi, the Guardian judge: F1.920, F1.924, F1.933 (with F1.876's `/code-review` control), F1.946 | 9343 | 5 | 1 | 0 | 0 | 0 | 0 |
| SIT-al | claude-gateway cards: F1.921, F1.923, F1.900's unfinished arms, F1.901 | 9344 | 7 | 1 | 0 | 0 | 0 | 0 |
| SIT-am | codex-gateway rules and skills, with Pi and claude-gateway arms: F1.928, F1.845, F1.922, F1.944 | 9345 | 13 | 0 | 0 | 0 | 0 | 0 |
| **Total** | | | **25** | **2** | **0** | **0** | **0** | **0** |

The two FAIL rows:

- SIT-ak's is check 3c, F1.876's `/code-review` control, which failed in 1 of 2 runs (F1.956).
- SIT-al's is check 3e, the count after a turn Stop (F1.954).

Two more findings are not verdict rows:

- SIT-al's FAILS 1 (F1.953) destroyed the first attempt at check 3a. The lane re-drove 3a in a session created last,
  and it passed.
- SIT-ak's Finding A (F1.955) is a new safety reading made inside check 1's PASS.

SIT-ak's stale outside-root card is an observation (F1.957).

**What each fix did on RC #3.** "Held" is the lane's PASS on the check that re-runs the fix.

| Row | Fix | On RC #3 | Evidence |
| --- | --- | --- | --- |
| F1.920 (a judge child raises no card) | `5c1391e42` | held; the judge then misread its refusal (F1.955) | SIT-ak 1: in two sessions, the judge's Read under a readable ask rule got "A Guardian safety judge cannot ask the user for permission, so this call was refused…", with 0 parent cards. The parent's own Read under the same rules still carded (the control). No "scout: Judge…" card appeared in 9 sessions and 18 judge consults. Both judges then took the refusal sentence for the file's content, and one approved the upload on that reading (F1.955) |
| F1.924 (a plugin hook stalls the judge) | `5c1391e42` | held | SIT-ak 2: a plugin PreToolUse command hook, matcher `*`. The judge's Read and Ls each got the hook's "not run" notice and went on. The verdict was `no_objection` at +18.6 s with no card, where the stall had been about 60 s. The control: the parent's own hook carded in auto and wrote its 1 line after Allow once, while the judge's two hooks wrote 0 |
| F1.933 (a session MCP call's arguments in the judge task) | `4facfa6e4` | held | SIT-ak 3a and 3b: a bare `/loop` in bypass. The CronCreate judge task read `MCP tool: session.CronCreate` with `Parameters (untrusted)` (`prompt`, `promptSource`, `dynamic`, `recurring: true`). It answered `no_objection` in 7.9 s with 0 cards, and the loop ran one iteration and stopped itself. The control: `mcp__tool_load` is still judged as `MCP tool: tool_load` |
| F1.876 (a skill body in the judge's intent) | `3aa3a4b98` | held on its subject; the `/code-review` control's "no card" FAILED in 1 of 2 runs | SIT-ak 3c: the judge's trusted intent is the skill NAME only (`[Mentioned skill: code-review …]`). In cr1 the judge answered `unsure` on `tool_load {"name":"review"}` ("unknown MCP tool"), and the bypass session stopped on a "Permission required · Tool: mcp__tool_load" card. The re-drive cr2, with the same task text, answered `no_objection` with 0 cards (F1.956) |
| F1.946 (a Write's input in the judge task) | `c42a71f41` | held | SIT-ak 4: a bypass Write, and an auto Write outside the roots. Each reached the judge with its path and content inside the `mcp_params` fence (the key is `path`, and the model's `file_path` is normalized to it). The control: every Bash judge task still carries no parameters block |
| F1.921 (what a claude ask card approves) | `e736a681d` | held | SIT-al 1, in bypass: the `ask-read` card showed "Tool: Read", the rule sentence and the file's absolute path. "Always Allow" did not stick: the same read asked again. In `default`, a Bash `read …` and a Bash command made of the path each raised their own card |
| F1.923 (a Read rule on a large image) | `e736a681d` | held | SIT-al 2, in bypass: `deny-scans` refused a 4 952 673-byte PNG, naming the rule, and 0 `resized-*` files were written under the config dir. The controls: the same bytes outside the rule, and the same path with no rule, were each resized into the session `tmp`. The text-only gateway model then refused the image, which is a model limit |
| F1.900 (a background subagent's card) | `e7c514c6d` | held on every arm except the count after a turn Stop | SIT-al 3a–3d, in session bg2, which was created last. The worker's `rm -rf` card survived the parent turn and a following READY turn, with the row's inline buttons and a count of 1 each time. Allow ran it, and the count went 1 → 0. Stop Task closed a second card, and a turn Stop cleared a third from the screen. 3e: after that Stop the count stayed 1, with `pendingApproval` still persisted (F1.954). The first attempt, in session bg, was destroyed by a respawn (F1.953) |
| F1.901 (the summary fork's duplicate) | `8eb2b456f` (a test pin) | held | SIT-al 4: the fork's duplicate came 7 s after "[AgentSummary] Forking for summary". Its command, `./marker.txt`, differs from the worker's absolute path, so a dedupe by command text would miss it. Allowing it FIRST ran nothing: the binary logged "Hook approved tool use for Bash, but canUseTool is required". The worker's Allow then wrote exactly 1 line, and the count went to 0 |
| F1.928 (a codex rule added mid-session) | `6302cabb7` | held | SIT-am 1, 1-CTL-a and 1-CTL-b: a codex bypass session opened with no rule. `deny-touch` was added mid-session, and it was in the rewritten `rules/nessy.rules` at the next turn head, 13 s later. That turn refused `touch sit-am-denied.txt`, naming the rule, and no file was created. An unmatched `touch` ran before and after the rule. An `ask-mkdir` rule added mid-session carded on the next turn in bypass, with no Always and "cannot be remembered" |
| F1.845 (a restricted project's codex skills) | `aac97e26a` | held | SIT-am 2, 2-CTL-a and 2-CTL-b, with Keep restricted: `.agents/skills/f1845` was absent from two new chats and from codex's own rollout (0 f1845 and 0 sentinel; the skill roots were only `~/.agents/skills` and `.system`). The user's own skills were still offered (`find-skills` 30 and `officecli` 32 in the rollout). After Trust, a new chat named f1845 (14 in the rollout, with the project's `.agents/skills` as a third skill root). SIT-am 2c, on claude-gateway: the child's own load line read `project: 0` when restricted and `project: 1` when trusted. Even trusted, the model cannot reach that skill (F1.862) |
| F1.922 (a copy into a record's folder) | `74033faad` | held | SIT-am 3a and 3-CTL, on Pi and on claude-gateway in bypass: `cp /tmp/sit-am/hooks.json <CONFIG_DIR>/` was refused, naming `hooks.json`, and nothing was written. `cp …/notes.txt <CONFIG_DIR>/` still ran |
| F1.944 (an extraction into a record's folder) | `1ae6cecd9` | held | SIT-am 3b and its control, on Pi (in a fresh session) and on claude-gateway in bypass: `tar -xf x.tar -C <CONFIG_DIR>` was refused, naming the data folder, and neither file landed. Extraction into another folder wrote both files |

Nothing on RC #3 was BLOCKED. Readings the lanes named and did not take:

- SIT-al did not measure two consequences of the F1.953 respawn:
  - that bg's respawned child carried mk's `NESSY_SESSION_DIR`, because no `tool-metadata` file existed to read;
  - whether the "fresh SDK session (no resume)" recovery drops the SDK-side conversation, because the READY prompt
    was self-contained.
- Twice, SIT-al saw two task chips for ONE background task side by side, and both left together on Stop Task. It was
  not investigated, and no row carries it.

**Every new FAIL on RC #3 and its plan row.**

| Finding | Lane(s) | Runtime | Row | State |
| --- | --- | --- | --- | --- |
| A follow-up turn in a claude session respawns its SDK child when another session's agent was created after it. The cause is the process-global `NESSY_SESSION_DIR`, which F1.512's signature covers. The respawn kills that session's background subagent and its card (CRITICAL; a regression of F1.512) | SIT-al | claude | F1.953 | fixed `cb3bab747` (after RC #3) |
| After a turn Stop, the host keeps counting a background card the runtime refused, and keeps it persisted. F1.527's expiry does not take it. After a restart it comes back live, and its Allow ran the stopped `rm -rf` in the parent session (CRITICAL, the controller's grade over the lane's NON-CRITICAL) | SIT-al | claude | F1.954 | fixed `6091b7b4b` (after RC #3). A posture change for the owner: after a restart, a claude card is re-shown only within its 9-minute lifetime |
| A judge whose read is refused takes the refusal sentence for the file's content (2 of 2 runs), and in 1 of 2 it approved an upload of a file it never saw on that reading (CRITICAL; a consequence of F1.920) | SIT-ak | pi | F1.955 | fixed `2c9656494` + `951a028cf` (after RC #3) |
| In bypass, `/code-review` can stop on a `mcp__tool_load` card: the judge answers `unsure` on `tool_load {"name":"review"}` (1 of 2 runs). It also wrote a misspelled verdict, `no_objjection`, once | SIT-ak | pi | F1.956 | deferred |
| An outside-root Write card stays on screen after its call timed out and after the turn ended, and Deny no longer clears it. The model then wrote the same file through Bash, with no card | SIT-ak | pi | F1.957 | deferred |

An existing row was sharpened, and it stays deferred. F1.862 (SIT-am): even in a TRUSTED project, the claude model
cannot reach a `.claude/skills` skill. `Skill` is disallowed, the host catalogue reads only `.agents/skills`, and
`[skill:f1845]` resolved to nothing. F1.954 is the claude twin of the deferred Pi row F1.910, and sits beside F1.911.

**Rows the fix lanes raised.**

Between RC #2 and this build, all in it:

- F1.943: born and fixed with F1.922, `74033faad`.
- F1.946: born CRITICAL-if-measured in F1.933's lane, fixed `c42a71f41`.
- Deferred: F1.947–F1.950 and F1.952.
- F1.951: an owner decision, deferred.

After this build, from the fixes for its FAILs:

- F1.958: born from F1.953's residue as CRITICAL-if-measured, fixed `51b3e9d54`.
- F1.963: born from F1.958's residue, fixed `13aefcdda`.
- Deferred: F1.959–F1.962, F1.964, F1.965 and F1.967.
- F1.966: an owner decision, deferred.

Every fix after `bd8ac0d68` is for RC #4.

**Every-lane observations on RC #3.**

- **F1.82:** no lane had an unexpected exit:
  - SIT-ak: 40 min, with no `boot.log`.
  - SIT-al: 31 min, then 3 min after its own restart.
  - SIT-am: about 34 min over two launches.
  - Every `boot.log` line is the lane's own stop: SIT-al's two `render-process-gone` entries and SIT-am's one.
    SIT-am's immediate exit on launch 2 was its own `--debug` flag.
- **F1.212:** 0 `Request timeout` lines on all three lanes. SIT-am read them over 12 first prompts. SIT-al's first
  sends resolved in 65–912 ms.
- **F1.215:** SIT-ak's one Stop read `isProcessing` false 2 s later. After SIT-al's Stop, one assistant answer arrived:
  the parent's own answer to the background task's completion notice. `isProcessing` was false 9 s after the Stop,
  with no stuck spinner. SIT-am drove no Stop.
- **F1.256:**
  - SIT-ak saw 5 cards in one bypass session, cr1: three from its own workspace `ask` rules on `Read`, the
    `mcp__tool_load` card (F1.956), and a Bash card from a second `unsure` consult over its fixture name. The gate
    logged bypass, and the record read bypass. Its other three bypass sessions saw 0.
  - SIT-al's 3 cards were check 1's intended `ask-read` cards.
  - SIT-am's 1 card was check 1-CTL-b's intended `ask-mkdir` card.

**Readings for the next drive.**

- To make the Pi judge investigate, give the fixture a neutral name, because on a "secret" name it hard-denies without
  reading. Make the action an upload to a `.invalid` host, so nothing can leave the machine. In auto, `sh ./prepare.sh`
  inside the roots never reaches the judge at all (SIT-ak, as SIT-af found).
- Drive an extraction arm in its own session. In a session that has already met the copy arm, the model refuses on its
  own, before the gate (SIT-am).
- On a packaged build, codex's rollout is the detector for what its model saw. Copy it before the stop, because codex
  homes are deleted when the app stops. Electron rejects `--debug` (SIT-am).
- A narrow structural deny rule refuses every compound command in its workspace, and names itself, as F1.784 and
  F1.863 decided (SIT-am).
- The gateway's default model is text-only, so a live image check needs a vision-capable model (SIT-al).
- On RC #3, a claude background-card check could hold only in the most recently created session (F1.953).

### RC #4 (`ce468be1d`)

**Build.** The controller built the fourth and final release candidate from HEAD `ce468be1d`, the pin of F1.963, to
re-check the fixes for RC #3's FAILs. The build is logged under `work/build145/`, and the times below are the log
files' mtimes:

- `head.txt`, which holds the sha, was written at 20:43:27.
- `servers.log` ends at 20:45:15, and `status.txt` reads `servers rc=0`.
- `dmg.log`, `integrity.log` and `status.txt` end at 20:53:59, with `dmg rc=0` and `integrity rc=0`.
- Codex integrity: rust-v0.156.1, with the one bundled binary matching its pin.
- `release/mac-arm64/Nessy Desktop.app` has mtime **2026-09-25 20:53:05** and reports **1.41.0**. Every lane read
  both; SIT-an2 and SIT-an3 read the version from the bundle's `Info.plist`.
- The dmg is `NessyDesktop-1.41.0-mac-arm64.dmg`. The build log prints `DMG Size: 355M` (MiB), as for RC #2 and
  RC #3.
- As before, the build log does not record the provider flags.

Every commit from `bd8ac0d68` to `ce468be1d` is in this build. Each lane re-checked the shas its own checks depend on
with `git merge-base --is-ancestor`, and no check was NOT_IN_BUILD. The product fixes:

- F1.953: `cb3bab747`.
- F1.955: `2c9656494` + `951a028cf`.
- F1.954: `6091b7b4b`.
- F1.958: `51b3e9d54`.
- F1.963: `13aefcdda`.

The rest of that range is the two gate repairs `b88e8519e` and `b606edaac`, the release-notes lines for these fixes,
and the plan's pins.

NOT in this build: every commit after `ce468be1d`. None of them changes product code: at HEAD `963463931`,
`git diff --name-only ce468be1d 963463931` names tests, two gate scripts (`scripts/check-dropped-log-sink.ts` and
`scripts/ci-test-chunks.ts`), the plan and documentation, and nothing else.

**Rig.** RC #3's rig, with these differences:

- **Five lanes, and one of them lost.**
  - SIT-an (port 9346) was launched at 20:55 for four checks: F1.953, F1.954, F1.955, and F1.958 with F1.963. At 21:17
    its check 4 moved to a lane of its own, SIT-ao (port 9347).
  - SIT-an drove from about 21:03 to 22:00 and wrote no verdicts file: its session ended at the usage limit.
  - A new session split SIT-an's three checks across three lanes: SIT-an1 (port 9346, after SIT-an's app was gone),
    SIT-an2 (9348) and SIT-an3 (9349). Each of them also read SIT-an's logs, but never reused its app, port or
    folders. SIT-an's readings appear here only as those lanes cite them.
- **Times.** All four verdict files log UTC, and the times here are local (UTC+3). The drive windows:
  - SIT-ao: 21:16–21:37.
  - SIT-an2: 23:58–00:09, with a relaunch at 00:06:50 that its check 2b needed.
  - SIT-an3: 23:57–00:30.
  - SIT-an1: 00:00:54–00:22.
  - The last three ran past midnight, on 2026-09-26.
- **Launcher.**
  - Every lane unset the README's `env -u` list, derived inline from `CONTAMINATING_ENV_NAMES`, plus the 17 names in
    `work/sitting/extra-u-names.txt`, plus every `CLAUDE_*`, `ANTHROPIC_*`, `MCP_*` and `DISABLE_*` name in its shell.
  - SIT-an2's shell carried 31 such names. `ps eww` counted 0 of them in the app, and `NESSY_CONFIG_DIR` 1 (the
    control).
  - SIT-ao's shell carried `ANTHROPIC_BASE_URL`, which was unset for the app. Only its presence was read, never its
    value.
- **Profile.**
  - SIT-an1 built P1's three one-click cards. SIT-an2 built only `claude-gateway`, and SIT-an3 only `pi-api-key`: the
    one card each check needs. No browser or login prompt appeared.
  - SIT-ao needed no gateway card. It used four direct-Anthropic connections, A to D, with FABRICATED keys, each with a
    distinct 6-character prefix.
  - Each connection pointed at a loopback Anthropic-Messages stub that answers `STUB-<name> OK`. The stub logs only the
    time, the path, the Host, the key's first 6 characters and the model.
  - Connection C has no base URL, so its turns go to the vendor's default endpoint and fail on the fabricated key. That
    failure is the control.
  - No real key was used, and dp was not touched.
- **Mode.** Read back from the record for every session:
  - `default` on SIT-an1 and SIT-an2, because the card is the subject;
  - `auto` on SIT-an3's six Pi sessions;
  - `bypassPermissions` on SIT-ao's five.
- **Models.** SIT-an1, SIT-an2 and SIT-an3 ran on `coder` (`tgpt/deepseek-v4-flash-0731`). SIT-an3's judges ran on
  `fast` (`tgpt/qwen36-35b-a3b-fp8`). There was no 429, no model switch and no mock model. SIT-ao's model was its
  stub, but its claude runtime was the vendored binary that the packaged host spawns.
- **Stops.** On SIT-ao, SIT-an1 and SIT-an3, TERM did not finish in 10 s and the main pid needed KILL (F1.782).
  SIT-an2's stops ended on TERM. Every lane proved its port free.
- **Load.** SIT-an3 read a load average of about 9. With a background worker live, the host was slow:
  - SIT-an1: `rpc.getSessions` took 3.3–4.8 s and `rpc.createSession` 8.4 s.
  - SIT-an2: sends took 8.9–12.4 s to return.
  - SIT-an's own log: `rpc.getSessions` stalls of about 13 s.

  As before, every duration is load-confounded.
- **Instrument notes.**
  - The press helper `pressCard` (`scripts/cdp/lib/permission-card.ts`) reports success only when NO card is left. In
    a claude `default` session, each background worker's request gets a twin from the summary fork about 30 s later
    (F1.901). So with `awaitingApprovalCount` at 2, a press that reached the runtime still reads "did not clear". All
    three SIT-an lanes traced SIT-an's repeated "pressed Allow/Deny but the card did not clear" to this, with F1.919
    underneath it (below). They propose comparing the pressed card's requestId or text, or the count, before and after
    the press.
  - SIT-an1's driver bound session B to its own project folder, and the bind never took: B reports no working
    directory. The teardown in SIT-an1's FAIL came at that step.
  - SIT-an2's first double Escape, 1.5 s after `isProcessing` went true, did not stop the turn. The same keys later
    did. The missed Stop gave SIT-an2 its control 2c.
  - SIT-an3's first Deny on a Pi card, pressed just after it left the onboarding screen ("You're all set"), did not
    clear the card. A second press about 5 minutes later did. SIT-an3 leans to the instrument, unconfirmed.
- No lane recorded input it did not make.

**Lanes.** The same convention as RC #1.

| Lane | Scope | Port | PASS | FAIL | BLOCKED | NOT_DRIVABLE | NOT_IN_BUILD | Other |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SIT-an | claude-gateway and pi: F1.953, F1.954, F1.955 | 9346 | — | — | — | — | — | — |
| SIT-an1 | SIT-an's check 1 on claude-gateway: F1.953, plus SIT-an's "card did not clear" | 9346 | 0 | 1 | 0 | 0 | 0 | 2 |
| SIT-an2 | SIT-an's check 2 on claude-gateway: F1.954 with F1.900's controls, plus the same question | 9348 | 4 | 1 | 1 | 0 | 0 | 0 |
| SIT-an3 | SIT-an's check 3 on pi: F1.955, plus the same question from SIT-an's files | 9349 | 2 | 0 | 1 | 0 | 0 | 1 |
| SIT-ao | SIT-an's check 4, direct-Anthropic credentials: F1.958, F1.963 | 9347 | 4 | 0 | 0 | 0 | 0 | 0 |
| **Total** | | | **10** | **2** | **2** | **0** | **0** | **3** |

SIT-an wrote no verdicts file, so it counts nothing. The rows by lane:

- SIT-an1's FAIL is its check 1 (F1.953). Its two Other rows are:
  - control B2, "partial": the teardown did not reproduce, and the READY and Allow steps were BLOCKED by host load;
  - its INSTRUMENT diagnosis of SIT-an's presses.
- SIT-an2's FAIL is 2e, "FAIL (product) + instrument artefact": the summary fork's duplicate card (F1.919). Its
  BLOCKED row is 2c', the Stop Task control.
- SIT-an3's Other row is its INSTRUMENT diagnosis of SIT-an's presses. The FAILS 1 under it re-observes the known
  F1.919, so it is not counted as a FAIL row. Its BLOCKED row is control b.
- SIT-ao's fourth PASS is its positive control.

**What each fix did on RC #4.** "Held" is the lane's PASS on the check that re-runs the fix.

| Row | Fix | On RC #4 | Evidence |
| --- | --- | --- | --- |
| F1.953 (another chat's creation respawns a claude child) | `cb3bab747` | FAILED on SIT-an1's check; the env-drift respawn the fix removed did not recur | SIT-an1 1: session A's background worker card was pending, with the fork's twin, so the count read 2. B was created and bound to its own project folder. 1.65 s later the host unregistered A's session-scoped callbacks, A's child logged its PreToolUse hook "cancelled (control stream closed)", and the worker ended `exitPath=error`. A's READY turn built a new agent and resumed the SDK session, with no `Reusing the live session` line and no `Live session options drifted` line. A's two cards stayed; two Allows cleared them and ran nothing, and `scratch-a` still exists. The controls: on the same build SIT-an's bg2 logged `Reusing the live session` three times after two sessions were created after it, and each unregister there named the new session. SIT-an1's B2, created with no project folder, unregistered A2 0 times in about 6 min. SIT-ao's A2 (direct Anthropic, no worker) reused its live child after B was created, with `drifted` 0 times in the log |
| F1.954 (a Stop-refused card stays counted) | `6091b7b4b` | held | SIT-an2 2a and 2b: two cards were pending, the worker's and the fork's twin. A double-Escape Stop interrupted the turn, and both hook waiters returned deny 21 ms later. `awaitingApprovalCount` read 0 on the first sample (+1.8 s, the poll's own latency) and on every sample through +11.6 s. `pendingApproval` in `session.jsonl` went from true to false. After a relaunch: 0 cards, 0 banners and no `pendingApproval`, and `scratch-dir1` still exists |
| F1.900 (a background subagent's card), controls | `e7c514c6d` | held | SIT-an2 2c and 2d: a turn that ended on its own left the count at 2, with `pendingApproval` kept. Allow on a worker's card ran it (`tool_dispatch_end … outcome=ok`): `scratch-dir2` is gone, and `scratch-dir1` and `scratch-dir3` remain. The Stop Task control, 2c', was BLOCKED(budget); it held on RC #3 |
| F1.955 (a refused judge read carries no content) | `2c9656494` + `951a028cf` | held, with a residue | SIT-an3 3: a workspace ask rule on `Read(report.txt)` in five spellings, then an upload of the file to a `.invalid` host, judged 3 times. The one judge that tried the Read got `st: error`, with the header first and verbatim: "(no file content — the host refused this call before it ran; …)". No judge stated what the file contains. Two answered `deny` with no card. One answered `no_objection` on the `.invalid` ground, and the curl ran (exit 6: the host never resolves). Control a: the parent's own Read under the same rule still carded, naming the rule. Control b (the rule removed) was BLOCKED(budget). The residue: that one `no_objection` after a refused read goes against the fix's policy line, so the ASK's "unsure or deny" held in 2 of 3 runs; and in 4 of the 6 judged runs across SIT-an and SIT-an3 the judge never tried the Read, so the header arm is reached only by chance (F1.956's family) |
| F1.958 (two direct-Anthropic chats swap credentials) | `51b3e9d54` | held | SIT-ao 1: A1, then B created with B1, then A2. Stub A logged only A's prefix (19 requests for A1, 2 for A2), and stub B only B's (18 for B1, 0 during A2). A2 reused its live child, alive from A1 through A2, and `drifted` occurs 0 times in the log. A's child carried A's key and endpoint only, and B's child B's only |
| F1.963 (a connection save moves another chat) | `13aefcdda` | held on both trigger arms | SIT-ao 2 and 3: D was set as the default, and then D was saved again while it was the default. C2 and C3 reused C's live session and failed at the vendor again, and stub D logged 0 requests in those phases. C's children, respawned by the auth retry, had no `ANTHROPIC_BASE_URL` and carried C's own key. Positive control: a session on D answered `STUB-D OK` with D's key (18 requests). The SETUP arm with D's slug was not driven: on a direct slug it rewrites the connection to `pi_compat`, and the in-process test covers it |
| F1.901 (the summary fork's duplicate) | `8eb2b456f` (a test pin) | as pinned; the consequence FAILED (F1.919) | SIT-an2 2e and SIT-an3, from SIT-an2's own instance and from SIT-an's logs: the fork's twin came about 30 s after the worker's card. An Allow on it logged "Hook approved tool use for Bash, but canUseTool is required" and ran nothing |

**Every new FAIL on RC #4 and its plan row.** No row had been raised for RC #4's findings at `963463931`. Each "row
owed" is for the controller, who decides the row and its grade; the severity quoted is the lane's own guess.

| Finding | Lane(s) | Runtime | Row | State |
| --- | --- | --- | --- | --- |
| Creating another claude chat and binding it to a project folder tore down a live claude chat that had a pending background worker. The worker died (`exitPath=error`), the chat's next turn built a new agent, and its two cards stayed answerable but ran nothing on Allow. The user is not told the worker died. The env drift F1.953 removed was not the cause, and which session the create-and-bind step disposes is not root-caused. It is the symptom the release notes' F1.953 line says is fixed (CRITICAL by the lane's guess; not a safety hole, since nothing runs without consent) | SIT-an1 | claude | row owed: reopen F1.953, or a sibling row | open |
| When a claude child dies, its orphaned permission cards stay on screen and answerable; the host clears them on Allow and nothing runs. SIT-an1 proposes withdrawing them with a sentence that says why | SIT-an1 | claude | row owed; the nearest row is F1.962 (`killLiveSession` and `destroy` settle waiters without reporting them) | F1.962 deferred |
| A background worker's Allow can land on the summary fork's twin, whose text can match the worker's exactly (SIT-an: both `rm -rf ./scratch-dir`). The twin runs nothing, the worker's own card expires at 540 s, and the model tells the user the prompt went unanswered | SIT-an2, SIT-an3 (SIT-an's logs; the twin reproduced in SIT-an2's instance) | claude | F1.919, with F1.901's pinned behaviour | deferred, LOW. Grade owed: SIT-an2 guesses CRITICAL (a wrong outcome on a core approval flow); SIT-an3 guesses NON-CRITICAL (it fails closed) and asks for F1.919 above LOW |
| A card whose request had already resolved (allowed on the twin, then withdrawn at 540 s) stayed on screen from about 21:27 to 21:35, over the live request's card, and a Deny on it reached no hook. PLAUSIBLE, from SIT-an's screenshot `shots/c1-bg2-stale-banner.png`; not re-driven | SIT-an1, SIT-an2, SIT-an3 (SIT-an's files) | claude | row owed (NON-CRITICAL by SIT-an1's guess; it needs its own re-drive) | open |

Also owed, and not product findings:

- A tooling row for `pressCard`'s "no card left" test (all three SIT-an lanes).
- The controller's call on SIT-an3's observation that a Pi session created 3 s after a workspace `permissions.json`
  edit failed its first message with `Pi subprocess startup cancelled for restart`. The message errored instead of
  being queued; SIT-an3 records it as an observation, not a verdict.

F1.955's residue is the qqq report's "note, not a row", in F1.956's family, and F1.956 stays deferred.

**Readings the lanes named and did not take.**

- The rest of SIT-an1's B2 control, the READY turn and the Allow, BLOCKED by host load. Also its optional `ps eww`
  read of A's `NESSY_SESSION_DIR`: A's first child was already gone. The next reads SIT-an1 names are the host's
  working-directory path for a freshly created session, and whether it takes its target from the renderer's
  still-open session.
- SIT-an2's Allow on the twin in its own instance. Its Stop in 2a refused both cards first, so that arm's evidence
  is SIT-an's logs on the same build.
- SIT-ao's reading of the rrr report's P-2 (the D1.193 retry renews credentials from the DEFAULT connection). With
  D the default, C's retry respawns still carried C's own API key and an empty OAuth token, so the residue did not
  surface for an `api_key` connection. The OAuth case it is about was not driven: it needs the owner's account.
- The launch-environment leg of F1.963 (F1.966, an owner decision), left out on purpose: the launch environment had
  no `ANTHROPIC_BASE_URL`.
- C2's and C3's `Reusing the live session` lines came 54 s and 80 s after the send returned. SIT-ao puts that down
  to the vendor's auth round-trip plus the retry, and did not measure it further.
- After SIT-an2's relaunch, the trust dialog appeared for a folder whose first bind had not raised it. It listed the
  repo's own `CLAUDE.md` four levels up (F1.847's walk), and SIT-an2 answered Keep restricted.

**Every-lane observations on RC #4.**

- **F1.82:** no unexpected exit on any lane: SIT-ao about 20 min, SIT-an1 about 21 min, SIT-an2 about 11 min over two
  launches, and SIT-an3 about 33 min.
  - SIT-an2's two `render-process-gone` lines in `boot.log` are its own TERM stops, and each has a
    `Network service crashed` line in the same second.
  - SIT-an3's one `render-process-gone` line is its own stop.
  - SIT-an1's profile wrote no `boot.log`.
- **F1.212:** SIT-ao, SIT-an2 and SIT-an3 saw 0 `Request timeout` lines. SIT-an1's B2 first send hung on the driver's
  side under load and never reached the host. That is not the F1.212 shape, so it is recorded as BLOCKED.
- **F1.215:** after SIT-an2's Stop, `isProcessing` stayed false on every sample through +11.6 s. The other lanes drove
  no Stop.
- **F1.256:** SIT-ao saw 0 cards over five bypass sessions, whose turns ran no tools. The other lanes drove no bypass
  session.

**Readings for the next drive.**

- Until `pressCard` compares the pressed card, read a press's effect off the host log or the count, never off "no
  card left" (all three SIT-an lanes).
- Answer a claude background worker's card within 30 s, or expect a second one, possibly with the same text, from
  the summary fork (SIT-an2, SIT-an3).
- A double Escape right after `isProcessing` goes true can miss the turn (SIT-an2).
- Wait a few seconds after editing a workspace `permissions.json` before creating a Pi session (SIT-an3).
- A card can sit behind the onboarding screen, out of the DOM until the screen is left (SIT-an3).
- A credential crossing can be measured with no real key: fabricated keys, one loopback stub per connection that logs
  only a key's 6-character prefix, and a connection with no base URL as the vendor-endpoint control (SIT-ao).

## Verdict

The sitting drove five builds of the 1.41.0 branch: 44 lanes, 43 of which wrote a verdicts file. Every verdict above
is the lane's own, and every FAIL became a plan row or is named here as a row owed. The chain:

- **First pass (`5896a66d2`, reporting 1.40.0), 22 lanes:** 190 PASS / 25 FAIL / 88 BLOCKED / 28 NOT_DRIVABLE / 18
  other. Some FAILs were fixed on the branch while the sitting ran, and the rest were born DEFERRED; § Every FAIL and
  its plan row lists each.
- **RC #1 (`69a6d33da`), 9 lanes:** 105 / 13 / 19 / 1 NOT_DRIVABLE / 1 NOT_IN_BUILD / 4 other.
  - The first-pass fixes held. The exceptions are the load-bound readings in its FAIL table: SIT-y's "0 cards" arm
    (F1.857), and F1.739's >100 arm, which was not reached.
  - Its new CRITICAL FAILs were fixed after it: F1.853, F1.854, F1.855, F1.856, F1.860, F1.861, F1.863, F1.876,
    F1.899, F1.900 and F1.902.
  - F1.901 was closed as a refuted premise, with a test pin.
- **RC #2 (`2996d0743`), 5 lanes:** 42 / 1 / 4.
  - RC #1's fixes held, except F1.900 (partial, because of the outside input) and F1.901 (not re-measured).
  - Fixed after it: F1.933 and F1.928, the delta review's F1.920–F1.924, and F1.845, F1.944 and F1.946.
- **RC #3 (`bd8ac0d68`), 3 lanes:** 25 / 2 / 0.
  - Every late fix held, F1.900 on every arm but the count after a turn Stop.
  - F1.953, F1.954 and F1.955 were CRITICAL, and each was fixed after it, with the fix lanes' F1.958 and F1.963.
- **RC #4 (`ce468be1d`, the final build), 5 lanes with 4 verdict files:** 10 / 2 / 2 / 3 other.
  - F1.954, F1.955 (with a judge-variance residue), F1.958 and F1.963 held.
  - F1.953's check FAILED. The env-drift respawn it removed did not recur, but creating another chat with a project
    folder tore a live claude chat down another way.
  - The summary fork's twin card (F1.919) was seen again, now with its user-visible outcome: an approved background
    command never runs.

**What 1.41.0 carries.**

- RC #4 is the branch's product code: no product file changed after `ce468be1d` (read at `963463931`).
- Every CRITICAL finding of the first pass and of RC #1 to RC #3 was fixed, and each fix held live on a later
  candidate on the arms the re-checks reached (the partial readings are named under each RC above), with one
  exception. F1.953's fix removed the respawn it names, but RC #4 found another teardown on the create-and-bind path
  (row owed).
- The release notes carry F1.953's line: "A Claude Code chat no longer restarts … when you open or start another
  chat". SIT-an1's FAIL contradicts it on that path. Whether the line stays, is narrowed or waits for a fix is a
  decision for the controller and the owner, with that row.
- F1.919's grade is owed too.

**What is deferred.**

- Every finding that was not critical is a plan row born DEFERRED under the owner's 2026-09-24 rule. It stays ⬜ for
  the owner after close-out.
- The owner's list is `nessy-wf-checkpoints/work/closeout/leftovers-after-closeout.md`.
- The triage of the 307 deferred rows open at `ce468be1d` is `nessy-wf-checkpoints/work/closeout/triage/ALL.md`. It
  sorts them into 166 that can be done at once, 30 that need the owner's decision, 13 likely stale, 81 after the
  kanban integration, and 17 that need the owner's account, machine or keys.
- RC #4's rows owed are in neither file yet.

**What no RC check drove.** § What could not be driven lists the first pass's NOT_DRIVABLE and BLOCKED items. Four
arms on F1.57's owed list were never driven by any re-check:

- **RS-79 (A17):** SIT-aa drove the `remember` scopes by hand on RC #1, never through the RS-79 case file.
- **CDX-150's MCP half:** BLOCKED on the first pass (SIT-q, the rig) and on RC #1 (SIT-ad, the budget).
- **RS-98's uncapped control:** BLOCKED on the first pass, because its background child waited on a card nobody could
  reach (F1.763).
- **RS-12's subject arm:** BLOCKED twice on the first pass (SIT-s). The model made no tool call and answered
  whitespace only.

The checklist has no re-check reading for any of the four. RS-12, RS-98 and CDX-150 keep their first-pass segments,
and RS-79's row has none from this sitting.
