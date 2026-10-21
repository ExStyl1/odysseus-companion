/**
 * RS-144 (UB14.7) — background tasks you can follow and stop: the task chip and its card, live and DARK, on Pi,
 * Claude and Codex.
 *
 * ## The row
 *
 * UB14.7 replaced our dropdown (`TaskActionMenu`) with v0.15.1's `BackgroundTaskChip`: a meta chip above the composer
 * (spinner + shimmer while it runs, a cross-faded check/cross/stop mark once it ends, "Stopping…" after a Stop the
 * host accepted) that opens a card — type · status · elapsed, the live step count (`task_activity`), a polled output
 * tail or the agent's recent steps and latest message, and Open / Copy / Dismiss / Stop. `ActiveTasksBar` is
 * upstream's wrapping motion row and keeps an open card's chip past its linger. The runtime matrix is ours: Pi —
 * live output and Stop (the supervisor store); Claude — Stop, and live output while the CLI's live level names the
 * task (UB9.8); Codex — Stop, no live read (Open hidden: the stated residue). This id is lane-picked (next free after
 * UB14.32's RS-143), NOT in `run.ts`'s `SITTING` (the checklist is controller-owned — the rs-121 rule), and the
 * controller confirms it at the pin. The DRIVE is the END-sitting wave's; this file is the recipe. The offline arms
 * are `background-task-chip.test.tsx` (the matrix by markup), `background-task-rows.test.ts` (task_activity,
 * stopping), `background-task-chip-state.test.ts` (keepId) and the dark playground sweep of `background-task-chip`
 * and `active-tasks-bar-context` (`registry-render.test.ts`).
 *
 * UB12.79 adds an arm to step 4: an agent's Open is v0.15.1's DOCUMENT overlay (`DocumentFormattedMarkdownOverlay`:
 * the message, a rule, "Recent steps"; a Bot badge naming the task), a command's Open stays L9's terminal with its
 * "Still running —" header. Offline: `task-output.test.ts` (the digest goes up whole), `background-task-chip.test.tsx`
 * (`agentDocument`, the wiring) and the dark sweep of `task-output-overlay`.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts';

const ID = 'RS-144'
const TITLE =
  'the background-task chip and card (DARK): a running chip shimmers with its clock, its card shows the live step count and the output tail (Pi command), the agent\'s steps and latest message (Claude agent) or "No output" with Open hidden (codex terminal); Stop reads Stopping… until the end event turns the chip Stopped; an open card keeps its ended chip past the 8 s linger; Dismiss hides a chip without stopping it'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UB14.7',
  runtimes: ['pi', 'claude', 'codex'], // the card's Open and its live read differ per runtime; Stop exists on all three
  credentials:
    'One model turn per runtime to start a background task (a Pi background shell, a Claude background agent, a codex background terminal): the Nessy gateway card, or the mock card when every gateway model is rate-limited.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '0. Land-check: the packaged build carries the UB14.7 commit or later. Launch by scripts/cdp/README.md\'s env -u launcher — fresh NESSY_CONFIG_DIR, DARK theme (owner rule), bypassPermissions (no permission card is the subject), ONE content panel, a Pi session first.',
    '1. PI COMMAND: ask the agent to run `for i in $(seq 1 120); do echo tick $i; sleep 1; done` in the background. EXPECT one chip in `[data-slot="background-tasks"]` above the composer: `button[data-task-status="running"]` with class `animate-shimmer`, the intent as its label and a ticking clock. Click it — EXPECT `[data-testid="background-task-card"]` above the chip (side top), header "Background command · Running · <clock>", the body a `<pre>` whose text grows by a few "tick" lines every ~2 s and stays scrolled to its end, footer Open · Copy · Dismiss · Stop with Open enabled once output exists. Screenshot dark.',
    '2. OPEN + COPY: press Open — EXPECT the terminal overlay with the whole output and the "Still running — …" header, and the card closed; close it, reopen the card, press Copy — EXPECT the toast "Task output copied to clipboard" and the clipboard ending with the newest tick line.',
    '3. STOP: reopen the card and press Stop — EXPECT the button to read "Stopping…" and be disabled at once (the chip loses its shimmer, its word reads Stopping…), then within a few seconds the chip shows the stop mark and "Stopped" (`data-task-status="stopped"`). Keep the card open for 15 s — EXPECT the chip still there (keepId); close it — EXPECT the chip gone within ~1 s (its 8 s linger already ran out).',
    '4. CLAUDE AGENT: switch to a claude-gateway session and ask for a background agent (the Agent tool with run_in_background, e.g. "in the background, list the files under src and summarise them"). EXPECT a chip whose card shows "N steps" under the title as the agent works (task_activity), "Recent steps" with tool icons and labels, and "Latest message"; Open enabled once a message exists. UB12.79 — press Open: EXPECT the DOCUMENT overlay, not the terminal: a header badge with the Bot icon and the task\'s intent, a `.markdown-content` body with the agent\'s message, a horizontal rule, then "Recent steps" listing each tool in bold with its label (an MCP tool by its source name); no "Still running —" header and no exit badge. Screenshot dark. Let it finish — EXPECT "Result" instead of "Latest message" and the done mark; Open still enabled (its end left a record) and opening the same document with the final answer.',
    '5. CODEX TERMINAL: switch to a codex session and start a background terminal (a long `sleep 60 && echo done`). EXPECT a chip whose card reads "No output" with NO Open button (footer Copy · Dismiss · Stop, Copy disabled) and no request to sessions:readTaskOutput while it is open (DevTools network/WS frames). Stop — EXPECT Stopping… then Stopped.',
    '6. DISMISS: start one more Pi background command, open its card and press Dismiss — EXPECT the chip gone at once; the task keeps running (ask the agent to list background tasks, or `ps`); its end does not bring the chip back.',
    '7. Verdict, for the checklist row the controller writes: PASS when the Pi card polls and tails the output, Open/Copy work, Stop goes Stopping… → Stopped with the chip kept while its card is open, the Claude card shows the step count, recent steps and latest message/result, the codex card offers no Open and makes no output read, and Dismiss hides without stopping.',
  ],
  expected:
    'In the packaged app, dark theme: background tasks appear as quiet pill chips above the composer that shimmer while running and settle into a check, cross or stop mark; each opens a card above it with the live step count and either the command\'s output tail or the agent\'s steps and message, refreshed every ~2 s, with Open, Copy, Dismiss and Stop; Stop reads Stopping… until the task really ends; a codex terminal says "No output" and offers no Open.',
  detector:
    'DOM reads: `[data-slot="background-tasks"] button[data-task-status]` (status attribute, class list for animate-shimmer, aria-label "<type>: <intent> · <status> · <clock>"), `[data-testid="background-task-card"]` (header text, the `<pre>` textContent sampled twice 4 s apart, footer button labels and disabled flags), the overlay header text and its kind (UB12.79: `.markdown-content` for an agent, the Terminal panel for a command); RPC frames for `sessions:readTaskOutput` counted while the codex card is open; the toast text; screenshots only as the dark record.',
  positiveControl:
    'Step 1\'s `<pre>` text MUST grow between two samples 4 s apart — if it does not, the card is not polling (or the command is not running). Step 5\'s zero-read claim is only meaningful against step 1, where the same counter MUST see reads every ~2 s.',
  runOnlyIf:
    'The packaged build carries the UB14.7 commit or later; one model turn per runtime (the gateway, or the mock card on quota exhaustion).',
  doneMeans:
    'UB14.7\'s checklist row (the controller\'s) carries the verdict per runtime: the chip states, the card\'s body per kind, Open/Copy, Stop → Stopping… → Stopped with keepId, the codex no-read residue, and Dismiss — each PASS/FAIL with its reading.',
  doNotConflate:
    'The background-finished chip above the card (another session ended) is UA1.15/UB14.27\'s; the rows above the composer as a whole (badges, the mode chip) are UB14.55\'s; the host read of a Claude task file is UB9.8\'s; the terminal overlay itself is L9\'s and unchanged (a command\'s Open); an agent\'s Open is the document overlay since UB12.79.',
  safety:
    'No credentials read or printed. The background commands are a counting loop and a sleep under the fresh NESSY_CONFIG_DIR\'s session folder; the agent prompts are ordinary read-only requests through the configured card.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
