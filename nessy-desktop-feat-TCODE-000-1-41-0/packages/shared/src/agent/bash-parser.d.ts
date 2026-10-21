/**
 * Type declarations for bash-parser
 *
 * bash-parser is a JavaScript library for parsing bash scripts into an AST.
 * We define our own types in bash-validator.ts since the library doesn't ship types.
 *
 * @see https://github.com/vorpaljs/bash-parser
 */

declare module 'bash-parser' {
  /**
   * Parse a bash command string into an AST.
   *
   * The AST nodes are typed in bash-validator.ts as:
   * - Script: Top-level node containing commands array
   * - Command: Simple command with name and suffix (args)
   * - LogicalExpression: && (and) or || (or) chains
   * - Pipeline: Piped commands (|)
   * - Subshell: Commands in parentheses (...)
   * - CompoundList: List of commands in subshell or similar
   * - Redirect: File redirections (>, >>, <)
   * - Word: Text token with optional expansions
   *
   * @param command - The bash command string to parse
   * @param options - Parser options. `insertLOC` adds a `loc` span to every
   *   node, giving the offsets of the word in the ORIGINAL string — quote
   *   characters included, which is the only place a word's quoting survives
   *   (`text` is already unquoted). `bash-validator.ts` reads it in the
   *   isolation write-scan to tell a QUOTED regex metacharacter from a glob
   *   the shell will expand.
   * @returns AST root node (Script type)
   */
  function bashParser(command: string, options?: { insertLOC?: boolean }): unknown;
  export default bashParser;
}
