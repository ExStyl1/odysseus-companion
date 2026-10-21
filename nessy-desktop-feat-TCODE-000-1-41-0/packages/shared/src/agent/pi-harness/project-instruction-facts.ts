/**
 * The project's own instructions, as a BOUNDED slice the safety judge can weigh
 * (P6.203, denominator A30).
 *
 * ## Why it exists
 *
 * The guardian consult context carried `toolName`, `input`, `cwd`,
 * `workspaceRoot`, `guardian`, the mode and its version, the git branch and the
 * working tree — and nothing about what the project itself says. So a
 * repository whose `AGENTS.md` says *"never force push"* was honoured by the
 * agent and invisible to the judge that rules on the agent's actions. Measured
 * before this module: in `prompts/guardian.ts`, `CLAUDE.md` 0, `AGENTS.md` 0,
 * `memory` 0, `projectInstructions` 0, against `hard_deny` 6 / `soft_deny` 6 /
 * `environment` 9 as positive controls.
 *
 * ## Native mechanism
 *
 * None on any runtime. Pi's guardian consult context is ours; claude's
 * classifier is inside the closed binary and is silenced by A1; codex's
 * `[auto_review].policy` is an operator config blob, unconnected to AGENTS.md.
 * Host-side, once, for the one runtime that has a judge — case (3) of
 * native-first, recorded rather than assumed.
 *
 * ## Two reasons for the bound, and they pull the same way
 *
 * **Token cost.** This text is prepended to EVERY borderline consult, and a
 * consult can fire many times in one turn. The memory stack is unbounded by
 * construction — an instruction file can import siblings, and this repository's
 * own `AGENTS.md` is tens of kilobytes. Shipping the whole stack would make the
 * judge cost a multiple of the action it is judging.
 *
 * **Injection surface.** Instruction files are REPOSITORY-authored, so cloning a
 * hostile repository is enough to put arbitrary text in front of the judge. The
 * bound limits how much of that text a repository can spend, and the one-way
 * clause in {@link GUARDIAN_POLICY_PROMPT} limits what it can do with it: a
 * project instruction may make the judge more cautious and can never authorize
 * anything. That is why the slice is rendered inside `<untrusted>` markers
 * rather than beside the trusted policy rules.
 *
 * ## What is selected, and what is deliberately not
 *
 * PROJECT-scoped instruction layers only. A `global` layer is the user's own
 * machine-wide file — trusted, but not what this row is about — and a `builtin`
 * layer is ours. Selecting by scope rather than by filename also means the
 * selection follows whatever the capability inventory decided is a project
 * instruction, instead of a second hard-coded list of file names that would
 * drift from it.
 *
 * A layer whose read FAILS is skipped rather than reported empty: an
 * unreadable instruction file must never look like a project that said nothing.
 */

/** The slice as the judge is given it. */
export interface GuardianProjectInstructions {
  /** The files the text came from, in the order they were spent, capped. */
  sources: string[];
  /** The concatenated bodies, capped at {@link PROJECT_INSTRUCTION_SLICE_CHARS}. */
  text: string;
  /** True when any body was cut, or any project layer did not fit at all. */
  truncated: boolean;
}

/**
 * How much of the project's instructions reach the judge.
 *
 * Sized against its neighbours in `GUARDIAN_INPUT_CAPS` rather than picked:
 * trusted user intent gets 4000 and admin policy prose 6000, so an UNTRUSTED,
 * repository-authored input gets less than either. See the docblock for why
 * both the token cost and the injection surface argue for the same bound.
 */
export const PROJECT_INSTRUCTION_SLICE_CHARS = 3000;

/** How many files the slice will name. Small: the judge needs provenance, not an index. */
export const PROJECT_INSTRUCTION_SOURCE_LIMIT = 5;

/** The minimum a single file gets before the budget is called spent. */
const MIN_USEFUL_BODY_CHARS = 200;

/**
 * The shape the slice needs, restated structurally so this module imports no
 * capability type.
 *
 * Both fields are optional because a layer's resource is a UNION: a native
 * resource carries `scope` and `absolutePath`, and a plugin-bundle resource
 * carries neither. A plugin's instruction file is therefore not project-scoped
 * by this selector and never enters the slice — which is the right answer as
 * well as the type-safe one: a plugin's own prose is not the project speaking.
 */
interface InstructionLayerLike {
  key: string;
  resource: {
    /**
     * The one field BOTH arms of the union carry. Present so this is not a
     * "weak type" — a shape of only optional properties matches nothing, which
     * is how the first draft of this interface silently rejected the real
     * layer list.
     */
    contentHash: string;
    scope?: { kind?: string } | undefined;
    absolutePath?: string | undefined;
  };
}

/**
 * Build the slice from the capability runtime's instruction layers.
 *
 * The budget is spent in the layers' own order, which is the inventory's
 * precedence order, so the nearest instructions survive truncation and the
 * furthest are the ones dropped. A layer that would get less than
 * {@link MIN_USEFUL_BODY_CHARS} is dropped whole rather than reduced to a
 * fragment the judge would have to guess at — and `truncated` says so either
 * way, because "there is more" is the fact the judge needs, not which byte it
 * stopped at.
 */
export async function sliceProjectInstructions<L extends InstructionLayerLike>(input: {
  layers: readonly L[];
  readText: (layer: L) => Promise<string>;
  limit?: number;
  sourceLimit?: number;
}): Promise<GuardianProjectInstructions | undefined> {
  const limit = input.limit ?? PROJECT_INSTRUCTION_SLICE_CHARS;
  const sourceLimit = input.sourceLimit ?? PROJECT_INSTRUCTION_SOURCE_LIMIT;
  const projectLayers = input.layers.filter(layer => layer.resource.scope?.kind === 'project');
  if (projectLayers.length === 0) return undefined;

  const sources: string[] = [];
  const parts: string[] = [];
  let spent = 0;
  let truncated = false;

  for (const layer of projectLayers) {
    if (sources.length >= sourceLimit) { truncated = true; break; }
    const remaining = limit - spent;
    if (remaining < MIN_USEFUL_BODY_CHARS) { truncated = true; break; }

    let body: string;
    try {
      body = (await input.readText(layer)).trim();
    } catch {
      // Skipped, not reported empty — see the docblock.
      continue;
    }
    if (!body) continue;

    const name = layer.resource.absolutePath ?? layer.key;
    if (body.length > remaining) {
      parts.push(`# ${name}\n${body.slice(0, remaining)}`);
      sources.push(name);
      truncated = true;
      spent = limit;
      break;
    }
    parts.push(`# ${name}\n${body}`);
    sources.push(name);
    spent += body.length + name.length + 3;
  }

  if (parts.length === 0) return undefined;
  return { sources, text: parts.join('\n\n'), truncated };
}
