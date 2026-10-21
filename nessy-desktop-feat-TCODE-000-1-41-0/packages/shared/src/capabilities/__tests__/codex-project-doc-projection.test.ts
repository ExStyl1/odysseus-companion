/**
 * P6.392 — the pin that keeps the host's project-instruction list and the codex
 * projection of it from drifting apart.
 *
 * `codex-responses-adapter` is a dependency-free LEAF (`@nessy-agent/shared`
 * depends on it, never the reverse), so the two filenames it projects are
 * duplicated there rather than imported — the same treatment `AgentTier` and
 * `PERMISSION_MODE_ORDER` already get in that package. A duplicate with no test
 * is a divergence with a delay, and this file is the test. It lives on the
 * SHARED side because that is the direction the dependency allows.
 *
 * ## I2.27 — TWO gates now stand between this projection and the model, both
 * read from the source at `rust-v0.154.0` (upstream #39653 / #39837)
 *
 * The projection still works (the case below re-verifies `candidate_filenames`
 * unchanged), but what codex DOES with the names it accepted has moved since
 * this file was written, and both moves are silent from here:
 *
 *  1. **An untrusted project supplies no project AGENTS.md at all.**
 *     `core/src/agents_md.rs::load_project_instructions` opens with
 *     `if config.active_project.is_untrusted() { return … }` — it keeps the
 *     HOST-provided `user_instructions` it was handed and reads not one project
 *     file. The trust key is the same `[projects."<root>"]` entry
 *     `buildCodexProjectTrustToml` writes, so trust now governs the project
 *     docs as well as the *"project-local config, hooks, and exec policies"*
 *     the gate has always named. That widening is NOT in
 *     `disabled_reason_for_decision`'s sentence, which is unchanged at the tag,
 *     so a user who reads codex's own explanation is told less than happened.
 *  2. **Under a filesystem sandbox, an unreadable AGENTS.md is FATAL rather
 *     than skipped.** The same function builds a `sandbox_context` whenever the
 *     turn's permission profile lacks full disk read access, and its error arms
 *     are asymmetric: `Err(error) if sandbox.is_none()` logs and continues,
 *     while the sandboxed arm returns `Err`. So a projected fallback filename
 *     the profile cannot read fails the load instead of being passed over.
 *
 * **Does gate 1 fire for US? YES since F1.750, deliberately.** Until then this
 * paragraph answered no: this product never emitted `trust_level = "untrusted"`,
 * so `is_untrusted()` was false for every session and a project the host
 * declined to trust still had its AGENTS.md read on codex. The premise under that
 * — that an ABSENT entry stays absent — was measured false on the shipped 0.156.1
 * (WJ-crit-t, F1.723): `thread_start_task` AUTO-TRUSTS a cwd with no entry, so
 * a restricted project was trusted outright, `.codex` layer and all. F1.750
 * (DECIDED by the controller: "Keep restricted" must mean restricted) now writes
 * `untrusted` for every project the host did not trust
 * (`config-writer-project-trust.test.ts` pins it), so codex reads NO project
 * AGENTS.md there — the same repository-owned content the host's own capability
 * resolver withholds from an untrusted project (`capabilities/native-sources.ts`,
 * "Trust boundary"). The cost is said per session as the `codex-project-trust`
 * fact. Gate 2 (the sandboxed fatal read) stays live regardless.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  CODEX_PROJECT_DOC_FALLBACK_FILENAMES,
  CODEX_PROJECT_ROOT_MARKERS,
} from '../../../../codex-responses-adapter/src/config-writer-permissions.ts';
import {
  AGENTS_MD_INSTRUCTION_FILE,
  AGENTS_OVERRIDE_INSTRUCTION_FILE,
  PROJECT_INSTRUCTION_FILES,
} from '../instruction-files.ts';

describe('the codex project-doc projection', () => {
  it('projects exactly the host names codex does not already know', () => {
    // `core/src/agents_md.rs::candidate_filenames`, RE-READ at `rust-v0.154.0`
    // (I2.27, 2026-09-17; it was taken at `rust-v0.150.1` and the function is
    // unchanged), seeds the list with `AGENTS.override.md` then `AGENTS.md` and
    // appends the configured fallbacks, skipping any it already holds and any
    // that is empty. So the projection is the host's list MINUS that pair — and
    // a fifth name added to `PROJECT_INSTRUCTION_FILES` without a matching
    // projection fails here rather than being read on two runtimes of three
    // with nothing saying so.
    const knownToCodex = new Set([AGENTS_OVERRIDE_INSTRUCTION_FILE, AGENTS_MD_INSTRUCTION_FILE]);
    expect([...CODEX_PROJECT_DOC_FALLBACK_FILENAMES])
      .toEqual(PROJECT_INSTRUCTION_FILES.filter(name => !knownToCodex.has(name)));
  });

  it('projects the marker the host itself walks to, not a guessed one', () => {
    // `prompts/output-styles.ts::outputStyleProjectRootFor` IS the host's
    // project-root notion, and it stops at `.git`. Asserted against that
    // module's source rather than against a constant, because the walk is a
    // literal there and a constant here would be a third copy of the same fact.
    const source = readFileSync(new URL('../../prompts/output-styles.ts', import.meta.url), 'utf8');
    for (const marker of CODEX_PROJECT_ROOT_MARKERS) {
      expect(source).toContain(`join(current, '${marker}')`);
    }
    // One marker, so codex's documented default (`.git` when unset) and ours are
    // the same set — which is what makes writing the key a pin rather than a
    // behaviour change.
    expect(CODEX_PROJECT_ROOT_MARKERS).toHaveLength(1);
  });
});
