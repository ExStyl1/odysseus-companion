/**
 * One rule, three consumers: **a fork is inside the parent's session scope, a
 * named subagent is outside it.**
 *
 * `sub-agents.md:1036` — "A fork inherits everything the main session has at the
 * moment it spawns. A named subagent starts from its own definition." Every
 * session-scoped input that reaches a child's system prompt has to land on the
 * right side of that line, and each of the three that did not was found by a
 * different unit looking at something else.
 */

/** Which kind of spawned child a session is; absent on a top-level session. */
export type PiChildKind = 'fork' | 'named';

/**
 * The output style a child's prompt is composed with.
 *
 * `sub-agents.md:933` — "**Output style**: a subagent runs its own system
 * prompt, so your [output style] doesn't shape its responses, except in a
 * [fork]." `output-styles.md:104` says the same from the other page: "Output
 * styles apply to the main conversation only … A fork is the exception, because
 * it inherits the parent's full system prompt."
 *
 * The read was global and unconditional, so the fork half was satisfied by
 * accident and the exclusion half was not implemented at all.
 */
export function resolveChildOutputStyleId(
  childKind: PiChildKind | undefined,
  sessionOutputStyleId: string | undefined,
): string | undefined {
  return childKind === 'named' ? undefined : sessionOutputStyleId;
}

/**
 * The session id that session-scoped MEMORY is read under.
 *
 * `sub-agents.md:1041` — a fork's "System prompt and tools" are "Same as main
 * session". Session memory lives at `<sessions>/<workspace>/<session>/data/
 * MEMORY.md`, so a fork reading its own fresh session id gets an empty file and
 * its prompt is the parent's minus that block — "nearly the same prompt", which
 * is also what breaks any prompt-cache-sharing claim (`:1046`).
 *
 * A named subagent keeps its own id. It starts from its own definition, and
 * handing it the parent's session memory would be the input isolation `:1004`
 * says a fork drops and a named subagent keeps.
 */
export function resolveMemorySessionId(
  config: { piChildKind?: PiChildKind; piParentSessionId?: string },
  ownSessionId: string,
): string {
  return config.piChildKind === 'fork' && config.piParentSessionId
    ? config.piParentSessionId
    : ownSessionId;
}
