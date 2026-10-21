import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import {
  CUSTOM_SLASH_COMMAND_PREFIX,
  PLUGIN_WORKFLOW_SLASH_COMMAND_ID_PREFIX,
  WORKFLOW_SLASH_COMMAND_ID_PREFIX,
  type CustomSlashCommand,
  type CustomSlashCommandId,
  type CustomSlashCommandSource,
} from './common.ts';

export {
  CUSTOM_SLASH_COMMAND_PREFIX,
  findCustomSlashCommand,
  isCustomSlashCommandId,
} from './common.ts';
export type {
  CustomSlashCommand,
  CustomSlashCommandId,
  CustomSlashCommandSource,
} from './common.ts';
import { NESSY_AGENT_PROJECT_DIR } from '../projects/nessy-agent-layout.ts';
import {
  skillOverrideHidesFromCommandLists,
  type SkillOverrideState,
} from '../config/skill-overrides.ts';

interface CustomSlashCommandRoots {
  workspaceRootPath?: string;
  /**
   * The project root, and **the caller's job is to have gated it on project
   * trust before passing it.** This helper does not gate: it searches this root
   * FIRST and `listCustomSlashCommands` is first-wins, so an untrusted root
   * passed here shadows a user's `/command` body with a repository's.
   *
   * Today the single production path — `SessionManager.loadSessionCustomSlashCommands`,
   * which serves both the list and the resolve entry points — assigns
   * `projectRoot` only under `resolved.trustDecision === 'trusted'`, so the
   * invariant holds. It is written here because the S11 output-style unit found
   * a byte-for-byte copy of this same working-directory-first search that had
   * **no** gate anywhere, and reported this one as the same live defect. It is
   * not — verified 2026-07-29 by reading both entry points — but the shape is
   * one gate away from being it, and the gate lives in another package.
   *
   * If you add a caller, gate it. `agents/definitions.ts` is the reference:
   * `options.projectRoot && options.projectTrusted === true`.
   */
  workingDirectory?: string;
}

interface ParsedFrontmatter {
  frontmatter: Record<string, string>;
  body: string;
}

export interface ResolvedCustomSlashCommand extends CustomSlashCommand {
  body: string;
  path: string;
  source: CustomSlashCommandSource;
  /** Server-only deterministic workflow dispatch; never projected to the composer. */
  workflowInvocation?: {
    name?: string;
    script?: string;
  };
}

/**
 * The two directories a `/command` is read from, on every runtime.
 *
 * ## `.claude/commands` is NOT one of them, and the claude child reads it anyway
 *
 * C3.276, from C3.183's live measurement (2026-09-11): a flat
 * `<project>/.claude/commands/<name>.md` with no frontmatter is named in the
 * claude child's own `system/init` `slash_commands` and its BODY reaches the
 * upstream turn — against a control with no file, which has neither. So on a
 * claude session the RUNTIME dispatches a roster this loader never listed, and
 * the user's composer shows the other one. That is a divergence inside a single
 * session, not only across a switch.
 *
 * It is left as it is, deliberately. Adding a third entry here would make a
 * project's `.claude/commands` dispatchable on Pi and codex too — which is the
 * host-as-the-seam answer — but on claude it would register the same NAME
 * twice, once expanded by this host and once by the child, with no rule saying
 * which body wins; and it would bypass
 * `packages/shared/src/capabilities/claude-setup-import.ts`, which exists
 * precisely to copy those files in under the user's own eye. Importing is the
 * product's posture; reading in place would be a different product.
 *
 * What was missing is that nobody was TOLD. The user-facing half is the
 * `claudeProjectCommands` row of
 * `apps/electron/src/renderer/components/app-shell/input/runtime-switch-costs.ts`,
 * which prices the loss when a claude session moves to Pi or codex and says in
 * the same sentence that this app's own list never showed them.
 *
 * BACK-POINTER, per AGENTS.md §Traps: that row asserts what THIS constant does
 * not contain. If a third directory is ever added here, that row and its
 * `runtime-capability-gaps.md` twin are the other half to change with it —
 * `__tests__/claude-commands-roster-divergence.test.ts` fails if they drift.
 */
const COMMAND_DIRS: ReadonlyArray<{ relativePath: string; source: CustomSlashCommandSource }> = [
  { relativePath: join(NESSY_AGENT_PROJECT_DIR, 'commands'), source: 'nessy-agent' },
  { relativePath: join('.agents', 'commands'), source: 'agents' },
];

const MAX_CUSTOM_COMMAND_BYTES = 64 * 1024;

function uniqueSearchRoots(options: CustomSlashCommandRoots): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();

  for (const candidate of [options.workingDirectory, options.workspaceRootPath]) {
    if (!candidate || !candidate.trim()) continue;
    const root = resolve(candidate);
    if (seen.has(root)) continue;
    seen.add(root);
    roots.push(root);
  }

  return roots;
}

function commandNameFromFileName(fileName: string): string | null {
  const raw = basename(fileName, extname(fileName))
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!raw || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(raw)) {
    return null;
  }

  return raw;
}

function parseScalar(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote) && trimmed.length >= 2) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseFrontmatter(raw: string): ParsedFrontmatter {
  const normalized = raw.replace(/^\uFEFF/, '');
  const lines = normalized.split(/\r?\n/);

  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: normalized };
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (endIndex === -1) {
    return { frontmatter: {}, body: normalized };
  }

  const frontmatter: Record<string, string> = {};
  for (const line of lines.slice(1, endIndex)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) continue;

    frontmatter[match[1]!.toLowerCase()] = parseScalar(match[2] ?? '');
  }

  return {
    frontmatter,
    body: lines.slice(endIndex + 1).join('\n'),
  };
}

function plainDescription(line: string): string {
  return line
    .replace(/^[-*]\s+/, '')
    .replace(/[`*_#>]/g, '')
    .trim()
    .slice(0, 180);
}

function descriptionFromBody(body: string): string | undefined {
  const firstContentLine = body
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0 && !line.startsWith('#'));

  return firstContentLine ? plainDescription(firstContentLine) : undefined;
}

function parseCustomCommand(
  raw: string,
  name: string,
  path: string,
  source: CustomSlashCommandSource,
): ResolvedCustomSlashCommand | null {
  const { frontmatter, body } = parseFrontmatter(raw);
  const prompt = body.trim();
  if (!prompt) {
    return null;
  }

  const description = frontmatter.description?.trim() || descriptionFromBody(prompt);
  const model = frontmatter.model?.trim();
  // P6.612 — the NATIVE arm of P6.406. `skills.md#frontmatter-reference` lists
  // the field: "`argument-hint` | No | Hint shown during autocomplete to
  // indicate expected arguments. Example: `[issue-number]` or `[filename]
  // [format]`." — and the same page binds it to command FILES rather than only
  // to skills: "Files in `.claude/commands/` support the same frontmatter,
  // except `name` and `paths`, which Claude Code ignores in a command file."
  //
  // The key is read at its documented hyphenated spelling. `parseFrontmatter`
  // lowercases keys and does not fold hyphens, so a camelCase `argumentHint:`
  // line lands under `argumenthint` and is deliberately NOT accepted: the page
  // documents one spelling for a command file, and the two plugin producers
  // that DO accept both (`format-adapters/claude.ts`, `codex.ts`) do so because
  // a plugin manifest can supply the field as a JSON key, which a `.md` file
  // cannot.
  //
  // Empty is dropped rather than carried as `''` — `CustomSlashCommand`'s own
  // contract is that a source with no hint omits the field, so the composer can
  // tell "no hint" from an empty one.
  const argumentHint = frontmatter['argument-hint']?.trim();

  return {
    id: `${CUSTOM_SLASH_COMMAND_PREFIX}${name}`,
    name,
    label: `/${name}`,
    body: prompt,
    path,
    source,
    ...(description ? { description } : {}),
    ...(model ? { model } : {}),
    ...(argumentHint ? { argumentHint } : {}),
  };
}

export function listCustomSlashCommands(options: CustomSlashCommandRoots = {}): ResolvedCustomSlashCommand[] {
  const commands: ResolvedCustomSlashCommand[] = [];
  const seenNames = new Set<string>();

  for (const root of uniqueSearchRoots(options)) {
    for (const commandDir of COMMAND_DIRS) {
      const dir = join(root, commandDir.relativePath);
      if (!existsSync(dir)) continue;

      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;

        const name = commandNameFromFileName(entry.name);
        if (!name || seenNames.has(name)) continue;

        const path = join(dir, entry.name);
        try {
          const fileStat = statSync(path);
          if (!fileStat.isFile() || fileStat.size > MAX_CUSTOM_COMMAND_BYTES) continue;

          const command = parseCustomCommand(readFileSync(path, 'utf8'), name, path, commandDir.source);
          if (!command) continue;

          seenNames.add(name);
          commands.push(command);
        } catch {
          continue;
        }
      }
    }
  }

  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

export function toCustomSlashCommandSummary(command: ResolvedCustomSlashCommand): CustomSlashCommand {
  return {
    id: command.id,
    name: command.name,
    label: command.label,
    ...(command.description ? { description: command.description } : {}),
    ...(command.model ? { model: command.model } : {}),
    // P6.612 — this projection is what `listCustomSlashCommandSummaries` runs
    // every native command through, so a field missing HERE is a field the
    // composer never sees however well the file was parsed. Body and path stay
    // out; the hint is composer metadata by definition.
    ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
  };
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'plugin';
}

/**
 * Namespaced id for a plugin prompt-command slash command:
 * `custom:plugin:<pluginKey>:<name>`. Distinct from a native command's plain
 * `custom:<name>` id, so a plugin command can never collide with (or shadow) a
 * native `.nessy-agent`/`.agents` command of the same bare name.
 */
export function pluginPromptCommandId(pluginKey: string, name: string): CustomSlashCommandId {
  return `${CUSTOM_SLASH_COMMAND_PREFIX}plugin:${pluginKey}:${name}`;
}

/** User-visible label for a plugin prompt-command: `/<plugin-name>:<name>`. */
export function pluginPromptCommandLabel(pluginName: string, name: string): string {
  return `/${slugify(pluginName)}:${name}`;
}

/** Saved-workflow slash command id; separate from native prompt-command ids. */
export function workflowSlashCommandId(name: string): CustomSlashCommandId {
  return `${WORKFLOW_SLASH_COMMAND_ID_PREFIX}${name}`;
}

/** Plugin-workflow slash command id; separate from plugin prompt-command ids. */
export function pluginWorkflowCommandId(pluginKey: string, name: string): CustomSlashCommandId {
  return `${PLUGIN_WORKFLOW_SLASH_COMMAND_ID_PREFIX}${pluginKey}:${name}`;
}

/** Canonical tool-facing name for a plugin workflow. */
export function pluginWorkflowName(pluginName: string, name: string): string {
  return `${slugify(pluginName)}:${name}`;
}

/** Prompt marker consumed by the workflow tool's model guidance. */
export function workflowSlashCommandBody(name: string): string {
  return `[workflow:${name}]\n$ARGUMENTS`;
}

// ---------------------------------------------------------------------------
// Skill-derived slash commands (P7)
// ---------------------------------------------------------------------------

/**
 * Namespaced id for a skill-derived slash command: `custom:skill:<name>`.
 * Follows `pluginPromptCommandId`'s pattern rather than inventing a namespace,
 * so a skill can never collide with (or shadow) a native `custom:<name>` or a
 * plugin `custom:plugin:<key>:<name>` command of the same bare name.
 */
export function skillSlashCommandId(name: string): CustomSlashCommandId {
  return `${CUSTOM_SLASH_COMMAND_PREFIX}skill:${name}`;
}

/**
 * Body for a skill-derived slash command.
 *
 * Deliberately the same `[skill:...]` marker a user would type: the command
 * expands to a marker and the EXISTING user-invocation path
 * (`BaseAgent.extractSkillInvocations`) does the pinned materialization, the
 * grant and the reinjection. No second materialization implementation, and the
 * `$ARGUMENTS` token is expanded by the same RPC that expands it for every other
 * custom command.
 *
 * `reference` must be what the invocation path resolves — the short alias when
 * the resolver selected it, otherwise the fully-qualified capability key.
 */
export function skillSlashCommandBody(reference: string): string {
  return `[skill:${reference}] $ARGUMENTS`;
}

// ---------------------------------------------------------------------------
// Stacked skill invocation (R75 / f149)
// ---------------------------------------------------------------------------

const SKILL_SLASH_COMMAND_ID_PREFIX = `${CUSTOM_SLASH_COMMAND_PREFIX}skill:`;

/**
 * True for an id minted by `skillSlashCommandId`, and for nothing else.
 *
 * The prefix used to be minted and never tested. Stacking needs the predicate on
 * BOTH sides of the decision — "is the leading command a skill?" and "is this
 * next token a skill?" — so it lives here rather than being re-spelled at each
 * call site, where the two spellings would eventually disagree.
 */
export function isSkillSlashCommandId(id: string): boolean {
  return id.startsWith(SKILL_SLASH_COMMAND_ID_PREFIX) && id.length > SKILL_SLASH_COMMAND_ID_PREFIX.length;
}

/** The bare skill name inside a `custom:skill:<name>` id, or `null`. */
export function skillSlashCommandName(id: string): string | null {
  return isSkillSlashCommandId(id) ? id.slice(SKILL_SLASH_COMMAND_ID_PREFIX.length) : null;
}

/**
 * `commands.md:13`, whole line: "A command is only recognized at the start of
 * your message. Text that follows the command name becomes its arguments. As of
 * v2.1.199, [skills](/docs/en/skills#pass-arguments-to-skills) are the
 * exception: a skill invocation followed by more skills, such as `/skill-a
 * /skill-b do XYZ`, loads every skill named at the start and passes the trailing
 * text to each as arguments. Up to six skills can be chained."
 *
 * `skills.md:490` gives the same cap from the other side: "Claude Code expands
 * the first skill plus up to five more stacked after it." Six total, so five
 * tokens may be peeled off the tail after the leading command.
 */
export const MAX_STACKED_SKILL_COMMANDS = 6;

/**
 * Skills that END a stack rather than joining it, because their own arguments
 * may begin with a slash command.
 *
 * `skills.md:490`, whole line: "Claude Code expands the first skill plus up to
 * five more stacked after it. Expansion stops at the first token that isn't an
 * inline user-invocable skill, so a skill that runs as a [forked
 * subagent](#run-skills-in-a-subagent), such as
 * [`/code-review`](/docs/en/code-review#review-a-diff-locally), or one whose
 * arguments may themselves start with a slash command, such as `/loop`, also
 * ends the run there. That token and everything after it become the argument
 * text for every expanded skill. `/code-review` runs as a forked subagent from
 * v2.1.218; on earlier versions it ran inline and stacked."
 *
 * The sentence names TWO reasons a skill ends a run, and only one of them is
 * dead here:
 *
 *  - FORKED SUBAGENT — no analogue. This fork has no forked-subagent skill mode
 *    at all, so `code-review` (added by R71) is an ordinary inline skill and
 *    stacks like any other. The page itself says that is what `/code-review`
 *    did before v2.1.218.
 *  - ARGUMENTS THAT START WITH A SLASH COMMAND — very much alive. `loop` is a
 *    bundled skill in this fork (`LOOP_SKILL_SLUG` in `SessionManager`), and
 *    running it with no interval means its FIRST argument is a slash command:
 *    `/loop /babysit-prs`. Without this rule that `/babysit-prs` would be
 *    stacked as a sibling instead of handed to `loop`, which is the exact
 *    silent misread the doc sentence exists to prevent.
 *
 * Membership is by bare skill name, matched case-insensitively the way the
 * composer's own labels are minted.
 */
export const STACK_ENDING_SKILL_NAMES: readonly string[] = ['loop'];

/** Whether a bare skill name ends a stacked run instead of joining it. */
export function skillEndsCommandStack(name: string): boolean {
  return STACK_ENDING_SKILL_NAMES.includes(name.trim().toLowerCase());
}

/** One `/name` token peeled off the front of a command's argument tail. */
export interface LeadingSlashCommandToken {
  /** The bare name, without the leading `/`. */
  name: string;
  /** Everything after this token, trimmed. The argument tail if the run stops here. */
  rest: string;
}

/**
 * Peel the leading run of whitespace-delimited `/name` tokens off an argument
 * tail, at most `limit` of them.
 *
 * This is only the LEXER. It reports candidate tokens in order and says nothing
 * about whether any of them names a skill — `skills.md:490`'s stop rule
 * ("Expansion stops at the first token that isn't an inline user-invocable
 * skill") is a resolution question the caller answers. The caller walks these in
 * order and stops at the first token that does not resolve; the argument tail is
 * then the `rest` of the last ACCEPTED token, which is exactly "that token and
 * everything after it become the argument text".
 *
 * A token must be delimited by whitespace or end-of-input, so `/usr/bin/env`
 * is one token named `usr/bin/env` — which resolves to no skill and therefore
 * ends the run — rather than three tokens whose first happens to be a real
 * skill name.
 */
export function leadingSlashCommandTokens(tail: string, limit: number): LeadingSlashCommandToken[] {
  const tokens: LeadingSlashCommandToken[] = [];
  let rest = tail.trim();
  while (tokens.length < limit) {
    const match = /^\/(\S+)(?:\s+|$)/.exec(rest);
    if (!match) break;
    rest = rest.slice(match[0].length).trim();
    tokens.push({ name: match[1]!, rest });
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// MCP prompt slash commands (R5)
// ---------------------------------------------------------------------------

/** MCP-side normalisation: spaces become underscores (mcp.md). */
export function normalizeMcpNameSegment(value: string): string {
  return value.trim().replace(/\s+/g, '_');
}

/**
 * Namespaced id for an MCP prompt command: `custom:mcp:<serverSlug>:<name>`.
 * Uses the ORIGINAL prompt name (not the normalised label) so resolution can
 * match it back to the server prompt whose real name `getPrompt` needs. Callers
 * match by full-string equality, never by splitting, so a `:` in the name is fine.
 */
export function mcpPromptCommandId(serverSlug: string, name: string): CustomSlashCommandId {
  return `${CUSTOM_SLASH_COMMAND_PREFIX}mcp:${serverSlug}:${name}`;
}

/** The name a user types: `mcp__<server>__<prompt>`, spaces normalised to underscores. */
export function mcpPromptCommandName(serverSlug: string, name: string): string {
  return `mcp__${normalizeMcpNameSegment(serverSlug)}__${normalizeMcpNameSegment(name)}`;
}

/** User-visible label for an MCP prompt command: `/mcp__<server>__<prompt>`. */
export function mcpPromptCommandLabel(serverSlug: string, name: string): string {
  return `/${mcpPromptCommandName(serverSlug, name)}`;
}

/** One prompt discovered on a connected MCP source. */
export interface McpPromptDescriptor {
  server: string;
  name: string;
  description?: string;
  /** Declared parameters in order; positional args map onto these. */
  argumentNames: string[];
}

/** Project discovered prompts into `/mcp__slug__prompt` command summaries. */
export function listMcpPromptCommands(prompts: readonly McpPromptDescriptor[]): CustomSlashCommand[] {
  return prompts.map(prompt => ({
    id: mcpPromptCommandId(prompt.server, prompt.name),
    name: mcpPromptCommandName(prompt.server, prompt.name),
    label: mcpPromptCommandLabel(prompt.server, prompt.name),
    ...(prompt.description ? { description: prompt.description } : {}),
  }));
}

/**
 * Split a command argument tail into positional tokens, quote-aware:
 * `"Bug in login" high` → `['Bug in login', 'high']`. Both quote styles are
 * honoured; bare runs of non-space are single tokens.
 */
export function parseQuotedArgs(text: string): string[] {
  const args: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return args;
}

/**
 * Map a quote-aware argument tail onto a prompt's declared parameters, by
 * position. Extra tokens beyond the declared parameters are dropped; declared
 * parameters with no token are omitted (the server decides whether they are
 * required).
 */
export function mapMcpPromptArguments(
  argumentNames: readonly string[],
  argsText: string,
): Record<string, string> {
  const tokens = parseQuotedArgs(argsText);
  const mapped: Record<string, string> = {};
  argumentNames.forEach((name, index) => {
    if (index < tokens.length) mapped[name] = tokens[index]!;
  });
  return mapped;
}

/**
 * Flatten a prompt's returned messages into the text injected as turn input.
 * Text content is used verbatim; non-text parts become a short placeholder so a
 * mixed-content prompt still injects a coherent message.
 */
export function renderMcpPromptResult(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
): string {
  const renderContent = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(renderContent).join('\n');
    if (content && typeof content === 'object') {
      const part = content as { type?: unknown; text?: unknown; mimeType?: unknown };
      if (typeof part.text === 'string') return part.text;
      if (part.type === 'resource') return '(resource content)';
      if (part.type === 'image') return `(image ${typeof part.mimeType === 'string' ? part.mimeType : ''})`.trim();
    }
    return '';
  };
  return messages.map(message => renderContent(message.content)).filter(Boolean).join('\n\n').trim();
}

/** The subset of a runtime skill handle this module needs. */
interface SkillSlashCommandInput {
  key: string;
  logicalName: string;
  selectedAsUnqualifiedAlias?: boolean;
  description?: string;
  userInvocable?: boolean;
  overrideState?: SkillOverrideState;
  /** `apps/web` for a skill owned by a directory below the cwd (R79). */
  directoryQualifier?: string;
}

export interface SkillSlashCommand {
  id: CustomSlashCommandId;
  name: string;
  label: string;
  body: string;
  description?: string;
}

/**
 * A second `/name` for a skill that already has one.
 *
 * `code-review.md:279`, whole line: "`/review` is an alias of `/code-review`;
 * before v2.1.223, it was a separate command that ran a single-pass, read-only
 * review of a GitHub pull request." The weekly changelog states the same
 * adoption (`2026-w32.md:90`, whole line): "`/review` is now an alias of
 * `/code-review`, and `/code-review` with no effort level reuses the level you
 * typed last". Only the ALIAS half is implemented here — the sticky effort
 * level is a separate, already-recorded deviation (this fork reuses the level
 * within the conversation, `review-tool.ts:435-441`).
 *
 * An alias is deliberately a DATA entry rather than a second skill directory or
 * a second command body. `selectSkillSlashCommands` mints it as a copy of the
 * entry the target already produced, which buys three things no duplicate could:
 *
 *  - the body is byte-identical, so `/review <args>` and `/code-review <args>`
 *    expand to the same `[skill:...] $ARGUMENTS` text and the argument tail is
 *    carried verbatim by the one expansion both share;
 *  - every rule that withholds the target withholds the alias with it —
 *    `user-invocable: false`, a `skillOverrides` state of `off`, the skill not
 *    being installed — so the alias INHERITS the invocation policy of
 *    `code-review/SKILL.md:4`'s `disable-model-invocation: true` instead of
 *    restating it somewhere the two could drift apart;
 *  - it adds no skill to any capability view, so the MODEL-facing listing
 *    (`PromptBuilder.buildSkillListingPart`) and the model invocation path
 *    (`BaseAgent.extractModelSkillInvocations`) are untouched: the alias is a
 *    user-only surface, exactly as the skill it points at is.
 *
 * `skill` is the bare LOGICAL name of the target, matched against the name the
 * selection loop actually handed out — a target that lost the bare name (or was
 * only offered under a directory-qualified one) contributes no alias.
 */
export const SKILL_SLASH_COMMAND_ALIASES: ReadonlyArray<{ alias: string; skill: string }> = [
  { alias: 'review', skill: 'code-review' },
];

/**
 * Pick the skills that should appear in the `/` menu, in a deterministic order.
 *
 * Three rules:
 *  - `user-invocable: false` hides the skill from the menu (the model can still
 *    invoke it). Absent means the documented default, `true`.
 *  - a `skillOverrides` state of `"off"` hides it too, and ONLY `"off"`:
 *    `skills.md:667`-`:672` keeps `"name-only"` and `"user-invocable-only"` in
 *    the `/` menu, description and all. `:676` widens `"off"` to "the command
 *    lists advertised to Remote Control clients and to Agent SDK callers, not
 *    only the terminal `/` menu" — in this fork those collapse to the single
 *    `workspace:listCustomSlashCommands` RPC, whose only skill feed is
 *    `SessionManager.skillSlashCommands`, so this one `continue` covers the
 *    whole sentence.
 *  - `reservedNames` wins: a name already reserved by something a skill may not
 *    displace stays reserved. This used to include explicit command files, and
 *    that was backwards — `skills.md:122` and `slash-commands.md:122`, whole
 *    line, end with "if a skill and a command share a name, the skill takes
 *    precedence", and `claude-directory.md:293` says the same in its own words.
 *    A command file is now filtered OUT by the caller instead (R75 · f144);
 *    what remains reserved is workflow-recipe names, a surface no Claude page
 *    covers either way, so the pre-existing behaviour is kept rather than
 *    invented anew.
 *
 * A NESTED skill that lost the bare name is offered under its directory-qualified
 * name instead of being dropped (R79). `skills.md:132`, whole line: "Typing
 * `/deploy` runs the project-root skill. Type the qualified name
 * `/apps/web:deploy` to run the nested variant explicitly." Before this, the
 * collision loser left the menu entirely and the only way to reach it was to type
 * its internal capability key, which is shown nowhere.
 *
 * The qualified form is chosen from `selectedAsUnqualifiedAlias`, NOT from
 * whether the bare name happens to be taken by the time the loop reaches this
 * entry: the resolver already decided who owns the short name, and re-deciding it
 * from iteration order is how the two would drift apart.
 */
export function selectSkillSlashCommands(
  skills: readonly SkillSlashCommandInput[],
  reservedNames: Iterable<string>,
): SkillSlashCommand[] {
  const taken = new Set(reservedNames);
  const selected: SkillSlashCommand[] = [];
  for (const skill of skills) {
    if (skill.userInvocable === false) continue;
    if (skillOverrideHidesFromCommandLists(skill.overrideState)) continue;
    const qualified = skill.directoryQualifier && !skill.selectedAsUnqualifiedAlias
      ? `${skill.directoryQualifier}:${skill.logicalName}`
      : undefined;
    const name = qualified ?? skill.logicalName;
    if (taken.has(name)) continue;
    taken.add(name);
    // The reference the body expands to must be what the invocation path
    // resolves: the short alias when the resolver selected it, the qualified
    // name for a nested variant, and the raw capability key otherwise.
    const reference = skill.selectedAsUnqualifiedAlias
      ? skill.logicalName
      : qualified ?? skill.key;
    selected.push({
      id: skillSlashCommandId(name),
      name,
      label: `/${name}`,
      body: skillSlashCommandBody(reference),
      ...(skill.description ? { description: skill.description } : {}),
    });
  }
  // Aliases ({@link SKILL_SLASH_COMMAND_ALIASES}) run as a SECOND pass over the
  // names nothing else claimed. Second, not inline: a real skill named `review`
  // and a reserved workflow recipe must both keep the bare name whatever order
  // they arrived in, and deciding that from iteration order is how a `/review`
  // a user already had would silently change meaning.
  // Resolved against a snapshot taken BEFORE the first alias is pushed, so an
  // alias can only ever point at a real skill — a second table entry naming the
  // first one's alias resolves to nothing instead of chaining off table order.
  const skillEntries = [...selected];
  for (const { alias, skill: targetName } of SKILL_SLASH_COMMAND_ALIASES) {
    if (taken.has(alias)) continue;
    const target = skillEntries.find(entry => entry.name === targetName);
    if (!target) continue;
    taken.add(alias);
    // Spread, so body and description stay the target's byte-for-byte; only the
    // three identity fields are re-minted.
    selected.push({ ...target, id: skillSlashCommandId(alias), name: alias, label: `/${alias}` });
  }
  return selected.sort((a, b) => a.name.localeCompare(b.name));
}
