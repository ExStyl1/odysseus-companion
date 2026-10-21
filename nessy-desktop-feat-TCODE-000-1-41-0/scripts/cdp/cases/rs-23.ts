/**
 * RS-23 (P6.408) — what actually LOADED: the session's own skill and command
 * roster, and whether a bare project `.claude/commands` file dispatches at all.
 *
 * Two denominator cells. L66 is the roster; L67 is the bare project command.
 *
 * ## The risk the row names, in its own words
 *
 * For L67, verbatim: *"claude-runtime: the SDK loads `.claude/commands/` itself
 * from the sources we already pass — `buildClaudeTurnShapeOptions` sets
 * `settingSources: ['user','project','local']` … so on that runtime it may
 * already work through a path the host does not know about, which is itself the
 * risk."* A command the host never registered, dispatching anyway, is not a
 * feature we shipped; it is a surface we do not control. The owner sitting
 * measured the SKILL analogue of that path finding nothing. Commands were never
 * driven.
 *
 * ## The roster is readable on exactly one of the three, and that is the finding
 *
 * - **claude**: `SDKSystemMessage` carries `skills: string[]` and `agents?:
 *   string[]` beside `slash_commands: string[]`, and
 *   `backend/claude/event-adapter.ts` reads only the last. So the skills roster
 *   arrives and is dropped. The sitting reads what it can out of the SDK's own
 *   transcript (`<workspace>/claude-config/projects/…/*.jsonl`, which
 *   `scripts/cdp/lib/runtime-session-log.ts` walks in full) and, where the init
 *   entry does not carry it, records UNREADABLE-FROM-OUTSIDE with that reason.
 *   That is a verdict; a blank cell is not.
 * - **codex**: `skills/list` is the native equivalent and is UNCALLED. Nothing
 *   to read, because nothing asks. Record it as uncalled — the null is the
 *   finding.
 * - **pi**: the roster is ours, so the palette is the roster, and `peekPalette`
 *   reads it.
 *
 * A sitting that reported "could not read the roster" for all three would be
 * hiding three different facts under one sentence.
 *
 * ## The fixture, and why it must carry BOTH
 *
 * A project with `.claude/commands/<name>.md` AND a skill of the SAME name, each
 * carrying a DIFFERENT unique marker in its body. That is what makes the
 * shadowing clause answerable: whichever marker comes back names the winner, and
 * neither coming back is itself an answer ("this runtime dispatches neither").
 * A fixture with only the command can say whether it dispatched and can say
 * nothing at all about ordering.
 *
 * The markers are minted per sitting. A fixed marker would be findable by a
 * model with a shell, and the answer would prove nothing about loading.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-23'
const TITLE = 'the session’s own skill and command roster per runtime, and whether a bare project .claude/commands file dispatches'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.408',
  runtimes: ['pi', 'claude', 'codex'],
  credentials: 'owner: one card per runtime. No key is read; the fixture is markdown.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. Build the fixture project in a scratch directory — never the operator\'s own tree. Two files, two markers minted for this sitting:',
    '   a. `.claude/commands/rs23-probe.md` — a command whose body instructs the model to reply with the single token COMMAND-<8 hex>;',
    '   b. a skill named `rs23-probe` (`skills/rs23-probe/SKILL.md` under the config dir, or the project skill location for the runtime) whose body instructs the model to reply with the single token SKILL-<8 hex>.',
    '   The two markers must differ, and neither may appear anywhere else on the machine.',
    '2. PACKAGED build, dark theme, one content panel. New session on the card under test, working directory = the fixture project. Answer the project trust gate if it appears and say in the notes that it appeared.',
    '3. ROSTER — pi: open the slash palette and record every entry it offers (`peekPalette`), plus the sources surface\'s skill list. That is the roster on this runtime.',
    '4. ROSTER — claude: run one ordinary turn so the SDK opens its transcript, then read every `.jsonl` under `<config>/workspaces/<workspaceId>/claude-config/projects/…` (all of them — one Nessy session is many SDK transcripts) and record whether the init/system entry carries `skills` and `slash_commands`, and what is in them. If the entry does not carry the roster, record UNREADABLE-FROM-OUTSIDE with that exact reason and note the known residue: the adapter reads only `slash_commands`.',
    '5. ROSTER — codex: record UNCALLED. `skills/list` is the native equivalent and nothing calls it. Do not substitute the palette for it — the palette is the host\'s list, not the runtime\'s, and reporting one as the other is the conflation this cell exists to avoid.',
    '6. DISPATCH — per runtime: type `/rs23-probe` into the composer one character at a time and record whether the palette offers it AT ALL. Then select it with the arrow keys and Enter (never `insertText`, never a click at a guessed coordinate) and let the turn run.',
    '7. Record which marker came back — COMMAND-<hex>, SKILL-<hex>, both, or neither. That single token is the whole shadowing answer.',
    '8. CONTROL: in a session whose working directory is NOT the fixture project, type the same token. The palette must not offer it and the marker must not come back. Without this, a command that was already installed globally would score as a project command that dispatched.',
    '9. SECOND CONTROL, claude only: with the fixture project open, rename `.claude/commands/rs23-probe.md` away and repeat step 6. The entry must disappear. This separates "the SDK loaded the project file" from "something else answers to that name".',
    '10. Repeat per runtime. Three roster cells, three dispatch cells, one shadowing statement each.',
  ],
  expected: 'per runtime: the roster recorded or its unreadability named with the reason; whether `/rs23-probe` is offered; which marker returns. The out-of-project control offers nothing and returns nothing.',
  detector: 'the unique marker in the reply — the only thing that says WHICH file answered. Plus the palette\'s own entries for what was offered, and the SDK\'s own transcript for the claude roster. Never "a skill seems to be loaded".',
  positiveControl: 'a session outside the fixture project, where neither the palette entry nor the marker may appear; and on claude, removing the command file, after which the entry must disappear.',
  doneMeans: 'per runtime, the loaded skill and command rosters are recorded, and the command-vs-skill shadowing order is stated (or its absence is).',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
