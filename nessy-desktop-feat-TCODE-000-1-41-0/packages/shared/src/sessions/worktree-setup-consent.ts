/**
 * Consent for `worktree.setupScript` — the card that gates a shell command
 * running inside a freshly created worktree.
 *
 * ## The seam this REUSES rather than re-inventing
 *
 * The workflow launch is the same trust family: a host-declared thing that
 * runs on the user's machine, shown before it runs, with a remember scoped to
 * BOTH the thing and the project. So the record store here IS
 * {@link WorkflowLaunchConsentStore} — the same class, the same positive-only
 * allowlist, the same "every read failure resolves to no consent recorded", the
 * same 0600 write, the same swallowed persist failure. Only the FILE differs,
 * and it has to: a remembered workflow launch must never be readable as a
 * remembered setup script. The class carries a workflow name in its parameter
 * names because the workflow launch introduced it; what it actually implements
 * is a project-scoped name allowlist, and a second copy of that with its own
 * failure semantics is exactly the drift this fork keeps paying for elsewhere.
 *
 * The prompt is the `workflow_launch` SHAPE too — a description plus the thing
 * being run, and deliberately NO `nonNegotiable`. This is a normal,
 * remember-able approval, not the `EnterWorktree` floor: the floor exists
 * because entering an out-of-namespace worktree moves the session's write
 * access somewhere the user never named, and it must not be clearable by a
 * rule. A setup script the user put in their OWN settings file is the opposite
 * case — they named it — so "don't ask again for this script in this project"
 * is a legitimate answer.
 *
 * ## Why the record is keyed on the SCRIPT, not on a name
 *
 * A workflow has a stable name and mutable contents; the remember is keyed on
 * the name because that is what the user recognises. A setup script has no
 * name at all — it IS its contents. Keying on anything else (the project alone,
 * a "setup" literal) would mean editing the script inherits the approval the
 * previous one earned, which is the whole attack: consent once to
 * `bun install`, then have `curl … | sh` run unprompted. So the name half of
 * the record is a digest of the exact string that will be executed.
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { CONFIG_DIR } from '../config/paths.ts'
import {
  WorkflowLaunchConsentStore,
  workflowConsentProjectKey,
} from '../workflows/workflow-launch-consent.ts'

/** How much of the script the card shows before eliding. */
const MAX_QUOTED_SCRIPT = 400

/**
 * The name half of the consent record: `setup:<sha256 of the script>`.
 *
 * Prefixed so a record file that is ever inspected by hand says what its
 * entries are, and hashed so the file never becomes a second copy of a command
 * line the user may consider private.
 */
export function worktreeSetupConsentName(script: string): string {
  return `setup:${createHash('sha256').update(script.trim(), 'utf8').digest('hex')}`
}

/**
 * The project half — the `<path>` in "don't ask again for this script in
 * `<path>`".
 *
 * The repository root IS the project for a worktree: every worktree of a
 * repository is created from it, so a consent granted while one worktree was
 * being made is honestly the same consent for the next one. It delegates to
 * `workflowConsentProjectKey` rather than calling `resolve` itself — that
 * function's contract is that there is exactly ONE derivation of a consent
 * project key, and a second normalization living here is precisely how a
 * remember gets written under one spelling of a path and looked up under
 * another. This wrapper exists only so the call site reads as worktree code.
 */
export function worktreeSetupConsentProjectKey(repoRoot: string): string {
  return workflowConsentProjectKey({ workspaceRootPath: repoRoot })
}

/**
 * The card text: what will run, where, and why it is being asked.
 *
 * The script is quoted so the user approves the actual string rather than a
 * description of it, elided past {@link MAX_QUOTED_SCRIPT} so a pathological
 * setting cannot push the prompt's own sentence off the card.
 */
export function describeWorktreeSetupConsent(input: {
  script: string
  worktreePath: string
}): string {
  const script = input.script.trim()
  const quoted = script.length > MAX_QUOTED_SCRIPT
    ? `${script.slice(0, MAX_QUOTED_SCRIPT)}…`
    : script
  return `Run this worktree setup script in ${input.worktreePath}?\n\n${quoted}\n\n`
    + 'It is declared by `worktree.setupScript` in your Nessy settings and runs as a shell'
    + ' command inside the new worktree, with whatever access this session already has.'
}

/**
 * The remember record for setup-script consent.
 *
 * Its own file next to the workflow one, for the reason in the module note.
 * `CONFIG_DIR` freezes at first import (`config/paths.ts`), which is why the
 * explicit `path` exists at all: a test cannot move the record by setting an
 * env var after the module loaded, and pointing two suites at one real config
 * directory is how a consent test starts passing for the wrong reason.
 */
export function createWorktreeSetupConsentStore(
  options: { path?: string } = {},
): WorkflowLaunchConsentStore {
  return new WorkflowLaunchConsentStore({
    path: options.path ?? join(CONFIG_DIR, 'worktree-setup-consent.json'),
  })
}
