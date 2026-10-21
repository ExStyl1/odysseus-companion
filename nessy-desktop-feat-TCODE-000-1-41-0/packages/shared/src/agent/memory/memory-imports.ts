import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fenceRun, type FenceState } from '@nessy-agent/session-tools-core';

/**
 * `stripBlockHtmlComments` MOVED to `@nessy-agent/session-tools-core`
 * (`memory-index.ts`) and is re-exported here so every existing importer is
 * unchanged. It had to move with the index caps: the write-time measurement
 * (`memory.md:386`) runs in the leaf package, and `errors.md:1549` excludes
 * block-level HTML comments from that measurement, so the load path and the
 * write check must share ONE stripper or they count different bytes.
 */
export { stripBlockHtmlComments } from '@nessy-agent/session-tools-core';

/**
 * ONE recogniser for `@path` imports, and it is a DOCUMENT scanner rather than a
 * line parser.
 *
 * `memory.md:95` — "CLAUDE.md files can import additional files using
 * `@path/to/import` syntax. Imported files are expanded and loaded into context
 * at launch alongside the CLAUDE.md that references them."
 * `memory.md:99` — "Import parsing skips Markdown code spans and fenced code
 * blocks. To mention a path in your CLAUDE.md without importing it, wrap it in
 * backticks: writing `` `@README` `` keeps the text literal, while `@README`
 * outside backticks imports the file."
 * `memory.md:101` — "To pull in a README, package.json, and a workflow guide,
 * reference them with `@` syntax anywhere in your CLAUDE.md:" — and the example
 * at `:104` carries TWO imports mid-sentence on one line, `:107` one after a
 * list bullet, `:116` one after a bullet with a `~/` path.
 *
 * Three rules follow from those lines, and all three were previously broken by
 * the same per-line predicate:
 * - a token is recognised ANYWHERE in a line, and a line may carry several;
 * - an extension is NOT required — `@README` is an import;
 * - a token inside a code span or a fenced block is NOT an import, which no
 *   per-line signature can decide because fence state spans lines.
 *
 * The predicate that used to live here (`parseMemoryImportPath`) satisfied the
 * code-span rule only as a side effect of anchoring at the line start, so fixing
 * the position rule alone would have silently re-opened the code-span hole. That
 * is why this is one scanner and not two.
 */
export interface MemoryImportToken {
  /** 0-based index of the line the token sits on. */
  line: number;
  /** Offset of the `@` within that line. */
  start: number;
  /** Offset one past the token's last character within that line. */
  end: number;
  /** The path exactly as written, quotes stripped, no resolution applied. */
  path: string;
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote) && trimmed.length >= 2) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** A character that may sit immediately before an import token's `@`. */
const IMPORT_TOKEN_PREFIX = /[\s([{<"']/;
/** A character that terminates an unquoted import path. */
const IMPORT_PATH_TERMINATOR = /[\s`<>"']/;
/**
 * Sentence punctuation trimmed off the end of an unquoted path, so
 * "…@package.json for available npm commands for this project." yields
 * `package.json` and a path is never taken to include the full stop that ends
 * the sentence around it. `.md` survives because `d` is not in this set.
 */
const IMPORT_PATH_TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

/**
 * The Nessy-only whole-line form. It ADDS a shape rather than removing one, and
 * on-disk memory files in the wild already use it, so the scanner keeps it: an
 * `@import ` line consumes the rest of the line as one path (quotes allowed,
 * spaces allowed).
 */
const IMPORT_DIRECTIVE = '@import ';

/**
 * Every import token in `text`, in document order.
 *
 * Narrowing, recorded rather than silent: code spans are matched WITHIN a line.
 * CommonMark lets a code span cross a newline, but an unclosed backtick run
 * would then swallow every import in the rest of the file, which fails open in
 * the wrong direction for a file that decides what the model reads.
 */
export function scanMemoryImports(text: string): MemoryImportToken[] {
  const tokens: MemoryImportToken[] = [];
  const lines = text.split(/\r?\n/);
  let fence: FenceState | null = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const run = fenceRun(line);
    if (fence) {
      // A closing fence uses the same marker, at least the opener's run length,
      // and carries no info string.
      if (run && run.char === fence.char && run.length >= fence.length && run.rest.trim() === '') fence = null;
      continue;
    }
    if (run) {
      fence = { char: run.char, length: run.length };
      continue;
    }

    let index = 0;
    while (index < line.length) {
      const char = line[index]!;

      if (char === '`') {
        // A run of N backticks opens a code span that closes on the next run of
        // EXACTLY N. An unmatched run is literal text and scanning continues
        // after it.
        let runEnd = index;
        while (line[runEnd] === '`') runEnd += 1;
        const runLength = runEnd - index;
        let cursor = runEnd;
        let closed = -1;
        while (cursor < line.length) {
          if (line[cursor] !== '`') { cursor += 1; continue; }
          let closeEnd = cursor;
          while (line[closeEnd] === '`') closeEnd += 1;
          if (closeEnd - cursor === runLength) { closed = closeEnd; break; }
          cursor = closeEnd;
        }
        index = closed >= 0 ? closed : runEnd;
        continue;
      }

      if (char !== '@') { index += 1; continue; }

      // `@@` stays the escape it has always been: neither `@` starts a token.
      if (line[index + 1] === '@') { index += 2; continue; }

      const previous = index > 0 ? line[index - 1]! : '';
      if (previous !== '' && !IMPORT_TOKEN_PREFIX.test(previous)) { index += 1; continue; }

      if (line.startsWith(IMPORT_DIRECTIVE, index) && line.slice(0, index).trim() === '') {
        const path = stripWrappingQuotes(line.slice(index + IMPORT_DIRECTIVE.length));
        if (path) tokens.push({ line: lineIndex, start: index, end: line.length, path });
        break;
      }

      const pathStart = index + 1;
      const quote = line[pathStart];
      if (quote === '"' || quote === "'") {
        const close = line.indexOf(quote, pathStart + 1);
        if (close === -1) { index = pathStart; continue; }
        const path = line.slice(pathStart + 1, close).trim();
        if (path) tokens.push({ line: lineIndex, start: index, end: close + 1, path });
        index = close + 1;
        continue;
      }

      let pathEnd = pathStart;
      while (pathEnd < line.length && !IMPORT_PATH_TERMINATOR.test(line[pathEnd]!)) pathEnd += 1;
      const raw = line.slice(pathStart, pathEnd);
      const path = raw.replace(IMPORT_PATH_TRAILING_PUNCTUATION, '');
      if (!path) { index = Math.max(pathEnd, pathStart); continue; }
      tokens.push({ line: lineIndex, start: index, end: pathStart + path.length, path });
      index = pathEnd;
    }
  }

  return tokens;
}

/**
 * Where an import token points.
 *
 * `memory.md:97` — "Both relative and absolute paths are allowed. Relative paths
 * resolve relative to the file containing the import, not the working
 * directory." `:116`'s example is `- @~/.claude/my-project-instructions.md`, so
 * `~` expands to the home directory rather than being read as a directory named
 * `~` beside the importer. Containment is the CALLER's decision and is unchanged
 * by this helper — the capability walker still refuses anything that resolves
 * outside its root.
 */
export function resolveMemoryImportPath(
  importerFilePath: string,
  importPath: string,
  homeDirectory = homedir(),
): string {
  if (importPath === '~') return resolve(homeDirectory);
  if (importPath.startsWith('~/') || importPath.startsWith('~\\')) {
    return resolve(homeDirectory, importPath.slice(2));
  }
  if (isAbsolute(importPath)) return resolve(importPath);
  return resolve(dirname(importerFilePath), importPath);
}

export interface MemoryImportResolution {
  /** The imported file's absolute path. */
  path: string;
  /** Its body, already expanded — the resolver owns depth and cycle control. */
  body: string;
}

/**
 * Splice every resolvable import into `text`.
 *
 * Two renderings, one recogniser:
 * - a token that IS the whole line (nothing but whitespace either side) is a
 *   directive, and the line is REPLACED by the imported body — the shape every
 *   whole-line `@path` in the wild already has, and the shape whose line the
 *   pinned block used to delete outright.
 * - a token inside prose keeps its line verbatim and the imported body follows
 *   it. `memory.md:104`'s own example — "See @README for project overview and
 *   @package.json for available npm commands for this project." — is why: both
 *   deleting the line and splicing a whole README into the middle of that
 *   sentence destroy the sentence.
 *
 * A whole-line directive that resolves to nothing still loses its line, which is
 * what the pinned block did for every recognised import before this. Inside
 * prose, an unresolved token is left exactly as written.
 *
 * Synchronous on purpose: `loadMemoryPromptBlock` is reached from the
 * synchronous `getSystemPrompt`, so the async callers read their bodies up front
 * and hand this a resolver that only looks things up.
 */
export function expandMemoryImports(
  text: string,
  importerFilePath: string,
  resolveImport: (importerFilePath: string, token: MemoryImportToken) => MemoryImportResolution | null,
): string {
  const tokens = scanMemoryImports(text);
  if (tokens.length === 0) return text;

  const byLine = new Map<number, MemoryImportToken[]>();
  for (const token of tokens) {
    const bucket = byLine.get(token.line);
    if (bucket) bucket.push(token);
    else byLine.set(token.line, [token]);
  }

  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const lineTokens = byLine.get(lineIndex);
    if (!lineTokens) { out.push(line); continue; }

    const imported: string[] = [];
    let resolvedAny = false;
    for (const token of lineTokens) {
      const resolution = resolveImport(importerFilePath, token);
      if (!resolution) continue;
      // A resolution with an EMPTY body still counts as resolved: that is the
      // "already inlined by another importer" case, where dropping the token is
      // the point — the bytes are in this generation's prompt already.
      resolvedAny = true;
      if (resolution.body.trim()) imported.push(resolution.body);
    }

    const only = lineTokens.length === 1
      && line.slice(0, lineTokens[0]!.start).trim() === ''
      && line.slice(lineTokens[0]!.end).trim() === '';
    // A whole-line token whose import RESOLVED is replaced by the body it
    // names. One that resolved to NOTHING keeps its line — the composer's own
    // rule ("a token with no layer at all behind it is left exactly as
    // written") was stated and, for a bare `@path` on its own line, not true:
    // the line was dropped either way, so a file the walk never registered, a
    // user's Sources-level disable and an auto-memory TOPIC file all became
    // silence. Leaving the line is what makes the topic file readable on demand
    // (P6.387): "Claude reads them on demand using its standard file tools when
    // it needs the information" needs the model to know the name.
    if (!only || !resolvedAny) out.push(line);
    out.push(...imported);
  }

  return out.join('\n');
}
