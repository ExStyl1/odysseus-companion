/**
 * The instruction-file rules — ONE holder, because copies of this list drift.
 *
 * Every walk that decides which project instruction files steer the model reads
 * this module: the capability collector (`capabilities/native-sources.ts`), the
 * pre-trust preview (`capabilities/project-contribution-detect.ts`), the
 * nestor-cloud request metadata (`agent/backend/nestor-cloud/metadata-builder.ts`)
 * and the agent-definition scan's exclusion (`agents/definitions.ts`).
 *
 * **Why it is its own module (P3.241).** P6.35 added `AGENTS.override.md` and
 * its supersession to the collector, and two siblings did not learn it: the
 * nestor-cloud walk kept a fourth independent `AGENTS.md` ancestor walk of its
 * own, and `agents/definitions.ts` kept a second copy of the exclusion set. The
 * fix is not two more entries — it is that there is nothing left to keep in
 * sync. The shape follows `utils/tool-grant-list.ts`, which reached the same
 * conclusion for the same reason: a leaf whose only imports are `node:fs` and
 * `node:path`, with the former home RE-EXPORTING its names so existing readers
 * keep their import specifier. That weight constraint is load-bearing rather
 * than tidy — `agents/definitions.ts` is imported by
 * `packages/pi-agent-server/src/orchestrator/*` through `agents/index.ts`, so an
 * edge into the collector would have loaded `gray-matter`, the permission
 * parser and the MCP stack into the Pi subprocess to answer "is this file an
 * instruction file".
 *
 * `__tests__/instruction-file-rule-holder.test.ts` pins both halves: this
 * module's import list stays `node:fs`/`node:path`, and a name added here
 * reaches the agent-definition exclusion and the nestor-cloud walk without
 * either being edited.
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Codex's local override for `AGENTS.md`, honoured natively by the app-server we
 * ship and — until P6.35 — read by nothing of ours.
 *
 * STRONG evidence, both tiers, because this is a codex claim: the shipped
 * binary (`apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`,
 * 0.148.0) carries the literal `AGENTS.override.md` beside `AGENTS.md` and its
 * own `core/src/agents_md.rs` frame, and the source at `rust-v0.150.1`
 * (`codex-rs/core/src/agents_md.rs`) spells the rule out:
 *
 * ```rust
 * pub const DEFAULT_AGENTS_MD_FILENAME: &str = "AGENTS.md";
 * /// Preferred local override for AGENTS.md instructions.
 * pub const LOCAL_AGENTS_MD_FILENAME: &str = "AGENTS.override.md";
 * ```
 *
 * and `candidate_filenames` pushes the override FIRST, `agents_md_paths` taking
 * the first candidate whose metadata says `is_file` and returning immediately —
 * so the choice is per DIRECTORY and by EXISTENCE, before the body is read. The
 * page agrees (weak tier, intent only —
 * `learn.chatgpt.com/docs/agent-configuration/agents-md.md`): "In each directory
 * along the path, it checks for `AGENTS.override.md`, then `AGENTS.md`, then any
 * fallback names in `project_doc_fallback_filenames`. Codex includes at most one
 * file per directory."
 *
 * So in a repo carrying this file a codex session was steered by something our
 * Sources surface could not name, while Pi and Claude read the file it
 * supersedes. Two readers of project instructions, disagreeing, silently.
 *
 * {@link agentsMdSupersededIn} is the second half — the constant alone would
 * make us load BOTH files in a directory where codex loads one, which is a
 * different divergence rather than none.
 */
export const AGENTS_OVERRIDE_INSTRUCTION_FILE = 'AGENTS.override.md';

/** The file {@link AGENTS_OVERRIDE_INSTRUCTION_FILE} supersedes. */
export const AGENTS_MD_INSTRUCTION_FILE = 'AGENTS.md';

/** Project instruction files, in stable order. */
export const PROJECT_INSTRUCTION_FILES = [
  AGENTS_OVERRIDE_INSTRUCTION_FILE,
  AGENTS_MD_INSTRUCTION_FILE,
  'CLAUDE.md',
  'CLAUDE.local.md',
];

/**
 * The `AGENTS.md` family alone — the two names codex's own `candidate_filenames`
 * knows, in its order. A reader that carries ONLY this family (the nestor-cloud
 * `agents_md` metadata field) filters {@link projectInstructionFilesIn} through
 * this rather than keeping its own pair, so the supersession cannot be honoured
 * for the collector and forgotten for the request.
 */
const AGENTS_MD_FAMILY: readonly string[] = [
  AGENTS_OVERRIDE_INSTRUCTION_FILE,
  AGENTS_MD_INSTRUCTION_FILE,
];

/**
 * `metadata.is_file`, spelled once: codex selects a candidate on it and a
 * directory named `AGENTS.override.md` is therefore not an override. Every
 * reader here uses this rather than `existsSync`, which answers a different
 * question and would hand a directory to `readFileSync`.
 */
export function instructionFileExistsAt(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Codex's per-directory rule, applied to every walk that reads
 * {@link PROJECT_INSTRUCTION_FILES}: where `AGENTS.override.md` is a file,
 * `AGENTS.md` in the SAME directory is not loaded.
 *
 * Deliberately keyed on EXISTENCE and not on content, because that is what
 * `agents_md_paths` does — it selects on `metadata.is_file` and only then reads,
 * discarding a blank body without falling back. An empty `AGENTS.override.md`
 * therefore silences `AGENTS.md` for codex, and now for us.
 *
 * Scope, stated so the next reader does not have to re-derive it: this pairs
 * `AGENTS.override.md` with `AGENTS.md` and touches NOTHING else. `CLAUDE.md`
 * and `CLAUDE.local.md` are a different vendor's chain codex knows only through
 * `project_doc_fallback_filenames` — **which P6.392 now writes**, from
 * `CODEX_PROJECT_DOC_FALLBACK_FILENAMES` in
 * `codex-responses-adapter/src/config-writer-permissions.ts`; this docblock said
 * "a surface we do not have" until then. What that projection buys and what it
 * does NOT is recorded on that constant: codex takes at most ONE file per
 * directory and the first candidate name wins, so a directory carrying both
 * `AGENTS.md` and `CLAUDE.md` still differs. And Claude's own
 * chain concatenates rather than overriding within itself —
 * `memory.md#how-claude-md-files-load`: "All discovered files are concatenated
 * into context rather than overriding each other." Our own `claudeMdExcludes`
 * layer stays orthogonal: it removes files from OUR context after discovery, so
 * an excluded override still supersedes, exactly as it still does for codex.
 */
export function agentsMdSupersededIn(directory: string): boolean {
  return instructionFileExistsAt(join(directory, AGENTS_OVERRIDE_INSTRUCTION_FILE));
}

/**
 * {@link PROJECT_INSTRUCTION_FILES} as it applies to ONE directory, with
 * {@link agentsMdSupersededIn} already applied. Every walk goes through here so
 * the rule cannot be honoured at three sites and forgotten at the fourth.
 */
export function projectInstructionFilesIn(directory: string): readonly string[] {
  return agentsMdSupersededIn(directory)
    ? PROJECT_INSTRUCTION_FILES.filter(name => name !== AGENTS_MD_INSTRUCTION_FILE)
    : PROJECT_INSTRUCTION_FILES;
}

/**
 * {@link projectInstructionFilesIn} narrowed to {@link AGENTS_MD_FAMILY} — the
 * candidates for a reader whose field carries the `AGENTS.md` chain and nothing
 * else. Derived from the full list, so a change to the rule reaches it.
 */
export function agentsMdInstructionFilesIn(directory: string): readonly string[] {
  return projectInstructionFilesIn(directory).filter(name => AGENTS_MD_FAMILY.includes(name));
}

/**
 * Instruction files are NEVER agent definitions. A markdown agent scan over a
 * directory that also holds `AGENTS.md`/`CLAUDE*` must exclude them even if they
 * carry frontmatter (W6 Step 4).
 *
 * Derived from {@link PROJECT_INSTRUCTION_FILES} rather than written out, which
 * is the whole of P3.241: this set had a second copy in `agents/definitions.ts`,
 * P6.35 taught only one of them `agents.override.md`, and nothing failed. The
 * lowercase fold is the scan's own — `isInstructionFileName` case-folds the
 * directory entry before the lookup, so `Agents.Override.md` is excluded too.
 */
export const INSTRUCTION_FILE_NAMES: ReadonlySet<string> = new Set(
  PROJECT_INSTRUCTION_FILES.map(name => name.toLowerCase()),
);

export function isInstructionFileName(fileName: string): boolean {
  return INSTRUCTION_FILE_NAMES.has(fileName.toLowerCase());
}
