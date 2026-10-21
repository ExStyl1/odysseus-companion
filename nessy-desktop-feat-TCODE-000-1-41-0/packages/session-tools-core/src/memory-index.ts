/**
 * The auto-memory INDEX (`MEMORY.md`) contract, in one place: what loads, how
 * much of it there is, what a write has to say about it, and the `modified`
 * stamp.
 *
 * WHY THIS LIVES HERE, in the leaf package rather than in
 * `@nessy-agent/shared/agent/memory` where the rest of the memory subsystem
 * lives. The dependency direction allows exactly one arrangement: this package
 * has NO dependency on `@nessy-agent/shared`, and `shared` depends on it. The
 * model-facing writer (`handlers/remember.ts`) and the UI/RPC writer
 * (`shared/agent/memory/memory-store.ts:appendMemoryFile`) must agree on the
 * limits, on the measurement and on the message text, and the load cap must
 * count the same bytes the write check counts — a second copy of any of that
 * is the drift this module exists to prevent. `MEMORY_FILE_NAME` and the
 * auto-memory marker are already duplicated across the two packages behind a
 * "keep in sync" comment; that is the anti-pattern, not the precedent.
 *
 * `capMemoryIndexLoad`, `stripBlockHtmlComments` and both limit constants were
 * MOVED here from `shared/agent/memory/` for that reason; `shared` re-exports
 * them, so every existing importer is unchanged.
 */

/** An open fence: its marker character and the run length that opened it. */
export interface FenceState {
  char: '`' | '~';
  length: number;
}

/**
 * The fence run a line opens or closes, or `null`. CommonMark allows up to three
 * leading spaces and an info string on the OPENING fence only, so a closing
 * fence is recognised separately by the caller.
 */
export function fenceRun(line: string): { char: '`' | '~'; length: number; rest: string } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const run = match[1]!;
  return { char: run[0] as '`' | '~', length: run.length, rest: match[2] ?? '' };
}

/**
 * Drop block-level HTML comments.
 *
 * `memory.md:161` — "Block-level HTML comments (`<!-- maintainer notes -->`) in
 * CLAUDE.md files are stripped before the content is injected into Claude's
 * context. Use them to leave notes for human maintainers without spending
 * context tokens on them. Comments inside code blocks are preserved. When you
 * open a CLAUDE.md file directly with the Read tool, comments remain visible."
 *
 * "Block-level" is read strictly: the comment must own its lines, opening at the
 * start of a line (indentation aside) and closing with nothing after `-->`. An
 * inline `note <!-- x --> more` is prose and survives — which is also what keeps
 * this off `stripAutoMemoryMarkers`' territory, since the auto-memory marker is
 * appended to the END of an entry line, and is therefore still charged against
 * the index budget (`errors.md:1549` excludes only frontmatter and BLOCK-level
 * comments from the measurement).
 *
 * An unterminated `<!--` is left alone rather than eating the rest of the file,
 * and comments inside a fenced block are preserved as the page requires.
 */
export function stripBlockHtmlComments(text: string): string {
  if (!text.includes('<!--')) return text;

  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let fence: FenceState | null = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const run = fenceRun(line);
    if (fence) {
      if (run && run.char === fence.char && run.length >= fence.length && run.rest.trim() === '') fence = null;
      out.push(line);
      continue;
    }
    if (run) {
      fence = { char: run.char, length: run.length };
      out.push(line);
      continue;
    }

    const open = line.indexOf('<!--');
    if (open === -1 || line.slice(0, open).trim() !== '') { out.push(line); continue; }

    let closeLine = -1;
    for (let cursor = lineIndex; cursor < lines.length; cursor += 1) {
      const from = cursor === lineIndex ? open + 4 : 0;
      const close = lines[cursor]!.indexOf('-->', from);
      if (close === -1) continue;
      if (lines[cursor]!.slice(close + 3).trim() === '') closeLine = cursor;
      break;
    }
    if (closeLine === -1) { out.push(line); continue; }
    lineIndex = closeLine;
  }

  return out.join('\n');
}

export const MEMORY_LOAD_LINE_LIMIT = 200;

/**
 * The BYTE half of the auto-memory index load limit. The two caps are one rule
 * and both are mandatory — `how-claude-code-works.md:74`: "The first 200 lines
 * or 25KB of MEMORY.md, whichever comes first, load at the start of each
 * session." `memory.md:384` adds the consequence: "The first 200 lines of
 * `MEMORY.md`, or the first 25KB, whichever comes first, are loaded at the start
 * of every conversation. Content beyond that threshold is not loaded at session
 * start." `context-window.md:29` states the same pair as a context-budget
 * guarantee, and `glossary.md:45` spells the unit "25 KB".
 *
 * Read as 25 KiB, by analogy with `AUTO_MEMORY_CLEANUP_MAX_BYTES = 256 * 1024`
 * (`memory-cleanup.ts`): none of the four pages disambiguates KB from KiB.
 */
export const MEMORY_LOAD_BYTE_LIMIT = 25 * 1024;

/**
 * The rewrite target the over-limit error names, verbatim from
 * `errors.md:1546`: "Rewrite it to under 140 lines now".
 */
export const MEMORY_INDEX_REWRITE_TARGET_LINES = 140;

/**
 * The byte-branch rewrite target. The page names no number for it, so it is the
 * SAME SHARE the documented line target is of the line limit (140/200 = 70 %),
 * which lands on exactly 17.5 KiB. Ours, derived, and marked as such.
 */
export const MEMORY_INDEX_REWRITE_TARGET_BYTES = Math.floor(
  MEMORY_LOAD_BYTE_LIMIT * (MEMORY_INDEX_REWRITE_TARGET_LINES / MEMORY_LOAD_LINE_LIMIT),
);

/**
 * How close to a limit counts as "near".
 *
 * `errors.md:1553` states the milder reminder exists — "When Claude's write
 * brings the file near a limit without crossing it, Claude Code returns a milder
 * reminder to compact the index instead of this error" — and names no number.
 * `errors.md:1546`'s "under 140 lines" is the rewrite TARGET after crossing, not
 * the near trigger. 90 % is ours: one `remember` call is one line, so 180 lines
 * leaves ~20 writes of warning before the cliff.
 */
export const MEMORY_INDEX_NEAR_LIMIT_RATIO = 0.9;

/**
 * Cut `text` to at most `maxBytes` UTF-8 bytes on a CODE-POINT boundary.
 *
 * `for…of` over a string iterates code points, so a surrogate pair counts once
 * and a multi-byte sequence is never split — the index is user prose and this
 * repo ships non-ASCII (ru) content through it.
 */
function truncateToUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return text;
  let kept = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf-8');
    if (bytes + size > maxBytes) break;
    kept += char;
    bytes += size;
  }
  return kept;
}

/**
 * What actually LOADS from an auto-memory index: the first `maxLines` lines or
 * the first `maxBytes` bytes, whichever comes first.
 *
 * `memory.md:384` — "The first 200 lines of `MEMORY.md`, or the first 25KB,
 * whichever comes first, are loaded at the start of every conversation. Content
 * beyond that threshold is not loaded at session start."
 *
 * Both caps are applied and the tighter one wins. The cut is on a LINE boundary
 * so the surviving text is whole entries rather than a severed one; the only
 * exception is a single line that alone exceeds the whole byte budget, which
 * would otherwise erase the index — that one is cut inside the line, on a
 * code-point boundary. Deterministic: same bytes in, same bytes out.
 *
 * This takes text that has already had frontmatter and block-level HTML
 * comments removed; {@link memoryIndexLoadedContent} is the whole pipeline and
 * is what every caller should reach for.
 */
export function capMemoryIndexLoad(
  text: string,
  maxLines = MEMORY_LOAD_LINE_LIMIT,
  maxBytes = MEMORY_LOAD_BYTE_LIMIT,
): string {
  if (maxLines <= 0 || maxBytes <= 0) return '';
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (kept.length >= maxLines) break;
    // The `\n` this line is joined back with counts too, so the emitted string
    // is what was measured.
    const cost = Buffer.byteLength(line, 'utf-8') + (kept.length > 0 ? 1 : 0);
    if (bytes + cost > maxBytes) break;
    kept.push(line);
    bytes += cost;
  }
  if (kept.length === 0) return truncateToUtf8Bytes(lines[0] ?? '', maxBytes).trim();
  return kept.join('\n').trim();
}

/**
 * Drop a leading YAML frontmatter block.
 *
 * `memory.md:388` — "The check measures only the content that loads: YAML
 * frontmatter and block-level HTML comments are stripped before the index is
 * loaded, so they don't count toward the limits." `errors.md:1549` says the same
 * of the error's measurement. So this is a LOAD-path rule first and a
 * measurement rule second, and both halves are the same strip — which is also
 * what keeps {@link stampMemoryModified}'s `modified:` line out of the pinned
 * prompt block. A frontmatter line that changed on every write would invalidate
 * the cached prefix on every memory write.
 *
 * Open/close test copied from `parseRuleFile`: line 0 is `---` AND some later
 * line is `---`. A `---` that is opened and never closed is NOT frontmatter and
 * the file is returned untouched, so a Markdown document that merely starts with
 * a horizontal rule keeps all of its content.
 *
 * SCOPED TO THE INDEX by every caller. A `.agents/rules` file carries its
 * `paths:` globs in frontmatter, and stripping it there would silently promote a
 * path-scoped rule to an unconditional one.
 */
export function stripMemoryFrontmatter(text: string): string {
  const normalized = text.replace(/^\uFEFF/, '');
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return text;
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (endIndex === -1) return text;
  return lines.slice(endIndex + 1).join('\n');
}

/**
 * The single definition of "what an auto-memory index contributes to the
 * prompt": frontmatter off, block-level HTML comments off, then the caps.
 *
 * Order is load-bearing and is `memory.md:388`'s own order — both strips run
 * BEFORE the measurement, "so they don't count toward the limits".
 */
export function memoryIndexLoadedContent(
  raw: string,
  maxLines = MEMORY_LOAD_LINE_LIMIT,
  maxBytes = MEMORY_LOAD_BYTE_LIMIT,
): string {
  return capMemoryIndexLoad(memoryIndexLoadable(raw), maxLines, maxBytes);
}

/** Everything the caps are measured against — the strips, without the cut. */
function memoryIndexLoadable(raw: string): string {
  return stripBlockHtmlComments(stripMemoryFrontmatter(raw)).trim();
}

export interface MemoryIndexMeasurement {
  lines: number;
  bytes: number;
}

/**
 * How big the loadable part of an index is, counted exactly the way
 * {@link capMemoryIndexLoad} charges it.
 *
 * The two run over the same string ({@link memoryIndexLoadable}) and use the
 * same line split and the same `\n` join, so "nothing was dropped" and
 * "`lines <= 200 && bytes <= 25 KiB`" are the same statement. That equivalence
 * is the whole reason the measurement lives beside the cap instead of beside
 * the writer.
 */
export function measureMemoryIndex(raw: string): MemoryIndexMeasurement {
  const loadable = memoryIndexLoadable(raw);
  if (!loadable) return { lines: 0, bytes: 0 };
  const lines = loadable.split(/\r?\n/);
  return { lines: lines.length, bytes: Buffer.byteLength(lines.join('\n'), 'utf-8') };
}

export type MemoryIndexNoticeLevel = 'ok' | 'near' | 'over';

export interface MemoryIndexWriteNotice {
  level: MemoryIndexNoticeLevel;
  /** Empty for `ok`. Self-describing on purpose — see the note in the builder. */
  message: string;
}

/** The remedy sentence, shared by both messages. */
const MEMORY_INDEX_REMEDY =
  'keep one line per entry, move detail into a separate file and pull it back in with an `@path` import, and merge or drop stale entries';

/**
 * What a write must tell the model about the index it just left behind.
 *
 * `memory.md:386` — "After Claude writes to `MEMORY.md`, Claude Code measures
 * the file against the 200-line and 25KB read limits. If the file is near a
 * limit, Claude Code reminds Claude to shorten it: keep one line per entry, move
 * detail into topic files, and merge or drop stale entries. If the file is over
 * a limit, the write still succeeds, but Claude Code returns an error telling
 * Claude to rewrite the index, because everything past the limit is dropped on
 * the next load."
 *
 * The over-limit wording follows `errors.md:1546` — "Error: this write left the
 * memory index at MEMORY.md at 214 lines, over its 200-line read limit. The
 * write succeeded, but everything past the limit is silently dropped each time
 * the index is loaded — entries at the end are already invisible to readers.
 * Rewrite it to under 140 lines now: keep one line per entry, move detail into
 * topic files, and merge or drop stale entries." Two deliberate departures:
 * the leading `Error: ` is dropped because `errorResponse` already prefixes
 * `[ERROR] `, and "topic files" becomes the `@path` import because this fork has
 * no memory DIRECTORY — a moved block only leaves the index's budget if the
 * index references it with an import (`memory-layers.ts` measures the caps
 * BEFORE expansion, so the import's own body is not charged to the index).
 *
 * BOTH messages are self-describing: `response.ts` records that `isError: true`
 * is invisible on the Codex/Responses path, so the text has to carry the fact
 * that the write succeeded on its own.
 */
export function memoryIndexWriteNotice(
  filePath: string,
  measured: MemoryIndexMeasurement,
): MemoryIndexWriteNotice {
  // Line first when both are crossed: it is the branch the page spells out, and
  // it is the one a reader can act on without counting bytes.
  if (measured.lines > MEMORY_LOAD_LINE_LIMIT) {
    return {
      level: 'over',
      message:
        `this write left the memory index at ${filePath} at ${measured.lines} lines, over its `
        + `${MEMORY_LOAD_LINE_LIMIT}-line read limit. The write succeeded, but everything past the `
        + 'limit is silently dropped each time the index is loaded — entries at the end are already '
        + `invisible to readers. Rewrite it to under ${MEMORY_INDEX_REWRITE_TARGET_LINES} lines now: `
        + `${MEMORY_INDEX_REMEDY}.`,
    };
  }
  if (measured.bytes > MEMORY_LOAD_BYTE_LIMIT) {
    return {
      level: 'over',
      message:
        `this write left the memory index at ${filePath} at ${measured.bytes} bytes, over its `
        + `${MEMORY_LOAD_BYTE_LIMIT}-byte (25KB) read limit. The write succeeded, but everything past `
        + 'the limit is silently dropped each time the index is loaded — entries at the end are '
        + `already invisible to readers. Rewrite it to under ${MEMORY_INDEX_REWRITE_TARGET_BYTES} `
        + `bytes now: ${MEMORY_INDEX_REMEDY}.`,
    };
  }
  const nearLines = measured.lines >= MEMORY_LOAD_LINE_LIMIT * MEMORY_INDEX_NEAR_LIMIT_RATIO;
  const nearBytes = measured.bytes >= MEMORY_LOAD_BYTE_LIMIT * MEMORY_INDEX_NEAR_LIMIT_RATIO;
  if (nearLines || nearBytes) {
    return {
      level: 'near',
      message:
        `The memory index at ${filePath} is near its read limit (${measured.lines} of `
        + `${MEMORY_LOAD_LINE_LIMIT} lines, ${measured.bytes} of ${MEMORY_LOAD_BYTE_LIMIT} bytes); `
        + `content past either limit stops loading. Compact it now: ${MEMORY_INDEX_REMEDY}.`,
    };
  }
  return { level: 'ok', message: '' };
}

/**
 * Refresh the `modified` frontmatter field on a memory file that HAS
 * frontmatter, and never add one to a file that has none.
 *
 * `memory.md:398`, read whole — "When Claude writes a memory file that begins
 * with YAML frontmatter, Claude Code records the write time in a `modified`
 * frontmatter field as an ISO 8601 timestamp. The timestamp shows how current
 * the fact is, both to you and to Claude when it reads the memory back. Any file
 * that has frontmatter gets the field the next time Claude writes it, including
 * files created on earlier versions; Claude Code never adds frontmatter to a
 * file that has none."
 *
 * Line-level surgery, deliberately NOT `gray-matter`'s `matter.stringify` even
 * though gray-matter is already a dependency here: re-serialising reorders keys
 * and requotes values in a file the user hand-wrote. Every other line comes out
 * byte-identical, the file's newline convention is preserved (a CRLF file is not
 * silently rewritten to LF), and a leading BOM survives.
 *
 * The open/close test is `stripMemoryFrontmatter`'s, so a file this stamps is
 * exactly a file whose frontmatter the load path strips — which is what keeps
 * the changing timestamp out of the pinned prompt block.
 */
/**
 * The four kinds of note auto memory records, in the page's own order.
 *
 * `memory.md`, verbatim: *"Claude saves four kinds of notes for itself. Claude
 * records the kind as a `type` field in the memory file's frontmatter"* —
 * `user` ("your role, expertise, and working preferences"), `feedback`
 * ("corrections you give Claude and approaches you confirm"), `project`
 * ("ongoing work, deadlines, and decisions that Claude can't derive from the
 * code or git history") and `reference` ("where to find information outside the
 * project, such as an issue tracker or dashboard").
 *
 * A closed set on purpose: an invented fifth value would be a field no reader
 * of the documented format knows how to interpret.
 */
export const AUTO_MEMORY_KINDS = ['user', 'feedback', 'project', 'reference'] as const;

export type AutoMemoryKind = (typeof AUTO_MEMORY_KINDS)[number];

export function isAutoMemoryKind(value: unknown): value is AutoMemoryKind {
  return typeof value === 'string' && (AUTO_MEMORY_KINDS as readonly string[]).includes(value);
}

/**
 * Record the note's kind as a `type` frontmatter field (P6.389).
 *
 * Same line-level surgery as {@link stampMemoryModified}, and two deliberate
 * differences from it:
 *
 * 1. **It SYNTHESIZES the block when there is none.** `modified` does not,
 *    because the page scopes that field to files that already have frontmatter
 *    ("Any file that has frontmatter gets the field the next time Claude writes
 *    it"). `type` is stated unconditionally — the kind is recorded, full stop —
 *    and it costs no context either way, because `memoryIndexLoadedContent`
 *    strips frontmatter before the caps are measured. It also cannot invalidate
 *    a cached prefix the way a timestamp can: the value never changes.
 * 2. **It never overwrites a `type` that is already there.**
 *
 * ## The residue behind rule 2, stated rather than papered over
 *
 * The page's `type` describes a file holding ONE memory (its own directory
 * listing is `user_role.md # One memory`, `feedback_testing.md # One memory`).
 * Our `remember` appends bullets to an INDEX, which can hold notes of several
 * kinds, and one field cannot honestly describe all of them. So the field
 * records the kind of the note that created the file, and a later note of a
 * different kind leaves it alone rather than relabelling everything above it.
 * Reaching the page's shape means writing each memory as its own topic file,
 * which is a layout change and a separate row.
 */
export function stampMemoryType(content: string, kind: AutoMemoryKind): string {
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? content.slice(1) : content;
  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/);
  const field = `type: ${kind}`;

  if (lines[0]?.trim() !== '---') {
    return `${bom}---${newline}${field}${newline}---${newline}${body}`;
  }
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  // An unterminated `---` is not frontmatter (the `stripMemoryFrontmatter`
  // rule): leave it alone rather than closing a block the author did not open.
  if (endIndex === -1) return content;
  const existing = lines.findIndex(
    (line, index) => index > 0 && index < endIndex && /^\s*type\s*:/.test(line),
  );
  if (existing !== -1) return content;
  lines.splice(endIndex, 0, field);
  return bom + lines.join(newline);
}

export function stampMemoryModified(content: string, now: Date = new Date()): string {
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? content.slice(1) : content;
  const lines = body.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return content;
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (endIndex === -1) return content;

  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  const stamp = `modified: ${now.toISOString()}`;
  const existing = lines.findIndex(
    (line, index) => index > 0 && index < endIndex && /^\s*modified\s*:/.test(line),
  );
  if (existing === -1) lines.splice(endIndex, 0, stamp);
  else lines[existing] = stamp;
  return bom + lines.join(newline);
}
