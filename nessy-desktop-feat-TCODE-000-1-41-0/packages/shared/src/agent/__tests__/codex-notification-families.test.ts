/**
 * P3.270 — every server-notification family the codex app-server can send is
 * classified: handled, opted out, or named as unread.
 *
 * The point of this suite is the PARTITION, not the lists. A family added
 * upstream must land in one of the three, and the assertion reads the vendored
 * `ServerNotification` union itself rather than a number written down here —
 * this tree has said "74" about a set that measures 72, and a count in prose is
 * a reading with a date.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CODEX_HANDLED_NOTIFICATION_METHODS,
  CODEX_NOTIFICATION_FAMILIES,
  CODEX_OPTED_OUT_NOTIFICATION_METHODS,
  CODEX_UNREAD_NOTIFICATION_METHODS,
  UNREAD_CODEX_NOTIFICATION_METHOD_SET,
  codexNotificationClassificationConflicts,
  describeCodexDeprecationNotice,
  describeCodexModelReroute,
} from '../codex-notification-families.ts';

/**
 * The upstream union, read from the schema this repo vendors at the tag its
 * shipped binary is built from (`rust-v0.148.0`).
 *
 * Read at test time rather than snapshotted, so a protocol regeneration is what
 * fails the build — the whole reason the classification exists is that a family
 * nobody classified is a family silently dropped.
 */
function schemaNotificationMethods(): string[] {
  const path = join(
    import.meta.dir,
    '../../../../codex-protocol/schema/codex_app_server_protocol.v2.schemas.json',
  );
  const schema = JSON.parse(readFileSync(path, 'utf8')) as {
    definitions: { ServerNotification: { oneOf: Array<{ properties: { method: { enum: string[] } } }> } };
  };
  return schema.definitions.ServerNotification.oneOf.map(variant => variant.properties.method.enum[0]!);
}

describe('P3.270 — the codex notification classification', () => {
  it('covers the vendored ServerNotification union exactly, in both directions', () => {
    const upstream = schemaNotificationMethods();
    // POSITIVE CONTROL: the union was actually read. A parse that silently
    // produced nothing would satisfy every set difference below.
    expect(upstream.length).toBeGreaterThan(50);

    const classified = CODEX_NOTIFICATION_FAMILIES;
    expect([...upstream].filter(method => !classified.has(method)).sort()).toEqual([]);
    expect([...classified].filter(method => !upstream.includes(method)).sort()).toEqual([]);
    // The three lists have no duplicates between them, so the sizes add up.
    expect(classified.size).toBe(upstream.length);
    expect(
      CODEX_HANDLED_NOTIFICATION_METHODS.length
      + CODEX_OPTED_OUT_NOTIFICATION_METHODS.length
      + CODEX_UNREAD_NOTIFICATION_METHODS.length,
    ).toBe(upstream.length);
  });

  /**
   * MEASURED on the shipped `darwin-arm64/codex-app-server`, 2026-09-03:
   * declaring `optOutNotificationMethods` `["remoteControl/status/changed",
   * "thread/status/changed","configWarning"]` removed exactly those three
   * families from a session and left the other seven untouched. The mechanism
   * is exact-name and unconditional — it will happily silence a channel that
   * reports a lost security floor — so an opted-out name that is also handled
   * is a defect nothing else can see.
   */
  it('never opts out of a family the host reads', () => {
    expect(codexNotificationClassificationConflicts()).toEqual([]);
    const handled = new Set<string>(CODEX_HANDLED_NOTIFICATION_METHODS);
    for (const method of CODEX_OPTED_OUT_NOTIFICATION_METHODS) {
      expect(handled.has(method)).toBe(false);
    }
    // The two channels that carry a security consequence, named individually
    // because they are the ones a careless widening would reach first.
    expect(CODEX_OPTED_OUT_NOTIFICATION_METHODS).not.toContain('configWarning' as never);
    expect(CODEX_OPTED_OUT_NOTIFICATION_METHODS).not.toContain('guardianWarning' as never);
  });

  it('the unread set is exactly the unread list', () => {
    expect(UNREAD_CODEX_NOTIFICATION_METHOD_SET.size).toBe(CODEX_UNREAD_NOTIFICATION_METHODS.length);
    for (const method of CODEX_UNREAD_NOTIFICATION_METHODS) {
      expect(UNREAD_CODEX_NOTIFICATION_METHOD_SET.has(method)).toBe(true);
    }
  });
});

describe('P3.270 — the two new readers', () => {
  it('model/rerouted names both models and the reason', () => {
    const line = describeCodexModelReroute({
      threadId: 't', turnId: 'u', fromModel: 'tgpt/qwen35', toModel: 'gpt-safe', reason: 'highRiskCyberActivity',
    });
    expect(line).toContain('tgpt/qwen35 → gpt-safe');
    expect(line).toContain('highRiskCyberActivity');
    // The CONSEQUENCE leads, not the symptom: a reader who is told only that a
    // reroute happened has no reason to connect it to the model in their picker.
    expect(line).toContain('REROUTED THIS TURN TO A DIFFERENT MODEL');
  });

  it('model/rerouted degrades to a shorter sentence rather than throwing', () => {
    // Every field optional at read time even though the wire type declares all
    // five: a rename upstream must shorten the line, never throw inside the
    // transport's synchronous notification dispatch.
    expect(() => describeCodexModelReroute(null)).not.toThrow();
    expect(describeCodexModelReroute({})).toContain('the model was not named on the notification');
    expect(describeCodexModelReroute({ toModel: 'gpt-safe' })).toContain('→ gpt-safe');
    expect(describeCodexModelReroute({ fromModel: 'a' })).toContain('away from a');
  });

  it('deprecationNotice passes summary and details through, bounded', () => {
    expect(describeCodexDeprecationNotice({ summary: 'x is going away', details: 'use y' }))
      .toBe('Codex DEPRECATION NOTICE — x is going away — use y');
    expect(describeCodexDeprecationNotice({})).toContain('no summary or details on the notification');
    // A runtime cannot put a paragraph on a transcript line.
    const long = describeCodexDeprecationNotice({ summary: 'z'.repeat(5000) });
    expect(long.length).toBeLessThan(500);
  });
});

/**
 * The WIRING, pinned by source match — the same technique, for the same reason,
 * as `codex-config-warning-surface.test.ts`'s last case: the `initialize` call
 * lives inside `ensureRuntime`, which spawns a real app-server, verifies a
 * binary manifest and binds an adapter port, so the one line that carries this
 * row is not drivable from a unit test.
 *
 * Without this case the classification above is real and UNAPPLIED: every
 * assertion reads the constants, so deleting the call site would leave the suite
 * green while the connection went back to receiving all 72 families. The BINARY
 * half — that codex honours the field at all — is not a unit-test question and
 * was measured instead: shipped `darwin-arm64/codex-app-server`, 2026-09-03,
 * three named families declared and exactly those three gone, the other seven
 * unchanged.
 */
describe('P3.270 — the opt-out reaches the initialize handshake', () => {
  const source = readFileSync(fileURLToPath(new URL('../codex-agent.ts', import.meta.url)), 'utf8');
  const at = (needle: string): number => {
    const index = source.indexOf(needle);
    expect(index, `missing source anchor: ${needle}`).toBeGreaterThanOrEqual(0);
    return index;
  };

  it('declares optOutNotificationMethods from the constant, inside the initialize capabilities', () => {
    const request = at("await client.request('initialize', {");
    const capabilities = at('          experimentalApi: true,');
    const optOut = at('          optOutNotificationMethods: [...CODEX_OPTED_OUT_NOTIFICATION_METHODS],');
    expect(request).toBeLessThan(capabilities);
    expect(capabilities).toBeLessThan(optOut);
    // Spread from the constant, never re-listed: a second copy of these names
    // is how the opt-out and the classification drift apart, and the drift is
    // invisible because the binary acknowledges neither.
    expect(source).not.toContain("optOutNotificationMethods: ['");
  });

  it('records an unread family once per session rather than dropping it', () => {
    const note = at('  private noteUnreadCodexNotification(method: string): void {');
    const call = at('    this.noteUnreadCodexNotification(method);');
    expect(call).toBeGreaterThan(0);
    expect(note).toBeGreaterThan(0);
    // The guard is what makes it once-per-family: several of these arrive per
    // delta, and a line each would bury the ones that arrive once.
    expect(source).toContain('if (this.seenUnreadNotificationMethods.has(method)) return;');
    // …and the HANDLED guard comes FIRST. `handleNotification` falls THROUGH to
    // the event adapter rather than returning, so `turn/started`,
    // `item/started`, `item/completed` and `thread/status/changed` all reach
    // this line on a healthy session. Without the guard, and before it, the
    // families this host reads best would each be announced as unclassified —
    // which is how a diagnostic channel becomes noise nobody reads.
    const handledGuard = at('    if (HANDLED_CODEX_NOTIFICATION_METHOD_SET.has(method)) return;');
    const seenGuard = at('    if (this.seenUnreadNotificationMethods.has(method)) return;');
    expect(handledGuard).toBeLessThan(seenGuard);
  });
});
