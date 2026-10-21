# 2026-09-20 — the release re-smoke of 1.40.0 (lane SIT-10)

Driven on `release/mac-arm64/Nessy Desktop.app`, `CFBundleShortVersionString` **1.40.0**, bundle mtime
**2026-09-20 08:30:26** — later than `d05d95b13` (08:25:13 +0300), the last code commit it contains. Dark theme,
port 9312 only, a fresh config dir and user-data dir under the lane scratchpad, launched through the README's
derived `env -u` list. The app's own environment carried **zero** of the thirteen contaminating names, with
`NESSY_CONFIG_DIR` seen in the same read as the control that the read worked. The three cards were created by
pressing the product's own one-click buttons.

**The release blocker is fixed.** SIT-9 measured a side question on a chat that had never run a turn failing 5
cold chats of 5, with Pi's own sentence — *"Pi capability runtime manifest is required before subprocess spawn"* —
rendered as the detail under the panel's generic error. On this artefact the same question is **answered** on all
three cards: pi in 5 758 ms, claude-gateway in 4 683 ms, codex in 4 148 ms, zero error bubbles, and the main
transcript unmoved at 0 → 0 in every case. The warm control answers in the same run on each card (3 → 3, 5 → 5,
7 → 7). The arm this fix could plausibly have broken — a side question asked while the model is streaming — was
driven with `isProcessing` and the panel read in ONE poll so "answered" and "still streaming" share a clock: the
answer landed at 2 883 ms (pi), 2 200 ms (claude) and 755 ms (codex) with the turn **still running** every time,
so the warm path still takes no capability turn.

A cold `/recap` was recorded rather than judged, and it corrects the row's own prediction: it is not per-runtime
at all. All three cards answer the same sentence — *"There is nothing to recap yet — this chat has no messages."*
— because the app refuses a recap on an empty transcript before any runtime is reached.

**The claude-gateway Always Allow (D1.436)** was driven in one repository with both runtimes in one app run. The
claude card's "Always Allow" writes **no** rule — `.claude/settings.local.json` does not exist at the bound root
— while still suppressing its own next card in the same session; a **new pi session in that repository still
asks**, which is the harm SIT-9 measured, inverted. The positive control is pi's own click in the same
repository: it still writes the narrow `Bash(npm test *)` of D1.404, never `Bash(npm *)`, and a later pi session
then runs the command with no card. Without that control a pass on the first reading would be
indistinguishable from the persist having been deleted.

**The workspace `permissions.json` floor (D1.438)** holds on pi and on claude-runtime for both spellings that
could be driven: an ordinary file write is refused with *"Direct Write operations in permissions.json are
blocked. Permission rules belong to the user: ask them to change these in Settings > Permissions."*, and a shell
redirect with the `Bash` wording of the same sentence. Neither refusal names `automation_create`, and
`automations.json` beside it still does — each guarded record keeps its own door. A `permissions.json` inside the
user's own project is written normally, so the guard is keyed on the workspace root. The **NotebookEdit** and
**Monitor** spellings could not be driven: the model declined to issue those calls on both runtimes, which is
reported as unavailable rather than as a hole. At exit neither guarded record existed on disk.

**The safety floor those rows sit on** was re-driven whole. `automation_create`'s ceiling accepts `acceptEdits`
(and writes the record — the positive control) and refuses `bypassPermissions` and `auto`, each naming
`acceptEdits` and writing nothing. A `PreToolUse` **command** action created by the model now raises a Bash card
carrying `Execute: <the command>`, and the command does **not** run while that card is unanswered — the marker
file was never created and the tool said so in a sentence naming the remedy. The control D1.343 must keep is
intact: the same command declared in the operator's own `<config dir>/hooks.json`, with the app relaunched, ran
with **no card** and its marker **was** created. And an automation a person set to `bypassPermissions` survives a
model `automation_update` that changes only its name.

**"Remember from this chat" (D1.426)** switches on all three runtimes: unticked, `remember` answers *"Memory is
disabled for this workspace."* and the phrase reaches no `MEMORY.md`. The documented F1.116 residue — a mid-chat
untick still saving until the runtime restarts — did **not** reproduce anywhere. The residue that is live runs
the other way and only on codex: resetting the switch mid-chat does not restore writing. A fresh codex chat
writes normally, which is what makes the OFF reading a real effect of the switch rather than a dead tool.

**D1.425 could not be driven**, and the reason is worth carrying: the withholding receipt is written to a pool
`debug` channel that does not reach a packaged build's captured stderr — a full run's app log carried zero pool
lines — so an absence there has no positive control. The classification itself needs no third-party key.

Teardown: the lane's own app pids were killed by number and ports 9312–9321 proved free with `lsof`. The probe
connection and session created for the D1.425 attempt were removed and `dpFs` returned to `enabled: false`.
