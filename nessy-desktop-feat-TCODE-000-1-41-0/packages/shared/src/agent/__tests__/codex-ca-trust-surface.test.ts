/**
 * P3.38 — an operator must be able to find out WHAT CODEX TRUSTS.
 *
 * ## The gap, and why it is a nastier one than it sounds
 *
 * P3.30 made the corporate CA reach codex and left this open deliberately: no
 * diagnostic, no settings text and no docs-site line says what codex trusts,
 * that our bundle was applied, or that an operator's own certificate variable
 * was PRESERVED rather than overwritten. Behind TLS interception a support case
 * therefore starts blind — which is most of the value of that fix.
 *
 * And the guard P3.30 added makes it HARDER to diagnose, not easier: the
 * correct behaviour (we stand aside for an operator's own bundle) sets nothing,
 * exactly like the bug it replaced. On the wire the two are identical. Only a
 * sentence can separate them, which is what this file pins.
 *
 * ## Evidence tier: STRONG for every clause asserted here
 *
 * The rule replicated by `describeCodexTrustDecision` is
 * `applyCodexCaCertificate`'s, itself read from `openai/codex`
 * `codex-rs/http-client/src/custom_ca.rs` at `rust-v0.150.1` — the tag shipped
 * when this was read; today's is `manifest.json`'s `upstream.tag` — and
 * cross-checked against
 * that shipped artifact. Nothing here rests on a vendor page, which on this
 * runtime has twice been measured contradicting its own binary.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describeCodexTrustDecision } from '../codex-agent.ts';

const OURS = '/opt/nessy/tinkoff-bundle.crt';
const THEIRS = '/etc/ssl/corp/their-bundle.pem';

describe('what codex trusts is stated, not left to be inferred', () => {
  /**
   * THE ROW'S CENTRAL CASE — the one an unstated correct behaviour is
   * indistinguishable from a bug.
   *
   * KILLS: a sentence that reports only "the app bundle was not applied", which
   * reads as the P3.30 bug rather than as the guard working.
   */
  it('says the operator\'s own CODEX_CA_CERTIFICATE was preserved, not overwritten', () => {
    const said = describeCodexTrustDecision({ CODEX_CA_CERTIFICATE: THEIRS }, OURS);
    expect(said).toContain(THEIRS);
    expect(said).toContain('PRESERVED rather than overwrote');
    // The reason, because "we did not apply ours" without it reads as a defect.
    expect(said).toContain('codex loads exactly one bundle');
    // And the remedy that actually works, since unsetting the variable is the
    // wrong one: codex reads ONE bundle, so the certificates must be merged.
    expect(said).toContain('append its certificates to your own file');
  });

  /**
   * `SSL_CERT_FILE` is the second variable the guard stands aside for.
   *
   * KILLS: a guard description that names only `CODEX_CA_CERTIFICATE` — which
   * would report "OS roots only" for an operator whose bundle IS in force, the
   * most misleading answer available.
   */
  it('stands aside for SSL_CERT_FILE too, and names the variable it found', () => {
    const said = describeCodexTrustDecision({ SSL_CERT_FILE: THEIRS }, OURS);
    expect(said).toContain('SSL_CERT_FILE');
    expect(said).toContain(THEIRS);
    expect(said).toContain('PRESERVED');
    expect(said).not.toContain('OS root store ONLY');
  });

  /** KILLS: reporting the fallback variable when the codex-specific one outranks it. */
  it('names CODEX_CA_CERTIFICATE when both are set, matching codex\'s own precedence', () => {
    const said = describeCodexTrustDecision(
      { CODEX_CA_CERTIFICATE: THEIRS, SSL_CERT_FILE: '/etc/ssl/other.pem' },
      OURS,
    );
    expect(said).toContain('`CODEX_CA_CERTIFICATE`');
    expect(said).toContain(THEIRS);
    expect(said).not.toContain('/etc/ssl/other.pem');
  });

  /** The ordinary managed install: our bundle applied because nothing was set. */
  it('says our bundle was applied, under the one name codex reads', () => {
    const said = describeCodexTrustDecision({}, OURS);
    expect(said).toContain(OURS);
    expect(said).toContain('`CODEX_CA_CERTIFICATE`');
    // Additive, so a user NOT behind interception knows this costs them nothing.
    expect(said).toContain('ADDITIVE to the platform roots');
  });

  /**
   * KILLS: silence in the case that actually breaks. This is the pre-P3.30
   * state, and the diagnosis a user could not previously follow.
   */
  it('says OS-roots-only out loud, and names the variable that will NOT help', () => {
    const said = describeCodexTrustDecision({}, undefined);
    expect(said).toContain('OS root store ONLY');
    expect(said).toContain('fail to verify where the other runtimes succeed');
    // Measured by P3.30: codex NEVER reads NODE_EXTRA_CA_CERTS, and that live
    // arm FAILED. Without this line the obvious remedy is the wrong one.
    expect(said).toContain('NEVER reads');
    expect(said).toContain('NODE_EXTRA_CA_CERTS');
  });

  /**
   * `VAR=""` is UNSET, tested the way codex tests it — `!value.is_empty()` in
   * `custom_ca.rs`, mirrored as `(value ?? '') !== ''` with no trim.
   *
   * KILLS: a `trim()` that would describe a decision the spawn does not make —
   * a whitespace-only value IS non-empty to codex, so the app does stand aside
   * for it and the sentence must say so.
   */
  it('treats an empty variable as unset, and a whitespace one as set, exactly as codex does', () => {
    expect(describeCodexTrustDecision({ CODEX_CA_CERTIFICATE: '', SSL_CERT_FILE: '' }, OURS))
      .toContain(OURS);
    expect(describeCodexTrustDecision({ CODEX_CA_CERTIFICATE: ' ' }, OURS))
      .toContain('PRESERVED');
  });

  /**
   * POSITIVE CONTROL on the same rig: the `not.toContain` assertions above must
   * not be passing because the function returns something inert. Every arm
   * produces a non-empty, prefixed sentence.
   */
  it('POSITIVE CONTROL: every arm returns a real, prefixed sentence', () => {
    for (const said of [
      describeCodexTrustDecision({ CODEX_CA_CERTIFICATE: THEIRS }, OURS),
      describeCodexTrustDecision({ SSL_CERT_FILE: THEIRS }, undefined),
      describeCodexTrustDecision({}, OURS),
      describeCodexTrustDecision({}, undefined),
    ]) {
      expect(said.startsWith('[codex CA] ')).toBe(true);
      expect(said.length).toBeGreaterThan(80);
    }
  });
});

/**
 * The WIRING, pinned by source match — `createRuntime` spawns a real
 * app-server and verifies a binary manifest, so it is not drivable from a unit
 * test, and the fact that carries this row is that the sentence is RECORDED at
 * all.
 *
 * It goes to the session-facts map rather than `debug()` deliberately: a
 * standing property of the session has to answer the same on turn sixty as on
 * turn one, and `debug()` routes through electron-log, whose transports the
 * packaged main process disables.
 */
describe('the codex spawn records what it decided about trust', () => {
  const source = readFileSync(fileURLToPath(new URL('../codex-agent.ts', import.meta.url)), 'utf8');

  it('records the trust sentence as a session fact, beside the CA spawn option', () => {
    expect(source).toContain("this.recordSessionFact(\n            'codex-ca-trust',");
    expect(source).toContain('describeCodexTrustDecision(process.env, caCertificatePath)');
    const resolve = source.indexOf('const caCertificatePath = resolveCodexCaCertificatePath();');
    const record = source.indexOf("'codex-ca-trust',");
    expect(resolve).toBeGreaterThanOrEqual(0);
    expect(record).toBeGreaterThan(resolve);
  });
});
