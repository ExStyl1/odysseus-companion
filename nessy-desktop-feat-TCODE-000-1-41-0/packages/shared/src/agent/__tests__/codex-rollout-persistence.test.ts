/**
 * P3.182 — codex persists every tool output, secrets included, and the only
 * thing standing between that and a credential at rest is two lines of ours.
 *
 * ## Native-first, asked first: the runtime CANNOT, on all three counts
 *
 * Probed against the shipped `codex-app-server`
 * (`apps/electron/resources/bin/codex/darwin-arm64`, md5
 * `eb2144664b1c4eb0697b69b4b242b737`, rust-v0.148.0, 2026-09-01) — STRONG tier,
 * the artifact we ship, not a vendor page:
 *
 *  - disabling persistence: the binary's own `struct ConfigToml with 97
 *    elements` field list carries `history`, `sqlite_home` and `log_dir` and NO
 *    rollout key; no `CODEX_*` variable switches it off either;
 *  - a retention setting: `codex_rollout::maintenance` / `::compression`
 *    archive and compress, they do not expire, and `[memories]`'s
 *    `max_rollout_age_days` bounds what is READ, not what is kept;
 *  - redaction: every `redact` in the artifact is the vendored AWS SDK's
 *    `Debug` impl (`** redacted **` beside `secret_access_key`).
 *
 * ## What was measured live, with its control
 *
 * Driving the binary over stdio: `thread/start` alone materialises
 * `CODEX_HOME/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl`, and one
 * turn wrote the user's prompt into it verbatim. The rollout lands at **644**
 * and every directory segment at **755**.
 *
 * POSITIVE CONTROL on the same rig, which is what makes that a reading rather
 * than an instrument artifact: `.sandbox_migration`, written by the same
 * process into the same home in the same run, lands at **600**. Codex chooses
 * 0600 where it wants it; for the rollout it does not.
 *
 * ## So what this file pins
 *
 * The containment is entirely ours — `mkdtempSync` (in `newCodexHome`, F1.652) +
 * `chmodSync(0o700)` in `createRuntime`, and `rmSync` in `cleanupRuntimeResources` — and until this
 * row neither was documented as load-bearing nor pinned by anything. Two lines
 * in two different methods, either of which a future tidy-up could drop without
 * a single test going red. That is the residue this file closes.
 *
 * `createRuntime` spawns a real app-server and verifies a binary manifest, so
 * the invariant is pinned by source match, the same technique
 * `codex-config-requirements.test.ts` uses and for the same stated reason.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describeCodexRolloutPersistence } from '../codex-agent.ts';
import { bracedRegion } from '../../testing/source-regions.ts';

const HOME = '/tmp/nessy-codex-home-abc123';

describe('what codex persists is stated, not left for a support case to discover', () => {
  const said = describeCodexRolloutPersistence(HOME);

  /**
   * KILLS: a sentence that says "codex keeps a session log". The row exists
   * because the persisted thing is tool OUTPUT — the bytes a tool already read,
   * which is what carried a leak-control's own secret into a rollout.
   */
  it('names tool OUTPUT specifically, and where it lands', () => {
    expect(said).toContain('OUTPUT');
    expect(said).toContain(`${HOME}/sessions/`);
    expect(said).toContain('rollout');
  });

  /**
   * KILLS: reporting the containment without the mode, which would let a reader
   * assume codex protects the file. It does not — 0644, measured.
   */
  it('states the mode codex actually writes, and that the containment is ours', () => {
    expect(said).toContain('0644');
    expect(said).toContain('0700');
    expect(said).toContain('deleted when the runtime is torn down');
    expect(said).toContain('kept so a restart can resume the thread, and deleted with the session'); // F1.1074
  });

  /**
   * C3.254 — KILLS: naming the rollout file as if it were the only copy.
   * Re-measured on the shipped binary at `rust-v0.150.1` (2026-09-12,
   * `codex-rollout-path-e2e.test.ts`), one turn's fixture marker is in the
   * `.jsonl` AND in `state_5.sqlite` in the same home, because
   * `rollout/src/state_db.rs`'s `apply_rollout_items` hands the same items to
   * the state DB. An operator told only about the file would believe deleting
   * it is the whole of the exposure.
   */
  it('names the state database as the second copy of the same turn', () => {
    expect(said).toContain(`${HOME}/state_5.sqlite`);
    expect(said).toContain('not the only copy');
  });

  /**
   * KILLS: implying a knob exists. Native-first was asked and the answer was
   * `cannot` three times; an operator who goes looking for a setting must be
   * told there is none rather than left searching.
   */
  it('says plainly that codex offers no redaction, retention or off switch', () => {
    expect(said).toContain('no redaction');
    expect(said).toContain('no retention setting');
    expect(said).toContain('no way to disable');
  });

  /**
   * THE ROW'S CENTRAL DISTINCTION.
   *
   * KILLS: collapsing the permission floor and the persistence into one
   * control. They are two, and only one of them exists — a credential the floor
   * stops a tool from READING is a different thing from one a tool has already
   * read and codex has written down.
   */
  it('separates the permission floor from the persistence', () => {
    expect(said).toContain('the floor does not reach what codex has already written');
  });
});

describe('the containment codex does not provide is pinned so it cannot be tidied away', () => {
  const source = readFileSync(fileURLToPath(new URL('../codex-agent.ts', import.meta.url)), 'utf8');
  /**
   * `includes(...)).toBe(true)` rather than `toContain`: the haystack is a
   * quarter-megabyte file, and `toContain`'s failure message prints ALL of it,
   * which buries the one line that actually failed under the whole module.
   */
  const has = (needle: string): void => {
    expect(source.includes(needle), `missing source anchor: ${needle}`).toBe(true);
  };

  /**
   * KILLS: dropping the `chmod`, which is the only thing making a 0644 rollout
   * unreadable to another local user. It must also come with the fact, so the
   * control and its statement cannot drift apart.
   */
  it('creates the home private and records what that is protecting', () => {
    has('chmodSync(codexHome, 0o700);');
    has("this.recordSessionFact('codex-rollout-persistence', describeCodexRolloutPersistence(codexHome));");
    const created = source.indexOf('const codexHome = this.newCodexHome();');
    const chmod = source.indexOf('chmodSync(codexHome, 0o700);');
    expect(created).toBeGreaterThanOrEqual(0);
    // Private BEFORE anything is written into it, not after.
    expect(chmod).toBeGreaterThan(created);
  });

  /**
   * F1.652 — KILLS: moving the home back under `$TMPDIR` unconditionally, where
   * codex's `:workspace` profile lets an agent command rewrite its
   * `rules/nessy.rules` (the durable Always-Deny grants) and `config.toml`, and a
   * host `thread/fork` then reads the rewritten rules. The home is minted under
   * the host root only when no agent-writable root covers it, and the `$TMPDIR`
   * fallback is SAID. Behaviour is pinned live in
   * `codex-home-outside-writable-roots.test.ts`; this pins the shape.
   */
  it('mints the home outside every agent-writable root, and says so when it cannot', () => {
    const body = bracedRegion(source, source.indexOf('  private newCodexHome(): string {'));
    expect(body).toContain('resolveCodexHostOnlyDirectory(this.codexHomeRoot, this.codexAgentWritableRoots(),');
    const hostRoot = body.indexOf('mintCodexHome(resolved.dir, '); // F1.681 — the host-root mint sweeps a dead host's homes first
    const said = body.indexOf('this.recordSessionFact(CODEX_HOME_LOCATION_FACT, line);');
    const fallback = body.indexOf('mkdtempSync(join(tmpdir(), CODEX_HOME_PREFIX))');
    expect(hostRoot).toBeGreaterThanOrEqual(0);
    // The fallback is reached only after the fact is recorded.
    expect(said).toBeGreaterThan(hostRoot);
    expect(fallback).toBeGreaterThan(said);
    // BOUNDARY CONTROL: the region is that method, not the tail of the class — the
    // floor hook's forget method is declared BELOW it.
    expect(body).not.toContain('private forgetFloorHookState(): void {');
  });

  /**
   * KILLS: dropping the removal, which is the whole of the retention policy —
   * codex has none, so if we stop deleting the home the rollout becomes a
   * credential at rest with no expiry at all.
   */
  it('removes the home, recursively, when the runtime is torn down', () => {
    const cleanup = source.indexOf('private async cleanupRuntimeResources(resources: {');
    expect(cleanup).toBeGreaterThanOrEqual(0);
    const after = source.slice(cleanup);
    const rm = after.indexOf('rmSync(resources.codexHome, {');
    expect(rm).toBeGreaterThanOrEqual(0);
    // D1.111 — the call's own argument braces, not 200 characters after it.
    const options = bracedRegion(after, rm);
    expect(options).toContain('recursive: true');
    // BOUNDARY CONTROL: the region is that options object and not the tail of
    // the method. `failed('codexHome', error)` is the catch arm BELOW it, so a
    // brace scan that ran away includes it — and a scan only ever runs forward,
    // which is why the anchor is something below the region rather than above.
    expect(options).not.toContain("failed('codexHome', error)");
  });
});
