/**
 * C4.24 (QL3, owner answer C, 2026-09-11) — the added folders' skills on codex.
 *
 * The WIRE is one request on a connection the session already holds:
 * `CodexAgent.syncCodexSkillExtraRoots` sends `skills/extraRoots/set`, and that
 * method's docblock carries the source readings (the params shape, codex's own
 * test settling that a member is a directory CONTAINING skill directories, the
 * `skills/changed` loop the memo prevents). This module carries the half that
 * has to be said rather than sent.
 */

/**
 * C4.24 (QL3, owner answer C, 2026-09-11) — the residue of the added-folder
 * skills flip, stated because the host's job is to make the residual difference
 * uniform or HONEST and this one CANNOT be made uniform.
 *
 * Measured at HEAD rather than assumed, and the reading is the one that makes
 * this sentence necessary: `additionalDirectories` has two documented meanings
 * and this fork sits across the seam (`capabilities/types.ts`, the
 * `additionalRuleDirectories` docblock and its `large-codebases.md` table).
 * `claude-agent.ts` hands our key to the SDK as the `additionalDirectories`
 * OPTION, and `permissions.md` says *"The SDK passes each entry to Claude Code
 * as `--add-dir`, so those directories behave like flag-added directories"* — so
 * on claude the roots load their own components at the child. On Pi it is the
 * SETTING, which `large-codebases.md` scores **"Never"** for skills, and the
 * host's own scan agrees: `capabilities/native-sources.ts` walks nested roots
 * under the project, never `getConfiguredAdditionalDirectories()`.
 *
 * So after this row the capability is present on claude (natively) and on codex
 * (through `skills/extraRoots/set`), and ABSENT on Pi — a real difference a user
 * meets only by switching, which is exactly the thing that has to be said rather
 * than shipped quietly.
 */
export const CODEX_SKILL_EXTRA_ROOTS_SWITCH_NOTE =
  'SKILLS FROM ADDED FOLDERS — this codex session was handed the skills directories of the folders you '
  + 'added, through codex\'s own skills/extraRoots/set, so their skills are available here. Claude does the '
  + 'same through --add-dir. PI DOES NOT: for Pi an added folder is the additionalDirectories setting, which '
  + 'loads no skills, so switching this session to Pi leaves those skills behind until you install them.';
