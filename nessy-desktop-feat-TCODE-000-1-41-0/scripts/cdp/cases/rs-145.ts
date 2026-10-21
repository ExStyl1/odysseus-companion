/**
 * RS-145 (UB14.34) — the composer visual sitting, live and DARK, at 1400 px and 700 px, plus the paste-a-console-
 * snippet offer per runtime.
 *
 * ## The row
 *
 * UB14.34 lands v0.15.0's pasted-snippet offer: pasting a console snippet (`$ cmd` lines or a fenced shell block)
 * into the composer shows the meta chip "Run in background · <first line>" with a dismiss directly above the card;
 * Run sends the run request (UB14.16's `runCommandMessage`) and clears a draft that IS the snippet; deleting the
 * pasted text withdraws the chip. Ours gates it on the runtime starting a background shell with its OWN tool
 * (`ComposerCapabilities.backgroundShell`, resolved server-side): Claude (`Bash` `run_in_background`) and Pi (our
 * bash `run_in_background`) carry it; codex does not until UB14.19 measures it; `NESSY_DISABLE_BACKGROUND_TASKS=1`
 * withdraws it on both. The row is ALSO the composer area's visual sitting (R4-14): the hint line on focus
 * (UB14.33), the decision ring of a permission prompt (UB14.27), the oversized-attachment toast (UB4.14), the chip,
 * and the mode and model menus (UB14.29/UB14.30) — on Pi, claude-gateway and codex, at 1400 px and 700 px.
 *
 * This id is lane-picked (next free after RS-144, UB14.7's), NOT in `run.ts`'s `SITTING` (the checklist is
 * controller-owned — the rs-121 rule), and the controller confirms it at the pin. The DRIVE is the END-sitting
 * wave's; this file is the recipe. The offline arms are `pasted-command-chip.test.tsx`, the `backgroundShell` arms
 * of `composer-capabilities.test.ts`, `side-question-composer.test.ts`'s UB14.34 arm and the playground sweep's
 * UB14.34 describe in `registry-render.test.ts` (dark).
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts';

const ID = 'RS-145'
const TITLE =
  'the composer visual sitting (DARK, 1400 px and 700 px, Pi / claude-gateway / codex): hint line on focus, the permission prompt\'s ring, the oversized-attachment toast, the mode and model menus; and the pasted console snippet\'s "Run in background" chip — on Pi and Claude only (backgroundShell), absent on codex, withdrawn when the pasted text is deleted'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UB14.34',
  runtimes: ['pi', 'claude', 'codex'], // the look is renderer-only; the chip is per runtime (the capability)
  credentials:
    'none for the look arms (no turn). The permission-ring arm and the Run arm each send one turn per runtime: the Nessy gateway cards, or the mock card when every gateway model is rate-limited.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '0. Land-check: the packaged build carries the UB14.34 commit or later. Launch by scripts/cdp/README.md\'s env -u launcher (it unsets the shell\'s CLAUDE_CODE_* names; also make sure NESSY_DISABLE_BACKGROUND_TASKS is UNSET) — fresh NESSY_CONFIG_DIR, DARK theme (owner rule), ONE content panel, three sessions in one workspace: a Pi gateway card, claude-gateway, a codex card (read back each session\'s BOUND connection as RS-121 does). bypassPermissions everywhere except step 3. Window 1400 px wide.',
    '1. CAPABILITY READ (per session, before any paste): read the session DTO the renderer holds (window.__nessyDebug or the session list RPC the CDP lib already uses) — EXPECT composerCapabilities.backgroundShell === true on Pi and on claude-gateway, and the key ABSENT on codex.',
    '2. HINT LINE (1400 px, Pi): click into the empty draft `[role="textbox"][data-tutorial="chat-input"]` — EXPECT `[data-composer-hints]` under the card goes from opacity 0 to 1 (getComputedStyle opacity after 300 ms), with the Send / new line / mode keycaps; blur — back to 0, height unchanged (24 px reserved). Screenshot dark.',
    '3. PERMISSION RING (default mode, Pi then claude-gateway then codex): set the mode chip to the asking mode, send "Run `ls ~/Documents` and tell me how many entries there are." — EXPECT the decision card replaces the toolbar and the composer card carries the ring (`.input-container` boxShadow contains the --info colour, or --destructive for a risky call); the hint line stays reserved but empty; the mode chip shows ABOVE the card. Deny the card. Screenshot dark per runtime.',
    '4. OVERSIZED ATTACHMENT (Pi; UB4.14): attach a file larger than the transport\'s maxMessageBytes (the handshake value; 16 MiB fallback — a 17 MB PDF under the fresh config dir) through the attach button — EXPECT a toast naming the file (toast.attachmentTooLarge, «Файл «…» слишком большой для отправки» in ru), the transport still connected, the draft kept. Screenshot dark (the toast stack bottom-left in the first pane).',
    '5. SNIPPET CHIP — POSITIVE (Pi, then claude-gateway): focus the draft and dispatch a paste: `const dt = new DataTransfer(); dt.setData("text/plain", "$ bun --version"); textbox.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }))` — EXPECT the draft reads "$ bun --version" and exactly one `[data-pasted-command]` appears directly above the card (after the queue strip, before `.input-container` in DOM order), its button text "Run in background" + "bun --version" (font-mono, tertiary), the play glyph in --accent, a dismiss named "Dismiss". Screenshot dark at 1400 px and again at 700 px (the chip fits: the command truncates with an ellipsis at ≤ 320 px).',
    '6. SNIPPET CHIP — WITHDRAW: select all in the draft and delete — EXPECT `[data-pasted-command]` count 0 within one frame. Paste again, then click the dismiss — EXPECT count 0 and the draft unchanged.',
    '7. SNIPPET CHIP — RUN (Pi, then claude-gateway; bypassPermissions): paste "$ sleep 20 && echo done" and click the chip — EXPECT the draft cleared (it was the snippet), the chip gone, a user message reading UB14.16\'s run-command text with the fenced `sleep 20 && echo done`, and within the turn a background task chip in the row above the composer (BackgroundTaskChip, running) while the turn ENDS before the 20 s are up (the command did not block the turn). Record the elapsed time of the turn.',
    '8. SNIPPET CHIP — NEGATIVE (codex): repeat step 5 on the codex session — EXPECT the draft reads the pasted text and `[data-pasted-command]` count stays 0 (the capability is absent). On the /btw panel of the Pi session, paste the same — EXPECT count 0 there too (the panel\'s ask has no tools).',
    '9. MODE AND MODEL MENUS (each runtime, 1400 px and 700 px): open the mode chip menu, then the model chip menu — EXPECT each opens upward from the toolbar on the floating material (`popover-styled`: border-radius 12px, a non-none box-shadow), rows 30 px, the selected row on --fill-hover; at 700 px the menus stay inside the window (getBoundingClientRect within innerWidth/innerHeight). Screenshot dark.',
    '10. Verdict, for the checklist row the controller writes: PASS when steps 1 and 5–8 hold (the chip on Pi and Claude only, withdrawn on delete and dismiss, Run sends the background request and the turn does not wait for the command) and steps 2–4 and 9 show the hint line, the ring, the named toast and the menus on the dark material at both widths on all three runtimes.',
  ],
  expected:
    'In the packaged app, dark theme: pasting "$ bun --version" into a Pi or Claude composer shows one "Run in background · bun --version" chip right above the card, deleting or dismissing removes it, and Run sends the background request while clearing the draft, with the command shown as a background task chip and the turn ending before the command does; on codex and in /btw no chip appears. The hint line fades in on focus, a permission prompt rings the card, an oversized file is refused with a toast naming it, and the mode and model menus open on the floating material at 1400 and 700 px.',
  detector:
    'DOM reads: `[data-pasted-command]` count and its DOM position relative to `.input-container`, the chip button\'s text and title, the dismiss aria-label; `[data-composer-hints]` computed opacity; `.input-container` boxShadow vs the computed --info / --destructive; the toast text; the menus\' computed border-radius, box-shadow and row height; the session DTO\'s composerCapabilities.backgroundShell; the background task chip in the row above the composer and the turn\'s start/end timestamps from the transcript. Screenshots only as the dark record.',
  positiveControl:
    'Step 5 MUST show the chip on at least one of Pi / claude-gateway — if no runtime ever shows it, the synthetic paste never reached RichTextInput\'s onPaste (check the draft received the text) or the build predates the row; only then is step 8\'s absence on codex evidence. Step 1\'s reading on Pi/Claude (true) is the control for codex\'s absent key on the same read.',
  runOnlyIf:
    'The packaged build carries the UB14.34 commit or later and NESSY_DISABLE_BACKGROUND_TASKS is unset (with it set to 1, step 1 must read the key absent on all three — record that as a separate arm, not a failure).',
  doneMeans:
    'UB14.34\'s checklist row (the controller\'s) carries the verdict per runtime and width: the chip arms (5–8) and the look arms (2–4, 9), each PASS/FAIL with its reading; codex records "no chip (backgroundShell absent)" until UB14.19\'s measurement adds the capability there.',
  doNotConflate:
    'The chip offers to RUN a pasted command as an agent background task (the runtime\'s own tool, the session\'s permission mode); the composer\'s `!cmd` shell mode is a different, HOST-run foreground runner and is unchanged. The transcript code block\'s Run button is UB14.15\'s (its case is UB14.19\'s). The hint line is UB14.33\'s, the card ring UB14.27\'s, the toast UB4.14\'s, the menus UB14.29/UB14.30\'s — this case only records them together.',
  safety:
    'No credentials read or printed. The oversized file is generated under the fresh NESSY_CONFIG_DIR (e.g. `mkfile -n 17m`); the commands pasted are read-only (`bun --version`, `sleep 20 && echo done`, `ls ~/Documents` — the last one is DENIED at the card).',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
