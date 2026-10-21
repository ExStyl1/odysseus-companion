// The backend's `replace_in_file` carries a plain-text `diff` of SEARCH/REPLACE blocks, not an
// old_string/new_string pair: the format, its markers and its rules are transcribed from the
// tool's own parameter description (`internal/usecase/vibe/agent/codeagent/tools.go:203-249`
// @ df526b7) — "The value must start directly with the SEARCH marker line", "To delete code:
// leave the REPLACE section empty", and the three "Wrong" cases (fenced value, prose before the
// first marker, prose after the last). The reference connector parses the same wire with a
// regex and answers malformed input with an instruction string rather than an error
// (`.references/nestor-assistant/nessy-acp-agent/src/tools/replace-in-file/local.ts:8-38`);
// this parser keeps that recovery text, on a scanner strict enough to notice the malformed
// shapes the regex would silently skip past.

export interface SearchReplaceEdit {
  oldText: string;
  newText: string;
}

const SEARCH_MARKER = '<<<<<<< SEARCH';
const SEPARATOR_MARKER = '=======';
const REPLACE_MARKER = '>>>>>>> REPLACE';

/** The tool's own guidance, echoed back so a rejected diff still tells the model how to retry. */
export function buildSearchReplaceFormatReminder(details: string): string {
  return [
    `replace_in_file failed: ${details}`,
    '',
    'Retry with a corrected plain-text diff.',
    '',
    'Rules:',
    '- The diff value must be plain text.',
    '- Do not wrap the diff in backticks or markdown fences.',
    '- The diff must start directly with "<<<<<<< SEARCH".',
    '- Use only this format:',
    '',
    SEARCH_MARKER,
    '[exact content to find]',
    SEPARATOR_MARKER,
    '[new content to replace with]',
    REPLACE_MARKER,
  ].join('\n');
}

export class SearchReplaceDiffError extends Error {
  readonly details: string;

  constructor(details: string) {
    super(buildSearchReplaceFormatReminder(details));
    this.name = 'SearchReplaceDiffError';
    this.details = details;
  }
}

interface LineSpan {
  start: number;
  end: number;
}

/**
 * Parse a `replace_in_file` diff into ordered edits. Markers are recognised as whole lines only,
 * so block content is taken verbatim — including its own line endings, which must keep matching
 * the file byte-for-byte. Throws `SearchReplaceDiffError` (whose message is the retry guidance)
 * on anything the backend's description calls wrong.
 */
export function parseSearchReplaceDiff(diff: string): SearchReplaceEdit[] {
  if (typeof diff !== 'string') throw new SearchReplaceDiffError('The diff must be plain text');

  const edits: SearchReplaceEdit[] = [];
  let state: 'outside' | 'search' | 'replace' = 'outside';
  let searchLines: LineSpan[] = [];
  let replaceLines: LineSpan[] = [];

  for (const line of splitLines(diff)) {
    const marker = markerOf(diff, line);

    if (state === 'outside') {
      if (marker === SEARCH_MARKER) {
        state = 'search';
        searchLines = [];
        replaceLines = [];
        continue;
      }
      if (isBlank(diff, line)) continue;
      throw new SearchReplaceDiffError(
        `Unexpected content outside a SEARCH/REPLACE block: ${quote(diff, line)}`,
      );
    }

    if (state === 'search') {
      if (marker === SEPARATOR_MARKER) {
        state = 'replace';
        continue;
      }
      if (marker === SEARCH_MARKER) {
        throw new SearchReplaceDiffError('A second "<<<<<<< SEARCH" marker opened before "======="');
      }
      if (marker === REPLACE_MARKER) {
        throw new SearchReplaceDiffError('A block reached ">>>>>>> REPLACE" without a "=======" separator');
      }
      searchLines.push(line);
      continue;
    }

    if (marker === REPLACE_MARKER) {
      edits.push(buildEdit(diff, searchLines, replaceLines));
      state = 'outside';
      continue;
    }
    if (marker === SEPARATOR_MARKER) {
      throw new SearchReplaceDiffError('A second "=======" separator appeared inside one block');
    }
    if (marker === SEARCH_MARKER) {
      throw new SearchReplaceDiffError('A new "<<<<<<< SEARCH" marker opened before ">>>>>>> REPLACE"');
    }
    replaceLines.push(line);
  }

  if (state === 'search') {
    throw new SearchReplaceDiffError('Unterminated block: no "=======" separator after "<<<<<<< SEARCH"');
  }
  if (state === 'replace') {
    throw new SearchReplaceDiffError('Unterminated block: no ">>>>>>> REPLACE" marker after "======="');
  }
  if (edits.length === 0) {
    throw new SearchReplaceDiffError('No valid SEARCH/REPLACE blocks found in diff');
  }

  return edits;
}

function buildEdit(diff: string, searchLines: LineSpan[], replaceLines: LineSpan[]): SearchReplaceEdit {
  const oldText = sliceContent(diff, searchLines);
  // An empty SEARCH section would anchor at offset 0 and silently prepend instead of replacing;
  // the tool's rules require enough context to make the match unique (tools.go:212-214).
  if (oldText.length === 0) {
    throw new SearchReplaceDiffError('The SEARCH section is empty — it must contain the exact content to find');
  }
  return { oldText, newText: sliceContent(diff, replaceLines) };
}

function sliceContent(diff: string, lines: LineSpan[]): string {
  if (lines.length === 0) return '';
  const text = diff.slice(lines[0]!.start, lines[lines.length - 1]!.end);
  // The last content line's trailing CR belongs to the CRLF terminator before the next marker.
  return text.endsWith('\r') ? text.slice(0, -1) : text;
}

function splitLines(text: string): LineSpan[] {
  const spans: LineSpan[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      spans.push({ start, end: index });
      start = index + 1;
    }
  }
  spans.push({ start, end: text.length });
  return spans;
}

// Trailing whitespace on a marker line carries no meaning and covers the CR of a CRLF diff.
function markerOf(diff: string, line: LineSpan): string {
  return diff.slice(line.start, line.end).replace(/\s+$/, '');
}

function isBlank(diff: string, line: LineSpan): boolean {
  return markerOf(diff, line).length === 0;
}

function quote(diff: string, line: LineSpan): string {
  const text = markerOf(diff, line);
  return JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}…` : text);
}
