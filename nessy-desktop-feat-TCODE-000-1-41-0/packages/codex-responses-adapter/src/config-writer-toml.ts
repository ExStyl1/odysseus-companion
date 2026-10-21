/**
 * The TOML escaper `config-writer.ts` and `config-writer-permissions.ts` share.
 *
 * P3.273 moved the `[permissions.*]` mapping and emission into a file of its
 * own so the credential floor and the rest of codex configuration are zonable
 * separately (a `git commit <pathspec>` takes the whole working-tree file, so a
 * SECTION of a file is not a zone). That emission needs this escaper, and the
 * only two ways to give it one without a module cycle are duplicating it —
 * which is exactly what its own docblock forbids — or lifting it here. Lifted,
 * unchanged, so both writers keep escaping identically.
 */

/**
 * Escape a string for a TOML basic (double-quoted) string.
 *
 * TOML 1.0.0 § *String* — "Any Unicode character may be used except those that
 * must be escaped: quotation mark, backslash, and the control characters other
 * than tab (U+0000 to U+0008, U+000A to U+001F, U+007F)." Escaping only `\` and
 * `"` was sufficient while every value here was a path, a model id or an enum
 * member; an agent's system prompt is neither, and a single newline in one
 * produces a file the app-server cannot parse AT ALL — i.e. a session that
 * fails to start, not a role that fails to load. The control-character arm is
 * the whole reason this is one shared escaper rather than a second one.
 */
export function tomlString(value: string): string {
  let escaped = '';
  for (const char of value) {
    switch (char) {
      case '\\': escaped += '\\\\'; break;
      case '"': escaped += '\\"'; break;
      case '\b': escaped += '\\b'; break;
      case '\t': escaped += '\\t'; break;
      case '\n': escaped += '\\n'; break;
      case '\f': escaped += '\\f'; break;
      case '\r': escaped += '\\r'; break;
      default: {
        const code = char.codePointAt(0)!;
        escaped += code <= 0x1f || code === 0x7f
          ? `\\u${code.toString(16).padStart(4, '0')}`
          : char;
      }
    }
  }
  return '"' + escaped + '"';
}
