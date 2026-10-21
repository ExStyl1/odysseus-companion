/**
 * DA2.15 — the model-target disclosure's ONE host sink, at all three call sites.
 *
 * ## Why the source is the instrument at three of these four arms
 *
 * The fact under test is a WIRING fact: does each of the three
 * `noteModelTargetToolEgress` call sites hand the helper the host's port instead
 * of leaving it unset? The helper's own behaviour is already pinned next door
 * (`backend/internal/drivers/upstream-target.test.ts`), and the defect this row
 * repairs was invisible for exactly as long as it was because every test of that
 * helper passes its OWN `emit` — i.e. drives the seam through a stub of the thing
 * that was broken. Driving the call sites for real means constructing three
 * backends, two of which spawn a runtime; the assertion would then be about the
 * spawn rather than about the wiring.
 *
 * So the arms are read off the source, each anchored to the CALL rather than to
 * the identifier (a bare `onModelTargetDisclosure` would also match the comment
 * that explains it), and the fourth arm below is behavioural: it proves the
 * fallback an unset host still relies on.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  _resetModelTargetNoticesForTesting,
  noteModelTargetToolEgress,
} from '../backend/internal/drivers/upstream-target.ts';

const SRC = join(import.meta.dir, '..', '..');
const read = (relative: string): string => readFileSync(join(SRC, relative), 'utf-8');

describe('DA2.15 — the sink exists and every call site passes it', () => {
  it('CoreBackendConfig declares the port beside its precedent', () => {
    const types = read('agent/backend/types.ts');
    expect(types).toContain('onModelTargetDisclosure?: (line: string) => void;');
    // Beside `onHostOverheadUsage`, which is the shape it copies: the backend
    // knows what happened, the host knows where to put it.
    expect(types).toContain('onHostOverheadUsage?:');
    expect(types.indexOf('onHostOverheadUsage?:'))
      .toBeLessThan(types.indexOf('onModelTargetDisclosure?:'));
  });

  it('backend/factory.ts passes it at backend construction', () => {
    const source = read('agent/backend/factory.ts');
    const call = source.slice(source.indexOf('noteModelTargetToolEgress({'));
    expect(call.slice(0, call.indexOf('});'))).toContain('emit: coreConfig.onModelTargetDisclosure,');
  });

  it('claude-agent.ts passes it at its outbound-tools seam', () => {
    const source = read('agent/claude-agent.ts');
    const call = source.slice(source.indexOf('noteModelTargetToolEgress({'));
    expect(call.slice(0, call.indexOf('});'))).toContain('emit: this.config.onModelTargetDisclosure,');
  });

  it('codex-agent.ts passes it at its outbound-tools seam', () => {
    const source = read('agent/codex-agent.ts');
    const call = source.slice(source.indexOf('noteModelTargetToolEgress({'));
    expect(call.slice(0, call.indexOf('});'))).toContain('emit: this.config.onModelTargetDisclosure,');
  });

  /**
   * The negative control, and it is what makes the three above safe to land
   * alone: a host that supplies no sink must be on EXACTLY the old path. That
   * path is the helper's own `console.warn`, so the arm asserts the fallback
   * survives the widening — `emit: undefined` is what all three call sites now
   * pass on every session whose host has not taken the port.
   */
  describe('an unset host is unchanged', () => {
    const realWarn = console.warn;
    afterEach(() => { console.warn = realWarn; _resetModelTargetNoticesForTesting(); });

    it('falls back to console.warn when emit is undefined', () => {
      _resetModelTargetNoticesForTesting();
      const lines: string[] = [];
      console.warn = (line: unknown) => { lines.push(String(line)); };

      const notice = noteModelTargetToolEgress({
        baseUrl: 'https://proxy.example.test/v1',
        model: 'anthropic/claude-sonnet-4-5',
        emit: undefined,
      });

      expect(notice).not.toBeNull();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('[model-target]');
      expect(lines[0]).toContain('external model vendor');
    });

    it('a supplied sink REPLACES that console line rather than adding to it', () => {
      _resetModelTargetNoticesForTesting();
      const warned: string[] = [];
      const sunk: string[] = [];
      console.warn = (line: unknown) => { warned.push(String(line)); };

      const notice = noteModelTargetToolEgress({
        baseUrl: 'https://proxy.example.test/v1',
        model: 'anthropic/claude-sonnet-4-5',
        emit: (line: string) => { sunk.push(line); },
      });

      expect(notice).not.toBeNull();
      expect(sunk).toHaveLength(1);
      // The fact the port's docblock tells a host about: take this and you take
      // the logging too, or the operator line is gone.
      expect(warned).toHaveLength(0);
    });
  });
});
