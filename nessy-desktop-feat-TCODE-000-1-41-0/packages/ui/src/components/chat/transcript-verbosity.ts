/**
 * P6.469 — ONE transcript verbosity, for all three runtimes.
 *
 * ## The gap, re-measured at HEAD
 *
 * `git grep -ail -i viewmode` over `packages/ui/src`, `packages/core/src` and
 * `apps/electron/src` resolved to exactly ONE file — `IslandFollowUpContentView.tsx`,
 * an unrelated annotation island — and `git grep -al verbose` over the whole
 * renderer resolved to **zero**. Positive control on the same rig: `collaps`
 * resolves in **74** renderer files, so the grep reads the code it was pointed at.
 * There was no Normal / Verbose / Summary anywhere, on any runtime.
 *
 * ## Why this is host-side and uniform BY CONSTRUCTION
 *
 * No runtime has a mechanism: not the claude SDK, not codex, not Pi. But the
 * transcript is host-rendered from one event stream, and the three backend
 * adapters already normalise a file change onto the SAME canonical tool name —
 * codex's `item.changes` becomes `'Edit'`
 * (`agent/backend/codex/event-adapter.ts`), Pi's edit tool becomes `'Edit'`
 * (`agent/backend/pi/event-adapter.ts`), and claude's native names are those
 * spellings already. So one filter over `ActivityItem` is the same filter on all
 * three, and there is nothing per-runtime to keep in step.
 *
 * ## The three modes are READ, not invented
 *
 * `desktop.md#switch-view-modes` (fetched 2026-09-07), verbatim:
 *
 * - **Normal** — *"Tool calls collapsed into summaries, with full text responses"*
 * - **Verbose** — *"Every tool call, file read, and intermediate step Claude takes"*
 * - **Summary** — *"Only Claude's final responses and the changes it made"*
 *
 * and the same section: *"press **Ctrl+O** on macOS or Windows to cycle through
 * them"*, which `hooks.md` restates as *"enable verbose mode with `Ctrl+O`"*.
 * So Normal is exactly what this product already did — nothing about the default
 * transcript changes — and the row is two new modes plus the cycle, not a
 * rewrite of the renderer.
 *
 * `hooks.md` also fixes one detail that would otherwise have been a guess:
 * *"The transcript and what Claude sees keep the original text, so Claude never
 * sees the replacement, and verbose mode shows the original."* Hence
 * {@link TranscriptVerbosityPresentation.showOriginalContent} — in Verbose a
 * `MessageDisplay` hook's on-screen replacement is set aside and the model's own
 * words are painted.
 *
 * ## Why a module and not an inline ternary in `TurnCard`
 *
 * The same containment `run-summary.ts` and `intermediate-row.ts` already use:
 * **`TurnCard.tsx` cannot be loaded by the bun runner at all** (it reaches
 * `pdfjs-dist` through `Markdown` → `MarkdownPdfBlock`). A decision left inside
 * the component can only ever be asserted by reading its source as text, which
 * cannot tell a painted row from a dropped one. The decision therefore lives
 * here, over a minimal structural input, and the component keeps only the JSX.
 */

export const TRANSCRIPT_VERBOSITY_MODES = ['normal', 'verbose', 'summary'] as const

export type TranscriptVerbosity = (typeof TRANSCRIPT_VERBOSITY_MODES)[number]

/**
 * Normal is the default because Normal is what this product already rendered.
 * A row that ships a new default would be a redesign wearing a feature's name.
 */
export const DEFAULT_TRANSCRIPT_VERBOSITY: TranscriptVerbosity = 'normal'

export function isTranscriptVerbosity(value: unknown): value is TranscriptVerbosity {
  return typeof value === 'string'
    && (TRANSCRIPT_VERBOSITY_MODES as readonly string[]).includes(value)
}

/**
 * The cycle the one key performs, in the page's own table order
 * (Normal → Verbose → Summary → Normal). An unrecognised value — a persisted
 * string from an older build, a hand-edited storage entry — cycles to the
 * default rather than throwing.
 */
export function cycleTranscriptVerbosity(current: TranscriptVerbosity | string): TranscriptVerbosity {
  const index = (TRANSCRIPT_VERBOSITY_MODES as readonly string[]).indexOf(current)
  if (index === -1) return DEFAULT_TRANSCRIPT_VERBOSITY
  return TRANSCRIPT_VERBOSITY_MODES[(index + 1) % TRANSCRIPT_VERBOSITY_MODES.length]!
}

/**
 * The canonical tool names that ARE *"the changes it made"*.
 *
 * Deliberately a second copy of the set that exists twice in
 * `packages/shared` (`agent/core/pre-tool-use.ts`'s `FILE_WRITE_TOOLS` and
 * `agent/claude-agent.ts`'s `CLAUDE_FILE_WRITE_TOOLS`), and the duplication is
 * the smaller evil: both of those modules reach `node:os`/`node:path` through
 * the permission DSL, and importing either into `packages/ui` would pull node
 * into the renderer bundle. Named here so the next reader knows there are three
 * copies and where the other two are.
 */
export const TRANSCRIPT_CHANGE_TOOL_NAMES: readonly string[] = [
  'Edit', 'MultiEdit', 'Write', 'NotebookEdit',
]

/** The minimum a row needs to be filtered. `ActivityItem` is assignable to it. */
export interface TranscriptActivity {
  type: string
  toolName?: string
  /** R32 · a `MessageDisplay` hook's on-screen replacement for `content`. */
  displayContent?: string
}

export interface TranscriptVerbosityPresentation<T extends TranscriptActivity> {
  /** The rows the activity section paints. */
  activities: T[]
  /**
   * How many rows this mode is holding back. NEVER hidden from the user: the
   * section header keeps counting them, so Summary reads as "there was more"
   * rather than as "nothing happened". A mode that silently shrinks the record
   * is the silent-divergence defect with a nicer name.
   */
  hiddenCount: number
  /**
   * Verbose opens the section it would otherwise be pointless to be in. Normal
   * and Summary leave the existing per-turn expansion state alone, which is why
   * this is `boolean | undefined` and not `boolean`.
   */
  expandByDefault: boolean | undefined
  /**
   * Verbose paints the model's own words, not a `MessageDisplay` replacement,
   * and {@link resolveTranscriptVerbosity} has ALREADY applied it by dropping
   * `displayContent` from the rows it returns.
   *
   * Applying it to the DATA rather than threading a flag through the render
   * tree is the whole reason this costs nothing: `TurnCard` paints rows through
   * three different paths (flat, Task-grouped, and the host's own
   * `renderActivity` override), and a flag would have had to reach all three or
   * the mode would be true in one view and false in the next.
   */
  showOriginalContent: boolean
}

/**
 * Apply a verbosity mode to one turn's already-sorted, plan-free activity list.
 *
 * Pure, and the input is structural on purpose — see the module docblock.
 */
export function resolveTranscriptVerbosity<T extends TranscriptActivity>(
  mode: TranscriptVerbosity,
  activities: readonly T[],
): TranscriptVerbosityPresentation<T> {
  if (mode === 'summary') {
    // "Only … the changes it made": a tool row survives when it changed a file.
    // Everything else — reads, searches, commentary, reasoning — is held back,
    // and the response text is rendered by the caller either way.
    const kept = activities.filter(a =>
      a.type === 'tool' && TRANSCRIPT_CHANGE_TOOL_NAMES.includes(a.toolName ?? ''))
    return {
      activities: kept,
      hiddenCount: activities.length - kept.length,
      expandByDefault: undefined,
      showOriginalContent: false,
    }
  }

  if (mode === 'verbose') {
    return {
      // `content` is untouched — only the hook's on-screen replacement is set
      // aside, which is exactly what the page promises and no more.
      activities: activities.map(a =>
        a.displayContent === undefined ? a : ({ ...a, displayContent: undefined } as T)),
      hiddenCount: 0,
      expandByDefault: true,
      showOriginalContent: true,
    }
  }

  return {
    activities: [...activities],
    hiddenCount: 0,
    expandByDefault: undefined,
    showOriginalContent: false,
  }
}
