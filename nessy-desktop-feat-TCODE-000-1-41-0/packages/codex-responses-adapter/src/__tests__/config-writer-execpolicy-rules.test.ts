/**
 * P3.1 gate (projection half): the durable allow-prefixes a codex "Always Allow"
 * persists are projected into `CODEX_HOME/rules/nessy.rules` as execpolicy
 * `prefix_rule(pattern=[...], decision="allow")` lines — the exact form the
 * bundled `codex-app-server` both emits and parses (`execpolicy/src/parser.rs`,
 * `execpolicy/src/rule.rs`; `ExecPolicyAmendment` binding). The file is a pure
 * projection: rewritten from scratch on every home build, skipped when nothing
 * projects.
 */
import { test, expect, describe } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCodexExecpolicyRules,
  formatCodexExecpolicyGrantSandboxDiagnostics,
  writeCodexConfig,
  CODEX_RULES_DIR,
  CODEX_RULES_FILE,
} from '../config-writer.ts';

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'p31-rules-home-'));
}

const BASE = {
  model: 'tgpt/qwen35-397b-a17b-fp8',
  adapterPort: 54321,
} as const;

describe('buildCodexExecpolicyRules — the projected prefix_rule shape', () => {
  test('emits one prefix_rule line per prefix, quoted tokens, decision="allow"', () => {
    const text = buildCodexExecpolicyRules([['git', 'status'], ['npm', 'run', 'build']]);
    expect(text).toContain('prefix_rule(pattern=["git", "status"], decision="allow")');
    expect(text).toContain('prefix_rule(pattern=["npm", "run", "build"], decision="allow")');
    // A file the parser can read is newline-terminated, one rule per line.
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trim().split('\n')).toHaveLength(2);
  });

  test('drops a prefix with no non-empty token instead of emitting an empty pattern', () => {
    // The binary rejects an empty pattern ("rules prefix_rule at index … has an
    // empty pattern"), which fails the whole file to load.
    expect(buildCodexExecpolicyRules([[], ['   ' as string].filter(t => t.trim())])).toBe('');
    expect(buildCodexExecpolicyRules([['', 'git', ''], ['status']]))
      .toBe('prefix_rule(pattern=["git"], decision="allow")\nprefix_rule(pattern=["status"], decision="allow")\n');
  });

  test('escapes a token carrying a quote or backslash so it cannot break out', () => {
    const text = buildCodexExecpolicyRules([['git', 'commit', '-m', 'a "b" \\ c']]);
    expect(text).toContain('prefix_rule(pattern=["git", "commit", "-m", "a \\"b\\" \\\\ c"], decision="allow")');
  });
});

describe('writeCodexConfig — projects into CODEX_HOME/rules/nessy.rules', () => {
  test('writes the rules file when prefixes are present', () => {
    const home = freshHome();
    try {
      writeCodexConfig({ ...BASE, codexHome: home, execpolicyAllowPrefixes: [['git', 'status']] });
      const rulesPath = join(home, CODEX_RULES_DIR, CODEX_RULES_FILE);
      expect(existsSync(rulesPath)).toBe(true);
      expect(readFileSync(rulesPath, 'utf8')).toBe('prefix_rule(pattern=["git", "status"], decision="allow")\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('writes NO rules dir when there is nothing to project', () => {
    const home = freshHome();
    try {
      writeCodexConfig({ ...BASE, codexHome: home });
      expect(existsSync(join(home, CODEX_RULES_DIR))).toBe(false);
      // Boundary: only-blank prefixes project nothing either.
      writeCodexConfig({ ...BASE, codexHome: home, execpolicyAllowPrefixes: [[], ['']] });
      expect(existsSync(join(home, CODEX_RULES_DIR))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a home REBUILD regenerates the rules dir from the same prefixes', () => {
    // Each build mints a FRESH CODEX_HOME (mkdtemp), so "survives a rebuild"
    // means the projection is re-derived and re-written, not that a file lingers.
    const prefixes = [['git', 'status']];
    const first = freshHome();
    const second = freshHome();
    try {
      writeCodexConfig({ ...BASE, codexHome: first, execpolicyAllowPrefixes: prefixes });
      writeCodexConfig({ ...BASE, codexHome: second, execpolicyAllowPrefixes: prefixes });
      const a = readFileSync(join(first, CODEX_RULES_DIR, CODEX_RULES_FILE), 'utf8');
      const b = readFileSync(join(second, CODEX_RULES_DIR, CODEX_RULES_FILE), 'utf8');
      expect(b).toBe(a);
      expect(b).toContain('prefix_rule(pattern=["git", "status"], decision="allow")');
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });
});

/**
 * P2.141b — the DENY half, projected as `decision="forbidden"`.
 *
 * The claim this pins is not "we emit a string" but "we emit the string the
 * shipped binary accepts as a refusal". Both halves of that were measured on
 * 2026-08-25 against `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`
 * (md5 `eb2144664b1c4eb0697b69b4b242b737`), driven over stdio with a scratch
 * `CODEX_HOME`:
 *   - `prefix_rule(pattern=["rm"], decision="forbidden")` loaded as
 *     `PrefixRule { … decision: Forbidden }`;
 *   - `decision="prompt"` loaded as `decision: Prompt`;
 *   - `decision="allow"` loaded as `decision: Allow` (baseline control);
 *   - `decision="nonsense"` was REJECTED — `error: invalid decision: nonsense`,
 *     with `configWarning` "Error parsing rules; custom rules not applied.";
 *   - syntax garbage produced no policy at all.
 * Two working negative controls, so the three positives are not a rig that
 * accepts anything.
 *
 * THE ARGV-ONLY TEST TRAP, and how these avoid it. `codex execpolicy check` is
 * documented (`rules.md:124`) but ABSENT from our artifact — `execpolicy` →
 * "error: unexpected argument 'execpolicy' found" — and the `match`/`not_match`
 * inline examples validate against RAW ARGV, so a test written either way would
 * assert only that the string round-trips through a parser and would prove
 * nothing about the wrapped `["bash","-lc","<script>"]` form codex actually
 * evaluates. So these tests deliberately claim only what they can establish: the
 * emitted SHAPE, and the bound. The enforcement claim is pinned where the
 * enforcement is — `codex-permission-floors.test.ts`, on the host gate.
 */
describe('buildCodexExecpolicyRules — the projected deny (P2.141b)', () => {
  /** KILLS: emitting `decision="deny"` (not a value the binary accepts) or reusing "allow". */
  test('emits decision="forbidden" for a deny prefix, and says whose rule it was', () => {
    // P6.1 — the `justification` is what codex renders into the refusal the
    // model and the user actually read: `derive_forbidden_reason`
    // (`core/src/exec_policy.rs`, rust-v0.150.1 — a SECOND path of P7.11's class:
    // the `src` segment was missing here, and the path as written 404s at every
    // tag this repo has shipped) formats
    // ``\`<cmd>\` rejected: <justification>`` when one is present and falls back to
    // "policy forbids commands starting with \`<prefix>\`" when it is not — true,
    // but attributing OUR rule to codex's own policy.
    expect(buildCodexExecpolicyRules([], [['rm', '-rf']]))
      .toBe('prefix_rule(pattern=["rm", "-rf"], decision="forbidden", justification="blocked by the Nessy permission rule: deny rm -rf")\n');
  });

  /** KILLS: dropping the deny half, or dropping the allow half once deny exists. */
  test('emits both halves, refusals first', () => {
    expect(buildCodexExecpolicyRules([['git', 'status']], [['rm']])).toBe(
      'prefix_rule(pattern=["rm"], decision="forbidden", justification="blocked by the Nessy permission rule: deny rm")\n'
      + 'prefix_rule(pattern=["git", "status"], decision="allow")\n',
    );
  });

  /**
   * NEGATIVE CONTROL: with no deny prefixes the output is byte-identical to what
   * it was before this feature — so the two tests above are not satisfied by a
   * builder that emits `forbidden` unconditionally.
   */
  test('is unchanged when nothing denies', () => {
    expect(buildCodexExecpolicyRules([['git', 'status']]))
      .toBe('prefix_rule(pattern=["git", "status"], decision="allow")\n');
    expect(buildCodexExecpolicyRules([], [])).toBe('');
  });

  /**
   * KILLS: emitting an empty pattern, which fails the WHOLE file to load
   * (fail-open) — the same filter the allow half applies, on the same terms.
   */
  test('drops a deny prefix with no non-empty token instead of emitting an empty pattern', () => {
    expect(buildCodexExecpolicyRules([], [['', '']])).toBe('');
    expect(buildCodexExecpolicyRules([], [[]])).toBe('');
  });

  /** KILLS: skipping the escaper on the deny path only. */
  test('escapes a deny token the same way an allow token is escaped', () => {
    expect(buildCodexExecpolicyRules([], [['rm', 'a"b\\c']]))
      .toBe('prefix_rule(pattern=["rm", "a\\"b\\\\c"], decision="forbidden", justification="blocked by the Nessy permission rule: deny rm a\\"b\\\\c")\n');
  });

  /** KILLS: wiring the option name wrong, so the projection never reaches the file. */
  test('writeCodexConfig puts the deny lines in the rules file', () => {
    const home = freshHome();
    try {
      writeCodexConfig({
        ...BASE,
        codexHome: home,
        execpolicyDenyPrefixes: [['rm', '-rf']],
      } as never);
      const text = readFileSync(join(home, CODEX_RULES_DIR, CODEX_RULES_FILE), 'utf8');
      expect(text).toContain('decision="forbidden"');
      expect(text).toContain('"rm", "-rf"');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  /** NEGATIVE CONTROL: no prefixes of either kind still writes no rules file at all. */
  test('writes no rules file when neither half projects', () => {
    const home = freshHome();
    try {
      writeCodexConfig({ ...BASE, codexHome: home } as never);
      expect(existsSync(join(home, CODEX_RULES_DIR, CODEX_RULES_FILE))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * P6.1 — the DSL's MIDDLE tier, projected as codex's own `decision="prompt"`.
 *
 * `allow` and `deny` were emitted; `ask` was not, and the row's first half is
 * that it therefore decided nothing for any call codex auto-approves. It is not
 * that `ask` was broken everywhere — `CodexAgent.consultPermissionRules` returns
 * `null` for it and the card is shown — but a card only exists for a call codex
 * ASKED about, and `approval_policy = "on-request"` leaves that to the model by
 * the release schema's own words, while our own `decision="allow"` grants exist
 * precisely so codex will "bypass approval".
 *
 * WHY `prompt` IS THE RIGHT VOCABULARY, read from the source at the tag of the
 * binary we bundle (`rust-v0.148.0`), not from the page:
 *  - `execpolicy/src/decision.rs` — `Decision::Prompt` is "Request explicit user
 *    approval; rejected outright when running with `approval_policy="never"`".
 *  - `execpolicy/src/policy.rs` — `Evaluation::from_matches` takes `.max()` over
 *    every matched rule's decision, and `Decision` derives `Ord` in declaration
 *    order `Allow < Prompt < Forbidden`. So a projected `prompt` OVERRIDES an
 *    `allow` for the same command, which is what an `ask` rule means.
 *  - `core/exec_policy.rs` — a `Prompt` from a policy rule becomes
 *    `ExecApprovalRequirement::NeedsApproval`, i.e. an
 *    `item/commandExecution/requestApproval`: the seam `handleServerRequest`
 *    already answers on.
 *
 * These tests pin the emitted SHAPE and the ordering, which is all a string
 * assertion can establish. That the shipped binary ACCEPTS the shape is a
 * different claim and is measured where it can be — a real `CODEX_HOME` boot in
 * `codex-agent-server`'s `config-warning-live.test.ts`, whose clean arm now
 * projects a prompt rule and a justification too.
 */
describe('buildCodexExecpolicyRules — the projected ask tier (P6.1)', () => {
  /** KILLS: emitting `decision="ask"` — not a value the binary accepts — or reusing "allow". */
  test('emits decision="prompt" for an ask prefix, and says whose rule it was', () => {
    expect(buildCodexExecpolicyRules([], [], [['git', 'push']]))
      .toBe('prefix_rule(pattern=["git", "push"], decision="prompt", justification="approval required by the Nessy permission rule: ask git push")\n');
  });

  /**
   * KILLS: an ordering that puts the tiers in any other sequence. The order
   * cannot change an OUTCOME — `.max()` decides that — so this pins the file a
   * human reads: refusals, then the things that will stop and ask, then grants.
   */
  test('emits all three tiers, most restrictive first', () => {
    expect(buildCodexExecpolicyRules([['git', 'status']], [['rm']], [['git', 'push']])).toBe(
      'prefix_rule(pattern=["rm"], decision="forbidden", justification="blocked by the Nessy permission rule: deny rm")\n'
      + 'prefix_rule(pattern=["git", "push"], decision="prompt", justification="approval required by the Nessy permission rule: ask git push")\n'
      + 'prefix_rule(pattern=["git", "status"], decision="allow")\n',
    );
  });

  /**
   * NEGATIVE CONTROL: with no ask prefixes the output is byte-identical to what
   * it was before this row — so the two tests above are not satisfied by a
   * builder that emits `prompt` unconditionally.
   */
  test('is unchanged when nothing asks', () => {
    expect(buildCodexExecpolicyRules([['git', 'status']], [], []))
      .toBe('prefix_rule(pattern=["git", "status"], decision="allow")\n');
    expect(buildCodexExecpolicyRules([], [], [])).toBe('');
  });

  /**
   * KILLS: an empty pattern on the new path, which fails the WHOLE file to load
   * (fail-open) and would take the deny floors down with it.
   */
  test('drops an ask prefix with no non-empty token', () => {
    expect(buildCodexExecpolicyRules([], [], [['', '']])).toBe('');
    expect(buildCodexExecpolicyRules([], [], [[]])).toBe('');
  });

  /** KILLS: skipping the escaper on the new path only. */
  test('escapes an ask token the same way the other two tiers escape theirs', () => {
    expect(buildCodexExecpolicyRules([], [], [['git', 'a"b\\c']]))
      .toBe('prefix_rule(pattern=["git", "a\\"b\\\\c"], decision="prompt", justification="approval required by the Nessy permission rule: ask git a\\"b\\\\c")\n');
  });

  /** KILLS: wiring the option name wrong, so the projection never reaches the file. */
  test('writeCodexConfig puts the prompt lines in the rules file', () => {
    const home = freshHome();
    try {
      writeCodexConfig({
        ...BASE,
        codexHome: home,
        execpolicyPromptPrefixes: [['git', 'push']],
      } as never);
      const text = readFileSync(join(home, CODEX_RULES_DIR, CODEX_RULES_FILE), 'utf8');
      expect(text).toContain('decision="prompt"');
      expect(text).toContain('"git", "push"');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  /**
   * A grant carries NO justification, deliberately: codex renders one only on a
   * refusal or a prompt, so on an allow it is text nobody ever reads.
   *
   * KILLS: stamping the justification unconditionally, which would also change
   * every existing allow line for no benefit.
   */
  test('an allow line carries no justification', () => {
    expect(buildCodexExecpolicyRules([['git', 'status']])).not.toContain('justification');
  });

  /**
   * P6.1's second half, finished: the justification names WHICH RULE, not just
   * that some rule of ours spoke.
   *
   * codex renders ``\`<cmd>\` rejected: <justification>``, so the SPECIFIC call is
   * already in the sentence; what a user with several deny rules cannot get from
   * that is which line to edit. The prefix is the projected rule's identity and
   * this function already holds it, so nothing upstream had to carry an id.
   *
   * KILLS: a single shared constant per tier — the shape the first cut had, which
   * passes every assertion above and still leaves two different rules refusing
   * with the same sentence.
   */
  test('each rule justifies itself by its own prefix', () => {
    const rules = buildCodexExecpolicyRules(
      [],
      [['rm', '-rf'], ['sh', '-c']],
      [['git', 'push'], ['docker', 'run']],
    ).trimEnd().split('\n');
    expect(rules).toEqual([
      'prefix_rule(pattern=["rm", "-rf"], decision="forbidden", justification="blocked by the Nessy permission rule: deny rm -rf")',
      'prefix_rule(pattern=["sh", "-c"], decision="forbidden", justification="blocked by the Nessy permission rule: deny sh -c")',
      'prefix_rule(pattern=["git", "push"], decision="prompt", justification="approval required by the Nessy permission rule: ask git push")',
      'prefix_rule(pattern=["docker", "run"], decision="prompt", justification="approval required by the Nessy permission rule: ask docker run")',
    ]);
    // The load-bearing part in one assertion: no two rules share a sentence.
    const justifications = rules.map(line => /justification="([^"]*)"/.exec(line)?.[1]);
    expect(new Set(justifications).size).toBe(4);
  });

  /**
   * The blank tokens a pattern drops are dropped from the justification too, so
   * the sentence never names a rule the file does not contain.
   *
   * KILLS: justifying from the raw prefix instead of the filtered tokens.
   */
  test('the justification names the tokens that were actually emitted', () => {
    expect(buildCodexExecpolicyRules([], [['rm', '', '-rf']]))
      .toBe('prefix_rule(pattern=["rm", "-rf"], decision="forbidden", justification="blocked by the Nessy permission rule: deny rm -rf")\n');
  });
});

/**
 * P3.80 — an allow rule also turns the SANDBOX off for its prefix, and the home
 * that projected one has to be able to say so.
 *
 * The mechanism is codex's, read from the source at the shipped tag
 * `rust-v0.150.1` and not from the page (the page is intent; the source is
 * behaviour, and we have twice measured the binary contradicting its own docs).
 * Cited by symbol since P7.2, because every line in this chain moved under the
 * lift and the symbols did not:
 * `Decision::Allow => ExecApprovalRequirement::Skip { bypass_sandbox: … }`
 * (`core/src/exec_policy.rs`) → `SandboxOverride::BypassSandboxFirstAttempt`
 * (`core/src/tools/sandboxing.rs`) → `SandboxType::None`
 * (`core/src/tools/orchestrator.rs`).
 *
 * These tests do NOT re-assert codex's behaviour — nothing here can. They pin
 * the two things that are ours: that the consequence is REPORTED at the
 * projection site, and that the report tells the two session shapes apart
 * instead of warning uniformly. A diagnostic that fires the same way in both
 * states is the noise version of this row and would be worse than silence.
 */
describe('P3.80 — the projected grant names its own second effect', () => {
  test('a projected grant with no denied-read entry reports that it runs UNSANDBOXED', () => {
    const messages = formatCodexExecpolicyGrantSandboxDiagnostics({
      execpolicyAllowPrefixes: [['git', 'status']],
      sandboxMode: 'workspace-write',
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('codex-execpolicy-grant-unsandboxed');
    expect(messages[0]).toContain('1 durable Always-Allow prefix');
    expect(messages[0]).toContain('OUTSIDE');
  });

  /**
   * The measured suppression, and the reason this row is a documented trade
   * rather than a hole: `sandboxing.rs:246-248` returns `NoOverride` BEFORE it
   * reads `bypass_sandbox` when the policy carries any denied read
   * (`permissions.rs:469-480`). `deniedReadPaths` is exactly such an entry.
   *
   * KILLS the uniform-warning mutant: drop the suppression branch and this test
   * reads the unsandboxed line instead.
   */
  test('a denied-read entry flips the report to sandbox-RETAINED', () => {
    const messages = formatCodexExecpolicyGrantSandboxDiagnostics({
      execpolicyAllowPrefixes: [['git', 'status']],
      sandboxMode: 'workspace-write',
      deniedReadPaths: ['/nessy-standin/creds.json'],
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('codex-execpolicy-grant-sandbox-retained');
    expect(messages[0]).toContain('1 denied-read entry');
    expect(messages[0]).not.toContain('codex-execpolicy-grant-unsandboxed');
  });

  /** Plural spelling, and proof the count is the projected count and not a boolean. */
  test('the report counts the prefixes that actually project', () => {
    const messages = formatCodexExecpolicyGrantSandboxDiagnostics({
      // The third projects nothing: `buildCodexExecpolicyRules` drops an
      // all-blank prefix, so counting it would describe a file that has two
      // lines as if it had three.
      execpolicyAllowPrefixes: [['git', 'status'], ['npm', 'run', 'build'], ['', '']],
      sandboxMode: 'workspace-write',
    });
    expect(messages[0]).toContain('2 durable Always-Allow prefixes');
  });

  test('no grant projected, nothing reported', () => {
    expect(formatCodexExecpolicyGrantSandboxDiagnostics({ sandboxMode: 'workspace-write' })).toEqual([]);
    expect(formatCodexExecpolicyGrantSandboxDiagnostics({
      execpolicyAllowPrefixes: [[], ['']],
      sandboxMode: 'workspace-write',
    })).toEqual([]);
  });

  /**
   * `danger-full-access` builds a NON-`Restricted` policy
   * (`permissions.rs:1320`), so there is no sandbox for the grant to remove and
   * a warning here would attach a real consequence to the wrong cause.
   *
   * KILLS the warn-always mutant.
   */
  test('danger-full-access reports nothing: there is no sandbox to lose', () => {
    expect(formatCodexExecpolicyGrantSandboxDiagnostics({
      execpolicyAllowPrefixes: [['git', 'status']],
      sandboxMode: 'danger-full-access',
    })).toEqual([]);
  });

  /** KILLS: writing the function and never calling it from the one real entry point. */
  test('writeCodexConfig emits the line on its own diagnostic sink', () => {
    const home = freshHome();
    const seen: string[] = [];
    try {
      writeCodexConfig({
        ...BASE,
        codexHome: home,
        sandboxMode: 'workspace-write',
        execpolicyAllowPrefixes: [['git', 'status']],
        onDiagnostic: message => seen.push(message),
      });
      expect(seen.some(message => message.includes('codex-execpolicy-grant-unsandboxed'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('writeCodexConfig stays silent when nothing projects', () => {
    const home = freshHome();
    const seen: string[] = [];
    try {
      writeCodexConfig({ ...BASE, codexHome: home, onDiagnostic: message => seen.push(message) });
      expect(seen.some(message => message.includes('codex-execpolicy-grant'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * P3.82 — a rule spelled `allow` is MODEL-CONDITIONAL; the other two are not.
 *
 * `core/src/session/turn_context.rs`'s `allow_prefix_rules` (`rust-v0.150.1`)
 * selects `AllowPrefixRules::IgnoreForCyberModel` when the model's
 * backend-catalog `model_specialty` is `"cyber"` or its slug is in
 * `requirements.toml`'s `[auto_review].ignore_rules`;
 * `core/src/exec_policy/model_policy.rs`'s `current_for_prefix_rules`
 * then rebuilds the policy keeping every rule EXCEPT a `PrefixRule` whose
 * `decision == Decision::Allow`. Neither trigger is knowable from this writer,
 * so it is documented on `execpolicyAllowPrefixes` rather than honoured.
 *
 * What IS enforceable here is the consequence for the OTHER two tiers, and it is
 * a security invariant rather than a formatting one: a refusal or an escalation
 * spelled as an allow would silently vanish on those models. The two tests below
 * are the guard. They are deliberately written over a MIXED build, because the
 * mistake they exist to catch is a wrong `decision` argument on one `emit` call,
 * which a single-tier assertion cannot see.
 */
describe('P3.82 — no floor may be spelled as a model-conditional allow', () => {
  test('every deny and prompt prefix lands on a non-allow line', () => {
    const text = buildCodexExecpolicyRules(
      [['git', 'status']],
      [['rm']],
      [['git', 'push']],
    );
    const lines = text.trim().split('\n');
    const allowLines = lines.filter(line => line.includes('decision="allow"'));
    // The grant, and only the grant.
    expect(allowLines).toHaveLength(1);
    expect(allowLines[0]).toContain('"git", "status"');
    // KILLS a wrong `decision` on either floor emit: the refused token and the
    // escalated token must not appear on the one line that a cyber model drops.
    expect(allowLines[0]).not.toContain('"rm"');
    expect(allowLines[0]).not.toContain('"git", "push"');
    expect(lines.filter(line => line.includes('decision="forbidden"'))).toHaveLength(1);
    expect(lines.filter(line => line.includes('decision="prompt"'))).toHaveLength(1);
  });

  test('a deny and a grant naming the SAME prefix stay on different tiers', () => {
    // The adversarial spelling, not the friendly one: identical tokens are where
    // a tier mix-up is invisible to a token-based assertion, so this asserts on
    // the DECISION of the line each one landed on.
    const lines = buildCodexExecpolicyRules([['rm']], [['rm']]).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.filter(line => line.includes('decision="forbidden"'))).toHaveLength(1);
    expect(lines.filter(line => line.includes('decision="allow"'))).toHaveLength(1);
  });
});
