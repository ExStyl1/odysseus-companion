/**
 * UA1.24 — the shareable chat snapshot: the transcript AS IT IS, minus paths and
 * secrets (OQ-22 (e), owner 2026-09-23: «нужно отправлять как есть по
 * возможности, то есть не только текст сообщений но и тулы и прочее, но без
 * путей и секретов»). Nessy's own: upstream craft-agents v0.13.4 shares a chat by
 * POSTing the raw `StoredSession` JSON to its viewer (`SessionManager.ts`
 * `shareToViewer`), which is exactly the privacy hole UA1.25 removes; there is
 * no upstream snapshot to port.
 *
 * ## Reused, not forked (O13, waves.md 2026-10-02)
 *
 * Every message is rendered by the Markdown export's own
 * `formatTranscriptMessage` (`SessionManager.ts`, exported in place, line for
 * line — moving it would shift every doc anchor below it). It is INJECTED
 * ({@link ShareSnapshotOptions.formatMessage}) rather than imported: the caller
 * (UA1.25's `shareToViewer`) lives in that module, so an import here would be a
 * cycle. This module adds only what the export has no form for — the collapsed
 * blocks — and writes its own header, because the export's header carries the
 * session id, the workspace name and the absolute working directory, the three
 * lines a reader of a shared chat must not get.
 *
 * ## What is emitted
 *
 * - user and assistant messages, plans, errors, warnings, info and status rows,
 *   attachments BY NAME (the stored path never leaves);
 * - tool calls: name, status and intent (the formatter's detail lines), then the
 *   input and the DISPLAYED result (`toolResult`) each inside a collapsed
 *   `<details>` block, as the chat shows them; `rawToolResult` / `rawToolInput`
 *   are never read (the display pair is what the user saw);
 * - thinking (`isThinking`) inside a collapsed `<details><summary>Thinking`
 *   block (whether the service renders `<details>` is UA1.27's measurement);
 *   its body's details-tag spellings are HTML-escaped outside code (UA12.30);
 * - the header: title, project folder NAME, model, connection, permission mode
 *   (it explains why tools ran), status, created / last-message times and token
 *   usage. Dropped: session id, workspace name, the working directory path.
 *
 * ## Cleaning, per string, in this order (DECIDED here, transparent and simple)
 *
 * 1. **Secrets are MASKED, never refused** (a chat routinely carries them): the
 *    shared tool-result table (`scanToolResultForSecrets`, which since F1.365
 *    holds `jwt`, `ory-token` and `bearer`) plus the publish guard's `pan`
 *    (`findLuhnPans`) — UA1.17's composition minus its publish-only key-name
 *    rule (UA12.175), the same table plus pan (O6). Each value
 *    becomes `[REDACTED:<rule>]`; the counts go to the card. Secrets go FIRST
 *    so a path pass can never cut a token into an unrecognisable tail. One
 *    local mask-mode extension: the shared `private-key` rule matches a PEM
 *    header only, which is enough to REFUSE (UA1.17) and not to MASK, so a
 *    whole key block — header or stored marker, body, END line — is masked as
 *    one `private-key` first (`Cleaner.maskPrivateKeyBlocks`).
 * 2. **Paths:** an absolute path inside the working directory or an accepted
 *    root becomes relative to it (`src/app.ts`; the root itself becomes `.`);
 *    a path under a home directory, a `~/…` form, or any other absolute path of
 *    two or more segments becomes `…/<basename>`. A single-segment `/word` is
 *    left alone: it is far more often a slash command than a path, and it can
 *    name no user. `formatPathsToRelative` (`utils/files.ts`) is not reused: it
 *    leaves every path outside the cwd absolute.
 * 3. **Last resort, literal:** every remaining occurrence of a home directory
 *    becomes `…` (e.g. inside `file:///…`), and the OS account name, as a whole
 *    word in any case, becomes `[user]`.
 *
 * Every string field is cleaned before the formatter sees it; then the WHOLE
 * Markdown gets steps 1 and 3 again, so every emitted string — the formatter's
 * detail lines included — passed the mask (the second pass normally finds
 * nothing; its counts merge).
 *
 * ## Size
 *
 * The service takes at most {@link MAX_ARTIFACT_CONTENT_BYTES} (16 MiB). Each
 * tool payload (input JSON and result) is cut at {@link SHARE_TOOL_PAYLOAD_CAP_BYTES}
 * with a visible marker naming the dropped size. The cap: 64 KiB is about 1 600
 * lines of output — more than a reader opens a collapsed block for — and bounds
 * one call to 1/256 of the service cap, so tool output alone needs 256 maximal
 * calls to fill it. The cut runs AFTER masking, so a secret is never halved
 * into an unrecognisable prefix. Over the service cap the share is refused with
 * a sentence ({@link ShareSnapshotRefusal}).
 *
 * Residue, stated: a details-tag spelling in a NON-thinking message body is
 * still emitted raw — it sits outside our blocks, where a stray close tag is
 * ignored but a literal opener could swallow what follows (the THINKING body,
 * where the block is ours, is escaped instead, UA12.30); an account name shorter than
 * three characters is not masked as a word (paths under its home still are),
 * and a common-word account name (`user`, `admin`) masks that word in prose;
 * Windows drive paths (`C:\…`) are not relativised — only the literal home and
 * account passes reach them; an absolute path glued to a word character
 * (`-I/opt/acme/include`, `x/opt/…`, `myfile:///…`) is not relativised either,
 * because that is also the shape of a URL path and of relative paths — only the
 * literal home and account passes reach it; nor is one after `+ - @ $ % . ~`
 * or a backslash — a unified-diff line `+/opt/acme/conf.yml` or `-/srv/x.db`,
 * `curl -d @/opt/…`, JSON-escaped `\/opt\/…` — for the same reason (those
 * characters also start options, versions and relative paths). A private-key
 * block's line breaks are real or JSON-escaped at any depth (`\n`, `\\n`, `\r\n`
 * written out, UA12.19), and its body may carry `\/`; after a stored marker the
 * body must be whole base64 or legacy lines, or blank-joined words of 40+
 * characters but the last (`echo $KEY` unquoted), so prose after a marker is
 * never swallowed up to a later END line — that END is masked alone. A key cut
 * before its END keeps its block masked only through whole base64 lines; a body
 * line glued to prose is not masked, and a one-word line right above an orphan
 * END line, or one blank-joined word before the END after a marker, is masked
 * with the body. A key in another encoding (URL-encoded, HTML entities, base64
 * of the PEM) is not recognised. A key-shaped run far longer than any key
 * (250 000 lines, measured) outruns the regex engine's backtracking budget for
 * the to-END rule: it is then masked line by line and its END on its own —
 * counted twice, never emitted.
 */
import { homedir, userInfo } from 'node:os'
import { posix } from 'node:path'
import type { PersistedMessage } from '@nessy-agent/core/types'
import { scanToolResultForSecrets } from '@nessy-agent/shared/agent/tool-result-secret-scan'
import { findLuhnPans } from '@nessy-agent/shared/artifacts/publish-guard'
import { MAX_ARTIFACT_CONTENT_BYTES } from '@nessy-agent/shared/artifacts/t-artifacts-client'

/** Per tool payload (input JSON, result). See the header for the reason. */
export const SHARE_TOOL_PAYLOAD_CAP_BYTES = 64 * 1024

/** The fields of a managed session the snapshot reads (structural, so the caller passes its own). */
export interface ShareSnapshotSession {
  name?: string
  preview?: string
  model?: string
  llmConnection?: string
  permissionMode?: string
  sessionStatus?: string
  createdAt?: number
  lastMessageAt?: number
  workingDirectory?: string
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    contextTokens: number
    contextWindow?: number
    costUsd?: number
  }
  messages: readonly PersistedMessage[]
}

export interface ShareSnapshotOptions {
  /** `SessionManager.ts` `formatTranscriptMessage` — injected, see the header. */
  formatMessage: (message: PersistedMessage, index: number) => string
  /** The accepted added roots (the working directory is read from the session). */
  roots?: readonly string[]
  /** Defaults to `os.homedir()`. */
  homeDirs?: readonly string[]
  /** Defaults to `os.userInfo().username`; `null` disables the word pass. */
  accountName?: string | null
}

export interface ShareSnapshot {
  ok: true
  markdown: string
  /** UTF-8 bytes of {@link markdown}. */
  bytes: number
  /** Rule name → masked values, for the card. Never the values. */
  maskedSecrets: ReadonlyArray<{ rule: string; count: number }>
  maskedSecretTotal: number
  /** Absolute paths rewritten (relative or `…/<basename>`). */
  relativisedPaths: number
  /** Tool payloads cut at {@link SHARE_TOOL_PAYLOAD_CAP_BYTES}. */
  truncatedPayloads: number
}

export interface ShareSnapshotRefusal {
  ok: false
  reason: 'too-large'
  bytes: number
  /** A sentence for the user. */
  message: string
}

export type ShareSnapshotResult = ShareSnapshot | ShareSnapshotRefusal

const MASK_MARKER_PAN = '[REDACTED:pan]'
const MASK_MARKER_PRIVATE_KEY = '[REDACTED:private-key]'
const ACCOUNT_MARKER = '[user]'
const ELLIPSIS = '…'

/** A key block's edges: a PEM header or END line, or the marker a stored result carries in the header's place. */
const PEM_EDGE = /-----(BEGIN|END)(?: [A-Z]+)* PRIVATE KEY-----|\[REDACTED:private-key\]/g
/**
 * A line break inside a key block (UA12.19): a real one, or one written out as
 * JSON escapes at any depth (`\n`, `\\n`, `\r\n`) — a service-account JSON and a
 * `.env` value carry their key that way.
 */
const PEM_BREAK = String.raw`(?:\r?\n|(?:\\+r)?\\+n)`
/**
 * One base64 run; a JSON-escaped `\/` counts as `/`. Groups repeat only per
 * `\/`, never per character: JavaScriptCore gives up (no match, silently) on a
 * group repeated over a megabyte, and a rule that silently fails emits the body.
 */
const PEM_B64 = String.raw`(?:\\+/)*[A-Za-z0-9+/=]+(?:\\+/[A-Za-z0-9+/=]*)*`
/** A legacy header line (`Proc-Type: 4,ENCRYPTED`, `DEK-Info: …`): words after the colon, never a break. */
const PEM_LEGACY = String.raw`(?:Proc-Type|DEK-Info):(?:[ \t]+[^\s\\]+)*`
const PEM_WORD = `(?:${PEM_B64}|${PEM_LEGACY})`
/** Between body lines: blanks and one or more breaks (a blank line is allowed). */
const PEM_LINE_SEP = String.raw`[ \t]*(?:${PEM_BREAK}[ \t]*)+`
const PEM_END_LINE = String.raw`-----END(?: [A-Z]+)* PRIVATE KEY-----`
/** From after a header: the body (base64, legacy header lines, any breaks or blanks) through the END line. */
const PEM_TO_END = new RegExp(String.raw`[A-Za-z0-9+/=:,\s\\-]*?${PEM_END_LINE}`, 'y')
/**
 * From after a stored marker: the body must look like a key, not words — whole
 * base64 or legacy lines, or (`echo $KEY` unquoted) words joined by blanks where
 * every word but the last is a 40+ character base64 line — then the END line.
 * So prose after a marker is never swallowed up to a later END (UA12.19).
 */
const MARKER_TO_END = new RegExp(
  String.raw`(?:(?:${PEM_LINE_SEP}|[ \t]+)${PEM_WORD}(?:(?:${PEM_LINE_SEP}|(?=[ \t])(?<=[A-Za-z0-9+/=]{40})[ \t]+)${PEM_WORD})*)?(?:${PEM_LINE_SEP}|[ \t]+)${PEM_END_LINE}`,
  'y',
)
/** From after a header with no END (output cut mid-key): whole body lines only. */
const PEM_TO_BODY_EDGE = new RegExp(String.raw`(?:${PEM_BREAK}[ \t]*${PEM_WORD}?[ \t\r]*(?=${PEM_BREAK}|$))*`, 'y')
/** After a stored marker with no END, a body counts only when one follows: a 40+ base64 line or a legacy header. */
const PEM_BODY_FOLLOWS = /(?:\s|(?:\\+r)?\\+n)*(?:(?:[A-Za-z0-9+/]|\\+\/){40}|Proc-Type:)/y

function isBlank(char: string | undefined): boolean {
  return char === ' ' || char === '\t'
}

/** Where a line break (real, or JSON-escaped at any depth) that ends at `end` begins, or -1. */
function breakStartBefore(text: string, end: number): number {
  if (text[end - 1] === '\n') return text[end - 2] === '\r' ? end - 2 : end - 1
  if (text[end - 1] !== 'n' || text[end - 2] !== '\\') return -1
  let start = end - 2
  while (text[start - 1] === '\\') start -= 1
  if (text[start - 1] === 'r' && text[start - 2] === '\\') {
    start -= 2
    while (text[start - 1] === '\\') start -= 1
  }
  return start
}

/** Where the whole base64 line that ends at `end` begins (blanks around it allowed), or -1 (never before `floor`). */
function bodyLineStart(text: string, end: number, floor: number): number {
  let i = end
  while (i > floor && isBlank(text[i - 1])) i -= 1
  const wordEnd = i
  while (i > floor) {
    const char = text[i - 1]!
    if (char === 'n' && text[i - 2] === '\\') break // the escaped break above this line
    if (char === '/' && text[i - 2] === '\\' && i - 2 >= floor) {
      i -= 2
      while (i > floor && text[i - 1] === '\\') i -= 1
      continue
    }
    if (!/[A-Za-z0-9+/=]/.test(char)) break
    i -= 1
  }
  if (i === wordEnd) return -1
  while (i > floor && isBlank(text[i - 1])) i -= 1
  return i === 0 || breakStartBefore(text, i) >= 0 ? i : -1
}

/** Where the base64 lines directly above an END line at `at` begin (never before `floor`); line breaks as {@link PEM_BREAK}. */
function bodyRunStart(text: string, at: number, floor: number): number {
  let start = at
  while (start > floor && isBlank(text[start - 1])) start -= 1
  if (start > 0 && breakStartBefore(text, start) < 0) return at
  for (;;) {
    const lineEnd = breakStartBefore(text, start)
    if (lineEnd < floor) return start
    const lineStart = bodyLineStart(text, lineEnd, floor)
    if (lineStart < 0) return start
    start = lineStart
  }
}

/**
 * What may precede an absolute path: not a word, path or escape character. A
 * colon IS allowed (PATH lists, `host:/…`, `C:/…`): a URL is still untouched,
 * because its `//` fails the segment rule and its path follows a word character.
 * A `file://` prefix is consumed with the path, so `file:///opt/x/a.js` becomes
 * `…/a.js` and `file://<cwd>/src/a.ts` becomes `src/a.ts`.
 */
const PATH_START = String.raw`(?:(?<!\w)file://(?=/)|(?<![\w.~/\\@$%+-]))`
/** One path character (a space or a delimiter ends the path). */
const PATH_CHAR = String.raw`[^\s"'\x60<>()\[\]{}|,;:*?\\]`
const SEGMENT_CHAR = String.raw`[^\s"'\x60<>()\[\]{}|,;:*?\\/]`

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function trimSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, '') : value
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

class Cleaner {
  readonly tally = new Map<string, number>()
  relativised = 0
  private readonly rootPatterns: Array<{ re: RegExp }>
  private readonly homePatterns: RegExp[]
  private readonly homeLiterals: string[]
  private readonly accountPattern: RegExp | null

  constructor(roots: string[], homes: string[], accountName: string | null) {
    this.rootPatterns = roots.map((root) => ({
      re: new RegExp(`${PATH_START}${escapeRegExp(root)}(?:/(${PATH_CHAR}*)|(?!${PATH_CHAR}))`, 'g'),
    }))
    this.homePatterns = homes.map((home) =>
      new RegExp(`${PATH_START}${escapeRegExp(home)}(?:/(${PATH_CHAR}*)|(?!${PATH_CHAR}))`, 'g'))
    this.homeLiterals = homes
    this.accountPattern = accountName && accountName.length >= 3
      ? new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(accountName)}(?![A-Za-z0-9_])`, 'gi')
      : null
  }

  /** Step 1: whole private-key blocks, then the shared table plus `pan`, counted. */
  maskSecrets(text: string): string {
    if (!text) return text
    const shared = scanToolResultForSecrets(this.maskPrivateKeyBlocks(text))
    for (const { rule, count } of shared.counts) this.tally.set(rule, (this.tally.get(rule) ?? 0) + count)
    let out = shared.text
    const pans = findLuhnPans(out)
    if (pans.length > 0) {
      this.tally.set('pan', (this.tally.get('pan') ?? 0) + pans.length)
      for (let i = pans.length - 1; i >= 0; i -= 1) {
        const { index, length } = pans[i]!
        out = out.slice(0, index) + MASK_MARKER_PAN + out.slice(index + length)
      }
    }
    return out
  }

  /**
   * A private key is a BLOCK, and the shared `private-key` rule matches its
   * header line only — enough for the publish guard, which refuses the whole
   * artifact on sight (UA1.17), not for a mask, which would hide the header and
   * pass the key itself. This mask-mode extension of the O6 composition runs
   * first and replaces each block whole with one marker, counted once: from a
   * PEM header, or from the marker a stored tool result already carries in its
   * place (the event adapters' `scrubToolResultText` masks the header and keeps
   * the body), through the END line; with no END (output cut mid-key) through
   * the last body line; an END whose header was cut off takes the base64 lines
   * above it. A marker with no body after it is left alone and not counted, so
   * the document's second pass does not recount its own markers.
   */
  private maskPrivateKeyBlocks(text: string): string {
    if (!text.includes('PRIVATE KEY-----') && !text.includes(MASK_MARKER_PRIVATE_KEY)) return text
    let out = ''
    let cursor = 0
    let masked = 0
    const lastEnd = text.lastIndexOf('-----END') // no END ahead: skip the to-END rules (a failing one costs a scan)
    for (const edge of text.matchAll(PEM_EDGE)) {
      const start = edge.index
      if (start < cursor) continue
      const afterEdge = start + edge[0].length
      let blockStart = start
      let blockEnd = -1
      if (edge[1] === 'END') {
        blockStart = bodyRunStart(text, start, cursor)
        blockEnd = afterEdge
      } else {
        const toEndRule = edge[1] === 'BEGIN' ? PEM_TO_END : MARKER_TO_END
        toEndRule.lastIndex = afterEdge
        const toEnd = afterEdge <= lastEnd ? toEndRule.exec(text) : null
        PEM_BODY_FOLLOWS.lastIndex = afterEdge
        if (toEnd) blockEnd = afterEdge + toEnd[0].length
        else if (edge[1] === 'BEGIN' || PEM_BODY_FOLLOWS.test(text)) {
          PEM_TO_BODY_EDGE.lastIndex = afterEdge
          blockEnd = afterEdge + (PEM_TO_BODY_EDGE.exec(text)?.[0].trimEnd().length ?? 0)
        }
      }
      if (blockEnd < 0) continue
      out += text.slice(cursor, blockStart) + MASK_MARKER_PRIVATE_KEY
      cursor = blockEnd
      masked += 1
    }
    if (masked === 0) return text
    this.tally.set('private-key', (this.tally.get('private-key') ?? 0) + masked)
    return out + text.slice(cursor)
  }

  private elide(rest: string | undefined): string {
    const base = rest ? posix.basename(rest) : ''
    return base ? `${ELLIPSIS}/${base}` : ELLIPSIS
  }

  /** Step 2: roots → relative; home, `~/`, other absolute (2+ segments) → `…/<basename>`. */
  relativisePaths(text: string): string {
    if (!text || (!text.includes('/'))) return text
    let out = text
    for (const { re } of this.rootPatterns) {
      out = out.replace(re, (_m, rest: string | undefined) => {
        this.relativised += 1
        const relative = rest ? rest.replace(/\/+$/, '') : ''
        return relative || '.'
      })
    }
    for (const re of this.homePatterns) {
      out = out.replace(re, (_m, rest: string | undefined) => {
        this.relativised += 1
        return this.elide(rest)
      })
    }
    out = out.replace(new RegExp(`${PATH_START}~/(${PATH_CHAR}*)`, 'g'), (_m, rest: string) => {
      this.relativised += 1
      return this.elide(rest)
    })
    out = out.replace(new RegExp(`${PATH_START}((?:/${SEGMENT_CHAR}+){2,}/?)`, 'g'), (_m, path: string) => {
      this.relativised += 1
      return this.elide(path)
    })
    return out
  }

  /** Step 3: literal home directories and the account name as a word. */
  literals(text: string): string {
    if (!text) return text
    let out = text
    for (const home of this.homeLiterals) {
      if (out.includes(home)) {
        out = out.split(home).join(ELLIPSIS)
        this.relativised += 1
      }
    }
    if (this.accountPattern) out = out.replace(this.accountPattern, ACCOUNT_MARKER)
    return out
  }

  clean(text: string | undefined): string | undefined {
    if (!text) return text
    return this.literals(this.relativisePaths(this.maskSecrets(text)))
  }

  cleanTree(value: unknown): unknown {
    if (typeof value === 'string') return this.clean(value)
    if (Array.isArray(value)) return value.map((item) => this.cleanTree(item))
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) out[this.clean(key) ?? key] = this.cleanTree(item)
      return out
    }
    return value
  }
}

function truncatePayload(text: string, counter: { truncated: number }): string {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= SHARE_TOOL_PAYLOAD_CAP_BYTES) return text
  counter.truncated += 1
  const kept = Buffer.from(text, 'utf8').subarray(0, SHARE_TOOL_PAYLOAD_CAP_BYTES).toString('utf8').replace(/\uFFFD+$/, '')
  const dropped = bytes - Buffer.byteLength(kept, 'utf8')
  return `${kept}\n[… truncated for sharing: ${dropped} bytes dropped]`
}

/** A fence longer than any backtick run inside, so payload text cannot close it. */
function fence(language: string, content: string): string {
  const longest = Math.max(0, ...Array.from(content.matchAll(/`+/g), (m) => m[0].length))
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return [ticks + language, content.trimEnd(), ticks].join('\n')
}

/**
 * UA12.30 — the THINKING body rides raw inside our collapsed block, so a literal
 * `</details>` line in it would close the block early, and a literal
 * `<details>` opener would open one of its own (the emitted counts must stay
 * ours alone). Every details-tag spelling in the body is HTML-escaped (`&lt;…`),
 * which a markdown renderer decodes back to the original characters in prose, so
 * the reader still sees `</details>` — inside the one block.
 * DECIDED (controller, 2026-10-09, the owner's simplicity rule): escape EVERYWHERE.
 * Three follow-ups tried to keep code raw by agreeing a lexer (`marked`) with
 * CommonMark and each verification found another shape where the two disagree
 * and a raw tag closed the block early; escape-everywhere had zero early closes
 * in the lanes' 40 000-body fuzz (markdown-it html:true, micromark). Stated
 * residue (cosmetic): inside a code span or code block of a thinking body a
 * details tag reads `&lt;…` literally. A fenced tool payload needs none of this
 * (its fence makes the text inert), so this runs at the thinking call site only.
 */
function escapeDetailsTags(body: string): string {
  return body.replace(/<\/?details(?![a-z])/gi, (tag) => `&lt;${tag.slice(1)}`)
}

function collapsed(summary: string, body: string): string {
  return ['<details><summary>' + summary + '</summary>', '', body, '', '</details>'].join('\n')
}

function timestamp(value: number | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function defaultAccountName(): string | null {
  try {
    return userInfo().username || null
  } catch {
    return null
  }
}

/** Usable as a path anchor: absolute, not the filesystem root. */
function usableAnchor(path: string | undefined): path is string {
  return typeof path === 'string' && path.startsWith('/') && trimSlash(path) !== '/'
}

/**
 * Build the snapshot UA1.25 sends. Pure apart from reading the OS home and
 * account name when the options do not supply them.
 */
export function buildShareSnapshot(session: ShareSnapshotSession, options: ShareSnapshotOptions): ShareSnapshotResult {
  const roots = [session.workingDirectory, ...(options.roots ?? [])]
    .filter(usableAnchor)
    .map(trimSlash)
    .sort((a, b) => b.length - a.length)
  const homes = (options.homeDirs ?? [homedir()]).filter(usableAnchor).map(trimSlash)
  const accountName = options.accountName === undefined ? defaultAccountName() : options.accountName
  const cleaner = new Cleaner(Array.from(new Set(roots)), Array.from(new Set(homes)), accountName)
  const counter = { truncated: 0 }

  const title = cleaner.clean(session.name || session.preview) || 'Shared chat'
  const lines: string[] = [`# ${title}`, '']
  const project = session.workingDirectory ? posix.basename(trimSlash(session.workingDirectory)) : ''
  if (project) lines.push(`- Project: ${cleaner.clean(project)}`)
  const createdAt = timestamp(session.createdAt)
  const lastMessageAt = timestamp(session.lastMessageAt)
  if (createdAt) lines.push(`- Created: ${createdAt}`)
  if (lastMessageAt) lines.push(`- Last message: ${lastMessageAt}`)
  if (session.model) lines.push(`- Model: ${cleaner.clean(session.model)}`)
  if (session.llmConnection) lines.push(`- Connection: ${cleaner.clean(session.llmConnection)}`)
  if (session.permissionMode) lines.push(`- Permission mode: ${session.permissionMode}`)
  if (session.sessionStatus) lines.push(`- Status: ${cleaner.clean(session.sessionStatus)}`)

  if (session.tokenUsage) {
    const usage = session.tokenUsage
    lines.push(
      '',
      '## Token usage',
      '',
      `- Input: ${usage.inputTokens}`,
      `- Output: ${usage.outputTokens}`,
      `- Total: ${usage.totalTokens}`,
      `- Context: ${usage.contextTokens}`,
    )
    if (usage.contextWindow) lines.push(`- Context window: ${usage.contextWindow}`)
    if (usage.costUsd) lines.push(`- Cost USD: ${usage.costUsd}`)
  }

  lines.push('', '## Messages')
  if (session.messages.length === 0) lines.push('', '_No messages._')

  for (const [index, message] of session.messages.entries()) {
    const thinking = message.isThinking === true
    const content = cleaner.clean(message.content) ?? ''
    // The formatter renders heading, time, tool name / status / intent, content,
    // attachments and annotations; the collapsed blocks are appended below.
    const projected: PersistedMessage = {
      ...message,
      content: thinking ? '' : content,
      toolName: cleaner.clean(message.toolName),
      toolIntent: cleaner.clean(message.toolIntent),
      toolInput: undefined,
      toolResult: undefined,
      rawToolInput: undefined,
      rawToolResult: undefined,
      attachments: message.attachments?.map((attachment) => ({
        ...attachment,
        name: cleaner.clean(attachment.name) ?? '',
        storedPath: '',
      })),
    }
    const parts: string[] = [options.formatMessage(projected, index)]
    if (thinking && content.trim()) parts.push(collapsed('Thinking', escapeDetailsTags(content.trimEnd())))
    if (message.toolInput && Object.keys(message.toolInput).length > 0) {
      const input = truncatePayload(JSON.stringify(cleaner.cleanTree(message.toolInput), null, 2), counter)
      parts.push(collapsed('Tool input', fence('json', input)))
    }
    if (message.toolResult) {
      const result = truncatePayload(cleaner.clean(message.toolResult) ?? '', counter)
      parts.push(collapsed('Tool result', fence('', result)))
    }
    lines.push('', parts.join('\n\n'))
  }

  // Every emitted string passes the mask: the whole document, once more.
  const markdown = cleaner.literals(cleaner.maskSecrets(lines.join('\n') + '\n'))
  const bytes = Buffer.byteLength(markdown, 'utf8')
  if (bytes > MAX_ARTIFACT_CONTENT_BYTES) {
    return {
      ok: false,
      reason: 'too-large',
      bytes,
      message: `This chat is too large to share: its snapshot is ${mib(bytes)} and the sharing service accepts at most ${mib(MAX_ARTIFACT_CONTENT_BYTES)}, even with each tool output cut to ${SHARE_TOOL_PAYLOAD_CAP_BYTES / 1024} KiB.`,
    }
  }
  const maskedSecrets = Array.from(cleaner.tally, ([rule, count]) => ({ rule, count }))
  return {
    ok: true,
    markdown,
    bytes,
    maskedSecrets,
    maskedSecretTotal: maskedSecrets.reduce((sum, entry) => sum + entry.count, 0),
    relativisedPaths: cleaner.relativised,
    truncatedPayloads: counter.truncated,
  }
}
