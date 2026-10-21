/**
 * **C3.181 (QL4, owner answer 2026-09-11: "claude's auto-memory enabled where
 * the SDK ships it") — the claude runtime's own auto memory: whether it is on
 * for this session, and where its files land.**
 *
 * ## Nothing is enabled here, because nothing needed enabling
 *
 * Native-first, asked and answered: the SDK's auto memory is ON by default and
 * the host has never turned it off except on purpose. `applyAutoMemoryOffSwitch`
 * (`packages/shared/src/agent/options.ts`) writes ONE direction —
 * `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` when this chat's memory scope is closed —
 * and writes NOTHING when memory is on, because `'0'` does not mean "permitted":
 * it FORCES memory on over the user's own `autoMemoryEnabled: false`. So on an
 * ordinary session the runtime's own resolution stands, and
 * `memory.md#enable-or-disable-auto-memory` says what that resolution is:
 * *"Auto memory is on by default."*
 *
 * The open half was never the switch. It is that the files land in a directory
 * NO host surface names, so a user cannot tell that the claude runtime is
 * keeping notes, where they are, or how to read them. This module is that
 * sentence, and it is deliberately only a sentence: a reader, not a second
 * memory store beside the runtime's.
 *
 * ## Where they land, and why the answer is OURS to state
 *
 * `memory.md#storage-location`: *"Each project gets its own memory directory at
 * `~/.claude/projects/<project>/memory/`. The `<project>` path is derived from
 * the git repository, so all worktrees and subdirectories within the same repo
 * share one auto memory directory. Outside a git repo, the project root is used
 * instead."* — and the sentence that makes the root
 * ours rather than the user's home: *"If you set `CLAUDE_CODE_PROJECT_DIR_NAME`
 * beside `CLAUDE_CONFIG_DIR`, Claude Code uses that name as the `<project>`
 * directory under `<config dir>/projects/` instead"*. This app sets
 * `CLAUDE_CONFIG_DIR` per Workspace (`options.ts`, the block above
 * `applyAutoMemoryOffSwitch`), so the tree is per-Workspace and durable: it
 * outlives the session, unlike codex's home, which is minted per runtime and
 * deleted at teardown.
 *
 * Two things this module states rather than computes, because computing them
 * would be inventing:
 *
 *  - **The `<project>` leaf — and C3.349, the half of the rule this module used
 *    to drop.** `memory.md#storage-location` states it in TWO clauses and only
 *    the first was quoted here: *"The `<project>` path is derived from the git
 *    repository, so all worktrees and subdirectories within the same repo share
 *    one auto memory directory. Outside a git repo, the project root is used
 *    instead."* The second clause is the one that governs a session with no
 *    project, and omitting it made this module's sentence read as a promise of
 *    stability in exactly the case where there is none.
 *
 *    C5.27 measured what that costs, live on the packaged 1.37.0 build: a second
 *    session on the SAME working directory reads the memory back, while on a
 *    working directory of the session's own the next session answers `NONE` —
 *    five of six leaves on that profile were empty. The vendored binary agrees
 *    with the page rather than with the old sentence: its own schema text for
 *    `autoMemoryDirectory` gives the default as
 *    `~/.claude/projects/<sanitized-cwd>/memory/` (quoted whole in `options.ts`
 *    `applyAutoMemoryOffSwitch`), and the project-dir resolver in the same
 *    bundle reads the resolved DIRECTORY, taking the pinned name as its only
 *    override — matched by content, never by a minified symbol.
 *
 *    We still do not reproduce the derivation — a wrong leaf is worse than an
 *    honest parent — so the sentence names the parent and now states BOTH arms
 *    of the rule instead of the one that flatters it.
 *  - **The pin this module REFUSES, which is C3.349's other option.** The same
 *    page section offers the mechanism that would give a project-less session a
 *    shared leaf: *"If you set `CLAUDE_CODE_PROJECT_DIR_NAME` beside
 *    `CLAUDE_CONFIG_DIR`, Claude Code uses that name as the `<project>`
 *    directory under `<config dir>/projects/` instead, whichever repository you
 *    launch it in, so projects launched with that config directory share one
 *    auto memory directory."* Read that last clause against this app's shape and
 *    it is a regression rather than a fix: `CLAUDE_CONFIG_DIR` here is per
 *    WORKSPACE, so a pin would merge the auto memory of every project in a
 *    workspace into one directory and break the case C5.27 measured WORKING.
 *    Pinning it only for a project-less session would mean deciding
 *    "project-less" ourselves, which is precisely the derivation the bullet
 *    above refuses to reproduce. So the honest shape is the sentence, and this
 *    paragraph exists so the next reader does not close the gap by setting the
 *    variable.
 *  - **A relocation we do not make.** *"To store auto memory in a different
 *    location, set `autoMemoryDirectory` in your `settings.json`."* That key is
 *    read from the user's own Claude settings, which we neither write nor read;
 *    the host's own `autoMemoryDirectory` (`config/storage.ts`
 *    `getAutoMemoryDirectory`) governs the HOST store and is not projected into
 *    the child. Two keys, one name, two stores — said out loud here because a
 *    user who sets ours and expects the child to follow would otherwise find out
 *    by not finding a file.
 *
 * ## Measured, so this is not a page reading alone
 *
 * The vendored bundle at SDK `0.3.247` / claudeCodeVersion `2.1.247`
 * (`node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`). The first
 * reading (2026-09-11) used `grep -ac`, which counts matching LINES, and on a
 * minified artefact that is not the number it looks like: re-measured 2026-09-12
 * with `grep -ao <name> <file> | wc -l` (OCCURRENCES), three of the six move —
 * `autoMemoryDirectory` 4 lines but **9** occurrences, `MEMORY.md` 8 but **12**,
 * `autoMemoryEnabled` 5 but **6**, while `CLAUDE_CODE_PROJECT_DIR_NAME` (**6**),
 * `CLAUDE_CODE_DISABLE_AUTO_MEMORY` (**4**) and `tengu_memdir_disabled` (**2**)
 * agree on both instruments. Negative control `nessyNotARealSdkKey` → **0** on
 * both. Nothing in this module's reasoning turns on the magnitudes — they are
 * presence readings — but the instrument is named so the next reader does not
 * compare a line count with an occurrence count and record a change that is not
 * one. The gate itself was extracted at `2.1.223` and is quoted in
 * `applyAutoMemoryOffSwitch`'s docblock; the two readings agree, which is why the
 * ON arm below is "the runtime decides" rather than a claim that it is on.
 *
 * C3.255 pins the project-dir naming this whole section rests on against the
 * vendored `sdk.mjs` — see the second `describe` of `claude-auto-memory.test.ts`.
 *
 * **What is NOT measured, and is therefore not claimed:** that a real gateway
 * session PRODUCES a memory file. That needs a live sitting — the model decides
 * what is worth remembering, and `memory.md` says so: *"Claude doesn't save
 * something every session."* The honest verdict is the disposition, and the
 * live check belongs in the CDP checklist.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The one variable that decides it, and the one this host writes.
 *
 * Kept beside {@link buildClaudeSessionMemoryEnv}'s spelling in
 * `session-memory-scope.ts` on purpose: a rename there that missed this reader
 * would make the sentence describe a switch nobody flips, so
 * `claude-auto-memory.test.ts` asserts the two agree.
 */
export const CLAUDE_AUTO_MEMORY_ENV_VAR = 'CLAUDE_CODE_DISABLE_AUTO_MEMORY';

/** `<config dir>/projects/<project>/memory/` — the two fixed segments of it. */
export const CLAUDE_AUTO_MEMORY_PROJECTS_DIR_NAME = 'projects';
export const CLAUDE_AUTO_MEMORY_LEAF_DIR_NAME = 'memory';

/** Where the runtime looks when `CLAUDE_CONFIG_DIR` is not set for the child. */
export const CLAUDE_DEFAULT_CONFIG_DIR_NAME = '.claude';

export type ClaudeAutoMemoryState =
  /** This host closed it for this chat: the variable is set to something truthy. */
  | 'off-by-host'
  /** `'0'` is present, which the runtime reads as "force memory on". We never write it. */
  | 'forced-on'
  /** Nothing is written, so the runtime's own resolution decides — its default is on. */
  | 'runtime-default';

export interface ClaudeAutoMemoryDisposition {
  readonly state: ClaudeAutoMemoryState;
  /**
   * `<config dir>/projects` — the PARENT of the per-project leaf, never the leaf
   * itself. See the module docblock for why the leaf is not derived here.
   */
  readonly projectsRoot: string;
  /** True when `projectsRoot` came from the child's own `CLAUDE_CONFIG_DIR`. */
  readonly fromConfigDir: boolean;
  /** The operator-facing line; one sentence per fact, never empty. */
  readonly sentence: string;
}

/**
 * Resolve the disposition from the environment the claude child is given.
 *
 * The child env is the honest input: it is exactly what decides, it already
 * carries this session's `CLAUDE_CONFIG_DIR`, and it is what
 * `applyAutoMemoryOffSwitch` wrote into.
 *
 * The runtime's own truthiness test is not reproduced — we classify `'0'` as the
 * force-on arm (its documented meaning, confirmed in the extracted gate) and any
 * other non-empty value as off, which is the direction of least memory for a
 * value we did not write. An empty string is treated as unset, the same as
 * absent.
 */
export function resolveClaudeAutoMemoryDisposition(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeAutoMemoryDisposition {
  const raw = env[CLAUDE_AUTO_MEMORY_ENV_VAR];
  const configDir = env.CLAUDE_CONFIG_DIR;
  const fromConfigDir = typeof configDir === 'string' && configDir.length > 0;
  const projectsRoot = join(
    fromConfigDir ? (configDir as string) : join(homedir(), CLAUDE_DEFAULT_CONFIG_DIR_NAME),
    CLAUDE_AUTO_MEMORY_PROJECTS_DIR_NAME,
  );
  const where = `${projectsRoot}/<project>/${CLAUDE_AUTO_MEMORY_LEAF_DIR_NAME}/`;
  // C3.349 — BOTH clauses of `memory.md#storage-location`, because the second one
  // is the one a session with no project lands in. See the module docblock.
  const leaf = 'the <project> leaf is the runtime\'s: inside a git repository it is derived from '
    + 'the repository, so every worktree of one repository shares one directory, and outside one '
    + 'the project root is used instead — so a session running somewhere of its own keeps its '
    + 'memory to itself, and the next session started elsewhere reads none of it';
  const relocation = 'Setting autoMemoryDirectory in your own Claude settings moves them; this '
    + "app's setting of the same name governs its OWN memory store and is not projected into the "
    + 'child.';

  let state: ClaudeAutoMemoryState;
  let sentence: string;
  if (raw === '0') {
    state = 'forced-on';
    sentence = '[claude auto memory] FORCED ON for this session: '
      + `${CLAUDE_AUTO_MEMORY_ENV_VAR}=0 is present in the environment, which the runtime honours `
      + 'over its own `autoMemoryEnabled` setting and over this app\'s memory switch. This app '
      + `never writes that value. Memory files are written under ${where} — ${leaf}. ${relocation}`;
  } else if (raw !== undefined && raw !== '') {
    state = 'off-by-host';
    sentence = '[claude auto memory] OFF for this session: this app sets '
      + `${CLAUDE_AUTO_MEMORY_ENV_VAR}=${raw} because memory is off for this chat, and the runtime `
      + 'then neither creates nor loads auto-memory files. Anything written by an earlier session '
      + `is still on disk under ${where}.`;
  } else {
    state = 'runtime-default';
    sentence = '[claude auto memory] ON unless your own Claude settings turn it off: this app '
      + `writes no ${CLAUDE_AUTO_MEMORY_ENV_VAR}, so the runtime's own resolution stands and its `
      + `default is on. It writes a MEMORY.md index plus one topic file per memory under ${where} — `
      + `${leaf}. That directory outlives the session and nothing in this app reads it. ${relocation}`;
  }
  return { state, projectsRoot, fromConfigDir, sentence };
}

/** The sentence alone, for a caller that only wants to say it. */
export function describeClaudeAutoMemory(env: NodeJS.ProcessEnv = process.env): string {
  return resolveClaudeAutoMemoryDisposition(env).sentence;
}
