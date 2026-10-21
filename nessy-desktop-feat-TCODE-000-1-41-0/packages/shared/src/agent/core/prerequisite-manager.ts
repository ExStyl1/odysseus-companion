/**
 * PrerequisiteManager - Prerequisite Reading System
 *
 * Blocks tool calls until specified files have been read in the current context window.
 * State resets on compaction since the LLM loses the guide content.
 *
 * Key responsibilities:
 * - Track which files have been read via the Read tool or a shell read in Bash (cat, head, sed -n …)
 * - Check prerequisites before tool execution (e.g., guide.md for sources)
 * - Reset state on context compaction
 */

/// <reference path="../bash-parser.d.ts" />
import bashParser from 'bash-parser';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve, join } from 'node:path';
import { expandPath } from './path-processor.ts';
import { getBrowserToolEnabled } from '../../config/storage.ts';
import { CONFIG_DIR } from '../../config/paths.ts';
import { foldAgentName } from '../../agents/definitions.ts';
import { parseSkillToolEntry, type SkillToolGrant } from '../../capabilities/runtime-skill-content.ts';
import { matchesToolPattern } from '../mode-manager.ts';
import { parseClaudeRuleString } from '../pi-harness/claude-permission-rules.ts';
import { PI_TOOL_BINDINGS } from '../pi-harness/harness-tool-descriptor.ts';
import {
  compilePermissionDslV1,
  evaluatePermissionDslV1,
  type CompiledPermissionDslV1,
} from '../pi-harness/permission-dsl.ts';
// The ONE reader of `sub-agents.md`'s server-level sentence, shared with the Pi
// child's tool expansion and the host's arrival re-validation (P6.618). Never a
// second parser: three sites, one rule.
import { mcpServerLevelGrantCovers } from '../pi-harness/runtime-agent-definition.ts';

// ============================================================
// Types
// ============================================================

export interface PrerequisiteRule {
  /** Match tool names that require prerequisites */
  toolMatcher: (toolName: string) => boolean;
  /** Resolve the required file path for a matched tool. Returns null to skip. */
  resolveRequiredPath: (toolName: string, workspaceRootPath: string) => string | null;
  /** Block message template. {filePath} is replaced with the required path. */
  blockMessage: string;
  /** If true, always block until file is read (no graceful fallback). */
  strict?: boolean;
}

export interface PrerequisiteCheckResult {
  allowed: boolean;
  blockReason?: string;
}

export interface PrerequisiteManagerConfig {
  workspaceRootPath: string;
  onDebug?: (message: string) => void;
}

// ============================================================
// Constants
// ============================================================

/** Slugs that are exempt from prerequisite checks (internal sources) */
const EXEMPT_SLUGS = new Set(['session']);

/** Global browser tools docs path required before browser tool usage. */
const BROWSER_TOOLS_DOC_PATH = resolve(join(CONFIG_DIR, 'docs', 'browser-tools.md'));

/**
 * Every spelling a tool can reach `checkPrerequisites` under, mapped to the
 * permission name a rule string is written with.
 *
 * `PI_TOOL_BINDINGS` is the contract, not an assumption: the gate passes the
 * permission name (`Bash`), the Pi proxy route passes the binding name
 * (`bash`), a projected definition carries the piName, and all three lowercase
 * into this map. `skill-tool-grant-subject.test.ts` pins it against the
 * bindings, so a renamed or newly added binding fails there.
 */
const PERMISSION_NAME_BY_TOOL: ReadonlyMap<string, string> = new Map(
  PI_TOOL_BINDINGS.flatMap(binding =>
    [binding.bindingName, binding.piName, binding.handlerName ?? binding.bindingName]
      .map(name => [name.toLowerCase(), binding.permissionName] as [string, string])),
);

/** Generation/digest for the one-rule programs a skill grant compiles into. */
const SKILL_GRANT_GENERATION = 'skill-tool-grant';

// ============================================================
// Rules
// ============================================================

/**
 * Static prerequisite rules. Each rule defines:
 * - Which tools it applies to
 * - What file must be read first
 * - What message to show when blocking
 */
const RULES: PrerequisiteRule[] = [
  // MCP source tools: mcp__{slug}__* format
  {
    toolMatcher: (toolName: string) => {
      if (!toolName.startsWith('mcp__')) return false;
      const parts = toolName.split('__');
      if (parts.length < 3) return false;
      const slug = parts[1]!;
      return !EXEMPT_SLUGS.has(slug);
    },
    resolveRequiredPath: (toolName: string, workspaceRootPath: string) => {
      const parts = toolName.split('__');
      const slug = parts[1]!;
      const guidePath = resolve(workspaceRootPath, 'sources', slug, 'guide.md');
      return existsSync(guidePath) ? guidePath : null;
    },
    blockMessage:
      'You must read the source guide before using this tool. Read {filePath} first (Read tool or `cat` in Bash), then retry.',
  },

  // API source tools: api_{slug} format
  {
    toolMatcher: (toolName: string) => {
      return toolName.startsWith('api_');
    },
    resolveRequiredPath: (toolName: string, workspaceRootPath: string) => {
      const slug = toolName.slice(4); // Remove 'api_' prefix
      const guidePath = resolve(workspaceRootPath, 'sources', slug, 'guide.md');
      return existsSync(guidePath) ? guidePath : null;
    },
    blockMessage:
      'You must read the source guide before using this tool. Read {filePath} first (Read tool or `cat` in Bash), then retry.',
  },

  // Built-in browser tool: require browser-tools.md first.
  // Only matches the session-scoped tool (not external MCP browser tools like mcp__playwright__*),
  // and skipped entirely when the built-in browser tool is disabled.
  {
    // Name first: every other tool call skips the config read (UB7.12, upstream v0.15.1).
    toolMatcher: (toolName: string) =>
      (toolName === 'browser_tool' || toolName === 'mcp__session__browser_tool') &&
      getBrowserToolEnabled(),
    resolveRequiredPath: () => {
      return existsSync(BROWSER_TOOLS_DOC_PATH) ? BROWSER_TOOLS_DOC_PATH : null;
    },
    blockMessage:
      'You must read the browser tools guide before using browser automation. Read {filePath} first (Read tool or `cat` in Bash), then retry.',
    strict: true,
  },
];

// ============================================================
// Shell Reads (UB7.12, upstream v0.15.1 verbatim)
// ============================================================

/** Commands that print a file for the model, whole or in part (like Read with offset/limit). */
const FILE_READERS = new Set(['cat', 'bat', 'less', 'more', 'nl', 'head', 'tail', 'sed']);

/** Cheap pre-check so most Bash calls skip the shell parse. */
const MENTIONS_FILE_READER = new RegExp(`\\b(?:${[...FILE_READERS].join('|')})\\b`);

/** Prefixes expandPath turns into the home directory. */
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;

/** The bash-parser AST nodes walked below (bash-validator.ts types the full set). */
interface ShellWord {
  type: 'Word';
  text: string;
  expansion?: Array<{ type: string; parameter?: string }>;
}

interface ShellRedirect {
  type: 'Redirect';
  op: { text: string };
  file: ShellWord;
  numberIo?: { text: string };
}

interface ShellNode {
  type: string;
  /** Script, CompoundList, Pipeline */
  commands?: ShellNode[];
  /** Subshell */
  list?: ShellNode;
  /** LogicalExpression */
  left?: ShellNode;
  right?: ShellNode;
  /** Command */
  name?: ShellWord;
  prefix?: Array<{ type: string }>;
  suffix?: Array<{ type: string }>;
  async?: boolean;
}

/**
 * Absolute paths of the files a Bash command prints for the model with a reader
 * (cat, head, sed -n …). Searching or counting a file (grep, wc), even through a
 * pipe, does not show it, and neither does sending the output to a file.
 */
function getBashReadPaths(command: string): string[] {
  // bash-parser parses heredoc bodies as commands, so their lines would look like reads.
  if (!MENTIONS_FILE_READER.test(command) || command.includes('<<')) return [];
  const paths: string[] = [];
  try {
    collectReads(bashParser(command) as ShellNode, paths);
  } catch {
    return []; // unparseable: count nothing
  }
  return paths;
}

function collectReads(node: ShellNode, paths: string[]): void {
  switch (node.type) {
    case 'Script':
    case 'CompoundList':
      for (const child of node.commands ?? []) collectReads(child, paths);
      break;
    case 'Subshell':
      if (node.list) collectReads(node.list, paths);
      break;
    case 'LogicalExpression':
      if (node.left) collectReads(node.left, paths);
      if (node.right) collectReads(node.right, paths);
      break;
    case 'Pipeline': {
      // The output reaches the model only if every later command is a reader too (`| head -50`).
      const commands = node.commands ?? [];
      commands.forEach((child, i) => {
        if (commands.slice(i + 1).every((next) => readerFiles(next) !== null)) collectReads(child, paths);
      });
      break;
    }
    case 'Command':
      paths.push(...(readerFiles(node) ?? []));
      break;
  }
}

/**
 * The files a reader command prints, or null when the node is not a reader whose
 * output reaches the model (any other command, a background job, output sent to a file).
 */
function readerFiles(node: ShellNode): string[] | null {
  if (node.type !== 'Command' || !node.name || node.async) return null;
  const redirects = [...(node.prefix ?? []), ...(node.suffix ?? [])].filter(
    (item): item is ShellRedirect => item.type === 'Redirect',
  );
  if (redirects.some(sendsStdoutToFile)) return null;

  const words = (node.suffix ?? []).filter((item): item is ShellWord => item.type === 'Word');
  let argv = [node.name, ...words].map(shellWordText);
  // `command cat` runs cat; `command -v cat` only looks it up (and is no reader below).
  if (argv[0] === 'command') argv = argv.slice(argv[1] === '-p' ? 2 : 1);
  const name = argv[0] ? basename(argv[0]) : null; // also /bin/cat, /usr/bin/sed
  if (!name || !FILE_READERS.has(name)) return null;

  const operands = name === 'sed' ? sedInputFiles(argv.slice(1)) : readerOperands(argv.slice(1));
  if (!operands) return null;
  for (const redirect of redirects) {
    if (redirect.op.text === '<') operands.push(shellWordText(redirect.file));
  }
  return operands.flatMap((operand) => {
    const path = operand === null ? null : toReadPath(operand);
    return path ? [path] : [];
  });
}

/** `>`, `>>`, `>|` and `>&` to a file keep stdout from the model; `2>` and `>&2` do not. */
function sendsStdoutToFile(redirect: ShellRedirect): boolean {
  if ((redirect.numberIo?.text ?? '1') !== '1') return false;
  if (redirect.op.text === '>&') return !/^\d+$/.test(redirect.file.text);
  return redirect.op.text === '>' || redirect.op.text === '>>' || redirect.op.text === '>|';
}

/**
 * A word as the shell expands it, or null when that depends on more than $HOME.
 * bash-parser strips quotes only from words without expansions.
 */
function shellWordText(word: ShellWord): string | null {
  if (!word.expansion) return word.text;
  if (word.expansion.some((part) => part.type !== 'ParameterExpansion' || part.parameter !== 'HOME')) return null;
  return word.text.replace(/["']/g, '');
}

/** File operands: everything that is not a flag, and everything after `--` (`-` is stdin). */
function readerOperands(args: Array<string | null>): Array<string | null> {
  const end = args.indexOf('--');
  const options = end === -1 ? args : args.slice(0, end);
  const rest = end === -1 ? [] : args.slice(end + 1);
  return [...options.filter((arg) => !arg?.startsWith('-')), ...rest];
}

/**
 * sed's input files: its operands minus the script, which is the first one unless
 * -e/-f gave it. null for -i/-I, which edit files in place and print nothing.
 */
function sedInputFiles(args: Array<string | null>): Array<string | null> | null {
  const operands: Array<string | null> = [];
  let scriptFromOption = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? null;
    if (arg === '--') {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg?.startsWith('--')) {
      const option = arg.split('=', 1)[0];
      if (option === '--in-place') return null;
      if (option === '--expression' || option === '--file') {
        scriptFromOption = true;
        if (!arg.includes('=')) i++;
      }
    } else if (arg?.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        if (arg[j] === 'i' || arg[j] === 'I') return null;
        if (arg[j] === 'e' || arg[j] === 'f') {
          scriptFromOption = true;
          if (j === arg.length - 1) i++; // the script is the next argument
          break;
        }
      }
    } else {
      operands.push(arg);
    }
  }
  return scriptFromOption ? operands : operands.slice(1);
}

/** Absolute form of a path operand; null for relative ones, since the shell's cwd is not known here. */
function toReadPath(operand: string): string | null {
  return isAbsolute(operand) || HOME_PREFIX.test(operand) ? expandPath(operand) : null;
}

// ============================================================
// PrerequisiteManager
// ============================================================

export class PrerequisiteManager {
  /** Max times to block a tool for the same prerequisite before allowing through */
  private static readonly MAX_REJECTIONS = 1;

  private readFiles: Set<string> = new Set();
  private rejectionCounts: Map<string, number> = new Map();
  /**
   * The invoked skills' `allowed-tools` PRE-APPROVAL, keyed by the LOWERCASED
   * TOOL NAME — the thing a call actually arrives as.
   *
   * Quoted from the raw page (`curl -sL https://code.claude.com/docs/en/skills.md`,
   * fetched 2026-08-13), frontmatter table: "Tools Claude can use **without
   * asking permission** during the turn that invokes this skill. The grant
   * clears when you send your next message." And § *Pre-approve tools for a
   * skill*: "It does not restrict which tools are available: every tool remains
   * callable, and your permission settings still govern tools that are not
   * listed."
   *
   * This map is therefore read by {@link skillGrantAllows} ONLY. Until
   * 2026-08-13 it was also a hard CEILING — a tool it did not name was refused
   * with `Tool "<x>" is outside the invoked skill tool ceiling.` — which gave
   * `allowed-tools` `disallowed-tools`' job, inverted. The value carries the
   * entry's patterns (or `undefined` for the bare, wider form) so name and
   * pattern are decided from one piece of state.
   */
  private skillToolGrants: ReadonlyMap<string, readonly string[] | undefined> | null = null;
  /**
   * The compiled form of each parameterized entry, keyed the same way.
   *
   * `null` is the documented-but-unmatchable form (`Write(path)`, `Cd(path)`,
   * a tool with no specifier semantics): the entry behaves as the bare, wider
   * grant. An entry with no parameters never lands here at all.
   */
  private skillToolGrantPrograms: Map<string, readonly CompiledPermissionDslV1[] | null> = new Map();
  private skillAgentCeiling: ReadonlySet<string> | null = null;
  /**
   * The invoked skills' `disallowed-tools`, canonicalized the same way the
   * ceiling's keys are.
   *
   * A SECOND, independent piece of state rather than a subtraction folded into
   * {@link skillToolGrants}, because the two fields have different domains:
   * a skill may declare `disallowed-tools` without declaring `allowed-tools` at
   * all, and folding would make the removal depend on a grant existing. This is
   * the field that RESTRICTS — "Tools removed from Claude's available pool
   * while this skill is active" — and it is the only one of the pair that can
   * refuse a call.
   */
  private skillDeniedTools: readonly string[] | null = null;
  /**
   * Whether `EndConversation` may be removed by the skill's own rule.
   *
   * `skills.md:262` — "Like deny rules, the field can't remove `EndConversation`
   * while any other tool remains." The caller owns the "any other tool remains"
   * half because it is the only layer that knows the pool; this gate only
   * honours the verdict.
   */
  private skillDeniedToolsMayRemoveEndConversation = false;
  /**
   * P2.385 — the SAME documented removal, for a skill this session was
   * PRELOADED with rather than one it invoked, and therefore SESSION-scoped.
   *
   * A THIRD field rather than a value pushed into {@link skillDeniedTools},
   * because the two have different LIFETIMES and the shorter one is cleared on
   * a schedule the longer one must not share. `skills.md#pre-approve-tools-for-a-skill`
   * bounds the turn-scoped case — "The restriction clears when you send your
   * next message" — and that sentence is about the turn that INVOKED the skill.
   * A preloaded skill was never invoked by a message and no message un-invokes
   * it: `sub-agents.md#preload-skills-into-subagents` says "The full content of
   * each listed skill is injected into the subagent's context at startup", so
   * the skill is active for every turn the child runs, and
   * `skills.md#frontmatter-reference`'s "Tools removed from Claude's available
   * pool **while this skill is active**" therefore covers all of them. Folding
   * this into the turn-scoped field would let {@link clearSkillInvocation} —
   * called from `chat`'s `finally` — disarm a removal after exactly one turn.
   *
   * `EndConversation` is never removed through this field. Both branches of
   * `skills.md`'s "can't remove `EndConversation` while any other tool remains"
   * agree on that here and neither needs the pool: a child with NO ceiling has
   * the full built-in set, so other tools certainly remain; a child WITH one
   * cannot carry `EndConversation` in it at all (it is not a Pi binding), so
   * there is nothing for the exception to bite on. Simpler than plumbing a
   * second `mayRemove…` verdict for a case that cannot arise.
   */
  private preloadedSkillDeniedTools: readonly string[] | null = null;
  private workspaceRootPath: string;
  private onDebug?: (message: string) => void;

  constructor(config: PrerequisiteManagerConfig) {
    this.workspaceRootPath = config.workspaceRootPath;
    this.onDebug = config.onDebug;
  }

  /**
   * Materialized skill content is consumed during turn assembly; only its
   * `allowed-tools` pre-approval remains here, for the invoking turn.
   *
   * **This widens what a skill can do, deliberately** (owner-approved,
   * 2026-08-13). Under the ceiling this replaced, a tool the skill did not list
   * was REFUSED outright, in every mode. Now it simply runs the ordinary
   * permission flow: in an asking mode the user is still prompted, so the
   * change is a prompt-count change there, but in `bypassPermissions`/`auto`
   * nothing prompts and the call goes through. That is the documented
   * behaviour — "every tool remains callable, and your permission settings
   * still govern tools that are not listed" — and it is why the same page warns
   * to "review project skills before trusting a repository, since a skill can
   * grant itself broad tool access". A skill that must not reach a tool has to
   * say so in `disallowed-tools`.
   */
  setSkillInvocationToolGrants(tools: readonly SkillToolGrant[] | undefined): void {
    this.skillToolGrants = tools
      ? new Map(tools.map(grant => [grant.name.toLowerCase(), grant.patterns]))
      : null;
    this.skillToolGrantPrograms = new Map();
    for (const grant of tools ?? []) {
      if (!grant.patterns) continue;
      this.skillToolGrantPrograms.set(grant.name.toLowerCase(), this.compileSkillGrant(grant.name, grant.patterns));
    }
  }

  /**
   * The allow-set is stored FOLDED (`foldAgentName`) so this ceiling agrees with
   * `resolveAgentDefinition`, which matches `subagent_type` case- and
   * separator-insensitively (whats-new/2026-w20.md:91). A case-only fold here
   * rejects the doc's own spelling one layer BEFORE the resolver ever runs, and
   * with a message that lists no agents — so the resolver's fold would be
   * invisible whenever an invoked skill declares an `agent:` restriction.
   */
  setSkillInvocationAgentCeiling(agents: readonly string[] | undefined): void {
    this.skillAgentCeiling = agents ? new Set(agents.map(foldAgentName)) : null;
  }

  /**
   * The invoked skills' `disallowed-tools` — subtraction, not narrowing.
   *
   * `mayRemoveEndConversation` carries the caller's answer to
   * `skills.md:262`'s "while any other tool remains".
   */
  setSkillInvocationDeniedTools(
    tools: readonly string[] | undefined,
    options: { mayRemoveEndConversation?: boolean } = {},
  ): void {
    this.skillDeniedTools = tools && tools.length > 0
      ? tools.map(tool => parseSkillToolEntry(tool).name)
      : null;
    this.skillDeniedToolsMayRemoveEndConversation = options.mayRemoveEndConversation === true;
  }

  /**
   * P2.385 — install a PRELOADED skill's `disallowed-tools` for the whole
   * session. Idempotent, and called once from `BaseAgent`'s constructor, so a
   * runtime-config change that disposes and recreates the agent re-installs it
   * from the same config rather than losing it.
   *
   * `undefined` and `[]` both mean "no removal", unlike the tool CEILING one
   * layer up where the empty list is the author's own empty set: this field is
   * a SUBTRACTION and subtracting nothing is subtracting nothing.
   *
   * @see preloadedSkillDeniedTools for why it is separate from the turn-scoped
   * field and why `EndConversation` is out of its reach.
   */
  setPreloadedSkillDeniedTools(tools: readonly string[] | undefined): void {
    this.preloadedSkillDeniedTools = tools && tools.length > 0
      ? tools.map(tool => parseSkillToolEntry(tool).name)
      : null;
  }

  /**
   * End the turn's skill state — "The grant clears when you send your next
   * message", and the same sentence for the restriction. Called from `chat`'s
   * `finally` in `base-agent.ts`, so both halves die with the turn that applied
   * them; nothing here is session-scoped.
   *
   * {@link preloadedSkillDeniedTools} is DELIBERATELY not cleared here (P2.385):
   * the sentence above is about the turn that invoked a skill, and a preloaded
   * skill is invoked by no turn. Clearing it would arm the removal for the
   * child's first turn and drop it for every turn after — worse than never
   * arming it, because the failure would look like an intermittent one.
   */
  clearSkillInvocation(): void {
    this.skillToolGrants = null;
    this.skillToolGrantPrograms = new Map();
    this.skillAgentCeiling = null;
    this.skillDeniedTools = null;
    this.skillDeniedToolsMayRemoveEndConversation = false;
  }

  /**
   * Check if a tool call's prerequisites are met.
   * Iterates rules, checks if required files have been read.
   * After MAX_REJECTIONS blocks for the same path, allows through gracefully.
   */
  checkPrerequisites(toolName: string, input?: Record<string, unknown>): PrerequisiteCheckResult {
    // `disallowed-tools` is the ONLY half of the pair that can refuse: it
    // removes the tool from the pool, and a removal outranks a grant naming the
    // same tool — the ordinary precedence, and the reason the doc calls the
    // field "like deny rules". `allowed-tools` is checked nowhere on this path;
    // it cannot block, so a call it does not name falls through to the ordinary
    // permission flow (see {@link skillGrantAllows}).
    const deniedBlock = this.checkSkillDeniedTools(toolName);
    if (deniedBlock) return { allowed: false, blockReason: deniedBlock };
    const agentBlock = this.checkSkillAgentCeiling(toolName, input);
    if (agentBlock) return { allowed: false, blockReason: agentBlock };

    for (const rule of RULES) {
      if (!rule.toolMatcher(toolName)) continue;

      const requiredPath = rule.resolveRequiredPath(toolName, this.workspaceRootPath);
      if (!requiredPath) continue; // No guide.md exists, skip

      if (!this.readFiles.has(requiredPath)) {
        const count = (this.rejectionCounts.get(requiredPath) ?? 0) + 1;
        this.rejectionCounts.set(requiredPath, count);

        const blockReason = rule.blockMessage.replace('{filePath}', requiredPath);

        if (rule.strict) {
          this.onDebug?.(`Prerequisite blocked (strict): ${toolName} requires ${requiredPath}`);
          return { allowed: false, blockReason };
        }

        if (count <= PrerequisiteManager.MAX_REJECTIONS) {
          this.onDebug?.(`Prerequisite blocked (${count}/${PrerequisiteManager.MAX_REJECTIONS}): ${toolName} requires ${requiredPath}`);
          return { allowed: false, blockReason };
        }
        // Exceeded max rejections — allow through gracefully
        this.onDebug?.(`Prerequisite: allowing ${toolName} after ${count} rejections (max reached)`);
      }
    }

    return { allowed: true };
  }

  /**
   * Whether the invoked skill's own `allowed-tools` PRE-APPROVES this call.
   *
   * The whole of what the field does: "Tools Claude can use without asking
   * permission during the turn that invokes this skill." A `true` here skips
   * the permission card; a `false` is NOT a refusal — the call continues into
   * the ordinary flow, which is the difference between this and the ceiling it
   * replaced.
   *
   * Both entry forms grant, which is the second half of the 2026-08-13
   * alignment. A BARE `Bash` used to be ceiling membership only, on the reason
   * that treating it as a no-prompt grant "would hand every bare-`Bash` skill
   * an unconditional shell" — but that is precisely what the page describes,
   * unqualified ("the listed tools"), and what it warns about two paragraphs
   * later: "a skill can grant itself broad tool access". A PARAMETERIZED entry
   * grants only the calls its pattern names — `skills.md`'s canonical pair, a
   * rule that "matches the exact command the skill body tells Claude to run, so
   * the script runs without prompting" — and a non-matching call gets the
   * prompt it would have got anyway.
   *
   * A tool `disallowed-tools` removed can never be pre-approved back INTO the
   * pool; `checkPrerequisites` already refused it one step earlier, and this
   * repeats the check so the two orders cannot disagree.
   *
   * The grant reads `skillToolGrants` and nothing else. There is no second
   * store, so it cannot outlive the turn: `clearSkillInvocation()` and a
   * non-preserving `resetReadState()` both null that one field, and this
   * returns false from the next call onward.
   */
  skillGrantAllows(toolName: string, input?: Record<string, unknown>): boolean {
    // EXACT first, and the order is the documented precedence rather than a
    // style choice: `mcp__tool_search` and `mcp__tool_load` are real
    // one-separator pool names that also fit the bare `mcp__<server>` shape, so
    // an advertised name must outrank a pattern. Only when no entry names this
    // tool exactly does the server-level reading run.
    if (!this.skillToolGrants?.has(toolName.toLowerCase())) {
      return this.skillServerLevelGrantAllows(toolName);
    }
    if (this.checkSkillDeniedTools(toolName)) return false;
    const patterns = this.skillToolPatterns(toolName);
    // A bare entry is the wider grant; `'unsupported'` is a pattern no
    // permission check can match, which the same rule makes the wider grant too
    // (see {@link matchSkillToolPatterns}).
    if (!patterns) return true;
    return this.matchSkillToolPatterns(toolName, input) !== 'no-match';
  }

  /**
   * A skill's `allowed-tools` entry that names a whole MCP SERVER, honoured
   * here at the point of enforcement — P6.618.
   *
   * `sub-agents.md` § *Available tools*: "Both fields accept MCP server-level
   * patterns in addition to exact tool names: `mcp__<server>` or
   * `mcp__<server>__*` grants or removes every tool from the named server."
   * The grant map is built by exact canonical name and read by exact lookup, so
   * a skill declaring either shape pre-approved NOTHING: `mcp__wire__query`
   * matched neither `mcp__wire` nor `mcp__wire__*`, and the wildcard T3
   * translates has never been a pre-approval either.
   *
   * {@link mcpServerLevelGrantCovers} is the ONE reader of that sentence in this
   * tree — the same helper the Pi child's `resolveExplicitTools` expansion and
   * the host's arrival re-validation already share — so a server whose name the
   * helper refuses (`mcp__session`, `mcp__*`) is refused here identically, and
   * a later narrowing of the rule cannot move these three sites apart. No second
   * parser.
   *
   * Two properties this must NOT lose, both asserted:
   * - `disallowed-tools` still outranks the grant. The subtraction is on the
   *   TOOL, not on the entry, so it answers the same for every covering entry
   *   and the first match can return.
   * - a foreign server's grant pre-approves nothing: the helper's trailing `__`
   *   is a prefix boundary, so `mcp__git` cannot admit `mcp__github__…`.
   *
   * A server-level entry is BARE by construction — the parameterized
   * `Name(pattern)` form names one tool — so there are no argument patterns to
   * match and it grants the server's tools with any input, exactly as a bare
   * exact entry does.
   */
  private skillServerLevelGrantAllows(toolName: string): boolean {
    if (!this.skillToolGrants) return false;
    for (const entry of this.skillToolGrants.keys()) {
      if (!mcpServerLevelGrantCovers(entry, toolName)) continue;
      return !this.checkSkillDeniedTools(toolName);
    }
    return false;
  }

  /** The parameterized patterns granted for this tool, or undefined (absent, or bare). */
  private skillToolPatterns(toolName: string): readonly string[] | undefined {
    return this.skillToolGrants?.get(toolName.toLowerCase());
  }

  /**
   * Remove a tool the invoked skill listed in `disallowed-tools`.
   *
   * Glob on the canonical tool name, exactly the shape the identically-named
   * SUBAGENT field already enforces (`spawner.ts:201` filters the agent's tool
   * list through `matchesToolPattern`), so the two spellings of one documented
   * idea cannot drift. Nothing here inspects arguments: the documented effect
   * is removal from the pool, not a constraint on how a tool is called.
   */
  private checkSkillDeniedTools(toolName: string): string | undefined {
    const canonical = parseSkillToolEntry(toolName).name;
    if (this.skillDeniedTools
      && !(canonical === 'endconversation' && !this.skillDeniedToolsMayRemoveEndConversation)) {
      const pattern = matchesToolPattern(canonical, [...this.skillDeniedTools], 'skill disallowedTools');
      if (pattern) {
        this.onDebug?.(`Skill disallowed-tools: ${toolName} removed by ${pattern}`);
        return `Tool "${toolName}" was removed by the invoked skill's disallowed-tools.`;
      }
    }
    // P2.385 — the preloaded removal, checked SECOND and independently. Second
    // only so the turn-scoped message keeps naming the turn-scoped cause; a
    // block from either list is the same refusal. Its own message names the
    // other cause, because "the invoked skill" sends a user of a subagent
    // looking for an invocation that never happened.
    if (this.preloadedSkillDeniedTools && canonical !== 'endconversation') {
      const pattern = matchesToolPattern(canonical, [...this.preloadedSkillDeniedTools], 'skill disallowedTools');
      if (pattern) {
        this.onDebug?.(`Preloaded skill disallowed-tools: ${toolName} removed by ${pattern}`);
        return `Tool "${toolName}" was removed by a preloaded skill's disallowed-tools.`;
      }
    }
    return undefined;
  }

  /**
   * Compile one parameterized entry into the same rules the permission system
   * uses, or `null` when no permission check matches that form.
   *
   * `Name(pattern)` IS a permission rule string — `skills.md:426` writes
   * `allowed-tools: Bash(git add *) Bash(git commit *)` in exactly the syntax
   * `permissions.md` defines — so the general parser decides what a specifier
   * means, per tool, instead of a second Bash-only implementation. That is what
   * makes `Read(/only/this.txt)` an enforced constraint rather than a specifier
   * silently dropped on the floor.
   *
   * `sourceRoot` is the workspace root: a turn-scoped skill grant is the
   * session-rule row of the settings-source table (`permissions.md:296`, "CLI
   * flags, `/permissions`, or session rules" anchor at the original cwd), and
   * a skill has no settings file of its own to anchor at.
   *
   * One program per pattern, so one unparseable entry cannot poison the rest.
   */
  private compileSkillGrant(
    grantName: string,
    patterns: readonly string[],
  ): readonly CompiledPermissionDslV1[] | null {
    const permissionName = PERMISSION_NAME_BY_TOOL.get(grantName.toLowerCase()) ?? grantName;
    const programs: CompiledPermissionDslV1[] = [];
    for (const pattern of patterns) {
      const parsed = parseClaudeRuleString(`${permissionName}(${pattern})`, 'allow');
      // Inert forms (`Write(path)`, a tool with no specifier semantics) make
      // the WHOLE entry behave as the bare, wider grant. `Cd(path)` compiles
      // now, but only `evaluateCdPermissionDslV1` reads a `cdPath` rule and
      // `Cd` is not model-invocable at all, so a Cd entry in `allowed-tools`
      // stays the wider grant rather than becoming an unmatchable deny.
      if (!parsed.rule || parsed.rule.match.kind === 'cdPath') return null;
      const program = compilePermissionDslV1({
        generation: SKILL_GRANT_GENERATION,
        projectTrusted: true,
        layers: [{
          scope: 'workspace',
          sourceDigest: SKILL_GRANT_GENERATION,
          sourceRoot: this.workspaceRootPath,
          document: { version: 1, rules: [{ id: 'skill-grant', action: 'allow', match: parsed.rule.match }] },
        }],
      });
      // The same half-contract the settings path had: a pattern that PARSES but
      // will not COMPILE is skipped by `compilePermissionDslV1`, which leaves
      // this program with no rules — `matchSkillToolPatterns` then answers
      // `'no-match'` and the skill quietly loses the pre-approval its
      // frontmatter asked for. That direction is deliberate (a grant we cannot
      // read must not widen), but it must not be SILENT:
      // `managed-settings.md#keys-that-fail-closed` — "an individual entry that
      // fails, such as a malformed permission rule, is skipped with a warning
      // while the rest of the file applies". One line per diagnostic, naming
      // the pattern, because the diagnostic's own rule id is the synthetic
      // `skill-grant` and would point the author at nothing.
      for (const diagnostic of program.diagnostics) {
        this.onDebug?.(
          `Skill allowed-tools grant "${permissionName}(${pattern})" was skipped `
          + `(${diagnostic.code}): ${diagnostic.message}`,
        );
      }
      programs.push(program);
    }
    return programs;
  }

  /**
   * Match a call's input against the skill's patterns.
   *
   * `'unsupported'` for an entry no permission check matches: the pattern is
   * ignored and the entry behaves as the bare, wider grant. `allowed-tools` is
   * a GRANT list, so a form we cannot match must not end up DENYING a tool the
   * author explicitly allowed. It mirrors the posture
   * `claude-permission-rules.ts` already takes for the same strings.
   *
   * An input we DO know how to match but cannot read is `'no-match'`, not
   * `'unsupported'`: a renamed field must fail closed, never silently allow
   * everything. That falls out of the matchers themselves — a `bash` rule with
   * no string `command`, or a path rule with no path parameter, simply does not
   * match — and so does a program that failed to compile, which evaluates to
   * the DSL's `invalid-policy` deny.
   */
  private matchSkillToolPatterns(
    toolName: string,
    input: Record<string, unknown> | undefined,
  ): 'match' | 'no-match' | 'unsupported' {
    const programs = this.skillToolGrantPrograms.get(toolName.toLowerCase());
    if (!programs) return 'unsupported';
    const request = {
      generation: SKILL_GRANT_GENERATION,
      semanticId: toolName.toLowerCase(),
      toolName: PERMISSION_NAME_BY_TOOL.get(toolName.toLowerCase()) ?? toolName,
      input: input ?? {},
      cwd: this.workspaceRootPath,
    };
    return programs.some(program => evaluatePermissionDslV1(program, request).action === 'allow')
      ? 'match'
      : 'no-match';
  }

  private checkSkillAgentCeiling(toolName: string, input?: Record<string, unknown>): string | undefined {
    if (!this.skillAgentCeiling) return undefined;
    const normalized = toolName.toLowerCase().replace(/^mcp__session__/, '');
    if (normalized === 'workflow' || normalized === 'spawn_session') {
      return `Tool "${toolName}" cannot prove the invoked skill agent ceiling at call time.`;
    }
    if (normalized === 'review') {
      return [...this.skillAgentCeiling].some(agent => agent === 'review' || agent === 'reviewer' || agent === 'guardian')
        ? undefined
        : `Tool "${toolName}" is outside the invoked skill agent ceiling.`;
    }
    if (normalized !== 'subagent' && normalized !== 'task') return undefined;

    const requested = new Set<string>();
    const collect = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const record = value as Record<string, unknown>;
      for (const key of ['agent', 'subagent_type']) {
        // Folded on this side too, so the membership test at the bottom
        // compares folded to folded — the ceiling and the resolver must accept
        // exactly the same spellings of the same agent.
        if (typeof record[key] === 'string' && record[key]!.trim()) requested.add(foldAgentName(record[key] as string));
      }
    };
    collect(input);
    for (const field of ['tasks', 'chain']) {
      const values = input?.[field];
      if (Array.isArray(values)) values.forEach(collect);
    }
    // Pi's session Task tool does not select an agent; leave it unaffected.
    if (normalized === 'task' && requested.size === 0) return undefined;
    if (requested.size === 0 || [...requested].some(agent => !this.skillAgentCeiling!.has(agent))) {
      return `Tool "${toolName}" requested an agent outside the invoked skill agent ceiling.`;
    }
    return undefined;
  }

  /**
   * Track a Read tool call. Extracts file_path from tool input,
   * normalizes it, and adds to the read set.
   */
  trackReadTool(toolInput: Record<string, unknown>): void {
    const filePath = (toolInput.file_path as string) || (toolInput.path as string);
    if (!filePath) return;
    this.markRead(expandPath(filePath), 'Read');
  }

  /**
   * Prerequisite check for a Bash call, run from the pre-tool-use pipeline
   * (UB7.12, upstream v0.15.1's `checkBashPrerequisites`). Files the command
   * prints with a reader (cat, head, sed -n …) count as read, like the Read
   * tool: reading the guide is how the agent clears the gate, so `cat
   * browser-tools.md` clears the strict browser rule exactly as Read would.
   *
   * Upstream holds a pending-skill gate here first and marks nothing while it
   * holds; our tree has no skill-prerequisite mechanism (the stub this replaces
   * recorded that), so the mark-then-check order is safe — the only
   * checkPrerequisites verdict for 'Bash' is the pinned "does not match".
   */
  checkBashPrerequisites(command: string): PrerequisiteCheckResult {
    for (const path of getBashReadPaths(command)) this.markRead(path, 'Bash');
    return this.checkPrerequisites('Bash');
  }

  /** Add a file to the read set and record how it was read. */
  private markRead(path: string, via: 'Read' | 'Bash'): void {
    this.readFiles.add(path);
    this.onDebug?.(`Prerequisite: tracked read of ${path} (${via})`);
  }

  /**
   * Reset read state. Called on context compaction since the LLM
   * loses the guide content and needs to re-read.
   *
   * {@link preloadedSkillDeniedTools} is absent from the block below on purpose
   * (P2.385): compaction is the case where a session-scoped removal matters
   * MOST — the preloaded skill's text may fall out of the window while the
   * restriction its author wrote is still in force — so a compaction that
   * disarmed it would hand the model back a tool the skill removed.
   */
  resetReadState(options: { preserveSkillInvocation?: boolean } = {}): void {
    const count = this.readFiles.size;
    this.readFiles.clear();
    this.rejectionCounts.clear();
    if (!options.preserveSkillInvocation) {
      this.skillToolGrants = null;
      this.skillToolGrantPrograms = new Map();
      this.skillAgentCeiling = null;
      this.skillDeniedTools = null;
      this.skillDeniedToolsMayRemoveEndConversation = false;
    }
    this.onDebug?.(`Prerequisite: reset read state (cleared ${count} reads)`);
  }

  /**
   * Check if a specific file has been read (for testing).
   */
  hasRead(filePath: string): boolean {
    return this.readFiles.has(expandPath(filePath));
  }
}
