import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
/** Terminal runs the same public command a user types; chat handoff supplies only a validated native ID. */
export async function openOdysseusTerminal(cwd?: string, cliId?: string): Promise<void> {
  if (process.platform !== 'darwin')
    throw new Error('System terminal launcher is configured for macOS');
  if (cwd !== undefined && !isAbsolute(cwd)) throw new Error('Invalid project directory');
  if (cliId !== undefined && !/^[A-Za-z0-9_-]+$/.test(cliId))
    throw new Error('Invalid CLI session');
  const command = `${cwd ? `cd -- ${quote(cwd)} && ` : ''}od${cliId ? ` --resume ${quote(cliId)}` : ''}`;
  const script = `tell application id "com.apple.Terminal"\ndo script ${JSON.stringify(command)}\nactivate\nend tell`;
  await new Promise<void>((resolve, reject) =>
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 15000 }, (error) =>
      error
        ? reject(
            new Error(
              'macOS could not open Terminal. Allow Terminal automation in System Settings.',
            ),
          )
        : resolve(),
    ),
  );
}
