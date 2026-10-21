/**
 * RS-119 (F1.735) — the withheld-capabilities recipe: what the "28 did not load"
 * on a fresh profile ARE, and whether the operator's skills root reaches a
 * Nessy profile.
 *
 * ## The row
 *
 * F1.735 was born from the 1.41.0 release sitting (lane SIT-d, packaged
 * `5896a66d2`, 2026-09-25): a fresh claude-gateway session opened with
 * "Not everything loaded in this chat — 81 active · 28 did not load", and the
 * hypothesis of the day blamed the operator's `~/.claude` skills. The owner's
 * 2026-09-26 decision corrected the premise before any drive: the skills on a
 * fresh profile come from `~/.agents/skills` (the host's global layer,
 * `GLOBAL_AGENT_SKILLS_DIR` in `skills/storage.ts`, trusted by codex and Pi
 * natively and supplied to claude by the host), never from `~/.claude` — and
 * ruled keep-measure: no product code changes, the 28 get measured.
 *
 * This file records the 7-step recipe as a sitting sheet (no `drive`: the
 * reading is three model turns plus three API reads, and `run.ts`'s `SITTING`
 * needs a checklist row this lane must not write).
 *
 * ## The measured answer (RC4, 2026-10-11, lane L5F2, port 9342)
 *
 * The recipe was driven once on the packaged 1.42.0 RC4 (`b72bb163d`), all
 * three gateway cards, `bypassPermissions` read back on every arm
 * (`work/sitting7/L5F2/f1735-reading.json`):
 *
 * - **All 28 are builtin MCP servers** — `builtin:mcp:<name>` rows, 27 of them
 *   the `dp*` family plus `codeSearch`, `SpiritK8s`, `t-tracker` and `time`,
 *   every one `reason: 'disabled'` with the catalog split
 *   `unavailableReason: 'source-disabled'`, `trustState: 'not-required'`.
 *   Group verdict: EXPECTED — sources the profile has simply not enabled, not
 *   a defect. RS-97's prior reading (27 such rows on packaged 1.40.0,
 *   `rs-97.ts`) is the same group one server larger.
 * - **Positive controls held on all three runtimes**: the inventory answers 28
 *   where the card prints "28 did not load", and catalog 109 − 28 withheld
 *   present = 81 where it prints "81 active" — the same numbers on claude, pi
 *   and codex, the inventory byte-identical across the three (the shared
 *   `toAgentRuntime` produces no runtime-specific rows here).
 * - **The premise controls held**: the catalog's home tier
 *   (`skill::global::-::-::home::`) carries exactly 73 rows = the 73 entries in
 *   `~/.agents/skills` on this machine, and covers every `/gsd-*` palette entry
 *   the composer offers (40 distinct names, none uncovered); `innersource`,
 *   which exists on this machine only under `~/.claude/skills/`, is ABSENT from
 *   the catalog — the `~/.claude` root does not reach the product.
 *
 * What the recipe below adds over that reading is repeatability on the next
 * build: same seven steps, same controls, a changed count or a covered
 * `innersource` is a new finding, not a stale sentence.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-119'
const TITLE =
  'what the withheld-capability card counts: the 28 "did not load" rows, the 81 active arithmetic, and the skills-root premise controls'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'F1.735',
  runtimes: ['claude', 'pi', 'codex'],
  credentials:
    'owner: the three one-click gateway cards (pi, Claude Code, codex) on a fresh NESSY_CONFIG_DIR. '
    + 'No key, token or credential file is read; `~/.claude` and `~/.agents/skills` are only ever listed, never read.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. Launch the PACKAGED build by scripts/cdp/README.md\'s env -u launcher, a fresh NESSY_CONFIG_DIR, dark theme, one content panel. Complete the one-click dp sign-in so all three gateway cards exist, and record the card slugs.',
    '2. On a claude-gateway session (freshSession, bypassPermissions READ BACK), run one real turn — the inventory record is empty before the first resolution. Take k from lib/state.ts\'s activeSession(s).',
    '3. THE INVENTORY: `w = await s.call(\'return await window.electronAPI.getSessionCapabilityInventory(\' + JSON.stringify(k.sessionId) + \')\')`. POSITIVE CONTROL: w.length must equal the "N did not load" number printed in `[data-testid="session-capability-summary"]` — read that text beside the call, never from memory.',
    '4. Group w by kind and reason; record every group\'s count with each member\'s logicalName and pluginKey. For every withheld key read its row in `c = (await window.electronAPI.capabilities.getCatalog({ workspaceId: k.workspaceId })).capabilities` for `unavailableReason` and `trustState` — this splits the bare reason \'disabled\' into source-disabled / managed-denied / session-not-selected / user-off.',
    '5. THE ACTIVE ARITHMETIC: c.length minus the number of withheld keys present in c must equal the "N active" number in the same summary element. A mismatch means the card and the catalog disagree about what loaded — that IS the finding, stop there.',
    '6. THE PREMISE CONTROLS, through the product: (a) `c.filter(x => x.kind === \'skill\' && x.key.startsWith(\'skill::global::-::-::home::\'))` is the ~/.agents/skills tier — compare its size with `ls ~/.agents/skills | wc -l` on the machine and type every `/gsd-` palette row (lib/composer.ts peekPalette) against it, coverage must be complete; (b) `c.some(x => x.logicalName === \'innersource\')` must be FALSE when `~/.claude/skills/innersource` exists on the machine — the ~/.claude-only control.',
    '7. Repeat steps 3–5 on a pi and a codex session in the SAME workspace: toAgentRuntime is shared, so only unsupported-runtime rows may differ; an inventory that differs by anything else is a runtime divergence worth its own row.',
    '8. Verdict per group: EXPECTED when the catalog split names an unselected source, a user-off source, a plugin awaiting trust review or an unsupported component; a DEFECT otherwise — and a defect becomes a new plan row, not a fix on this one.',
  ],
  expected:
    'Per runtime: w.length equals the card\'s "did not load" count; the catalog arithmetic reproduces the "active" count; every withheld row is a named capability with a catalog unavailableReason/trustState that explains it; the home skill tier covers the /gsd-* palette and no ~/.claude-resident name appears.',
  detector:
    '`window.electronAPI.getSessionCapabilityInventory(sessionId)` (the withheld rows the card renders), '
    + '`window.electronAPI.capabilities.getCatalog({ workspaceId })` (the full catalog for the split and the arithmetic), '
    + 'the text of `[data-testid="session-capability-summary"]` (the card\'s own two numbers), and lib/composer.ts '
    + 'peekPalette for the /gsd-* rows. The counts are read from the card and the APIs in the same minute — '
    + 'a catalog that changed between reads fails its own arithmetic.',
  positiveControl:
    'Three, all required: (1) the card\'s own "N did not load" text must equal the inventory length — an API '
    + 'answer without the DOM count is an unanswered read, not a zero; (2) the catalog arithmetic must reproduce '
    + '"N active" — without it "28 withheld" and "I read a stale catalog" are the same number; (3) the home tier '
    + 'size must equal the machine\'s own `ls ~/.agents/skills | wc -l`, and a machine where that directory is '
    + 'empty must answer 0 home rows — a control that proves the tier is READ, not merely unpopulated.',
  doneMeans:
    'The checklist row records what the withheld set IS (kind/reason groups with the catalog split) and the '
    + 'premise verdict (skills root = ~/.agents/skills, ~/.claude absent), each group marked expected or defect.',
  doNotConflate:
    '"Disabled" the reason and "source-disabled" the catalog split are not the same claim — one is the runtime '
    + 'view\'s bucket, the other names WHY (a source the profile has not enabled). And the palette listing a skill '
    + 'is not the catalog loading it: the tier coverage check compares the two lists, it does not assume either.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
