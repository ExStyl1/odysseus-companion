/**
 * P6.3 — `--restricted` versus the three `settingSources` this fork passes.
 *
 * THE ROW'S PREMISE IS CORRECTED HERE RATHER THAN FIXED. The flag is real and
 * documented, and the collision it names is real: `cli-reference.md` §CLI flags
 * says a restricted session "loads only [managed settings](/docs/en/managed-settings)
 * and `--settings`", so the `['user','project','local']` that
 * `buildClaudeTurnShapeOptions` passes would simply be ignored. What is NOT real
 * is that it can happen on the runtime we ship:
 *
 *  - the same row ends *"Requires Claude Code v2.1.248 or later"*,
 *  - the vendored native binary reports `2.1.247 (Claude Code)` — ONE patch
 *    version short (it said 2.1.223 / 25 short, then 2.1.233 / 15 short; P7.1
 *    lifted the bundle to 0.3.247 and the DIRECTION is unchanged, which is the
 *    only thing this paragraph claims — the assertion below reads the manifest,
 *    not this line),
 *  - and `errors.md` §"Cloud sessions cannot be created from a --restricted
 *    session" states what an older binary does with it: *"Before v2.1.248, Claude
 *    Code had no `--restricted` flag; earlier versions reject the flag itself
 *    with an unknown-option error."*
 *
 * This is the AGENTS.md bundle-versus-page split resolved in the bundle's favour,
 * because the question is what the runtime CAN DO rather than what we must be
 * able to accept: emitting the flag today would abort the child, not restrict it.
 *
 * SO WHAT THIS FILE IS. Not a feature — a tripwire, in the shape
 * `config/__tests__/claude-provider-routing-env.test.ts` established: it reads
 * the shipped bundle and fails on the version bump that makes the collision
 * reachable, so the decision is MADE rather than inherited. Two things break
 * silently on that day, and neither is visible from the flag's own row:
 *
 *  1. `permissions.md` §"Additional directories grant file access, not
 *     configuration" — *"Skills, commands, and subagents from any flag-added
 *     directory load through the `project` setting source"*. Restricted mode drops
 *     that source, so it also switches P6.34 off.
 *  2. The user's own `.claude/settings.json` allow/ask/deny rules, which R3 in
 *     `claude-agent.ts` deliberately stopped pre-empting so the SDK could apply
 *     them.
 *
 * WHY NO SUBSTITUTE WAS BUILT (native-first, AGENTS.md). The question "does the
 * runtime already have its own mechanism" has a measured answer — yes, one
 * version ahead of us — so constructing a host-side restricted mode would be
 * building beside a native mechanism we have not yet enabled. Ledger A9 also
 * records the absence as `UNIFORM` across Pi, claude and codex, so nothing here
 * is a switch-safety divergence; it is a capability none of the three offers.
 *
 * ## C3.15 (coverage-95, 2026-09-11) — the measurement the row ordered, taken
 * ## one patch version BEFORE the lift it is conditioned on
 *
 * The row reads *"At the SDK lift to 2.1.248 or later, measure the claimed
 * `--restricted` collision with our three settingSources"*. The lift has NOT
 * happened: both self-reports say `2.1.247` (the SDK manifest's
 * `claudeCodeVersion`, and the vendored binary's own `--version`), so an A/B of
 * one packaged arm with the flag against one without has no arm to build — the
 * flag would be rejected as an unknown option by the binary we ship, which is a
 * measurement of the version and not of the collision.
 *
 * What COULD be measured was taken instead, over all three faces of the bundle
 * (AGENTS.md §"docs are the contract for BEHAVIOUR, not for MEMBERSHIP": the
 * bundle is the denominator for what the runtime can already do), with a
 * negative control (`--zzz-no-such-flag`, 0 everywhere) and positive controls
 * that prove each probe reads:
 *
 * | probe | `sdk.d.ts` | `sdk.mjs` | native binary |
 * | --- | --- | --- | --- |
 * | `--restricted` | 0 | 0 | 0 |
 * | `CLAUDE_CODE_RESTRICTED` | 0 | 0 | 0 |
 * | `--add-dir` (control) | — | 2 | 43 |
 * | `--setting-sources` (control) | — | 1 | 21 |
 * | `--dangerously-skip-permissions` (control) | — | — | 22 |
 *
 * So the cell stays a DECIDED REFUSAL with a reading rather than an assumption,
 * and the tripwire below now watches BOTH faces — the argv builder in `sdk.mjs`
 * AND the binary that would have to accept the flag — because the two can move
 * apart: the CLI could gain the flag a patch before the SDK learns to emit it,
 * and a tripwire that only reads the emitter would sleep through that day.
 *
 * ## IT FIRED — 2026-09-13, C3.380's lift to `0.3.251` / `2.1.251`
 *
 * The day this file was built for. Both self-reports say `2.1.251`, which is
 * past the `2.1.248` the flag's own row requires, and the binary carries both
 * spellings. Re-measured across all three faces, both instruments named
 * (`grep -acF` lines / `grep -aoF … | wc -l` occurrences — a minified artefact
 * answers differently by each, C3.294):
 *
 * | probe | `sdk.d.ts` | `sdk.mjs` | native binary |
 * | --- | --- | --- | --- |
 * | `--restricted` | 0 | **0** | **31 / 34** |
 * | `CLAUDE_CODE_RESTRICTED` | 0 | **1** | **9 / 9** |
 * | `--add-dir` (control) | 1 | 2 | 31 / 44 |
 * | `--setting-sources` (control) | 0 | 1 | 19 / 21 |
 * | `--dangerously-skip-permissions` (control) | 0 | 0 | 20 / 22 |
 * | `--zzz-no-such-flag` (negative control) | 0 | 0 | 0 / 0 |
 *
 * **And this file's own prediction is what the numbers show.** It said the two
 * faces "can move apart: the CLI could gain the flag a patch before the SDK
 * learns to emit it, and a tripwire that only reads the emitter would sleep
 * through that day." That is exactly the state: the BINARY accepts
 * `--restricted` and the SDK's argv builder still never emits it (0), while
 * `sdk.mjs` has gained the env NAME — one occurrence, inside the exported
 * env-var getter table, so the runtime now knows the name without the emitter
 * using it. A tripwire reading only `sdk.mjs` would have reported "still
 * absent" on the day the capability arrived.
 *
 * **The decision applied, not re-derived** (it is the paragraph immediately
 * below, written while the flag was still unreachable): NOT ADOPTED. This fork
 * emits no `--restricted` and sets no `CLAUDE_CODE_RESTRICTED`; the three
 * `settingSources` stay. The assertions below are INVERTED rather than deleted,
 * so they now pin the arrival, and the fourth case — "nothing in this fork can
 * pass THIS raw CLI flag" — stops being a belt-and-braces check and becomes the
 * enforcement: it is the only thing standing between the capability and an
 * accidental adoption.
 *
 * **One residue the lift measured and did NOT decide**, recorded here because
 * an undocumented choice nobody can see is indistinguishable from a defect:
 * `classifyManagedEnvVar('CLAUDE_CODE_RESTRICTED')` is `immediate` and the name
 * is not in the SDK's own withhold set, so an administrator's managed `env`
 * block can switch a claude child into restricted mode today — silently
 * dropping the `project` source and with it P6.34 and the user's own
 * `.claude/settings.json` rules. That may well be RIGHT (an admin setting it is
 * an operator asking for restricted mode, which is the "explicit operator
 * switch" this header contemplates) but nobody has decided it, and no
 * diagnostic says it happened. The lift lane recorded it as a proposed row
 * rather than classifying it from a version bump.
 *
 * WHEN IT FIRES, the decision is already written and must not be re-derived from
 * scratch: the three sources stay unless the operator asks for restricted mode,
 * because dropping `project` silently switches P6.34 off and silently stops
 * applying the user's own `.claude/settings.json` rules — both listed above. The
 * flag is therefore adopted only behind an explicit operator switch that says
 * so, or not adopted, with the reason at the site.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The first version whose CLI accepts the flag, per `cli-reference.md` §CLI flags. */
const RESTRICTED_MODE_MIN_CLI_VERSION = '2.1.248';

/** Walk up to the workspace copy of a vendored SDK file, or null. */
function resolveVendored(...segments: string[]): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(dir, 'node_modules', '@anthropic-ai', ...segments);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** `2.1.223` → `[2, 1, 223]`, for an ordering compare rather than a string one. */
function versionParts(version: string): number[] {
  return version.split('.').map(part => Number.parseInt(part, 10));
}

function isBefore(left: string, right: string): boolean {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0;
  }
  return false;
}

describe('P6.3 — restricted mode cannot collide with settingSources on the shipped runtime', () => {
  it('THE MEASUREMENT: the vendored CLI has no --restricted, with controls that prove the probe reads', () => {
    const bundle = resolveVendored('claude-agent-sdk', 'sdk.mjs');
    expect(bundle).not.toBeNull();
    // `latin1` for the same reason the routing-array probe uses it: the bundle is
    // not valid UTF-8 throughout, and a lossy decode silently drops matches.
    const source = readFileSync(bundle!, 'latin1');

    // POSITIVE CONTROLS FIRST — an absence claim is worthless without them, and
    // these three are flags the same argv builder emits.
    for (const flag of ['--add-dir', '--setting-sources', '--allow-dangerously-skip-permissions']) {
      expect({ flag, present: source.includes(flag) }).toEqual({ flag, present: true });
    }

    // THE TRIPWIRE. When this fails, the flag has arrived and two decisions come
    // due: whether a restricted session may keep `settingSources`
    // (`cli-reference.md`: restricted "loads only managed settings and
    // `--settings`"), and that dropping the `project` source also drops the
    // skills, commands and subagents P6.34 loads from `--add-dir` roots.
    expect({
      flag: '--restricted',
      presentInVendoredBundle: source.includes('--restricted'),
    }).toEqual({ flag: '--restricted', presentInVendoredBundle: false });
  });

  it('C3.15: the NATIVE BINARY gained --restricted and CLAUDE_CODE_RESTRICTED at 2.1.251 — the tripwire, fired', () => {
    // The other face of the same absence, and NOT a duplicate of the case above.
    // `sdk.mjs` is the argv BUILDER; the binary is what would have to accept the
    // flag, and the two move independently — the CLI can gain a flag a patch
    // before the SDK learns to emit it. A tripwire that reads only the emitter
    // sleeps through that day, which is exactly the shape this file exists to
    // prevent.
    const binary = [
      `claude-agent-sdk-${process.platform}-${process.arch}`,
      'claude-agent-sdk-binary',
    ].map(pkg => resolveVendored(pkg, 'claude')).find(path => path !== null) ?? null;

    // A host with no native binary for its platform+arch is a legitimate state
    // (a non-darwin-arm64 machine, a `--production` install) — but on the
    // platform this repo VENDORS (darwin-arm64, the package AGENTS.md names) an
    // absence is a broken install, not a state to skip past. So the
    // discriminator is asserted UNCONDITIONALLY, above the branch, with the
    // expectation that differs by platform: `lint:conditional-expect` (P2.405)
    // reads an `expect` inside `if (binary === null)` as an assertion a flipped
    // condition would DELETE rather than fail, and it is right — the previous
    // shape here was a sentinel equal to itself.
    const vendoredHere = process.platform === 'darwin' && process.arch === 'arm64';
    const nativeBinary = binary === null ? 'absent' : 'present';
    expect({ vendoredHere, nativeBinary }).toEqual({
      vendoredHere,
      nativeBinary: vendoredHere ? 'present' : nativeBinary,
    });
    if (binary === null) return;

    const image = readFileSync(binary, 'latin1');
    const countOf = (needle: string): number => image.split(needle).length - 1;

    // POSITIVE CONTROLS — three flags the CLI really accepts, so a zero below is
    // an absence rather than a failed read of a 290-odd MiB image. Asserted as
    // "> 0" and not as a fixed count, because a count is a reading with a date:
    // pinning 43 here would turn a harmless rebuild into a red.
    for (const flag of ['--add-dir', '--setting-sources', '--dangerously-skip-permissions']) {
      expect({ flag, occurrences: countOf(flag) > 0 }).toEqual({ flag, occurrences: true });
    }
    // NEGATIVE CONTROL — a flag that cannot exist, so the probe is shown to be
    // capable of returning zero.
    expect({ flag: '--zzz-no-such-flag', found: countOf('--zzz-no-such-flag') > 0 })
      .toEqual({ flag: '--zzz-no-such-flag', found: false });

    // THE TRIPWIRE, both spellings: the CLI flag and the env var
    // `cli-reference.md` pairs with it. BOTH arrived at 2.1.251 (C3.380,
    // 2026-09-13) and the assertion is inverted rather than removed — the
    // decision is carried in the compared VALUE so whoever meets a failure here
    // reads it without going looking. A binary that LOST them again would fail
    // this, which is the only way this case can still discriminate.
    const DECISION =
      'NOT ADOPTED (the header decision, written before the flag was reachable and applied '
      + 'unchanged on the lift): this fork emits no `--restricted` and sets no '
      + '`CLAUDE_CODE_RESTRICTED`, because restricted mode loads only managed settings and '
      + '`--settings`, which drops the `project` source — and with it P6.34\'s skills, commands '
      + 'and subagents from `--add-dir` roots, and the user\'s own .claude/settings.json '
      + 'allow/ask/deny rules. The live guard is the LAST case in this file, not this one.';
    expect({
      cliFlag: countOf('--restricted') > 0,
      envVar: countOf('CLAUDE_CODE_RESTRICTED') > 0,
      DECISION,
    }).toEqual({ cliFlag: true, envVar: true, DECISION });
  });

  it('THE REASON it was absent has expired: the vendored CLI is now past the version the flag requires', () => {
    // Version-derived rather than only string-derived, so a bundle that gains the
    // flag without gaining the version — or the reverse — is still caught. The
    // expectation flipped with the lift (2.1.247 -> 2.1.251, C3.380), and the
    // two halves are asserted TOGETHER: a bundle whose version says one thing
    // while the binary says the other is the state this pairing exists to find.
    const manifest = resolveVendored('claude-agent-sdk', 'package.json');
    expect(manifest).not.toBeNull();
    const version = JSON.parse(readFileSync(manifest!, 'utf8')).version as string;
    // The SDK's own version tracks the CLI's patch number (`0.3.223` ↔ `2.1.223`,
    // confirmed against `claude --version` on the platform binary — re-confirmed
    // at `0.3.251` ↔ `2.1.251` on 2026-09-13, both self-reports agreeing).
    const cliPatchLine = `2.1.${versionParts(version)[2]}`;
    expect({
      cliPatchLine,
      predatesRestrictedMode: isBefore(cliPatchLine, RESTRICTED_MODE_MIN_CLI_VERSION),
    }).toEqual({ cliPatchLine, predatesRestrictedMode: false });
  });

  it('THE OTHER HALF: nothing in this fork can pass THIS raw CLI flag', () => {
    // The SDK's `extraArgs` is the only route by which an undeclared flag could
    // reach the child, and until 2026-09-07 this asserted that the hatch had NO
    // caller at all. P6.314 gave it exactly one — `append-subagent-system-prompt`,
    // the runtime's own flag for the operator's subagent-prompt append,
    // re-measured 2026-09-12 on the vendored 2.1.247 at 5 lines / 6 occurrences
    // against a control at 0/0 (C3.252; the superseded reading was "7
    // occurrences" at 2.1.233, and C3.294 is why both instruments are named).
    //
    // So the tripwire is NARROWED to the real risk rather than deleted: what
    // must stay unreachable is `restricted`, on either file, in any spelling
    // `extraArgs` could carry. A blanket "no caller" assertion would now have to
    // be silenced, and a pin people silence pins nothing.
    const assignsExtraArgs = /(^|[^A-Za-z])extraArgs\s*:/m;
    const passesRestricted = /(^|[^A-Za-z])(['"]?)restricted\2\s*:/m;
    const agentSource = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    const optionsSource = readFileSync(new URL('../options.ts', import.meta.url), 'utf8');
    expect(agentSource).not.toMatch(passesRestricted);
    expect(optionsSource).not.toMatch(passesRestricted);
    // `options.ts` still has no caller of the hatch at all, which is the
    // stronger statement where it still holds.
    expect(optionsSource).not.toMatch(assignsExtraArgs);
    // The ONE caller, pinned by name: if a second key appears here, this row's
    // claim has to be re-argued rather than inherited.
    expect(agentSource).toContain("extraArgs: { 'append-subagent-system-prompt': append }");
    // The instrument's own controls: both patterns DO fire on a real assignment.
    expect(`  extraArgs: { restricted: null },`).toMatch(assignsExtraArgs);
    expect(`  extraArgs: { restricted: null },`).toMatch(passesRestricted);
    // And the three sources the flag would override are still spelled out here,
    // which is what makes the collision legible when it becomes reachable.
    //
    // Anchored to the CODE LINE, and that is not fussiness: the plain substring
    // form of this assertion survived a mutant that narrowed the real option to
    // two sources, because the docblock 250 lines above quotes the three-source
    // spelling verbatim. A pin a comment can satisfy pins nothing.
    //
    // The anchor MOVED with `01460499a` (P6.930, 2026-09-10), which gave the
    // option an operator flag: the three sources are now the DEFAULT ARM of a
    // ternary rather than a bare property, so the old property-line pattern
    // matched nothing and this case had been red since that commit. Both halves
    // are pinned now — the ternary head, so a rewrite that drops the default
    // arm fails here, and the arm itself, so a narrowing does.
    const declaresThreeSources = /^\s+\? \['user', 'project', 'local'\]$/m;
    expect(agentSource).toMatch(/^\s+settingSources: input\.settingSources === undefined$/m);
    expect(agentSource).toMatch(declaresThreeSources);
    // The instrument's control: the prose spelling alone must NOT satisfy it.
    expect(" * We pass `settingSources: ['user', 'project', 'local']` so a user's own")
      .not.toMatch(declaresThreeSources);
  });
});
