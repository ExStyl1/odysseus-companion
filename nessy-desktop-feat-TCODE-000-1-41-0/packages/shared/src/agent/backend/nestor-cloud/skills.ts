import type { RuntimeSkillHandle } from '../../../capabilities/views.ts';
import {
  skillOverrideHidesDescriptionFromModel,
  skillOverrideHidesFromModelListing,
  skillOverrideRefusesInvocation,
} from '../../../config/skill-overrides.ts';
import type { NestorSkillMetadata } from './metadata-builder.ts';

/**
 * `codeagent/skills.go:59-61` — `isSkillRegistryErrorResponse` greps the tool
 * result TEXT for this exact prefix, and `deduplicateSkillsInHistory` uses the
 * answer to decide whether the skill counts as activated. A failure reported any
 * other way (in particular through the A2A tool-result `error` field, which the
 * backend rewrites into `<tool_error>…` — `mapping/tool_result.go:11-17`) marks
 * the skill activated for the rest of the conversation: every later activation
 * of the SAME name is then replaced with "Skill content is already loaded" and
 * the model never receives the instructions.
 *
 * The literal is the backend's, typo included. Do not "fix" it.
 */
export const NESTOR_SKILL_FAILURE_PREFIX = 'Skills registry has throw an error:';

/**
 * Per-entry description bound, borrowed from the model-facing listing
 * (`core/prompt-builder.ts:SKILL_LISTING_DESCRIPTION_MAX_CHARS`). Here it also
 * protects the request byte budget: this metadata rides EVERY message to the
 * remote agent, and the gateway rejects a request over 500,000 bytes.
 */
const SKILL_DESCRIPTION_MAX_CHARS = 180;

/**
 * `SkillV1.Description` is `validate:"required"`
 * (`a2aextensions/skills_extension.go:18-21`), and one item that fails
 * validation does not merely drop itself — `parseVersionedMetaSlice` runs
 * `MapToValuesUntilFirstErr`, so the FIRST invalid entry aborts the decode and
 * the model loses the whole skill list. An entry therefore always carries a
 * non-empty description, whatever the author (or `skillOverrides`) left.
 */
const SKILL_DESCRIPTION_FALLBACK = 'No description provided.';

export interface NestorSkillActivation {
  body: string;
  /** Absent when the materializer cannot resolve one; the line is then omitted. */
  directory?: string;
  resources?: readonly string[];
  /**
   * The author's `disallowed-tools` (`skills.md:262`). Nothing on this backend can
   * enforce it — the model runs remotely and picks its own tools — so it is STATED
   * on the same rail `paths` is stated on rather than dropped in silence.
   */
  disallowedTools?: readonly string[];
}

/**
 * The reference the model must send back in `activate_skill.skill_name`.
 *
 * Mirrors `core/prompt-builder.ts:skillListingReference` — the short alias when
 * the resolver selected it, the directory-qualified name for a nested skill that
 * did not get the short one, otherwise the fully-qualified key. That function is
 * module-private, so this is a second speller of the rule; {@link selectNestorCloudSkill}
 * accepts ALL THREE forms so an advertise/resolve disagreement cannot make a
 * skill unactivatable.
 */
export function nestorSkillReference(skill: RuntimeSkillHandle): string {
  if (skill.selectedAsUnqualifiedAlias) return skill.logicalName;
  if (skill.directoryQualifier) return `${skill.directoryQualifier}:${skill.logicalName}`;
  return skill.key;
}

/**
 * `metadata.skills` for the remote agent — the half of F4 that gives the model
 * something to activate. The backend renders these as
 * `- **<name>**: <description>` and instructs the model to "Use the exact skill
 * name as listed below" (`codeagent/prompt_builder.go:132-137`).
 *
 * The invocability filter is the SAME pair the local model-facing listing
 * applies (`core/prompt-builder.ts:buildSkillListingPart`), so what is advertised
 * here and what {@link selectNestorCloudSkill} will activate cannot drift.
 * Sorted by key for the same reason the listing is: a stable byte sequence on a
 * payload that rides every message.
 */
export function buildNestorCloudSkillMetadata(
  skills: readonly RuntimeSkillHandle[] | undefined,
): NestorSkillMetadata[] | undefined {
  const advertised = (skills ?? [])
    .filter(skill => skill.disableModelInvocation !== true)
    .filter(skill => !skillOverrideHidesFromModelListing(skill.overrideState))
    .slice()
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(skill => ({
      name: nestorSkillReference(skill),
      description: advertisedDescription(skill),
    }));
  return advertised.length > 0 ? advertised : undefined;
}

function advertisedDescription(skill: RuntimeSkillHandle): string {
  const authored = skillOverrideHidesDescriptionFromModel(skill.overrideState)
    ? ''
    : skill.description ?? '';
  const flattened = authored.replace(/\s+/g, ' ').trim();
  const bounded = flattened.length > SKILL_DESCRIPTION_MAX_CHARS
    ? `${flattened.slice(0, SKILL_DESCRIPTION_MAX_CHARS - 1)}…`
    : flattened;
  // `skills.md:267` — `paths` limits AUTOMATIC activation. This backend runs the
  // model remotely and nothing here can see which file the turn is working with,
  // so the constraint is STATED on the same annotation rail the local listing
  // uses rather than enforced.
  const paths = skill.paths?.length ? ` [only while working with ${skill.paths.join(' ')}]` : '';
  return `${bounded || SKILL_DESCRIPTION_FALLBACK}${paths}`;
}

/**
 * Resolve an `activate_skill.skill_name` back onto a skill this session may let
 * the MODEL invoke. Returns `undefined` for an unknown name and for a skill the
 * model is refused — a guessed slug must not walk past
 * `disable-model-invocation` or a `skillOverrides` state (`skills.md:676`).
 */
export function selectNestorCloudSkill(
  skills: readonly RuntimeSkillHandle[] | undefined,
  requestedName: string,
): RuntimeSkillHandle | undefined {
  const wanted = requestedName.trim();
  if (!wanted) return undefined;
  const match = (skills ?? []).find(skill => wanted === skill.key
    || wanted === nestorSkillReference(skill)
    || (skill.directoryQualifier && wanted === `${skill.directoryQualifier}:${skill.logicalName}`)
    || (skill.selectedAsUnqualifiedAlias && wanted === skill.logicalName));
  if (!match) return undefined;
  if (match.disableModelInvocation === true) return undefined;
  if (skillOverrideRefusesInvocation(match.overrideState, 'model')) return undefined;
  return match;
}

/**
 * The reference connector's envelope, byte-for-byte
 * (`nessy-acp-agent/src/tools/activate-skill/local.ts:21-25`, same string in the
 * VS Code plugin's `activateSkill.ts:47-55`). The backend does not parse it —
 * the model does — so matching the connector is what makes the remote system
 * prompt's skill protocol read the way it was written for.
 *
 * The directory line is dropped when the materializer cannot resolve one:
 * `Skill directory: undefined` would send the model looking for a path that does
 * not exist, which is worse than not naming one.
 */
export function formatNestorSkillContent(
  activation: NestorSkillActivation & { name: string },
): string {
  const resources = activation.resources?.length
    ? `\n<skill_resources>\n${activation.resources.map(resource => `  <file>${resource}</file>`).join('\n')}\n</skill_resources>`
    : '';
  const directory = activation.directory
    ? `\n\nSkill directory: ${activation.directory}`
    : '';
  const disallowed = activation.disallowedTools?.length
    ? `\n\nDisallowed tools (author restriction, not enforced remotely): ${activation.disallowedTools.join(', ')}`
    : '';
  return `<skill_content name="${activation.name}">\n${activation.body}${directory}${disallowed}${resources}\n</skill_content>`;
}

/**
 * Undo the materializer's supporting-resource rewrite for a REMOTE reader.
 *
 * `materializeSupportingResources` replaces every supporting-file reference in
 * the body with an opaque `skill-resource:<hex>` handle
 * (`runtime-skill-content.ts:1175`). That handle is resolvable only through our
 * own capability runtime; the remote model's vocabulary is `read_file` and
 * friends (`codeagent/tools.go`), so a handle names a file it can never open.
 * Putting the author's relative path back makes the reference readable against
 * the `Skill directory:` line the same envelope carries.
 *
 * A pre-R17 snapshot entry has no `relativePath` — there is nothing to restore
 * to, so its handle is left exactly as it is rather than guessed at.
 */
export function restoreSkillResourcePaths(
  body: string,
  resources: readonly { handle: string; relativePath?: string }[] | undefined,
): string {
  let restored = body;
  for (const resource of resources ?? []) {
    if (!resource.relativePath) continue;
    restored = restored.split(resource.handle).join(resource.relativePath);
  }
  return restored;
}

/** @see NESTOR_SKILL_FAILURE_PREFIX — the prefix is load-bearing, not cosmetic. */
export function formatNestorSkillFailure(message: string): string {
  return `${NESTOR_SKILL_FAILURE_PREFIX} ${message}`;
}
