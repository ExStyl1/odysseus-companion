/**
 * What a settled turn DID, in one phrase — "Ran 2 shell commands, read 3 files".
 *
 * The collapsed turn header used to end at `turnCard.stepsCompleted` →
 * "Steps Completed", which tells the reader nothing the step badge beside it
 * does not already say. This module replaces that one branch of
 * `getPreviewText` (`TurnCard.tsx`; since UB14.11 `getWorkLogPreview` in
 * `turn/work-log-summary.ts`); every earlier branch — an explicit intent,
 * an activity intent, running tool names, a Task description — is more specific
 * and still wins.
 *
 * ---------------------------------------------------------------------------
 * SOURCE AND LICENSE
 *
 * `RunCategory`, `RUN_CATEGORIES`, `RUN_CATEGORY_ORDER`, `runPhrase`,
 * `categorizeCall` and `formatToolRunLabel` are adapted from **omnigent**
 * (`github.com/omnigent-ai/omnigent`, Apache-2.0), file
 * `web/src/lib/toolTitle.ts` lines 237-349 at commit `b08eb50`. Adaptations:
 *
 * - **`FORMATTERS` is deliberately NOT taken.** Nessy already names an
 *   individual row better than a formatter table can: `toolDisplayMeta` plus the
 *   model-authored `displayName`/`_intent` (see `getToolDisplayInfo` in
 *   `TurnCard.tsx`). Only the *aggregate* phrase was missing.
 * - **`stripOmnigentPrefix` is deliberately NOT taken.** It peels omnigent's own
 *   `mcp__omnigent__` prefix before the category lookup. We must not do the
 *   equivalent: an MCP row is spelled `mcp__sources__<wire>__<tool>` under Codex
 *   and `mcp__<wire>__<tool>` under Pi/Claude, a deliberate and documented
 *   divergence (`mcp-tool-name.ts`), and guessing a category from the tool half
 *   of a third-party server's name is exactly the wrong inference. MCP rows are
 *   never categorised — see `categorizeCall`.
 * - The phrases are translated rather than built by appending `"s"`, and the
 *   join is **bounded** (`TURN_PREVIEW_MAX_PHRASES`) because our header clips
 *   with CSS `truncate`: the bound keeps the header's text whole on the widest
 *   column (`TURN_PREVIEW_BUDGET_CHARS`). Until UB14.11 the error count was the
 *   tail that would have been clipped; since then it is a chip outside the clip.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TABLE IS SHORT
 *
 * omnigent's `RUN_CATEGORIES` needs 25 rows because it must recognise four
 * vendor spellings per operation. Ours needs 11, because all three of our
 * runtimes have already converged on Claude's vocabulary before a row reaches
 * the renderer — verified in the tree, not assumed:
 *
 * - Pi: `PI_TOOL_BINDINGS` binds `read→Read`, `bash→Bash`, `edit→Edit`
 *   (`pi-harness/harness-tool-descriptor.ts:286-289`), and the Pi event adapter
 *   emits `tool.binding.permissionName` as the row's `toolName`
 *   (`backend/pi/event-adapter.ts:1149`).
 * - Codex: `commandExecution→Bash` and `fileChange→Edit`
 *   (`backend/codex/event-adapter.ts:286,289`).
 * - Claude: the SDK's own names, which are the vocabulary the other two adopted.
 *
 * Corroborated against the 674 stored `session.jsonl` transcripts on the
 * author's machine: `Bash` 181, `Read` 77, `Write` 65, `Ls` 40, `WebSearch` 18,
 * `WebFetch` 8, `Find` 8, `Edit` 4 — and **zero** lowercase `read`/`bash`/
 * `edit`/`write`/`grep`/`find`/`ls` rows, so no legacy-spelling rows are needed.
 * (The scan is its own positive control: it found the uppercase names in
 * quantity with the same matcher that reported the lowercase ones absent.)
 *
 * Four rows are runtime-specific: `Glob` and `MultiEdit` are Claude-only names,
 * `Find` and `Ls` are Pi-only. `Glob` and `Find` are the same operation under
 * two names; `Ls` has no Claude or Codex counterpart at all
 * (`core/pre-tool-use.ts:148` records the same split for the path-checking gate).
 */
import i18n from 'i18next'

/** The five things a turn can be summarised as doing. omnigent's set, verbatim. */
export type RunCategory = 'shell' | 'list' | 'read' | 'edit' | 'search'

/** One tool call in a settled turn: its name plus (optional) recorded input. */
export interface ToolRunCall {
  name: string
  args?: Record<string, unknown>
}

/**
 * The minimum an activity must carry to be summarised. `ActivityItem`
 * (`TurnCard.tsx`) is structurally assignable to this; declaring it here rather
 * than importing keeps the dependency one-way, so this module stays loadable
 * under `bun test` (`TurnCard.tsx` is not — it reaches `pdfjs-dist` through
 * `Markdown`, see `inline-execution-tool-name.test.ts`).
 */
export interface RunSummaryActivity {
  toolName?: string
  toolInput?: Record<string, unknown>
}

/**
 * Tool name → category. `WebFetch` is **deliberately absent**: none of the five
 * categories is true of fetching a URL, and "ran 3 searches" for three fetches
 * is a worse answer than folding them into "called 3 other tools".
 */
export const RUN_CATEGORIES: Readonly<Record<string, RunCategory>> = Object.freeze({
  // Claude `Bash`; Pi `bash` and `bash_background`; Codex `commandExecution`.
  Bash: 'shell',
  // Pi-only. Claude and Codex have no listing tool; Codex lists with `ls` inside
  // a shell call, which `categorizeCall` re-categorises.
  Ls: 'list',
  // Claude `Read`; Pi `read`. Codex has NO read tool — see `categorizeCall`.
  Read: 'read',
  Edit: 'edit', // Claude `Edit`; Pi `edit`; Codex `fileChange`
  Write: 'edit', // Claude `Write`; Pi `write`
  MultiEdit: 'edit', // Claude-only
  NotebookEdit: 'edit', // Claude `NotebookEdit`; Pi `notebook_edit`
  Grep: 'search', // Claude `Grep`; Pi `grep`
  Glob: 'search', // Claude-only — the same operation as Pi's `Find`
  Find: 'search', // Pi-only — the same operation as Claude's `Glob`
  WebSearch: 'search', // Claude `WebSearch`; Pi `web_search`
})

/** Phrase order in the joined label. omnigent's order, kept for determinism. */
export const RUN_CATEGORY_ORDER: readonly RunCategory[] = Object.freeze([
  'shell',
  'list',
  'read',
  'edit',
  'search',
])

/**
 * How many phrases the label may hold, counting the trailing "other" phrase.
 *
 * The header renders the label in a `truncate` span, which is
 * `white-space: nowrap; text-overflow: ellipsis` — it clips at the END. Until
 * UB14.11 the END was where the error count was concatenated, so an unbounded
 * join dropped it silently; since v0.15.1's work log the count is a separate
 * "N failed" chip beside the span (`turn/WorkLog.tsx` `WorkLogHeader`), and the
 * bound keeps the label itself whole, after the lead "N steps · " (the two
 * together within `TURN_PREVIEW_BUDGET_CHARS`).
 *
 * Three matches the cap the sibling branch already uses for running tool names
 * (`getWorkLogPreview`, `.slice(0, 3) // Max 3 names`). Nothing is lost by the
 * bound: when more categories are present than fit, the surplus folds into the
 * "other" phrase, so every call in the turn is still accounted for.
 */
export const TURN_PREVIEW_MAX_PHRASES = 3

/**
 * The longest header text the work log can show without clipping, in characters:
 * the WHOLE text of `WorkLogHeader`'s `truncate` span (`turn/WorkLog.tsx`), which
 * since UB14.11 holds the lead "N steps", the " · " separator and this module's
 * label. The lead is at the start, so it is counted too.
 *
 * **Derivation (UB12.42, 2026-10-17), from v0.15.1's classes in this repo.** The
 * transcript column is `CHAT_LAYOUT.maxWidth` (`max-w-[768px]`) less
 * `containerPaddingX` (`px-6`) on both sides (`lib/layout.ts`) = 720px. In the
 * header row, `gap-1` 4 + the ⋯ slot 24 (`TurnIconButton`'s `size-control-sm`;
 * `HOVER_REVEAL` hides it with opacity only, so it keeps its width) leave 692 for
 * the toggle button, which `-ml-1.5` widens to 698; its `pl-1.5` 6 + `pr-2` 8
 * leave 684, and the chevron `size-3.5` 14 + `gap-2` 8 leave **662px** for the
 * span, at `text-label` (13px; the lead is `font-medium`).
 *
 * The advance is MEASURED, where the pre-redesign derivation assumed 7.3px:
 * CoreText (`NSString.size(withAttributes:)` with `NSFont.systemFont(ofSize: 13)`,
 * medium for the lead and regular for the rest; the font Chromium's `system-ui`
 * resolves to on macOS), over every category combination at 9, 99 and 999 calls
 * each plus the over-cap controls below: Russian 6.89–7.02px per character,
 * English 5.86–6.19. Sized by the wider locale, ⌊662 / 7.02⌋ = **94**. (Control
 * on the same instrument: `iiiiiiiiii` reads 31.4px and `MMMMMMMMMM` 112.9px.)
 *
 * Worst case at 999 calls per category (5 000 to 6 000 calls in one turn, so
 * the lead has four digits): en 84 characters (520px), ru **94** (660px of 662). The
 * Russian margin is zero, so a longer Russian phrase is a real regression and the
 * test will say so; at 99 calls per category it is four characters (ru 90). One
 * phrase over `TURN_PREVIEW_MAX_PHRASES` would need en 100 / ru 115: the cap is
 * what keeps the worst case inside (`run-summary.test.ts` §4 holds both arms).
 *
 * Until UB12.42 the value was 95, derived for the pre-redesign header (an 800px
 * column, a step badge, the label alone with the error count as its tail).
 *
 * Stated residues, not gated:
 * - **A "N failed" chip narrows the span**: `gap-2` 8 + `CHIP_DESTRUCTIVE`'s
 *   `px-1.5` 12 + its 12px text (en "999 failed" 57px, ru "999 ошибок" 72px).
 *   English still fits. The widest Russian three-phrase label loses the end of
 *   its last phrase to the ellipsis: about 9px beside "9 ошибок" at 9 calls per
 *   category, about 90px beside "999 ошибок" at 999. Accepted, because the lead
 *   is at the start and the failed count is the chip, so the clip can only take
 *   the tail of the last phrase (the "other" phrase in the widest combination).
 * - Narrower columns (a split panel, or the compact shell with its 36px ⋯
 *   target) clip earlier, by design. Windows' `Segoe UI Variable Text` and the
 *   opt-in Inter font (`html[data-font="inter"]`) were not measured.
 */
export const TURN_PREVIEW_BUDGET_CHARS = 94

/**
 * Login-shell wrapper a runtime may put around a command, e.g.
 * `/bin/zsh -lc 'cat notes.txt'`. Present in real traffic: 30 of the 177 stored
 * `Bash` commands in the local corpus carry it.
 */
const SHELL_WRAPPER_RE = /^(?:\S+\/)?(?:bash|zsh|sh|dash|fish)\s+-l?c\s+([\s\S]+)$/

/** Peel a login-shell wrapper (and its quotes) off a command string. */
function unwrapShellCommand(command: string): string {
  const match = SHELL_WRAPPER_RE.exec(command.trim())
  if (match === null) return command.trim()
  const inner = match[1]!.trim()
  const quote = inner[0]
  if ((quote === "'" || quote === '"') && inner.length >= 2 && inner.endsWith(quote)) {
    return inner.slice(1, -1).trim()
  }
  return inner
}

/**
 * The category one call belongs to, or `'other'`.
 *
 * **The shell re-categorisation carries more weight here than it does upstream.**
 * Codex has no read tool and no listing tool: its file reads arrive as `Bash`
 * with `cat …` and its listings as `Bash` with `ls …`. Without this rule a Codex
 * turn reads "Ran 5 shell commands" where the identical Claude turn reads "Read
 * 4 files, listed 1 directory". A compound command (`cd x && ls`) stays a shell
 * command, which is correct — it is not only a listing.
 */
export function categorizeCall(call: ToolRunCall): RunCategory | 'other' {
  // MCP rows are never categorised. See the module header: the two spellings
  // diverge by runtime on purpose, and a third-party server's tool half is not
  // ours to interpret.
  if (call.name.startsWith('mcp__')) return 'other'

  const category = RUN_CATEGORIES[call.name] ?? 'other'
  if (category === 'shell') {
    const raw = typeof call.args?.command === 'string' ? call.args.command : ''
    const command = unwrapShellCommand(raw)
    if (command === 'ls' || command.startsWith('ls ')) return 'list'
    if (command === 'cat' || command.startsWith('cat ')) return 'read'
  }
  return category
}

/** i18n key for a category's phrase. Resolved per call — never at module level. */
const CATEGORY_KEYS: Readonly<Record<RunCategory, string>> = Object.freeze({
  shell: 'turnCard.runShell',
  list: 'turnCard.runList',
  read: 'turnCard.runRead',
  edit: 'turnCard.runEdit',
  search: 'turnCard.runSearch',
})

/** The translated, lower-case phrase for `n` calls in `category`. */
export function runPhrase(category: RunCategory, n: number): string {
  return i18n.t(CATEGORY_KEYS[category], { count: n })
}

/** Upper-case the first character of an assembled label. */
function sentenceCase(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1)
}

/**
 * The folded label for a settled turn's tool calls, mirroring the one-liners the
 * native CLIs print: "Read 2 files", "Ran 1 shell command, read 2 files". A run
 * made entirely of unrecognised tools falls back to "Called N tools".
 */
export function formatToolRunLabel(calls: ToolRunCall[]): string {
  const counts = new Map<RunCategory | 'other', number>()
  for (const call of calls) {
    const category = categorizeCall(call)
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }

  const known = RUN_CATEGORY_ORDER.filter(c => counts.has(c))
  let other = counts.get('other') ?? 0

  if (known.length === 0) {
    return sentenceCase(i18n.t('turnCard.runFallback', { count: calls.length }))
  }

  // Bound the join (see TURN_PREVIEW_MAX_PHRASES). Categories past the cap fold
  // into the "other" phrase rather than vanishing, so the label stays true.
  let kept = known
  if (known.length + (other > 0 ? 1 : 0) > TURN_PREVIEW_MAX_PHRASES) {
    kept = known.slice(0, TURN_PREVIEW_MAX_PHRASES - 1)
    for (const category of known.slice(TURN_PREVIEW_MAX_PHRASES - 1)) {
      other += counts.get(category)!
    }
  }

  const phrases = kept.map(c => runPhrase(c, counts.get(c)!))
  if (other > 0) phrases.push(i18n.t('turnCard.runOther', { count: other }))
  return sentenceCase(phrases.join(', '))
}

/**
 * The settled-turn preview label for a turn's activities.
 *
 * A turn whose activities carry no tool call at all — assistant commentary only —
 * has nothing to categorise, and "called 0 tools" would be a lie. It gets the
 * neutral step phrase instead, which is at least count-bearing where the old
 * `turnCard.stepsCompleted` was not.
 *
 * Nothing is appended to it: the failed count is the work log's chip (UB14.11,
 * `turn/work-log-summary.ts` `countFailedActivities`).
 */
export function summarizeTurnRun(activities: readonly RunSummaryActivity[]): string {
  const calls: ToolRunCall[] = activities
    .filter((a): a is RunSummaryActivity & { toolName: string } => !!a.toolName)
    .map(a => ({ name: a.toolName, args: a.toolInput }))

  if (calls.length === 0) {
    return sentenceCase(i18n.t('turnCard.runSteps', { count: activities.length }))
  }
  return formatToolRunLabel(calls)
}
