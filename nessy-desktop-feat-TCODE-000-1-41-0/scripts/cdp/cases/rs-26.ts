/**
 * RS-26 (P6.552) — the two live codex arms W6-a proved host-side and could not
 * drive: the `bypassPermissions` answer on a REAL approval request, and the
 * P6.62 `deniedPaths` refusal from the SHIPPED binary.
 *
 * Both arms need an approval request raised by the real `codex-app-server`
 * against a packaged build. The stub provider cannot raise one — which is the
 * whole reason these two rode to the sitting rather than closing in a lane.
 *
 * ## Arm 1 — `bypassPermissions`
 *
 * The host-side answer is built and tested. What is unproven is what the SHIPPED
 * binary does when a genuine approval request meets that mode: does the request
 * stop being raised at all, or is it raised and auto-answered? Those are
 * different products (one of them still round-trips every call through the
 * approval channel) and only a live request tells them apart.
 *
 * ## Arm 2 — `deniedPaths`, and the two things that must be true of the rig
 *
 * P6.62's own `done_means`, verbatim: *"on codex a `Read`/`cat` of a
 * `deniedPaths` entry is refused by the host with **no approval card offered** —
 * the outcome Pi and claude already give — with an ordinary workspace file as the
 * positive control in the same run, the OS profile removed so the HOST arm is
 * what is measured, and a Pi run in the same rig proving the shared floor's
 * behaviour did not move."*
 *
 * Three riders, each of which a careless sitting drops:
 *
 * 1. **The OS profile must be removed.** codex's own `permissions.filesystem`
 *    deny carries all nineteen floor entries and is OS-enforced, so with it in
 *    place a refusal proves the OS profile works and says nothing about our
 *    gate. P3.308 also measured a Linux root-anchored deny making the sandbox
 *    fail to BUILD rather than deny, so the OS arm is not even a consistent
 *    substitute.
 * 2. **The distinguishing observation is the ABSENCE OF A CARD**, not the
 *    refusal. Before P6.62 the request was refused too — by the human declining
 *    the card that should never have been offered. "It was refused" passes on
 *    both the fixed and the broken build.
 * 3. **A Pi run in the same rig**, because the fix touches a floor Pi and claude
 *    share. A codex-only sitting cannot see the regression it is most likely to
 *    have caused.
 *
 * ## Never a real credential
 *
 * The denied entry under test is a scratch file the sitting seeds inside a FAKE
 * HOME, holding a per-run marker. Nothing real is read, and the interesting
 * outcome — content coming back — can therefore be recorded rather than
 * suppressed.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-26'
const TITLE = 'the two live codex arms — the bypassPermissions answer on a real approval request, and the deniedPaths refusal from the shipped binary'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.552',
  runtimes: ['codex', 'pi'],
  credentials: 'owner: a codex-runtime card and a Pi card (the Pi arm is the regression control, not decoration). No key is read; the denied file is a scratch marker inside a fake HOME.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. Build the fake home: a scratch directory with the denied entry the floor names, containing ONE line `DENIED-<8 hex>`, plus an ordinary workspace file containing `PLAIN-<8 hex>`. Launch the PACKAGED build with HOME pointed at it.',
    '2. REMOVE THE OS PROFILE for the codex arm. With codex\'s own `permissions.filesystem` deny in place, a refusal measures the OS and not our gate — and this is the step that decides whether the run answers the row at all. Record how it was removed.',
    '3. ARM 2, codex: new session on the codex card, ordinary permission mode. Ask the model to read the denied entry, positively phrased ("Read <path> and tell me its first line").',
    '4. Record TWO things, and the second is the verdict: (a) was the read refused; (b) was an approval CARD offered at any point. A refusal WITH a card is the pre-P6.62 behaviour and reads as a pass to anyone scoring (a) alone.',
    '5. POSITIVE CONTROL, same session, same run: ask for the ordinary workspace file. It must be read and `PLAIN-<hex>` must come back. Without it, a refusal is indistinguishable from a session whose read tool does not work.',
    '6. REGRESSION CONTROL: repeat 3–5 on a Pi card in the same rig. The shared floor must behave exactly as it did before — refused, no card, control file readable. The fix landed on a floor all three runtimes reach, so this is the arm most likely to carry the damage.',
    '7. ARM 1, codex: new session, set the permission mode to `bypassPermissions` through the app\'s own command (`sessionCommand(id, { type: "setPermissionMode", mode: "bypassPermissions" })`, a state write rather than a menu click). Then ask for work that WOULD raise an approval in the ordinary mode — establish that first, in an ordinary-mode session, so "no card appeared" has a subject.',
    '8. Record whether an approval request was raised at all, and whether any card appeared. Note which of the two products it is: requests suppressed at the source, or requests raised and auto-answered. Quote the evidence.',
    '9. Write PASS/FAIL per arm on the packaged build, with a narrative under `docs/testing/cdp-runs/`. On FAIL, the code rows reopen — say which.',
  ],
  expected: 'Arm 2: the denied read is refused with NO card, the ordinary file reads normally, and Pi behaves identically. Arm 1: a recorded answer to whether bypassPermissions suppresses the request or auto-answers it, with the ordinary-mode session as the proof that a request was there to suppress.',
  detector: 'whether an approval card was offered — the presence or absence of the request, not the refusal. Read from the backend\'s own `snapshot.security.pendingPermissions` as well as the card, because a card the renderer left up and a genuinely pending request look identical on screen and only one of them is a finding.',
  positiveControl: 'an ordinary workspace file read in the same run (the read tool works), a Pi run in the same rig (the shared floor did not move), and for arm 1 an ordinary-mode session where the same work DOES raise a request.',
  doneMeans: 'the two CDP cases added to `docs/testing/cdp-live-checklist.md` with PASS/FAIL on the packaged 1.34.x build, narratives in `docs/testing/cdp-runs/`; on FAIL the code rows reopen.',
  neverDo: 'Do not run arm 2 with codex\'s OS profile in place — it refuses for the wrong reason and the run would bank a pass for an untested host gate. And do not score the refusal alone: before P6.62 the read was refused too, by a human declining a card that should never have been offered.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
