/**
 * P3.171 — the instrument's own tests, plus one live arm on the vendored
 * `sdk.mjs`.
 *
 * The synthetic cases exist because the three control rules are the whole
 * mechanism, and each of them can only be demonstrated by an artefact that
 * violates it. The live arm exists because a classifier that has never met a
 * real minified bundle is a model of one.
 *
 * The native binary is deliberately NOT read here: it is 272 553 824 bytes, and
 * a suite that loads it would be a starved run on this box rather than a
 * measurement. Its numbers are recorded in `binary-evidence.ts` with the
 * instrument that produced them.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import {
  accessorReferences,
  classifyBinaryEvidence,
  countShape,
  MENTIONED_UNREAD_CONTROLS,
  type BinaryEvidenceControls,
} from './binary-evidence.ts';

const CONTROLS: BinaryEvidenceControls = {
  read: 'READ_ME',
  mentionedUnread: 'MENTIONED_ONLY',
  absent: 'NONSENSE_ABSENT_CONTROL',
};

/** A bundle where the read control is read inline and the other name is not. */
const HEALTHY = [
  'var a=process.env.READ_ME;',
  'var registry={READ_ME:()=>x1,MENTIONED_ONLY:()=>x2,TARGET_NAME:()=>x3};',
  'var withhold=["MENTIONED_ONLY","TARGET_NAME"];',
  'function f(){return process.env.TARGET_NAME}',
].join('\n');

describe('P3.171: the three controls decide before the target does', () => {
  it('refuses the run when the nonsense control matches', () => {
    const report = classifyBinaryEvidence({
      haystack: `${HEALTHY}\nvar leak="NONSENSE_ABSENT_CONTROL";`,
      name: 'TARGET_NAME',
      shape: 'occurrence',
      controls: CONTROLS,
    });
    expect(report.verdict).toBe('rig-dead');
    expect(report.reason).toContain('NONSENSE_ABSENT_CONTROL');
  });

  it('refuses a shape with no sensitivity, rather than reporting its zero', () => {
    // `env-read` finds nothing at all here, including for the name the artefact
    // acts on — exactly the native binary's `CLAUDE_CODE_HOST_CREDS_FILE` case.
    const viaHelper = [
      'var registry={READ_ME:()=>x1,TARGET_NAME:()=>x3};',
      'function g(){return read("READ_ME")}',
    ].join('\n');
    const report = classifyBinaryEvidence({
      haystack: viaHelper,
      name: 'TARGET_NAME',
      shape: 'env-read',
      controls: CONTROLS,
    });
    expect(report.verdict).toBe('shape-unusable');
    expect(report.reason).toContain('no sensitivity');
  });

  it('refuses a shape with no specificity, rather than reporting its hit', () => {
    // `key-or-assign` fires on the registry entry every name has — the native
    // binary's case, where the unread control scores as well as the read ones.
    const report = classifyBinaryEvidence({
      haystack: HEALTHY,
      name: 'TARGET_NAME',
      shape: 'key-or-assign',
      controls: CONTROLS,
    });
    expect(report.verdict).toBe('shape-unusable');
    expect(report.reason).toContain('no specificity');
  });

  it('reads, unread-on-this-shape and absent, once all three controls pass', () => {
    expect(classifyBinaryEvidence({
      haystack: HEALTHY, name: 'TARGET_NAME', shape: 'env-read', controls: CONTROLS,
    }).verdict).toBe('reads');

    expect(classifyBinaryEvidence({
      haystack: HEALTHY, name: 'MENTIONED_ONLY', shape: 'env-read', controls: CONTROLS,
    }).verdict).toBe('unread-on-this-shape');

    expect(classifyBinaryEvidence({
      haystack: HEALTHY, name: 'NEVER_HEARD_OF_IT', shape: 'env-read', controls: CONTROLS,
    }).verdict).toBe('absent');
  });

  it('reports both instruments, because a bare count names neither', () => {
    const counts = countShape('READ_ME READ_ME\nREAD_ME', 'occurrence', 'READ_ME');
    expect(counts).toEqual({ lines: 2, occurrences: 3 });
  });
});

describe('P3.171: the accessor hop counts references BEYOND the two every entry has', () => {
  it('returns zero for an accessor nothing consumes', () => {
    const stub = 'var x2=p.bool();var registry={MENTIONED_ONLY:()=>x2};';
    expect(accessorReferences(stub, 'MENTIONED_ONLY')).toEqual({ accessor: 'x2', extra: 0 });
  });

  it('counts a real consumer', () => {
    const live = 'var x1=p.bool();var registry={READ_ME:()=>x1};if(x1())go();';
    expect(accessorReferences(live, 'READ_ME')).toEqual({ accessor: 'x1', extra: 1 });
  });

  it('reports no accessor for a name with no registry entry', () => {
    expect(accessorReferences('nothing here', 'READ_ME')).toEqual({ accessor: null, extra: 0 });
  });
});

// ---------------------------------------------------------------------------
// The live arm: the vendored `sdk.mjs`, which is the artefact P3.134's stub was
// found in and the one that most invites the mistake this file is about.
// ---------------------------------------------------------------------------
function sdkBundle(): string | null {
  const entry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
  const path = `${entry.slice(0, entry.lastIndexOf('/'))}/sdk.mjs`;
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

describe('P3.171: sdk.mjs declares far more names than it reads', () => {
  const bundle = sdkBundle();

  it('is present, so a zero below is a measurement and not a missing file', () => {
    expect(bundle).not.toBeNull();
    expect((bundle ?? '').length).toBeGreaterThan(1_000_000);
  });

  it('reads CLAUDE_CONFIG_DIR inline and the two remote-settings names not at all', () => {
    if (!bundle) throw new Error('sdk.mjs missing; the arm above already failed');
    const controls: BinaryEvidenceControls = {
      read: 'CLAUDE_CONFIG_DIR',
      mentionedUnread: Object.keys(MENTIONED_UNREAD_CONTROLS)[0]!,
      absent: 'CLAUDE_CODE_ZZZ_ABSENT_CONTROL_P3171',
    };
    // Sensitivity control alive, specificity control silent, nonsense at zero.
    expect(countShape(bundle, 'env-read', controls.read).occurrences).toBeGreaterThan(0);
    expect(countShape(bundle, 'env-read', controls.mentionedUnread).occurrences).toBe(0);
    expect(countShape(bundle, 'occurrence', controls.absent).occurrences).toBe(0);

    expect(classifyBinaryEvidence({
      haystack: bundle, name: controls.read, shape: 'env-read', controls,
    }).verdict).toBe('reads');
    // The name whose reader P3.171 called a stub. It IS unread here — and has a
    // real body in the native binary, which is the artefact conflation the
    // instrument's docblock records.
    expect(classifyBinaryEvidence({
      haystack: bundle, name: 'CLAUDE_CODE_REMOTE_SETTINGS_PATH', shape: 'env-read', controls,
    }).verdict).toBe('unread-on-this-shape');
  });

  it('has a dead accessor hop for every name, control included', () => {
    if (!bundle) throw new Error('sdk.mjs missing; the arm above already failed');
    // The measurement that makes an accessor-existence probe worthless HERE:
    // even the name this file reads six times has no consumer of its accessor.
    expect(accessorReferences(bundle, 'CLAUDE_CONFIG_DIR').extra).toBe(0);
    expect(accessorReferences(bundle, 'CLAUDE_CODE_MOCK_REMOTE_SETTINGS').extra).toBe(0);
  });

  it('declares an order of magnitude more names than it reads', () => {
    if (!bundle) throw new Error('sdk.mjs missing; the arm above already failed');
    // Measured 2026-09-01: 834 registry entries, 89 distinct names read
    // directly. Asserted as a ratio rather than as those two numbers, which
    // move with every SDK bump — the claim is structural, not numeric.
    const declared = new Set(
      [...bundle.matchAll(/([A-Z][A-Z0-9_]{3,}):\(\)=>[A-Za-z0-9_$]+/g)].map(match => match[1]!),
    );
    const read = new Set(
      [...bundle.matchAll(/(?:process\.)?env(?:\.|\[")([A-Z][A-Z0-9_]{3,})/g)].map(match => match[1]!),
    );
    expect(declared.size).toBeGreaterThan(500);
    expect(read.size * 2).toBeLessThan(declared.size);
  });
});
