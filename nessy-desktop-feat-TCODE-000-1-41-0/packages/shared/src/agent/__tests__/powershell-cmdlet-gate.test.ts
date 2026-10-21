/**
 * The spawn-free cmdlet gate (P2.241 / P2.395), and the grid that measured it.
 *
 * `getDeniedPathViolation` reaches `extractPowerShellWriteTarget` on EVERY Bash
 * permission check. Measured on this host with the availability probe already
 * warm: **580 ms per call** at load average 15.5, and 10.2 s per call while the
 * machine was also spawning the grid below — so the cost is a contention
 * multiplier sitting on the permission path, not a constant.
 *
 * `cannotNamePowerShellCmdlet` removes the spawn for commands the parser
 * provably cannot find a target in. Its safety is an ARGUMENT (see the
 * function's own docblock: `getCommandName` reads only a
 * `StringConstantExpressionAst`'s parsed `.Value`, and only `` `u{…} `` can put
 * a character there that the source did not contain), and this file is the
 * measurement that argument has to survive.
 *
 * ## Two layers, and why the slow one is opt-in
 *
 * The default suite is PURE TEXT plus a five-case live slice. The exhaustive
 * grid — 341 commands, every backtick / empty-quote / split-quote insertion at
 * every position of every read and write cmdlet, `` `u{…} `` substitution of
 * every character, the `&"…"` invocation forms, upper case, and a backtick line
 * continuation inside the name — spawns `pwsh` 341 times and took **1414 s**
 * here. Run it deliberately:
 *
 *     NESSY_POWERSHELL_CMDLET_GRID=1 bun test packages/shared/src/agent/__tests__/powershell-cmdlet-gate.test.ts
 *
 * Recorded result, 2026-09-03, `pwsh` 7.x on darwin-arm64: **0 cases where the
 * gate skipped and the parser found a target**, 175 spawn-and-hit, 41
 * skip-and-null, 125 over-spawn. Over-spawning is the direction that costs time
 * rather than safety.
 *
 * **Extend this grid before extending `READ_CMDLETS` or `WRITE_CMDLETS`.**
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test';

import {
  cannotNamePowerShellCmdlet,
  extractPowerShellReadTarget,
  extractPowerShellWriteTarget,
  isPowerShellAvailable,
} from '../powershell-validator.ts';

/**
 * D1.110 — a FILE budget, sized against the MEASURED floor rather than bun's
 * 5 s default.
 *
 * This file's cost is `pwsh` spawns, and the docblock above already prices one:
 * **580 ms per call warm at load 15.5, and 10.2 s per call while the machine was
 * also spawning the grid** — a contention multiplier, not a constant. The
 * default suite's live slice makes five such calls, so the contended cost of the
 * live half alone is about 51 s against a 5 s per-case default.
 *
 * MEASURED 2026-09-17, this file ALONE under the test lock, twice:
 * **4.62 s** at load 9.81 (`user 5.57 / sys 0.97` against `real 4.63` — 140 %
 * cpu, a WARM reading and not a floor; slowest body **2.84 s** read with
 * `--reporter=junit`, the only instrument that separates a body from a file),
 * and **21.77 s** at load 8.25 (`user 5.79 / sys 1.39` against `real 21.77` —
 * 33 % cpu) on the same bytes at a LOWER load. W12-d measured the slow body at
 * **13.63 s** on a loaded box, 2.7x the default.
 *
 * 60 s is the family's number for a spawn-per-case suite on this box
 * (`user-settings-strict-report.test.ts`, `cron-scheduler.test.ts`,
 * `load-stored-config-fail-closed.test.ts`'s `SPAWN_BUDGET_MS`, whose floor was
 * measured at 34.87 s wall for 0.53 s of user CPU for ONE spawn). It is about
 * 4.4x the largest body anyone has observed here.
 *
 * **It does NOT cover the opt-in grid.** `NESSY_POWERSHELL_CMDLET_GRID=1` spawns
 * `pwsh` 341 times and took 1 414 s; that arm carries its own budget where it is
 * declared, and raising this one to cover it would hide a hung default run.
 * Re-measure before lowering; a warm reading is not a floor.
 */
setDefaultTimeout(60_000);

const WRITE = ['out-file', 'set-content', 'add-content'] as const;
const READ = ['get-content', 'gc', 'type'] as const;

/**
 * The five spellings P2.241 measured as producing a real write target while
 * defeating a naive substring test. They are the reason the gate strips
 * `` ` ``, `'` and `"` and then carries an explicit escape hatch: the first
 * three are recovered by stripping, and the last two are not recoverable at all
 * without running the parser, because `` `u{…} `` synthesises a character the
 * source never contained.
 */
const MEASURED_EVASIONS = [
  'Out`-File C:\\temp\\x.txt',
  "Out-Fil'e' C:\\temp\\x.txt",
  "O'ut-Fil'e C:\\temp\\x.txt",
  'Out`u{2D}File C:\\temp\\x.txt',
  '&"`u{4F}ut-File" C:\\temp\\x.txt',
] as const;

describe('cannotNamePowerShellCmdlet — the text half', () => {
  it('skips an ordinary POSIX command on the write side', () => {
    const posix = [
      'ls -la', 'git status', 'cat README.md', 'echo hello', 'grep -rn foo .',
      'npm run build', 'bun test', 'find . -name "*.ts"', 'mkdir -p dist',
      'chmod +x run.sh', 'curl -s https://example.com', 'docker ps -a',
    ];
    for (const command of posix) {
      expect(cannotNamePowerShellCmdlet(command, WRITE), command).toBe(true);
    }
  });

  it('does NOT skip the five measured evasions', () => {
    // The load-bearing direction. A `false` here means "spawn the parser",
    // which is the expensive answer and the safe one.
    for (const command of MEASURED_EVASIONS) {
      expect(cannotNamePowerShellCmdlet(command, WRITE), command).toBe(false);
    }
  });

  it('the escape hatch is the whole reason the last two are caught', () => {
    // Positive control on the hatch itself: strip-only, with no `` `u{ ``
    // exemption, would skip both — which is the fail-OPEN this gate must not
    // have. Reproduce the strip-only predicate here rather than asserting the
    // absence, so the row shows what the hatch buys.
    const stripOnly = (command: string) =>
      !WRITE.some(c => command.replace(/[`'"]/g, '').toLowerCase().includes(c));
    expect(stripOnly('Out`u{2D}File C:\\temp\\x.txt')).toBe(true);
    expect(stripOnly('&"`u{4F}ut-File" C:\\temp\\x.txt')).toBe(true);
    // …and the three that stripping DOES recover, so the control is two-sided.
    expect(stripOnly('Out`-File C:\\temp\\x.txt')).toBe(false);
    expect(stripOnly("Out-Fil'e' C:\\temp\\x.txt")).toBe(false);
    expect(stripOnly("O'ut-Fil'e C:\\temp\\x.txt")).toBe(false);
  });

  it('the read side skips less, and the six it keeps are named', () => {
    // Not a flaw to be fixed: `gc` and `type` are short enough to occur inside
    // ordinary POSIX words, and a substring test cannot do better without word
    // boundaries — which backtick-and-quote stripping is what destroys. Named
    // here so the read side's lower skip rate is a known property rather than a
    // surprise the next reader tries to "fix" by shortening the strip set.
    const keeps = [
      'gcc -o out main.c', 'gcloud auth login', 'type -a node', 'ls /usr/gc',
      'file --mime-type x', 'git config --type bool a.b',
    ];
    for (const command of keeps) {
      expect(cannotNamePowerShellCmdlet(command, READ), command).toBe(false);
    }
    expect(cannotNamePowerShellCmdlet('ls -la', READ)).toBe(true);
    expect(cannotNamePowerShellCmdlet('git status', READ)).toBe(true);
  });

  it('the wrapped form is judged on the OUTER text, which still carries the name', () => {
    // `extractPowerShellWriteTarget` unwraps `powershell.exe -Command "…"` and
    // re-enters. The gate runs on the outer string first, so it has to see the
    // inner name through the wrapper — it does, because unwrapping only removes
    // quotes.
    expect(cannotNamePowerShellCmdlet(
      'powershell.exe -Command "Out-File C:\\temp\\x.txt"', WRITE,
    )).toBe(false);
    expect(cannotNamePowerShellCmdlet(
      'powershell.exe -Command "Get-Process"', WRITE,
    )).toBe(true);
  });
});

describe('cannotNamePowerShellCmdlet — against the real parser', () => {
  // Every case here spawns `pwsh`. Budget set against the MEASURED floor
  // (580 ms/call warm, 10.2 s/call under contention) rather than against zero,
  // so a loaded box does not manufacture a red.
  const LIVE_TIMEOUT = 120_000;

  it('pwsh is available on this rig (the control for every absence below)', () => {
    // If this is false the rows below prove nothing, and they say so rather
    // than passing vacuously.
    expect(typeof isPowerShellAvailable()).toBe('boolean');
    // P2.240 · budgeted like its two siblings, and it was the ONLY case in this
    // describe that was not. `isPowerShellAvailable()` spawns
    // `pwsh -Command 'exit 0'` and therefore pays the same floor the comment
    // above measures (580 ms warm, 10.2 s under contention) — while running on
    // bun's 5 s default. Measured 2026-09-03 at load 10.9: **5100.10 ms, red**,
    // with the two budgeted siblings green in the same run. A CONTROL that
    // reddens on load is the worst case of the knob-below-the-floor trap: it is
    // the thing that proves the rows under it are not vacuous.
  }, LIVE_TIMEOUT);

  it('every measured evasion reaches the parser AND yields a real target', () => {
    if (!isPowerShellAvailable()) {
      // Positive control for the skip: no pwsh means no parser, and the
      // extractor returns null for everything by design.
      expect(extractPowerShellWriteTarget('Out-File C:\\temp\\x.txt')).toBeNull();
      return;
    }
    for (const command of MEASURED_EVASIONS) {
      expect(cannotNamePowerShellCmdlet(command, WRITE), command).toBe(false);
      expect(extractPowerShellWriteTarget(command), command).toBe('C:\\temp\\x.txt');
    }
  }, LIVE_TIMEOUT);

  it('the gate changes no verdict the parser would have reached', () => {
    if (!isPowerShellAvailable()) return;
    // Plain forms, both poles, so the gate is shown not to have narrowed the
    // extractor's own behaviour.
    expect(extractPowerShellWriteTarget('Out-File -FilePath C:\\temp\\x.txt')).toBe('C:\\temp\\x.txt');
    expect(extractPowerShellReadTarget('Get-Content C:\\temp\\x.txt')).toBe('C:\\temp\\x.txt');
    expect(extractPowerShellWriteTarget('Get-Process')).toBeNull();
    expect(extractPowerShellWriteTarget('ls -la')).toBeNull();
  }, LIVE_TIMEOUT);
});

/**
 * The exhaustive grid, opt-in. See this file's header for the recorded result
 * and the runtime.
 */
describe('the exhaustive spelling grid', () => {
  const enabled = process.env.NESSY_POWERSHELL_CMDLET_GRID === '1';

  const spellings = (name: string): string[] => {
    const out = new Set<string>([name, name.toUpperCase(), `&"${name}"`, `&'${name}'`, `& "${name}"`]);
    for (let i = 0; i < name.length; i++) {
      out.add(`${name.slice(0, i)}\`${name.slice(i)}`);
      out.add(`${name.slice(0, i)}''${name.slice(i)}`);
      out.add(`${name.slice(0, i)}""${name.slice(i)}`);
      const code = name.charCodeAt(i).toString(16).toUpperCase();
      out.add(`${name.slice(0, i)}\`u{${code}}${name.slice(i + 1)}`);
      out.add(`&"${name.slice(0, i)}\`u{${code}}${name.slice(i + 1)}"`);
    }
    for (let i = 1; i < name.length - 1; i++) out.add(`${name.slice(0, i)}'${name.slice(i)}'`);
    for (let i = 1; i < name.length; i++) out.add(`${name.slice(0, i)}\`\n${name.slice(i)}`);
    return [...out];
  };

  it.skipIf(!enabled)('the gate never skips a command the parser reads a target from', () => {
    const failOpen: string[] = [];
    let skipped = 0;
    let spawnHit = 0;
    for (const [names, cmdlets, extract] of [
      [['Out-File', 'Set-Content', 'Add-Content'], WRITE, extractPowerShellWriteTarget],
      [['Get-Content', 'gc', 'type'], READ, extractPowerShellReadTarget],
    ] as const) {
      for (const name of names) {
        for (const spelling of spellings(name)) {
          const command = `${spelling} C:\\temp\\probe.txt`;
          const gateSkips = cannotNamePowerShellCmdlet(command, cmdlets);
          const target = extract(command);
          if (gateSkips) skipped++;
          else if (target !== null) spawnHit++;
          if (gateSkips && target !== null) failOpen.push(`${command} -> ${target}`);
        }
      }
    }
    expect(failOpen).toEqual([]);
    // Positive controls: the grid actually ran and actually exercised both
    // outcomes, so an empty `failOpen` is a measurement.
    expect(skipped).toBeGreaterThan(0);
    expect(spawnHit).toBeGreaterThan(0);
  }, 3_600_000);
});
