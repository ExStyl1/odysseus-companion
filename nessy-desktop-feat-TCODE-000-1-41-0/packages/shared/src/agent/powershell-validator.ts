/**
 * PowerShell Command Validator
 *
 * Uses PowerShell's native System.Management.Automation.Language.Parser to create
 * a proper AST and validate commands against the read-only allowlist (Plan, Don't ask). This mirrors the approach
 * used by bash-validator.ts but for PowerShell syntax.
 *
 * AST Node Types (from PowerShell):
 * - ScriptBlockAst: Root node
 * - PipelineAst: Pipeline of commands
 * - CommandAst: Simple command with elements
 * - CommandExpressionAst: Expression used as command
 * - SubExpressionAst: $(...) substitution
 * - ScriptBlockExpressionAst: { ... } script blocks
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join, win32 } from 'path';
import { fileURLToPath } from 'url';
import { debug } from '../utils/debug.ts';
import type { CompiledBashPattern } from './mode-types.ts';

// ============================================================
// Module Root (set at Electron startup)
// ============================================================

/** The parser script this validator spawns. */
const PARSER_SCRIPT_NAME = 'powershell-parser.ps1';

/**
 * Module-level root directory for the PowerShell parser script.
 * Set once at Electron startup via setPowerShellValidatorRoot(__dirname).
 */
let _validatorRoot: string | undefined;

/**
 * The directory THIS module was loaded from, when that is knowable.
 *
 * Measured, and the reason every access below is guarded: esbuild rewrites
 * `import.meta` to `{}` for `--format=cjs`, which is how `apps/electron`
 * bundles the main process (`build:main`), so `import.meta.url` is `undefined`
 * there. That host registers an explicit root at startup and never needs this.
 */
const MODULE_DIR: string | undefined = (() => {
  const url = (import.meta as { url?: string } | undefined)?.url;
  if (typeof url !== 'string' || !url.startsWith('file:')) return undefined;
  try {
    return dirname(fileURLToPath(url));
  } catch {
    return undefined;
  }
})();

/**
 * Register the directory containing the PowerShell parser script.
 * Call this once at app startup: setPowerShellValidatorRoot(join(__dirname, 'resources'))
 *
 * After this, the validator will look for powershell-parser.ps1 in this directory
 * AND NOWHERE ELSE — see resolveParserScriptPath. Pass `undefined` to clear the
 * registration (a test seam; production callers always pass a directory).
 */
export function setPowerShellValidatorRoot(dir: string | undefined): void {
  _validatorRoot = dir;
  parserScriptMissingWarned = false;
  debug('[PowerShellValidator] Root set to:', dir);
}

/**
 * The root registered at startup, if any. Mirrors `getBundledAssetsRoot` in
 * `utils/paths.ts`; exists so a caller (or a test) can save and restore it.
 */
export function getPowerShellValidatorRoot(): string | undefined {
  return _validatorRoot;
}

// ============================================================
// Types
// ============================================================

/**
 * Result of validating a PowerShell command AST.
 */
export interface PowerShellValidationResult {
  allowed: boolean;
  /** Primary reason for rejection (if not allowed) */
  reason?: PowerShellValidationReason;
  /** Individual results for compound commands */
  subcommandResults?: SubcommandResult[];
}

export interface SubcommandResult {
  command: string;
  allowed: boolean;
  reason?: string;
}

export type PowerShellValidationReason =
  | { type: 'pipeline'; explanation: string }
  | { type: 'redirect'; target: string; explanation: string }
  | { type: 'subexpression'; explanation: string }
  | { type: 'script_block'; explanation: string }
  | { type: 'invoke_expression'; explanation: string }
  | { type: 'dot_sourcing'; explanation: string }
  | { type: 'unsafe_command'; command: string; explanation: string }
  | { type: 'parse_error'; error: string }
  | { type: 'background_execution'; explanation: string }
  | { type: 'assignment'; explanation: string }
  | { type: 'powershell_unavailable'; explanation: string };

// ============================================================
// AST Node Types (from PowerShell parser output)
// ============================================================

interface ASTNode {
  Type: string;
  Text: string;
}

interface ScriptBlockAst extends ASTNode {
  Type: 'ScriptBlockAst';
  BeginBlock?: NamedBlockAst;
  ProcessBlock?: NamedBlockAst;
  EndBlock?: NamedBlockAst;
}

interface NamedBlockAst extends ASTNode {
  Type: 'NamedBlockAst';
  Statements: ASTNode[];
  Unnamed: boolean;
}

interface PipelineAst extends ASTNode {
  Type: 'PipelineAst';
  PipelineElements: ASTNode[];
  Background: boolean;
}

interface CommandAst extends ASTNode {
  Type: 'CommandAst';
  CommandElements: ASTNode[];
  Redirections: ASTNode[];
  InvocationOperator: string;
}

interface CommandExpressionAst extends ASTNode {
  Type: 'CommandExpressionAst';
  Expression: ASTNode;
}

interface StringConstantExpressionAst extends ASTNode {
  Type: 'StringConstantExpressionAst';
  Value: string;
  StringConstantType: string;
}

interface VariableExpressionAst extends ASTNode {
  Type: 'VariableExpressionAst';
  VariablePath: string;
  Splatted: boolean;
}

interface SubExpressionAst extends ASTNode {
  Type: 'SubExpressionAst';
  SubExpression: ASTNode;
}

interface ScriptBlockExpressionAst extends ASTNode {
  Type: 'ScriptBlockExpressionAst';
  ScriptBlock: ASTNode;
}

interface FileRedirectionAst extends ASTNode {
  Type: 'FileRedirectionAst';
  Location: ASTNode;
  Append: boolean;
  FromStream: string;
}

interface AssignmentStatementAst extends ASTNode {
  Type: 'AssignmentStatementAst';
  Left: ASTNode;
  Right: ASTNode;
  Operator: string;
}

interface ExpandableStringExpressionAst extends ASTNode {
  Type: 'ExpandableStringExpressionAst';
  Value: string;
  NestedExpressions: ASTNode[];
}

interface CommandParameterAst extends ASTNode {
  Type: 'CommandParameterAst';
  ParameterName: string;
  Argument?: ASTNode;
}

interface InvokeMemberExpressionAst extends ASTNode {
  Type: 'InvokeMemberExpressionAst';
  Expression: ASTNode;
  Member: ASTNode;
  Arguments: ASTNode[];
  Static: boolean;
}

interface ParseResult {
  success: boolean;
  ast?: ScriptBlockAst;
  parseErrors?: Array<{ Message: string; Text: string; ErrorId: string }>;
  error?: string;
}

// ============================================================
// Dangerous Cmdlets and Patterns
// ============================================================

/**
 * Cmdlets that are dangerous because they write to the filesystem or execute code.
 */
const DANGEROUS_CMDLETS = new Set([
  // File writing
  'out-file',
  'set-content',
  'add-content',
  'new-item',
  'copy-item',
  'move-item',
  'remove-item',
  'rename-item',
  'clear-content',

  // Code execution
  'invoke-expression',
  'iex',
  'invoke-command',
  'icm',
  'start-process',
  'start',
  'saps',

  // Script execution
  'invoke-item',
  'ii',

  // Downloading with output
  'invoke-webrequest',
  'iwr',
  'invoke-restmethod',
  'irm',

  // Registry modification
  'set-itemproperty',
  'new-itemproperty',
  'remove-itemproperty',

  // Service/process modification
  'stop-process',
  'kill',
  'stop-service',
  'start-service',
  'restart-service',
  'set-service',

  // Dangerous aliases
  'del',
  'rd',
  'rm',
  'rmdir',
  'erase',
  'ri',
  'mi',
  'ni',
  'sp',
]);

/**
 * Check if a cmdlet name is inherently dangerous.
 */
function isDangerousCmdlet(cmdlet: string): boolean {
  return DANGEROUS_CMDLETS.has(cmdlet.toLowerCase());
}

// ============================================================
// PowerShell Process Management
// ============================================================

let powershellAvailable: boolean | null = null;
let powershellPath: string | null = null;

/**
 * Check if PowerShell (pwsh) is available on this system.
 * Uses synchronous check for compatibility with existing validation flow.
 */
export function isPowerShellAvailable(): boolean {
  if (powershellAvailable !== null) {
    return powershellAvailable;
  }

  // Try pwsh first (PowerShell Core - cross-platform), then Windows PowerShell by name
  const candidates: string[] = ['pwsh', 'powershell'];

  // On Windows, also try the full path to powershell.exe as a fallback.
  // Spawned subprocesses (e.g. from Electron) may not inherit the full system
  // PATH, so 'powershell' by name can fail even though it's always installed.
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
    candidates.push(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  }

  for (const cmd of candidates) {
    try {
      const result = spawnSync(cmd, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
        encoding: 'utf8',
        shell: true,
      });

      if (result.status === 0) {
        powershellPath = cmd;
        powershellAvailable = true;
        debug('[PowerShellValidator] Found PowerShell:', powershellPath);
        return true;
      }
    } catch {
      // Try next option
    }
  }

  powershellAvailable = false;
  debug('[PowerShellValidator] PowerShell not available');
  return false;
}

/**
 * The error `parseCommand` reports when the parser script cannot be located.
 * It is a REFUSAL, not a silent pass: every caller of `parseCommand` treats a
 * `success: false` as "this command could not be validated", and
 * `validatePowerShellCommand` turns it into `allowed: false`.
 */
const PARSER_SCRIPT_MISSING_ERROR =
  `PowerShell parser script (${PARSER_SCRIPT_NAME}) not found; PowerShell AST validation is unavailable on this host`;

let parserScriptMissingWarned = false;

/**
 * The parser spawn's own ceiling, hoisted so the number the expiry REPORTS and
 * the number it is measured against are the same one (P2.240).
 *
 * 10s, unchanged and deliberate. It is not a test knob: raising it hides a real
 * hang from a user whose shell validation would then stall, and lowering it
 * turns ordinary load into refusals. What P2.240 changes is that reaching it now
 * says so.
 */
const PARSE_SPAWN_TIMEOUT_MS = 10_000;

/**
 * Locate the PowerShell parser script, or report that it cannot be found.
 *
 * This used to THROW when `setPowerShellValidatorRoot()` had never been called,
 * from a line outside `parseCommand`'s own `try` — and the only production
 * caller of that setter is the Electron main process. `getDeniedPathViolation`
 * reaches `extractPowerShellWriteTarget` on EVERY Bash permission check, so on
 * any non-Electron host that has `pwsh`/`powershell.exe` on PATH — a
 * `nessy-server` or `apps/cli` process, which on Windows means every one of
 * them — the FIRST Bash permission check threw an uncaught error (P2.254).
 *
 * Two candidates, in order, and no others:
 *
 *  1. An explicitly registered root. That registration is the app's claim about
 *     where it STAGED the script (`apps/electron/scripts/copy-assets.ts` puts it
 *     in `dist/resources/`), so it is authoritative: if the script is not there,
 *     that is a packaging break and we say so, rather than quietly reaching for
 *     a copy the app never shipped.
 *  2. Otherwise, the file sitting next to THIS module. `@nessy-agent/shared`
 *     publishes `src/index.ts` as its entry, so `nessy-server` and `apps/cli`
 *     load this very file from `packages/shared/src/agent/`, where the script
 *     lives. That is a real default for exactly the hosts the throw was killing.
 *
 * Resolution is MODULE-relative and never `process.cwd()`-relative, unlike
 * `getBundledAssetsDir`: this path is handed to `pwsh -File`, so a cwd-based
 * candidate would let any checked-out repository supply a script we then
 * EXECUTE — the same hazard `getBundledAssetsRoot` documents for trust material,
 * except here the asset is code.
 */
function resolveParserScriptPath(): string | null {
  if (_validatorRoot) {
    const staged = join(_validatorRoot, PARSER_SCRIPT_NAME);
    return existsSync(staged) ? staged : null;
  }

  if (MODULE_DIR) {
    const adjacent = join(MODULE_DIR, PARSER_SCRIPT_NAME);
    if (existsSync(adjacent)) return adjacent;
  }

  return null;
}

/**
 * Parse a PowerShell command using the native parser.
 * Synchronous for compatibility with existing validation flow.
 */
function parseCommand(command: string): ParseResult {
  if (!powershellPath) {
    return { success: false, error: 'PowerShell not available' };
  }

  try {
    const scriptPath = resolveParserScriptPath();
    if (!scriptPath) {
      // Say so ONCE, out loud. A permission path that degrades in silence is
      // how this defect survived: `debug()` is off unless NESSY_DEBUG=1, and a
      // host in this state answers every PowerShell validation with a refusal.
      if (!parserScriptMissingWarned) {
        parserScriptMissingWarned = true;
        console.warn(
          `[PowerShellValidator] ${PARSER_SCRIPT_MISSING_ERROR}. ` +
            (_validatorRoot
              ? `Registered root: ${_validatorRoot}`
              : 'No root was registered via setPowerShellValidatorRoot() and no script sits next to this module.')
        );
      }
      return { success: false, error: PARSER_SCRIPT_MISSING_ERROR };
    }

    const result = spawnSync(
      powershellPath,
      ['-NoProfile', '-NonInteractive', '-File', scriptPath, '-Command', command],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        // P2.240 — deliberately NOT raised. Raising it hides a real hang;
        // lowering it manufactures more failures. A user's shell validation must
        // not stall for 30s, so the ceiling stays and the EXPIRY is made legible
        // instead (below). One parser spawn costs 0.69-0.88s idle on the
        // reference host (pwsh 7.6.5); the ceiling is only reached under load.
        timeout: PARSE_SPAWN_TIMEOUT_MS,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024, // 10MB for large ASTs
      }
    );

    if (result.error) {
      // P2.240 · SAY WHAT THIS IS. Every caller of `parseCommand` turns
      // `success: false` into `null`, and a `null` write-target is
      // indistinguishable from "this command writes nothing" — so a spawn that
      // never produced an answer arrives at the reader as a WRONG ANSWER. That
      // is how a five-lane test fan-out manufactured 25 failures that looked
      // exactly like product defects (measured: 471/0 idle, 446/25 under load),
      // and it is the same shape for a user on a loaded machine, who gets a
      // silently permissive-looking validation instead of "we could not check".
      //
      // Out loud, on `console.warn`, for the reason the missing-script path
      // above gives: `debug()` is off unless NESSY_DEBUG=1, and a host in this
      // state answers every PowerShell validation from a parse that never ran.
      // NOT once-latched, unlike that path: a missing script is permanent, while
      // this is a condition that comes and goes, and the repetition is itself
      // the signal that the machine rather than the command is the cause.
      //
      // The code is named because the two shapes need different reactions and
      // are otherwise identical at the call site: `ETIMEDOUT` is the ceiling
      // (>= 10s, the machine is loaded), while `EAGAIN`/`EMFILE` under a fan-out
      // fail in 160-240ms. `spawnSync` sets `result.error` for BOTH, so a
      // duration rule alone reads the fast ones as real answers.
      const code = (result.error as NodeJS.ErrnoException).code;
      const detail = code === 'ETIMEDOUT'
        ? `timed out after ${PARSE_SPAWN_TIMEOUT_MS}ms — the parse did not run, so this is a REFUSAL to answer, not a verdict about the command`
        : `failed to spawn (${code ?? 'no code'}) — the parse did not run, so this is a REFUSAL to answer, not a verdict about the command`;
      console.warn(`[PowerShellValidator] parser ${detail}: ${result.error.message}`);
      return {
        success: false,
        error: `Failed to spawn PowerShell: ${result.error.message}`,
      };
    }

    const stdout = result.stdout || '';
    const stderr = result.stderr || '';

    if (result.status !== 0 && !stdout) {
      return {
        success: false,
        error: stderr || `PowerShell exited with code ${result.status}`,
      };
    }

    try {
      return JSON.parse(stdout) as ParseResult;
    } catch (e) {
      return {
        success: false,
        error: `Failed to parse PowerShell output: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  } catch (e) {
    return {
      success: false,
      error: `PowerShell execution failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ============================================================
// Validation Logic
// ============================================================

/**
 * Validate a PowerShell command using AST analysis.
 *
 * @param command - The PowerShell command string to validate
 * @param patterns - Compiled regex patterns for allowed commands
 * @returns Validation result with detailed reason if rejected
 */
export function validatePowerShellCommand(
  command: string,
  patterns: CompiledBashPattern[]
): PowerShellValidationResult {
  // Check if PowerShell is available
  if (!isPowerShellAvailable()) {
    return {
      allowed: false,
      reason: {
        type: 'powershell_unavailable',
        explanation: 'PowerShell is not available on this system',
      },
    };
  }

  // Parse the command
  const parseResult = parseCommand(command);

  if (!parseResult.success || !parseResult.ast) {
    return {
      allowed: false,
      reason: {
        type: 'parse_error',
        error: parseResult.error || 'Unknown parse error',
      },
    };
  }

  // Check for parse errors
  if (parseResult.parseErrors && parseResult.parseErrors.length > 0) {
    return {
      allowed: false,
      reason: {
        type: 'parse_error',
        error: parseResult.parseErrors.map(e => e.Message).join('; '),
      },
    };
  }

  // Validate the AST
  return validatePowerShellAst(parseResult.ast, patterns);
}

/**
 * The verdict of {@link validatePowerShellCommand} for an AST the parser script
 * already produced (its `ast` field). Exported so a test can drive the walk on
 * a recorded real-parser AST without a `pwsh` spawn (UA12.88 follow-up 2).
 */
export function validatePowerShellAst(
  ast: object,
  patterns: CompiledBashPattern[]
): PowerShellValidationResult {
  const subcommandResults: SubcommandResult[] = [];
  const result = validateNode(ast as ASTNode, patterns, subcommandResults);

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
): PowerShellValidationResult {
  if (!node) {
    return { allowed: true };
  }

  switch (node.Type) {
    case 'ScriptBlockAst':
      return validateScriptBlock(node as ScriptBlockAst, patterns, results);

    case 'NamedBlockAst':
      return validateNamedBlock(node as NamedBlockAst, patterns, results);

    case 'PipelineAst':
      return validatePipeline(node as PipelineAst, patterns, results);

    case 'CommandAst':
      return validateCommand(node as CommandAst, patterns, results);

    case 'CommandExpressionAst':
      return validateCommandExpression(node as CommandExpressionAst, patterns, results);

    case 'AssignmentStatementAst':
      return {
        allowed: false,
        reason: {
          type: 'assignment',
          explanation: 'Variable assignment could modify state',
        },
      };

    case 'SubExpressionAst':
      return {
        allowed: false,
        reason: {
          type: 'subexpression',
          explanation: '$(...) subexpressions execute embedded commands',
        },
      };

    case 'ScriptBlockExpressionAst':
      return {
        allowed: false,
        reason: {
          type: 'script_block',
          explanation: 'Script blocks { } can execute arbitrary code',
        },
      };

    default:
      // Check for dangerous patterns in any node
      return validateGenericNode(node, patterns, results);
  }
}

/**
 * Validate a ScriptBlockAst (root node).
 */
function validateScriptBlock(
  node: ScriptBlockAst,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): PowerShellValidationResult {
  // Validate each block
  for (const block of [node.BeginBlock, node.ProcessBlock, node.EndBlock]) {
    if (block) {
      const result = validateNode(block, patterns, results);
      if (!result.allowed) {
        return result;
      }
    }
  }
  return { allowed: true };
}

/**
 * Validate a NamedBlockAst.
 */
function validateNamedBlock(
  node: NamedBlockAst,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): PowerShellValidationResult {
  for (const stmt of node.Statements || []) {
    const result = validateNode(stmt, patterns, results);
    if (!result.allowed) {
      return result;
    }
  }
  return { allowed: true };
}

/**
 * Validate a PipelineAst.
 */
function validatePipeline(
  node: PipelineAst,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): PowerShellValidationResult {
  // Check for background execution
  if (node.Background) {
    return {
      allowed: false,
      reason: {
        type: 'background_execution',
        explanation: 'Background execution (&) could hide malicious activity',
      },
    };
  }

  // Validate each pipeline element
  for (const element of node.PipelineElements || []) {
    const result = validateNode(element, patterns, results);
    if (!result.allowed) {
      return result;
    }
  }

  return { allowed: true };
}

/**
 * Validate a CommandAst.
 */
function validateCommand(
  node: CommandAst,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): PowerShellValidationResult {
  // Check invocation operator
  if (node.InvocationOperator === 'Dot') {
    return {
      allowed: false,
      reason: {
        type: 'dot_sourcing',
        explanation: 'Dot-sourcing (.) executes scripts in current scope',
      },
    };
  }

  if (node.InvocationOperator === 'Ampersand') {
    return {
      allowed: false,
      reason: {
        type: 'script_block',
        explanation: 'Call operator (&) executes commands/scripts',
      },
    };
  }

  // Check for file redirections
  for (const redirect of node.Redirections || []) {
    if (redirect.Type === 'FileRedirectionAst') {
      const fileRedirect = redirect as FileRedirectionAst;
      const target = fileRedirect.Location?.Text || 'unknown';

      // Allow redirection to $null (PowerShell's /dev/null)
      if (target.toLowerCase() === '$null') {
        continue;
      }

      return {
        allowed: false,
        reason: {
          type: 'redirect',
          target,
          explanation: `File redirection to "${target}" writes to filesystem`,
        },
      };
    }
  }

  // Build command string for pattern matching
  const commandParts: string[] = [];

  for (const element of node.CommandElements || []) {
    // Check each element for dangerous constructs
    const dangerCheck = checkForDangerousConstructs(element);
    if (dangerCheck) {
      return { allowed: false, reason: dangerCheck };
    }

    // Extract text for pattern matching
    const text = getElementText(element);
    if (text) {
      commandParts.push(text);
    }
  }

  const commandStr = commandParts.join(' ');
  const cmdletName = commandParts[0] || '';

  // Check if cmdlet is inherently dangerous
  if (isDangerousCmdlet(cmdletName)) {
    const subResult: SubcommandResult = {
      command: commandStr,
      allowed: false,
      reason: `Cmdlet "${cmdletName}" can modify system state`,
    };
    results.push(subResult);

    return {
      allowed: false,
      reason: {
        type: 'unsafe_command',
        command: commandStr,
        explanation: `Cmdlet "${cmdletName}" can modify system state`,
      },
    };
  }

  // Check against safe patterns (case-insensitive for PowerShell)
  // PowerShell cmdlets are case-insensitive, so Get-Process == get-process == GET-PROCESS
  const matchesPattern = patterns.some(pattern => {
    // Try original pattern first
    if (pattern.regex.test(commandStr)) {
      return true;
    }
    // If pattern doesn't have 'i' flag, try case-insensitive match
    if (!pattern.regex.flags.includes('i')) {
      try {
        const caseInsensitiveRegex = new RegExp(pattern.source, pattern.regex.flags + 'i');
        return caseInsensitiveRegex.test(commandStr);
      } catch {
        // If regex creation fails, fall back to original result
        return false;
      }
    }
    return false;
  });

  // UA12.88 follow-up 2 — a matched regex is the FIRST gate, as on the bash path: sed, sort and gh api
  // must also pass their argv inspector (bash-validator.ts {@link nativeArgvInspectorReason}). Before, a
  // line `looksLikePowerShell` flags (a quoted ` -eq ` is enough) skipped them, so `gh api -X DELETE …`
  // and `gh api -X GET … -F a=@.env` read as read-only here on upstream's two shipped gh api entries.
  const inspectorReason = matchesPattern ? nativeArgvInspectorReason(commandParts) : null;
  if (inspectorReason) {
    results.push({ command: commandStr, allowed: false, reason: inspectorReason });
    return {
      allowed: false,
      reason: { type: 'unsafe_command', command: commandStr, explanation: inspectorReason },
    };
  }

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
 * Validate a CommandExpressionAst.
 */
function validateCommandExpression(
  node: CommandExpressionAst,
  patterns: CompiledBashPattern[],
  results: SubcommandResult[]
): PowerShellValidationResult {
  return validateNode(node.Expression, patterns, results);
}

/**
 * Validate any node for dangerous patterns.
 */
function validateGenericNode(
  node: ASTNode,
  _patterns: CompiledBashPattern[],
  _results: SubcommandResult[]
): PowerShellValidationResult {
  const dangerCheck = checkForDangerousConstructs(node);
  if (dangerCheck) {
    return { allowed: false, reason: dangerCheck };
  }

  return { allowed: true };
}

/**
 * Check an AST node for dangerous constructs.
 */
function checkForDangerousConstructs(node: ASTNode): PowerShellValidationReason | null {
  if (!node) {
    return null;
  }

  switch (node.Type) {
    case 'SubExpressionAst':
      return {
        type: 'subexpression',
        explanation: `$(...) subexpression executes embedded commands (found: ${node.Text})`,
      };

    case 'ScriptBlockExpressionAst':
      return {
        type: 'script_block',
        explanation: `Script block { } can execute arbitrary code (found: ${node.Text})`,
      };

    case 'ExpandableStringExpressionAst': {
      const expandable = node as ExpandableStringExpressionAst;
      // Check for subexpressions in the string
      for (const nested of expandable.NestedExpressions || []) {
        if (nested.Type === 'SubExpressionAst') {
          return {
            type: 'subexpression',
            explanation: `String contains $(...) subexpression (found: ${node.Text})`,
          };
        }
      }
      break;
    }

    case 'InvokeMemberExpressionAst': {
      // Method invocation could be dangerous
      const invoke = node as InvokeMemberExpressionAst;
      const memberText = invoke.Member?.Text?.toLowerCase() || '';

      // Block potentially dangerous method calls
      const dangerousMethods = ['invoke', 'invokescript', 'create', 'start'];
      if (dangerousMethods.some(m => memberText.includes(m))) {
        return {
          type: 'invoke_expression',
          explanation: `Method invocation could execute code (found: ${node.Text})`,
        };
      }
      break;
    }
  }

  return null;
}

/**
 * Get the text value from a command element.
 */
function getElementText(node: ASTNode): string | null {
  if (!node) {
    return null;
  }

  switch (node.Type) {
    case 'StringConstantExpressionAst':
      return (node as StringConstantExpressionAst).Value;

    case 'VariableExpressionAst':
      return `$${(node as VariableExpressionAst).VariablePath}`;

    case 'CommandParameterAst':
      return node.Text;

    default:
      return node.Text;
  }
}

/**
 * Synchronous check if command looks like PowerShell syntax.
 * Used to determine whether to use PowerShell or bash validation.
 *
 * Re-exported from the pure rule module, which is where the permission matcher
 * for `PowerShell(...)` rules also reads it: the routing decision and the
 * permission decision must be the same answer, so there is one implementation.
 */
export { looksLikePowerShell } from './pi-harness/claude-powershell-rule.ts';

// ============================================================
// Write Target Extraction (for plans folder exception)
// ============================================================

/**
 * Detect and unwrap `powershell.exe -Command "..."` wrapper, returning the inner command.
 *
 * Codex on Windows often wraps PowerShell commands in:
 *   "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command "Set-Content -Path \"...\" ..."
 *   powershell.exe -NoProfile -Command "..."
 *   pwsh -Command "..."
 *
 * The PS AST parser sees `powershell.exe` as the top-level command (not the inner cmdlet),
 * so extractPowerShellWriteTarget() fails. This function strips the wrapper and returns
 * the inner command with escaped quotes unescaped, so it can be re-parsed.
 */
export function unwrapPowerShellCommand(command: string): string | null {
  // Match: "C:\...\powershell.exe" -Command "inner"  OR  powershell.exe -Command "inner"  OR  pwsh -Command "inner"
  // Optional flags like -NoProfile -NonInteractive before -Command
  const match = command.match(
    /^(?:"[^"]*[/\\]?(?:powershell|pwsh)(?:\.exe)?"\s+|(?:powershell|pwsh)(?:\.exe)?\s+)(?:-(?!Command)\w+\s+)*-Command\s+"((?:[^"\\]|\\.)*)"\s*$/i
  );
  if (!match?.[1]) return null;
  // Unescape inner escaped quotes: \" → "
  return match[1].replace(/\\"/g, '"');
}

/** Read cmdlets that read files */
const READ_CMDLETS = ['get-content', 'gc', 'type'];

/** Write cmdlets that output to files */
const WRITE_CMDLETS = ['out-file', 'set-content', 'add-content'];

/**
 * The ONE PowerShell escape that can synthesise a character absent from the
 * source text. Everything else `` ` `` introduces (`` `n ``, `` `t ``, `` `0 ``,
 * `` `a ``, `` `e ``…) yields a control character, and no cmdlet name contains
 * one — so stripping the backtick can only ever JOIN a name, never forge one.
 * `` `u{2D} `` can forge the hyphen of `Out-File`, and `` `u{4F} `` its `O`.
 */
const POWERSHELL_SYNTHESIS_ESCAPE = /`u\{/i;

/**
 * Whether the parser could not possibly name one of `cmdlets` in this command —
 * i.e. whether the (expensive) PowerShell subprocess can be skipped.
 *
 * ## Why this exists: every Bash permission check was paying a subprocess
 *
 * `mode-manager.ts:getDeniedPathViolation` calls
 * {@link extractPowerShellWriteTarget} on EVERY `Bash` tool call, with no
 * "does this even look like PowerShell" gate. Measured on this host
 * (darwin-arm64, `pwsh` present, availability probe already warm, load average
 * 15.5): **580 ms per call** over ten ordinary POSIX commands, and 10.2 s per
 * call while the machine was also running the spelling grid below — so the cost
 * is not a constant, it is a contention multiplier on the permission path.
 * P2.254 measured the same thing from the other end: one test file went from
 * 2 s while the validator was broken to 1318 s once it correctly spawned.
 *
 * ## Why a substring gate, and why THIS substring gate
 *
 * P2.241 refused the obvious fix — a `looksLikePowerShell` gate — because
 * getting it wrong makes the denied-path check fail OPEN, and that is the wrong
 * direction. This gate is narrower and its safety is an argument, not a hope:
 *
 * `getCommandName` returns a name only from a `StringConstantExpressionAst`,
 * i.e. a bareword or a quoted constant, and only its parsed `.Value`. The
 * characters of that `.Value` can come from exactly three places: the source
 * text; quote and backtick removal, which DELETES characters and can therefore
 * only join a name that was already spelled out; and `` `u{…} ``, which is the
 * one construct that can introduce a character the source never contained. So
 * stripping `` ` ``, `'` and `"` and then looking for the name is a SUPERSET of
 * what the parser can find, provided any `` `u{ `` sends the command to the
 * parser regardless. A name assembled at RUNTIME — `& ("Out" + "-File")`,
 * `& $cmd` — is not a `StringConstantExpressionAst` at all, so the parser
 * returns null for it too.
 *
 * Measured against that argument rather than asserted: an exhaustive spelling
 * grid of 341 commands — backtick, empty-quote and split-quote insertions at
 * every position of every read and write cmdlet, `` `u{…} `` substitution of
 * every character, the `&"…"` invocation forms, upper case, and a backtick line
 * continuation inside the name — produced **0 cases where this gate skipped and
 * the parser found a target**. It over-spawns on 125 of the 341 (it says "might
 * name one" where the parser then finds nothing), which is the direction that
 * costs time rather than safety. The five spellings P2.241 recorded as defeating
 * a naive substring test are all in that grid and all pass here.
 *
 * On ordinary POSIX commands the gate skips 31 of 31 on the write side. The
 * read side skips 25 of 31, and the six it will not skip are a genuine property
 * of the cmdlet list rather than a flaw: `gc` and `type` are short enough to
 * occur inside `gcc`, `gcloud`, `/usr/gc`, `type -a node`, `--mime-type` and
 * `--type bool`. A substring test cannot do better without word boundaries, and
 * word boundaries are exactly what backtick-and-quote stripping destroys.
 *
 * **Posture note.** This narrows nothing an administrator configured and
 * changes no verdict the parser would have reached; it removes a subprocess for
 * commands the parser provably cannot find a target in. It IS nevertheless a
 * gate on a denied-path check, so the failure direction is stated here on
 * purpose: if the superset argument above is ever false, the failure is OPEN.
 * The grid that measured it is `--self-test`-shaped in
 * `powershell-cmdlet-gate.test.ts`; extend it before extending
 * {@link READ_CMDLETS} or {@link WRITE_CMDLETS}.
 */
export function cannotNamePowerShellCmdlet(command: string, cmdlets: readonly string[]): boolean {
  if (POWERSHELL_SYNTHESIS_ESCAPE.test(command)) return false;
  const stripped = command.replace(/[`'"]/g, '').toLowerCase();
  return !cmdlets.some(cmdlet => stripped.includes(cmdlet));
}

/**
 * `-Path`, `-FilePath` and `-LiteralPath` values, in the three spellings a
 * command string can carry them: single-quoted, double-quoted, and BARE.
 * `-LiteralPath` is included here and is absent from the AST path
 * ({@link extractPowerShellWriteTarget} asks for `FilePath`/`Path` only), so
 * this is a superset in that one direction rather than a copy.
 */
const POWERSHELL_PATH_PARAMETER =
  /(?:^|\s)-(?:File|Literal)?Path\s+(?:"([^"]+)"|'([^']+)'|([^\s'"]+))/gi;

/**
 * A write cmdlet immediately followed by a POSITIONAL value — `Set-Content
 * C:\x\id_rsa -Value y`. The first character class refuses a leading `-` so a
 * flag is never mistaken for a path, which is the same rule
 * `extractFirstPositionalArg` applies to the parsed form.
 */
const POWERSHELL_POSITIONAL_TARGET =
  /(?:^|[\s|;(])(?:out-file|set-content|add-content)\s+(?:"([^"]+)"|'([^']+)'|([^\s'"-][^\s'"]*))/gi;

/**
 * Every plausible write target in `command`, WITHOUT spawning anything.
 *
 * ## The defect this exists for (P3.332)
 *
 * {@link extractPowerShellWriteTarget} returns `null` for two different things:
 * "this command writes nothing" and "the parser refused to answer". The refusal
 * is real and load-dependent — `parseCommand` reports `success: false` on a
 * spawn timeout, on `EAGAIN`/`EMFILE` under a fan-out, and on a missing parser
 * script — and `validatePowerShellCommand` consumes the IDENTICAL refusal and
 * correctly turns it into `allowed: false`. The denied-path floor could not: it
 * reads a `null` as "no target", contributes no candidate, and a command that
 * would have been refused is judged as though it named nothing.
 *
 * ## Why candidates, plural, and why they are only ever ADDED
 *
 * This never replaces the parser and never decides anything on its own. Its
 * output is appended to the floor's candidate list in
 * `mode-manager.getDeniedPathViolation`, where every candidate can only produce
 * a DENY — so a false positive costs a refused write with a legible reason, and
 * a false negative costs nothing that was not already lost. It is deliberately
 * NOT wired into the plans/data-folder ALLOW exception at the other
 * `extractPowerShellWriteTarget` call site: there a target is what grants
 * permission, so a regex-derived guess could manufacture an allow. That site
 * already fails closed by withholding one, and it stays as it is.
 *
 * ## What the floor already had, measured before this was written
 *
 * `mode-manager.extractBashWriteTarget` has carried spawn-free patterns for the
 * QUOTED forms since the Codex work (patterns 4-8). Driven at HEAD with the
 * parser forced to refuse, those three shapes still deny:
 * `Out-File -FilePath 'C:\…\id_rsa'`, `Out-File 'C:\…\id_rsa'`,
 * `Set-Content -Path 'C:\…\id_rsa'`. What survived the refusal, and is what
 * this function adds:
 *
 * | shape                                        | before | after |
 * | -------------------------------------------- | ------ | ----- |
 * | `Out-File -FilePath C:\…\id_rsa` (unquoted) | allowed | denied |
 * | `Out-File -FilePath id_rsa` (bare name)      | allowed | denied |
 * | `Out-File -LiteralPath '…\id_rsa'`           | allowed | denied |
 * | `Set-Content -Path C:\…\id_rsa` (unquoted)  | allowed | denied |
 * | `Set-Content C:\…\id_rsa` (positional)      | allowed | denied |
 * | `Add-Content id_rsa` (positional, bare)      | allowed | denied |
 *
 * The `cannotNamePowerShellCmdlet` gate runs first, so on an ordinary POSIX
 * command this costs one substring test and returns nothing — the same superset
 * argument that gate already carries, with the same failure direction stated
 * there.
 */
export function powerShellWriteTargetCandidates(command: string): readonly string[] {
  if (cannotNamePowerShellCmdlet(command, WRITE_CMDLETS)) return [];

  // Three views of the same text: as written; with the `powershell.exe
  // -Command "…"` wrapper removed (the form Codex on Windows produces); and
  // with lone escaped quotes collapsed, which is the wrapper's inner spelling
  // when the outer quotes are not matched by `unwrapPowerShellCommand`.
  const views = new Set<string>([command]);
  const inner = unwrapPowerShellCommand(command);
  if (inner) views.add(inner);
  if (command.includes('\\"')) views.add(command.replace(/\\"/g, '"'));

  const candidates = new Set<string>();
  for (const view of views) {
    for (const pattern of [POWERSHELL_PATH_PARAMETER, POWERSHELL_POSITIONAL_TARGET]) {
      pattern.lastIndex = 0;
      for (const match of view.matchAll(pattern)) {
        const value = match[1] ?? match[2] ?? match[3];
        // A candidate made only of separators or quotes is regex debris from the
        // escaped-quote view, never a path; dropping it keeps the floor's
        // diagnostic readable without narrowing anything real.
        if (!value || value.startsWith('-') || !/[^\\/'"]/.test(value)) continue;
        candidates.add(value);
      }
    }
  }
  return [...candidates];
}

/**
 * Extract file path from PowerShell write commands using AST analysis.
 * Used to check if a write command targets the plans folder.
 *
 * Returns `null` for BOTH "writes nothing" and "the parser refused"; a caller
 * that must not confuse the two wants {@link powerShellWriteTargetCandidates}
 * beside it.
 *
 * @param command - The PowerShell command string
 * @returns The file path if a write cmdlet is detected, null otherwise
 */
export function extractPowerShellWriteTarget(command: string): string | null {
  // BEFORE the availability probe, which is itself a spawn on its first call.
  // See `cannotNamePowerShellCmdlet` for the superset argument and the numbers.
  if (cannotNamePowerShellCmdlet(command, WRITE_CMDLETS)) return null;
  if (!isPowerShellAvailable()) return null;

  // If wrapped in powershell.exe -Command "...", unwrap and re-parse the inner command.
  // The PS AST parser would see powershell.exe as the top-level command (not the write cmdlet).
  const innerCommand = unwrapPowerShellCommand(command);
  if (innerCommand) {
    return extractPowerShellWriteTarget(innerCommand);
  }

  const parseResult = parseCommand(command);
  if (!parseResult.success || !parseResult.ast) return null;

  // Find the last command in any pipeline (where write cmdlets typically appear)
  const lastCmd = findLastPipelineCommand(parseResult.ast);
  if (!lastCmd) return null;

  // Check if it's a write cmdlet
  const cmdName = getCommandName(lastCmd);
  if (!cmdName || !WRITE_CMDLETS.includes(cmdName.toLowerCase())) return null;

  // Extract -FilePath or -Path parameter value
  let targetPath = extractParameterValue(lastCmd, ['FilePath', 'Path']);

  // Fallback: check for positional parameter (e.g. Out-File C:\temp\file.txt)
  if (!targetPath) {
    targetPath = extractFirstPositionalArg(lastCmd);
  }

  if (targetPath) {
    debug('[PowerShellValidator] Extracted write target:', targetPath);
  }
  return targetPath;
}

// ============================================================
// Windows Path Containment (for the plans folder exception)
// ============================================================

/**
 * True when `path` is a Windows-style ROOTED path: a drive-letter root
 * (`C:\...`, `c:/...`) or a UNC root (`\\server\share`).
 *
 * `C:file.txt` is deliberately NOT one. That is drive-RELATIVE: it names a
 * location under that drive's own current directory, which nothing but Windows
 * can resolve, so a containment check must never treat it as rooted.
 */
export function isWindowsStylePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\/]/.test(path);
}

/**
 * Containment for a PAIR of Windows-style rooted paths, decided with
 * `path.win32` semantics and case-insensitively. Returns false for any pair
 * this cannot claim, so a caller that mis-routes a POSIX path here fails closed.
 *
 * Why it exists (measured, P2.219): on a POSIX host a backslash is an ordinary
 * filename character, so `path.dirname('C:\\a\\b')` is `'.'` and an entire
 * Windows path is ONE component. A containment check written against the host's
 * `path` module therefore cannot see that `C:\...\plans\plan.md` sits inside
 * `C:\...\plans`: `relative()` compares two single-component names, and a
 * nearest-existing-ancestor walk climbs straight past the whole Windows path to
 * the process cwd. That is what refused the plans-folder writes that
 * `mode-manager`'s exception documents as allowed, on every non-Windows host
 * with a real `pwsh` on it.
 *
 * Case is folded because Windows filesystems are case-insensitive: `Users` and
 * `users` are the same directory there.
 *
 * Purely lexical, by necessity — a Windows path cannot be `realpath`-ed on a
 * POSIX host. `win32.relative` (not a prefix test) is what refuses a
 * sibling-prefix directory such as `...\plans-evil`, and normalisation is what
 * refuses a `..` climb back out.
 */
export function isWindowsPathWithinDirectory(targetPath: string, baseDir: string): boolean {
  if (!isWindowsStylePath(targetPath) || !isWindowsStylePath(baseDir)) return false;
  const base = win32.resolve(baseDir).toLowerCase();
  const target = win32.resolve(targetPath).toLowerCase();
  if (base === target) return true;
  const rel = win32.relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !win32.isAbsolute(rel);
}

/**
 * Extract file path from PowerShell read commands using AST analysis.
 * Used to detect file reads (Get-Content, gc, type) for prerequisite tracking.
 *
 * Handles complex cases like:
 * - Get-Content -Path "file.txt" -Encoding UTF8
 * - gc file.txt | Select-String "pattern"
 * - powershell.exe -Command "Get-Content file.txt"
 *
 * @param command - The PowerShell command string
 * @returns The file path if a read cmdlet is detected, null otherwise
 */
export function extractPowerShellReadTarget(command: string): string | null {
  if (cannotNamePowerShellCmdlet(command, READ_CMDLETS)) return null;
  if (!isPowerShellAvailable()) return null;

  // If wrapped in powershell.exe -Command "...", unwrap and re-parse the inner command.
  const innerCommand = unwrapPowerShellCommand(command);
  if (innerCommand) {
    return extractPowerShellReadTarget(innerCommand);
  }

  const parseResult = parseCommand(command);
  if (!parseResult.success || !parseResult.ast) return null;

  // Find the first command in any pipeline (where read cmdlets appear as data source)
  const firstCmd = findFirstPipelineCommand(parseResult.ast);
  if (!firstCmd) return null;

  // Check if it's a read cmdlet
  const cmdName = getCommandName(firstCmd);
  if (!cmdName || !READ_CMDLETS.includes(cmdName.toLowerCase())) return null;

  // Extract -Path or -LiteralPath parameter value
  let targetPath = extractParameterValue(firstCmd, ['Path', 'LiteralPath']);

  // Fallback: positional parameter (e.g. Get-Content C:\temp\file.txt)
  if (!targetPath) {
    targetPath = extractFirstPositionalArg(firstCmd);
  }

  return targetPath;
}

/**
 * Find the first CommandAst in a pipeline within the AST.
 * Read cmdlets are typically the data source (first in pipeline).
 */
function findFirstPipelineCommand(ast: ASTNode): CommandAst | null {
  const pipeline = findFirstPipeline(ast);
  if (!pipeline || !pipeline.PipelineElements?.length) return null;

  const firstElement = pipeline.PipelineElements[0];
  if (firstElement?.Type === 'CommandAst') {
    return firstElement as CommandAst;
  }
  return null;
}

/**
 * Find the last CommandAst in a pipeline within the AST.
 */
function findLastPipelineCommand(ast: ASTNode): CommandAst | null {
  // Navigate to the first pipeline
  const pipeline = findFirstPipeline(ast);
  if (!pipeline || !pipeline.PipelineElements?.length) return null;

  // Get the last element in the pipeline
  const lastElement = pipeline.PipelineElements[pipeline.PipelineElements.length - 1];
  if (lastElement?.Type === 'CommandAst') {
    return lastElement as CommandAst;
  }
  return null;
}

/**
 * Recursively find the first PipelineAst in the AST.
 */
function findFirstPipeline(node: ASTNode): PipelineAst | null {
  if (!node) return null;

  if (node.Type === 'PipelineAst') {
    return node as PipelineAst;
  }

  // Check ScriptBlockAst
  if (node.Type === 'ScriptBlockAst') {
    const scriptBlock = node as ScriptBlockAst;
    for (const block of [scriptBlock.EndBlock, scriptBlock.ProcessBlock, scriptBlock.BeginBlock]) {
      if (block) {
        const result = findFirstPipeline(block);
        if (result) return result;
      }
    }
  }

  // Check NamedBlockAst
  if (node.Type === 'NamedBlockAst') {
    const namedBlock = node as NamedBlockAst;
    for (const stmt of namedBlock.Statements || []) {
      const result = findFirstPipeline(stmt);
      if (result) return result;
    }
  }

  return null;
}

/**
 * Get the command name from a CommandAst.
 */
function getCommandName(cmd: CommandAst): string | null {
  if (!cmd.CommandElements?.length) return null;

  const firstElement = cmd.CommandElements[0];
  // Command name is typically a StringConstantExpressionAst
  if (firstElement?.Type === 'StringConstantExpressionAst') {
    return (firstElement as StringConstantExpressionAst).Value || null;
  }
  return null;
}

/**
 * Extract a parameter value from a CommandAst.
 * Looks for named parameters like -FilePath or -Path.
 */
function extractParameterValue(cmd: CommandAst, paramNames: string[]): string | null {
  if (!cmd.CommandElements) return null;

  const lowerParamNames = paramNames.map(p => p.toLowerCase());

  for (let i = 0; i < cmd.CommandElements.length; i++) {
    const element = cmd.CommandElements[i];

    // Check for CommandParameterAst (named parameter)
    if (element?.Type === 'CommandParameterAst') {
      const param = element as CommandParameterAst;
      const paramName = param.ParameterName?.toLowerCase();

      if (paramName && lowerParamNames.includes(paramName)) {
        // Parameter value might be in Argument property or next element
        if (param.Argument) {
          return extractStringValue(param.Argument);
        }
        // Check next element for the value
        const nextElement = cmd.CommandElements[i + 1];
        if (nextElement && nextElement.Type !== 'CommandParameterAst') {
          return extractStringValue(nextElement);
        }
      }
    }
  }

  return null;
}

/**
 * Extract the first positional argument from a CommandAst.
 * Skips the command name (index 0) and any named parameters (CommandParameterAst)
 * along with their values. Returns the first remaining string element.
 *
 * This handles commands like: Out-File C:\temp\file.txt
 * where the path is a positional parameter (no -FilePath flag).
 */
function extractFirstPositionalArg(cmd: CommandAst): string | null {
  if (!cmd.CommandElements || cmd.CommandElements.length < 2) return null;

  let i = 1; // Skip index 0 (cmdlet name)
  while (i < cmd.CommandElements.length) {
    const element = cmd.CommandElements[i];
    if (element?.Type === 'CommandParameterAst') {
      // Skip the parameter name and its value (next element)
      i += 2;
      continue;
    }
    // First non-parameter element is the positional argument
    if (!element) return null;
    return extractStringValue(element);
  }
  return null;
}

/**
 * Extract string value from various AST node types.
 */
function extractStringValue(node: ASTNode): string | null {
  if (!node) return null;

  switch (node.Type) {
    case 'StringConstantExpressionAst':
      return (node as StringConstantExpressionAst).Value || null;
    case 'ExpandableStringExpressionAst':
      return (node as ExpandableStringExpressionAst).Value || null;
    default:
      // Fallback to Text property which contains the raw text
      return node.Text?.replace(/^['"]|['"]$/g, '') || null;
  }
}

// UA12.88 follow-up 2 — imported at the END of the file: the docs cite this file by line (highest cited
// line 401 on 2026-10-09), and an import is hoisted wherever it is written.
import { nativeArgvInspectorReason } from './bash-validator.ts';
