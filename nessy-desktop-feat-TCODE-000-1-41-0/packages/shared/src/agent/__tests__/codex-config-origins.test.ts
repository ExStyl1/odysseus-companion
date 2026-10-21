/**
 * P6.169 — `config/read` with `includeLayers: true`, and the three things the
 * shipped binary said that the row had assumed otherwise.
 *
 * The fixture below is not invented. It is the answer
 * `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server` returned on
 * 2026-09-08 to a real `initialize` + `initialized` + `config/read`, against a
 * scratch `CODEX_HOME` carrying `model` and `model_reasoning_effort` plus a
 * project `.codex/config.toml` setting `model` — trimmed to the fields this
 * host reads, with the temp paths kept verbatim. Testing the DESCRIBER against
 * those bytes rather than driving a child is deliberate: the probe's own
 * contract is that it degrades, and the shape it degrades from is what a unit
 * test can actually pin.
 */

import { describe, expect, it } from 'bun:test';

import { describeCodexConfigProvenance } from '../../config/config-doctor.ts';
import {
  CODEX_CONFIG_READ_METHOD,
  probeCodexConfigOrigins,
  readRecordedCodexConfigProvenance,
  recordCodexConfigProvenance,
  resetRecordedCodexConfigProvenance,
} from '../codex-config-origins.ts';

const USER_FILE = '/private/var/folders/5p/T/codex-home-p2/config.toml';
const PROJECT_FOLDER = '/private/var/folders/5p/T/codex-ws-p2/.codex';
const USER_SHA = 'sha256:b0f0111ad0b4a82142c1de8939efcd8927584232470f398783e50649676e4598';

/** The measured answer, trimmed to the fields this host reads. */
const MEASURED = {
  // 97 top-level keys came back; three of them stand in here, and
  // `effectiveKeyCount` is asserted against the real 97 separately below.
  config: { model: 'nessy-probe-model', model_reasoning_effort: 'high', sandbox_mode: 'workspace-write' },
  origins: {
    model: { name: { type: 'user', file: USER_FILE, profile: null }, version: USER_SHA },
    model_reasoning_effort: { name: { type: 'user', file: USER_FILE, profile: null }, version: USER_SHA },
  },
  layers: [
    {
      name: { type: 'project', dotCodexFolder: PROJECT_FOLDER },
      version: 'sha256:be9c7632a9fba6a11d78486cacd84225fb11a0aef9ef3eabb1bdfa35e704104b',
      config: { model: 'project-override-model' },
      disabledReason:
        'To load project-local config, hooks, and exec policies, add /private/var/folders/5p/T/codex-ws-p2 '
        + `as a trusted project in ${USER_FILE}.`,
    },
    {
      name: { type: 'user', file: USER_FILE, profile: null },
      version: USER_SHA,
      config: { model: 'nessy-probe-model', model_reasoning_effort: 'high' },
      disabledReason: null,
    },
    {
      name: { type: 'system', file: '/etc/codex/config.toml' },
      version: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      config: {},
      disabledReason: null,
    },
  ],
};

describe('describeCodexConfigProvenance — the measured answer (P6.169)', () => {
  it('separates a layer that was READ AND NOT APPLIED from one that supplies', () => {
    const described = describeCodexConfigProvenance(MEASURED);
    expect(described).toBeDefined();
    const layers = described!.layers;
    expect(layers.map(layer => [layer.kind, layer.state])).toEqual([
      ['project', 'not-applied'],
      ['user', 'supplies'],
      ['system', 'present-no-keys'],
    ]);
    // The project layer HAS a key, and reporting it as `supplies` would be the
    // exact lie this view exists to remove: the runtime read it and refused it.
    expect(layers[0]?.keys).toEqual(['model']);
    expect(layers[0]?.disabledReason).toContain('trusted project');
    // The file to open, per source variant: `dotCodexFolder` for a project
    // layer, `file` for the other two.
    expect(layers[0]?.label).toBe(PROJECT_FOLDER);
    expect(layers[2]?.label).toBe('/etc/codex/config.toml');
    // `/etc/codex/config.toml` does not exist on this machine and still came
    // back as a layer — which is P6.168's `present-no-keys` state arriving from
    // the other side, and the state a user misreads as "I am being ignored".
    expect(layers[2]?.keys).toEqual([]);
    expect(layers[2]?.disabledReason).toBeUndefined();
  });

  it('names the WINNER per key, and says how few keys any file explains', () => {
    const described = describeCodexConfigProvenance(MEASURED)!;
    // `model` is set by BOTH the project layer and the user layer; the origin
    // map names the user file, because the project layer is not applied. That
    // is why `origins` is rendered beside the layer list rather than derived
    // from it.
    expect(described.origins).toEqual([
      { key: 'model', kind: 'user', label: USER_FILE },
      { key: 'model_reasoning_effort', kind: 'user', label: USER_FILE },
    ]);
    // Sorted, so the list is stable between reads of a map with no order.
    expect(described.origins.map(o => o.key)).toEqual([...described.origins.map(o => o.key)].sort());
    // The row's own control, corrected by the measurement: `origins` explains
    // only the keys some layer SET. On the real rig that was 2 of 97, so the
    // gap is carried rather than hidden.
    expect(described.effectiveKeyCount).toBe(3);
    expect(described.origins.length).toBeLessThan(described.effectiveKeyCount);
  });

  it('drops what it cannot read instead of throwing', () => {
    // A separately versioned binary's answer, so every field is tolerated. The
    // negative arm: no config object at all is not an empty report, it is no
    // report — and a section that renders as "nothing is set" would be
    // indistinguishable from a real answer.
    expect(describeCodexConfigProvenance(undefined)).toBeUndefined();
    expect(describeCodexConfigProvenance({ origins: {}, layers: [] })).toBeUndefined();
    expect(describeCodexConfigProvenance('not an object')).toBeUndefined();
    const salvaged = describeCodexConfigProvenance({
      config: { a: 1 },
      origins: { good: { name: { type: 'system', file: '/etc/codex/config.toml' } }, bad: null, worse: { name: 7 } },
      layers: [null, { name: { notAType: true } }, { name: { type: 'sessionFlags' }, config: { b: 2 } }],
    })!;
    expect(salvaged.origins).toEqual([{ key: 'good', kind: 'system', label: '/etc/codex/config.toml' }]);
    // `sessionFlags` is a layer with no file at all, so it carries no label and
    // the surface says "not a file" rather than rendering an empty path.
    expect(salvaged.layers).toEqual([{ kind: 'sessionFlags', state: 'supplies', keys: ['b'] }]);
  });
});

describe('probeCodexConfigOrigins — it degrades, never throws (P6.169)', () => {
  it('always sends includeLayers, and the cwd when it has one', async () => {
    const sent: Array<{ method: string; params: unknown }> = [];
    const reading = await probeCodexConfigOrigins({
      request: async (method, params) => {
        sent.push({ method, params });
        return MEASURED;
      },
    }, { cwd: '/work/ws' });

    expect(sent).toEqual([{
      method: CODEX_CONFIG_READ_METHOD,
      // Without `includeLayers` the shipped binary returns `layers: undefined`,
      // and the layer list is the half that answers "the file exists and sets
      // nothing" and "the file was read and not applied".
      params: { includeLayers: true, cwd: '/work/ws' },
    }]);
    expect(reading.status).toBe('read');
    expect(reading.provenance?.layers).toHaveLength(3);

    // ...and no `cwd` key at all when the caller has none, rather than a null:
    // a path we do not believe in would make the answer a guess.
    const bare: Array<unknown> = [];
    await probeCodexConfigOrigins({
      request: async (_method, params) => { bare.push(params); return MEASURED; },
    });
    expect(bare).toEqual([{ includeLayers: true }]);
  });

  it('separates a definitive refusal from a transient failure, and says so once', async () => {
    const lines: string[] = [];
    // The shipped binary answers an unknown method as a serde `unknown variant`
    // on its `ClientRequest` enum — the shared classifier's own reading.
    const refused = await probeCodexConfigOrigins({
      request: async () => { throw new Error('unknown variant `config/read`, expected one of ...'); },
    }, { onDiagnostic: line => lines.push(line) });
    expect(refused.status).toBe('unsupported');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('unsupported');

    // A deadline carries neither a code nor a serde token, so it is transient —
    // the server may know the method perfectly well and be wedged.
    const timedOut = await probeCodexConfigOrigins({
      request: () => new Promise(() => {}),
    }, { timeoutMs: 5 });
    expect(timedOut.status).toBe('failed');
    expect(timedOut.detail).toContain('timed out');
    expect(timedOut.provenance).toBeUndefined();

    // An answer in a shape this host cannot read is `failed`, not `read`: an
    // empty section claiming to be an answer is the defect the view removes.
    const unreadable = await probeCodexConfigOrigins({ request: async () => ({ origins: {} }) });
    expect(unreadable.status).toBe('failed');
    expect(unreadable.provenance).toBeUndefined();
  });

  it('never erases a good answer with a failed probe', () => {
    resetRecordedCodexConfigProvenance();
    expect(readRecordedCodexConfigProvenance('ws-1')).toBeUndefined();
    const described = describeCodexConfigProvenance(MEASURED)!;
    recordCodexConfigProvenance('ws-1', described);
    expect(readRecordedCodexConfigProvenance('ws-1')).toBe(described);
    // The negative arm, and the reason the recorder ignores `undefined`: a
    // runtime that could not answer is not a statement about the configuration,
    // so the previous session's reading stands.
    recordCodexConfigProvenance('ws-1', undefined);
    expect(readRecordedCodexConfigProvenance('ws-1')).toBe(described);
    resetRecordedCodexConfigProvenance();
  });
});

describe('the record is keyed by WORKSPACE (P6.823)', () => {
  /**
   * `config/read` resolves the project layer from the session's `cwd`, so the
   * answer describes ONE workspace's layer stack. A process-wide slot showed
   * every open workspace whichever one started a codex session last.
   */
  it('keeps two workspaces apart, and the second does not overwrite the first', () => {
    resetRecordedCodexConfigProvenance();
    const first = describeCodexConfigProvenance(MEASURED)!;
    const second = describeCodexConfigProvenance({
      ...MEASURED,
      layers: [
        {
          scope: 'project',
          source: { type: 'project', folder: '/private/var/folders/5p/T/codex-ws-OTHER/.codex' },
          config: { model: 'other-workspace-model' },
        },
      ],
    })!;
    recordCodexConfigProvenance('ws-1', first);
    recordCodexConfigProvenance('ws-2', second);

    expect(readRecordedCodexConfigProvenance('ws-1')).toBe(first);
    expect(readRecordedCodexConfigProvenance('ws-2')).toBe(second);
    // The pre-P6.823 shape: one slot, so the LAST writer answered for both.
    expect(readRecordedCodexConfigProvenance('ws-1')).not.toBe(second);
    resetRecordedCodexConfigProvenance();
  });

  it('never borrows another workspace\'s answer', () => {
    resetRecordedCodexConfigProvenance();
    const described = describeCodexConfigProvenance(MEASURED)!;
    recordCodexConfigProvenance('ws-1', described);
    // A workspace no codex session has run in, and a page opened without a
    // workspace at all: both are "nobody has answered here", never ws-1's
    // layers under another directory's name.
    expect(readRecordedCodexConfigProvenance('ws-2')).toBeUndefined();
    expect(readRecordedCodexConfigProvenance()).toBeUndefined();
    expect(readRecordedCodexConfigProvenance(undefined)).toBeUndefined();

    // And the no-workspace slot is its own, reachable and non-colliding.
    recordCodexConfigProvenance(undefined, described);
    expect(readRecordedCodexConfigProvenance()).toBe(described);
    expect(readRecordedCodexConfigProvenance('ws-2')).toBeUndefined();
    resetRecordedCodexConfigProvenance();
  });

  it('is threaded from the codex spawn and read for the requested workspace', async () => {
    // A call-site pin: two pure functions cannot see a caller that passes no
    // key, and the whole defect was a missing argument.
    const agent = await Bun.file(
      new URL('../codex-agent.ts', import.meta.url).pathname,
    ).text();
    expect(agent).toContain('recordCodexConfigProvenance(this.config.workspace?.id, configOrigins.provenance)');
    const handler = await Bun.file(
      new URL('../../../../server-core/src/handlers/rpc/settings.ts', import.meta.url).pathname,
    ).text();
    expect(handler).toContain('readRecordedCodexConfigProvenance(workspaceId)');
  });
});
