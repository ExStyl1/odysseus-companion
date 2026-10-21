/**
 * Shared browser_tool command parsing.
 *
 * `splitBatchCommands` and `tokenizeCommand` moved here VERBATIM from
 * browser-tool-runtime.ts so the permission gate's read-only classifier
 * (browser-tool-names.ts) and the executor (browser-tool-runtime.ts) tokenize
 * one command string with the SAME parser. A second tokenizer would let a
 * quoting difference classify `"snapshot; click @e1"` differently in the two
 * places, which is the bypass — and importing browser-tool-runtime.ts from the
 * permission path would drag the whole Electron-facing runtime along, so the
 * parser lives in this dependency-free module instead.
 *
 * UB4.20 (v0.15.1, Apache-2.0): the quote rule landed HERE, in the shared
 * parser, not in the runtime — the classifier and the executor must see the
 * same rule or a plain-text apostrophe classifies split but runs raw (or the
 * reverse), which is exactly the desync this module exists to prevent.
 */

function decodeEscapes(input: string): string {
  return input.replace(/\\(.)/g, (_match, ch: string) => {
    if (ch === 'n') return '\n';
    if (ch === 't') return '\t';
    if (ch === 'r') return '\r';
    if (ch === '"') return '"';
    if (ch === "'") return "'";
    if (ch === '\\') return '\\';
    if (ch === ';') return ';';
    return `\\${ch}`;
  });
}

const UNCLOSED_QUOTE_ERROR = 'Parse error: unclosed quote in browser_tool command. '
  + 'An argument that starts with a quote must end with the same quote (escape inner quotes with \\, or use array mode).';

/**
 * Quote rule shared by splitBatchCommands and tokenizeCommand, so plain-text
 * apostrophes (`fill @e5 Don't do this`) stay literal:
 * - A quote at the start of a token (start of input, after whitespace or a `;`
 *   separator) opens a span that closes only at the same quote followed by
 *   whitespace, `;` or the end of input. The tokenizer strips these quotes.
 * - Any other quote is literal and kept. When the same quote recurs before the
 *   token ends, the span between still protects `;` from batch splitting, so
 *   unquoted selectors like `div[data-x='a;b']` survive.
 *
 * Returns the index of the closing quote, or -1: unclosed at a token start,
 * literal elsewhere.
 */
function findClosingQuote(input: string, openIndex: number, atTokenStart: boolean): number {
  const quote = input[openIndex];
  for (let i = openIndex + 1; i < input.length; i += 1) {
    const ch = input[i]!;
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (!atTokenStart && /\s/.test(ch)) return -1;
    if (ch !== quote) continue;
    if (!atTokenStart) return i;
    const next = input[i + 1];
    if (next === undefined || next === ';' || /\s/.test(next)) return i;
  }
  return -1;
}

export function splitBatchCommands(input: string): string[] {
  const commands: string[] = [];
  let current = '';
  let atTokenStart = true;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;

    if (ch === '\\') {
      // Keep escapes verbatim; tokenizeCommand decodes them.
      current += input.slice(i, i + 2);
      i += 1;
      atTokenStart = false;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const close = findClosingQuote(input, i, atTokenStart);
      if (close === -1 && atTokenStart) throw new Error(UNCLOSED_QUOTE_ERROR);
      const end = close === -1 ? i : close;
      current += input.slice(i, end + 1);
      i = end;
      atTokenStart = false;
      continue;
    }

    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed.length > 0) commands.push(trimmed);
      current = '';
      atTokenStart = true;
      continue;
    }

    current += ch;
    atTokenStart = /\s/.test(ch);
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) commands.push(trimmed);
  return commands;
}

export function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let tokenStarted = false;

  const pushCurrent = () => {
    if (!tokenStarted) return;
    tokens.push(decodeEscapes(current));
    current = '';
    tokenStarted = false;
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;

    if (ch === '\\') {
      // Keep the escape pair; decodeEscapes resolves it when the token ends.
      current += input.slice(i, i + 2);
      i += 1;
      tokenStarted = true;
      continue;
    }

    if (ch === '"' || ch === "'") {
      if (tokenStarted) {
        // Mid-token quotes are literal (their `;` protection only matters when splitting).
        current += ch;
        continue;
      }
      const close = findClosingQuote(input, i, true);
      if (close === -1) throw new Error(UNCLOSED_QUOTE_ERROR);
      current += input.slice(i + 1, close);
      i = close;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }

    current += ch;
    tokenStarted = true;
  }

  pushCurrent();
  return tokens;
}
