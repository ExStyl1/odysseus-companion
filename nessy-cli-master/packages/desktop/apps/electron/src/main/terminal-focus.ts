/**
 * [nessy-fork] desktop-pet-session-aggregation
 *
 * Focuses the terminal window owning an external CLI session (pet card
 * click). Port of the Swift notifier's focus logic, hardened: instead of
 * matching window titles we resolve the session's controlling tty from its
 * pid (`lsof`) and match terminal tabs by tty — titles lie, ttys don't.
 *
 * All OS interaction goes through an injectable `run` seam so tests can
 * verify script selection and fallback order without spawning osascript.
 * Darwin-only; a no-op elsewhere (focus on Linux/Windows is a follow-up).
 */

import * as path from 'node:path';
import { execFile } from 'node:child_process';

export type RunCommand = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string }>;

const defaultRun: RunCommand = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 3_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout) });
    });
  });

/**
 * Focus the terminal of `pid` (preferred) or the window whose title
 * mentions `workDir`'s basename. Never throws — focus is best-effort.
 */
export async function focusTerminalSession(
  opts: { pid?: number; workDir?: string },
  run: RunCommand = defaultRun,
): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const tty = opts.pid ? await resolveTty(opts.pid, run).catch(() => null) : null;
  if (tty) {
    if (await focusITerm2ByTty(tty, run).catch(() => false)) return true;
    if (await focusTerminalAppByTty(tty, run).catch(() => false)) return true;
  }
  if (opts.workDir) {
    if (await focusByTitle(path.basename(opts.workDir), run).catch(() => false)) {
      return true;
    }
  }
  return false;
}

/** Controlling tty of a pid: first `/dev/ttys*` in `lsof -p <pid> -Fn` output. */
export async function resolveTty(
  pid: number,
  run: RunCommand = defaultRun,
): Promise<string | null> {
  const { stdout } = await run('lsof', ['-p', String(pid), '-Fn']);
  const match = stdout.match(/^n\/dev\/ttys\d+$/m);
  return match ? match[0].slice(1) : null;
}

async function isRunning(app: string, run: RunCommand): Promise<boolean> {
  const { stdout } = await run('osascript', [
    '-e',
    `application "${app}" is running`,
  ]);
  return stdout.trim().toLowerCase() === 'true';
}

async function focusITerm2ByTty(tty: string, run: RunCommand): Promise<boolean> {
  if (!(await isRunning('iTerm', run))) return false;
  const script = `
tell application "iTerm"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${tty}" then
          select w
          select t
          return true
        end if
      end repeat
    end repeat
  end repeat
end tell`;
  const { stdout } = await run('osascript', ['-e', script]);
  return stdout.trim() === 'true';
}

async function focusTerminalAppByTty(
  tty: string,
  run: RunCommand,
): Promise<boolean> {
  if (!(await isRunning('Terminal', run))) return false;
  const script = `
tell application "Terminal"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${tty}" then
        set frontmost of w to true
        set selected tab of w to t
        return true
      end if
    end repeat
  end repeat
end tell`;
  const { stdout } = await run('osascript', ['-e', script]);
  return stdout.trim() === 'true';
}

/** Last resort: any terminal window whose title mentions the project. */
async function focusByTitle(basename: string, run: RunCommand): Promise<boolean> {
  const escaped = basename.replace(/["\\]/g, '\\$&');
  const script = `
tell application "System Events"
  set frontApps to name of every process whose background only is false
end tell
repeat with appName in frontApps
  if appName is "iTerm" or appName is "Terminal" then
    tell application (appName as text)
      activate
      repeat with w in windows
        if name of w contains "${escaped}" then
          set frontmost of w to true
          return true
        end if
      end repeat
    end tell
  end if
end repeat`;
  try {
    const { stdout } = await run('osascript', ['-e', script]);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}
