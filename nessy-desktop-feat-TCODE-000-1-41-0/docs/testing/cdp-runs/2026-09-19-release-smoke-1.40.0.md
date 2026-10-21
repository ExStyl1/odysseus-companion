# 2026-09-19 — the 1.40.0 pre-merge SMOKE on the packaged artefact (lane SIT-7, verbatim report)

**NOTHING RELEASE-BLOCKING FAILED.** All four checks PASS, each with its positive control.

Driven 2026-09-18 19:16 → 2026-09-19 13:02 on `release/mac-arm64/Nessy Desktop.app`, runtime `pi`
(card `pi-api-key`, `pi_compat`, model `coder (tgpt/deepseek-v4-flash-0731)`), dark theme,
`bypassPermissions` (owner rule D1.385).

## Verdict

| # | Check | Verdict | What I actually saw |
| --- | --- | --- | --- |
| 1 | `/btw` empty state (D1.382) | **PASS** (en + ru) | Panel reads *"Ask about this chat — the answer stays out of the transcript"* / *"Спросите об этом чате — ответ не попадёт в историю"*. Neither *"What would you like to change?"* nor *"Just describe it — I'll handle the rest"* (nor their ru twins) is present, and the panel carries a composer — the owner's photographed defect is gone on both locales |
| 2 | nested `/btw` (D1.384) | **PASS** | `/btw and what is a merge` typed INSIDE the panel asks **"and what is a merge"** as the next side question; the `/btw ` prefix is gone; panels stay **1 → 1** (no second panel) and the panel text CHANGED (not a no-op) |
| 3 | no stub-session RPC (D1.383) | **PASS** | `[ChatInputZone] Failed to hydrate queue` logged **0 times** across every `/btw` open of the whole sitting. CONTROL: a REAL session's queue survives a full `Page.reload` — `queueGet` returns the same message id before and after, the strip shows the token after, 0 hydrate errors in the reload window |
| 4 | Stop with a message queued (D1.376/D1.377) | **PASS** | After the queued submit the composer is still `{"type":"button","label":"Stop"}` and `listSessions` still reports `isProcessing: true` — the exact pair that flipped on the defect. The interrupt reached the runtime: `Response interrupted`, the running `Bash` left `executing`, 0 live marked processes. CONTROL arm B (nothing queued): identical Stop, settled 6.1 s, 0 processing gaps, 0 tool growth |

## The artefact

- `CFBundleShortVersionString` = **1.40.0**; bundle mtime **2026-09-18 19:11:56**, binary 19:11:53 — after
  `ef951f951` (18:35:18), the last of the fixes. Never rebuilt, never removed.
- All five fix commits are ancestors of HEAD: `ef951f951` (D1.382), `c6608ba13` (D1.383),
  `df194e02e` (D1.384), `b1a840678` (D1.376), `6b9980c3a` (the Stop seam). Checked at `eee1e919f` when
  the sitting began and re-checked at `dd0d031ef` at exit, the controller having committed meanwhile —
  all five ancestors both times, and the artefact's mtime is unchanged, so nothing measured here moved.
- Literal control in the shipped tree: `Ask about this chat` → **6**, `Спросите об этом чате` → **3**,
  `chat.submit.stopFailed` → **14**, `side-question-panel` → **2**. D1.383/D1.384 ship no new literal
  (identifiers are minified away), so they rest on ancestry plus D1.382's literal, which is the LATEST
  of the three and is present.

## Rig

Ports **9282** only (9283–9291 proven free and untouched); fresh `NESSY_CONFIG_DIR` and `--user-data-dir`
under the lane scratchpad, never under `~`; `NESSY_DEBUG=1`; the owner's profile never launched; no
`dp auth` command run; no token read, printed or committed. The pi card was created by pressing the
product's own onboarding button. App killed by PID at exit, ports proven free.

### Rig finding 1 — the README's launcher deletes 7 of the 13 contaminating names

`scripts/cdp/README.md`'s `env -u` recipe names **seven** variables; `CONTAMINATING_ENV_NAMES` in
`scripts/cdp/lib/app-env.ts` carries **thirteen**. My first launch, made by following the README
verbatim, handed the app six of them — including `CLAUDE_CODE_EXECPATH` (*"which binary a nested
invocation reaches for"*) and `CLAUDE_CODE_MESSAGING_TOKEN`, which that module's own comment calls a
credential. I killed that instance, relaunched with all thirteen deleted, and re-read the running app's
environment: zero present, `NESSY_CONFIG_DIR` present as the read-worked control. Every reading in this
report is from the clean instance.

### Rig finding 2 — a detached app window has NO DISPLAY, and this surface cannot be measured on one

This cost most of the lane and it is the one another sitting will hit. Launched detached, the window
reports `visibilityState: "hidden"` and `document.hasFocus() === false`, and Accessibility reports
**0 windows** for the process even while macOS calls it frontmost. The `/btw` panel is a Radix popover
whose lifetime is focus-driven, and on such a window **it mounts and is removed ~15 ms later**
(MutationObserver: `ADDED` t=1303, `REMOVED` t=1320). I nearly filed that as a release-blocking product
defect. It is not, and three readings say so:

- the Enter **keyup lands after the close** (t=82 vs t=43), so the keystroke is not the cause;
- a **send-BUTTON arm** — `label: "Send"`, no keyboard at all — reproduces it exactly (added t=878759,
  removed t=878773);
- `Emulation.setFocusEmulationEnabled` **plus** `Page.setWebLifecycleState({state:'active'})` restore
  `hasFocus: true` / `visibilityState: "visible"`, and **the panel then stays open** — which is how every
  PASS above was taken. Both must be re-asserted after `freshSession()` and after any reload.

And it is not this wave's doing: `clearSubmittedDraft` (with its `requestAnimationFrame` refocus), the
`SideQuestionOverlay` Popover wrapper and the `SideQuestionPanel` autofocus effect are **byte-identical**
at `df194e02e^` and at HEAD (md5-compared).

### Rig finding 3 — `Escape` to close the slash palette also dismisses the panel

My first driver pressed Escape to clear the palette before Enter, and the panel opened and vanished. The
product's own palette **selection** (type `/btw`, wait for the row, press Enter) is the path, and it
works. The panel's own composer publishes `slash: { commandIds: [] }`, so no palette opens inside it and
a plain Enter is right there.

## Evidence

- Check 1 en: `"Side question Close (Esc) Ask about this chat — the answer stays out of the transcript …"`,
  panels open 1.
- Check 1 ru: `"Побочный вопрос Закрыть (Esc) Спросите об этом чате — ответ не попадёт в историю …"`,
  panels open 1, composer present. Screenshot `CHECK1-ru.png`.
- Check 2: `"… What is a git rebase and what is a merge …"` — the nested question is asked verbatim with
  the prefix stripped; `panels before → after: 1 → 1`.
- Check 3 control: `queueGet` before reload `{"queue":[{"id":"msg-1789822920729-ypzupo","text":"SIT7Q617A4 queued follow-up"…}],"paused":false}`,
  after reload **the same id**, strip visible both times, 0 hydrate errors.
- Check 4 arm A transcript ordering (the disambiguation that matters): `3` Bash probe-1 *completed* →
  `5` **user QUEUED** → `6` Bash probe-2 ***executing*** → `7` info **"Response interrupted"** → `8` a NEW
  user message. Every tool after index 7 belongs to that new turn, so the interrupted turn did stop.
- Screenshots and console dumps:
  `/private/tmp/claude-503/-Users-i-i-gavrikov-Desktop-work-nessy-desktop/6d85ea66-9b2b-4987-af2d-465eeb2a8515/scratchpad/sit7/out/`
  (scratchpad — nothing written into the repo).

## Proposed rows, each with its control

**P-SIT7-1 — after a Stop with a message queued behind it, the session starts ANOTHER turn, and what it
re-sends is the ORIGINAL prompt rather than the queued message.** `size S`. Not release-blocking: the
Stop itself is correct on all four of check 4's criteria, and arm B is clean. **Evidence:** arm A
(`ab9b91c0-91d0-447b-8fd7-c8f53f31d396`) — index 7 `Response interrupted`, then index 8 carries the
ORIGINAL 6-probe prompt and index 9 the model saying *"The user re-sent the task"*; five further Bash
calls run to completion, `waitUntilSettled` reports `processingGaps: 1` and times out at 120 s. The
queued follow-up at index 5 keeps its `isQueued` flag and is never answered. **Control:** arm B, the
identical Stop with nothing queued — `processingGaps: 0`, tool growth **0**, settled in **6 101 ms**. The
only difference between the arms is the queued message, so the queued message is what causes the restart.
Adjacent to RS-81's recorded `cancel_queued` residue (the host sends it **0** times), but not the same
claim: this one re-runs the *original* prompt. **Zone:** the queue drain on `onProcessingStopped`
(`SessionManager`) plus `ChatDisplay.handleStop`'s in-flight-prompt restore — read which of the two
supplies index 8 before proposing a fix.

**P-SIT7-2 — `scripts/cdp/README.md`'s `env -u` launcher is a stale copy of `CONTAMINATING_ENV_NAMES`.**
`size XS`. **Evidence:** rig finding 1 — seven names in the README against thirteen in the module, and a
launch made by following the README handed the app six, one of them a credential. **Control:** the read
this lane already took — `ps eww` over the running app for all thirteen, with `NESSY_CONFIG_DIR` as the
proof the read worked; it answers six before the fix and zero after. **Smallest fix:** have the README
point at the module (or a launcher script that derives the list), so the two cannot drift — the module
already says the list "is a reading with a date, not a closed set".

**P-SIT7-3 — `lib/connect.ts`'s `attach()` does not make the window focused or visible, so every
focus-dependent case measures a window the OS is not showing.** `size S`. **Evidence:** rig finding 2 —
`visibilityState: "hidden"`, `hasFocus: false`, 0 AX windows, and a popover that dismisses itself in
15 ms; two CDP calls fix both and the surface then behaves. **Control:** the pair of readings on the same
window, same minute — panel removed after 17 ms without the calls, panel still open after 1 200 ms with
them; and `document.hasFocus()` / `visibilityState` printed either side. **Why it matters beyond this
lane:** any earlier sitting that measured a focus- or `requestAnimationFrame`-dependent surface on a
detached app may have recorded an artefact. **Zone:** `scripts/cdp/lib/connect.ts` (`attach`), with the
re-assert after `freshSession()`.

## Checklist rows HANDED BACK (I did not edit `docs/testing/cdp-live-checklist.md`)

The controller pins these; I touched no case file and took no `work/rezone.md` TAKE line, because no
repo file was edited.

| Case | Row | Subject | Result |
| --- | --- | --- | --- |
| (new) | D1.382 | the `/btw` panel's empty state, en + ru, on the packaged build | PASS |
| (new) | D1.384 | a `/btw` typed inside the panel asks it, prefix stripped, one panel | PASS |
| (new) | D1.383 | no `queueGet` for a renderer-minted id; a real session still hydrates across a reload | PASS |
| RS-81 | D1.376/D1.377 | Stop with a message queued — the composer-control detector + the no-queue control | PASS |

RS-81's own two rig notes from WI-bk still stand and I did not repair them: `diagnostic()` filters
`-claude.txt` and cannot see the `-claude-host.txt` sibling, and the cheap composer-control detector is
not in the file. I used the composer-control detector directly (one read, no file), which is why neither
blocked this run.

## Uncommitted at exit

EMPTY. `git status --porcelain` is clean; every script this lane wrote lives in the session scratchpad,
and no file under the repository was created, edited or committed.
