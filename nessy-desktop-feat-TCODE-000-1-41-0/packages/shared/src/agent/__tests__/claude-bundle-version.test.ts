/**
 * P6.658 — THE BUNDLE-VERSION METHOD HAS A GATE.
 *
 * P6.543 corrected the method AGENTS.md carries for answering *"which Claude
 * Code is in this bundle?"*: read the runtime's own self-report, because a grep
 * of a 293 MiB binary for a dotted version is not a probe (it scored 374 hits
 * for the right version and 1 for a wrong one — OCCURRENCES, the instrument
 * named here by C3.294 because LINES answers differently on a minified
 * artefact), and a version read on an out-of-repo rig is a version of another
 * package (P6.554).
 *
 * Re-measured 2026-09-12 on the vendored 2.1.247 binary (222 MiB / 233 MB,
 * 233 073 008 bytes — it SHRANK across the lift): `2.1.247` scores 1561 lines /
 * 1680 occurrences, and `2.1.233`, `2.1.238` and `2.1.223` score 1/1 EACH. So
 * the headline number moved 4.5x on a smaller file and three wrong versions are
 * still spelled in it — the argument above is stronger at this bundle than at
 * the one it was written against, which is why the counts are refreshed rather
 * than the sentence softened.
 *
 * The correction landed as prose and nothing enforced it. Two independent
 * sources describe the same fact —
 *
 *   - `@anthropic-ai/claude-agent-sdk/package.json`'s `claudeCodeVersion`, the
 *     number every pin, doc line and switch-cost sentence in this tree quotes;
 *   - the vendored native binary's own `--version`, the number the model
 *     actually runs behind.
 *
 * — and they AGREE: at `2.1.233` on 2026-09-07, and at `2.1.247` on 2026-09-12
 * after the P7.1 lift (re-read both ways, `claudeCodeVersion` and
 * `claude --version`). Nothing told anyone the day they
 * stop agreeing, and they can: `apps/electron/node_modules/@anthropic-ai` is
 * declared in no package.json, so `bun install` cannot refresh it, and it was
 * measured holding 2.1.223 three days after the lockfile moved to 2.1.233
 * (P3.313, the reason `ensure-claude-sdk-binary-dir.cjs` exists). That hook
 * proves the PACKAGED tree at `afterPack` time; this file proves the DEV tree
 * on every `bun test`, which is where every measurement in this plan is taken.
 *
 * ## What it asserts, and what it deliberately does not
 *
 * Only the equality of the two self-reports. NOT a hard-coded version: a bump
 * that moves both sides together is the normal case and must stay green — the
 * pin on the exact version is P3.174's job
 * (`claude-denied-path-search-results-e2e.test.ts`, which reads the MANIFEST
 * fields only and stays valid). This file is the other half: manifest against
 * binary, so a stale copy on either side is named rather than inferred.
 *
 * ## Where the binary is looked for
 *
 * The same two names `ensure-claude-sdk-binary-dir.cjs` and the three build
 * scripts use, in the order they become real:
 *
 *   1. `claude-agent-sdk-<platform>-<arch>` — what `bun install` places in the
 *      dev tree, and the package `build-dmg.sh` reads as `SDK_BIN_PKG`;
 *   2. `claude-agent-sdk-binary` — the arch-neutral ALIAS those scripts stage
 *      into the app so `electron-builder.yml` has one stable path.
 *
 * Neither present means this host has no native binary for its platform+arch,
 * which is a legitimate state (a non-darwin-arm64 host, or a `--production`
 * install). The case then SKIPS with both probed paths in its name — never
 * silently returns, because a block contributing zero executed tests is
 * indistinguishable from a green one.
 *
 * ## The budget is set against a measured floor
 *
 * `claude --version` on the vendored 293 MiB binary, measured 2026-09-07 at
 * load 8.4-10.7 with six lanes writing this tree, and the two readings are an
 * order of magnitude apart for a reason worth writing down:
 *
 *   - COLD (first spawns after the file had not been touched): 3.33 s, 3.63 s,
 *     3.84 s, 8.59 s — the cost of faulting 293 MiB in, not of the process;
 *   - WARM (same command minutes later, and the whole suite): 0.07 s for the
 *     spawn, 0.49 s / 1.03 s / 1.28 s for the file's two tests together.
 *
 * The budget belongs against the COLD floor, because a fresh boot and CI both
 * pay it and neither gets a second try: Bun's 5 s default would have failed the
 * fourth cold reading for the wrong reason. Hence 60 s — well over the worst
 * measured spawn, and still a real ceiling rather than no budget at all. A warm
 * reading used as the floor here would have manufactured a flake.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

/** The `@anthropic-ai` scope directory, resolved from the SDK the app imports. */
const SCOPE_DIR = (() => {
  const sdkEntry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
  return sdkEntry.slice(0, sdkEntry.lastIndexOf('/@anthropic-ai/')) + '/@anthropic-ai';
})();

const MANIFEST = `${SCOPE_DIR}/claude-agent-sdk/package.json`;

/** In the order these become real; see the header. */
const BINARY_CANDIDATES = [
  `${SCOPE_DIR}/claude-agent-sdk-${process.platform}-${process.arch}/claude`,
  `${SCOPE_DIR}/claude-agent-sdk-binary/claude`,
];

const NATIVE_BINARY = BINARY_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;

const SKIP_REASON =
  NATIVE_BINARY === null
    ? `SKIPPED: no native binary on this host — probed ${BINARY_CANDIDATES.join(' and ')}`
    : '';

function vendoredClaudeCodeVersion(): string | undefined {
  return (JSON.parse(readFileSync(MANIFEST, 'utf8')) as { claudeCodeVersion?: string })
    .claudeCodeVersion;
}

describe('P6.658 · the vendored SDK manifest and the vendored binary report the same Claude Code', () => {
  test('control: the manifest is readable and declares `claudeCodeVersion`', () => {
    // Without this, a renamed or absent field would make the comparison below
    // read `undefined` and fail for a reason that sends the reader after the
    // wrong bug.
    expect(typeof vendoredClaudeCodeVersion()).toBe('string');
  });

  test.skipIf(NATIVE_BINARY === null)(
    `GATE: the binary's own --version equals the manifest's claudeCodeVersion${SKIP_REASON ? ` (${SKIP_REASON})` : ''}`,
    () => {
      const declared = vendoredClaudeCodeVersion();
      const spawned = Bun.spawnSync([NATIVE_BINARY as string, '--version']);

      // A binary that cannot run at all is a different failure from a binary
      // that disagrees, and it must not be reported as the second one.
      expect(
        spawned.exitCode,
        `${NATIVE_BINARY} --version exited ${spawned.exitCode}: ${spawned.stderr.toString().trim()}`,
      ).toBe(0);

      const printed = spawned.stdout.toString().trim();
      // Measured 2026-09-07: `2.1.233 (Claude Code)`; re-measured 2026-09-12
      // after the P7.1 lift: `2.1.247 (Claude Code)`. The suffix is asserted so
      // that a future binary answering something else entirely is named here
      // rather than silently parsed into a version-shaped substring.
      const parsed = /^(\d+\.\d+\.\d+)\s+\(Claude Code\)$/.exec(printed);
      expect(parsed, `unexpected --version output from ${NATIVE_BINARY}: ${printed}`).not.toBeNull();

      expect(
        parsed?.[1],
        'the vendored native binary and the vendored SDK manifest disagree about which Claude Code '
          + 'this bundle carries. One of the two is stale — most likely a copy no package.json governs '
          + '(see P3.313 and `ensure-claude-sdk-binary-dir.cjs`). Every version-dependent measurement '
          + 'in this tree quotes the manifest, so until they agree those readings name a binary nobody runs.',
      ).toBe(declared);
    },
    60_000,
  );
});
