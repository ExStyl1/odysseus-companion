/**
 * UA3.2 — copied from craft-agents-oss `v0.13.4:packages/shared/src/tasks/generator-prompt.ts`, unchanged.
 *
 * Licence: the prompt text below is Apache-2.0 (craft-agents-oss, "Copyright 2026 Craft Docs Ltd." per its NOTICE),
 * carried verbatim as AGENTS.md "Adapted prompt/policy text" requires (permissive upstream; source and licence
 * recorded here).
 *
 * UA4.5 — adapted for Nessy's Generate mode (`rpc/tasks.ts` `tasks:generate`): ONE rule line is added to
 * {@link buildGeneratorPrompt} (marked NESSY below). The draft authors in `dontAsk` (`generate-limits.ts`), where a
 * write or a command no rule pre-approves is refused, and nothing it authors is saved until the user saves — so the
 * prompt tells the model to answer in its message rather than create the file or run anything. The repair prompt is
 * upstream's, unchanged.
 *
 * UB1.14 — the `depends_on` edge line and the `nodes.<id>.output` rule line are `v0.15.1:packages/shared/src/tasks/generator-prompt.ts`'s
 * (the edge "runs the dependent after the upstream node and hands it the upstream node's final reply"; an explicit
 * `${nodes.<id>.output}` places the reply and it is then not added again). The runner now honours both — `TaskRunner.upstreamReplies`.
 * Upstream's "Do not use tools" rule line is UB2.9's arm, not this row's.
 */
/**
 * Generator prompt for Generate mode (#2 / architecture §3a).
 *
 * The task's persistent orchestrator session is asked to AUTHOR a `task.yaml`
 * from a natural-language goal. The result is a human-editable artifact, so the
 * prompt is legibility-first (#7): bias toward the simplest graph that achieves
 * the goal, with clear titles and explicit dependencies — not the cleverest one.
 */
export function buildGeneratorPrompt(goal: string, title?: string): string {
  return [
    'You are authoring a `task.yaml` that decomposes a goal into a small DAG of subtasks.',
    'Each node becomes a child AI session; a `depends_on` edge runs the dependent after the upstream node and hands it the upstream node\'s final reply.',
    '',
    'Rules:',
    '- Output ONLY the YAML — no prose, no code fences, no explanation.',
    // UB2.9 (B4-14; upstream v0.15.1 verbatim): the authoring turn has a time limit and the
    // subtasks do the investigating — reads and searches burned the attempt's budget.
    '- Do not use tools (no file reads, searches, commands or source calls): write the YAML from the goal and the context you already have. The subtasks do the investigating, and this answer has a time limit.',
    // NESSY (UA4.5): the draft runs in `dontAsk` and nothing is saved until the user saves — answer in the message.
    '- Reply with the YAML in your message. Do not create or edit files and do not run commands: nothing is saved until the user reviews and saves the task.',
    '- Prefer the SIMPLEST graph that achieves the goal: few nodes, clear titles, explicit dependencies. A human will read and edit this.',
    '- Make nodes parallel (no `depends_on` between them) ONLY when the steps are genuinely independent.',
    '- To place an upstream result at a specific point in a prompt, write ${nodes.<id>.output} there (the reply is then not added again).',
    '- Every ${nodes.<id>.output} reference MUST point to an `id` that you actually declare under `nodes`. Never reference a node you did not create. Verify each reference resolves before emitting the YAML.',
    '- Add `acceptance_criteria`: a short, checkable rubric for the FINISHED task (what "done and correct" means). It is what you will grade the result against when the run finishes — make it concrete and testable, not a restatement of the goal.',
    '',
    'Schema:',
    '  id: kebab-case-slug',
    '  title: short human title',
    '  goal: one-line restatement of the goal',
    '  acceptance_criteria: a concrete, checkable definition of done for the whole task',
    '  nodes:',
    '    - id: kebab-id',
    '      title: short title (becomes the subtask/session name)',
    '      prompt: the full instruction for this subtask (may include ${nodes.<id>.output})',
    '      depends_on: [other-node-id]   # omit when the node has no dependencies',
    '',
    'Example:',
    '  id: migrate-auth',
    '  title: Migrate auth',
    '  goal: Migrate the auth layer to the new session model.',
    '  acceptance_criteria: All auth call sites use the new session API and the existing auth tests pass.',
    '  nodes:',
    '    - id: audit',
    '      title: Audit call sites',
    '      prompt: List every auth call site and how it is used.',
    '    - id: design',
    '      title: Design new auth',
    '      prompt: "Design the new session-based auth using the audit: ${nodes.audit.output}"',
    '      depends_on: [audit]',
    '',
    title ? `Working title: ${title}` : '',
    `Goal: ${goal}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Repair prompt for the auto-repair turn (Generate mode robustness).
 *
 * The orchestrator just authored a `task.yaml` that failed validation (commonly a
 * `${nodes.X.output}` reference to a node id it never declared). It still holds the
 * conversation, so we hand the concrete validation errors back and ask for a corrected
 * spec — same output contract as the original generation (YAML only).
 */
export function buildRepairPrompt(errors: { path: string; message: string }[]): string {
  return [
    'The task.yaml you produced failed validation with these errors:',
    ...errors.map((e) => `- ${e.path}: ${e.message}`),
    '',
    'Fix every error and output the COMPLETE corrected task.yaml.',
    'Most common cause: a ${nodes.<id>.output} reference whose <id> is not declared under `nodes`. Either add the missing node or change the reference to an id you actually declare.',
    // UB2.9 (B4-14; upstream v0.15.1): the repair turn is bound by the same no-tools rule.
    'Output ONLY the YAML — no prose, no code fences, no explanation. Do not use tools.',
  ].join('\n')
}
