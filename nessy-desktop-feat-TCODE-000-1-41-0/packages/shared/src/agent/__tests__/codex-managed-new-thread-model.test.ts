/**
 * P6.484 — an administrator's `models.newThread` is applied, on codex's own
 * terms.
 *
 * Owner decision 2026-09-05 Q15(b). The reference implementation, read at
 * `rust-v0.150.1`: `tui/src/managed_new_thread_defaults.rs` fills `config.model`
 * ONLY when the invocation carried no `-m` and no `-c model=`, under the comment
 * "Managed values are defaults rather than enforcement. Preserve explicit launch
 * choices". Option (c) — applying it over a user's pick — would be strictly
 * stronger than codex itself.
 *
 * The requirement was not unapplicable here; it was UNANSWERABLE, because
 * `this._model = config.model || defaultModel` discarded the one bit that
 * decides. `BaseAgent.modelChosenExplicitly` records it.
 */
import { describe, expect, it } from 'bun:test';
import {
  CODEX_REQUIREMENT_NEW_THREAD_DEFAULTS_PREFIX,
  formatCodexConfigRequirementsDiagnostics,
  probeCodexConfigRequirements,
  resolveCodexManagedNewThreadModel,
  withCodexNewThreadModelVerdict,
} from '../codex-config-requirements.ts';
import type { CodexConfigRequirementsReadingV1 } from '../codex-config-requirements.ts';

const REQUIRED = { model: 'gpt-5.1-codex', modelReasoningEffort: 'high', serviceTier: 'priority' };

describe('P6.484 the administrator new-thread model', () => {
  /**
   * C3.426 · `serviceTier` joined this verdict at C3.169 (`fa5628232`, QK7 owner
   * answer A) and this exact-shape expectation was the one assertion in the tree
   * left behind. It is restated rather than loosened — `toEqual` stays, because
   * its job is to fail on a field nobody decided to add.
   *
   * WHY the tier rides an APPLIED verdict unconditionally while the model needs
   * `modelChosenExplicitly`: the posture is "fill only what the invocation did
   * not choose", and this build offers no service-tier control at all — no
   * setting, no picker, no connection field — so there is no user choice for an
   * administrator's value to override. The EFFORT is the third field and parts
   * company with both: a thinking level IS a choice this build offers and no
   * explicit-versus-inherited bit exists for it, so it stays reported and not
   * applied. The field's own arms (a requirement with no tier, a PRESERVED
   * verdict carrying neither) are driven in `codex-managed-service-tier.test.ts`
   * and are not repeated here.
   */
  it('applies when the connection DEFAULTED to its model', () => {
    expect(resolveCodexManagedNewThreadModel(REQUIRED, {
      model: 'tgpt/qwen35-397b-a17b-fp8',
      modelChosenExplicitly: false,
    })).toEqual({ kind: 'applied', model: 'gpt-5.1-codex', effort: 'high', serviceTier: 'priority' });
  });

  it('stands down when the user PICKED one — codex preserves explicit choices', () => {
    expect(resolveCodexManagedNewThreadModel(REQUIRED, {
      model: 'tgpt/qwen35-397b-a17b-fp8',
      modelChosenExplicitly: true,
    })).toEqual({ kind: 'preserved', required: 'gpt-5.1-codex', chosen: 'tgpt/qwen35-397b-a17b-fp8' });
  });

  it('reports PRESERVED even when the pick equals the requirement', () => {
    // The two are different events and an audit must be able to tell them apart:
    // one is an override that fired, the other is an override that did not.
    expect(resolveCodexManagedNewThreadModel(REQUIRED, {
      model: 'gpt-5.1-codex',
      modelChosenExplicitly: true,
    }).kind).toBe('preserved');
  });

  it('says nothing when no model was required', () => {
    expect(resolveCodexManagedNewThreadModel(undefined, { model: 'm', modelChosenExplicitly: false }))
      .toEqual({ kind: 'none' });
    // A requirement carrying only an effort is not a model requirement.
    expect(resolveCodexManagedNewThreadModel({ modelReasoningEffort: 'high' }, {
      model: 'm',
      modelChosenExplicitly: false,
    })).toEqual({ kind: 'none' });
  });

  it('carries no effort into the verdict when the requirement carried none', () => {
    expect(resolveCodexManagedNewThreadModel({ model: 'x' }, {
      model: 'm',
      modelChosenExplicitly: false,
    })).toEqual({ kind: 'applied', model: 'x' });
  });

  describe('the honest surface P6.7 built', () => {
    const reading = {
      status: 'read',
      honoured: [],
      unsupported: [],
      codexEnforced: [],
      notApplied: ['models'],
      inapplicable: [],
      unrecognised: [],
      managedNewThreadDefaults: REQUIRED,
    } as unknown as CodexConfigRequirementsReadingV1;

    const lineFor = (verdict: Parameters<typeof formatCodexConfigRequirementsDiagnostics>[1]): string =>
      formatCodexConfigRequirementsDiagnostics(reading, verdict)
        .find(line => line.startsWith(CODEX_REQUIREMENT_NEW_THREAD_DEFAULTS_PREFIX)) ?? '';

    it('still names the VALUE, which is what P3.239 added', () => {
      expect(lineFor({ kind: 'none' })).toContain('model gpt-5.1-codex');
      expect(lineFor({ kind: 'none' })).toContain('service tier priority');
    });

    it('says which of the three things happened', () => {
      expect(lineFor({ kind: 'applied', model: 'gpt-5.1-codex', effort: 'high' }))
        .toContain('INHERITED');
      expect(lineFor({ kind: 'preserved', required: 'gpt-5.1-codex', chosen: 'qwen' }))
        .toContain('PICKED qwen');
      // The caller that cannot answer keeps the sentence this function printed
      // before the row, rather than a new one that would be a guess.
      expect(lineFor({ kind: 'none' })).toContain('NOT applied');
    });
  });
});

/**
 * P6.484's APPLY half — the classification, and the wiring that carries the
 * verdict from the probe to both the bucket and the sentence.
 *
 * The end-to-end apply (`this.setModel(...)` before `thread/start`) is asserted
 * as a SOURCE SHAPE in `codex-config-requirements.test.ts`, beside the three
 * other spawn-path pins, for the reason that file already records: `spawnRuntime`
 * needs a real app-server and an adapter port. Everything that DECIDES lives in
 * the two pure functions below and is driven for real here.
 */
describe('P6.484 the bucket the verdict moves', () => {
  const reading = (notApplied: readonly string[], honoured: readonly string[] = []) => ({
    status: 'read',
    honoured,
    unsupported: [],
    codexEnforced: [],
    notApplied,
    inapplicable: [],
    unrecognised: [],
    managedNewThreadDefaults: REQUIRED,
  } as unknown as CodexConfigRequirementsReadingV1);

  it('moves `models` to honoured when the requirement was APPLIED', () => {
    const moved = withCodexNewThreadModelVerdict(
      reading(['models']),
      { kind: 'applied', model: 'gpt-5.1-codex' },
    );
    expect(moved.honoured).toContain('models');
    expect(moved.notApplied).not.toContain('models');
  });

  /**
   * And when it was PRESERVED, which is the judgement worth reading twice:
   * standing down over an explicit user choice IS the requirement's own posture
   * ("Managed values are defaults rather than enforcement"), so leaving it under
   * a line that says this build does not apply it would state the opposite of
   * what happened.
   */
  it('moves `models` when the requirement stood down over a user pick', () => {
    const moved = withCodexNewThreadModelVerdict(
      reading(['models']),
      { kind: 'preserved', required: 'gpt-5.1-codex', chosen: 'qwen' },
    );
    expect(moved.honoured).toContain('models');
    expect(moved.notApplied).not.toContain('models');
  });

  it('leaves it alone for a caller that cannot answer, byte for byte', () => {
    const before = reading(['models']);
    expect(withCodexNewThreadModelVerdict(before, { kind: 'none' })).toBe(before);
  });

  it('leaves a non-answering reading alone whatever the verdict', () => {
    const failed = { status: 'failed' } as unknown as CodexConfigRequirementsReadingV1;
    expect(withCodexNewThreadModelVerdict(failed, { kind: 'applied', model: 'x' })).toBe(failed);
  });

  it('does not invent an entry when `models` was never in the bucket', () => {
    const before = reading([], ['featureRequirements.in_app_browser']);
    const after = withCodexNewThreadModelVerdict(before, { kind: 'applied', model: 'x' });
    expect(after).toBe(before);
    expect(after.honoured).toEqual(['featureRequirements.in_app_browser']);
  });
});

describe('P6.484 the probe carries the session, so the bucket and the sentence agree', () => {
  const document = {
    requirements: {
      models: { newThread: { model: 'gpt-5.1-codex', modelReasoningEffort: 'high' } },
    },
  };
  const client = { request: async () => document } as never;

  it('reports APPLIED and honours `models` when the connection defaulted', async () => {
    const lines: string[] = [];
    const result = await probeCodexConfigRequirements(client, {
      onDiagnostic: line => { lines.push(line); },
      session: { model: 'tgpt/qwen35-397b-a17b-fp8', modelChosenExplicitly: false },
    });

    expect(result.honoured).toContain('models');
    expect(result.notApplied).not.toContain('models');
    const line = lines.find(l => l.startsWith(CODEX_REQUIREMENT_NEW_THREAD_DEFAULTS_PREFIX));
    expect(line).toContain('INHERITED');
    expect(line).toContain('gpt-5.1-codex');
  });

  it('reports PRESERVED and still honours `models` when the user picked one', async () => {
    const lines: string[] = [];
    const result = await probeCodexConfigRequirements(client, {
      onDiagnostic: line => { lines.push(line); },
      session: { model: 'tgpt/qwen35-397b-a17b-fp8', modelChosenExplicitly: true },
    });

    expect(result.honoured).toContain('models');
    expect(lines.find(l => l.startsWith(CODEX_REQUIREMENT_NEW_THREAD_DEFAULTS_PREFIX)))
      .toContain('PICKED tgpt/qwen35-397b-a17b-fp8');
  });

  /**
   * THE CONTROL, and it is what makes the two cases above mean anything: a
   * caller that supplies no session gets the pre-row behaviour exactly — the
   * requirement stays in the unapplied bucket and the sentence stays the one
   * that was true for such a caller.
   */
  it('keeps the pre-row behaviour for a caller that cannot answer', async () => {
    const lines: string[] = [];
    const result = await probeCodexConfigRequirements(client, {
      onDiagnostic: line => { lines.push(line); },
    });

    expect(result.notApplied).toContain('models');
    expect(result.honoured).not.toContain('models');
    expect(lines.find(l => l.startsWith(CODEX_REQUIREMENT_NEW_THREAD_DEFAULTS_PREFIX)))
      .toContain('NOT applied');
  });
});
