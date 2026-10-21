import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import {
  INTERCEPTOR_BUNDLE_MARKER,
  INTERCEPTOR_BUNDLE_RELATIVE,
  INTERCEPTOR_ENTRY,
  INTERCEPTOR_SRC_DIR,
  interceptorClosure,
  interceptorPreloadFragment,
  relativeImportsOf,
  stageInterceptorSources,
  verifyInterceptorPairing,
} from '../../../../scripts/build/interceptor-pairing.ts';

const repoRoot = join(import.meta.dir, '..', '..', '..', '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf-8');
}

describe('interceptor packaging contract', () => {
  /**
   * P6.820 — the four packaging manifests, checked against the DERIVED closure
   * instead of against one name typed into this test by hand.
   *
   * The case this replaces asserted `interceptor-request-utils.ts` in all four.
   * It passed for four days while every one of them shipped THREE of seven, for
   * the reason a pinned name always misses: a name a test names cannot be the
   * name that is absent. The manifests are now the two shapes that cannot go
   * short — `electron-builder.yml` lists the whole closure and is compared to it
   * as a SET, and the three platform scripts name no member at all, because they
   * call `copyInterceptor` and it walks the imports.
   */
  it('ships the whole derived closure, and the three scripts stage it rather than naming files', () => {
    const srcPrefix = `${INTERCEPTOR_SRC_DIR.split(sep).join('/')}/`;
    const closure = interceptorClosure(repoRoot);
    const expected = [INTERCEPTOR_ENTRY, ...closure].map(rel => `${srcPrefix}${rel}`).sort();

    // The manifest lists exactly the closure — neither short (the P6.805 defect)
    // nor long (a module dropped from the imports but left shipping).
    const listed = readRepoFile('apps/electron/electron-builder.yml')
      .split('\n')
      .map(line => line.trim().match(/^-\s+"?(packages\/shared\/src\/\S+?)"?$/)?.[1])
      .filter((entry): entry is string => entry !== undefined)
      .sort();
    expect(listed).toEqual(expected);

    for (const script of ['build-dmg.sh', 'build-linux.sh', 'build-win.ps1']) {
      const source = readRepoFile(`apps/electron/scripts/${script}`);
      // Positive: it stages through the one derivation.
      expect(source, script).toContain('copyInterceptor');
      // Negative: and no CODE line names a closure member. Comment lines are
      // dropped first, and that is measured rather than tidy — build-dmg.sh's
      // Claude-flag comment cites `packages/shared/src/feature-flags.ts` as the
      // mirror of `isAnthropicBackendEnabled()`, so a whole-file substring
      // search reports a hand list that is a cross-reference. Both `.sh` and
      // `.ps1` comment with `#`. The ENTRY is exempt by construction: it is not
      // in `closure`, and each script still names it once to assert the stager
      // ran — a post-condition, not a second list.
      const code = source.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
      for (const member of closure) {
        expect(code, `${script} still hand-lists ${member}`).not.toContain(member);
      }
    }
  });

  // The list used to be written by hand in five places at once — `copyInterceptor`
  // and four packaging manifests — and every one of them carried the same three
  // names while the interceptor imported five modules directly. A name pinned in a
  // test cannot see that; a DERIVED set can, which is what these three assert.
  // P6.820 then removed the four hand lists themselves: the three platform
  // scripts call `copyInterceptor`, and `electron-builder.yml` is compared to
  // the derived set by the case above.
  describe('source closure', () => {
    const stagings: string[] = [];
    afterAll(() => {
      for (const dir of stagings) rmSync(dir, { recursive: true, force: true });
    });

    // Pinned deliberately. A change here is a real change to what the
    // dev/monorepo preload path needs — and since P6.820 it is also a change to
    // what SHIPS: `electron-builder.yml` is compared to this derivation, and the
    // three platform scripts stage from it, so this list moving moves all four.
    const EXPECTED_CLOSURE = [
      'auth/nestor-model-snapshot.ts',
      'auth/nestor.ts',
      'config/paths.ts',
      'feature-flags.ts',
      'interceptor-common.ts',
      'interceptor-request-utils.ts',
      'telemetry/gateway-headers.ts',
      // C3.218 (2026-09-11) made `gateway-headers.ts` log its decision through
      // `debug()`, so the closure grew by one leaf module with no imports of its
      // own; the 1.38.0 close-out run caught the manifest and this pin still at seven.
      'utils/debug.ts',
    ];

    it('derives the closure from the interceptor own imports, transitively', () => {
      expect(interceptorClosure(repoRoot)).toEqual(EXPECTED_CLOSURE);
    });

    // The negative that a text scan gets wrong: `unified-network-interceptor.ts`
    // QUOTES an import of `config/config-doctor.ts` inside a docblock, while
    // measuring what importing it would cost. Read as an import it would stage a
    // module — and, on the manifest side, ship one — the interceptor refuses to load.
    it('does not read a specifier quoted in a comment as an import', () => {
      expect(interceptorClosure(repoRoot)).not.toContain('config/config-doctor.ts');
      expect(readRepoFile(join(INTERCEPTOR_SRC_DIR, INTERCEPTOR_ENTRY)))
        .toContain("from './config/config-doctor.ts'");

      expect(relativeImportsOf('/** quoted: import { x } from \'./ghost.ts\'; */\nexport const a = 1;\n'))
        .toEqual([]);
      // …and the positive control for the shape a line-anchored scan misses:
      // four of this module's own six specifiers sit on a line starting with `}`.
      expect(relativeImportsOf('import {\n  a,\n} from \'./real.ts\';\n')).toEqual(['./real.ts']);
    });

    it('stages every derived file, and only those', () => {
      const destRoot = mkdtempSync(join(tmpdir(), 'nessy-interceptor-stage-'));
      stagings.push(destRoot);

      const staged = stageInterceptorSources(repoRoot, destRoot);
      expect(staged).toEqual([INTERCEPTOR_ENTRY, ...EXPECTED_CLOSURE]);

      const stagedRoot = join(destRoot, INTERCEPTOR_SRC_DIR);
      const onDisk = readdirSync(stagedRoot, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name).slice(stagedRoot.length + 1).split(sep).join('/'))
        .sort();
      expect(onDisk).toEqual([...staged].sort());
      expect(existsSync(join(stagedRoot, 'auth', 'nestor.ts'))).toBe(true);
    });
  });

  // The headless server shipped without the interceptor because nothing paired
  // "the bundle is built" with "the entry point loads it": the interceptor
  // reached the server only through the repo-root bunfig.toml preload, which
  // bun resolves from the CWD and which no assembled distribution contains.
  describe('server distribution pairing', () => {
    function assembleFixture(overrides: {
      bundle?: string | null;
      entry?: string;
      dockerfile?: string;
    } = {}): string {
      const root = mkdtempSync(join(tmpdir(), 'nessy-server-dist-'));
      if (overrides.bundle !== null) {
        mkdirSync(join(root, dirname(INTERCEPTOR_BUNDLE_RELATIVE)), { recursive: true });
        writeFileSync(
          join(root, INTERCEPTOR_BUNDLE_RELATIVE),
          overrides.bundle ?? `console.log("${INTERCEPTOR_BUNDLE_MARKER}");`,
        );
      }
      mkdirSync(join(root, 'bin'), { recursive: true });
      writeFileSync(
        join(root, 'bin', 'nessy-server'),
        overrides.entry
          ?? `exec "$ROOT/vendor/bun/bun" run ${interceptorPreloadFragment()} "$ROOT/packages/server/src/index.ts" "$@"\n`,
      );
      writeFileSync(
        join(root, 'Dockerfile'),
        overrides.dockerfile ?? 'ENTRYPOINT ["/app/bin/nessy-server"]\n',
      );
      fixtures.push(root);
      return root;
    }

    const fixtures: string[] = [];
    afterAll(() => {
      for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
    });

    it('accepts a distribution that ships the bundle and loads it', () => {
      expect(() => verifyInterceptorPairing(assembleFixture())).not.toThrow();
    });

    it('rejects a distribution assembled without the bundle', () => {
      expect(() => verifyInterceptorPairing(assembleFixture({ bundle: null })))
        .toThrow(/Interceptor bundle missing/);
    });

    it('rejects a bundle that is not the interceptor', () => {
      expect(() => verifyInterceptorPairing(assembleFixture({ bundle: 'module.exports = {};' })))
        .toThrow(/does not contain the interceptor/);
    });

    it('rejects an entry script that ships the bundle but never preloads it', () => {
      const entry = 'exec "$ROOT/vendor/bun/bun" run "$ROOT/packages/server/src/index.ts" "$@"\n';
      expect(() => verifyInterceptorPairing(assembleFixture({ entry })))
        .toThrow(/does not preload the interceptor/);
    });

    it('rejects a container entry that bypasses bin/nessy-server', () => {
      const dockerfile = 'ENTRYPOINT ["/app/vendor/bun/bun", "run", "/app/packages/server/src/index.ts"]\n';
      expect(() => verifyInterceptorPairing(assembleFixture({ dockerfile })))
        .toThrow(/bypass the interceptor preload/);
    });

    // `copyInterceptorBundle` in scripts/build/common.ts is the cautionary case:
    // a packaging check that exists but is never called. Assert the build runs
    // this one, and that the entry script it generates is the shape verified above.
    it('is wired into the server build rather than left orphaned', () => {
      const buildServer = readRepoFile('scripts/build-server.ts');
      expect(buildServer).toContain('await buildInterceptorBundle(config)');
      expect(buildServer).toContain('verifyInterceptorPairing(outputDir)');
      expect(buildServer).toContain(
        'exec "$ROOT/vendor/bun/bun" run ${interceptorPreloadFragment()} "$ROOT/packages/server/src/index.ts"',
      );
    });
  });
});
