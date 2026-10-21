/**
 * RS-137 (UB14.25) — our own structured cards on v0.15.1's decision anatomy, live and DARK: the ask-user card
 * (Claude's AskUserQuestion and Pi's ask_user), the workflow-launch consent (Pi and Claude), and the
 * artifact-publish details inside the publish card.
 *
 * ## The row
 *
 * UB14.25 restyled the three structured cards upstream does not have onto the anatomy UB14.20 landed
 * (`DecisionCard`: the info tile and a label-lg title, the indented details, the answer that moves the user
 * forward as the accent primary, wider answers secondary, the refusal a ghost after the spacer, the quiet foot).
 * Restyle only: AskUserQuestion keeps its multi-question / multi-select / "Other" / general-reply behaviour and
 * the URL-consent panel, the workflow launch keeps Once / Always for this project / Deny and what each sends,
 * and the artifact-publish details keep every line. The redesign rows owe "an arm in that area's CDP screenshot
 * case in DARK theme". This id is lane-picked (next free: `rs-136.ts` is the last case file and no RS-137
 * appears in `scripts/`, `docs/testing` or `work/`; the same search finds RS-136, the control), NOT in `run.ts`'s
 * `SITTING` (the checklist is controller-owned — the rs-121 rule), and the controller confirms it at the pin.
 * The DRIVE is the END-sitting wave's; this file is the recipe. The offline arms are `AskUserRequest.test.tsx`'s
 * and `WorkflowLaunchRequest.test.tsx`'s UB14.25 describes, `decision-anatomy-material.test.ts`, and the
 * playground sweep's UB14.25 arm in `registry-render.test.ts` (dark: the `input-container` ask-user and
 * workflow states, the artifact-publish state, every `orchestration-ask-user` scenario).
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts';

const ID = 'RS-137'
const TITLE =
  'our structured cards on the decision anatomy (DARK): AskUserQuestion with two questions on Claude and ask_user on Pi (header pills, selectable rows, Submit primary, Cancel ghost; both answers reach the model), the workflow-launch consent on Pi and Claude (Once primary · Always secondary · Deny ghost; Deny launches nothing), and the artifact-publish details in the sunken wells'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UB14.25',
  runtimes: ['pi', 'claude'], // the row's Runtimes line: Claude (AskUserQuestion), Pi/Claude (workflows); codex raises neither card
  credentials:
    'none beyond the session\'s own model turn: the Nessy gateway card, or the mock card when every gateway model is rate-limited. Every workflow card is answered Deny (nothing launches); the publish card is answered Deny (nothing leaves the machine).',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '0. Land-check: the packaged build carries the UB14.25 commit or later. Launch by scripts/cdp/README.md\'s env -u launcher — fresh NESSY_CONFIG_DIR, DARK theme (owner rule), permission mode DEFAULT/Manual (the workflow and publish cards are the subject — never bypass, which skips the workflow consent), the window ≥ 1400 px wide.',
    '1. ASKUSERQUESTION, TWO QUESTIONS (Claude): in a Claude-runtime session ask "Use the AskUserQuestion tool once, with exactly two questions: \\"Which format?\\" (header Format; options Summary, Detailed; single select) and \\"Which sections?\\" (header Sections; options Introduction, Conclusion; multi select). Then tell me my answers." EXPECT the composer swapped for the card: `[data-tutorial="ask-user-banner"][data-decision-tone="info"]` inside the VISIBLE `.input-container` (not the `aria-hidden` measuring copy), the composer card\'s class list carrying ring-[color:var(--info-border)], the tile `span.bg-info-tint` 28×28, the title chat.askUser.title, two `rounded-full bg-info-tint` header pills, four `button[aria-pressed="false"]` rows, each question\'s Other field, the general-reply field under a separator, then Submit (data-variant="primary", disabled) · spacer · Cancel (data-variant="ghost", NO dashed or destructive border). Screenshot dark.',
    '2. PICK AND SUBMIT: click Summary, Introduction and Conclusion — EXPECT each row `aria-pressed="true"` with the info tint and a check glyph, and Submit enabled (background-color = the computed --accent-solid). Click Submit — EXPECT the card gone, the composer back, and the model\'s reply naming Summary AND both Introduction and Conclusion (both answers reached it).',
    '3. ASK_USER, ONE QUESTION (Pi): in a Pi session ask "Use your ask_user tool to ask me which of these to do: Ship it, Stop. Allow a free-text answer." EXPECT the same anatomy, the options as RAISED rows (data-variant="secondary") that are the direct children of the card\'s `.grid.gap-2` (what `lib/ask-user.ts` reads — `readAskUserCard(session).options` must list exactly the two), the free-text field with an icon Send (data-variant="primary", disabled until typed), and only Cancel (ghost) in the actions row. Click Cancel — EXPECT the card gone and the turn told the question was declined.',
    '4. WORKFLOW LAUNCH (Pi, then Claude): ask "Launch the workflow tool with name rs137-demo and phases [\\"Discover\\", \\"Report\\"]" (or a saved recipe) — EXPECT the consent card: the Workflow glyph tile, the title naming rs137-demo, the consent sentence with "Planned phases: Discover → Report" in the details, and the row Once (primary) · Always for this project (secondary, raised) · spacer · Deny (ghost). Click Deny — EXPECT no subagent spawned and no run recorded. Repeat on Claude (mcp__session__workflow). Then ask for a launch with no phases (name only) — EXPECT "declares no phases up front" and the same three answers, Deny still the ghost; Deny.',
    '5. ARTIFACT PUBLISH DETAILS (Pi): with a publish service configured, ask the agent to publish a small Markdown file with publish_artifact — EXPECT the permission card (UB14.24\'s anatomy) whose details carry `[data-testid="artifact-publish-details"]`: the warning access block, the facts in label-size secondary text, the preview in a `.bg-sunken` well (`[data-testid="artifact-publish-markdown"]`, or the HTML frame with its hairline ring), and the first source lines in the sunken mono well (`pre[data-testid="artifact-publish-source"].bg-sunken.font-mono`). Deny — EXPECT nothing published. Skip with the reason when no publish service is configured.',
    '6. NARROW: resize so the composer is < 32 rem wide and raise the step-1 card again — EXPECT the details lose their 38 px indent, Submit and Cancel grow to 40 px and share the row, the spacer hidden. Cancel.',
    '7. Verdict, for the checklist row the controller writes: PASS when each card wears the info anatomy inside the ringed composer, the primary answer is the accent primary (Submit, Send, Once), the wider answer the raised secondary (Always for this project, the single-question options), the refusal the ghost after the spacer (Cancel, Deny), both AskUserQuestion answers reach the model, Deny launches nothing and publishes nothing, and the narrow card stacks its actions.',
  ],
  expected:
    'In the packaged app, dark theme: AskUserQuestion (Claude) and ask_user (Pi) replace the composer with an info decision card — header pills, selectable answer rows, a solid-accent Submit and a ghost Cancel — and the submitted answers reach the model; the workflow-launch consent shows Once (accent), Always for this project (raised) and Deny (ghost) on Pi and Claude and Deny launches nothing; the publish card\'s details sit in sunken wells.',
  detector:
    'DOM reads inside the VISIBLE `.input-container`: `[data-tutorial="ask-user-banner"]` with `data-decision-tone`, the tile `span.bg-info-tint`, `button[data-variant]` order and `aria-pressed`, computed background-color against the computed --accent-solid / --surface-raised / --fill-hover on the same page, `lib/ask-user.ts` `readAskUserCard` for the option list; the model\'s reply text for the answers it received; the session\'s subagent list and the workflow run record after Deny; `[data-testid^="artifact-publish-"]` for the details; screenshots only as the dark record.',
  positiveControl:
    'Step 1\'s card MUST carry `data-decision-tone` and the composer class list MUST switch from the focus ring (freeform, before the ask) to the info ring — if neither changes, the read is of the hidden measuring copy. Step 2\'s Submit is the control for its own disabled state in step 1: the same button must flip from disabled to enabled after a pick.',
  runOnlyIf:
    'The packaged build carries the UB14.25 commit or later. Every step needs a model turn (the gateway, or the mock card on quota exhaustion); steps 1, 2 and the Claude half of step 4 a Claude-runtime connection; step 5 a configured artifact publish service.',
  doneMeans:
    'UB14.25\'s checklist row (the controller\'s) carries the verdict: each card\'s anatomy and computed material, both AskUserQuestion answers reaching the model, Deny launching and publishing nothing, the no-phases card keeping its refusal, and the narrow layout — each PASS/FAIL with its reading.',
  doNotConflate:
    'The ring and material of the composer card are UB14.27\'s; the permission card around the publish details is UB14.24\'s (RS-136); the admin and credential cards are UB14.23\'s (RS-135); whether a workflow launch is prompted at all (the mode, the per-project remember record) is pre-tool-use policy, not this row.',
  safety:
    'No credentials read, typed or printed. Every workflow and publish card is answered Deny, so no subagent is spawned and no bytes leave the machine; the questions are answered inside the session only; nothing is written outside the fresh NESSY_CONFIG_DIR workspace.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
