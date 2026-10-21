/**
 * The configured additional filesystem roots the permission gate consumes.
 *
 * `shouldAllowToolInMode` has always accepted `options.additionalDirectories`
 * and implemented containment against it; nothing ever fed it. This module is
 * the single reader, so every gate call site names the same list once.
 *
 * Widening a root is a permission decision, not a convenience: the list comes
 * ONLY from the explicit, persisted `additionalDirectories` setting in
 * `config.json`. It is never inferred from a path the model asked about — the
 * model's route to a new root stays the outside-root approval flow
 * (`local-tools/runtime.ts`, `requestOutsideRootApproval`).
 *
 * ## Why there is NO PROJECT-TRUST GATE here, measured (P6.193)
 *
 * P6.193 reads "`additionalDirectories` has no trust gate at all", and the
 * grep behind it is right — this file contains zero occurrences of "trust".
 * The conclusion does not follow, and the reason is the ONE source above.
 *
 * Project trust scopes a document a *repository* supplies. This setting has
 * exactly one source and it is `loadStoredConfig()` — the user's own
 * installation-global `config.json`, which takes no workspace argument and
 * cannot be written by a checkout. There is no project-scope
 * `additionalDirectories` layer to withhold, so a trust gate here would guard
 * an empty set while implying to a reader that an untrusted repository could
 * ever have widened these roots. It cannot.
 *
 * The trust boundary that WAS loose is the permission-rule layer, and it is
 * fixed where it lives: `pi-harness/permission-dsl.ts`'s
 * `withholdProjectGrants` withholds an untrusted project's `allow` rules and
 * keeps its `deny` and `ask` rules, which the compiler previously dropped
 * together.
 *
 * If a project-scope source is ever added here, the gate becomes real and this
 * paragraph becomes wrong — which is why it names its own precondition.
 */

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { CONFIG_DIR } from '../config/paths.ts';
import { loadStoredConfig } from '../config/storage.ts';
import { createLogger } from '../utils/debug.ts';
import { canonicalizeForDecision } from './session-filesystem-scope.ts';

const log = createLogger('permissions');

export interface AdditionalDirectoriesResolution {
  /** Canonical absolute roots, deduplicated, safe to hand to the gate. */
  roots: string[];
  /** One line per rejected entry — a bad entry is reported, never dropped silently. */
  diagnostics: string[];
}

export interface AdditionalDirectoriesResolutionOptions {
  /**
   * The base a relative entry resolves against — the directory belonging to the
   * settings FILE that declared these entries. Without one, a relative entry is
   * still refused, because there is then nothing stable to resolve it against.
   *
   * See the note on {@link resolveAdditionalDirectories} before choosing a value
   * for a project-scope file: the honest base is the directory the file's own
   * relative paths are written against, which for a `.claude/settings.json` is
   * the project directory and not `dirname()` of the file.
   */
  settingsFileDirectory?: string;
}

/**
 * Validate and canonicalize configured entries.
 *
 * An entry must name an existing directory. An absolute entry is taken as
 * written; a RELATIVE one resolves against the directory of the settings file
 * that declared it.
 *
 * ## Why the settings file, and not the working directory (P6.516, Q-den 47)
 *
 * This function used to refuse every relative entry, with a reason that was
 * correct about the hazard and wrong about the only fix: *"there is no
 * unambiguous cwd at gate time, so resolving one would make the granted root
 * depend on where the app was launched from."* True — and that is an argument
 * against the CWD as the base, not against resolving at all. The cost of
 * refusing was that a documented path shape stayed dead: the page's own example
 * is relative (`large-codebases.md` § Grant access across packages or
 * repositories shows `"../shared"`, `"../web"`), so an author following it got
 * an entry dropped into a `log.warn`.
 *
 * The declaring file's own directory has the property the cwd lacks: it does not
 * move. The same file grants the same roots on every machine and from every
 * launch directory, which is the whole of what made the cwd unusable.
 *
 * **Deliberate difference from the page, stated rather than smuggled.**
 * `large-codebases.md` says, verbatim: *"Relative paths resolve against the
 * directory you start Claude from."* We resolve against the declaring file
 * instead, on purpose — and the two bases are NOT the same base wearing a
 * different name, so do not read this as an equivalent spelling. For the page's
 * own example the file is `packages/api/.claude/settings.json` and the session
 * starts from `packages/api/`, so the page's `"../shared"` means
 * `packages/shared` while this rule's would mean `packages/api/shared`: they
 * differ by the `.claude/` level, not merely when the session starts elsewhere.
 *
 * That divergence is UNREACHABLE today and the reason matters more than the
 * fact: the only file that reaches this resolver is the installation-global
 * `<CONFIG_DIR>/config.json`, which is not a project `.claude/settings.json`,
 * has no `.claude/` level, and belongs to no launch directory. A future
 * project-scope reader is the one that meets it, and it must decide what to hand
 * in rather than reflexively passing `dirname(settingsFile)` — mirroring the
 * page means passing the PROJECT directory (the parent of `.claude/`).
 *
 * **No new authority.** The one source that reaches this function today is the
 * user's own installation-global `config.json` (see the header), so resolving a
 * relative entry widens what the USER can spell, never who can spell it. A
 * repository still cannot widen these roots, because no project-scope source
 * exists to read — the same precondition the header names.
 */
export function resolveAdditionalDirectories(
  entries: readonly unknown[],
  options: AdditionalDirectoriesResolutionOptions = {},
): AdditionalDirectoriesResolution {
  const roots: string[] = [];
  const diagnostics: string[] = [];
  const base = options.settingsFileDirectory?.trim();

  for (const entry of entries) {
    const raw = typeof entry === 'string' ? entry.trim() : '';
    if (!raw) {
      diagnostics.push(`additionalDirectories: ignoring non-path entry ${JSON.stringify(entry)}.`);
      continue;
    }
    let absolute: string;
    if (isAbsolute(raw)) {
      absolute = raw;
    } else if (base) {
      absolute = resolve(base, raw);
    } else {
      // Reached by the OTHER caller, deliberately: `pi-agent.ts`'s
      // `addDirectories` grant comes from a hook's `updatedPermissions`, which
      // is programmatic and has no declaring file at all. Refusing is the only
      // honest answer when the base is unknown — it is the old behaviour, and
      // the diagnostic reaches that caller's user as a `deferred` entry.
      diagnostics.push(
        `additionalDirectories: ignoring relative entry "${raw}" — no declaring settings file is known,`
        + ' so there is nothing stable to resolve it against; use an absolute path.',
      );
      continue;
    }
    // The same canonicalization the captured filesystem scope applies to its own
    // roots (session-filesystem-scope.ts), so a symlink cannot smuggle a root
    // past the containment checks downstream.
    const canonical = canonicalizeForDecision(absolute);
    if (!existsSync(canonical) || !statSync(canonical).isDirectory()) {
      // The RESOLVED path is named beside the entry: a relative entry that lands
      // somewhere surprising is the one case where quoting the entry alone
      // leaves the reader unable to see why.
      diagnostics.push(raw === absolute
        ? `additionalDirectories: ignoring "${raw}" — not an existing directory.`
        : `additionalDirectories: ignoring "${raw}" — it resolves to "${absolute}", `
          + 'which is not an existing directory.');
      continue;
    }
    if (!roots.includes(canonical)) {
      roots.push(canonical);
    }
  }

  return { roots, diagnostics };
}

/** Memoized on the raw entries, so editing the setting takes effect without a restart. */
let resolutionCache: { key: string; roots: string[] } | null = null;

/**
 * The canonical additional roots for this installation, or an empty list.
 *
 * Fails closed: an unreadable config grants no extra roots.
 */
export function getConfiguredAdditionalDirectories(): string[] {
  let entries: unknown;
  try {
    entries = loadStoredConfig()?.additionalDirectories;
  } catch {
    return [];
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }

  const key = JSON.stringify(entries);
  if (resolutionCache?.key === key) {
    return resolutionCache.roots;
  }

  // The declaring settings file is `<CONFIG_DIR>/config.json` and there is no
  // other source, so its directory is the base every relative entry resolves
  // against. Naming it here rather than defaulting inside the resolver keeps the
  // resolver honest for the next caller, which will hand it a different file.
  const { roots, diagnostics } = resolveAdditionalDirectories(entries, { settingsFileDirectory: CONFIG_DIR });
  for (const diagnostic of diagnostics) {
    log.warn(diagnostic);
  }
  resolutionCache = { key, roots };
  return roots;
}
