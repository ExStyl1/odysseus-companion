# 2026-10-01/02 — the 1.41.0 final sitting (SIT2, RC #1) and its re-check sitting (SIT3, RC #2)

The final live sitting of the 1.41.0 branch: the do-now group, the mode unification (Explore retired, Claude Code's
five-row picker) and the 2026-10-01 runtime lifts, driven on a packaged release candidate after all of them landed
(owner 2026-09-26: heavy testing once, at the very end). It is the "RC #5" the 2026-09-25 release sitting's
narrative ([2026-09-25-release-sitting-1.41.0.md](2026-09-25-release-sitting-1.41.0.md)) left owed. Two sittings:

- **SIT2**, six lanes SIT2-a … SIT2-f on RC #1 (`831fde57f`), 2026-10-01 18:02–20:40 local (15:02–17:40Z).
- **SIT3**, three lanes SIT3-a … SIT3-c on RC #2 (`198e27f39`), 2026-10-02 02:56–03:29 local (2026-10-01 23:56Z –
  2026-10-02 00:29Z). Every SIT3 check re-drives a SIT2 FAIL that was fixed after RC #1.

Every lane drove its own packaged app instance, all lanes of a sitting at once (owner 2026-10-01, after first asking
for one instance: "давай попробуем еще раз одновременно"). Every lane wrote a verdicts file outside the tree,
`nessy-wf-checkpoints/work/sitting2/SIT2-<x>-verdicts.md` and `…/sitting3/SIT3-<x>-verdicts.md`; SIT2 was triaged in
`nessy-wf-checkpoints/work/sitting2/TRIAGE.md`. This narrative aggregates them. It does not re-judge them: a verdict
below is the lane's own, and every FAIL is mapped to the plan row it became in
`docs/superpowers/plans/2026-09-18-integrations-followup-1.41.0.md` (states read at HEAD `0f595118c`). The owner was
away for both sittings, so nothing that needs the owner's own sign-in, key, account or machine was driven; each such
item is NOT_DRIVABLE with its reason, listed at the end.

## Builds

**RC #1 (SIT2).** Built by the controller 2026-10-01 17:50 from HEAD `831fde57f` after `bun run electron:build:servers`
(servers restaged at `831fde57f`): `release/mac-arm64/Nessy Desktop.app`, bundle mtime 2026-10-01 17:49:27, unsigned
(`CSC_IDENTITY_AUTO_DISCOVERY=false`), `NESSY_FEATURE_PROVIDER_CHATGPT=1`, the rehearsal update feed
`https://updates.invalid/dev` (a failing update check is expected). Runtimes: Claude Agent SDK 0.3.274 / Claude Code
2.1.274 (SIT2-b read `2.1.274 (Claude Code)` off the bundled binary), codex app-server rust-v0.159.3 plus codex's own
`codex-code-mode-host` (integrity verified at build; SIT2-d read the shipped sha256 `357f5463…` equal to the pin and the
host's Developer ID signature), Pi 0.85.1. The tree moved on to `a96b92581` while SIT2 drove, with docs and `scripts/`
commits only (`git diff --stat 831fde57f HEAD -- packages apps` empty, read by SIT2-a).

**RC #2 (SIT3).** Built 2026-10-02 02:52 from HEAD `198e27f39`, bundle mtime 02:52:45, the same flags and feed, servers
restaged at `1b5219f48` (no server-side change after it). SIT3-c read the self-reports off the bundle: claude 2.1.274,
SDK 0.3.274, `codex-app-server` 0.159.3, `pi-agent-server` 0.85.1; its in-app What's New reads "Nessy Desktop 1.41.0".
Between the two RCs are 54 commits, among them every fix in § Every FAIL and its plan row (each checked an ancestor of
`198e27f39` and not of `831fde57f`).

## Rig

- **One instance per lane.** Debug ports 9401–9406 (SIT2-a … f) and 9411–9413 (SIT3-a … c); a relocated
  `NESSY_CONFIG_DIR` and `--user-data-dir` per lane under `nessy-wf-checkpoints/work/sitting{2,3}/<LANE>/`, created
  fresh; `NESSY_DEBUG=1`; the dark theme. No lane touched the real `~/.nessy-agent` or `~/.nessy`, read a token, or ran
  `dp auth login/logout`. Every lane stopped its own app by pid and proved its port free with `lsof`, another lane's
  listener as the positive control. Three SIT2 lanes (b, d, f) had an earlier attempt that was stopped and moved
  aside: SIT2-b and SIT2-d started again on fresh dirs, and SIT2-f's second driver re-scored its predecessor's readings
  from that driver's own logs and screenshots.
- **Launcher (F1.852).** Every launch used the README's `env -u` launcher with its list derived inline from
  `launcherUnsetNames()`, and every lane proved it with `ps eww` (names only): 0 names in the four families
  `CLAUDE_*`, `ANTHROPIC_*`, `MCP_*`, `DISABLE_*` (SIT2-a's launching shell exported 33), `NESSY_CONFIG_DIR` present as
  the control. Launch variables a check needed were added AFTER the list and named: SIT2-c's `ANTHROPIC_BASE_URL` at a
  loopback stub plus a recording proxy; SIT2-d's and SIT3-b's idle knobs `NESSY_IDLE_AGENT_TTL_MS=40000
  NESSY_IDLE_AGENT_SWEEP_MS=10000`; SIT3-a's `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`. SIT2-a measured the other half:
  `run.ts RS-105` with another `NESSY_CONFIG_DIR` exits 2 with nothing run. A debug launch is `-- --debug` (DN-287);
  SIT2-b, SIT2-f's L2, SIT3-a and SIT3-c used it.
- **Profile P1.** Every lane built its gateway cards with the product's own one-click buttons: `pi-api-key` (pi_compat),
  `claude-gateway` and `codex-gateway` (SIT2-e, a Pi-only lane, built the Pi card alone; SIT2-f also added the Nestor
  Cloud card). **No lane saw a browser or a login prompt.** The catalogue was the same on all three cards in both
  sittings (read by SIT2-d and SIT3-b): `coder` = `tgpt/deepseek-v4-flash-0731`
  (SIT3-a read its window as 524 000) and `fast` = `tgpt/qwen36-35b-a3b-fp8`. No lane recorded a gateway 429.
- **Fabricated keys and loopback stubs only.** SIT2-b (Anthropic Messages on 127.0.0.1:18402), SIT2-c (four stubs plus a
  recording CONNECT proxy that REFUSES `*.anthropic.com`, so no fabricated key left the machine and "the child went to
  api.anthropic.com" is a counted refused CONNECT), SIT2-e (an OpenAI-shaped stub for F1.329) and SIT3-a (the SIT2-b
  stub shape). Stubs log header NAMES and at most an 8-character prefix, never a key.
- **Rig confound.** A claude child whose working directory is inside this repo reads the repo's own
  `.claude/settings.local.json`; every lane ran `git init` in its lane root before the first claude session and gave
  every project folder its own `git init`. No lane's verdicts mark a claude reading as confounded.
- **Mode.** `bypassPermissions` everywhere except checks whose subject is the card or the mode, read back from the
  session record after every create (the `freshSession` hazard, F1.775).

## Machine load — read every number with this

SIT2 ran six app instances at once on one Mac, plus each lane's helpers, stubs and case processes. The lanes recorded
load averages of **8 to 23** (SIT2-e 8–13 with a peak of 23; SIT2-a about 15 when RS-105 timed out). At that load:
CDP `Runtime.evaluate` calls hit their 30 s ceiling on SIT2-a (RS-105's A3/A4), SIT2-c (twice, on first prompts that
were answered), SIT2-d (CDX-150, and a plugin install RPC that took about 70 s) and SIT2-f (twice); SIT2-d's CDX-150
fell into the `freshSession` hazard; SIT2-d's branch took 17.9 s to create with four other lanes live; SIT2-e's host log
went silent for 34 s and its relaunch's `rpc.getSessions` took 12–25 s; RS-106's pace was more than 1.5 h per run. The
unauthenticated GitHub API, shared by every lane, ran out (`remaining: 0`) and the registry answered
`plugin.install.repository_ref_unresolved` until the reset. SIT3 ran three instances; its lanes recorded no load
average, gateway turns took 4–20 s (SIT3-a), and no CDP ceiling was hit. **Every duration here is load-confounded and
none is a performance claim**; several arms were BLOCKED by the budget, not by the product.

## Lanes

Counts are verdict ROWS as each lane wrote them (usually one check on one runtime); a compound cell is classed by its
first verdict word. "Other" is SKIPPED, SUPERSEDED, MEASURED, DEFERRED and inconclusive rows. The every-lane
observations (F1.82, F1.212, F1.215, F1.256) are not counted; they have their own section.

### SIT2 — RC #1 (`831fde57f`)

| Lane | Scope | Port | PASS | FAIL | BLOCKED | NOT_DRIVABLE | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SIT2-a | UI, trust, sessions, CLI (Pi mostly; F1.735 on all three) | 9401 | 15 | 3 | 1 | 1 | 1 |
| SIT2-b | Claude gateway: cards, hooks, background work, goal Stop, memory tool, the Claude lifts | 9402 | 9 | 2 | 1 | 3 | 2 |
| SIT2-c | Claude settings files and endpoints (loopback stubs) | 9403 | 7 | 1 | 0 | 1 | 0 |
| SIT2-d | Codex: modes, auto-review, resume, branch, plugins mid-turn, MDM rig, the codex lifts | 9404 | 13 | 3 | 2 | 1 | 3 |
| SIT2-e | Pi: plan and re-submit, compaction Stop, subagent cards, agents, LSP, outside-root cards, usage | 9405 | 10 | 2 | 2 | 0 | 2 |
| SIT2-f | Modes across runtimes, CDP case re-drives, tool loading | 9406 | 18 | 5 | 1 | 1 | 1 |
| **Total** | | | **72** | **16** | **7** | **7** | **9** |

Of the 16 FAIL rows, 4 are instruments (SIT2-a's `answerTrustGate` outcome; SIT2-f's RS-05, CRU-4 and RS-103
detectors) and 12 are product findings. Three more product findings sit outside the FAIL count: SIT2-b's Update
Required stub arm (inside a row classed NOT_DRIVABLE by its real-key arm), SIT2-b's ask-rule finding (its FAIL 3, no
check row) and SIT2-f's queued message sent at the next launch (an observation).

### SIT3 — RC #2 (`198e27f39`)

| Lane | Scope | Port | PASS | FAIL | BLOCKED | NOT_DRIVABLE | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SIT3-a | Claude re-check: goal Stop, Update Required, 1M window, ask rule, withdrawn line, hook banner | 9411 | 10 | 0 | 0 | 0 | 0 |
| SIT3-b | Codex re-check: resume after restart, Always Allow text, fork notice, CDX-150 | 9412 | 9 | 1 | 1 | 1 | 0 |
| SIT3-c | Pi, modes, queue, notes and the fixed harness cases | 9413 | 11 | 0 | 0 | 0 | 0 |
| **Total** | | | **30** | **1** | **1** | **1** | **0** |

SIT3's one FAIL is an extra arm, not a re-check row (/clear on a BRANCHED codex chat, F1.1278). SIT3-c's F1.68 row is
classed PASS by its first word (tier 4) while the case itself printed FAIL on its control (an instrument, F1.1285).

## Cases driven

The CDP cases (`scripts/cdp/cases/`) the two sittings ran; their checklist rows carry the same readings. Counts are the
case's own `##CDP-RESULT##` line (checks passed / scored).

| Case | Sitting, lane | Runtime(s) | Verdict | Row(s) |
| --- | --- | --- | --- | --- |
| RS-105 | SIT2-a | pi | FAIL by error (`cdp-timeout` in A3/A4 at load ~15); 8/8 scored checks PASS, A1 and A2 among them | F1.851, F1.852 |
| RS-81 | SIT2-f | claude-gateway | PASS 17/17 (312 s) | D1.376, F1.767; side reading → F1.1248 |
| RS-81 | SIT3-c | claude-gateway | PASS 17/17 (279 s), plus a hand quit-and-relaunch arm PASS | F1.1248 |
| RS-107 | SIT2-f | pi, claude-gateway, codex-gateway | PASS 13/13, 14/14, 15/15 | F1.767 |
| RS-99 | SIT2-f | pi (fresh profile) | PASS 6/6 (56 s); the LSP half could not start on this Mac (SIT2-e) | F1.810, F1.1012 |
| RS-106 | SIT2-f | pi, claude, codex | BLOCKED (budget): 2 of 21 invocation arms in 13 min, each PASS | F1.877 |
| RS-05 | SIT2-f → SIT3-c | pi, claude, codex | FAIL 23/24 (instrument) → PASS 24/24 | F1.915, F1.1250 |
| AGT-10 | SIT2-f | pi, on Plan | PASS 4/4 | F1.1054 |
| CRU-1 | SIT2-f | claude-gateway, on Plan | PASS 12/12 (4th run; the first three were the rig) | F1.1054 |
| CRU-4 | SIT2-f → SIT3-c | codex vs pi | FAIL 8/10 (instrument) → PASS 10/10 in en and in ru | F1.1054, F1.1250, F1.1249 |
| RS-65 | SIT2-f | pi, Guardian off | PASS 6/6 | F1.1054 |
| RS-103 | SIT2-f → SIT3-c | pi | FAIL 16/17 (instrument; F1.1020's prompt PASS) → PASS 17/17 | F1.1020, F1.1250 |
| CDX-150 | SIT2-d → SIT3-b | codex-gateway, rust-v0.159.3 | BLOCKED (harness hazard, no fixture) → PASS 8/8 | F1.1215 |
| W19R-C3-4 | SIT3-c | pi, Auto | FAIL 14/15 by the case: tier 4 PASS, the control's scoring is the instrument | F1.68, F1.1285 |

Hand arms that touch a case's subject are recorded in that case's row the way the checklist already records hand arms:
SIT2-b's user-scope `remember` on claude-gateway (RS-79's A17 slot), SIT2-a's open-page arm of F1.851 (RS-105), SIT2-d's
hand evidence for CDX-150, and SIT3-c's restart arm (RS-81). Every other check in both sittings was a hand check named
by its plan row; those live in this narrative only.

## Results by lane — SIT2 (RC #1)

### SIT2-a — UI, trust, sessions, CLI

- **Trust.** The trust dialog no longer follows File > New Chat (F1.974): two rounds, the dialog stayed with chat A and
  bound A. `answerTrustGate`'s live read of the folder box by `data-testid=project-trust-path` (F1.976, F1.991) matched
  the bound folder in five dialogs, and the RC carries the test id. But the helper REPORTED `not-shown (already decided:
  …)` after its own click had answered, 4 of 4 times (instrument, fixed by F1.1250). "Keep restricted" on a running
  chat's folder (F1.977) stopped it with exactly one persisted warning naming the folder, still there after a reload.
- **Sessions and CLI.** An Add Source turn over 4 min kept streaming with 0 request-timeout errors (F1.754). The
  permission-mode doors read `ask` as `default` and refuse `junk` by name, on codex (F1.800) and on the RC's create door
  (F1.1000); the CLI arm was BLOCKED (the source headless server stayed silent 240 s, twice; the packaged app ships no
  CLI).
- **Sources.** A built-in dp server switched off answers no tools at once on the server and on a RE-OPENED page
  (F1.851; RS-105's A1/A2 green on a once-on profile), but a page already OPEN keeps its 11 tools until re-opened
  (FAIL, F1.1251). The '29 did not load' list matched the banner and `81 active` on claude, Pi and codex alike: the 28
  built-in dp servers (off by default) plus the lane's own unselected folder source, so the long-standing "28 did not
  load" is expected (F1.735).
- **Watches.** Two task chips for one task (F1.968) and a resolved card left on screen (F1.970): no sighting, but with
  one background task and one card in the drive both are weak negatives.
- **Nested skills on Pi (F1.63):** FAIL. After `Read pkg/notes.txt` the nested `pkg:sit2a-deploy` never appeared in the
  listing or the palette (claude passed the same shape at the 2026-09-25 sitting); F1.1253, deferred.

### SIT2-b — Claude gateway

- **PASS:** the codex ask card now leads with "Bash requires approval" (F1.887); a background worker's card is withdrawn
  with one line naming the command when its child is stopped in the app by a folder change, and an app quit keeps it for
  R7 (F1.975); a blocking `UserPromptSubmit` hook shows its reason as a warning row (F1.864, with a residue: the
  "Original prompt" was the host-decorated prompt, 2613 px tall → F1.1247); the model-capability line appears once per
  new child in `main.log` (F1.822, 15 of 17 children — the two spawned at a user Stop logged none); a user-scope
  `remember` returns plain text (F1.909); a trusted project's `.claude/settings.json` `ANTHROPIC_AUTH_TOKEN` reaches a
  direct card's stub, is named (never its value) in the transcript and the config doctor, and an untrusted project names
  nothing (F1.1043, F1.1064); the bundled claude is 2.1.274 and runs a tool turn (F1.1213).
- **F1.61 answered:** on Claude Code 2.1.274, `ultrathink` adds a per-turn reasoning reminder and changes no budget or
  effort; it passes through our composition untouched.
- **FAIL, CRITICAL — Stop on an active Claude goal restarts it** about 8 s later with a "Continue active goal" row, 2 of
  2, and the agent resumed running tools (the DN-284 prediction, measured; F1.1239). It also explains F1.215's "spinner
  comes back after Stop" on this lane.
- **FAIL — 1M Claude models read a 200K window** (Fable 5.1, Opus 5.5, Opus 4.8 on a direct stub card; F1.1214,
  F1.1221). The owner then decided to remove the Extended context switch (F1.1241).
- **Stub-arm FAIL — the "Claude Code Update Required" card said the bundled runtime is "unknown"** (F1.1240); the
  real-key arm is the owner's.
- **New, FAIL 3 — one workspace ask rule for `touch …` carded every unrelated compound or redirected Bash on Claude, in
  Bypass too, naming that rule** (fails closed; F1.1245).
- **BLOCKED / NOT_DRIVABLE / SKIPPED:** F1.821 (no gateway model lacks xhigh, and on this build the clamp already
  happens on turn 1; the stub's background tool stalled); F1.1001 (the managed policy is a root-owned system file);
  F1.1219's `defaultToNo` (claude.ai-only producers) and its `suppressAlwaysAllowRule` arm (an MCP fixture, budget);
  F1.874 (budget). The F1.975 "Keep restricted" side arm was inconclusive (the line is renderer-only and the DOM was read
  after a re-navigation); that transience became F1.1246.

### SIT2-c — Claude settings files and endpoints

The endpoint rule held on all six claude arms: a launch `ANTHROPIC_BASE_URL` (F1.966), a trusted project's
`env.ANTHROPIC_BASE_URL` (F1.981) and its provider toggle `CLAUDE_CODE_USE_VERTEX` (F1.1006), each on claude-gateway and
on a direct card. Every stub got 0 requests apart from the lanes' own positive-control curls, every direct turn ended at
a refused CONNECT to api.anthropic.com, and the transcript and the doctor named each ignored file or name. The Dock-like
leg (F1.980) measured that the boot reset erases login-shell-only managed names (Bedrock, AWS) before any runtime child
spawns, while a non-managed marker survives; the decide-half is F1.1256. The fail-closed policy (a workspace
`permissions.json` with 513 deny rules, the reachable route to F1.1002) refused every claude tool call with the
compiler's sentence, warned in en and ru, and on codex refused the escalated call — but codex's v2 approval carries no
reason, so the model was told "rejected by user" and the reply blamed the user (FAIL, NON-CRITICAL; F1.1255). The ru
warning left "в workspace" untranslated (F1.1238). 0 cards in any bypass session.

### SIT2-d — Codex

- **PASS:** turning auto-review off reaches a live session (F1.781); Plan with the sandbox switch off refuses a project
  shell write with no card and cards an edit, while a write into the session plans folder lands (F1.787, F1.1003); a
  plugin installed and uninstalled mid-turn defers its refresh and revokes nothing (F1.766); the MDM stand-in on a scratch
  copy of the shipped codex answers `requirements_toml_base64` (F1.636, rig half); open, resume and branch with the
  `codex-deny-read-slows-thread-open` diagnostic gone (F1.1027); a branch answers from the parent (F1.1076); auto-review
  ON cards the user in Manual and routes to the reviewer in Auto (F1.1169 — the reviewer still answers 404 on the gateway
  cards, F1.724); Don't ask with the switch off refuses an in-project write with no card (F1.1056); an MCP deny rule added
  mid-session holds by withholding the tool (F1.937); a writeStdin card appears for an escalated terminal (F1.1215); the
  bundle ships a signed `codex-code-mode-host` beside the app-server (F1.1216, bundle half).
- **F1.929 explained:** the "lost first press" on a fresh session's first card is the project-trust modal opening over
  the card; the first click dismisses the modal. Closed as harness.
- **F1.780's credential-protection line** is SUPERSEDED by F1.1057 (no credential floor).
- **FAIL, CRITICAL — a codex chat forgets its conversation after a quit and relaunch**, 2 of 2, with no notice: the saved
  thread id never reached `CodexAgent` (`RUNTIME_ANCHOR_SUPPORT['codex-runtime'] = false`; F1.1235). The idle-release arm
  was BLOCKED: the reaper never fired.
- **FAIL — the Always Allow card said "for the session"** while it saves a workspace execpolicy rule (F1.1236).
- **FAIL, new — codex 0.159.3's "DEPRECATION NOTICE — Full-history hydration…" showed as a chat row** on every fork
  (F1.1237).
- **BLOCKED / NOT_DRIVABLE / SKIPPED:** CDX-150 (the harness hazard under load, no fixture); F1.634 (a real MDM profile or
  root-owned `/etc/codex/managed_config.toml`); the code_mode_only turn of F1.1216 (no such model in any reachable
  catalogue); F1.64 and F1.65 (budget). The ru codex runtime note said "Bypass" against the picker's «Обход разрешений»
  (F1.1249).

### SIT2-e — Pi

- **PASS:** a trusted project's own `.claude/agents/one-turn.md` runs with no "Unknown agent" (F1.730; its name never
  reaches the model's tool description, F1.1262); `/code-review` twice in bypass raises no `mcp__tool_load` card
  (F1.956); a subagent's card counts on the parent (F1.903); a judge's refused out-of-root read is marked "no file
  content" (F1.959); a no-project chat names and writes its workspace root while plans go to the session plans folder
  (F1.907, F1.915); Plan's submit, leave and Accept → Manual (F1.760); an outside-root card leaves when its call TIMES
  OUT (F1.957); usage totals add both calls of a turn, a plan-submit turn's usage, and a stopped turn's one call, with no
  auto-continue (F1.1073, F1.628, F1.1162).
- **F1.329 measured:** pi-ai sends `stream_options` and `max_completion_tokens` to a custom endpoint; a strict endpoint
  rejects the request with no retry (F1.1263).
- **FAIL, CRITICAL — a revised Pi plan after feedback opened with the OLD plan and the feedback turn's tools all failed**
  (1 of 2 runs): the plan handoff never aborted the Pi run, whose stale `SubmitPlan` retry landed inside the feedback turn
  (F1.1242).
- **FAIL, CRITICAL — Stop with a Pi outside-root card up left the card counted and durable** (in the record and the
  backend, also after a renderer reload); the triage read from the code that after a restart one Allow could then re-run
  the stopped call (F1.1243).
- **BLOCKED / SKIPPED:** Stop during a manual `/compact` (nothing large enough to compact; F1.621, F1.729); Pi + LSP
  (F1.1013, F1.1024, F1.1025, F1.1012: this Mac's global TypeScript 7.0.2 has no `tsserver.js`, and the product then
  projected no `lsp` tool and gave no notice); F1.68 (budget).

### SIT2-f — Modes, case re-drives, tool loading

- **Modes PASS on the packaged build:** the EN and RU pickers (Auto Recommended 1 … Bypass permissions 5, no Don't ask
  row), the Default badge following Workspace Settings, the SHIFT+TAB ring skipping Don't ask, Don't ask shown on a
  session an automation runs in it, each codex mode per the F1.1056 table (Manual's documented residue visible), Nestor
  Cloud still Plan and Act only (F1.1050–F1.1056, F1.1070), and a hand-written `explore` automation read as Plan, edited
  with no unattended-edit card in Auto against an allow-all control that cards, and saved back as `plan` (F1.1166).
- **FAIL, CRITICAL (a regression) — a session stored as Explore opened in Manual**, and the file was rewritten as
  `default`: the startup restore read headers without the Explore → Plan normalization (F1.1234).
- **FAIL — the "Plan mode" view lists nothing:** the sidebar has no Views entry and even control views list 0 rows. The
  release notes promised the view (CRITICAL as a notes promise, F1.1244); the dormant views surface is F1.1261.
- **Cases:** see § Cases driven. RS-05, CRU-4 and RS-103 failed only on their detectors (F1.1250).
- **Observations:** the first renderer load after a `-- --debug` launch failed to load sessions ("Workspace connection
  is unavailable"; a reload recovered; a normal relaunch did not reproduce it; F1.1270). A claude message queued behind
  RS-81's Stop was sent by itself at the next launch, 55 min later, in Auto (F1.1248).
- F1.623 needs the owner's ChatGPT subscription; F1.1069 (the iPhone simulator) is deferred by the owner.

## Results by lane — SIT3 (RC #2)

### SIT3-a — Claude re-check

Every re-check PASSED. Stop on an active goal (F1.1239), twice: the log now ends the turn `interrupted` within about
115 ms, 0 `Starting chat` and 0 "Continue active goal" rows for over 60 s (15 min after a third Stop), and the goal
resumes only on the user's next message. The Update Required card names "the bundled runtime is 2.1.274" (F1.1240).
F1.1241: Settings → AI has no Extended Context switch in en or ru; Opus 4.8 and Fable 5.1 on a direct stub card run at
1M (the spawn line, the `context-1m` beta, the meter's "1000k" and `/context`'s "Window size 1,000,000") with BARE ids in
the UI; `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` gives 200K; the gateway window is unchanged (524 000). A workspace ask rule now
cards only a compound command containing its command (F1.1245: 4 unrelated compounds ran in Bypass with no card, the one
with the touch carded). The "Permission request withdrawn" line survives a reload (F1.1246). The hook-block banner shows
the reason only, 39 px tall (F1.1247). Residues: the stored `contextWindow` reads 200 000 after turn 1 of a fresh 1M
child (F1.1283); `[1m]` appears in the stored per-model usage keys (F1.1279); the meter is blank after an ordinary
direct-card turn and `/context` once read "Unavailable" (F1.1284).

### SIT3-b — Codex re-check

F1.1235 held on both restart arms (a TERM quit and a KILL): `thread/resume` with the same thread id and the right
answer, 0 resume-failed notices. `/clear` after a resume starts a fresh thread and the cleared history does not come
back (`dfd27978d`). With the kept rollout folder moved away, the "could not resume" notice shows and a new thread
starts. Boundaries: a fresh session logs `thread/start`, a branch `thread/fork`. The idle arm was BLOCKED again: the
reaper never fires for a session holding an MCP-pool lease (read from code; F1.1282). The Always Allow card now says
it saves a rule in the workspace permissions (F1.1236). No DEPRECATION NOTICE row after a branch and an execpolicy
re-fork (F1.1237). CDX-150 PASS 8/8. The code_mode_only turn stays NOT_DRIVABLE (catalogue: the two `tgpt/` models
only). **FAIL (extra arm):** `/clear` on a BRANCHED codex chat re-forks the parent and the model still knows the
cleared conversation (F1.1278; pre-existing since P6.102).

### SIT3-c — Pi, modes, queue, notes, harness cases

Every re-check PASSED. Stored `explore` and `safe` headers restore as Plan and never become `default` (F1.1234). The
Pi revised plan after feedback, twice: a new card with the revision, the feedback turn's tools succeed, and Pi's log
shows the handoff abort after every `SubmitPlan` (F1.1242). Stop with a Pi outside-root Write card up: count 0, no
`pendingApproval`, and no card after a restart (F1.1243). A Stop-paused queue stays paused across a quit and relaunch
until Resume, against an unpaused Pi queue replayed at startup (F1.1248). The ru fail-closed warning reads «в рабочем
пространстве» (F1.1238). What's New carries RN-3's wording (F1.1244), and its runtime bullet equals the bundle's
self-reports. CRU-4 (en and ru), RS-103 and RS-05 PASS on the fixed cases (F1.1250). F1.68's fourth tier is honoured;
the case's control scoring is the instrument (F1.1285). Side notes: sessions saved in Bypass reopen in Auto (F1.1281);
after a Stop claude pauses its queue while Pi sends it (F1.1280); the 1.41.0 release notes still carry the date line
"September 25, 2026".

## Every-lane observations

- **F1.82 (an exit with no report):** none, in either sitting. Every exit was a lane's own stop. The main process needed
  KILL 5–15 s after TERM on SIT2-a, SIT2-b, SIT2-c's arm B, SIT2-d's first stop, every SIT2-e stop and SIT3-c's first
  stop (a Pi turn still running); SIT2-f, SIT3-a and SIT3-b stopped on TERM. No data was lost: SIT2-b's durable card
  record survived the KILL. Readings appended to F1.782 and F1.82.
- **F1.212 (a request timeout on a first prompt):** 0 `Request timeout` lines in the app logs of every lane but one.
  SIT2-e's relaunch showed "Failed to load sessions … Request timeout: sessions:get (30000ms)" for about 20 min through
  three Retries, at load 8–13, and the next launch did not reproduce it; with SIT2-f's `-- --debug` first-load failure
  it is F1.1270, a measure row. The harness's own 30 s CDP ceilings are not this row.
- **F1.215 (the spinner back after a Stop):** seen only on SIT2-b's claude goal session, where it was the goal
  restarting (F1.1239). On SIT3-a, after the fix, it did not recur after three Stops.
- **F1.256 (a card in a bypass session):** SIT2-a saw one, a Pi outside-root read card in the hidden "MCP Source
  Configuration" session, unanswered for 80 s while Bash read the same folder with no card (a posture question,
  F1.1254). SIT2-b's bypass cards were the subject of F1.887 and the ask-rule defect (F1.1245); SIT3-a's one card was
  F1.1245's own subject. Every other bypass session in both sittings raised 0 cards.

## Every FAIL and its plan row

"Held on RC #2" is the SIT3 lanes' own verdict; every fix commit below is an ancestor of `198e27f39` and not of
`831fde57f`. CRITICAL is the owner's definition (a security or safety hole, data loss, a crash, a core flow broken for
users, wrong user-facing behaviour the release notes promise, or a regression this release introduced); everything
else was born DEFERRED under the 2026-09-24 rule unless it was cheap enough for the do-now group.

### SIT2's findings

| Finding | Lane | Runtime | Row | Fix | On RC #2 |
| --- | --- | --- | --- | --- | --- |
| A session stored as Explore opens in Manual and is rewritten `default` (CRITICAL, regression) | SIT2-f | all | F1.1234 | `514e1c2ae` | held (SIT3-c) |
| A codex chat forgets its conversation after a quit and relaunch, silently (CRITICAL, regression) | SIT2-d | codex | F1.1235 | `3fc0ceac7` `dfd27978d` | held on both restart arms, `/clear` and the resume-failed notice; the idle arm unreachable (F1.1282) |
| The codex Always Allow card says "for the session" for a workspace rule (CRITICAL, false text) | SIT2-d | codex | F1.1236 | `9c62e2d77` | held (SIT3-b) |
| Codex 0.159.3's deprecation notice shown as a chat row on every fork (CRITICAL, regression) | SIT2-d | codex | F1.1237 | `fcdd8320d` | held (SIT3-b) |
| Stop on an active Claude goal restarts it 8 s later (CRITICAL, safety) | SIT2-b | claude | F1.1239 | `9fdaafdb3` `2d90eaab7` | held twice (SIT3-a) |
| The Update Required card says the bundled runtime is "unknown" (CRITICAL, false text) | SIT2-b | claude | F1.1240 | `4895b66a0` | held (SIT3-a) |
| A revised Pi plan after feedback opens with the old plan; the feedback turn's tools fail (CRITICAL, CR-A) | SIT2-e | pi | F1.1242 | `328646b76` | held twice (SIT3-c) |
| Stop leaves a Pi outside-root card counted and durable (CRITICAL, CR-B) | SIT2-e | pi | F1.1243 | `01d0d8528` | held, also across a restart (SIT3-c) |
| The notes promise a sidebar "Plan mode" view (CRITICAL, CR-C), and two notes sentences over-promise (F1.851, F1.1002) | SIT2-f, SIT2-a, SIT2-c | notes | F1.1244 | `7302a4f4d` | held (SIT3-c, What's New) |
| 1M Claude models read a 200K window | SIT2-b | claude | F1.1214, F1.1221 → F1.1241 (the switch removed, owner 2026-10-01; F1.1232 closed with it) | `b35591a2e` `04cac6e4b` `cec8a953a` `fe8898167` `caaaa0a54` | held (SIT3-a); residues F1.1279, F1.1283, F1.1284 |
| One workspace ask rule cards every unrelated compound Bash on Claude, Bypass included (introduced this release) | SIT2-b | claude | F1.1245 | `adcdf63dc` `4ea1a4c67` | held (SIT3-a) |
| The F1.975 withdrawal line is gone after a reload (introduced this release) | SIT2-b | claude | F1.1246 | `668bf3ae1` | held (SIT3-a) |
| The hook-block banner shows the host-decorated prompt (introduced this release) | SIT2-b | claude | F1.1247 | `d7dccf4a5` | held (SIT3-a) |
| A message queued behind a Stop is sent by itself at the next launch (raised to do-now: the agent starts after a Stop) | SIT2-f | claude | F1.1248 | `cb22805b6` `75dd9895d` | held (SIT3-c) |
| The ru fail-closed warning says "в workspace" | SIT2-c | i18n | F1.1238 | `1db267c95` `c9ecbe644` | held (SIT3-c) |
| The ru codex runtime note says "Bypass" | SIT2-d | i18n | F1.1249 | `37f162b61` | held (SIT3-c, CRU-4 in ru) |
| An OPEN dp MCP page keeps its tools after the switch goes off | SIT2-a | ui | F1.1251 | deferred (the notes sentence qualified by F1.1244) | — |
| Pi: the nested `pkg:` skill never registers after `Read pkg/notes.txt` | SIT2-a | pi | F1.1253 | deferred | — |
| Codex: a policy refusal reaches the model as "rejected by user" | SIT2-c | codex | F1.1255 | deferred (the notes sentence qualified by F1.1244) | — |
| The views surface lists nothing and has no sidebar entry | SIT2-f | ui | F1.1261 | deferred | — |
| `answerTrustGate` reports `not-shown` after its own click answered | SIT2-a | harness | F1.1250 | `af0428d5f` | not re-driven live |
| CRU-4, RS-103 arm E and RS-05's Pi control: stale or too narrow detectors | SIT2-f | harness | F1.1250 | `af0428d5f` | all three PASS (SIT3-c) |

F1.929 (the lost first press) closed as harness with SIT2-d's cause (F1.1250's note). Deferred side findings born from
SIT2 with no FAIL row of their own: F1.1252 (a switched-off page's copy), F1.1254 (Pi outside-root cards in Bypass, a
posture), F1.1256 (Dock-launch names, a decision), F1.1257 (stale task chips), F1.1258 (the "Not everything loaded"
notice on a new chat), F1.1259 (the attestation envelope in dp tool descriptions), F1.1260 (Reconnect on switched-off
rows), F1.1262 (project agents absent from Pi's subagent tool description), F1.1263 (pi-ai compat for strict endpoints),
F1.1264 (running rows after a Stop), F1.1265 (`automation_list`'s text), F1.1266–F1.1269 (four RU, notice, codex-row and
automation-order nits) and F1.1270 (the relaunch session-list measure). Readings appended to existing rows: F1.1124,
F1.782 and F1.82, F1.835, F1.1000, and the F1.1012/F1.1013/F1.1024/F1.1025 LSP rig. F1.1271–F1.1277 came from the fix
lanes, not from the sitting.

### SIT3's findings

| Finding | Lane | Runtime | Row | State |
| --- | --- | --- | --- | --- |
| `/clear` on a BRANCHED codex chat re-forks the parent; the cleared conversation comes back | SIT3-b | codex | F1.1278 | do-now (FX-1), re-checked on RC #3 |
| `[1m]` appears in the stored per-model usage keys, against the owner's constraint (F1.1241) | SIT3-a | claude | F1.1279 | do-now (FX-2), re-checked on RC #3 |
| After a Stop claude pauses its queue while Pi sends it at once | SIT3-c | pi, host | F1.1280 | do-now (FX-3, investigate first), re-checked on RC #3 |
| Sessions saved in Bypass reopen in Auto after a restart | SIT3-c (also SIT2-d, SIT2-f) | all | F1.1281 | deferred (safe direction) |
| The idle reaper never releases a session holding an MCP-pool lease | SIT3-b (also SIT2-d) | host | F1.1282 | deferred |
| The stored context window reads 200 000 after turn 1 of a fresh 1M child | SIT3-a | claude | F1.1283 | deferred |
| The meter is blank after a direct-card turn; `/context` once read "Unavailable" | SIT3-a | claude | F1.1284 | deferred |
| W19R-C3-4 scores its `not-tried` control arm as FAIL | SIT3-c | harness | F1.1285 | deferred |

F1.1286–F1.1289 came from the fix lanes PI-1 and EC-1; F1.1289 is the CDP case owed for SIT3-a's hand-driven F1.1241
arms.

## What could not be driven, and why

- **The owner's accounts and keys (owner away).** F1.623 and the code_mode_only turn of F1.1216 (a ChatGPT subscription
  card or an OpenAI key; the gateway catalogue carries no gpt-6, gpt-6.1 or gpt-5.6 model, read on both sittings);
  F1.1213's real-key Opus 5.5 / Sonnet 5.5 arm (driven on a stub instead); F1.1219's `defaultToNo` (only claude.ai
  artifact tools produce it); the dp Reconnect button (it may start a re-login); a real MDM profile (F1.636's real arm,
  F1.634).
- **Root-owned policy files.** The managed policy is read only from `/Library/Application Support/Nessy/managed-policy.json`
  with no per-instance relocation: F1.1001 and F1.1002's broken managed document itself (driven through the workspace
  cap-overflow route instead). Creating it needs sudo and would reach every lane's app. Codex's legacy managed config
  needs a root-owned `/etc/codex/managed_config.toml` (F1.634).
- **iOS.** F1.1069 (the iPhone simulator) is deferred by the owner to after the kanban plan; no lane drove it.
- **This Mac and this rig.** The global TypeScript 7.0.2 (no `tsserver.js`) for the Pi LSP rows; no session large
  enough to compact (F1.621, F1.729); no gateway model without xhigh and no stub that runs a real background tool
  (F1.821); the source headless server for F1.1000's CLI arm; the playground, which the packaged app does not carry
  (F1.1167).
- **The budget, at this load.** RS-106 (2 of 21 arms), F1.64, F1.65, F1.66 (also needs a delivered managed policy),
  F1.874, F1.1219's `suppressAlwaysAllowRule` arm (an MCP fixture), and F1.68 on SIT2 (SIT3-c drove it).
- **States the rig could not reach.** F1.1074's idle-release arm on both sittings (the reaper never fires; F1.1282).
- **Owed from the 2026-09-25 narrative and not in any SIT2 or SIT3 brief:** F1.953's create-and-bind re-drive with a
  path-checked trust answer, and F1.919's twin card. The nearest readings are SIT2-a's (path-checked trust answers bind
  the right chat in five dialogs, F1.974/F1.976; no stale card seen, F1.970) and SIT2-b's (a folder change withdraws a
  worker's card with one line, F1.975). RS-98's uncapped control and RS-12's subject arm were not driven either;
  CDX-150's MCP half is now PASS (SIT3-b), and RS-79's A17 slot has SIT2-b's hand arm.

## RC #3 — the FX re-check

RC #3 was built at 04:03 from `c0acc5997` (FX-1 `e307ce2b6`, FX-2 `156dd7495`, FX-3's case fix `57a0a806d`; servers
restaged). One lane, SIT4-a, drove it on one instance for about 28.5 minutes: **11 PASS / 1 FAIL / 1 BLOCKED /
1 NOT_DRIVABLE**, and the four standing observations (F1.82, F1.212, F1.215, F1.256) clean.

- **F1.1278:** PASS. `/clear` in a branched codex chat opened a fresh thread and the model answered NONE; the control
  branch before the clear still forked and remembered the word.
- **F1.1279:** PASS for the stored per-model usage keys (bare, no `[1m]`). The UI half FAILED on an older gap:
  `/usage` shows no per-model lines at all, because the renderer's usage-update handler rebuilds `tokenUsage` from a
  fixed list that drops `modelUsage` (also seen by SIT3-a on RC #2) — NON-CRITICAL, pre-existing, a DEFERRED row.
- **F1.1280 / RS-103 arm F:** PASS on Pi and Claude: after a Stop the queued message stays paused, Resume sends it. The
  first run on a fresh profile was BLOCKED because all three gateway cards default to "steer", so the message was
  steered, not queued; the arm should set "queue" itself (a DEFERRED case row with arm E's wrong memory-file path).
- **F1.1250 (`answerTrustGate`):** PASS — "answered" 3 of 3 within 1–3 s; a folder with no dialog still reports
  "not-shown".
- **F1.953 and F1.919 (owed since 2026-09-26):** PASS — creating and binding chat B with both trust answers
  path-checked did not tear down chat A, and A's pending card ran its command once; the background worker raised one
  card for 162 s with no duplicate from the summary fork. F1.919's memory-file arm is NOT_DRIVABLE (nothing in the
  drive writes one).

## Verdict

- **SIT2 (RC #1, `831fde57f`), 6 lanes:** 72 PASS / 16 FAIL / 7 BLOCKED / 7 NOT_DRIVABLE / 9 other over 111 rows.
  Nine findings were CRITICAL (F1.1234–F1.1237, F1.1239, F1.1240, F1.1242–F1.1244); none was refuted by the triage's
  skeptics. Each was fixed after the build, with eight cheaper do-now fixes beside them (F1.1238, F1.1241, F1.1245–F1.1250).
- **SIT3 (RC #2, `198e27f39`), 3 lanes:** 30 PASS / 1 FAIL / 1 BLOCKED / 1 NOT_DRIVABLE over 33 rows. **Every fix
  re-checked held live**, on every arm the lanes reached; the exceptions are F1.1235's idle arm (unreachable, F1.1282)
  and F1.1250's `answerTrustGate` half (not re-driven live). The one FAIL is an extra arm (F1.1278).
- **SIT4 (RC #3, `c0acc5997`), 1 lane:** 11 PASS / 1 FAIL (pre-existing `/usage` per-model lines) / 1 BLOCKED (case
  default) / 1 NOT_DRIVABLE. Every FX fix held live. RC #3 is the product code 1.41.0 carries; the commits after it
  touch tests, plans and generated docs only.
- **What is deferred.** Every non-critical finding of both sittings is a plan row born DEFERRED (F1.1251–F1.1270,
  F1.1281–F1.1285, and the fix lanes' F1.1271–F1.1277 and F1.1286–F1.1289), left for the owner after close-out.
