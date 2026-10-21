/**
 * **P3.105 — the RESULTS half of the sensitive-files contract.**
 *
 * `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`, row P3.105.
 *
 * `settings-reference.md`, section `#exclude-sensitive-files`, states what a
 * deny on a sensitive path does, verbatim:
 *
 * > "Use it for files that hold API keys, secrets, or environment values:
 * > Claude Code excludes matching files from file discovery and search results,
 * > denies reads of them, and blocks the Edit and Write tools on the matching
 * > paths."
 *
 * Three promises. Our `deniedPaths` floor delivers the second and the third,
 * and it delivers them on the REQUEST — `getDeniedPathViolation` refuses a call
 * whose `path`/`file_path` argument names a denied file, and P3.104/P3.146
 * widened that to the discovery tools and to Pi's `Find`/`Ls` spellings. The
 * first promise is about the RESPONSE, and nothing enforced it: a `grep` or a
 * `find` rooted one level ABOVE a denied file has a perfectly legal path
 * argument, so the request gate passes it and the denied file's contents come
 * back in the results. That asymmetry — enforced on the request, unenforced on
 * the response — is what this module closes for the tools in this package.
 *
 * ## Why the host, and not the runtime we sit in
 *
 * P3.147 measured the native-first route and it did not cover this: the Claude
 * SDK's own `permissions.deny` denied the read but STILL returned the line from
 * `Grep` on the 2.1.223 shipped then (P3.174) and on every binary up to 2.1.247,
 * so the vendor did not deliver the clause it publishes — repaired by the vendor
 * at 2.1.251, driven 2026-09-13 (C3.380). That is about CLAUDE and changes
 * nothing here: Pi's tools are ours end to end either way.
 * codex's `permissions.filesystem` does, because it is
 * OS-enforced (P3.175). Pi's tools are ours end to end — this file IS the
 * implementation, there is no vendor surface to enable — so the residual
 * difference is ours to make uniform or honest rather than silent.
 *
 * ## Two ways this goes wrong, and what each one costs
 *
 * 1. **Filtering silently.** A search that returns fewer rows and says nothing
 *    teaches the reader the file does not exist. Every filtered result set
 *    therefore carries {@link deniedResultsWithheldNotice}, which states that
 *    something was withheld and why WITHOUT naming what — naming it would undo
 *    the exclusion the contract asks for. The count is of FILES, not of lines,
 *    for the same reason: "17 matches withheld" leaks how many lines of a
 *    credential file contain the query.
 * 2. **Filtering the wrong field.** A result carries a path, a line number and
 *    content, and content can NAME a denied path without being one. The deny
 *    matches on the path, so this module parses the path field and tests only
 *    that. A file whose text mentions `~/.ssh/id_rsa` is returned intact.
 *
 * ## Why the deny decision is injected rather than made here
 *
 * The one matcher is `matchesDeniedPath`, private to `agent/mode-manager.ts`
 * and reachable only through `shouldAllowToolInMode`. Two measurements decided
 * against importing it:
 *
 * - **Weight.** Bundling `local-tools/runtime.ts` alone with
 *   `bun build --target=bun` produces 112 KB; adding a `mode-manager.ts` import
 *   produces 8.81 MB over 828 modules. `LocalToolRuntime`'s only live
 *   construction site is the Pi subprocess, whose shipped bundle is ~27 MB, so
 *   that is a ~32% increase to reach one predicate.
 * - **Boundary.** That construction site installs a `permissionManager` whose
 *   `evaluateToolCall` THROWS `'Session ToolExecutor must use
 *   LocalToolRuntime.executeAuthorized'`. Permission decisions are host-side by
 *   deliberate design there; importing the permission engine into the
 *   subprocess would contradict a decision recorded in code.
 *
 * A second matcher was rejected outright: four defects shipped out of that one
 * compiler in a single day (P3.104, P3.108, P3.146, and a silently inert
 * pattern), and a re-derivation inherits the whole class. So the runtime asks,
 * in one batch per result set, and the host answers with the one matcher —
 * the same shape `claude-denied-path-rules.ts` uses, where the caller supplies
 * `deniedPaths` and the module never reads config itself.
 *
 * **The batch returns the DENIED subset, not the allowed one.** A host that
 * answers wrongly with `[]` then withholds nothing, which is today's behaviour;
 * a host that answered wrongly with `[]` under an allowed-subset contract would
 * withhold EVERY result of every search, which is failure 1 at full scale. The
 * request gate remains the primary enforcement and is unchanged; this is a
 * second, response-side point.
 */

import { isAbsolute, join } from 'node:path';

/**
 * Returns the subset of `paths` that the `deniedPaths` floor withholds. Called
 * once per result set with the DISTINCT absolute paths that set is about to
 * name; may answer asynchronously so a host that owns the matcher out of
 * process can answer in one round trip.
 */
export type DeniedResultPathFilter =
  (paths: readonly string[]) => Promise<readonly string[]> | readonly string[];

/** No filter configured, or nothing to ask about. */
const NOTHING_DENIED: ReadonlySet<string> = new Set<string>();

/**
 * Tool-result contract text: English verbatim and never localized, the same
 * rule the R10 background handle and the missing-`rg` diagnosis in
 * `runtime.ts` follow. It goes to the model, and it is the whole of what makes
 * this filter honest rather than silent — so it says that something was
 * withheld, why, and where to change it, and it does not say WHICH.
 */
export function deniedResultsWithheldNotice(withheldFiles: number): string {
  const noun = withheldFiles === 1 ? '1 file' : `${withheldFiles} files`;
  return `[${noun} withheld: matched a deniedPaths entry, and denied paths are `
    + 'excluded from file discovery and search results. The paths are not listed. '
    + 'Change deniedPaths in the permissions config to adjust what is withheld.]';
}

/** Result text with the notice appended when anything was withheld. */
export function appendWithheldNotice(text: string, withheldFiles: number): string {
  if (withheldFiles <= 0) return text;
  const notice = deniedResultsWithheldNotice(withheldFiles);
  return text.length > 0 ? `${text}\n${notice}` : notice;
}

/**
 * Ask the host which of these paths are denied. Distinct paths only — a grep
 * hit list repeats one path per matching line, and the host may be answering
 * across a process boundary.
 */
export async function resolveDeniedPaths(
  filter: DeniedResultPathFilter | undefined,
  paths: readonly string[],
): Promise<ReadonlySet<string>> {
  if (!filter || paths.length === 0) return NOTHING_DENIED;
  const distinct = [...new Set(paths)];
  const denied = await filter(distinct);
  return denied.length === 0 ? NOTHING_DENIED : new Set(denied);
}

/** An absolute candidate for a path ripgrep printed relative to its root. */
function absoluteAgainst(root: string, path: string): string {
  return isAbsolute(path) ? path : join(root, path);
}

/**
 * The path field of one ripgrep line, or null when the line carries no path.
 *
 * Both search operations in `runtime.ts` pass `--line-number`, so a match line
 * is `<path>:<line>:<content>` and — under `--context` — a context line is
 * `<path>-<line>-<content>`, with `--` alone separating context blocks.
 *
 * The `:` form is tried FIRST and that ordering is load-bearing. A path may
 * legitimately contain `-<digits>-` (`/w/b-12-c.ts`), and trying the `-` form
 * first would parse that as the path `/w/b`, testing a path that does not
 * exist against the deny list. Reading the `:` form first attributes the line
 * correctly, and a Windows drive letter survives it because `\d+` refuses
 * `C:\…` and forces the lazy quantifier onward.
 */
function parseMatchLinePath(line: string): string | null {
  return /^(.*?):\d+:/.exec(line)?.[1] ?? null;
}

/**
 * Withhold every result line belonging to a denied file.
 *
 * Context lines are attributed by longest known-path prefix rather than by
 * parsing them, because the `-` separator is ambiguous with an ordinary
 * filename (see {@link parseMatchLinePath}) and because ripgrep never emits a
 * context line for a file it did not also emit a match line for. A line that
 * cannot be attributed is KEPT: an unattributable line is not evidence that
 * something is denied, and dropping it would withhold on a guess.
 */
export async function withholdDeniedMatchLines(
  text: string,
  root: string,
  filter: DeniedResultPathFilter | undefined,
): Promise<{ text: string; withheldFiles: number }> {
  if (!filter || text.length === 0) return { text, withheldFiles: 0 };

  const lines = text.split('\n');
  const linePaths = lines.map(parseMatchLinePath);
  const candidates = linePaths.filter((path): path is string => path !== null);
  if (candidates.length === 0) return { text, withheldFiles: 0 };

  const denied = await resolveDeniedPaths(filter, candidates.map(path => absoluteAgainst(root, path)));
  if (denied.size === 0) return { text, withheldFiles: 0 };

  // Longest first so `/w/a/b.ts` wins over `/w/a` when both produced matches.
  const knownPaths = [...new Set(candidates)].sort((a, b) => b.length - a.length);
  const withheldFiles = new Set<string>();
  const kept: string[] = [];

  for (const [index, line] of lines.entries()) {
    const parsed = linePaths[index];
    const owner = parsed ?? knownPaths.find(path => line.startsWith(path)) ?? null;
    if (owner !== null && denied.has(absoluteAgainst(root, owner))) {
      withheldFiles.add(owner);
      continue;
    }
    kept.push(line);
  }

  return { text: kept.join('\n'), withheldFiles: withheldFiles.size };
}

/**
 * Withhold denied entries from a path listing — `find`'s glob matches, `ls`'s
 * directory entries, `list_files`' walk. `toAbsolute` maps one entry to the
 * path the deny list is asked about, because each caller spells its entries
 * differently (relative to the search root, a bare name, a name with a
 * trailing `/` for a directory).
 */
export async function withholdDeniedEntries(
  entries: readonly string[],
  toAbsolute: (entry: string) => string,
  filter: DeniedResultPathFilter | undefined,
): Promise<{ entries: string[]; withheldFiles: number }> {
  if (!filter || entries.length === 0) return { entries: [...entries], withheldFiles: 0 };

  const denied = await resolveDeniedPaths(filter, entries.map(toAbsolute));
  if (denied.size === 0) return { entries: [...entries], withheldFiles: 0 };

  const kept = entries.filter(entry => !denied.has(toAbsolute(entry)));
  return { entries: kept, withheldFiles: entries.length - kept.length };
}
