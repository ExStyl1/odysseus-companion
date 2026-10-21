/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Advanced edit strategies for finding and applying text replacements.
 *
 * This module provides multiple fallback strategies for locating text in files:
 * 1. Exact match with various normalizations
 * 2. Loose block matching (ignoring trailing whitespace/indentation)
 * 3. Fuzzy matching with similarity thresholds
 * 4. Escape sequence handling
 * 5. File confusion detection
 */

import type { Content } from '@google/genai';
import { ToolNames } from '../tools/tool-names.js';

/* -------------------------------------------------------------------------- */
// Normalization Functions
/* -------------------------------------------------------------------------- */

export function normalizeEols(input: string): string {
  // Normalize CRLF and bare CR to LF
  return input.replace(/\r\n?/g, '\n');
}

export function unescapeLiteralNewlines(input: string): string {
  // Replace literal backslash-n with real LF (do not touch other escapes)
  return input.replace(/\\n/g, '\n');
}

function unescapeLiteralNewlinesOnce(input: string): string {
  return input
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

function unescapeDoubleEscapedNewlines(input: string): string {
  // Важно: порядок замен — сначала двойные, потом одинарные
  return input
    .replace(/\\\\n/g, '\n')
    .replace(/\\\\r/g, '\r')
    .replace(/\\\\t/g, '\t')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

function tryJsonUnquoteLiteral(input: string): string | null {
  // эвристика: много обратных слэшей или \uXXXX — похоже на JSON-литерал
  const isLikelyEscaped =
    /\\[nrt"\\]/.test(input) || /\\u[0-9a-fA-F]{4}/.test(input);
  if (!isLikelyEscaped) return null;
  try {
    // экранируем обратные слэши и кавычки, чтобы собрать валидную JSON-строку
    const escaped = input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return JSON.parse(`"${escaped}"`);
  } catch {
    return null;
  }
}

function normalizeIndentOnlyLines(input: string): string {
  // \n[пробелы/табуляция]+\n  ->  \n\n
  return input.replace(/\n[ \t]+\n/g, '\n\n');
}

/**
 * Generates multiple variants of a string for matching attempts.
 * Each variant applies different normalization strategies.
 */
export function makeVariants(s: string): string[] {
  // v1: как есть
  const v1 = s;

  // v2: нормализация EOL (CRLF/CR -> LF)
  const v2 = normalizeEols(v1);

  // v3: одинарные \n/\r/\t -> реальные переводы
  const v3 = unescapeLiteralNewlinesOnce(v2);

  // v4: двойные экранирования \\n/\\r/\\t -> реальные переводы
  const v4 = unescapeDoubleEscapedNewlines(v2);

  // v5: осторожный JSON-unquote (только если это действительно похоже на экранированный блок)
  const v5maybe = tryJsonUnquoteLiteral(v2);
  const v5 = v5maybe ?? v4; // если не получилось — просто повтор v4 (дедуп фильтранёт)
  // v6: нормализация пустых строк из пробелов
  const v6 = normalizeIndentOnlyLines(v2);

  // v7: normalized + trailing newline
  const v7 = v2.endsWith('\n') ? v2 : v2 + '\n';

  // v8: unescaped + trailing newline
  const v8 = v3.endsWith('\n') ? v3 : v3 + '\n';

  // Дедуп с сохранением порядка
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of [v1, v2, v3, v4, v5, v6, v7, v8]) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
// Escape Sequence Handling
/* -------------------------------------------------------------------------- */

/**
 * Expand escape sequences (\n, \r, \t) with position mapping
 * back to the original string. Double-escaped (\\) collapses to single \.
 */
export function expandEscapeSequences(content: string): {
  expanded: string;
  posMap: number[];
} {
  const chars: string[] = [];
  const posMap: number[] = [];
  let i = 0;
  while (i < content.length) {
    if (content[i] === '\\' && i + 1 < content.length) {
      const next = content[i + 1];
      if (next === '\\') {
        chars.push('\\');
        posMap.push(i);
        i += 2;
      } else if ('nrt'.includes(next)) {
        chars.push(next === 'n' ? '\n' : next === 'r' ? '\r' : '\t');
        posMap.push(i);
        i += 2;
      } else {
        chars.push(content[i]);
        posMap.push(i);
        i += 1;
      }
    } else {
      chars.push(content[i]);
      posMap.push(i);
      i += 1;
    }
  }
  posMap.push(i); // sentinel
  return { expanded: chars.join(''), posMap };
}

/**
 * Find pattern in content by expanding escape sequences in content.
 * Returns original (non-expanded) positions if match found.
 */
export function findMatchWithExpandedEscapes(
  currentContent: string,
  pattern: string,
): { start: number; end: number } | null {
  const { expanded, posMap } = expandEscapeSequences(currentContent);
  if (expanded === currentContent) return null; // no escapes expanded
  const pos = expanded.indexOf(pattern);
  if (pos === -1) return null;
  return { start: posMap[pos], end: posMap[pos + pattern.length] };
}

/**
 * Convert new_string using escape mapping: preserve original escape sequences
 * in unchanged portions, apply model's changes only to the modified part.
 */
export function convertNewStringViaEscapeMapping(
  realOld: string,
  modelOld: string,
  modelNew: string,
): string {
  const { posMap } = expandEscapeSequences(realOld);
  // Find common prefix and suffix between modelOld and modelNew
  let pre = 0;
  while (
    pre < modelOld.length &&
    pre < modelNew.length &&
    modelOld[pre] === modelNew[pre]
  )
    pre++;
  let suf = 0;
  while (
    suf < modelOld.length - pre &&
    suf < modelNew.length - pre &&
    modelOld[modelOld.length - 1 - suf] === modelNew[modelNew.length - 1 - suf]
  )
    suf++;

  // Map expanded positions back to original
  const origPrefixEnd = posMap[pre];
  const origSuffixStart = posMap[modelOld.length - suf];
  const modelChanged = modelNew.slice(pre, modelNew.length - suf);

  return (
    realOld.slice(0, origPrefixEnd) +
    modelChanged +
    realOld.slice(origSuffixStart)
  );
}

/* -------------------------------------------------------------------------- */
// Loose Block Matching
/* -------------------------------------------------------------------------- */

/**
 * Finds a block match allowing differences in trailing whitespace on each line.
 * Empty lines in pattern match empty or whitespace-only lines in content.
 */
export function findLooseBlockMatch(
  currentContent: string,
  pattern: string,
): { start: number; end: number } | null {
  const cur = normalizeEols(currentContent);
  const pat = normalizeEols(pattern);

  const curLines = cur.split('\n');
  const patLines = pat.split('\n');

  if (patLines.length === 0) return null;

  // Предварительно посчитаем смещения начала каждой строки в cur
  const lineOffsets: number[] = new Array(curLines.length);
  let offset = 0;
  for (let i = 0; i < curLines.length; i++) {
    lineOffsets[i] = offset;
    offset += curLines[i].length;
    if (i < curLines.length - 1) offset += 1; // '\n'
  }

  outer: for (let i = 0; i + patLines.length <= curLines.length; i++) {
    for (let j = 0; j < patLines.length; j++) {
      const patLine = patLines[j].replace(/[ \t]+$/g, '');
      const curLine = curLines[i + j].replace(/[ \t]+$/g, '');

      const patEmpty = patLine === '';

      if (patEmpty) {
        // В old_string строка пустая → в файле допускаем пустую или только пробелы/табы
        if (!/^[ \t]*$/.test(curLines[i + j])) {
          continue outer;
        }
      } else {
        // Непустые строки должны совпасть (без trailing spaces)
        if (patLine !== curLine) {
          continue outer;
        }
      }
    }

    // Совпадение найдено, считаем индекс начала/конца в исходной строке
    const start = lineOffsets[i];
    const lastLineIndex = i + patLines.length - 1;
    const end =
      lineOffsets[lastLineIndex] +
      curLines[lastLineIndex].length +
      (lastLineIndex < curLines.length - 1 ? 1 : 0); // включаем завершающий \n, если он есть

    return { start, end };
  }

  return null;
}

/**
 * Finds a block match ignoring indentation differences.
 * Compares trimmed lines only.
 */
export function findLooseBlockMatchIgnoreIndent(
  currentContent: string,
  pattern: string,
): { start: number; end: number } | null {
  const cur = normalizeEols(currentContent);
  const pat = normalizeEols(pattern);

  const curLines = cur.split('\n');
  const patLines = pat.split('\n');

  if (patLines.length === 0) return null;

  const lineOffsets: number[] = new Array(curLines.length);
  let offset = 0;
  for (let i = 0; i < curLines.length; i++) {
    lineOffsets[i] = offset;
    offset += curLines[i].length;
    if (i < curLines.length - 1) offset += 1;
  }

  outer: for (let i = 0; i + patLines.length <= curLines.length; i++) {
    for (let j = 0; j < patLines.length; j++) {
      const patLine = patLines[j].trim();
      const curLine = curLines[i + j].trim();

      const patEmpty = patLine === '';
      if (patEmpty) {
        if (!/^[ \t]*$/.test(curLines[i + j])) continue outer;
      } else if (patLine !== curLine) {
        continue outer;
      }
    }

    const start = lineOffsets[i];
    const lastLineIndex = i + patLines.length - 1;
    const end =
      lineOffsets[lastLineIndex] +
      curLines[lastLineIndex].length +
      (lastLineIndex < curLines.length - 1 ? 1 : 0);

    return { start, end };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
// Blank Line Tolerant Matching
/* -------------------------------------------------------------------------- */

/**
 * Finds a block match by comparing only significant (non-blank) lines,
 * skipping blank/whitespace-only lines in both pattern and content.
 * Handles cases where the model adds or removes blank lines.
 * Requires at least 3 significant lines for safety.
 */
export function findBlockMatchIgnoringExtraBlanks(
  currentContent: string,
  pattern: string,
): { start: number; end: number } | null {
  const cur = normalizeEols(currentContent);
  const pat = normalizeEols(pattern);

  const curLines = cur.split('\n');
  const patLines = pat.split('\n');

  // Extract significant (non-blank) lines from pattern, trimmed trailing whitespace
  const sigPatLines = patLines
    .filter((l) => l.trim() !== '')
    .map((l) => l.replace(/[ \t]+$/, ''));

  if (sigPatLines.length < 3) return null; // too few lines for safe matching

  // Check that blank lines actually differ — if same structure, earlier strategies handle it
  const patHasBlanks = patLines.some((l) => l.trim() === '');
  const patTotalCount = patLines.length;

  // Build line offsets for content
  const lineOffsets: number[] = new Array(curLines.length);
  let offset = 0;
  for (let i = 0; i < curLines.length; i++) {
    lineOffsets[i] = offset;
    offset += curLines[i].length;
    if (i < curLines.length - 1) offset += 1;
  }

  // Try each starting position in content
  for (let startI = 0; startI < curLines.length; startI++) {
    let patIdx = 0;
    let curI = startI;
    let firstMatchedI = -1;
    let lastMatchedI = -1;

    while (patIdx < sigPatLines.length && curI < curLines.length) {
      const curLine = curLines[curI].replace(/[ \t]+$/, '');

      if (curLine.trim() === '') {
        // Skip blank lines in content
        curI++;
        continue;
      }

      if (curLine === sigPatLines[patIdx]) {
        if (firstMatchedI === -1) firstMatchedI = curI;
        lastMatchedI = curI;
        patIdx++;
        curI++;
      } else {
        break; // mismatch — try next start position
      }
    }

    if (patIdx === sigPatLines.length && firstMatchedI >= 0) {
      // All significant lines matched.
      // Verify that blank line structure actually differs (otherwise earlier strategies suffice).
      const matchedLineCount = lastMatchedI - startI + 1;
      if (matchedLineCount === patTotalCount && !patHasBlanks) {
        // Same structure — skip, let other strategies handle it
        continue;
      }

      const start = lineOffsets[startI];
      const end =
        lineOffsets[lastMatchedI] +
        curLines[lastMatchedI].length +
        (lastMatchedI < curLines.length - 1 ? 1 : 0);

      return { start, end };
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
// Aggressive Normalization Matching
/* -------------------------------------------------------------------------- */

/**
 * Applies all normalizations to a string: unescape double-escaped JSON sequences,
 * normalize EOL, then split into significant trimmed lines.
 *
 * Handles the common model failure where JSON output has mixed escaping:
 * \\n → \n (literal) and \\\" → \" (literal) after one JSON parse level.
 */
function aggressiveNormalizeToLines(input: string): string[] {
  // 1. Unescape double-escaped JSON: \" → ", \\ → \, \n → newline, \r → CR, \t → tab
  //    Order matters: \\ first (so \\n doesn't become \<newline>), then the rest
  let s = input
    .replace(/\\\\/g, '\x00ESCAPED_BACKSLASH\x00') // placeholder for real \\
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\x00ESCAPED_BACKSLASH\x00/g, '\\'); // restore single backslash
  // 2. Normalize EOL
  s = normalizeEols(s);
  // 3. Split into lines, keep only significant (non-blank), trim all whitespace
  return s
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => l.trim());
}

/**
 * Finds a block match by aggressively normalizing both pattern and content:
 * unescapes literal \n sequences, ignores indentation, and skips blank lines.
 *
 * This handles the case where the model produces JSON with mixed \\n and \n
 * escaping combined with indentation differences and extra blank lines.
 *
 * Requires at least 5 significant lines for safety (very aggressive normalization).
 */
export function findBlockMatchAggressiveNormalization(
  currentContent: string,
  pattern: string,
): { start: number; end: number } | null {
  const cur = normalizeEols(currentContent);
  const curLines = cur.split('\n');

  const sigPatLines = aggressiveNormalizeToLines(pattern);

  if (sigPatLines.length < 5) return null; // require more lines due to aggressive matching

  // Pre-compute trimmed content lines for matching
  const curTrimmed = curLines.map((l) => l.trim());

  // Build line offsets for content
  const lineOffsets: number[] = new Array(curLines.length);
  let offset = 0;
  for (let i = 0; i < curLines.length; i++) {
    lineOffsets[i] = offset;
    offset += curLines[i].length;
    if (i < curLines.length - 1) offset += 1;
  }

  // Try each starting position in content
  for (let startI = 0; startI < curLines.length; startI++) {
    let patIdx = 0;
    let curI = startI;
    let firstMatchedI = -1;
    let lastMatchedI = -1;

    while (patIdx < sigPatLines.length && curI < curLines.length) {
      if (curTrimmed[curI] === '') {
        // Skip blank lines in content
        curI++;
        continue;
      }

      if (curTrimmed[curI] === sigPatLines[patIdx]) {
        if (firstMatchedI === -1) firstMatchedI = curI;
        lastMatchedI = curI;
        patIdx++;
        curI++;
      } else {
        break;
      }
    }

    if (patIdx === sigPatLines.length && firstMatchedI >= 0) {
      const start = lineOffsets[firstMatchedI];
      const end =
        lineOffsets[lastMatchedI] +
        curLines[lastMatchedI].length +
        (lastMatchedI < curLines.length - 1 ? 1 : 0);

      return { start, end };
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
// Fuzzy Matching
/* -------------------------------------------------------------------------- */

/**
 * Calculates the Levenshtein distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Use two rows instead of full matrix for memory efficiency
  let prevRow = new Array(b.length + 1);
  let currRow = new Array(b.length + 1);

  for (let j = 0; j <= b.length; j++) {
    prevRow[j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    currRow[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        prevRow[j] + 1, // deletion
        currRow[j - 1] + 1, // insertion
        prevRow[j - 1] + cost, // substitution
      );
    }
    [prevRow, currRow] = [currRow, prevRow];
  }

  return prevRow[b.length];
}

/**
 * Calculates similarity ratio between two strings (0 to 1, where 1 is identical).
 */
export function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const maxLen = Math.max(a.length, b.length);
  const distance = levenshteinDistance(a, b);
  return 1 - distance / maxLen;
}

/**
 * Finds a fuzzy block match in the content when exact matching fails.
 * Returns the best matching block if similarity is above threshold.
 */
export function findFuzzyBlockMatch(
  currentContent: string,
  pattern: string,
  similarityThreshold = 0.85,
): {
  start: number;
  end: number;
  similarity: number;
  matchedText: string;
} | null {
  const cur = normalizeEols(currentContent);
  const pat = normalizeEols(pattern);

  const curLines = cur.split('\n');
  const patLines = pat.split('\n');

  if (patLines.length === 0 || patLines.length > curLines.length) return null;

  // Build line offsets
  const lineOffsets: number[] = new Array(curLines.length);
  let offset = 0;
  for (let i = 0; i < curLines.length; i++) {
    lineOffsets[i] = offset;
    offset += curLines[i].length;
    if (i < curLines.length - 1) offset += 1;
  }

  let bestMatch: {
    start: number;
    end: number;
    similarity: number;
    matchedText: string;
  } | null = null;

  // Slide window over content
  for (let i = 0; i + patLines.length <= curLines.length; i++) {
    const windowLines = curLines.slice(i, i + patLines.length);
    const windowText = windowLines.join('\n');
    const patText = patLines.join('\n');

    // Quick pre-check: first and last lines should be somewhat similar
    const firstLineSim = stringSimilarity(
      windowLines[0].trim(),
      patLines[0].trim(),
    );
    const lastLineSim = stringSimilarity(
      windowLines[windowLines.length - 1].trim(),
      patLines[patLines.length - 1].trim(),
    );

    // Skip if first/last lines are too different
    if (firstLineSim < 0.5 || lastLineSim < 0.5) continue;

    const similarity = stringSimilarity(windowText, patText);

    if (
      similarity >= similarityThreshold &&
      (!bestMatch || similarity > bestMatch.similarity)
    ) {
      const start = lineOffsets[i];
      const lastLineIndex = i + patLines.length - 1;
      const end =
        lineOffsets[lastLineIndex] +
        curLines[lastLineIndex].length +
        (lastLineIndex < curLines.length - 1 ? 1 : 0);

      bestMatch = {
        start,
        end,
        similarity,
        matchedText: windowText,
      };
    }
  }

  return bestMatch;
}

/* -------------------------------------------------------------------------- */
// File Confusion Detection
/* -------------------------------------------------------------------------- */

interface RecentReadFile {
  filePath: string;
  content: string;
}

/**
 * Extracts recently read files from chat history.
 */
export function extractRecentReadFiles(history: Content[]): RecentReadFile[] {
  const results: RecentReadFile[] = [];
  const seenPaths = new Set<string>();

  // Iterate backwards to get most recent first
  for (let i = history.length - 1; i >= 0; i--) {
    const content = history[i];

    // Look for functionCall in model messages to get file path
    if (content.role === 'model' && content.parts) {
      for (const part of content.parts) {
        if (part.functionCall?.name === 'read_file') {
          const args = part.functionCall.args as
            | Record<string, unknown>
            | undefined;
          const filePath = (args?.['absolute_path'] ?? args?.['file_path']) as
            | string
            | undefined;
          const callId = part.functionCall.id;

          if (!filePath || seenPaths.has(filePath)) continue;

          // Find corresponding response in next user message
          if (i + 1 < history.length && history[i + 1].role === 'user') {
            for (const responsePart of history[i + 1].parts || []) {
              if (responsePart.functionResponse?.name === 'read_file') {
                // Match by id if available, otherwise assume it's the right response
                const responseId = responsePart.functionResponse?.id;
                if (callId && responseId && callId !== responseId) continue;

                const response = responsePart.functionResponse?.response as
                  | Record<string, unknown>
                  | undefined;
                const text = (response?.['text'] ??
                  response?.['llmContent'] ??
                  '') as string;
                if (text) {
                  results.push({ filePath, content: text });
                  seenPaths.add(filePath);
                }
                break;
              }
            }
          }
        }
      }
    }

    // Limit to last 5 unique files
    if (results.length >= 5) break;
  }

  return results;
}

/**
 * Searches for a pattern in recently read files.
 * Returns the file path if found in exactly one file (unambiguous).
 */
export function searchInRecentReads(
  pattern: string,
  recentReads: RecentReadFile[],
  excludePath: string,
): string | null {
  if (!pattern || pattern.length < 10) return null;

  const found: string[] = [];
  const normalizedPattern = normalizeEols(pattern);

  for (const { filePath, content } of recentReads) {
    if (filePath === excludePath) continue;
    if (normalizeEols(content).includes(normalizedPattern)) {
      found.push(filePath);
    }
  }

  // Only suggest if found in exactly ONE file (unambiguous)
  return found.length === 1 ? found[0] : null;
}

/* -------------------------------------------------------------------------- */
// Line Context Helpers
/* -------------------------------------------------------------------------- */

function buildLineOffsets(content: string): number[] {
  const offsets: number[] = [];
  const lines = content.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets.push(offset);
    offset += lines[i].length + 1; // +1 for '\n'
  }
  return offsets;
}

function indexToLine(offsets: number[], index: number): number {
  let line = 0;
  while (line + 1 < offsets.length && offsets[line + 1] <= index) {
    line++;
  }
  return line;
}

/**
 * Collects line contexts around matches for error messages.
 */
export function collectLineContexts(
  content: string,
  needle: string,
  maxContexts = 3,
  radius = 2,
): string[] {
  if (!needle) return [];
  const contexts: string[] = [];
  const lines = content.split('\n');
  const offsets = buildLineOffsets(content);

  let idx = content.indexOf(needle);
  while (idx !== -1 && contexts.length < maxContexts) {
    const line = indexToLine(offsets, idx);
    const from = Math.max(0, line - radius);
    const to = Math.min(lines.length - 1, line + radius);
    const snippet = lines.slice(from, to + 1).join('\n');
    contexts.push(`L${from + 1}-${to + 1}: ${snippet}`);
    idx = content.indexOf(needle, idx + Math.max(needle.length, 1));
  }

  return contexts;
}

/**
 * Extracts a probe line from old_string for diagnostic purposes.
 */
export function probeLine(oldString: string): string | null {
  for (const line of oldString.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length >= 3) {
      return trimmed;
    }
  }
  return null;
}

/**
 * Extracts a snippet of the file around where the pattern would match.
 */
export function extractFileSnippetAroundPattern(
  content: string,
  pattern: string,
  contextLines: number = 3,
  maxSnippetLength: number = 500,
): string | null {
  if (!content || !pattern) return null;

  const lines = content.split('\n');
  const patternLines = pattern.split('\n');
  const firstPatternLine = patternLines[0]?.trim();

  if (!firstPatternLine || firstPatternLine.length < 3) return null;

  // Find line containing the first line of the pattern
  let matchLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (
      lines[i].includes(firstPatternLine) ||
      lines[i].trim() === firstPatternLine
    ) {
      matchLineIndex = i;
      break;
    }
  }

  if (matchLineIndex === -1) {
    // Try to find a partial match with any significant line
    for (const patLine of patternLines) {
      const trimmedPat = patLine.trim();
      if (trimmedPat.length < 5) continue;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(trimmedPat)) {
          matchLineIndex = i;
          break;
        }
      }
      if (matchLineIndex !== -1) break;
    }
  }

  if (matchLineIndex === -1) return null;

  const startLine = Math.max(0, matchLineIndex - contextLines);
  const endLine = Math.min(
    lines.length - 1,
    matchLineIndex + patternLines.length + contextLines,
  );

  const snippetLines: string[] = [];
  for (let i = startLine; i <= endLine; i++) {
    const lineNum = i + 1; // 1-based line numbers
    snippetLines.push(`${lineNum}: ${lines[i]}`);
  }

  let snippet = snippetLines.join('\n');
  if (snippet.length > maxSnippetLength) {
    snippet = snippet.substring(0, maxSnippetLength) + '\n... (truncated)';
  }

  return snippet;
}

/* -------------------------------------------------------------------------- */
// No-op Diagnostics
/* -------------------------------------------------------------------------- */

export interface NoopDiagnostics {
  reason: 'json_escaping' | 'already_correct' | 'whitespace_only' | 'unknown';
  explanation: string;
  fileSnippet: string | null;
  suggestions: string[];
  technicalDetails: string;
}

function detectJsonEscapingConfusion(
  parsedOldString: string,
  parsedNewString: string,
): boolean {
  // If they're identical and contain backslashes, it's likely JSON escaping confusion
  if (parsedOldString === parsedNewString && parsedOldString.includes('\\')) {
    return true;
  }

  // Check for patterns that commonly cause confusion: regex, paths, escape sequences
  const escapablePatterns = [
    /\\[nrtbfv0]/, // Common escape sequences
    /\\[dDwWsSbB]/, // Regex character classes
    /\\\./, // Escaped dots (common in regex)
    /\\\//, // Escaped slashes
    /\\\\/, // Escaped backslashes
    /r['"][^'"]*\\/, // Python raw strings with backslashes
  ];

  return escapablePatterns.some((p) => p.test(parsedOldString));
}

/**
 * Diagnoses why a no-op edit occurred.
 */
export function diagnoseNoopEdit(
  parsedOldString: string,
  parsedNewString: string,
  currentContent: string | null,
  filePath: string,
): NoopDiagnostics {
  const isJsonEscaping = detectJsonEscapingConfusion(
    parsedOldString,
    parsedNewString,
  );
  const fileSnippet = currentContent
    ? extractFileSnippetAroundPattern(currentContent, parsedOldString)
    : null;

  // Determine if this is whitespace-only difference in the original intent
  const oldTrimmed = parsedOldString.replace(/\s+/g, '');
  const newTrimmed = parsedNewString.replace(/\s+/g, '');
  const isWhitespaceOnly =
    oldTrimmed === newTrimmed && parsedOldString !== parsedNewString;

  let reason: NoopDiagnostics['reason'] = 'unknown';
  let explanation: string;
  let suggestions: string[];
  let technicalDetails: string;

  if (isJsonEscaping) {
    reason = 'json_escaping';
    explanation =
      'Your old_string and new_string are IDENTICAL after JSON parsing. ' +
      'The file already contains exactly what you specified. ' +
      'This typically happens when you try to change backslash escaping, ' +
      'but JSON parsing normalizes both values to the same string.';

    suggestions = [
      'Use ReadFile to see the ACTUAL file content first',
      'Remember: In JSON, \\\\ represents a single \\',
      'To ADD a backslash to the file, use 4 backslashes (\\\\\\\\) in JSON',
      'If the file content is already correct, do NOT call Edit',
      'Compare what you see in ReadFile output with your old_string',
    ];

    // Show what the parsed string actually looks like
    const displayString =
      parsedOldString.length > 100
        ? parsedOldString.substring(0, 100) + '...'
        : parsedOldString;
    technicalDetails =
      `After JSON parsing, both strings equal: ${JSON.stringify(displayString)}\n` +
      `Contains backslashes: ${parsedOldString.includes('\\') ? 'YES' : 'no'}`;
  } else if (isWhitespaceOnly) {
    reason = 'whitespace_only';
    explanation =
      'Your old_string and new_string differ only in whitespace, ' +
      'but the actual content is the same. The edit would not change the file meaningfully.';

    suggestions = [
      'If you intended to change indentation, ensure both strings have correct whitespace',
      'Use ReadFile to copy the EXACT whitespace from the file',
      'If the content is already correct, do NOT call Edit',
    ];

    technicalDetails = `Non-whitespace content is identical in both strings`;
  } else if (currentContent?.includes(parsedNewString)) {
    reason = 'already_correct';
    explanation =
      'The file already contains exactly what you specified in new_string. ' +
      'The desired content is already present, so no edit is needed.';

    suggestions = [
      'Use ReadFile to verify the current file state',
      'The change you want may have already been applied',
      'Do NOT call Edit when the file already has the correct content',
    ];

    technicalDetails = `new_string found in file at the expected location`;
  } else {
    reason = 'unknown';
    explanation =
      'The old_string and new_string are identical, so there is nothing to change. ' +
      'This may be a copy-paste error or misunderstanding of the current file state.';

    suggestions = [
      'Use ReadFile to see the actual file content',
      'Ensure old_string differs from new_string',
      'Check for invisible characters or encoding issues',
    ];

    technicalDetails = `Both strings are identical (length: ${parsedOldString.length})`;
  }

  return {
    reason,
    explanation,
    fileSnippet,
    suggestions,
    technicalDetails,
  };
}

/**
 * Formats a no-op diagnostic into a helpful error message with STOP instructions.
 */
export function formatNoopDiagnosticMessage(
  diagnostics: NoopDiagnostics,
  filePath: string,
  parsedOldString: string,
  parsedNewString: string,
  _includeFileSnippet: boolean = true,
): { display: string; raw: string } {
  // Short display of strings (first line, max 80 chars)
  const shortOld = parsedOldString.split('\n')[0].substring(0, 80);
  const shortNew = parsedNewString.split('\n')[0].substring(0, 80);
  const oldEllipsis =
    parsedOldString.length > 80 || parsedOldString.includes('\n') ? '...' : '';
  const newEllipsis =
    parsedNewString.length > 80 || parsedNewString.includes('\n') ? '...' : '';

  const stopBanner = `
═══════════════════════════════════════════════════════════════
⛔ STOP - DO NOT CALL EDIT AGAIN FOR THIS FILE
═══════════════════════════════════════════════════════════════`;

  const comparison = `
WHAT YOU SENT (after JSON parsing):
  ${shortOld}${oldEllipsis}

WHAT FILE CONTAINS:
  ${shortNew}${newEllipsis}

↑ THESE ARE IDENTICAL ↑`;

  const nextStep = `
═══════════════════════════════════════════════════════════════
✅ NEXT STEP: Tell the user the file is already correct.
   Do NOT attempt another edit.
═══════════════════════════════════════════════════════════════`;

  // Short reason explanation
  const reasonExplanation = {
    json_escaping:
      'WHY: JSON escaping. Your JSON "\\\\." becomes "\\." after parsing.',
    already_correct:
      'WHY: The file already contains the exact content you want.',
    whitespace_only: 'WHY: Only whitespace differs, content is the same.',
    unknown: 'WHY: old_string and new_string are identical.',
  }[diagnostics.reason];

  const display = `${stopBanner}

THE FILE IS ALREADY CORRECT. Your edit request changes nothing.
${comparison}

${reasonExplanation}
${nextStep}`;

  const raw =
    `STOP_EDIT_LOOP: File ${filePath} is already correct. ` +
    `Reason: ${diagnostics.reason}. ` +
    `DO NOT call edit again. Tell user the file is correct.`;

  return { display, raw };
}

// Helpful hints
export const HINT_READFILE = ` Hint: Use the ${ToolNames.READ_FILE} tool to read the file. Then, copy the EXACT text (including all whitespace, indentation, and newlines) from the output to use as the 'old_string' in your edit request.`;

export const HINT_WRONG_FILE = (file: string) =>
  ` Hint: Did you mean to edit "${file}"? The content was found there.`;
