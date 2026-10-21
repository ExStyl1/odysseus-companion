/**
 * C4.33 (QX5, owner answer C, 2026-09-11) — `shell_snapshot` needs no bundled
 * shell, and the guard that makes the day it does LOUD.
 *
 * ## The row's premise, refuted
 *
 * QX5 asked whether this product enables a `[features]` key with no binary
 * behind it, and named `shell_snapshot` as the one verified residue: we write it
 * `true` and `scripts/fetch-codex.mjs` extracts only `bin/codex-app-server` from
 * the release archive. Option C was "measure it on the shipped binary and bundle
 * `codex-resources/zsh` ONLY if there is no fallback to the system zsh".
 *
 * **There is a fallback, and the bundled zsh is not even on the lookup path.**
 * Measured at `rust-v0.150.1`:
 *
 *  - `codex-rs/shell-command/src/shell_snapshot.rs` `snapshot_script` returns a
 *    SCRIPT per `ShellType`; nothing in it names an interpreter path.
 *  - The interpreter comes from `shell-command/src/shell_detect.rs`
 *    `get_shell_path`, in three steps: the user's login shell from `getpwuid`,
 *    then `which::which(binary_name)`, then the literal fallbacks —
 *    `ZSH_FALLBACK_PATHS = ["/bin/zsh"]`,
 *    `BASH_FALLBACK_PATHS = ["/bin/bash", "/usr/bin/bash"]`,
 *    `SH_FALLBACK_PATHS = ["/bin/sh"]`. No member of any of those is a path
 *    inside the release archive.
 *  - The shipped `darwin-arm64` binary scores `codex-resources/zsh` **0**
 *    against `/bin/zsh` **2** and `zsh` **77** on the same scan, with
 *    `zzz-not-a-real-str` **0** as the dead control.
 *  - `codex-resources/zsh/bin/zsh` IS real — `scripts/codex_package/zsh.py`,
 *    *"Fetch the patched zsh fork used by shell_zsh_fork"*, `ZSH_RESOURCE_PATH =
 *    Path("zsh") / "bin" / "zsh"` — and belongs to `Feature::ShellZshFork`
 *    (`Stage::UnderDevelopment`, `default_enabled: false`) and
 *    `Feature::UnifiedExecZshFork` (`Stage::Removed`), neither of which this
 *    writer emits.
 *
 * So nothing is bundled: XS, and zero bytes added to the dmg.
 *
 * ## What this file is FOR, given nothing was built
 *
 * The refutation is only durable while the two zsh-fork keys stay unwritten. The
 * day a lane adds `shell_zsh_fork = true` to the `[features]` block, the patched
 * zsh has to be extracted with it — and that is exactly the kind of pairing that
 * ships silently, because the feature flag parses fine and the capability simply
 * does not work. This is the guard, and `scripts/fetch-codex.mjs`'s own docblock
 * carries the same reading where the extraction list lives.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodexConfigToml } from '../config-writer.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FETCH_SCRIPT = join(REPO_ROOT, 'scripts', 'fetch-codex.mjs');

const CONFIG = buildCodexConfigToml({
  codexHome: '/tmp/nessy-c433-home',
  model: 'tgpt/deepseek-v4-flash-0731',
  adapterPort: 1,
});

describe('C4.33 — the shell the snapshot runs in is the system\'s', () => {
  test('the snapshot key is written, so the claim has a subject', () => {
    expect(CONFIG).toContain('shell_snapshot = true');
  });

  test('NEITHER zsh-fork key is written — the pairing guard', () => {
    // `shell_zsh_fork` is the feature the bundled `codex-resources/zsh/bin/zsh`
    // exists for. Writing it without extending `fetch-codex.mjs`'s extraction
    // list would enable a capability with no binary behind it, and nothing would
    // fail — the flag parses, the feature just does not work.
    expect(CONFIG).not.toContain('shell_zsh_fork');
    expect(CONFIG).not.toContain('unified_exec_zsh_fork');
    // POSITIVE CONTROL on the same string: the block this searched is real and
    // does carry keys, so the two absences are absences and not an empty read.
    expect(CONFIG).toContain('[features]');
    expect(CONFIG).toContain('unified_exec = true');
  });

  test('the extraction list still takes only the app-server binary', () => {
    const script = readFileSync(FETCH_SCRIPT, 'utf8');
    // The darwin/linux path installs exactly one file per target.
    expect(script).toContain("const extractedBin = join(extractDir, 'bin', binaryName(spec.exe));");
    // The Windows sandbox trio is its own opt-in list — read THE ARRAY, not the
    // whole file. A `not.toContain` over the file would fire on the docblock
    // that EXPLAINS the decision, which is the correction-re-creates-the-finding
    // shape AGENTS.md §Traps records; the first draft of this case did exactly
    // that and went red against a paragraph that was entirely right.
    const listStart = script.indexOf('const WINDOWS_SANDBOX_FILES = [');
    expect(listStart).toBeGreaterThan(-1);
    const list = script.slice(listStart, script.indexOf('];', listStart));
    expect(list.match(/\[/g) ?? []).toHaveLength(4); // the array plus its three members
    expect(list).not.toContain('zsh');
    // …and the reading lives where the next lane meets it.
    expect(script).toContain('WHAT IS NOT EXTRACTED');
    expect(script).toContain('ZSH_FALLBACK_PATHS');
  });
});
