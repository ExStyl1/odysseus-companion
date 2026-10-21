import { BUILTIN_AGENT_DEFINITIONS } from '../agents/definitions.ts'

/**
 * **P6.605 — the bundled `reviewer` reaches the codex role writer.**
 *
 * P6.485 built the writer half under owner decision Q17(b): a role whose tool
 * grant codex cannot honour is declared anyway when its name is in the writer's
 * own narrow exception set, and it carries a read-only obligation as prose. What
 * was missing is the PROJECTION — nothing ever handed the writer a bundled
 * definition, so `/code-review` on codex still spawned an unnamed agent with the
 * parent's full tools, and the one agent name that exists on all three runtimes
 * did not exist on one of them.
 *
 * This is the codex twin of {@link buildClaudeRuntimeBuiltinAgents}, which
 * closed the identical hole for claude (P3.277) — same four bundled
 * definitions, same reason, different runtime shape.
 *
 * ## Why ONE of the four, and not all four
 *
 * `CodexConfigOptions.agents` goes through a gate that DENIES any descriptor
 * carrying `tools` or `disallowedTools`, because codex has no per-role tool
 * policy to narrow with and declaring such a role would hand the child the
 * parent's whole surface. All four bundled definitions carry `tools`. The
 * writer's exception is BY NAME and holds exactly one name, `reviewer`, for the
 * reason recorded at that set: it is a role we bundle and we invoke, and the
 * deny was preserving a restriction nobody was enforcing.
 *
 * So projecting all four would declare `reviewer` and produce a per-session
 * user-facing denial notice for `scout`, `planner` and `worker` — three notices
 * naming a capability nobody had on codex either before or after, on every
 * session. Honest and useless. Projecting the one the writer can accept is the
 * smaller honest thing, and the coupling is stated rather than hidden: **the day
 * the writer's exception set grows a name, this filter has to grow the same
 * name**, and the integration test in
 * `__tests__/codex-builtin-reviewer-role.test.ts` fails if the two disagree,
 * because it drives the real writer.
 *
 * ## The shape is the writer's SUBSET, deliberately
 *
 * `CodexAgentRoleDescriptor` is a subset of
 * `PiRuntimeAgentDefinitionDescriptor` — the writer says so at its own field —
 * so this returns only the members the role layer reads. Nothing here
 * synthesises a `sha256` or a `definitionDigest`: those belong to a capability
 * resource loaded from disk and hash-verified, and a bundled constant has
 * neither a file nor a revision. Inventing values for them would put a fake
 * provenance into the one structure whose purpose is provenance.
 */
export const CODEX_BUILTIN_ROLE_NAMES: readonly string[] = Object.freeze(['reviewer'])

/** The members of `CodexAgentRoleDescriptor` a bundled definition can fill. */
export interface CodexBuiltinRoleDescriptor {
  readonly key: string
  readonly name: string
  readonly selectedAsUnqualifiedAlias: boolean
  readonly description: string
  readonly systemPrompt: string
  readonly tools: readonly string[]
}

/**
 * The bundled roles to declare on a codex session, in the writer's own shape.
 *
 * `key` is prefixed `builtin:` so it can never collide with a workspace or
 * project definition's fully qualified key.
 *
 * `selectedAsUnqualifiedAlias` is **`true`, and it has to be** — this was
 * measured wrong first and the wrong answer looked right. The writer derives the
 * role name as `descriptor.selectedAsUnqualifiedAlias ? descriptor.name :
 * descriptor.key`, then sanitizes it to `[A-Za-z0-9_-]`. With `false` the
 * bundled role would be declared as **`builtin_reviewer`**: it would not match
 * the writer's by-name exception (so it would be denied outright), and even past
 * that gate it would not be the name `/code-review` spawns — which is the entire
 * point of the row, one agent name existing on all three runtimes.
 *
 * The collision with a user's own `.claude/agents/reviewer.md` is settled by
 * ORDER instead, and that is the call site's obligation: the writer's
 * `claimed` gate denies whichever definition arrives SECOND, so this list is
 * spread **after** the session's own definitions. A user who authored a reviewer
 * keeps it, exactly as on Pi and claude, and the bundled one is denied with a
 * legible reason rather than silently shadowing it.
 */
export function codexBuiltinRoleDescriptors(): readonly CodexBuiltinRoleDescriptor[] {
  return Object.freeze(
    BUILTIN_AGENT_DEFINITIONS
      .filter(definition => CODEX_BUILTIN_ROLE_NAMES.includes(definition.name))
      .map(definition => Object.freeze({
        key: `builtin:${definition.name}`,
        name: definition.name,
        selectedAsUnqualifiedAlias: true,
        description: definition.description,
        systemPrompt: definition.systemPrompt,
        // Carried, not dropped, and that is the point: the grant is what makes
        // the writer prepend the read-only obligation. A projection that omitted
        // `tools` would produce a `reviewer` codex declares with no obligation
        // at all — the one outcome worse than not declaring it.
        tools: definition.tools,
      })),
  )
}
