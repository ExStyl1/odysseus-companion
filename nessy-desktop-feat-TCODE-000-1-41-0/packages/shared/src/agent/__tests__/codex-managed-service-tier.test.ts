/**
 * C3.169 (QK7, owner answer A, 2026-09-11) — an administrator's
 * `models.newThread.serviceTier` is APPLIED, exactly as the model is, and the
 * reasoning effort beside it is still only REPORTED.
 *
 * ## Why the two fields part company, pinned rather than commented
 *
 * The posture is the owner's own 2026-09-05 Q15 answer (b): *fill only what the
 * invocation did not choose*. For the MODEL that needs `modelChosenExplicitly`,
 * because a user really can pick one. For the SERVICE TIER it is satisfied
 * unconditionally — this build has no service-tier control at all, so there is
 * no user choice for an administrator's value to override. For the REASONING
 * EFFORT it is NOT satisfied: a thinking level is a choice this build offers and
 * it records no explicit-versus-inherited bit for it, so applying it would be
 * the stronger posture through the back door.
 *
 * The field exists on the wire we already send —
 * `packages/codex-protocol/generated/v2/ThreadStartParams.ts`, *"Override the
 * service tier for this turn and subsequent turns"* — so nothing is invented.
 *
 * ## What each case kills
 *
 *  - "carries the tier" dies if the resolver drops the field, which is the
 *    shipped state this row changes.
 *  - "a preserved verdict carries NEITHER" is the control that keeps the
 *    stand-down whole: a tier applied over a user-picked model would be the
 *    posture half-observed, which is worse than not observing it.
 *  - "the effort is reported, not applied" is the clause the row explicitly
 *    leaves standing, and the diagnostic now SAYS so — the line used to read
 *    "starts on <model> at reasoning effort <effort>", which described the
 *    effort as applied when it never was.
 *  - the `[managed]` line cases are the honest surface: an administrator must be
 *    able to read which of the three fields moved.
 */
import { describe, expect, it } from 'bun:test';
import {
  CODEX_REQUIREMENT_NEW_THREAD_DEFAULTS_PREFIX,
  formatCodexConfigRequirementsDiagnostics,
  resolveCodexManagedNewThreadModel,
  type CodexConfigRequirementsReadingV1,
} from '../codex-config-requirements.ts';

const INHERITED = { model: 'codex/connection-default', modelChosenExplicitly: false } as const;
const PICKED = { model: 'codex/user-picked', modelChosenExplicitly: true } as const;

const DEFAULTS = {
  model: 'codex/required-model',
  modelReasoningEffort: 'high',
  serviceTier: 'priority',
} as const;

/** A `read` reading whose only content is the new-thread requirement. */
function reading(): CodexConfigRequirementsReadingV1 {
  return {
    status: 'read',
    inAppUpdatesDisabled: undefined,
    inAppBrowserDisabled: undefined,
    honoured: [],
    unsupported: ['models'],
    codexEnforced: [],
    notApplied: ['models'],
    inapplicable: [],
    unrecognised: [],
    managedNewThreadDefaults: DEFAULTS,
  } as unknown as CodexConfigRequirementsReadingV1;
}

describe('C3.169 — the managed new-thread service tier', () => {
  it('carries the tier on the APPLIED verdict, beside the model', () => {
    const verdict = resolveCodexManagedNewThreadModel(DEFAULTS, INHERITED);
    expect(verdict).toEqual({
      kind: 'applied',
      model: 'codex/required-model',
      effort: 'high',
      serviceTier: 'priority',
    });
  });

  it('CONTROL: a PRESERVED verdict carries neither the tier nor the effort', () => {
    // Standing down is whole. A tier applied over a user-picked model would be
    // the posture half-observed.
    expect(resolveCodexManagedNewThreadModel(DEFAULTS, PICKED)).toEqual({
      kind: 'preserved',
      required: 'codex/required-model',
      chosen: 'codex/user-picked',
    });
  });

  it('CONTROL: a requirement with a tier and NO model is still `none`', () => {
    // The tier rides the model's verdict and does not mint one of its own: with
    // no required model there is no inherited-versus-picked question to answer,
    // and applying a tier alone would be an override with no posture behind it.
    expect(resolveCodexManagedNewThreadModel({ serviceTier: 'priority' }, INHERITED))
      .toEqual({ kind: 'none' });
  });

  it('omits the field entirely when the administrator set no tier', () => {
    const verdict = resolveCodexManagedNewThreadModel(
      { model: 'codex/required-model' },
      INHERITED,
    );
    expect(verdict).toEqual({ kind: 'applied', model: 'codex/required-model' });
    expect('serviceTier' in verdict).toBe(false);
  });

  it('the honest surface names the tier as applied and the effort as NOT applied', () => {
    const [line] = formatCodexConfigRequirementsDiagnostics(
      reading(),
      resolveCodexManagedNewThreadModel(DEFAULTS, INHERITED),
    ).filter(text => text.startsWith(CODEX_REQUIREMENT_NEW_THREAD_DEFAULTS_PREFIX));

    expect(line).toBeDefined();
    // The values the administrator deployed, still printed by name.
    expect(line).toContain('service tier priority');
    // What the session DID with each of them.
    expect(line).toContain('starts on codex/required-model on service tier priority');
    expect(line).toContain('REPORTED and NOT applied');
    // The sentence this replaces described the effort as applied; it must not
    // come back. Matched as the whole phrase, so the words "reasoning effort"
    // staying in the line is not what reddens it.
    expect(line).not.toContain('starts on codex/required-model at reasoning effort');
  });

  it('CONTROL: the preserved line still says the requirement stood down', () => {
    const [line] = formatCodexConfigRequirementsDiagnostics(
      reading(),
      resolveCodexManagedNewThreadModel(DEFAULTS, PICKED),
    ).filter(text => text.startsWith(CODEX_REQUIREMENT_NEW_THREAD_DEFAULTS_PREFIX));

    expect(line).toContain('the user PICKED codex/user-picked');
    expect(line).toContain('stands down and is not applied');
    // The deployed VALUES are still named — that half is the reading, not the verdict.
    expect(line).toContain('service tier priority');
  });
});
