/**
 * RS-125 (UB7.9) — the Phase 7 live cases: three drives this lane can land
 * offline but not run (a packaged sitting owns every drive).
 *
 * ## The row
 *
 * UB7.9 names three live cases; this file is their recipe sheet. The id is
 * lane-picked (next free after RS-124; the dispatch allocated none), NOT in
 * `run.ts`'s `SITTING` (the checklist is controller-owned — the rs-121 rule),
 * and the controller confirms it at the pin.
 *
 * ## Arm A — the rtk outdated notice with a fixture rtk 0.43 (UB7.4)
 *
 * Landed `b5980bb4e`: the detector's safe floor is 0.44.0 — a binary between
 * 0.23.0 and 0.44.0 reads `outdated` (reported, NEVER used for rewrites), and
 * the RtkUpdatePrompt opens once per outdated version while Token Optimization
 * is on, naming the minimum version and "update rtk the way you installed it"
 * — NO installer command (OQ-43.8 (b); the guard test reads the sources).
 *
 * ## Arm B — allowedWritePaths in Ask (UB7.6)
 *
 * Landed `06b8be021`: `shouldPromptInAskMode`'s file-write arm suppresses the
 * card for a write inside the workspace allowlist's globs (default mode ONLY —
 * plan refuses the same write whatever the list says; writes outside still
 * prompt). The unit drives are pinned (mode-manager-allowed-write-paths.test.ts,
 * 7 pass / 0 fail); the live arm drives the CARD path end to end.
 *
 * ## Arm C — the git context block on Pi (UB7.1)
 *
 * Landed `a10bfc89e`: the Pi prompt carries a stable repo-identity block (cached
 * prefix) and a volatile branch/upstream/counts block on the user tail, composed
 * by `developer-context.ts` (the composition pinned by
 * developer-context.test.ts, 4 pass / 0 fail). The live arm reads the block
 * from the runtime's own record.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-125'
const TITLE =
  'the Phase 7 drives: the rtk outdated notice with a fixture rtk 0.43, allowedWritePaths card-free in Ask and still prompting outside, and the git context block on a Pi session in a repo'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UB7.9',
  runtimes: ['pi', 'claude'],
  credentials:
    'owner: arm A needs a throwaway `rtk` shim earlier on PATH than any real rtk (a /bin/sh script printing "rtk 0.43.0" for --version; the rig never runs a real installer); arm B needs a scratch directory pair the operator may write in; arm C needs any git repository with one commit (the rig makes one). No key or token is ever read or printed.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '0. Land-checks per arm (scripts/cdp/README.md\'s stale-bundle rule — rebuild, relaunch, then measure): A requires UB7.4 (b5980bb4e or later), B requires UB7.6 (06b8be021 or later), C requires UB7.1 (a10bfc89e or later).',
    '1. Launch the PACKAGED build by scripts/cdp/README.md\'s env -u launcher — fresh NESSY_CONFIG_DIR, dark theme.',
    '2. ARM A (UB7.4, any runtime with Token Optimization): put the throwaway shim FIRST on the launcher\'s PATH so `which rtk` resolves to it and `rtk --version` prints `rtk 0.43.0`; in Settings > AI, switch Token Optimization ON and press Re-check. EXPECT: the update dialog opens, titles "Update rtk", its body names version 0.43.0 and the minimum 0.44.0, the instructions say to update rtk the way it was installed, the found-path line names the shim, and the dialog carries Later + Re-check and NO command line, NO Copy button and NO installer command anywhere. Press Later; relaunch; EXPECT: no dialog (the dismissed version is remembered); press Re-check in Settings after swapping the shim for a real 0.44+ rtk (or removing it) — the toggle returns to its usable state.',
    '3. ARM B (UB7.6, default mode — never bypass, never plan): hand-edit the workspace permissions.json to `{ "allowedWritePaths": ["<scratch-root>/**"] }` and restart (Settings > Permissions does not offer the list). In a DEFAULT-mode session ask the agent to create `<scratch-root>/ub7-6/probe.txt` with a line of text. EXPECT: NO permission card — the write runs. Then ask for `/tmp/ub7-6-outside/probe.txt` (outside the glob). EXPECT: the card. Then switch to PLAN mode and ask for the same inside-glob write. EXPECT: refused (plan never reads the list). POSITIVE CONTROL: the same inside write in default mode BEFORE the permissions.json exists — EXPECT: the card (proves the rig raises cards, so B\'s missing one is the product).',
    '4. ARM C (UB7.1, Pi session): set the session\'s working directory to a real git repository with one commit and a dirty tracked file; send one turn (any short prompt). THE DETECTOR: the runtime debug log records the composed user tail — EXPECT a `<developer_context kind="git_repository" scope="volatile">` block carrying `branch: <the repo\'s branch>`, `worktreeState: dirty`, the changed-file sample naming the tracked file, and NO block at all when the working directory is a plain folder (the control session).',
    '5. Verdict per arm, recorded in the checklist rows the controller writes: A passes when the dialog names 0.43.0/0.44.0 with no installer command and the dismissed version stays quiet after relaunch; B passes when the inside write ran card-free, the outside write carded and the plan write was refused with the no-list control carding; C passes when the volatile block names the live branch and dirty state in the runtime\'s own record.',
  ],
  expected:
    'Arm A: the outdated rtk (0.43.0) opens the update dialog naming the 0.44.0 minimum with no installer command anywhere, and the Later memory keeps it quiet after relaunch. Arm B: an allowedWritePaths write in the default mode runs card-free, an outside write cards, and plan refuses the same write. Arm C: a Pi session in a repository carries the volatile git context block (branch, worktreeState, counts, sample) in its composed tail, and a plain-folder session carries none.',
  detector:
    'Product-written records only: the RtkUpdateDialog itself and the Settings Re-check state (arm A — never a screenshot of model prose), the permission card\'s presence/absence and the write\'s file existing (arm B), and the runtime debug log\'s composed-tail record (arm C — the block names the live branch, which a fixture cannot know). No model prose is evidence.',
  positiveControl:
    'Per arm: A — the dialog\'s Re-check with a REAL 0.44+ rtk returns the toggle to usable (proves the rig can see rtk state change); B — the same inside write BEFORE the permissions.json exists cards (proves the rig raises cards, so B\'s missing card is the product); C — the plain-folder control session carries no developer_context block (proves the reader sees its absence, so C\'s present block is the product).',
  runOnlyIf:
    'Arm A: UB7.4 in the build (b5980bb4e+) and a writable PATH position the launcher respects. Arm B: UB7.6 in the build (06b8be021+). Arm C: UB7.1 in the build (a10bfc89e+) and a runtime whose debug log records the composed tail (else the arm records the unit pin — developer-context.test.ts, 4 pass / 0 fail at a10bfc89e — as its verdict).',
  doneMeans:
    'UB7.9\'s checklist row (the controller\'s) carries verdicts: the outdated notice shown with the minimum named and no installer command; the allowlist write card-free with the outside and plan controls holding; the volatile git block read from the runtime record with the plain-folder control clean.',
  doNotConflate:
    'Arm A\'s "the notice names the minimum" is the 0.44.0 string in the DIALOG, not in a log line. Arm B\'s card-free write is the FILE EXISTING with no card in between — a card the operator accepted is the control\'s outcome, not the row\'s. Arm C\'s block must name the LIVE branch of the drive repository — a block naming a different branch is a stale cache, which is a finding, not a pass.',
  safety:
    'Arm A\'s shim is a throwaway script in a temp dir, never an installer run. Arm B\'s writes land in operator-owned scratch directories only. Arm C reads the rig\'s own repository. No key or token is ever read or printed.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
